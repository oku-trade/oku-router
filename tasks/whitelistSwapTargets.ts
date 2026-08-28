/**
 * whitelistSwapTargets.ts
 *
 * Reconcile the on-chain OkuRouter swap-target whitelist against
 * chain-config (`@gfxlabs/oku-chains`) on every deployed chain.
 *
 * This is the general-purpose replacement for the one-off hardcoded
 * backfills (see scripts/whitelistMarketRouters.ts). It derives the desired
 * whitelist from `NETWORK_CONFIGS[<network>].knownSwapTargets` -- i.e. from
 * chain-config's `marketRouters` -- diffs it against `swapTargets()` on the
 * live router, and registers whatever is missing. There is no hardcoded
 * address list to go stale: when chain-config publishes new aggregator
 * routers, bump the dependency and re-run this task.
 *
 * Safety properties:
 *   - Idempotent. Only addresses that read back `swapTargets() == false`
 *     are submitted, so re-running is a no-op.
 *   - Ownership-preflighted per chain. `updateSwapTargets` is onlyOwner, so
 *     a chain whose `owner()` doesn't match the configured signer is
 *     skipped loudly rather than burning gas on a guaranteed revert.
 *   - Code-preflighted per target. An address with no bytecode is skipped;
 *     whitelisting an EOA as a swap target would be a security footgun.
 *   - Post-write verified. After each tx we re-read `swapTargets()` and
 *     only report success if it actually flipped to true.
 *
 * Usage:
 *   npx hardhat whitelist-swap-targets --dry-run
 *   npx hardhat whitelist-swap-targets --dry-run --networks mainnet,bsc
 *   npx hardhat whitelist-swap-targets --networks plasma
 *   npx hardhat whitelist-swap-targets            # all chains, live
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { NETWORK_CONFIGS, type SwapTarget } from "../util/deploymentConfig";

interface ChainResult {
  network: string;
  router: string;
  desired: number;
  already: number;
  added: string[];
  skipped: string[];
  failed: string[];
  note?: string;
}

/**
 * Pull the deployer private key out of the hardhat network config rather
 * than using hre.ethers, because this task iterates many networks in one
 * process and hre is bound to a single `--network`. Mirrors the approach in
 * scripts/whitelistMarketRouters.ts.
 */
function resolveAccountKey(hre: any, networkName: string): string | undefined {
  const accounts = (hre.config.networks as any)[networkName]?.accounts;
  const key = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof key !== "string") return undefined;
  // The repo uses an all-zero key as the "unset" sentinel.
  if (/^(0x)?0{64}$/.test(key)) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

