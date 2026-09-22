/**
 * testForkSweepWorldchain.ts
 *
 * Local rehearsal of a fee sweep, against a fork of the real chain, before
 * any signature is collected.
 *
 * What it does:
 *   1. Forks the target chain at its latest block.
 *   2. Snapshots router and recipient balances for every asset in the bundle.
 *   3. Impersonates the Safe -- which is the router's actual `owner()` -- and
 *      issues the bundle's `sweepAll` call(s) verbatim.
 *   4. Re-reads every balance, decodes the emitted events, and reconciles the
 *      two against each other.
 *   5. Writes an accounting artifact in the SAME schema as a real execution,
 *      tagged `mode: "fork-simulation"`.
 *
 * Why impersonation rather than a signed SafeTx: `sweepAll` is `onlyOwner`,
 * and the owner is the Safe, so acting AS the Safe exercises the authorization
 * path that matters for the sweep itself. The `execTransaction` path
 * (threshold, nonce, signature recovery) is validated separately by
 * `safe:exec`'s dry run, which simulates the real call against the real chain
 * with the real signatures before broadcasting.
 *
 * The events-vs-deltas reconciliation is the point of the exercise, not
 * decoration: `sweepAll` emits the router's balance as read BEFORE transfer,
 * so a fee-on-transfer or rebasing token delivers less than it claims. This
 * catches that on a fork instead of in the books.
 *
 * Usage:
 *   npx hardhat run scripts/testForkSweepWorldchain.ts
 *   SWEEP_BUNDLE=sweep-worldchain npx hardhat run scripts/testForkSweepWorldchain.ts
 *
 * Env:
 *   SWEEP_BUNDLE     bundle name (default: newest sweep-* in safe-bundles/)
 *   SWEEP_NETWORK    network within the bundle (default: first chain)
 *   SWEEP_FORK_RPC   RPC to fork from (default: the hardhat network's url)
 *   FORK_CHAIN_ID    set this to the real chainId so the artifact is labelled
 *                    correctly; hardhat_reset cannot change chainId itself.
 */
import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import { Interface, formatUnits, getAddress, parseEther, toBeHex } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { NETWORK_CONFIGS } from "../util/deploymentConfig";
import { NATIVE_SENTINEL, priceAssets, type FeeAsset } from "../util/feeScan";
import { buildReport, renderMarkdown, type AccountingAsset } from "../util/feeAccounting";
import { writeAccounting } from "../tasks/feeAccounting";

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
]);

interface SweepManifestAsset {
  token: string;
  symbol: string;
  decimals: number;
  amountRaw: string;
  amount: string;
}

function newestSweepBundle(): string {
  const files = fs
    .readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, f), "utf8"));
        return b?.intent === "sweep" ? { name: f.replace(/\.json$/, ""), createdAt: b.createdAt ?? "" } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; createdAt: string } => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (files.length === 0) {
    throw new Error(
      "no sweep bundle found in safe-bundles/. Build one first:\n" +
        "  npx hardhat safe:build --intent sweep --networks worldchain",
    );
  }
  return files[0].name;
}

async function balanceOf(
  provider: JsonRpcProvider,
  token: string,
  holder: string,
): Promise<bigint> {
  if (token === NATIVE_SENTINEL) return provider.getBalance(holder);
  return BigInt(await provider.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [holder]) }));
}

