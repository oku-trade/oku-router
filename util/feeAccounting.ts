/**
 * feeAccounting.ts
 *
 * Builds the durable record of a fee sweep: what left the router, what
 * arrived at the recipient, what it was worth, and what it cost to move.
 *
 * The central design rule here is that amounts are derived from TWO
 * independent sources and cross-checked:
 *
 *   1. the `TokenWithdrawn` / `EthWithdrawn` events, and
 *   2. measured balance deltas on the recipient.
 *
 * They are not redundant. `sweepAll` emits the router's balance as read
 * BEFORE the transfer, so a fee-on-transfer or rebasing token delivers less
 * than the event claims. Trusting events alone would silently produce books
 * that overstate receipts, which for an accounting artifact is the one
 * failure mode that matters. Any divergence is recorded per-asset as
 * `deltaMatchesEvent: false` and surfaced in `reconciliation.discrepancies`
 * rather than being smoothed over.
 *
 * The same builder serves both the fork simulation and the real execution, so
 * the artifact format is proven before anything is signed.
 */
import { formatUnits } from "ethers";

export type AccountingMode = "execution" | "fork-simulation";

export interface AccountingAsset {
  /** ERC20 address, or "native". */
  token: string;
  symbol: string;
  decimals: number;
  /** Authoritative amount: recipient delta when measurable, else the event. */
  amountRaw: string;
  amount: string;
  /** Amount as reported by TokenWithdrawn/EthWithdrawn. */
  eventAmountRaw?: string;
  routerBalanceBefore?: string;
  routerBalanceAfter?: string;
  recipientBalanceBefore?: string;
  recipientBalanceAfter?: string;
  recipientDeltaRaw?: string;
  /**
   * True when the recipient delta equals the emitted amount. False indicates
   * a fee-on-transfer/rebasing token. Undefined when balances could not be
   * read (non-archive RPC), in which case only the event is known.
   */
  deltaMatchesEvent?: boolean;
  usdPrice?: number;
  usdValue?: number;
  poolDepthUsd?: number;
  realizableUsd?: number;
  priceSource?: string;
}

export interface AccountingExecution {
  txHash: string;
  blockNumber: number;
  blockTimestamp: string;
  relayer?: string;
  safeNonce?: string;
  safeTxHash?: string;
  signers?: string[];
  gasUsed: string;
  effectiveGasPrice: string;
  gasCostWei: string;
  gasCostNative: string;
  gasCostUsd?: number;
  status: "success" | "reverted";
}

export interface AccountingReport {
  kind: "oku-fee-sweep";
  schemaVersion: 1;
  mode: AccountingMode;
  bundle?: string;
  network: string;
  chainId: number;
  router: string;
  safe: string;
  recipient: string;
  generatedAt: string;
  execution: AccountingExecution;
  assets: AccountingAsset[];
  totals: {
    assetCount: number;
    usdNotional: number;
    usdRealizable: number;
    nativeUsdPrice?: number;
  };
  reconciliation: {
    /** Every swept asset now reads zero on the router. */
    allRouterBalancesZero: boolean;
    /** Every measurable recipient delta matched its event. */
    eventsMatchBalanceDeltas: boolean;
    /** Assets still holding a balance on the router after the sweep. */
    residuals: { token: string; symbol: string; amount: string }[];
    /** Human-readable notes on any mismatch. */
    discrepancies: string[];
  };
  warnings: string[];
}

export interface BuildReportInput {
  mode: AccountingMode;
  bundle?: string;
  network: string;
  chainId: number;
  router: string;
  safe: string;
  recipient: string;
  execution: AccountingExecution;
  assets: AccountingAsset[];
  nativeUsdPrice?: number;
  warnings?: string[];
}

/** Assemble a report, computing totals and reconciliation from the assets. */
export function buildReport(input: BuildReportInput): AccountingReport {
  const residuals: { token: string; symbol: string; amount: string }[] = [];
  const discrepancies: string[] = [];

  for (const a of input.assets) {
    if (a.routerBalanceAfter !== undefined && BigInt(a.routerBalanceAfter) > 0n) {
      residuals.push({
        token: a.token,
        symbol: a.symbol,
        amount: formatUnits(BigInt(a.routerBalanceAfter), a.decimals),
      });
    }
    if (a.deltaMatchesEvent === false) {
      const ev = a.eventAmountRaw ? formatUnits(BigInt(a.eventAmountRaw), a.decimals) : "?";
      const got = a.recipientDeltaRaw
        ? formatUnits(BigInt(a.recipientDeltaRaw), a.decimals)
        : "?";
      discrepancies.push(
        `${a.symbol} (${a.token}): event reported ${ev} but recipient received ${got} ` +
          `-- consistent with a fee-on-transfer or rebasing token`,
      );
    }
  }

  let usdNotional = 0;
  let usdRealizable = 0;
  for (const a of input.assets) {
    usdNotional += a.usdValue ?? 0;
    usdRealizable += a.realizableUsd ?? 0;
  }

  return {
    kind: "oku-fee-sweep",
    schemaVersion: 1,
    mode: input.mode,
    bundle: input.bundle,
    network: input.network,
    chainId: input.chainId,
    router: input.router,
    safe: input.safe,
    recipient: input.recipient,
    generatedAt: new Date().toISOString(),
    execution: input.execution,
    assets: input.assets,
    totals: {
      assetCount: input.assets.length,
      usdNotional,
      usdRealizable,
      nativeUsdPrice: input.nativeUsdPrice,
    },
    reconciliation: {
      allRouterBalancesZero: residuals.length === 0,
      eventsMatchBalanceDeltas: discrepancies.length === 0,
      residuals,
      discrepancies,
    },
    warnings: input.warnings ?? [],
  };
}

