/**
 * safeChains.ts
 *
 * Shared multi-chain plumbing for the safe:* tasks.
 *
 * All of the safe:* tasks sweep every chain in deployments/ in a single
 * process, which means they cannot use `hre.ethers` (bound to one
 * `--network`). This module centralizes the provider/key/gas handling that
 * tasks/whitelistSwapTargets.ts established, so the four safe tasks don't
 * each re-derive it.
 */
import * as fs from "fs";
import * as path from "path";
import { JsonRpcProvider, Network, Wallet } from "ethers";
import type { TransactionReceipt } from "ethers";
import { sleep } from "./rpcRetry";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

export interface SafeChain {
  /** hardhat network name, e.g. "arbitrum". */
  network: string;
  chainId: number;
  rpcUrl: string;
  /** Live OkuRouter address from the registry, if deployed. */
  router?: string;
  /** `owner` field recorded in the registry (not a live read). */
  recordedOwner?: string;
  /** Safe address recorded in the registry, if already deployed. */
  recordedSafe?: string;
  /** Raw hardhat network config, for gas overrides. */
  netCfg: Record<string, unknown>;
}

/**
 * Enumerate deployed chains from deployments/*.json.
 *
 * Chains with a registry file but no usable RPC in hardhat.config.ts are
 * returned with an empty rpcUrl so callers can report them explicitly rather
 * than silently omitting them -- a silently-skipped chain during an ownership
 * migration is exactly the kind of gap that leaves one router stranded.
 */
export function listSafeChains(
  hre: HardhatRuntimeEnvironment,
  only?: Set<string>,
): SafeChain[] {
  const dir = path.resolve(__dirname, "..", "deployments");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: SafeChain[] = [];
  for (const file of files) {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const network: string = reg.networkName;
    if (only && !only.has(network)) continue;
    const netCfg = ((hre.config.networks as Record<string, unknown>)[network] ??
      {}) as Record<string, unknown>;
    out.push({
      network,
      chainId: Number(reg.chainId),
      rpcUrl: typeof netCfg.url === "string" ? netCfg.url : "",
      router: reg.current?.OkuRouter?.address,
      recordedOwner: reg.current?.OkuRouter?.owner,
      recordedSafe: reg.current?.Safe?.address,
      netCfg,
    });
  }
  out.sort((a, b) => a.chainId - b.chainId);
  return out;
}

/**
 * Build a provider for one chain.
 *
 * batchMaxCount: 1 disables JSON-RPC request batching. Several chains here
 * (plasma, xdc) run nodes that mishandle batched payloads and return a
 * malformed response, which ethers surfaces as an opaque "could not coalesce
 * error" even though the same call succeeds alone.
 *
 * staticNetwork pins the chainId so the provider never runs background
 * network auto-detection. That polling lives outside the caller's await
 * chain, so a flaky endpoint would otherwise surface as an unhandled
 * rejection that kills the whole sweep instead of degrading to one skipped
 * chain.
 */
export function makeProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, chainId, {
    batchMaxCount: 1,
    staticNetwork: Network.from(chainId),
  });
}

/**
 * Pull the deployer private key out of the hardhat network config rather than
 * using hre.ethers, because these tasks iterate many networks in one process.
 * Mirrors resolveAccountKey() in tasks/whitelistSwapTargets.ts.
 */
export function resolveDeployerKey(
  hre: HardhatRuntimeEnvironment,
  network: string,
): string | undefined {
  const accounts = (hre.config.networks as Record<string, { accounts?: unknown }>)[
    network
  ]?.accounts;
  const key = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof key !== "string") return undefined;
  // The repo uses an all-zero key as the "unset" sentinel.
  if (/^(0x)?0{64}$/.test(key)) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

/**
 * Per-network gas overrides from hardhat.config.ts.
 *
 * Saga mines zero-price txs (baseFee = gasPrice = 0) and xdc rejects EIP-1559,
 * so both pin an explicit legacy gasPrice that ethers must not auto-populate
 * over. Any task that sends a transaction must apply these.
 */
export function gasOverrides(chain: SafeChain): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const gp = chain.netCfg.gasPrice;
  if (gp !== undefined && gp !== "auto") {
    overrides.gasPrice = BigInt(gp as string | number);
  }
  return overrides;
}

