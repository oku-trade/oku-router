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
}

export interface FeeScanResult {
  router: string;
  assets: PricedFeeAsset[];
  coverage: ScanCoverage | null;
  /** Non-fatal problems worth surfacing (RPC refused logs, pricing gaps, …). */
  warnings: string[];
}

/** Fraction of pool depth we treat as realistically exitable. */
const REALIZABLE_DEPTH_FRACTION = 0.3;

/**
 * Find the largest block span this endpoint will accept for eth_getLogs.
 * Returns 0 if the endpoint refuses even the smallest probe.
 */
async function probeLogRange(
  provider: JsonRpcProvider,
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
  provider: JsonRpcProvider,
  router: string,
  opts: { maxRequests?: number; fromBlock?: number } = {},
): Promise<{ tokens: Set<string>; coverage: ScanCoverage | null }> {
  const maxRequests = opts.maxRequests ?? 400;
  const latest = await provider.getBlockNumber();
  const range = await probeLogRange(provider, router, latest);
  if (range === 0) return { tokens: new Set(), coverage: null };

  const topic = OkuRouter__factory.createInterface().getEvent("OrderFilled").topicHash;

  let from = opts.fromBlock ?? 0;
  let partial = false;
  const needed = Math.ceil((latest - from + 1) / range);
  if (needed > maxRequests) {
    from = Math.max(0, latest - maxRequests * range + 1);
    partial = true;
  }

  const tokens = new Set<string>();
  let events = 0;
  for (let start = from; start <= latest; start += range) {
    const end = Math.min(start + range - 1, latest);
    let logs: Log[];
    try {
      logs = await provider.getLogs({ address: router, fromBlock: start, toBlock: end, topics: [topic] });
    } catch {
      // A single refused window should not abandon the whole scan.
      continue;
    }
    for (const log of logs) {
      events++;
      // tokenIn is the first non-indexed field. A zero tokenIn means the swap
      // was ETH -> token, where the fee is native and there is no ERC20 to add.
      const tokenIn = `0x${log.data.slice(26, 66)}`;
      if (tokenIn !== ZERO_ADDR) tokens.add(getAddress(tokenIn));
    }
  }

  return {
    tokens,
    coverage: { fromBlock: from, toBlock: latest, rangeUsed: range, partial, events, everSeen: tokens.size },
  };
}

/** Read symbol/decimals/balance for a set of candidate tokens, keeping non-zero ones. */
export async function readNonZeroBalances(
  provider: JsonRpcProvider,
  router: string,
  candidates: Iterable<string>,
): Promise<FeeAsset[]> {
  const out: FeeAsset[] = [];
  for (const raw of candidates) {
    let token: string;
    try {
      token = getAddress(raw);
    } catch {
      continue;
    }
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

  const usdcAddr = getAddress(usdc);
  const wethAddr = getAddress(weth);

  // USDC decimals, read once; it anchors every other price.
  let usdcDecimals = 6;
  try {
    const d = await provider.call({ to: usdcAddr, data: ERC20_IFACE.encodeFunctionData("decimals", []) });
    usdcDecimals = Number(BigInt(d));
  } catch {
    warnings.push("could not read USDC decimals; assuming 6");
  }

  const ethPool = await poolPrice(provider, factory, wethAddr, 18, usdcAddr, usdcDecimals);
  const nativeUsd = ethPool ? ethPool.price : null;
  if (!nativeUsd) warnings.push("no WETH/USDC pool; native and WETH-quoted assets unpriced");

  const priced: PricedFeeAsset[] = [];
  for (const a of assets) {
    const amount = Number(formatUnits(a.balance, a.decimals));

    if (a.token === NATIVE_SENTINEL || getAddress2(a.token) === wethAddr) {
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

    if (getAddress2(a.token) === usdcAddr) {
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

/** getAddress that tolerates the native sentinel. */
function getAddress2(v: string): string {
  try {
    return getAddress(v);
  } catch {
    return v;
  }
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
  opts: { maxRequests?: number; price?: boolean } = {},
): Promise<FeeScanResult> {
  const warnings: string[] = [];

  const { tokens, coverage } = await scanFeeAssets(provider, router, {
    maxRequests: opts.maxRequests,
  });
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
        `that appear only if well-known. Use --rpc with a wider-range endpoint, or raise ` +
        `--max-requests, for full history.`,
    );
  }

  // Union in the chain's well-known tokens. This is what keeps a partial or
  // refused log scan from missing USDC/WETH/WBTC, which is where the value is.
  const known = (cfg.chain as unknown as { token?: Record<string, string> }).token ?? {};
  for (const v of [known.wethAddress, known.wbtcAddress, known.usdcAddress, cfg.wethAddress, cfg.usdcAddress]) {
    if (v) {
      try {
        tokens.add(getAddress(v));
      } catch {
        // ignore malformed config entries
      }
    }
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
