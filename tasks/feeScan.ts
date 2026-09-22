/**
 * fees:scan
 *
 * Read-only report of idle protocol fees sitting on the OkuRouter of each
 * chain. Sends no transactions and needs no key.
 *
 * This exists because the router has no fee accounting of any kind: there is
 * no `collectableFees()` view, no per-token mapping, nothing. Fees are simply
 * the contract's own balance, so the only way to know what is there is to
 * discover which assets have flowed through and read each balance. See
 * util/feeScan.ts for the discovery rules.
 *
 * Two distinct totals are printed and they are NOT interchangeable:
 *   - notional   : spot price x balance, summed.
 *   - realizable : the same, but each asset capped at a fraction of its pool
 *                  depth. Long-tail tokens routinely quote a real-looking
 *                  price against a pool with no quote liquidity, so notional
 *                  overstates badly. Make decisions on realizable.
 *
 * Discovery resumes from a local, gitignored cache (util/feeAssetCache.ts),
 * so a regular cadence pays for new blocks only. `--no-cache` forces a cold
 * scan. Per-chain log endpoints come from `<NET>_LOGS_URL`.
 *
 * For the full collect-and-sign workflow use `fees:cycle`, which wraps this
 * scan, writes a snapshot, and builds the sweep bundle from it.
 *
 * Usage:
 *   npx hardhat fees:scan
 *   npx hardhat fees:scan --networks worldchain
 *   npx hardhat fees:scan --networks worldchain --json out.json
 *   npx hardhat fees:scan --networks mainnet,op --no-price
 */
import * as fs from "fs";
import { task } from "hardhat/config";
import { listSafeChains, logsEnvVar, mapLimit, pad } from "../util/safeChains";
import { NATIVE_SENTINEL } from "../util/feeScan";
import { scanChainForSnapshot } from "../util/feeSweepScan";
import { buildSnapshot } from "../util/feeSnapshot";

function usd(n: number | undefined): string {
  if (n === undefined) return "     -";
  return `$${n.toFixed(2)}`;
}

task("fees:scan", "Report idle protocol fees held by each OkuRouter")
  .addOptionalParam("networks", "Comma-separated hardhat network names")
  .addOptionalParam("json", "Write the full result to this path as JSON")
  .addOptionalParam("maxRequests", "Per-chain eth_getLogs request budget (default 400)")
  .addOptionalParam(
    "rpc",
    "Override RPC URL (requires a single --networks entry). For multi-chain runs " +
      "set <NET>_LOGS_URL instead, e.g. WORLDCHAIN_LOGS_URL.",
  )
  .addFlag("noPrice", "Skip USD valuation (much faster)")
  .addFlag("noCache", "Ignore the discovery cache and re-scan full history")
  .setAction(async (args, hre) => {
    const only = args.networks
      ? new Set(String(args.networks).split(",").map((s: string) => s.trim()))
      : undefined;
    const maxRequests = args.maxRequests ? Number(args.maxRequests) : undefined;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    if (args.rpc && chains.length !== 1) {
      throw new Error(
        `--rpc applies to one chain, but ${chains.length} were selected. ` +
          `Pass --networks <single network> alongside --rpc, or set ${logsEnvVar("<net>")} ` +
          `per chain for a multi-chain run.`,
      );
    }

    if (chains.length === 0) {
      console.log("No chains matched (or none have an OkuRouter in deployments/).");
      return;
    }

    console.log(`\nScanning idle fees on ${chains.length} chain(s)...\n`);

    const results = await mapLimit(chains, 4, (chain) =>
      scanChainForSnapshot(chain, {
        maxRequests,
        useCache: !args.noCache,
        price: !args.noPrice,
        rpcOverride: args.rpc ? String(args.rpc) : undefined,
      }),
    );

    for (const r of results) {
      if (r.status === "error" || r.status === "no-rpc" || r.status === "no-config") {
        console.log(
          `=== ${r.network} (${r.chainId})  --  ${r.status.toUpperCase()}` +
            `${r.error ? `: ${r.error}` : ""}`,
        );
        continue;
      }

      console.log(
        `=== ${r.network} (${r.chainId})  router ${r.router}  ` +
          `${r.totals.assetCount} asset(s)  notional ${usd(r.totals.usdNotional)}  ` +
          `realizable ${usd(r.totals.usdRealizable)}`,
      );
      if (r.coverage) {
        console.log(
          `    scan: blocks ${r.coverage.fromBlock}-${r.coverage.toBlock} ` +
            `(range ${r.coverage.rangeUsed}${r.coverage.partial ? ", PARTIAL" : ", full"}), ` +
            `${r.coverage.events} OrderFilled, ${r.coverage.everSeen} assets ever seen` +
            `${r.cacheHit ? ", resumed from cache" : ""}` +
            `${r.usedLogsRpc ? `, via ${logsEnvVar(r.network)}` : ""}`,
        );
      }
      if (r.assets.length) {
        console.log(
          `    ${pad("symbol", 12)}${pad("amount", 26)}${pad("usd", 12)}${pad("depth", 12)}address`,
        );
      }
      for (const a of r.assets) {
        console.log(
          `    ${pad(a.symbol.slice(0, 11), 12)}${pad(a.amount, 26)}` +
            `${pad(usd(a.usdValue), 12)}${pad(usd(a.poolDepthUsd), 12)}` +
            `${a.token === NATIVE_SENTINEL ? "(native)" : a.token}`,
        );
      }
      for (const w of r.warnings) console.log(`    ! ${w}`);
      console.log("");
    }

    const snap = buildSnapshot(results);

    console.log("-".repeat(92));
    console.log(
      `TOTAL across ${snap.totals.chainsScanned} chain(s):  ` +
        `notional ${usd(snap.totals.usdNotional)}   realizable ${usd(snap.totals.usdRealizable)}`,
    );
    console.log(
      "Notional is spot x balance and overstates long-tail tokens; realizable caps each\n" +
        "asset at a fraction of its pool depth. Decide on realizable.",
    );

    if (snap.totals.chainsErrored > 0) {
      // These chains were not proven empty -- they could not be read at all.
      // Exiting non-zero is what makes that visible to a scheduled run.
      console.log(
        `\n${snap.totals.chainsErrored} chain(s) FAILED to scan and are not accounted for above.`,
      );
      process.exitCode = 1;
    }

    if (args.json) {
      fs.writeFileSync(String(args.json), `${JSON.stringify(snap, null, 2)}\n`, "utf8");
      console.log(`\nJSON written: ${args.json}`);
    }
  });