/** Convenience: provider + optional wallet, with guaranteed cleanup. */
export async function withChain<T>(
  hre: HardhatRuntimeEnvironment,
  chain: SafeChain,
  fn: (ctx: { provider: JsonRpcProvider; wallet?: Wallet }) => Promise<T>,
  opts: { needSigner?: boolean } = {},
): Promise<T> {
  if (!chain.rpcUrl) {
    throw new Error(`NO_RPC configured for network ${chain.network}`);
  }
  const provider = makeProvider(chain.rpcUrl, chain.chainId);
  try {
    let wallet: Wallet | undefined;
    if (opts.needSigner) {
      const key = resolveDeployerKey(hre, chain.network);
      if (!key) throw new Error(`NO_KEY configured for network ${chain.network}`);
      wallet = new Wallet(key, provider);
    }
    return await fn({ provider, wallet });
  } finally {
    provider.destroy();
  }
}

/**
 * Wait for a transaction receipt by polling `eth_getTransactionReceipt`
 * directly, instead of using ethers' `tx.wait()`.
 *
 * Why not tx.wait(): it subscribes to new blocks and, on a provider without
 * filter support, ethers falls back to fetching full blocks on an interval.
 * On XDC that blew a 4 GB heap and killed a 32-chain deploy sweep mid-run
 * (the transaction had already succeeded on chain; only the receipt wait
 * died). Polling a single receipt hash allocates nothing per iteration and
 * behaves identically on all 34 chains.
 *
 * Returns null on timeout rather than throwing. Callers must treat that as
 * "unknown, go verify the real success condition" -- for a deploy that means
 * checking `getCode` at the target address, which is authoritative anyway.
 */
export async function confirmTx(
  provider: JsonRpcProvider,
  txHash: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TransactionReceipt | null> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
    } catch {
      // Transient RPC failure: keep polling until the deadline.
    }
    await sleep(pollMs);
  }
  return null;
}

/**
 * Poll `eth_getCode` until bytecode appears at `address`, or give up.
 *
 * A single getCode immediately after a receipt is not reliable across these
 * 34 chains: several (observed on Nibiru, and on XDC when the receipt poll
 * times out) serve reads from a node that has not yet caught up, so the call
 * returns "0x" for an address that is genuinely deployed. Treating that as a
 * failure produces a false NO_CODE_POST_DEPLOY and, worse, skips recording a
 * deployment that actually exists.
 *
 * Returns true as soon as code is observed.
 */
export async function waitForCode(
  provider: JsonRpcProvider,
  address: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await provider.getCode(address)) !== "0x") return true;
    } catch {
      // Transient RPC failure: keep polling until the deadline.
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Poll a read until it returns the expected value, or give up.
 *
 * Same hazard as waitForCode(): several of these chains (observed on Celo,
 * Nibiru, XDC) serve reads from a node that has not yet applied the block we
 * just got a receipt for, so a post-write verification read can return the
 * *previous* value and produce a false failure. That is especially dangerous
 * for an ownership migration, where a false negative invites the operator to
 * re-send a transaction that already succeeded.
 *
 * Comparison is case-insensitive so address casing cannot cause a spurious
 * mismatch.
 */
export async function waitForValue(
  read: () => Promise<string>,
  expected: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ok: boolean; last: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      last = await read();
      if (last.toLowerCase() === expected.toLowerCase()) return { ok: true, last };
    } catch {
      // Transient RPC failure: keep polling until the deadline.
    }
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(pollMs);
  }
}

/**
 * Bounded-concurrency map.
 *
 * The safe:* tasks fan out across 34 different RPC endpoints, so some
 * parallelism is safe (unlike batching requests to a single node). We cap it
 * anyway: several of these chains share an Alchemy key, and an unbounded fan
 * out reliably trips per-key rate limits.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Right-pad helper for the aligned summary tables these tasks print. */
export function pad(s: unknown, n: number): string {
  return String(s ?? "").padEnd(n);
}

/** Format a wei balance as a short decimal string for tables. */
export function fmtEther(wei: bigint, decimals = 4): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
