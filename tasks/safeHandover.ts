/**
 * safeHandover.ts
 *
 * The EOA half of the ownership migration: `transferOwnership(safe)` sent by
 * the current owner. DRY RUN unless --broadcast.
 *
 * Ownable2Step splits the handover into two transactions with two different
 * senders, which is why this is a separate task from the safe:* admin flow:
 *
 *   1. `transferOwnership(safe)` -- sent by the CURRENT owner (the deployer
 *      EOA). This task. It only sets `pendingOwner`; the deployer remains
 *      fully in control afterwards.
 *   2. `acceptOwnership()` -- must be sent BY the Safe, so it is a SafeTx:
 *        npx hardhat safe:build --intent accept-ownership
 *        npx hardhat safe:sign  --name ...
 *        npx hardhat safe:exec  --name ... --broadcast
 *
 * That split is the safety net for this whole migration. Step 1 is inert on
 * its own: if the Safe turns out to be missing, misconfigured or unable to
 * transact on some chain, `acceptOwnership` simply never happens and
 * ownership stays with the deployer. A botched handover is a no-op, not a
 * loss of the router.
 *
 * Because of that, this task refuses to run unless it has independently
 * verified -- on the chain in question -- that the Safe exists, has the
 * expected owners and threshold, is running the expected singleton, and has
 * no unexpected modules enabled.
 *
 * Usage:
 *   npx hardhat safe:handover                             # dry run, all chains
 *   npx hardhat safe:handover --networks telos            # dry run, canary
 *   npx hardhat safe:handover --networks telos --broadcast
 */
import { task } from "hardhat/config";
import { Wallet, ZeroAddress, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  OKU_SAFE_OWNERS,
  OKU_SAFE_THRESHOLD,
  SAFE_FALLBACK_HANDLER,
  SAFE_L1_SINGLETON,
  SAFE_L2_SINGLETON,
  assertOkuSafeConfig,
  getOkuSafeDeployment,
} from "../util/safeConfig";
import { SAFE_IFACE } from "../util/safeTx";
import { readRegistry, recordDeployment } from "../util/deploymentsRegistry";
import {
  confirmTx,
  gasOverrides,
  listSafeChains,
  makeProvider,
  pad,
  resolveDeployerKey,
  waitForValue,
} from "../util/safeChains";
import { withRetry } from "../util/rpcRetry";
import { OkuRouter__factory } from "../typechain-types";

/** keccak256("fallback_manager.handler.address") */
const SLOT_FALLBACK_HANDLER =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

