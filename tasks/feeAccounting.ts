/**
 * fees:account
 *
 * Produce the accounting artifact for an executed fee sweep.
 *
 * Deliberately a standalone, idempotent task rather than logic buried inside
 * `safe:exec`: the record must be regenerable from nothing but a transaction
 * hash. If the write fails, or the artifact is lost, or someone wants to
 * re-derive it a year later, `fees:account --tx 0x...` reconstructs it from
 * chain data. safe:exec invokes this automatically after a sweep broadcast,
 * but the task is the source of truth, not the hook.
 *
 * Amounts are taken from the recipient's measured balance delta wherever the
 * RPC lets us read historical state, and cross-checked against the emitted
 * TokenWithdrawn/EthWithdrawn amounts. See util/feeAccounting.ts for why that
 * redundancy is load-bearing.
 *
 * Usage:
 *   npx hardhat fees:account --network-name worldchain --tx 0xabc...
 *   npx hardhat fees:account --network-name worldchain --tx 0xabc... --name sweep-worldchain
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { Interface, formatUnits, getAddress } from "ethers";
import type { JsonRpcProvider, Log } from "ethers";
import { listSafeChains, makeProvider } from "../util/safeChains";
import { NETWORK_CONFIGS } from "../util/deploymentConfig";
import { OkuRouter__factory } from "../typechain-types";
import { NATIVE_SENTINEL, priceAssets, type FeeAsset } from "../util/feeScan";
import {
  buildReport,
  ledgerEntryFor,
  renderMarkdown,
  type AccountingAsset,
  type AccountingMode,
  type AccountingReport,
  type LedgerEntry,
} from "../util/feeAccounting";

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");
const REPORTS_DIR = path.resolve(__dirname, "..", "fee-reports");

/** Atomic write, matching the convention used by the deployments registry. */
export function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

/** Read a balance at a specific block, returning undefined if unavailable. */
async function balanceAt(
  provider: JsonRpcProvider,
  token: string,
  holder: string,
  blockTag: number,
): Promise<bigint | undefined> {
  try {
    if (token === NATIVE_SENTINEL) return await provider.getBalance(holder, blockTag);
    const raw = await provider.call({
      to: token,
      data: ERC20.encodeFunctionData("balanceOf", [holder]),
      blockTag,
    });
    return BigInt(raw);
  } catch {
    // Non-archive node: historical state is unavailable. The caller degrades
    // to event-only accounting rather than reporting a wrong number.
    return undefined;
  }
}

async function tokenMeta(
  provider: JsonRpcProvider,
  token: string,
): Promise<{ symbol: string; decimals: number }> {
  let decimals = 18;
  let symbol = "?";
  try {
    decimals = Number(BigInt(await provider.call({ to: token, data: ERC20.encodeFunctionData("decimals", []) })));
  } catch {
    /* non-standard token */
  }
  try {
    symbol = ERC20.decodeFunctionResult(
      "symbol",
      await provider.call({ to: token, data: ERC20.encodeFunctionData("symbol", []) }),
    )[0] as string;
  } catch {
    /* non-standard token */
  }
  return { symbol, decimals };
}

/**
 * Reconstruct a sweep's accounting from an executed transaction.
 *
 * Exported so the fork simulation can call it directly against the in-process
 * Hardhat provider and emit an artifact in the identical schema.
 */
