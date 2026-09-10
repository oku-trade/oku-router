/**
 * deploymentConfig.ts
 *
 * Static, per-chain initialization parameters for the Oku Router deployment
 * tasks and test harness, sourced from `@gfxlabs/oku-chains` (the same
 * chain-config package used across gfx labs projects) plus a small local
 * overrides map for deployment-specific data that package does not (and
 * should not) carry:
 *
 *   - `ownerAddress`       — Oku Router constructor owner
 *   - `supportedRouters`   — backend router names to test/whitelist
 *   - `canonicalPermit2`   — whether this chain uses the canonical Uniswap
 *                            Permit2 deployment (0x000000000022D4730...)
 *   - `create2FactoryAddress` — Safe Singleton Factory address, when deployed
 *   - `rpcUrl`             — resolved from an env var per chain
 *
 * Chain identity (chainId, native currency, WETH/USDC addresses, Permit2,
 * and known router/aggregator contract addresses to whitelist) all come
 * from `@gfxlabs/oku-chains`, which is the single source of truth shared
 * with the rest of gfx labs' infrastructure (and is kept up to date with
 * "marketRouters" data as new third-party routers are deployed).
 *
 * This module replaces `util/networkConfig.ts` (deprecated, see that file).
 *
 * `@gfxlabs/oku-chains` is installed from the published npm registry, range
 * pinned in `package.json` (currently `^1.12.42`; installed 1.12.42 as of
 * this writing) for reproducible-enough deploys while still picking up
 * chain-config fixes. It was confirmed to include the marketRouters
 * reconciliation (oneinch/unizen/propellerswap/binance/native additions,
 * telos's new marketRouters block, robinhood's full router set), the fynd
 * router addition, and the bitget router addition (mainnet, arbitrum, base,
 * bsc, polygon, avalanche, hyperevm) this migration depends on.
 *
 * Note that 1.12.40 filed the TychoRouterV3 addresses under `fynd` rather
 * than `propellerswap`, so `marketRouters.fynd` on those chains holds two
 * unrelated vendors' routers. That only affects per-market attribution --
 * the on-chain whitelist is keyed on address alone, so it is harmless here.
 */

import { getAddress } from "ethers";
import {
  type IChainInfo,
  type MarketRouterName,
  marketRouterEntries,
  networkByName,
} from "@gfxlabs/oku-chains";

export interface SwapTarget {
  address: string;
  name: string;
  protocol: string;
}

export interface NetworkConfig {
  networkName: string;
  chainId: number;
  chainName: string; // chain-config internalName, e.g. "optimism", "base"
  wethAddress: string;
  usdcAddress?: string;
  nativeSymbol: string;
  supportedRouters: string[];
  knownSwapTargets: SwapTarget[];
  ownerAddress: string;
  permit2Address: string;
  canonicalPermit2: boolean;
  rpcUrl?: string;
  create2FactoryAddress?: string;
  /** The underlying chain-config chain object, for anything not surfaced above. */
  chain: IChainInfo;
}

/**
 * Deployment-specific overrides, keyed by hardhat network name.
 *
 * `internalName` is only set where it differs from the hardhat network key
 * (chain-config's naming almost always matches 1:1 -- "op" -> "optimism",
 * "avax" -> "avalanche", and "mainnet" -> "ethereum" are the only
 * exceptions).
 */
interface DeploymentOverride {
  internalName?: string;
  supportedRouters: string[];
  canonicalPermit2: boolean;
  create2FactoryAddress?: string;
  rpcUrl?: string;
}

