/**
 * networkConfig.ts
 *
 * @deprecated This module is deprecated and kept only as a compatibility
 * shim. Chain identity (chainId, native currency, WETH/USDC addresses,
 * Permit2, and known router/aggregator addresses to whitelist) now comes
 * from `@gfxlabs/oku-chains` -- the shared chain-config package used across
 * gfx labs' infrastructure -- combined with a small local overrides map for
 * deployment-specific data (owner address, supported backend router names,
 * CREATE2 factory address, RPC URL). See `util/deploymentConfig.ts` for the
 * replacement implementation.
 *
 * All in-repo consumers have been migrated to `util/deploymentConfig.ts`
 * directly; this file re-exports the same names purely so any
 * not-yet-updated external script or one-off tooling importing from
 * "../util/networkConfig" doesn't break outright. New code should import
 * from `util/deploymentConfig.ts` instead. This shim will be removed in a
 * future cleanup once nothing references it.
 */

export {
  type SwapTarget,
  type NetworkConfig,
  NETWORK_CONFIGS,
  getNetworkConfig,
  getNetworkConfigByChainId,
  isRouterSupported,
  getSupportedNetworks,
} from "./deploymentConfig";