export async function accountForSweepTx(opts: {
  provider: JsonRpcProvider;
  network: string;
  chainId: number;
  router: string;
  safe: string;
  recipient: string;
  txHash: string;
  mode: AccountingMode;
  bundle?: string;
  safeNonce?: string;
  safeTxHash?: string;
  signers?: string[];
}) {
  const { provider, router, recipient, txHash } = opts;
  const warnings: string[] = [];

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`no receipt for ${txHash}`);
  const block = await provider.getBlock(receipt.blockNumber);
  const before = receipt.blockNumber - 1;
  const after = receipt.blockNumber;

  const routerIface = OkuRouter__factory.createInterface();
  const tokenWithdrawn = routerIface.getEvent("TokenWithdrawn").topicHash;
  const ethWithdrawn = routerIface.getEvent("EthWithdrawn").topicHash;

  // Only consider events emitted by this router: a MultiSend batch can carry
  // unrelated logs from other contracts in the same transaction.
  const logs = receipt.logs.filter(
    (l: Log) => getAddress(l.address) === getAddress(router),
  );

  const events: { token: string; amount: bigint }[] = [];
  for (const l of logs) {
    if (l.topics[0] === tokenWithdrawn) {
      const parsed = routerIface.decodeEventLog("TokenWithdrawn", l.data, l.topics);
      events.push({ token: getAddress(parsed[0] as string), amount: parsed[2] as bigint });
    } else if (l.topics[0] === ethWithdrawn) {
      const parsed = routerIface.decodeEventLog("EthWithdrawn", l.data, l.topics);
      events.push({ token: NATIVE_SENTINEL, amount: parsed[1] as bigint });
    }
  }

  if (events.length === 0) {
    warnings.push("no TokenWithdrawn/EthWithdrawn events found in this transaction");
  }

  const assets: AccountingAsset[] = [];
  const forPricing: FeeAsset[] = [];
  let anyHistoricalRead = false;

  for (const ev of events) {
    const isNative = ev.token === NATIVE_SENTINEL;
    const meta = isNative
      ? { symbol: NETWORK_CONFIGS[opts.network]?.nativeSymbol ?? "ETH", decimals: 18 }
      : await tokenMeta(provider, ev.token);

    const [rBefore, rAfter, pBefore, pAfter] = await Promise.all([
      balanceAt(provider, ev.token, router, before),
      balanceAt(provider, ev.token, router, after),
      balanceAt(provider, ev.token, recipient, before),
      balanceAt(provider, ev.token, recipient, after),
    ]);
    if (rBefore !== undefined) anyHistoricalRead = true;

    // The recipient's native delta is distorted if the recipient also paid
    // gas for this transaction; it does not here (the relayer pays), but be
    // explicit rather than silently trusting it.
    let delta: bigint | undefined;
    if (pBefore !== undefined && pAfter !== undefined) delta = pAfter - pBefore;

    const authoritative = delta !== undefined ? delta : ev.amount;

    assets.push({
      token: ev.token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      amountRaw: authoritative.toString(),
      amount: formatUnits(authoritative, meta.decimals),
      eventAmountRaw: ev.amount.toString(),
      routerBalanceBefore: rBefore?.toString(),
      routerBalanceAfter: rAfter?.toString(),
      recipientBalanceBefore: pBefore?.toString(),
      recipientBalanceAfter: pAfter?.toString(),
      recipientDeltaRaw: delta?.toString(),
      deltaMatchesEvent: delta === undefined ? undefined : delta === ev.amount,
    });

    forPricing.push({
      token: ev.token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      balance: authoritative,
    });
  }

  if (!anyHistoricalRead && events.length > 0) {
    warnings.push(
      "RPC would not serve historical state; amounts are taken from events only and " +
        "a fee-on-transfer token could therefore be overstated",
    );
  }

  // Price at the execution block so the record reflects value at the time of
  // the sweep, not whenever the report happened to be generated.
  let nativeUsdPrice: number | undefined;
  const cfg = NETWORK_CONFIGS[opts.network];
  if (cfg) {
    try {
      const { priced, nativeUsd, warnings: pw } = await priceAssets(provider, cfg, forPricing);
      nativeUsdPrice = nativeUsd ?? undefined;
      warnings.push(...pw);
      for (const p of priced) {
        const a = assets.find((x) => x.token === p.token);
        if (!a) continue;
        a.usdPrice = p.usdPrice;
        a.usdValue = p.usdValue;
        a.poolDepthUsd = p.poolDepthUsd;
        a.realizableUsd = p.realizableUsd;
        a.priceSource = p.priceSource;
      }
    } catch (e) {
      warnings.push(`pricing failed: ${String((e as { message?: string }).message ?? e).slice(0, 80)}`);
    }
  }

  const gasUsed = receipt.gasUsed;
  const gasPrice = receipt.gasPrice ?? 0n;
  const gasCostWei = gasUsed * gasPrice;
  const gasCostNative = formatUnits(gasCostWei, 18);

  return buildReport({
    mode: opts.mode,
    bundle: opts.bundle,
    network: opts.network,
    chainId: opts.chainId,
    router: getAddress(router),
    safe: getAddress(opts.safe),
    recipient: getAddress(recipient),
    nativeUsdPrice,
    warnings,
    execution: {
      txHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: block ? new Date(block.timestamp * 1000).toISOString() : "unknown",
      relayer: receipt.from ? getAddress(receipt.from) : undefined,
      safeNonce: opts.safeNonce,
      safeTxHash: opts.safeTxHash,
      signers: opts.signers,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: gasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      gasCostNative,
      gasCostUsd: nativeUsdPrice !== undefined ? Number(gasCostNative) * nativeUsdPrice : undefined,
      status: receipt.status === 1 ? "success" : "reverted",
    },
    assets,
  });
}