// Every chain shares the same Oku Router constructor owner.
const OWNER_ADDRESS = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// Canonical Uniswap Permit2 deployment address, used as a fallback when
// chain-config has not (yet) recorded a chain's permit2 address but the
// chain is known to use the canonical deployment.
const CANONICAL_PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const DEPLOYMENT_OVERRIDES: Record<string, DeploymentOverride> = {
  op: {
    internalName: "optimism",
    supportedRouters: ["enso","icecreamswap","odos","oneinch","paraswap","kyberswap","unizen","okx","zeroex","openocean","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.OP_URL,
  },
  base: {
    supportedRouters: ["kyberswap","icecreamswap","openocean","enso","odos","oneinch","okx","paraswap","fabric","usor","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.BASE_URL,
  },
  worldchain: {
    supportedRouters: ["icecreamswap","enso","usor","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.WORLDCHAIN_URL,
  },
  bsc: {
    supportedRouters: ["oneinch","odos","kyberswap","paraswap","zeroex","okx","icecreamswap","openocean","enso","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.BSC_URL,
  },
  polygon: {
    supportedRouters: ["oneinch","odos","kyberswap","paraswap","zeroex","okx","openocean","enso","icecreamswap","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.POLYGON_URL,
  },
  arbitrum: {
    supportedRouters: ["oneinch","odos","kyberswap","paraswap","zeroex","okx","icecreamswap","openocean","enso","fabric","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.ARB_URL,
  },
  taiko: {
    supportedRouters: ["kyberswap"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.TAIKO_URL,
  },
  celo: {
    supportedRouters: ["icecreamswap","openocean"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.CELO_URL,
  },
  avax: {
    internalName: "avalanche",
    supportedRouters: ["oneinch","odos","kyberswap","zeroex","okx","icecreamswap","openocean","enso","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.AVAX_URL,
  },
  linea: {
    supportedRouters: ["oneinch","odos","kyberswap","zeroex","icecreamswap","openocean","enso","okx","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.LINEA_URL,
  },
  blast: {
    supportedRouters: ["zeroex","icecreamswap","openocean"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.BLAST_URL,
  },
  scroll: {
    supportedRouters: ["odos","kyberswap","zeroex","icecreamswap","openocean"],
    // chain-config has scroll's canonical Permit2 recorded (and it's
    // confirmed on-chain at 0xb1f3a7B8… matching the canonical prediction),
    // so this was a stale `false` left over from before that data existed.
    // Harmless in practice (chain-config's `permit2` field wins via
    // resolvePermit2Address()), but corrected so this flag isn't a trap for
    // future readers.
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.SCROLL_URL,
  },
  zksync: {
    supportedRouters: ["odos","kyberswap","oneinch","openocean"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.ZKSYNC_URL,
  },
  monad: {
    supportedRouters: ["enso","icecreamswap","kyberswap","okx","openocean","usor","zeroex"],
    canonicalPermit2: true,
    rpcUrl: process.env.MONAD_URL,
  },
  sei: {
    supportedRouters: ["enso","icecreamswap","openocean","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.SEI_URL,
  },
  rootstock: {
    supportedRouters: ["openocean","icecreamswap","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.ROOTSTOCK_URL,
  },
  filecoin: {
    supportedRouters: ["usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.FILECOIN_URL,
  },
  boba: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.BOBA_URL,
  },
  telos: {
    supportedRouters: ["icecreamswap","openocean"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.TELOS_URL,
  },
  lightlink: {
    supportedRouters: ["icecreamswap"],
    canonicalPermit2: false,
    rpcUrl: process.env.LIGHTLINK_URL,
  },
  hemi: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.HEMI_URL,
  },
  xdc: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.XDC_URL,
  },
  unichain: {
    supportedRouters: ["odos","kyberswap","openocean","propellerswap","enso","icecreamswap","okx","paraswap","usor","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.UNICHAIN_URL,
  },
  sonic: {
    supportedRouters: ["kyberswap","odos","openocean"],
    canonicalPermit2: true,
    rpcUrl: process.env.SONIC_URL,
  },
  redbelly: {
    supportedRouters: ["usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.REDBELLY_URL,
  },
  lens: {
    supportedRouters: [],
    canonicalPermit2: false,
    rpcUrl: process.env.LENS_URL,
  },
  goat: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.GOAT_URL,
  },
  mantle: {
    supportedRouters: ["odos","zeroex","icecreamswap","openocean","okx","usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.MANTLE_URL,
  },
  nibiru: {
    supportedRouters: ["usor"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.NIBIRU_URL,
  },
  plasma: {
    supportedRouters: ["kyberswap","openocean","enso","icecreamswap","okx","usor","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.PLASMA_URL,
  },
  etherlink: {
    supportedRouters: ["kyberswap","threeroute","usor"],
    canonicalPermit2: false,
    rpcUrl: process.env.ETHERLINK_URL,
  },
  bob: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: false,
    rpcUrl: process.env.BOB_URL,
  },
  corn: {
    supportedRouters: [],
    canonicalPermit2: false,
    rpcUrl: process.env.CORN_URL,
  },
  gnosis: {
    supportedRouters: ["oneinch","paraswap","openocean","enso","icecreamswap","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.GNOSIS_URL,
  },
  gensyn: {
    supportedRouters: ["icecreamswap","usor"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.GENSYN_URL,
  },
  robinhood: {
    supportedRouters: ["enso","fabric","icecreamswap","kyberswap","native","okx","openocean","uniswap","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
  },
  // --- Full-scope expansion additions below ---
  mainnet: {
    internalName: "ethereum",
    // chain-config's `uniswap.permit2` is now populated for ethereum (see
    // src/definitions/mainnet.ts upstream), but canonicalPermit2 is kept
    // `true` here too as a belt-and-suspenders fallback in case an older
    // published chain-config version (without that field) is installed.
    supportedRouters: ["binance","enso","icecreamswap","kyberswap","native","odos","okx","openocean","paraswap","uniswap","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.MAINNET_URL,
  },
  saga: {
    supportedRouters: ["uniswap"],
    canonicalPermit2: false,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.SAGA_URL,
  },
  zerog: {
    supportedRouters: ["icecreamswap","uniswap"],
    // Same stale-flag correction as scroll above -- chain-config has
    // zerog's canonical Permit2 recorded and it's confirmed on-chain at
    // 0xb1f3a7B8… matching the canonical prediction.
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.ZEROG_URL,
  },
  hyperevm: {
    // Same belt-and-suspenders note as `mainnet` above -- chain-config now
    // has real `uniswap.permit2` data for hyperevm too, manually confirmed
    // via eth_getCode against the canonical Permit2 address.
    supportedRouters: ["enso","icecreamswap","kyberswap","okx","openocean","zeroex"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.HYPEREVM_URL,
  },
  pharos: {
    // chain-config now has real `uniswap.permit2` data for pharos (confirmed
    // canonical per https://docs.pharos.xyz/getting-started/canonical-contracts
    // Pacific Mainnet table, and verified on-chain via eth_getCode). Kept as
    // a belt-and-suspenders fallback per the same pattern as mainnet/hyperevm.
    // `marketRouters` is still empty in chain-config (0 entries) -- no
    // swap targets to whitelist yet, same situation as `celo`.
    supportedRouters: [],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.PHAROS_URL,
  },
};

/**
 * Resolve the wrapped-native ("WETH-equivalent") address for a chain.
 *
 * Prefers chain-config's `uniswap.wrappedNativeAddress` (the address
 * actually used for wrap/unwrap and as the "WETH" leg of swaps on this
 * chain -- e.g. WMATIC/WPOL on Polygon, WAVAX on Avalanche). Falls back to
 * `token.wethAddress`, and then `token.nativeAddress` for chains like Celo
 * where the native gas token is itself an ERC-20 and chain-config models it
 * under `token.nativeAddress` rather than `uniswap.wrappedNativeAddress`.
 */
function resolveWethAddress(chain: IChainInfo): string {
  return (
    chain.uniswap.wrappedNativeAddress ??
    chain.token.wethAddress ??
    chain.token.nativeAddress ??
    ""
  );
}

/**
 * Resolve the Permit2 address for a chain. Chain-config has this for every
 * chain except a handful that use the canonical Uniswap deployment but
 * haven't had it recorded upstream yet -- fall back to the canonical
 * address in that case (canonicalPermit2 is only set `true` for chains that
 * are, in fact, canonical).
 */
function resolvePermit2Address(
  chain: IChainInfo,
  canonicalPermit2: boolean,
): string {
  return (
    chain.uniswap.permit2 ??
    (canonicalPermit2 ? CANONICAL_PERMIT2_ADDRESS : "")
  );
}

/**
 * Build the `knownSwapTargets` whitelist for a chain from chain-config's
 * `marketRouters` data. Each `{market, address}` entry becomes a
 * `SwapTarget`; `name` and `protocol` are both set to the market name since
 * chain-config groups addresses by market rather than tracking individual
 * per-address display names.
 *
 * Addresses are re-checksummed via `getAddress(addr.toLowerCase())` rather
 * than passed through verbatim. chain-config is consumed by both Go and TS:
 * Go's `common.HexToAddress` ignores EIP-55 casing entirely, so an address
 * with a malformed mixed-case checksum round-trips fine there and can ship
 * in a published package unnoticed. ethers v6, by contrast, *throws*
 * ("bad address checksum") the moment such a string is encoded into a call.
 *
 * That is not hypothetical: `@gfxlabs/oku-chains@1.12.38` shipped mainnet's
 * `marketRouters.fabric` as 0x4296339B4Ff8E67f07De40D97A49a680F2598e0F,
 * whose correct EIP-55 form is 0x4296339B4FF8E67f07de40D97A49A680F2598e0f
 * (same 20 bytes, wrong casing). Left unnormalized it would blow up both
 * the swap-target whitelist and any subsequent mainnet deploy that calls
 * `registerSwapTargets`. Lowercasing first discards the (untrusted) casing
 * and lets ethers recompute the canonical checksum, so upstream casing bugs
 * degrade to a no-op here instead of a hard failure.
 */
function buildKnownSwapTargets(chain: IChainInfo): SwapTarget[] {
  return marketRouterEntries(chain).map(({ market, address }) => ({
    address: getAddress(address.toLowerCase()),
    name: market,
    protocol: market,
  }));
}

function resolveNetworkConfig(
  networkName: string,
  override: DeploymentOverride,
): NetworkConfig {
  const internalName = override.internalName ?? networkName;
  const chain = networkByName(internalName);

  return {
    networkName,
    chainId: chain.id,
    chainName: chain.internalName,
    wethAddress: resolveWethAddress(chain),
    usdcAddress: chain.token.usdcAddress,
    nativeSymbol: chain.nativeCurrency.symbol,
    supportedRouters: override.supportedRouters,
    knownSwapTargets: buildKnownSwapTargets(chain),
    ownerAddress: OWNER_ADDRESS,
    permit2Address: resolvePermit2Address(chain, override.canonicalPermit2),
    canonicalPermit2: override.canonicalPermit2,
    rpcUrl: override.rpcUrl,
    create2FactoryAddress: override.create2FactoryAddress,
    chain,
  };
}

/**
 * All supported network configs, keyed by hardhat network name. Resolved
 * eagerly at module load (mirrors the old static `NETWORK_CONFIGS` const in
 * `networkConfig.ts`) so a bad chain-config lookup fails loudly at import
 * time rather than being deferred to whenever a given network is first
 * touched.
 */
export const NETWORK_CONFIGS: Record<string, NetworkConfig> = Object.fromEntries(
  Object.entries(DEPLOYMENT_OVERRIDES).map(([networkName, override]) => [
    networkName,
    resolveNetworkConfig(networkName, override),
  ]),
);

// Get network config by network name (e.g., "op", "base", "worldchain")
export function getNetworkConfig(networkName: string): NetworkConfig {
  const config = NETWORK_CONFIGS[networkName];

  if (!config) {
    throw new Error(
      `No configuration found for network: ${networkName}. ` +
        `Available networks: ${Object.keys(NETWORK_CONFIGS).join(", ")}`,
    );
  }

  return config;
}

// Get network config by chain ID
export function getNetworkConfigByChainId(chainId: number): NetworkConfig {
  const config = Object.values(NETWORK_CONFIGS).find(
    (c) => c.chainId === chainId,
  );

  if (!config) {
    throw new Error(
      `No configuration found for chain ID: ${chainId}. ` +
        `Available chain IDs: ${Object.values(NETWORK_CONFIGS)
          .map((c) => c.chainId)
          .join(", ")}`,
    );
  }

  return config;
}

// Check if a network supports a specific router
export function isRouterSupported(
  networkName: string,
  routerName: string,
): boolean {
  const config = NETWORK_CONFIGS[networkName];
  return config ? config.supportedRouters.includes(routerName) : false;
}

// Get all supported network names
export function getSupportedNetworks(): string[] {
  return Object.keys(NETWORK_CONFIGS);
}

export type { MarketRouterName };
