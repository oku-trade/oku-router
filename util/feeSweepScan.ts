/**
 * feeSweepScan.ts
 *
 * One chain's fee scan, packaged as a SnapshotChain.
 *
 * Shared by `fees:scan` and `fees:cycle` so the two cannot drift: the report
 * an operator reads and the data a sweep bundle is built from must come from
 * the same code path, or the bundle will eventually disagree with the report
 * that authorized it.
 *
 * Every failure mode is captured as a status rather than thrown. A 34-chain
 * sweep must not lose 33 chains because one endpoint timed out, but it must
 * also not quietly treat that timeout as "nothing to collect".
 */
import { makeProvider, type SafeChain } from "./safeChains";
import { NETWORK_CONFIGS } from "./deploymentConfig";
import { scanChainFees, totalUsd } from "./feeScan";
import { discoverFeeAssets } from "./feeAssetCache";
import { toSnapshotAsset, type SnapshotChain } from "./feeSnapshot";

export interface ChainScanOptions {
  /** Per-chain eth_getLogs request budget. */
  maxRequests?: number;
  /**
   * Resume from the cached block interval. Default true. When false the scan
   * re-walks history from scratch; already-known token addresses are retained
   * either way, since an address that once took a fee always did.
   */
  useCache?: boolean;
  /** Persist the updated discovery cache. Default true. */
  writeCache?: boolean;
  /** USD valuation. Default true. */
  price?: boolean;
  /** Explicit RPC, overriding both logsRpcUrl and rpcUrl. Single-chain use. */
  rpcOverride?: string;
}

/**
 * Scan one chain and return its snapshot entry.
 *
 * The logs endpoint (`<NET>_LOGS_URL`) is used for the whole chain when set,
 * not just for eth_getLogs. A logs-capable endpoint is by definition a
 * superset of a plain one, and running balance reads through a second
 * provider would double the connection count across 34 chains for no gain.
 */
export async function scanChainForSnapshot(
  chain: SafeChain,
  opts: ChainScanOptions = {},
): Promise<SnapshotChain> {
  const base: SnapshotChain = {
    network: chain.network,
    chainId: chain.chainId,
    router: chain.router,
    status: "empty",
    coverage: null,
    cacheHit: false,
    usedLogsRpc: false,
    warnings: [],
    assets: [],
    totals: { assetCount: 0, usdNotional: 0, usdRealizable: 0 },
  };

  const rpc = opts.rpcOverride ?? chain.logsRpcUrl ?? chain.rpcUrl;
  if (!rpc) return { ...base, status: "no-rpc" };
  if (!chain.router) return { ...base, status: "no-rpc", error: "no OkuRouter in deployments/" };

  const cfg = NETWORK_CONFIGS[chain.network];
  if (!cfg) return { ...base, status: "no-config" };

  const usedLogsRpc = !opts.rpcOverride && Boolean(chain.logsRpcUrl);
  const provider = makeProvider(rpc, chain.chainId);
  try {
    const discovery = await discoverFeeAssets(
      provider,
      { network: chain.network, chainId: chain.chainId, router: chain.router },
      {
        maxRequests: opts.maxRequests,
        useCache: opts.useCache,
        write: opts.writeCache,
      },
    );

    const res = await scanChainFees(provider, cfg, chain.router, {
      price: opts.price !== false,
      discovery: { tokens: discovery.tokens, coverage: discovery.coverage },
    });

    const { notional, realizable } = totalUsd(res.assets);
    return {
      ...base,
      status: res.assets.length > 0 ? "has-fees" : "empty",
      coverage: discovery.coverage,
      cacheHit: discovery.cacheHit,
      usedLogsRpc,
      warnings: res.warnings,
      assets: res.assets.map(toSnapshotAsset),
      totals: {
        assetCount: res.assets.length,
        usdNotional: notional,
        usdRealizable: realizable,
      },
    };
  } catch (e) {
    const msg = String((e as { message?: string }).message ?? e);
    return { ...base, status: "error", usedLogsRpc, error: msg.slice(0, 200) };
  } finally {
    provider.destroy();
  }
}
