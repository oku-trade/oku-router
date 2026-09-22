/**
 * feeScan.ts
 *
 * Discovery and valuation of idle protocol fees sitting on an OkuRouter.
 *
 * The router has NO fee accounting. Fees are not tracked in any state
 * variable or mapping -- they simply accumulate as the contract's own token
 * and ETH balance:
 *   - token -> token : fee is withheld from the input token (the router pulls
 *                      `sellAmount` but only approves `sellAmount - feeAmount`)
 *   - ETH   -> token : fee is withheld from msg.value
 *   - token -> ETH   : fee is taken in basis points out of the output ETH
 *
 * Consequently there is no view function to ask "what is collectable". The
 * only way to know is to (a) work out which assets have ever flowed through,
 * and (b) read `balanceOf(router)` for each. This module does both.
 *
 * Asset discovery is driven by the `OrderFilled` event, whose `tokenIn` is the
 * fee asset for every case except token -> ETH (where the fee is native). The
 * event's token fields are NOT indexed, so they cannot be filtered by topic --
 * logs must be fetched and decoded.
 *
 * Valuation is done from Uniswap V3 pools on the same chain rather than an
 * external price API, so it needs no key and cannot disagree with the chain.
 * Crucially it reports pool DEPTH alongside spot price: most of these assets
 * are long-tail tokens that happened to route through the router once, and a
 * spot price against an empty pool is a fiction. Callers should present the
 * depth-capped figure, not the notional.
 */
import type { JsonRpcProvider, Log } from "ethers";
import { Interface, getAddress, formatUnits } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import type { NetworkConfig } from "./deploymentConfig";
import { logsEnvVar } from "./safeChains";

/** Pseudo-address used to represent the chain's native asset in asset lists. */
export const NATIVE_SENTINEL = "native";

const ERC20_IFACE = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const FACTORY_IFACE = new Interface([
  "function getPool(address,address,uint24) view returns (address)",
]);

const POOL_IFACE = new Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
]);

/** Uniswap V3 fee tiers, in the order we prefer to probe them. */
const FEE_TIERS = [500, 3000, 100, 10000] as const;

/**
 * getLogs range caps vary enormously between providers, and none of them
 * advertise the limit -- you discover it by being rejected. Probed
 * high-to-low; the first span that returns is used for the whole scan.
 */
