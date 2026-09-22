/**
 * fees:cycle
 *
 * One command for a fee collection round:
 *
 *   1. scan every deployed chain for idle protocol fees
 *   2. write a snapshot (JSON + markdown) of what is available
 *   3. build the multi-chain sweep bundle from those exact numbers
 *   4. emit the signing page the hardware wallets use
 *
 * Why it is one task rather than four commands
 * --------------------------------------------
 * The scan and the build each have to discover which assets have ever flowed
 * through each router. Run separately they do that work twice, against chain
 * state that has moved in between, so the report an operator approved and the
 * bundle they end up signing can disagree. Here the scan happens once and the
 * build consumes it (`safe:build --from-scan`), which makes the snapshot the
 * authorization record for the bundle rather than a parallel opinion.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It does not filter by value. `--min-usd` defaults to 0, so every chain
 * holding anything is built. Deciding that a chain is not worth a 2-of-3
 * hardware ceremony is an operator judgement, and at 34 chains that decision
 * is worth seeing rather than inheriting from a constant. The ranked table
 * and the copy-pasteable `--networks` line exist to make acting on it cheap.
 *
 * It does not execute. Collecting signatures is a separate, human step; see
 * `safe:exec` once the page reports every chain at threshold.
 *
 * Usage:
 *   npx hardhat fees:cycle --scan-only
 *   npx hardhat fees:cycle
 *   npx hardhat fees:cycle --networks base,arbitrum --name sweep-2026-09-22
 *   npx hardhat fees:cycle --min-usd 25
 *
 * Chains whose default endpoint caps eth_getLogs need a logs-capable endpoint
 * in <NET>_LOGS_URL (e.g. WORLDCHAIN_LOGS_URL) or their long-tail assets
 * cannot be discovered at all.
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { listSafeChains, logsEnvVar, mapLimit, pad } from "../util/safeChains";
import { scanChainForSnapshot } from "../util/feeSweepScan";
import {
  buildSnapshot,
  chainsAboveThreshold,
  sweepableChains,
  writeSnapshot,
} from "../util/feeSnapshot";

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

task("fees:cycle", "Scan every chain for idle fees, build the sweep bundle, emit the signing page")
  .addOptionalParam("networks", "Comma-separated hardhat network names (default: all deployed)")
  .addOptionalParam("name", "Bundle name (default: sweep-<date>)")
  .addOptionalParam("to", "Sweep recipient (default: OKU_FEE_RECIPIENT)")
  .addOptionalParam("minUsd", "Skip chains whose realizable total is below this (default 0)")
  .addOptionalParam("maxRequests", "Per-chain eth_getLogs request budget (default 400)")
  .addOptionalParam("maxTokens", "Max tokens per sweepAll call (default 40)")
  .addOptionalParam("concurrency", "Chains scanned in parallel (default 4)")
  .addFlag("scanOnly", "Stop after the snapshot; do not build a bundle")
  .addFlag("noCache", "Ignore the discovery cache and re-scan full history")
  .addFlag("noEth", "Do NOT sweep the native balance")
  .addFlag("force", "Overwrite an existing bundle of the same name")
  .setAction(async (args, hre) => {
    const only = args.networks
      ? new Set(String(args.networks).split(",").map((s: string) => s.trim()).filter(Boolean))
      : undefined;
    const minUsd = args.minUsd ? Number(args.minUsd) : 0;
    const concurrency = args.concurrency ? Number(args.concurrency) : 4;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    if (chains.length === 0) {
      console.log("No chains matched (or none have an OkuRouter in deployments/).");
      return;
    }

    const started = new Date();
    const stamp = started.toISOString().replace(/[:.]/g, "-").slice(11, 19);
    const date = started.toISOString().slice(0, 10);

    console.log("\n" + "=".repeat(96));
    console.log(`FEE CYCLE  ${started.toISOString()}`);
    console.log("=".repeat(96));
    console.log(`Chains       : ${chains.length}`);
    console.log(`Discovery    : ${args.noCache ? "cold (--no-cache)" : "incremental (cached)"}`);
    const withLogsRpc = chains.filter((c) => c.logsRpcUrl);
    console.log(
      `Logs endpoint: ${withLogsRpc.length}/${chains.length} chain(s) have a *_LOGS_URL override` +
        `${withLogsRpc.length ? ` (${withLogsRpc.map((c) => c.network).join(", ")})` : ""}`,
    );
    console.log("");

    // ---- 1. scan ----------------------------------------------------------
    let done = 0;
    const results = await mapLimit(chains, concurrency, async (chain) => {
      const r = await scanChainForSnapshot(chain, {
        maxRequests: args.maxRequests ? Number(args.maxRequests) : undefined,
        useCache: !args.noCache,
        price: true,
      });
      done++;
      const detail =
        r.status === "has-fees"
          ? `${r.totals.assetCount} asset(s)  realizable ${usd(r.totals.usdRealizable)}`
          : r.status === "error"
            ? `ERROR: ${r.error}`
            : r.status;
      console.log(`  [${String(done).padStart(2)}/${chains.length}] ${pad(chain.network, 12)} ${detail}`);
      return r;
    });

    // ---- 2. snapshot ------------------------------------------------------
    const snap = buildSnapshot(results);
    const written = writeSnapshot(snap, stamp);

    const sweepable = sweepableChains(snap);
    const selected = chainsAboveThreshold(snap, minUsd);

    console.log("\n" + "-".repeat(96));
    console.log("AVAILABLE TO SWEEP");
    console.log("-".repeat(96));
    if (sweepable.length === 0) {
      console.log("Nothing on any chain.");
    } else {
      console.log(
        `  ${pad("chain", 14)}${pad("assets", 8)}${pad("notional", 14)}${pad("realizable", 14)}coverage`,
      );
      for (const c of sweepable) {
        const cov = !c.coverage
          ? "NO LOGS"
          : c.coverage.partial
            ? `partial ${c.coverage.fromBlock}-${c.coverage.toBlock}`
            : "full";
        console.log(
          `  ${pad(c.network, 14)}${pad(String(c.totals.assetCount), 8)}` +
            `${pad(usd(c.totals.usdNotional), 14)}${pad(usd(c.totals.usdRealizable), 14)}${cov}`,
        );
      }
    }
    console.log("-".repeat(96));
    console.log(
      `  TOTAL  notional ${usd(snap.totals.usdNotional)}   ` +
        `realizable ${usd(snap.totals.usdRealizable)}   across ${sweepable.length} chain(s)`,
    );
    console.log(
      "  Realizable caps each asset at a fraction of its pool depth. Decide on realizable:\n" +
        "  notional routinely overstates long-tail tokens by an order of magnitude.",
    );

    // Chains that could not be read are NOT chains with nothing to collect.
    // Saying so out loud, and failing the exit code, is the only thing that
    // stops a scheduled run from quietly skipping them week after week.
    const unread = snap.chains.filter(
      (c) => c.status === "error" || c.status === "no-rpc" || c.status === "no-config",
    );
    if (unread.length) {
      console.log("\n" + "!".repeat(96));
      console.log(
        `${unread.length} chain(s) COULD NOT BE READ. They are not empty -- their state is ` +
          `unknown,\nand anything on them will not appear in the bundle:`,
      );
      for (const c of unread) {
        console.log(`  ${pad(c.network, 14)}${c.status}${c.error ? `: ${c.error}` : ""}`);
      }
      console.log("!".repeat(96));
      process.exitCode = 1;
    }

    const noLogs = snap.chains.filter((c) => c.status !== "error" && c.coverage === null);
    if (noLogs.length) {
      console.log(
        `\n${noLogs.length} chain(s) refused eth_getLogs entirely, so only well-known tokens ` +
          `were checked.\nSet a logs-capable endpoint to see long-tail assets:`,
      );
      for (const c of noLogs) console.log(`  ${logsEnvVar(c.network)}=<url>`);
    }

    console.log(`\nSnapshot: ${written.json}`);
    console.log(`Report  : ${written.md}`);
    console.log(
      "(gitignored -- a snapshot is money that exists, not money that moved. Only the\n" +
        " accounting written at execution time is a durable record.)",
    );

    if (sweepable.length) {
      console.log(`\nTo narrow the ceremony, re-run with:`);
      console.log(`  --networks ${sweepable.map((c) => c.network).join(",")}`);
    }

    if (args.scanOnly) {
      console.log("\n--scan-only: stopping before the bundle.\n");
      return;
    }

    if (selected.length === 0) {
      console.log(
        minUsd > 0
          ? `\nNo chain cleared --min-usd ${usd(minUsd)}. No bundle written.\n`
          : "\nNothing to sweep on any chain. No bundle written.\n",
      );
      return;
    }

    // ---- 3. build ---------------------------------------------------------
    const name = String(args.name ?? `sweep-${date}`);
    const bundlePath = path.join(BUNDLE_DIR, `${name}.json`);
    if (fs.existsSync(bundlePath) && !args.force) {
      // Overwriting matters: a rebuilt bundle carries fresh Safe nonces, so
      // every signature already collected against the old one becomes dead
      // weight that safe:exec will reject as stale. Make that a decision.
      throw new Error(
        `bundle "${name}" already exists at ${bundlePath}. Rebuilding it would invalidate ` +
          `any signatures already collected (new nonces => new safeTxHashes). Pass --name ` +
          `<other> for a separate ceremony, or --force if the old one is genuinely dead.`,
      );
    }

    console.log("\n" + "=".repeat(96));
    console.log(`BUILDING SWEEP BUNDLE  "${name}"  across ${selected.length} chain(s)`);
    console.log("=".repeat(96));

    await hre.run("safe:build", {
      intent: "sweep",
      name,
      networks: selected.map((c) => c.network).join(","),
      fromScan: written.json,
      ...(args.to ? { to: String(args.to) } : {}),
      ...(minUsd > 0 ? { minUsd: String(minUsd) } : {}),
      ...(args.maxTokens ? { maxTokens: String(args.maxTokens) } : {}),
      noEth: Boolean(args.noEth),
    });

    if (!fs.existsSync(bundlePath)) {
      console.log("\nNo bundle was produced; skipping the signing page.\n");
      return;
    }

    // ---- 4. signing page --------------------------------------------------
    await hre.run("safe:sign-page", { name });

    console.log("=".repeat(96));
    console.log("NEXT");
    console.log("=".repeat(96));
    console.log(`  1. npm run sign-page`);
    console.log(`  2. each owner opens http://127.0.0.1:8547/${name}/sign.html and signs`);
    console.log(`  3. npx hardhat safe:exec --name ${name}            # dry run`);
    console.log(`  4. npx hardhat safe:exec --name ${name} --broadcast`);
    console.log("");
    console.log(
      "  Signatures are bound to the Safe nonce at build time. If anything else executes\n" +
        "  through the Safe in the meantime, safe:exec rejects the bundle as stale and the\n" +
        "  ceremony has to be repeated -- so collect signatures promptly.",
    );
    console.log("");
  });