task("whitelist-swap-targets", "Reconcile OkuRouter swap-target whitelist against chain-config")
  .addFlag("dryRun", "Report what would change without sending transactions")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .setAction(async (taskArgs, hre) => {
    const dryRun: boolean = taskArgs.dryRun;
    const only = taskArgs.networks
      ? new Set<string>(String(taskArgs.networks).split(",").map((s) => s.trim()).filter(Boolean))
      : undefined;

    const deploymentsDir = path.resolve(__dirname, "..", "deployments");
    const files = fs.readdirSync(deploymentsDir).filter((f) => f.endsWith(".json"));

    console.log(
      `\nReconciling swap-target whitelist against chain-config${dryRun ? "  [DRY RUN — no txs will be sent]" : ""}`,
    );

    const results: ChainResult[] = [];

    for (const file of files) {
      const reg = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), "utf8"));
      const network: string = reg.networkName;
      if (only && !only.has(network)) continue;

      const routerAddr: string | undefined = reg.current?.OkuRouter?.address;
      const res: ChainResult = {
        network,
        router: routerAddr ?? "",
        desired: 0,
        already: 0,
        added: [],
        skipped: [],
        failed: [],
      };

      if (!routerAddr) {
        res.note = "NO_DEPLOYMENT";
        results.push(res);
        continue;
      }

      const cfg = NETWORK_CONFIGS[network];
      if (!cfg) {
        res.note = "NO_NETWORK_CONFIG";
        results.push(res);
        continue;
      }

      const targets: readonly SwapTarget[] = cfg.knownSwapTargets;
      res.desired = targets.length;
      if (targets.length === 0) {
        // Not an error: some chains genuinely have no marketRouters data
        // upstream yet (e.g. scroll, pharos).
        res.note = "NO_TARGETS_IN_CHAIN_CONFIG";
        results.push(res);
        continue;
      }

      const netCfg = (hre.config.networks as any)[network];
      const rpcUrl: string | undefined = netCfg?.url;
      const accountKey = resolveAccountKey(hre, network);
      if (!rpcUrl || !accountKey) {
        res.note = `NO_RPC_OR_KEY (url=${!!rpcUrl} key=${!!accountKey})`;
        results.push(res);
        continue;
      }

      // batchMaxCount: 1 disables ethers' JSON-RPC request batching. Several
      // of the chains here (plasma, xdc) run nodes that mishandle batched
      // payloads and return a malformed/partial response, which ethers
      // surfaces as an opaque "could not coalesce error" even though the
      // identical call succeeds when sent on its own. One request per call is
      // marginally slower but makes the reconcile trustworthy on every chain.
      //
      // staticNetwork pins the chainId from the deployment registry so the
      // provider never runs background network auto-detection. That polling
      // lives outside this function's await chain, so when a flaky/rate-limited
      // endpoint fails it surfaces as an *unhandled rejection* that kills the
      // whole task mid-sweep rather than being caught below (observed against
      // a free-tier mainnet endpoint returning 408). Pinning it keeps every
      // network error inside the try/catch, so one bad RPC degrades to a
      // single skipped chain instead of aborting the run.
      const provider = new ethers.JsonRpcProvider(rpcUrl, reg.chainId, {
        batchMaxCount: 1,
        staticNetwork: ethers.Network.from(reg.chainId),
      });
      try {
        const wallet = new ethers.Wallet(accountKey, provider);
        const router = OkuRouter__factory.connect(routerAddr, wallet);

        const owner = await router.owner();
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
          res.note = `NOT_OWNER (owner=${owner} signer=${wallet.address})`;
          results.push(res);
          continue;
        }

        // Honor per-network gas overrides from hardhat.config.ts. Saga
        // mines zero-price txs and xdc rejects EIP-1559, so both pin an
        // explicit gasPrice that ethers must not auto-populate over.
        const overrides: Record<string, unknown> = {};
        if (netCfg?.gasPrice !== undefined && netCfg.gasPrice !== "auto") {
          overrides.gasPrice = BigInt(netCfg.gasPrice);
        }

        console.log(`\n=== ${network}  router=${routerAddr}`);

        const missing: SwapTarget[] = [];
        for (const t of targets) {
          let registered: boolean;
          try {
            registered = await router.swapTargets(t.address);
          } catch (e: any) {
            res.failed.push(`${t.name} ${t.address} (read: ${e.shortMessage ?? e.message})`);
            continue;
          }
          if (registered) {
            res.already++;
          } else {
            missing.push(t);
          }
        }

        if (missing.length === 0) {
          console.log(`  all ${res.already}/${targets.length} targets already whitelisted`);
          results.push(res);
          continue;
        }

        console.log(`  ${res.already}/${targets.length} already whitelisted; ${missing.length} missing:`);

        for (const t of missing) {
          // Never whitelist an address with no bytecode.
          let code: string;
          try {
            code = await provider.getCode(t.address);
          } catch (e: any) {
            res.failed.push(`${t.name} ${t.address} (getCode: ${e.shortMessage ?? e.message})`);
            continue;
          }
          if (code === "0x") {
            console.log(`  ⚠ skip (no code)  ${t.name.padEnd(14)} ${t.address}`);
            res.skipped.push(`${t.name} ${t.address} (no code)`);
            continue;
          }

          if (dryRun) {
            console.log(`  [would add]       ${t.name.padEnd(14)} ${t.address}`);
            res.added.push(`${t.name} ${t.address}`);
            continue;
          }

          try {
            const tx = await router.updateSwapTargets(t.address, true, overrides);
            const receipt = await tx.wait();
            const ok = await router.swapTargets(t.address);
            if (!ok) {
              console.log(`  ✗ post-write verify FALSE ${t.name} ${t.address} [tx ${receipt?.hash}]`);
              res.failed.push(`${t.name} ${t.address} (verify false)`);
            } else {
              console.log(`  ✓ added           ${t.name.padEnd(14)} ${t.address} [tx ${receipt?.hash}]`);
              res.added.push(`${t.name} ${t.address}`);
            }
          } catch (e: any) {
            console.log(`  ✗ tx failed       ${t.name.padEnd(14)} ${t.address} — ${e.shortMessage ?? e.message}`);
            res.failed.push(`${t.name} ${t.address} (${e.shortMessage ?? e.message})`);
          }
        }
      } catch (e: any) {
        res.note = `ERROR ${e.shortMessage ?? e.message}`;
      } finally {
        provider.destroy();
      }

      results.push(res);
    }

    // ---- summary ----
    console.log("\n" + "=".repeat(72));
    console.log(dryRun ? "DRY RUN SUMMARY" : "SUMMARY");
    console.log("=".repeat(72));
    const widest = Math.max(...results.map((r) => r.network.length), 10);
    let totalAdded = 0,
      totalFailed = 0,
      totalSkipped = 0;
    for (const r of results) {
      totalAdded += r.added.length;
      totalFailed += r.failed.length;
      totalSkipped += r.skipped.length;
      const bits: string[] = [];
      if (r.note) bits.push(r.note);
      else {
        bits.push(`${r.already}/${r.desired} already`);
        if (r.added.length) bits.push(`${dryRun ? "would add" : "added"} ${r.added.length}`);
        if (r.skipped.length) bits.push(`skipped ${r.skipped.length}`);
        if (r.failed.length) bits.push(`FAILED ${r.failed.length}`);
      }
      console.log(`${r.network.padEnd(widest)}  ${bits.join(", ")}`);
    }
    console.log("-".repeat(72));
    console.log(
      `${dryRun ? "would add" : "added"}: ${totalAdded}   skipped: ${totalSkipped}   failed: ${totalFailed}`,
    );

    if (totalFailed > 0) {
      console.log("\nFailures:");
      for (const r of results) {
        for (const f of r.failed) console.log(`  ${r.network}: ${f}`);
      }
      process.exitCode = 1;
    }
    console.log("");
  });