/**
 * Write a sweep's artifacts and fold it into the ledger.
 *
 * Layout (see README "Fee collection"):
 *
 *   fee-reports/data/<YYYY-MM-DD>/<network>-<txprefix>.json   machine-readable
 *   fee-reports/reports/<YYYY-MM-DD>/<network>.md             human-readable
 *   fee-reports/reports/<YYYY-MM-DD>/SUMMARY.md               cross-chain roll-up
 *   fee-reports/ledger.json                                   append-only index
 *   fee-reports/simulations/...                               fork rehearsals (gitignored)
 *
 * Three properties are deliberate:
 *   - The date comes from the BLOCK timestamp, so a regenerated report cannot
 *     drift into the wrong bucket.
 *   - The JSON filename carries a tx-hash prefix, so a second sweep of the
 *     same chain on the same day can never silently overwrite the first.
 *     An accounting record that can be clobbered is not a record.
 *   - Human and machine artifacts live in separate trees, so `data/` can be
 *     consumed programmatically without filtering prose out of it.
 *
 * Simulations are diverted to their own gitignored tree: they are rehearsals,
 * not financial events, and must never contaminate the ledger.
 */
export function writeAccounting(report: ReturnType<typeof buildReport>): {
  json: string;
  md: string;
} {
  const sim = report.mode === "fork-simulation";
  const txPrefix = report.execution.txHash.split(",")[0].slice(2, 10);

  if (sim) {
    const dir = path.join(REPORTS_DIR, "simulations", report.date);
    const json = path.join(dir, `${report.network}-${txPrefix}.json`);
    const md = path.join(dir, `${report.network}-${txPrefix}.md`);
    writeAtomic(json, `${JSON.stringify(report, null, 2)}\n`);
    writeAtomic(md, renderMarkdown(report));
    return { json, md };
  }

  const json = path.join(REPORTS_DIR, "data", report.date, `${report.network}-${txPrefix}.json`);
  const md = path.join(REPORTS_DIR, "reports", report.date, `${report.network}.md`);
  writeAtomic(json, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(md, renderMarkdown(report));

  appendLedger(ledgerEntryFor(report, path.relative(REPORTS_DIR, json)));
  writeDateSummary(report.date);
  return { json, md };
}

/**
 * Merge one entry into the ledger, keyed by (txHash, network) so re-running
 * `fees:account` on the same transaction updates rather than duplicates.
 */
export function appendLedger(entry: LedgerEntry): void {
  const file = path.join(REPORTS_DIR, "ledger.json");
  let entries: LedgerEntry[] = [];
  if (fs.existsSync(file)) {
    try {
      entries = JSON.parse(fs.readFileSync(file, "utf8")) as LedgerEntry[];
    } catch {
      // A corrupt ledger must not block recording a sweep that already
      // happened; it is rebuildable from data/ via `fees:report --rebuild`.
      entries = [];
    }
  }
  const idx = entries.findIndex(
    (e) => e.txHash === entry.txHash && e.network === entry.network,
  );
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  entries.sort((a, b) => (a.date === b.date ? a.network.localeCompare(b.network) : a.date.localeCompare(b.date)));
  writeAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Read every machine-readable record under data/. */
export function readAllReports(): AccountingReport[] {
  const dataDir = path.join(REPORTS_DIR, "data");
  if (!fs.existsSync(dataDir)) return [];
  const out: AccountingReport[] = [];
  for (const day of fs.readdirSync(dataDir)) {
    const dir = path.join(dataDir, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AccountingReport);
      } catch {
        // skip unreadable record rather than abort the whole roll-up
      }
    }
  }
  return out;
}