task(
  "safe:handover",
  "transferOwnership(Safe) from the deployer EOA (DRY RUN unless --broadcast)",
)
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addFlag("broadcast", "Actually send transactions (default is a dry run)")
  .addFlag("continueOnError", "Keep going after a chain fails")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const broadcast: boolean = taskArgs.broadcast;
    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    console.log("\n" + "=".repeat(96));
    console.log(
      broadcast
        ? "SAFE HANDOVER  *** BROADCAST — transferOwnership WILL BE SENT ***"
        : "SAFE HANDOVER  [DRY RUN]",
    );
    console.log("=".repeat(96));
    console.log(`New owner : ${dep.address}  (${dep.threshold} of ${dep.owners.length})`);
    console.log(`Chains    : ${chains.length}`);
    console.log(
      `\nThis sets pendingOwner only. The deployer keeps full control until the\n` +
        `Safe calls acceptOwnership() via: safe:build --intent accept-ownership`,
    );

    const results: { network: string; status: string; detail: string }[] = [];

    for (const chain of chains) {
      console.log(`\n=== ${chain.network} (${chain.chainId})`);
      if (!chain.rpcUrl) {
        console.log("  ✗ NO_RPC");
        results.push({ network: chain.network, status: "skipped", detail: "NO_RPC" });
        continue;
      }
      const provider = makeProvider(chain.rpcUrl, chain.chainId);
      try {
        // ---- verify the Safe on THIS chain before trusting it ----
        const code = await withRetry(
          () => provider.getCode(dep.address),
          `${chain.network}:getCode(safe)`,
        );
        if (code === "0x") {
          console.log(`  ✗ Safe not deployed here. Run safe:deploy first.`);
          results.push({ network: chain.network, status: "blocked", detail: "NO_SAFE" });
          continue;
        }
        const call = async (fn: string) =>
          SAFE_IFACE.decodeFunctionResult(
            fn,
            await provider.call({
              to: dep.address,
              data: SAFE_IFACE.encodeFunctionData(fn),
            }),
          )[0];
        const safeOwners = ((await call("getOwners")) as string[]).map((o) => getAddress(o));
        const safeThreshold = Number((await call("getThreshold")) as bigint);
        const want = new Set(OKU_SAFE_OWNERS.map((o) => getAddress(o)));
        const got = new Set(safeOwners);
        const problems: string[] = [];
        if (got.size !== want.size || ![...want].every((o) => got.has(o))) {
          problems.push(`owner set mismatch: [${safeOwners.join(", ")}]`);
        }
        if (safeThreshold !== OKU_SAFE_THRESHOLD) {
          problems.push(`threshold ${safeThreshold} != ${OKU_SAFE_THRESHOLD}`);
        }
        const s0 = await provider.getStorage(dep.address, "0x0");
        const singleton = getAddress("0x" + s0.slice(-40));
        const expectedSingleton =
          chain.chainId === 1 ? getAddress(SAFE_L1_SINGLETON) : getAddress(SAFE_L2_SINGLETON);
        if (singleton !== expectedSingleton) {
          problems.push(`singleton ${singleton} != ${expectedSingleton}`);
        }
        const sf = await provider.getStorage(dep.address, SLOT_FALLBACK_HANDLER);
        if (getAddress("0x" + sf.slice(-40)) !== getAddress(SAFE_FALLBACK_HANDLER)) {
          problems.push(`fallback handler mismatch`);
        }
        try {
          const raw = await provider.call({
            to: dep.address,
            data: SAFE_IFACE.encodeFunctionData("getModulesPaginated", [
              "0x0000000000000000000000000000000000000001",
              10,
            ]),
          });
          const [modules] = SAFE_IFACE.decodeFunctionResult("getModulesPaginated", raw);
          if ((modules as string[]).length > 0) {
            problems.push(`modules enabled: ${(modules as string[]).join(", ")}`);
          }
        } catch {
          problems.push("could not read modules");
        }
        if (problems.length) {
          console.log(`  ✗ Safe verification FAILED — refusing to hand over:`);
          problems.forEach((p) => console.log(`      ${p}`));
          results.push({
            network: chain.network,
            status: "blocked",
            detail: problems[0].slice(0, 50),
          });
          if (!taskArgs.continueOnError) break;
          continue;
        }
        console.log(
          `  ✓ Safe verified: ${safeThreshold}/${safeOwners.length}, singleton ${singleton}`,
        );

        // ---- router state ----
        const router = OkuRouter__factory.connect(chain.router!, provider);
        const [owner, pending] = await Promise.all([router.owner(), router.pendingOwner()]);
        const currentOwner = getAddress(owner);
        if (currentOwner === getAddress(dep.address)) {
          console.log(`  ✓ Safe already owns this router — nothing to do`);
          results.push({ network: chain.network, status: "done", detail: "already owned" });
          continue;
        }
        if (getAddress(pending) === getAddress(dep.address)) {
          console.log(
            `  ✓ pendingOwner already set to the Safe. Next: safe:build --intent accept-ownership`,
          );
          results.push({ network: chain.network, status: "pending", detail: "awaiting accept" });
          continue;
        }

        const key = resolveDeployerKey(hre, chain.network);
        if (!key) {
          console.log(`  ✗ NO_KEY`);
          results.push({ network: chain.network, status: "skipped", detail: "NO_KEY" });
          continue;
        }
        const wallet = new Wallet(key, provider);
        if (currentOwner !== getAddress(wallet.address)) {
          console.log(
            `  ✗ NOT_OWNER: router owner is ${currentOwner}, signer is ${wallet.address}`,
          );
          results.push({ network: chain.network, status: "blocked", detail: "NOT_OWNER" });
          if (!taskArgs.continueOnError) break;
          continue;
        }
        if (getAddress(pending) !== ZeroAddress) {
          console.log(
            `  ⚠ pendingOwner is currently ${getAddress(pending)}; this call will replace it`,
          );
        }

        const data = OkuRouter__factory.createInterface().encodeFunctionData(
          "transferOwnership",
          [dep.address],
        );

        if (!broadcast) {
          await provider.call({ from: wallet.address, to: chain.router!, data });
          console.log(
            `  ✓ [dry run] transferOwnership(${dep.address}) simulated OK from ${wallet.address}`,
          );
          results.push({ network: chain.network, status: "would-transfer", detail: "" });
          continue;
        }

        const overrides = gasOverrides(chain);
        const tx = await withRetry(
          () => router.connect(wallet).transferOwnership(dep.address, overrides),
          `${chain.network}:transferOwnership`,
        );
        const receipt = await confirmTx(provider, tx.hash);
        // Poll rather than read once: several chains (Celo, Nibiru, XDC)
        // serve this from a node that has not applied the block yet and
        // would report the stale pendingOwner, producing a false failure
        // that invites re-sending an already-successful transaction.
        const verified = await waitForValue(
          async () => getAddress(await router.pendingOwner()),
          getAddress(dep.address),
        );
        const nowPending = verified.last;
        if (!verified.ok) {
          console.log(
            `  ✗ post-write verify failed: pendingOwner is ${nowPending} [tx ${tx.hash}]`,
          );
          results.push({ network: chain.network, status: "failed", detail: "VERIFY" });
          if (!taskArgs.continueOnError) break;
          continue;
        }
        console.log(
          `  ✓ pendingOwner set to Safe [tx ${tx.hash}] block ${receipt?.blockNumber}`,
        );
        console.log(`    owner() is still ${currentOwner} until the Safe accepts.`);
        results.push({ network: chain.network, status: "transferred", detail: tx.hash.slice(0, 14) });
      } catch (e) {
        const anyE = e as { shortMessage?: string; message?: string };
        console.log(`  ✗ ${anyE.shortMessage ?? anyE.message ?? e}`);
        results.push({
          network: chain.network,
          status: "failed",
          detail: String(anyE.shortMessage ?? anyE.message ?? e).slice(0, 50),
        });
        if (!taskArgs.continueOnError) break;
      } finally {
        provider.destroy();
      }
    }

    console.log("\n" + "=".repeat(96));
    console.log(broadcast ? "HANDOVER SUMMARY" : "DRY RUN SUMMARY");
    console.log("=".repeat(96));
    for (const r of results) {
      console.log(pad(r.network, 14) + pad(r.status, 18) + r.detail);
    }
    if (results.some((r) => r.status === "failed" || r.status === "blocked")) {
      process.exitCode = 1;
    }
    console.log("");
  });