function usd(n: number | undefined): string {
  return n === undefined ? "-" : `$${n.toFixed(2)}`;
}

/** Human-readable sibling of the JSON, for pasting into a ticket or a memo. */
export function renderMarkdown(r: AccountingReport): string {
  const L: string[] = [];
  const title =
    r.mode === "fork-simulation"
      ? "Fee Sweep - FORK SIMULATION (no funds moved)"
      : "Fee Sweep - Execution Record";

  L.push(`# ${title}`);
  L.push("");
  if (r.mode === "fork-simulation") {
    L.push(
      "> This run happened on a local fork. Nothing here touched a live chain; " +
        "it exists to prove the sweep behaves as expected and that this artifact " +
        "format is correct before any signature is collected.",
    );
    L.push("");
  }
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Network | ${r.network} (chainId ${r.chainId}) |`);
  if (r.bundle) L.push(`| Bundle | \`${r.bundle}\` |`);
  L.push(`| Router | \`${r.router}\` |`);
  L.push(`| Safe | \`${r.safe}\` |`);
  L.push(`| Recipient | \`${r.recipient}\` |`);
  L.push(`| Tx | \`${r.execution.txHash}\` |`);
  L.push(`| Block | ${r.execution.blockNumber} (${r.execution.blockTimestamp}) |`);
  if (r.execution.safeNonce !== undefined) L.push(`| Safe nonce | ${r.execution.safeNonce} |`);
  if (r.execution.signers?.length) {
    L.push(`| Signers | ${r.execution.signers.map((s) => `\`${s}\``).join(", ")} |`);
  }
  L.push(
    `| Gas | ${r.execution.gasUsed} @ ${r.execution.effectiveGasPrice} wei = ` +
      `${r.execution.gasCostNative}${r.execution.gasCostUsd !== undefined ? ` (${usd(r.execution.gasCostUsd)})` : ""} |`,
  );
  L.push(`| Status | ${r.execution.status} |`);
  L.push(`| Generated | ${r.generatedAt} |`);
  L.push("");

  L.push(`## Assets swept (${r.assets.length})`);
  L.push("");
  L.push("| Asset | Amount | USD | Realizable | Verified |");
  L.push("|---|---:|---:|---:|---|");
  for (const a of r.assets) {
    const verified =
      a.deltaMatchesEvent === undefined
        ? "event only"
        : a.deltaMatchesEvent
          ? "yes"
          : "**MISMATCH**";
    L.push(
      `| ${a.symbol} | ${a.amount} | ${usd(a.usdValue)} | ${usd(a.realizableUsd)} | ${verified} |`,
    );
  }
  L.push("");
  L.push(`**Notional:** ${usd(r.totals.usdNotional)}  `);
  L.push(`**Realizable:** ${usd(r.totals.usdRealizable)}`);
  L.push("");
  L.push(
    "Notional is spot price x amount. Realizable caps each asset at a fraction of its " +
      "pool depth, because long-tail tokens quote prices against pools with no liquidity. " +
      "Realizable is the meaningful figure.",
  );
  L.push("");

  L.push("## Reconciliation");
  L.push("");
  L.push(`- Router fully drained: **${r.reconciliation.allRouterBalancesZero ? "yes" : "NO"}**`);
  L.push(
    `- Events match measured balance deltas: **${r.reconciliation.eventsMatchBalanceDeltas ? "yes" : "NO"}**`,
  );
  if (r.reconciliation.residuals.length) {
    L.push("");
    L.push("### Residual balances remaining on the router");
    L.push("");
    for (const x of r.reconciliation.residuals) L.push(`- ${x.symbol}: ${x.amount} (\`${x.token}\`)`);
  }
  if (r.reconciliation.discrepancies.length) {
    L.push("");
    L.push("### Discrepancies");
    L.push("");
    for (const d of r.reconciliation.discrepancies) L.push(`- ${d}`);
  }
  if (r.warnings.length) {
    L.push("");
    L.push("### Warnings");
    L.push("");
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  L.push("");
  return L.join("\n");
}