const RANGE_PROBES = [
  10_000_000, 1_000_000, 100_000, 10_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10,
];

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export interface FeeAsset {
  /** Checksummed ERC20 address, or NATIVE_SENTINEL. */
  token: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

export interface PriceInfo {
  /** USD per whole token. */
  usdPrice: number;
  /** Quote-token liquidity in the pool used, expressed in USD. */
  poolDepthUsd: number;
  /** e.g. "univ3:0xabc…@500" or "stable:usdc". */
  source: string;
}

export interface PricedFeeAsset extends FeeAsset {
  usdPrice?: number;
  usdValue?: number;
  poolDepthUsd?: number;
  /**
   * usdValue capped at a conservative fraction of pool depth. A long-tail
   * token can show a large notional against a pool with nothing in it; this
   * is the number to make decisions on.
   */
  realizableUsd?: number;
  priceSource?: string;
}

export interface ScanCoverage {
  fromBlock: number;
  toBlock: number;
  /** Log span the RPC accepted per request. */
  rangeUsed: number;
  /** True when history was truncated to respect the request budget. */
  partial: boolean;
  /** OrderFilled events decoded. */
  events: number;
  /** Distinct fee assets ever observed (before balance filtering). */
  everSeen: number;
  /**
   * Windows the RPC refused mid-scan. A single refused window does not abort
   * the scan, but it does leave a hole, so this must be surfaced: a caller
   * that persists a resume point would otherwise skip those blocks forever.
   */
  refusedWindows: number;
  /**
   * Highest block at or below which EVERY window was scanned successfully --
   * the only value an incremental scan may safely resume from.
   *
   * Null when the very first window was refused, meaning nothing contiguous
   * was established and there is no safe resume point.
   */
  scannedThrough: number | null;
}

export interface FeeScanResult {
  router: string;
  assets: PricedFeeAsset[];
  coverage: ScanCoverage | null;
  /** Non-fatal problems worth surfacing (RPC refused logs, pricing gaps, …). */
  warnings: string[];
}

/**
 * Checksum an address without validating the one it arrived with.
 *
 * ethers implements EIP-55, but Rootstock (and other chains) use EIP-1191,
 * which mixes the chainId into the checksum -- so an address that is
 * perfectly valid there fails EIP-55 validation. chain-config stores
 * addresses in each chain's native form, and `getAddress` on Rootstock's USDC
 * throws "bad address checksum", which previously took out valuation, and
 * therefore the entire scan, for that chain.
 *
 * Lowercasing first means we never validate an incoming checksum, only
 * recompute one. A malformed address (wrong length, non-hex) is still
 * rejected, which is the check that actually matters.
 *
 * Returns undefined rather than throwing so callers decide whether a bad
 * address is fatal.
 */
export function toChecksum(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return getAddress(value.trim().toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * The provider surface log discovery actually uses.
 *
 * Structural rather than the concrete JsonRpcProvider so the incremental
 * scan logic -- where the resume-point rules live, and where a bug silently
 * loses assets -- can be unit tested against a scripted fake instead of
 * needing a live chain.
 */
export type LogScanProvider = Pick<JsonRpcProvider, "getBlockNumber" | "getLogs">;

/** Fraction of pool depth we treat as realistically exitable. */
const REALIZABLE_DEPTH_FRACTION = 0.3;

/**
 * Quote-side liquidity, in USD, below which a pool is not treated as evidence
 * of a price at all. Deliberately tiny: the target is degenerate pools holding
 * fractions of a cent, not merely thin ones -- thin pools are already handled
 * honestly by the realizable cap.
 */
const MIN_POOL_DEPTH_USD = 1;

/**
 * Find the largest block span this endpoint will accept for eth_getLogs.
 * Returns 0 if the endpoint refuses even the smallest probe.
 */
export async function probeLogRange(
  provider: LogScanProvider,
  address: string,
  latest: number,
): Promise<number> {
  for (const span of RANGE_PROBES) {
    try {
      // Inclusive bounds: fromBlock..toBlock spans `span` blocks, not span+1.
      // Providers that advertise a "100 block range" reject 101, so being off
      // by one here silently downgrades the scan to nothing.
      await provider.getLogs({
        address,
        fromBlock: Math.max(0, latest - span + 1),
        toBlock: latest,
      });
      return span;
    } catch {
      // Refused: try a smaller window.
    }
  }
  return 0;
}

/**
 * Scan `OrderFilled` logs for every asset that has ever been taken as a fee.
 *
 * `maxRequests` bounds the work: on a chain with a 200-block log cap and
 * millions of blocks, a full-history scan is not viable. When the budget is
 * insufficient the scan walks BACKWARD from head and reports `partial: true`
 * so callers can say so out loud rather than implying completeness. Known
 * tokens are unioned in separately, which keeps the common assets covered
 * even on a partial scan.
 */
export async function scanFeeAssets(
  provider: LogScanProvider,
  router: string,
  opts: { maxRequests?: number; fromBlock?: number } = {},
): Promise<{ tokens: Set<string>; coverage: ScanCoverage | null }> {
  const maxRequests = opts.maxRequests ?? 400;
  const latest = await provider.getBlockNumber();
  const range = await probeLogRange(provider, router, latest);
  if (range === 0) return { tokens: new Set(), coverage: null };

  let from = opts.fromBlock ?? 0;
  let partial = false;
  const needed = Math.ceil((latest - from + 1) / range);
  if (needed > maxRequests) {
    from = Math.max(0, latest - maxRequests * range + 1);
    partial = true;
  }

  const win = await scanLogWindow(provider, router, from, latest, range);

  return {
    tokens: win.tokens,
    coverage: {
      fromBlock: from,
      toBlock: latest,
      rangeUsed: range,
      partial,
      events: win.events,
      everSeen: win.tokens.size,
      refusedWindows: win.refusedWindows,
      scannedThrough: win.scannedThrough,
    },
  };
}

/** Outcome of walking one contiguous block window for OrderFilled logs. */
export interface LogWindowResult {
  /** Fee assets (OrderFilled.tokenIn) observed in this window. */
  tokens: Set<string>;
  /** OrderFilled events decoded. */
  events: number;
  /** Windows the RPC refused. Non-zero means the coverage has holes. */
  refusedWindows: number;
  /**
   * Highest block reached with NO preceding refusal, i.e. the safe resume
   * point. `fromBlock - 1` if the first window was refused; null if that
   * would be negative (nothing contiguous was established at all).
   */
  scannedThrough: number | null;
}

/**
 * Walk `fromBlock..toBlock` inclusive in `range`-sized windows, collecting
 * fee assets from OrderFilled.
 *
 * A refused window is skipped rather than aborting the scan -- some endpoints
 * fail intermittently and giving up would discard everything already found.
 * But the resume point then STOPS ADVANCING. This is the whole reason the
 * function reports `scannedThrough` separately from `toBlock`: persisting
 * `toBlock` as a resume point after a mid-scan refusal would skip the
 * unscanned blocks permanently, and any asset first traded inside that hole
 * would become invisible to every future run. The hole is re-scanned instead.
 */
export async function scanLogWindow(
  provider: LogScanProvider,
  router: string,
  fromBlock: number,
  toBlock: number,
  range: number,
): Promise<LogWindowResult> {
  const topic = OkuRouter__factory.createInterface().getEvent("OrderFilled").topicHash;
  const tokens = new Set<string>();
  let events = 0;
  let refusedWindows = 0;
  let holed = false;
  let scannedThrough: number | null = fromBlock > 0 ? fromBlock - 1 : null;

  for (let start = fromBlock; start <= toBlock; start += range) {
    const end = Math.min(start + range - 1, toBlock);
    let logs: Log[];
    try {
      logs = await provider.getLogs({
        address: router,
        fromBlock: start,
        toBlock: end,
        topics: [topic],
      });
    } catch {
      refusedWindows++;
      holed = true;
      continue;
    }
    if (!holed) scannedThrough = end;
    for (const log of logs) {
      events++;
      // tokenIn is the first non-indexed field. A zero tokenIn means the swap
      // was ETH -> token, where the fee is native and there is no ERC20 to add.
      const tokenIn = `0x${log.data.slice(26, 66)}`;
      if (tokenIn !== ZERO_ADDR) tokens.add(getAddress(tokenIn));
    }
  }

  return { tokens, events, refusedWindows, scannedThrough };
}

/** Read symbol/decimals/balance for a set of candidate tokens, keeping non-zero ones. */
export async function readNonZeroBalances(
  provider: JsonRpcProvider,
  router: string,
  candidates: Iterable<string>,
): Promise<FeeAsset[]> {
  const out: FeeAsset[] = [];
  for (const raw of candidates) {
    const token = toChecksum(raw);
    if (!token) continue;
    try {
      const balRaw = await provider.call({
        to: token,
        data: ERC20_IFACE.encodeFunctionData("balanceOf", [router]),
      });
      const balance = BigInt(balRaw);
      if (balance === 0n) continue;

      const decRaw = await provider.call({
        to: token,
        data: ERC20_IFACE.encodeFunctionData("decimals", []),
      });
      const decimals = Number(BigInt(decRaw));

      let symbol = "?";
      try {
        const symRaw = await provider.call({
          to: token,
          data: ERC20_IFACE.encodeFunctionData("symbol", []),
        });
        symbol = ERC20_IFACE.decodeFunctionResult("symbol", symRaw)[0] as string;
      } catch {
        // Non-standard tokens (bytes32 symbol, or none) still sweep fine.
      }
      out.push({ token, symbol, decimals, balance });
    } catch {
      // Not a readable ERC20 at this address; nothing to sweep.
    }
  }
  return out;
}

/**
 * Spot price of `token` denominated in `quote`, from the deepest V3 pool.
 *
 * Returns the price as a float alongside the quote-side balance of the pool,
 * which is the honest measure of whether that price is obtainable.
 */
async function poolPrice(
  provider: JsonRpcProvider,
  factory: string,
  token: string,
  tokenDecimals: number,
  quote: string,
  quoteDecimals: number,
): Promise<{ price: number; quoteBalance: bigint; pool: string; fee: number } | null> {
  let best: { price: number; quoteBalance: bigint; pool: string; fee: number } | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const res = await provider.call({
        to: factory,
        data: FACTORY_IFACE.encodeFunctionData("getPool", [token, quote, fee]),
      });
      const pool = getAddress(`0x${res.slice(26)}`);
      if (pool === ZERO_ADDR) continue;

      const slot0 = await provider.call({
        to: pool,
        data: POOL_IFACE.encodeFunctionData("slot0", []),
      });
      const sqrtPriceX96 = BigInt(POOL_IFACE.decodeFunctionResult("slot0", slot0)[0]);
      if (sqrtPriceX96 === 0n) continue;

      const t0Raw = await provider.call({
        to: pool,
        data: POOL_IFACE.encodeFunctionData("token0", []),
      });
      const token0 = getAddress(POOL_IFACE.decodeFunctionResult("token0", t0Raw)[0] as string);

      const quoteBalRaw = await provider.call({
        to: quote,
        data: ERC20_IFACE.encodeFunctionData("balanceOf", [pool]),
      });
      const quoteBalance = BigInt(quoteBalRaw);

      // price of token1 per token0, in raw units, carried through BigInt so a
      // small ratio does not truncate to zero before it reaches a float.
      const scaled = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / 2n ** 192n;
      const raw = Number(scaled) / 1e18;
      if (!Number.isFinite(raw) || raw === 0) continue;

      const price =
        token0 === getAddress(token)
          ? raw * 10 ** (tokenDecimals - quoteDecimals)
          : (1 / raw) * 10 ** (tokenDecimals - quoteDecimals);
      if (!Number.isFinite(price) || price <= 0) continue;

      if (!best || quoteBalance > best.quoteBalance) best = { price, quoteBalance, pool, fee };
    } catch {
      // Missing or unreadable pool at this tier.
    }
  }
  return best;
}

/**
 * Normalize a ticker for native-vs-wrapped comparison: "WETH" -> "ETH",
 * "WAVAX" -> "AVAX", "CELO" -> "CELO".
 */
function bareSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/^W/, "");
}