task(
  "safe:refresh-registry",
  "Re-read live owner()/Safe state and rewrite deployments/*.json to match the chain",
)
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only);

    console.log(
      "\nRefreshing deployments/*.json from on-chain state " +
        "(README requires the owner field to match the chain after any handover)\n",
    );
    let changed = 0;
    for (const chain of chains) {
      if (!chain.rpcUrl || !chain.router) continue;
      const provider = makeProvider(chain.rpcUrl, chain.chainId);
      try {
        const router = OkuRouter__factory.connect(chain.router, provider);
        const liveOwner = getAddress(await router.owner());
        const reg = readRegistry(chain.network, chain.chainId);
        const entry = reg.current.OkuRouter;
        if (entry && getAddress(entry.owner!) !== liveOwner) {
          recordDeployment(chain.network, chain.chainId, "OkuRouter", {
            ...entry,
            owner: liveOwner,
          });
          console.log(`  ✓ ${pad(chain.network, 12)} owner ${entry.owner} -> ${liveOwner}`);
          changed++;
        }

        // Record the Safe too, if it is deployed here and not yet tracked.
        const code = await provider.getCode(dep.address);
        if (code !== "0x" && !reg.current.Safe) {
          const call = async (fn: string) =>
            SAFE_IFACE.decodeFunctionResult(
              fn,
              await provider.call({
                to: dep.address,
                data: SAFE_IFACE.encodeFunctionData(fn),
              }),
            )[0];
          const owners = ((await call("getOwners")) as string[]).map((o) => getAddress(o));
          const threshold = Number((await call("getThreshold")) as bigint);
          const version = String(await call("VERSION"));
          recordDeployment(chain.network, chain.chainId, "Safe", {
            address: dep.address,
            version: `${version}${chain.chainId === 1 ? "" : "+L2"}`,
            threshold,
            owners,
          });
          console.log(`  ✓ ${pad(chain.network, 12)} recorded Safe ${dep.address}`);
          changed++;
        }
      } catch (e) {
        const anyE = e as { shortMessage?: string; message?: string };
        console.log(`  ✗ ${pad(chain.network, 12)} ${anyE.shortMessage ?? anyE.message}`);
      } finally {
        provider.destroy();
      }
    }
    console.log(`\n${changed} registry field(s) updated.\n`);
  });
