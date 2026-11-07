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
 * DUPLICATED, NOT SHARED: a sibling repo that operates the production Safe
 * multisig and fee collection keeps its own copy of this exact file (it has
 * no build dependency on this repo). Any edit to `DEPLOYMENT_OVERRIDES`,
 * `knownSwapTargets`/`extraSwapTargets`, or anything else in this file that
 * the two need to agree on (they do) must be applied to both copies by hand.
 * There is currently no shared package enforcing that; a stale copy there
 * degrades to a stale whitelist/config, not a build failure, so it will not
 * announce itself.
 *
 * `@gfxlabs/oku-chains` is installed from the published npm registry,
 * exact-pinned in `package.json` (currently `1.21.0`, published from
 * chain-config b5015c0). Bump it deliberately in both repos together: every
 * new `marketRouters` entry becomes a swap target that must be whitelisted
 * through the Safe. 1.15.1 adds the Rango Diamond router on 16 chains and
 * corrects Celo's uniswap SwapRouter02 to 0x5615CDAb10dc425a742d643d949a7F474C01abc4
 * (0x68b3...Fc45 is an unrelated contract on Celo; it is no longer in config
 * but remains whitelisted on the Celo router until explicitly removed).
 * 1.16.0 adds the shared threeroute router 0x333333333c306C76f341028122ae7c90A334D176
 * on mainnet, base, monad, robinhood and etherlink (sonic too, but OkuRouter
 * is not deployed there). On etherlink it replaces threeroute
 * 0x1B62C2CEf163E3120E512F71F6e6E99058c80F6E, which likewise stays
 * whitelisted on-chain until explicitly removed.
 * 1.21.0 adds elysium (chainId 99901), the first version that has it. Every
 * hardhat command fails at config load on an older version, because the
 * `elysium` network entry resolves its chainId through `networkByName`.
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
  /**
   * Swap targets to whitelist that chain-config's `marketRouters` does not
   * (yet) carry. Merged into `knownSwapTargets`; chain-config wins on a
   * duplicate address, so this degrades to a no-op once upstream catches up
   * rather than producing a duplicate entry.
   *
   * ONLY add an address here that Oku's own backend has explicitly named --
   * i.e. one that appeared in an `OKU_ROUTER_SWAP_TARGET_NOT_ALLOWED`
   * response. Never add an address inferred from another chain, from
   * bytecode similarity, or from a vendor's documentation.
   *
   * The reason is the blast radius of `updateSwapTargets`: a whitelisted
   * target receives ERC20 approvals and an arbitrary `.call{value:}()` from
   * the router, so a wrong address is a direct path to draining in-flight
   * user funds and accumulated fees. Every entry must cite the response that
   * named it.
   */
  extraSwapTargets?: SwapTarget[];
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
    //
    // `marketRouters` is still empty in chain-config for pharos (0 entries),
    // and `markets` is `{}`, so `buildKnownSwapTargets` yields nothing. The
    // routers below therefore come from `extraSwapTargets` instead. Remove
    // them once chain-config publishes pharos `marketRouters` -- the merge
    // dedupes by address, so leaving them is harmless in the meantime.
    supportedRouters: ["icecreamswap", "okx"],
    canonicalPermit2: true,
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    rpcUrl: process.env.PHAROS_URL,
    // Both addresses were named by Oku's own backend in
    // `OKU_ROUTER_SWAP_TARGET_NOT_ALLOWED` responses for
    // chain_id=1672 oku_router=0xb1f3a7B816B0681188F54dFa400991B93ADf00ed
    // (PROS -> USDC quotes). Both verified on-chain as contracts and as not
    // currently whitelisted.
    //
    // Deliberately NOT included: okx runs three contracts per chain
    // elsewhere (~24.5KB / ~13.3KB / ~1.6KB) and only the 13.3KB one was
    // named here. The other two are not inferred -- if an okx route later
    // fails naming a new address, that response is the authority for adding
    // it. `usor` is absent for a different reason: its pharos quote failed
    // with an upstream HTTP 500 from the market, not a whitelist rejection,
    // so there is no target to add.
    extraSwapTargets: [
      {
        address: "0x2Ca37ff95caF25366eF16fc2E655b78a165D125F",
        name: "icecreamswap",
        protocol: "icecreamswap",
      },
      {
        address: "0x974d1cF6FFA4fCE5a4d62955AFc02F45aAC29f35",
        name: "okx",
        protocol: "okx",
      },
    ],
  },
  elysium: {
    // Kinetiq's Arbitrum Orbit L2 settling to HyperEVM, chainId 99901, HYPE
    // gas. First published in @gfxlabs/oku-chains 1.21.0.
    //
    // chain-config records canonical Permit2 (verified on-chain via
    // eth_getCode). `marketRouters` was deliberately left empty upstream
    // until the aggregator deployments were confirmed. At launch, aggregators supplied their elysium addresses directly. They
    // are carried in `extraSwapTargets` below until chain-config publishes
    // them (the merge then drops the local copies).
    //
    // `create2FactoryAddress` is intentionally unset. As of 2026-11-06 the
    // Safe Singleton Factory has no code on elysium, and its deployer
    // 0xE1CB04A0fA36DdD16a06ea828007E35e1a3cBC37 is still at nonce 0. Safe
    // has not yet published a pre-signed deployment for 99901. So OkuRouter
    // is deployed here with plain CREATE (`deploy` without --deterministic),
    // at an address derived from the deployer's nonce rather than the shared
    // 0xb1f3a7B8… address. That tradeoff was accepted. Redeploying at the
    // canonical address later, once the factory exists, is fine: set this
    // field and run `deploy --deterministic`.
    supportedRouters: ["enso", "icecreamswap", "kyberswap", "openocean"],
    canonicalPermit2: true,
    rpcUrl: process.env.ELYSIUM_URL,
    // A pre-launch exception to the "backend-named only" rule above: the
    // backend has no elysium routes yet to name anything, so every entry
    // here was supplied by the protocol and approved directly by the
    // operator. Apply with:
    //   npx hardhat whitelist-swap-targets --fork-network elysium   (dry run)
    //   npx hardhat whitelist-swap-targets --network elysium
    extraSwapTargets: [
      // OpenOcean's usual router address (chain-config lists the same one on
      // base, arbitrum, optimism and hyperevm). Approved 2026-11-06. Checked
      // on-chain: an EIP-1967 proxy with the same ProxyAdmin as on Base
      // (0xc979fec5bf053d0d52cada4cfe1c25737731502d), and the proxy and
      // implementation (0xed85325119ccfc6acb16fa931bac6378b76e4615) runtime
      // code are identical to Base's except for the solc metadata hash.
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "openocean",
        protocol: "openocean",
      },
      // Supplied by IceCreamSwap (ICS) for elysium, approved 2026-11-06.
      // ICS deploys a different router address on each chain, so there is no
      // cross-chain code comparison; checked only that it has code (1,775 bytes).
      // Kyber and Enso below were compared against other chains' code, and
      // all five new targets were whitelisted 2026-11-06 after a fork dry run.
      {
        address: "0x6af335771d1DdF7dD1501eCC89e978455Fe5c6Dd",
        name: "icecreamswap",
        protocol: "icecreamswap",
      },
      // Supplied by Enso, approved 2026-11-06. The same address chain-config
      // lists for enso on robinhood, with runtime code identical to it apart
      // from the solc metadata hash.
      {
        address: "0xCfBAa9Cfce952Ca4F4069874fF1Df8c05e37a3c7",
        name: "enso",
        protocol: "enso",
      },
      // Supplied by KyberSwap, approved 2026-11-06. The router is the same
      // address chain-config lists on base, arbitrum, optimism, ethereum,
      // hyperevm and robinhood. On those chains only the router is
      // whitelisted; Kyber asked for the executor proxy and input-scale
      // helper here too, and the operator approved all three. Checked
      // on-chain against hyperevm/base/robinhood:
      //   - router: same code as hyperevm except its WETH immutable (elysium
      //     WHYPE 0xbA87…5E81 vs hyperevm 0x5555…) and the metadata hash.
      //     Its owner() differs: 0xBE2F0354D970265BFc36D383af77F72736b81B54
      //     here vs 0x1874028262F1F4B2DD1F2700A72Ee8b9b7C69090 on hyperevm.
      //   - executor proxy: identical code to base, hyperevm and robinhood.
      //   - input-scale helper: an ERC-1967 proxy to the same implementation
      //     as hyperevm (0x6d88e9296f51ebe4044a6f518b529c2b4861579a).
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "kyberswap MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x8F10B468b06c6FD214B65F87778827F7D113f996",
        name: "kyberswap AggregationExecutorProxy",
        protocol: "kyberswap",
      },
      {
        address: "0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D",
        name: "kyberswap InputScaleHelper",
        protocol: "kyberswap",
      },
    ],
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
function buildKnownSwapTargets(
  chain: IChainInfo,
  extra: SwapTarget[] = [],
): SwapTarget[] {
  // Annotated explicitly: without it TS infers `name`/`protocol` as
  // `keyof MarketRouters` from chain-config's `market` field, which then
  // rejects the plain-string names carried by `extraSwapTargets`.
  const targets: SwapTarget[] = marketRouterEntries(chain).map(
    ({ market, address }) => ({
      address: getAddress(address.toLowerCase()),
      name: market,
      protocol: market,
    }),
  );

  // Merge locally-configured supplements, deduped by address with
  // chain-config taking precedence. That ordering matters: once upstream
  // publishes a router we are carrying in `extraSwapTargets`, the local entry
  // silently drops out instead of producing a duplicate whitelist write.
  const seen = new Set(targets.map((t) => t.address.toLowerCase()));
  for (const t of extra) {
    const address = getAddress(t.address.toLowerCase());
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    targets.push({ ...t, address });
  }
  return targets;
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
    knownSwapTargets: buildKnownSwapTargets(chain, override.extraSwapTargets),
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
