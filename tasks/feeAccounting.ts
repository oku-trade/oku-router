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
  renderMarkdown,
  type AccountingAsset,
  type AccountingMode,
} from "../util/feeAccounting";

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");

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

/** Write both artifacts and return their paths. */
export function writeAccounting(
  bundleName: string,
  network: string,
  report: ReturnType<typeof buildReport>,
): { json: string; md: string } {
  const dir = path.join(BUNDLE_DIR, bundleName, "accounting");
  const json = path.join(dir, `${network}.json`);
  const md = path.join(dir, `${network}.md`);
  writeAtomic(json, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(md, renderMarkdown(report));
  return { json, md };
}

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

      const { json, md } = writeAccounting(bundleName, network, report);
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