function usd(n: number | undefined): string {
  return typeof n === "number" && isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

/** Regenerate the cross-chain SUMMARY.md for one sweep date. */
export function writeDateSummary(date: string): string | null {
  const reports = readAllReports().filter((r) => r.date === date);
  if (reports.length === 0) return null;
  reports.sort((a, b) => b.totals.usdRealizable - a.totals.usdRealizable);

  const notional = reports.reduce((s, r) => s + r.totals.usdNotional, 0);
  const realizable = reports.reduce((s, r) => s + r.totals.usdRealizable, 0);
  const gasUsd = reports.reduce((s, r) => s + (r.execution.gasCostUsd ?? 0), 0);
  const assets = reports.reduce((s, r) => s + r.totals.assetCount, 0);
  const unreconciled = reports.filter(
    (r) => !r.reconciliation.allRouterBalancesZero || !r.reconciliation.eventsMatchBalanceDeltas,
  );

  const L: string[] = [];
  L.push(`# Fee collection — ${date} (${reports[0].isoWeek})`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Chains swept | ${reports.length} |`);
  L.push(`| Assets moved | ${assets} |`);
  L.push(`| Notional | ${usd(notional)} |`);
  L.push(`| **Realizable** | **${usd(realizable)}** |`);
  L.push(`| Gas spent | ${usd(gasUsd)} |`);
  L.push(`| Fully reconciled | ${unreconciled.length === 0 ? "yes" : `NO — ${unreconciled.length} chain(s)`} |`);
  L.push("");
  L.push("| Chain | Assets | Notional | Realizable | Gas | Tx |");
  L.push("|---|---:|---:|---:|---:|---|");
  for (const r of reports) {
    L.push(
      `| [${r.network}](./${r.network}.md) | ${r.totals.assetCount} | ${usd(r.totals.usdNotional)} ` +
        `| ${usd(r.totals.usdRealizable)} | ${usd(r.execution.gasCostUsd)} | \`${r.execution.txHash.slice(0, 12)}…\` |`,
    );
  }
  L.push("");
  if (unreconciled.length) {
    L.push("## Needs attention");
    L.push("");
    for (const r of unreconciled) {
      if (!r.reconciliation.allRouterBalancesZero) {
        L.push(`- **${r.network}**: router still holds ${r.reconciliation.residuals.length} asset(s)`);
      }
      for (const d of r.reconciliation.discrepancies) L.push(`- **${r.network}**: ${d}`);
    }
    L.push("");
  }
  L.push(
    "Realizable caps each asset at a fraction of its pool depth; notional does not. " +
      "Use realizable.",
  );
  L.push("");

  const file = path.join(REPORTS_DIR, "reports", date, "SUMMARY.md");
  writeAtomic(file, L.join("\n"));
  return file;
}

task("fees:report", "Roll up fee collection across dates, weeks or chains")
  .addOptionalParam("since", "Inclusive start date, YYYY-MM-DD")
  .addOptionalParam("until", "Inclusive end date, YYYY-MM-DD")
  .addOptionalParam("week", "ISO week, e.g. 2026-W38")
  .addOptionalParam("networkName", "Restrict to one chain")
  .addFlag("rebuild", "Regenerate ledger.json and every SUMMARY.md from data/")
  .setAction(async (args) => {
    let reports = readAllReports();

    if (args.rebuild) {
      // data/ is the source of truth; ledger.json and the summaries are
      // derived, so they can always be reconstructed from it.
      const ledgerFile = path.join(REPORTS_DIR, "ledger.json");
      if (fs.existsSync(ledgerFile)) fs.rmSync(ledgerFile);
      const days = new Set<string>();
      for (const r of reports) {
        const txPrefix = r.execution.txHash.split(",")[0].slice(2, 10);
        appendLedger(
          ledgerEntryFor(r, path.join("data", r.date, `${r.network}-${txPrefix}.json`)),
        );
        days.add(r.date);
      }
      for (const d of days) writeDateSummary(d);
      console.log(`Rebuilt ledger.json (${reports.length} record(s)) and ${days.size} SUMMARY.md file(s).`);
      return;
    }

    if (args.week) reports = reports.filter((r) => r.isoWeek === String(args.week));
    if (args.since) reports = reports.filter((r) => r.date >= String(args.since));
    if (args.until) reports = reports.filter((r) => r.date <= String(args.until));
    if (args.networkName) reports = reports.filter((r) => r.network === String(args.networkName));

    if (reports.length === 0) {
      console.log("No sweep records match that filter.");
      return;
    }
    reports.sort((a, b) => (a.date === b.date ? a.network.localeCompare(b.network) : a.date.localeCompare(b.date)));

    const notional = reports.reduce((s, r) => s + r.totals.usdNotional, 0);
    const realizable = reports.reduce((s, r) => s + r.totals.usdRealizable, 0);
    const gas = reports.reduce((s, r) => s + (r.execution.gasCostUsd ?? 0), 0);
    const assets = reports.reduce((s, r) => s + r.totals.assetCount, 0);
    const bad = reports.filter(
      (r) => !r.reconciliation.allRouterBalancesZero || !r.reconciliation.eventsMatchBalanceDeltas,
    );

    console.log("");
    console.log(`${"date".padEnd(12)}${"week".padEnd(10)}${"chain".padEnd(13)}${"assets".padStart(7)}${"notional".padStart(12)}${"realizable".padStart(12)}${"gas".padStart(9)}`);
    console.log("-".repeat(75));
    for (const r of reports) {
      console.log(
        r.date.padEnd(12) +
          r.isoWeek.padEnd(10) +
          r.network.padEnd(13) +
          String(r.totals.assetCount).padStart(7) +
          usd(r.totals.usdNotional).padStart(12) +
          usd(r.totals.usdRealizable).padStart(12) +
          usd(r.execution.gasCostUsd).padStart(9),
      );
    }
    console.log("-".repeat(75));
    console.log(
      `${reports.length} sweep(s), ${assets} asset(s):  notional ${usd(notional)}   ` +
        `realizable ${usd(realizable)}   gas ${usd(gas)}`,
    );
    if (bad.length) {
      console.log(`\n${bad.length} sweep(s) did NOT fully reconcile:`);
      for (const r of bad) console.log(`  ${r.date} ${r.network}  tx ${r.execution.txHash.slice(0, 18)}…`);
      process.exitCode = 1;
    }
    console.log("");
  });