async function main() {
  const bundleName = process.env.SWEEP_BUNDLE ?? newestSweepBundle();
  const bundlePath = path.join(BUNDLE_DIR, `${bundleName}.json`);
  if (!fs.existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  if (bundle.intent !== "sweep") {
    throw new Error(`bundle ${bundleName} has intent "${bundle.intent}", expected "sweep"`);
  }

  const networkName: string = process.env.SWEEP_NETWORK ?? bundle.chains[0]?.network;
  const chain = bundle.chains.find((c: { network: string }) => c.network === networkName);
  if (!chain) throw new Error(`bundle has no chain entry for ${networkName}`);
  if (!chain.sweep) throw new Error(`chain entry for ${networkName} has no sweep manifest`);

  const cfg = NETWORK_CONFIGS[networkName];
  const router: string = getAddress(chain.router);
  const safe: string = getAddress(bundle.safe);
  const recipient: string = getAddress(chain.sweep.recipient);

  const forkRpc =
    process.env.SWEEP_FORK_RPC ??
    ((hre.config.networks as Record<string, { url?: string }>)[networkName]?.url ?? "");
  if (!forkRpc) throw new Error(`no RPC to fork from for ${networkName}`);

  console.log("=".repeat(96));
  console.log(`FORK SWEEP SIMULATION  --  ${networkName}`);
  console.log("=".repeat(96));
  console.log(`Bundle    : ${bundleName}`);
  console.log(`Router    : ${router}`);
  console.log(`Safe      : ${safe}  (impersonated)`);
  console.log(`Recipient : ${recipient}`);
  console.log(`Calls     : ${chain.calls.length}`);
  console.log(`Assets    : ${chain.sweep.assets.length}`);

  // ---- 1. Fork -----------------------------------------------------------
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: forkRpc } }],
  });
  const provider = hre.ethers.provider as unknown as JsonRpcProvider;
  const forkChainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const blockNumber = await provider.getBlockNumber();
  console.log(`\nForked at block ${blockNumber}. EVM chainId reports ${forkChainId}.`);
  if (forkChainId !== chain.chainId) {
    console.log(
      `  NOTE: real chainId is ${chain.chainId}. hardhat_reset cannot change the\n` +
        `  network's chainId, so re-run with FORK_CHAIN_ID=${chain.chainId} if you need\n` +
        `  the artifact and any chainId-dependent logic to match reality.`,
    );
  }

  // Verify the premise: the Safe really is the owner on the forked state.
  const routerRead = OkuRouter__factory.connect(router, provider);
  const onChainOwner = getAddress(await routerRead.owner());
  if (onChainOwner !== safe) {
    throw new Error(`router owner is ${onChainOwner}, not the Safe ${safe}; refusing to continue`);
  }
  console.log(`Confirmed router.owner() == Safe.`);

  // ---- 2. Snapshot BEFORE (and before any balance manipulation) ----------
  const manifest: SweepManifestAsset[] = chain.sweep.assets;
  const before = new Map<string, { router: bigint; recipient: bigint }>();
  for (const a of manifest) {
    before.set(a.token, {
      router: await balanceOf(provider, a.token, router),
      recipient: await balanceOf(provider, a.token, recipient),
    });
  }
  console.log(`Snapshotted ${before.size} asset balances for router and recipient.`);

  // ---- 3. Impersonate the Safe and sweep ---------------------------------
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [safe] });
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [safe, toBeHex(parseEther("10"))],
  });

  const receipts: { hash: string; gasUsed: bigint; gasPrice: bigint; logs: readonly unknown[] }[] = [];
  try {
    const safeSigner = await hre.ethers.getSigner(safe);
    for (const [i, call] of chain.calls.entries()) {
      console.log(`\n  [${i + 1}/${chain.calls.length}] ${String(call.label).slice(0, 120)}`);
      const sent = await safeSigner.sendTransaction({
        to: call.to,
        data: call.data,
        value: BigInt(call.value ?? "0"),
      });
      const rc = await sent.wait();
      if (!rc) throw new Error("no receipt");
      console.log(`      tx ${rc.hash}  status=${rc.status}  gasUsed=${rc.gasUsed}`);
      if (rc.status !== 1) throw new Error(`sweep call ${i + 1} reverted`);
      receipts.push({ hash: rc.hash, gasUsed: rc.gasUsed, gasPrice: rc.gasPrice ?? 0n, logs: rc.logs });
    }
  } finally {
    await hre.network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [safe],
    });
  }

  // ---- 4. Decode events and snapshot AFTER -------------------------------
  const iface = OkuRouter__factory.createInterface();
  const tokenTopic = iface.getEvent("TokenWithdrawn").topicHash;
  const ethTopic = iface.getEvent("EthWithdrawn").topicHash;

  const eventAmounts = new Map<string, bigint>();
  for (const rc of receipts) {
    for (const raw of rc.logs as { address: string; topics: string[]; data: string }[]) {
      if (getAddress(raw.address) !== router) continue;
      if (raw.topics[0] === tokenTopic) {
        const p = iface.decodeEventLog("TokenWithdrawn", raw.data, raw.topics);
        const k = getAddress(p[0] as string);
        eventAmounts.set(k, (eventAmounts.get(k) ?? 0n) + (p[2] as bigint));
      } else if (raw.topics[0] === ethTopic) {
        const p = iface.decodeEventLog("EthWithdrawn", raw.data, raw.topics);
        eventAmounts.set(
          NATIVE_SENTINEL,
          (eventAmounts.get(NATIVE_SENTINEL) ?? 0n) + (p[1] as bigint),
        );
      }
    }
  }

  const assets: AccountingAsset[] = [];
  const forPricing: FeeAsset[] = [];
  const warnings: string[] = [];

  for (const a of manifest) {
    const pre = before.get(a.token)!;
    const routerAfter = await balanceOf(provider, a.token, router);
    const recipientAfter = await balanceOf(provider, a.token, recipient);
    const delta = recipientAfter - pre.recipient;
    const ev = eventAmounts.get(a.token);

    if (ev === undefined && pre.router > 0n) {
      warnings.push(`${a.symbol}: held ${formatUnits(pre.router, a.decimals)} but emitted no withdrawal event`);
    }

    assets.push({
      token: a.token,
      symbol: a.symbol,
      decimals: a.decimals,
      amountRaw: delta.toString(),
      amount: formatUnits(delta, a.decimals),
      eventAmountRaw: ev?.toString(),
      routerBalanceBefore: pre.router.toString(),
      routerBalanceAfter: routerAfter.toString(),
      recipientBalanceBefore: pre.recipient.toString(),
      recipientBalanceAfter: recipientAfter.toString(),
      recipientDeltaRaw: delta.toString(),
      deltaMatchesEvent: ev === undefined ? undefined : delta === ev,
    });
    forPricing.push({ token: a.token, symbol: a.symbol, decimals: a.decimals, balance: delta });
  }

  // ---- 5. Price and report ----------------------------------------------
  let nativeUsdPrice: number | undefined;
  if (cfg) {
    try {
      const { priced, nativeUsd, warnings: pw } = await priceAssets(provider, cfg, forPricing);
      nativeUsdPrice = nativeUsd ?? undefined;
      warnings.push(...pw);
      for (const p of priced) {
        const t = assets.find((x) => x.token === p.token);
        if (!t) continue;
        t.usdPrice = p.usdPrice;
        t.usdValue = p.usdValue;
        t.poolDepthUsd = p.poolDepthUsd;
        t.realizableUsd = p.realizableUsd;
        t.priceSource = p.priceSource;
      }
    } catch (e) {
      warnings.push(`pricing failed: ${String((e as { message?: string }).message ?? e).slice(0, 80)}`);
    }
  }

  const totalGas = receipts.reduce((s, r) => s + r.gasUsed, 0n);
  const gasPrice = receipts[0]?.gasPrice ?? 0n;
  const gasCostWei = totalGas * gasPrice;
  const blk = await provider.getBlock(await provider.getBlockNumber());

  warnings.push(
    "fork simulation: gas price and native valuation come from the forked EVM, not the live chain",
  );

  const report = buildReport({
    mode: "fork-simulation",
    bundle: bundleName,
    network: networkName,
    chainId: chain.chainId,
    router,
    safe,
    recipient,
    nativeUsdPrice,
    warnings,
    execution: {
      txHash: receipts.map((r) => r.hash).join(","),
      blockNumber: blk?.number ?? 0,
      blockTimestamp: blk ? new Date(blk.timestamp * 1000).toISOString() : "unknown",
      relayer: safe,
      safeNonce: chain.nonce,
      safeTxHash: chain.safeTxHash,
      gasUsed: totalGas.toString(),
      effectiveGasPrice: gasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      gasCostNative: formatUnits(gasCostWei, 18),
      gasCostUsd: nativeUsdPrice !== undefined ? Number(formatUnits(gasCostWei, 18)) * nativeUsdPrice : undefined,
      status: "success",
    },
    assets,
  });

  const { json, md } = writeAccounting(report);

  // ---- 6. Assertions -----------------------------------------------------
  console.log(`\n${"-".repeat(96)}`);
  console.log(renderMarkdown(report));
  console.log("-".repeat(96));
  console.log(`Artifacts:\n  ${json}\n  ${md}`);

  const moved = assets.filter((a) => BigInt(a.amountRaw) > 0n);

  const failures: string[] = [];
  if (!report.reconciliation.allRouterBalancesZero) {
    failures.push(
      `router still holds: ${report.reconciliation.residuals.map((r) => `${r.symbol} ${r.amount}`).join(", ")}`,
    );
  }
  // A sweep of an already-empty router trivially satisfies every other
  // assertion: nothing reverts, no balance is left behind, and no event
  // contradicts a delta. Reporting that as a pass would mean the rehearsal
  // proves nothing on exactly the run where it matters least -- so require
  // that something actually moved.
  if (moved.length === 0) {
    failures.push(
      "nothing moved: the router held no balance for any asset in the bundle, so this " +
        "run exercised no transfer path. Rebuild the bundle against current balances.",
    );
  }
  if (!report.reconciliation.eventsMatchBalanceDeltas) {
    failures.push(`event/delta mismatch on ${report.reconciliation.discrepancies.length} asset(s)`);
  }
  for (const a of assets) {
    if (BigInt(a.recipientDeltaRaw ?? "0") <= 0n && BigInt(a.routerBalanceBefore ?? "0") > 0n) {
      failures.push(`${a.symbol}: router held a balance but recipient received nothing`);
    }
  }

  if (failures.length) {
    console.log(`\nSIMULATION FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  // Report what actually moved, not how many entries the manifest had -- the
  // two diverge whenever balances changed between build and rehearsal.
  const skipped = assets.length - moved.length;
  console.log(
    `\nSIMULATION PASSED. ${moved.length} of ${assets.length} manifest asset(s) moved` +
      `${skipped > 0 ? ` (${skipped} held a zero balance and were skipped)` : ""}, ` +
      `router fully drained, every event reconciled against a measured recipient delta.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