/**
 * Does `token` look like the wrapped form of `nativeSymbol`?
 *
 * Returns false if the symbol cannot be read. A non-standard token that will
 * not answer symbol() is not evidence that it wraps the native asset, and
 * guessing yes is how a chain ends up valuing its gas token as ether.
 */
export async function symbolMatchesNative(
  provider: JsonRpcProvider,
  token: string,
  nativeSymbol: string,
): Promise<boolean> {
  if (!nativeSymbol) return false;
  try {
    const raw = await provider.call({
      to: token,
      data: ERC20_IFACE.encodeFunctionData("symbol", []),
    });
    const sym = ERC20_IFACE.decodeFunctionResult("symbol", raw)[0] as string;
    return bareSymbol(sym) === bareSymbol(nativeSymbol);
  } catch {
    return false;
  }
}

/**
 * Attach USD valuations to a set of assets using on-chain V3 pools.
 *
 * Tries token/USDC first and token/WETH second, preferring whichever pool
 * holds more quote-side liquidity. Assets with no pool are left unpriced
 * rather than assigned a zero, so "unknown" is distinguishable from
 * "worthless".
 */
export async function priceAssets(
  provider: JsonRpcProvider,
  cfg: NetworkConfig,
  assets: FeeAsset[],
): Promise<{ priced: PricedFeeAsset[]; nativeUsd: number | null; warnings: string[] }> {
  const warnings: string[] = [];
  const uni = (cfg.chain as unknown as { uniswap?: { poolFactory?: string } }).uniswap;
  const factory = uni?.poolFactory;
  const usdc = cfg.usdcAddress;
  const weth = cfg.wethAddress;

  if (!factory || !usdc || !weth) {
    warnings.push(`no V3 factory/USDC/WETH for ${cfg.networkName}; valuations unavailable`);
    return { priced: assets.map((a) => ({ ...a })), nativeUsd: null, warnings };
  }

  const usdcAddr = toChecksum(usdc);
  const wethAddr = toChecksum(weth);
  if (!usdcAddr || !wethAddr) {
    warnings.push(
      `${cfg.networkName}: malformed USDC/WETH address in chain config; valuations unavailable`,
    );
    return { priced: assets.map((a) => ({ ...a })), nativeUsd: null, warnings };
  }

  // USDC decimals, read once; it anchors every other price.
  let usdcDecimals = 6;
  try {
    const d = await provider.call({ to: usdcAddr, data: ERC20_IFACE.encodeFunctionData("decimals", []) });
    usdcDecimals = Number(BigInt(d));
  } catch {
    warnings.push("could not read USDC decimals; assuming 6");
  }

  const ethPoolRaw = await poolPrice(provider, factory, wethAddr, 18, usdcAddr, usdcDecimals);
  // The anchor pool. Every WETH-quoted price is multiplied by this one, so a
  // dust-liquidity anchor would propagate a fabricated number across the
  // whole chain rather than to a single asset.
  const ethPool =
    ethPoolRaw && Number(formatUnits(ethPoolRaw.quoteBalance, usdcDecimals)) >= MIN_POOL_DEPTH_USD
      ? ethPoolRaw
      : null;
  const wethUsd = ethPool ? ethPool.price : null;
  if (!wethUsd) {
    warnings.push(
      `${cfg.networkName}: no WETH/USDC pool with usable liquidity; native and ` +
        `WETH-quoted assets are unpriced`,
    );
  }

  // Is cfg.wethAddress actually the WRAPPED FORM OF THIS CHAIN'S NATIVE ASSET?
  //
  // Usually yes -- it is WAVAX on Avalanche, WXDAI on Gnosis, WBNB on BSC,
  // WRBTC on Rootstock. But on Polygon it is bridged WETH while the native
  // asset is POL, and assuming otherwise priced 9.6 POL at $26,447 by giving
  // it the price of ether: a 10,000x overstatement, and enough on its own to
  // make a whole-estate total meaningless.
  //
  // Checked by reading the symbol rather than keeping a per-chain table,
  // because a table is exactly the thing that silently goes stale. If it
  // cannot be established, native is left UNPRICED: this module's rule is
  // that unknown must stay distinguishable from worthless, and a wrong price
  // is far worse than no price.
  const wethIsWrappedNative = await symbolMatchesNative(provider, wethAddr, cfg.nativeSymbol);
  const nativeUsd = wethIsWrappedNative ? wethUsd : null;
  if (!wethIsWrappedNative && assets.some((a) => a.token === NATIVE_SENTINEL)) {
    warnings.push(
      `${cfg.networkName}: the configured WETH is not the wrapped form of ${cfg.nativeSymbol}, ` +
        `so the native balance is left unpriced rather than valued as ether.`,
    );
  }

  const priced: PricedFeeAsset[] = [];
  for (const a of assets) {
    const amount = Number(formatUnits(a.balance, a.decimals));

    if (a.token === NATIVE_SENTINEL) {
      if (nativeUsd !== null) {
        priced.push({
          ...a,
          usdPrice: nativeUsd,
          usdValue: amount * nativeUsd,
          poolDepthUsd: ethPool ? Number(formatUnits(ethPool.quoteBalance, usdcDecimals)) : undefined,
          realizableUsd: amount * nativeUsd,
          priceSource: ethPool ? `univ3:${ethPool.pool}@${ethPool.fee}` : "unpriced",
        });
      } else {
        priced.push({ ...a });
      }
      continue;
    }

    if (toChecksum(a.token) === wethAddr) {
      // The WETH token itself is priced off its own pool regardless of what
      // the native asset is -- that part was never ambiguous.
      if (wethUsd !== null) {
        priced.push({
          ...a,
          usdPrice: wethUsd,
          usdValue: amount * wethUsd,
          poolDepthUsd: ethPool ? Number(formatUnits(ethPool.quoteBalance, usdcDecimals)) : undefined,
          realizableUsd: amount * wethUsd,
          priceSource: ethPool ? `univ3:${ethPool.pool}@${ethPool.fee}` : "unpriced",
        });
      } else {
        priced.push({ ...a });
      }
      continue;
    }

    if (toChecksum(a.token) === usdcAddr) {
      priced.push({
        ...a,
        usdPrice: 1,
        usdValue: amount,
        realizableUsd: amount,
        priceSource: "stable:usdc",
      });
      continue;
    }

    const viaUsdc = await poolPrice(provider, factory, a.token, a.decimals, usdcAddr, usdcDecimals);
    const viaWeth = nativeUsd !== null
      ? await poolPrice(provider, factory, a.token, a.decimals, wethAddr, 18)
      : null;

    const cands: { usd: number; depth: number; src: string }[] = [];
    if (viaUsdc) {
      cands.push({
        usd: amount * viaUsdc.price,
        depth: Number(formatUnits(viaUsdc.quoteBalance, usdcDecimals)),
        src: `univ3:${viaUsdc.pool}@${viaUsdc.fee}`,
      });
    }
    if (viaWeth && nativeUsd !== null) {
      cands.push({
        usd: amount * viaWeth.price * nativeUsd,
        depth: Number(formatUnits(viaWeth.quoteBalance, 18)) * nativeUsd,
        src: `univ3:${viaWeth.pool}@${viaWeth.fee}`,
      });
    }
    // Deepest pool wins: it is the one whose price is actually obtainable.
    cands.sort((x, y) => y.depth - x.depth);
    const pick = cands[0];
    if (!pick) {
      priced.push({ ...a });
      continue;
    }
    // A pool holding essentially nothing does not establish a price; its
    // sqrtPriceX96 is whatever the last trade left behind, and dividing by a
    // dust reserve produces numbers with no meaning. One mainnet token quoted
    // $9.4e41 against a pool holding $2.7e-9, which alone made the estate
    // total read as 4.4e41 dollars.
    //
    // Reporting no price is the honest outcome. The module's rule that
    // "unknown" must stay distinguishable from "worthless" cuts both ways: a
    // fabricated price is worse than an absent one, because only the absent
    // one prompts someone to go and look.
    if (pick.depth < MIN_POOL_DEPTH_USD) {
      priced.push({ ...a, poolDepthUsd: pick.depth, priceSource: "unpriced:no-liquidity" });
      continue;
    }
    priced.push({
      ...a,
      usdPrice: pick.usd / (amount || 1),
      usdValue: pick.usd,
      poolDepthUsd: pick.depth,
      realizableUsd: Math.min(pick.usd, pick.depth * REALIZABLE_DEPTH_FRACTION),
      priceSource: pick.src,
    });
  }

  return { priced, nativeUsd, warnings };
}