task("fees:account", "Build the accounting record for an executed fee sweep")
  .addParam("tx", "Transaction hash of the executed sweep")
  .addParam("networkName", "Hardhat network name the sweep ran on")
  .addOptionalParam("name", "Bundle name (default: sweep-<network>)")
  .addOptionalParam("recipient", "Override the recipient address to measure")
  .setAction(async (args, hre) => {
    const network = String(args.networkName);
    const chain = listSafeChains(hre, new Set([network]))[0];
    if (!chain) throw new Error(`no deployments entry for network ${network}`);
    if (!chain.rpcUrl) throw new Error(`no RPC configured for ${network}`);
    if (!chain.router) throw new Error(`no OkuRouter recorded for ${network}`);

    const bundleName = String(args.name ?? `sweep-${network}`);
    const bundleFile = path.join(BUNDLE_DIR, `${bundleName}.json`);

    let recipient = args.recipient ? getAddress(String(args.recipient)) : undefined;
    let safeNonce: string | undefined;
    let safeTxHash: string | undefined;
    let signers: string[] | undefined;

    if (fs.existsSync(bundleFile)) {
      const b = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
      const entry = (b.chains ?? []).find((c: { network: string }) => c.network === network);
      recipient = recipient ?? (entry?.sweep?.recipient as string | undefined);
      safeNonce = entry?.nonce;
      safeTxHash = entry?.safeTxHash;
      // Signers come from the gitignored sidecars; include them if present.
      const dir = path.join(BUNDLE_DIR, bundleName);
      if (fs.existsSync(dir)) {
        const found: string[] = [];
        for (const f of fs.readdirSync(dir)) {
          const m = /^signatures-(0x[0-9a-fA-F]{40})\.json$/.exec(f);
          if (!m) continue;
          try {
            const entries = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            if (entries.some((e: { safeTxHash: string }) => e.safeTxHash === safeTxHash)) {
              found.push(getAddress(m[1]));
            }
          } catch {
            /* unreadable sidecar */
          }
        }
        if (found.length) signers = found;
      }
    }

    if (!recipient) {
      throw new Error(
        "could not determine the sweep recipient. Pass --recipient, or run with a " +
          "--name that matches an existing sweep bundle.",
      );
    }

    const provider = makeProvider(chain.rpcUrl, chain.chainId);
    try {
      const report = await accountForSweepTx({
        provider,
        network,
        chainId: chain.chainId,
        router: chain.router,
        safe: chain.recordedSafe ?? "0x0000000000000000000000000000000000000000",
        recipient,
        txHash: String(args.tx),
        mode: "execution",
        bundle: bundleName,
        safeNonce,
        safeTxHash,
        signers,
      });

      const { json, md } = writeAccounting(report);
      console.log(renderMarkdown(report));
      console.log(`\nWritten:\n  ${json}\n  ${md}`);

      if (!report.reconciliation.allRouterBalancesZero) {
        console.log("\nWARNING: the router still holds a balance for at least one swept asset.");
      }
      if (!report.reconciliation.eventsMatchBalanceDeltas) {
        console.log("\nWARNING: emitted amounts did not match measured recipient deltas.");
      }
    } finally {
      provider.destroy();
    }
  });