/**
 * Full idle-fee picture for one chain: discover assets, read balances, price.
 *
 * `includeNative` adds the router's ETH balance as a synthetic asset so the
 * caller can present one list; `sweepAll` takes native via its `includeEth`
 * flag rather than an array entry, so callers must NOT pass the sentinel into
 * the tokens array.
 */
export async function scanChainFees(
  provider: JsonRpcProvider,
  cfg: NetworkConfig,
  router: string,
  opts: {
    maxRequests?: number;
    price?: boolean;
    /**
     * Pre-computed discovery, so a caller that already knows which assets have
     * ever flowed through (from the incremental cache, or from an earlier
     * snapshot) does not pay for log discovery a second time. Balances are
     * ALWAYS re-read live regardless, so injecting a stale token set can only
     * omit a newly-traded asset -- it can never produce a wrong amount.
     */
    discovery?: { tokens: Iterable<string>; coverage: ScanCoverage | null };
  } = {},
): Promise<FeeScanResult> {
  const warnings: string[] = [];

  const discovered =
    opts.discovery ??
    (await scanFeeAssets(provider, router, { maxRequests: opts.maxRequests }));
  const tokens = new Set<string>(discovered.tokens);
  const coverage = discovered.coverage;
  if (!coverage) {
    warnings.push(
      `${cfg.networkName}: RPC refused eth_getLogs at every probed range, so long-tail ` +
        `assets CANNOT be discovered -- only well-known tokens are covered. Re-run with ` +
        `--rpc <endpoint that supports eth_getLogs> for a complete picture.`,
    );
  } else if (coverage.partial) {
    const blocks = coverage.toBlock - coverage.fromBlock + 1;
    warnings.push(
      `${cfg.networkName}: INCOMPLETE. This endpoint caps eth_getLogs at ${coverage.rangeUsed} ` +
        `block(s), so within the request budget only the last ${blocks} blocks ` +
        `(${coverage.fromBlock}-${coverage.toBlock}) were scanned. Assets last traded before ` +
        `that appear only if well-known. Set ${logsEnvVar(cfg.networkName)} to a wider-range ` +
        `endpoint, or raise --max-requests, for full history.`,
    );
  }
  if (coverage && coverage.refusedWindows > 0) {
    warnings.push(
      `${cfg.networkName}: ${coverage.refusedWindows} log window(s) were refused mid-scan, ` +
        `so discovery has holes. The resume point was held at block ` +
        `${coverage.scannedThrough ?? coverage.fromBlock} so the gap is re-scanned next run ` +
        `rather than skipped forever.`,
    );
  }

  // Union in the chain's well-known tokens. This is what keeps a partial or
  // refused log scan from missing USDC/WETH/WBTC, which is where the value is.
  const known = (cfg.chain as unknown as { token?: Record<string, string> }).token ?? {};
  for (const v of [known.wethAddress, known.wbtcAddress, known.usdcAddress, cfg.wethAddress, cfg.usdcAddress]) {
    const addr = toChecksum(v);
    if (addr) tokens.add(addr);
  }

  const erc20 = await readNonZeroBalances(provider, router, tokens);

  const assets: FeeAsset[] = [...erc20];
  const nativeBal = await provider.getBalance(router);
  if (nativeBal > 0n) {
    assets.push({
      token: NATIVE_SENTINEL,
      symbol: cfg.nativeSymbol,
      decimals: 18,
      balance: nativeBal,
    });
  }

  if (opts.price === false) {
    return { router, assets, coverage, warnings };
  }

  const { priced, warnings: priceWarnings } = await priceAssets(provider, cfg, assets);
  warnings.push(...priceWarnings);

  priced.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
  return { router, assets: priced, coverage, warnings };
}

/** Sum helpers used by both the scan task and the accounting report. */
export function totalUsd(assets: PricedFeeAsset[]): { notional: number; realizable: number } {
  let notional = 0;
  let realizable = 0;
  for (const a of assets) {
    notional += a.usdValue ?? 0;
    realizable += a.realizableUsd ?? 0;
  }
  return { notional, realizable };
}

/** Human-readable amount, for tables and the accounting markdown. */
export function fmtAmount(a: { balance: bigint; decimals: number }): string {
  return formatUnits(a.balance, a.decimals);
}
