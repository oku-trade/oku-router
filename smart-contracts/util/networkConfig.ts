/**
 * networkConfig.ts
 *
 * Static, per-chain initialization parameters for the Oku Router deployment
 * tasks and test harness. This module is intentionally *only* about chain
 * identity (chainId, RPC, WETH/USDC, owner, supported routers, known swap
 * targets to whitelist). It does NOT carry live contract addresses.
 *
 * Live OkuRouter / Permit2Proxy addresses and deployment blocks are stored in
 * the on-disk registry at `deployments/<networkName>.json` and accessed via
 * `util/deploymentsRegistry.ts` (`getCurrentAddress(networkName, contract)`).
 * Keeping the two surfaces separate prevents the drift we used to see when
 * the same address lived as both a hardcoded literal here and a registry
 * entry there.
 *
 * Supported aggregator entry points (where deployed):
 * - 1inch (AggregationRouterV6): 0x111111125421ca6dc452d289314280a0f8842a65 (same on every supported chain)
 * - KyberSwap (MetaAggregationRouterV2): 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 (same on every chain)
 * - Paraswap (AugustusV6.2): 0x6a000f20005980200259b80c5102003040001068 (same on every chain)
 * - OpenOcean (ExchangeV2): 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64 (same on most chains; zkSync differs)
 * - Odos: V3 router 0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05 same on every chain; V2 router differs per chain.
 * - IceCreamSwap: chain-specific V2 router addresses.
 * - PropellerSwap/Tycho: Ethereum, Base, Unichain only.
 * - 0x/Matcha: AllowanceHolder is hardcodable per hardfork; Settler rotates per deployment (reverify quarterly).
 * - OKX: chain-specific DexRouter + TokenApprove pair (both must be whitelisted).
 * - Enso, Unizen, Gluex: API-dependent (addresses fetched dynamically).
 */

export interface SwapTarget {
  address: string;
  name: string;
  protocol: string;
}

/**
 * Static chain init parameters.
 *
 * IMPORTANT: this type intentionally does NOT carry any live contract addresses
 * (OkuRouter, Permit2Proxy) or deployment blocks. Those are mutable state that
 * belongs in the on-disk registry (`deployments/<networkName>.json`, accessed
 * via `util/deploymentsRegistry.ts`). Mixing them in here historically caused
 * drift between the two sources of truth. Read live addresses with
 * `getCurrentAddress(networkName, "OkuRouter" | "Permit2Proxy")`.
 */
export interface NetworkConfig {
  networkName: string;
  chainId: number;
  chainName: string; // Backend chain name (e.g., "optimism", "base", "worldchain")
  wethAddress: string;
  usdcAddress?: string; // Optional - some networks may not have USDC
  nativeSymbol: string; // "ETH" for most networks
  supportedRouters: string[]; // Backend router names
  knownSwapTargets: SwapTarget[]; // Known swap target contracts to whitelist on deployment
  ownerAddress: string; // Rainbow Router owner address
  rpcUrl?: string; // Optional RPC URL from env
  create2FactoryAddress?: string; // Safe Singleton Factory address for deterministic deployments (empty = not available)
}

// Network configurations indexed by network name
export const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  op: {
    networkName: "op",
    chainId: 10,
    chainName: "optimism",
    wethAddress: "0x4200000000000000000000000000000000000006",
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "enso",
      "icecreamswap",
      "odos",
      "oneinch",
      "paraswap",
      "kyberswap",
      "unizen",
      "okx", // Now supported with transfer proxy!
      "zeroex", // Now supported with transfer proxy!
      "openocean",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05",
        name: "OdosRouterV3",
        protocol: "odos",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0xDd5E9B947c99Aa60bab00ca4631Dce63b49983E7",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0x98c43b751ff87b4dd0bc3b7aabef66c230c08445",
        name: "OptimismSettler",
        protocol: "0x",
      },
      {
        address: "0xa575f37e869e6887564f87c07e2885e08d542c4a",
        name: "AggregatorGuard",
        protocol: "icecreamswap",
      },
      {
        address: "0xad1d43efcf92133a9a0f33e5936f5ca10f2b012e",
        name: "TransparentUpgradeableProxy",
        protocol: "unizen",
      },
      {
        address: "0xca423977156bb05b13a2ba3b76bc5419e2fe9680",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0xdef1abe32c034e558cdd535791643c58a13acc10",
        name: "ExchangeProxy",
        protocol: "0x",
      },
      {
        address: "0xef58b643240178c2bc37681f8d4e50d7ec37ee22",
        name: "TransparentUpgradeableProxy",
        protocol: "unizen",
      },
      {
        address: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.OP_URL,
  },
  base: {
    networkName: "base",
    chainId: 8453,
    chainName: "base",
    wethAddress: "0x4200000000000000000000000000000000000006",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "kyberswap",
      "icecreamswap",
      "openocean",
      // "propellerswap", // Not supported by backend on Base
      "enso",
      "odos",
      "oneinch",
      "okx",
      "paraswap",
      "fabric",
      "usor",
      "zeroex",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05",
        name: "OdosRouterV3",
        protocol: "odos",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x19ceead7105607cd444f5ad10dd51356436095a1",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6352a56caadc4f1e25cd6c75970fa768a3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0xc87de04e2ec1f4282dff2933a2d58199f688fc3d",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0xef58b643240178c2bc37681f8d4e50d7ec37ee22",
        name: "TransparentUpgradeableProxy",
        protocol: "unizen",
      },
      {
        address: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0xC8F6b8Ba0DC0f175B568B99440B0867F69A29265",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x7c137a37742437d2212b7bd873ed135b5c4c61da",
        name: "FabricRouter",
        protocol: "fabric",
      },
      {
        address: "0x7747F8D2a76BD6345Cc29622a946A929647F2359",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0xea3207778e39EB02D72C9D3c4Eac7E224ac5d369",
        name: "TychoRouter",
        protocol: "propellerswap",
      },
      {
        address: "0x2626664c2603336E57B271c5C0b26F421741e481",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
      // NOTE: removed `UniversalRouter 0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8` —
      // that address has no code on Base. Base's actual Uniswap UniversalRouter is
      // 0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad above (v1_2; current UR per
      // Uniswap docs is 0x6fF5693b99212Da76ad316178A184AB56D299b43, intentionally
      // not added here per user instruction — only SwapRouter02 is being added in
      // this pass).
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.BASE_URL,
  },
  worldchain: {
    networkName: "worldchain",
    chainId: 480,
    chainName: "worldchain",
    wethAddress: "0x4200000000000000000000000000000000000006",
    usdcAddress: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", // Native USDC on World Chain
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "icecreamswap",
      "enso",
      "usor",
      "zeroex",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x1072a0A713A23a2Da9BAB99E9CD68187970E89a4",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x091AD9e2e6e5eD44c1c66dB50e49A601F9f36cF6",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.WORLDCHAIN_URL,
  },
  bsc: {
    networkName: "bsc",
    chainId: 56,
    chainName: "bsc",
    wethAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC USDC
    nativeSymbol: "BNB",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "odos",
      "kyberswap",
      "paraswap",
      "zeroex",
      "okx",
      "icecreamswap",
      "openocean",
      "enso",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0xc2eff1F1cE35d395408A34Ad881dBCD978F40b89",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05",
        name: "OdosRouterV3",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0x62cceF0b4545166f721cAa9fEe13c1d3767E27dc",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x1a3304cBef66de00FbE1548CC4C6585aD22FbCFf",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x4Dae2f939ACf50408e13d58534Ff8c2776d45265",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.BSC_URL,
  },
  polygon: {
    networkName: "polygon",
    chainId: 137,
    chainName: "polygon",
    wethAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Native USDC
    nativeSymbol: "MATIC",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "odos",
      "kyberswap",
      "paraswap",
      "zeroex",
      "okx",
      "openocean",
      "enso",
      "icecreamswap",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x7150ea07D00d8E5a46bcC809f1c9FDf5cb5f8E81",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0xF6E1B4b201e220FC3741bd7a75675ffEA25c02AD",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x99bA7d569EA69671B399A7cC488b687515F7EC23",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0xec7BE89e9d109e7e3Fec59c222CF297125FEFda2",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.POLYGON_URL,
  },
  arbitrum: {
    networkName: "arbitrum",
    chainId: 42161,
    chainName: "arbitrum",
    wethAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "odos",
      "kyberswap",
      "paraswap",
      "zeroex",
      "okx",
      "icecreamswap",
      "openocean",
      "enso",
      "fabric",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0xfeEA2A79D7d3d36753C8917AF744D71f13C9b02a",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0x7CF6b330b437E9fb432B1400DE17B03357Cf049A",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x57f96440f1b1cAD53B40A8924BD540b1279A491c",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x3a7f029e3ad003ab5aa78ccf101b1b543eaed6f9",
        name: "FabricRouter",
        protocol: "fabric",
      },
      {
        address: "0x5E325eDA8064b456f4781070C0738d849c824258",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.ARB_URL,
  },
  // ==================== NEW CHAINS ====================
  taiko: {
    networkName: "taiko",
    chainId: 167000,
    chainName: "taiko",
    wethAddress: "0xA51894664A773981C6C112C43ce576f315d5b1B6", // WETH on Taiko
    usdcAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b", // USDC on Taiko
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      // Limited router support on Taiko - needs verification
      "kyberswap",
    ],
    knownSwapTargets: [
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.TAIKO_URL,
  },
  celo: {
    networkName: "celo",
    chainId: 42220,
    chainName: "celo",
    wethAddress: "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO (native wrapped)
    usdcAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // Native USDC on Celo
    nativeSymbol: "CELO",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["icecreamswap", "openocean"],
    knownSwapTargets: [
      {
        address: "0xA1d3462AFbFFe3BA45A5044FB899e6E219Ec842A",
        name: "IceCreamSwapV2Router",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.CELO_URL,
  },
  avax: {
    networkName: "avax",
    chainId: 43114,
    chainName: "avalanche",
    wethAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Native USDC on Avalanche
    nativeSymbol: "AVAX",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "odos",
      "kyberswap",
      "zeroex",
      "okx",
      "icecreamswap",
      "openocean",
      "enso",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x6De411A14aEaafB3f23697A4472a4D4ed275Ac0f",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x88de50B233052e4Fb783d4F6db78Cc34fEa3e9FC",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0xa94Fcf9fc56a864f8DE51e6315aee5863AD63C91",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0xa575f37e869e6887564F87c07e2885e08D542C4a",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x4Dae2f939ACf50408e13d58534Ff8c2776d45265",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.AVAX_URL,
  },
  linea: {
    networkName: "linea",
    chainId: 59144,
    chainName: "linea",
    wethAddress: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", // WETH on Linea
    usdcAddress: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", // USDC on Linea
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "odos",
      "kyberswap",
      "zeroex",
      "icecreamswap",
      "openocean",
      "enso",
      "okx",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001ff3684f28c67538d4d072c22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x1816eA2150e74Eb3068A4e3809E461Cc6977A7D7",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x2d8879046f1559E53eb052E949e9544bCB72f414",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x2fF506ed9729580EF8Bf04429614beB1baE5F76D",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xA146d46823f3F594B785200102Be5385CAfCE9B5",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x2E1Dee213BA8d7af0934C49a23187BabEACa8764",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0xd7c7d7f18dd5388d5217c9696c7e799fcd75c6bd",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.LINEA_URL,
  },
  blast: {
    networkName: "blast",
    chainId: 81457,
    chainName: "blast",
    wethAddress: "0x4300000000000000000000000000000000000004", // WETH on Blast
    usdcAddress: "0x4300000000000000000000000000000000000003", // USDB (Blast native stablecoin)
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["zeroex", "icecreamswap", "openocean"],
    knownSwapTargets: [
      {
        address: "0x0000000000001fF3684f28c67538d4D072C22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4",
        name: "IceCreamSwapV2Router",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8",
        name: "UniversalRouter",
        protocol: "uniswap",
      },
      {
        address: "0x549FEB8c9bd4c12Ad2AB27022dA12492aC452B66",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.BLAST_URL,
  },
  scroll: {
    networkName: "scroll",
    chainId: 534352,
    chainName: "scroll",
    wethAddress: "0x5300000000000000000000000000000000000004", // WETH on Scroll
    usdcAddress: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", // USDC on Scroll
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "odos",
      "kyberswap",
      "zeroex",
      "icecreamswap",
      "openocean",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000005E88410CcDFaDe4a5EfaE4b49562",
        name: "AllowanceHolder",
        protocol: "0x",
      }, // Shanghai hardfork address
      {
        address: "0xbFe03C9E20a9Fc0b37de01A172F207004935E0b1",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4",
        name: "IceCreamSwapV2Router",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xfc30937f5cde93df8d48acaf7e6f5d8d8a31f636",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.SCROLL_URL,
  },
  // ==================== ADDITIONAL CHAINS ====================
  zksync: {
    networkName: "zksync",
    chainId: 324,
    chainName: "zksync",
    wethAddress: "0x8Ebe4A94740515945ad826238Fc4D56c6B8b0e60", // WETH on zkSync Era
    usdcAddress: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", // USDC on zkSync Era
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["odos", "kyberswap", "oneinch", "openocean"],
    knownSwapTargets: [
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x4bBa932E9792A2b917D47830C93a9BC79320E4f7",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x36A1aCbbCAfca2468b85011DDD16E7Cb4d673230",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      }, // zkSync-specific address
      {
        address: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.ZKSYNC_URL,
  },
  monad: {
    networkName: "monad",
    chainId: 143, // Monad mainnet chainId
    chainName: "monad",
    wethAddress: "", // WMON - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "MON",
    create2FactoryAddress: "", // Safe Singleton Factory not yet deployed on Monad
    supportedRouters: [
      "enso",
      "icecreamswap",
      "kyberswap",
      "okx",
      "openocean",
      "usor",
      "zeroex",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001ff3684f28c67538d4d072c22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0xfb78Fcae443eB423b59B8C186518c5dF94416344",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0xCfBAa9Cfce952Ca4F4069874fF1Df8c05e37a3c7",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x7A7AD9aa93cd0A2D0255326E5Fb145CEc14997FF",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0x75FC67473A91335B5b8F8821277262a13B38c9b3",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.MONAD_URL,
  },
  sei: {
    networkName: "sei",
    chainId: 1329,
    chainName: "sei",
    wethAddress: "", // WSEI - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "SEI",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "enso",
      "icecreamswap",
      "openocean",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x300b3D30aaBf46b05983284f0297D966E92bbeB2",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xa683c66045ad16abb1bCE5ad46A64d95f9A25785",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.SEI_URL,
  },
  rootstock: {
    networkName: "rootstock",
    chainId: 30,
    chainName: "rootstock",
    wethAddress: "0x967f8799aF07DF1534d48A95a5C9FEBE92c53ae0", // WRBTC
    usdcAddress: "", // Bridged USDC - To be confirmed
    nativeSymbol: "RBTC",
    create2FactoryAddress: "", // Safe Singleton Factory not available on Rootstock
    supportedRouters: ["openocean", "icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0x63d3C7Ab37ca36A2A0A338076C163fF60c72527c",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x244f68e77357f86a8522323eBF80b5FC2F814d3E",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x0B14ff67f0014046b4b99057Aec4509640b3947A",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.ROOTSTOCK_URL,
  },
  filecoin: {
    networkName: "filecoin",
    chainId: 314,
    chainName: "filecoin",
    wethAddress: "0x60E1773636CF5E4A227d9AC24F20fEca034ee25A", // WFIL
    usdcAddress: "", // To be confirmed
    nativeSymbol: "FIL",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["usor"],
    knownSwapTargets: [
      {
        address: "0x83702C6356A1028A900F83d446D189a31646a16b",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xcAb04058e60020d65D18D4B3DFF2cA1445D7099f",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.FILECOIN_URL,
  },
  boba: {
    networkName: "boba",
    chainId: 288,
    chainName: "boba",
    wethAddress: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000", // WETH on Boba
    usdcAddress: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc", // USDC on Boba
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x4ba622997559f9b5ac68751d7fc3deecc23a0e88",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x759E8B0cb9d65291e258aE3e043258ae1dD0df16",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.BOBA_URL,
  },
  telos: {
    networkName: "telos",
    chainId: 40,
    chainName: "telos",
    wethAddress: "0xD102cE6A4dB07D247fcc28F366A623Df0938CA9E", // WTLOS
    usdcAddress: "", // To be confirmed
    nativeSymbol: "TLOS",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["icecreamswap", "openocean"],
    knownSwapTargets: [
      {
        address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4",
        name: "IceCreamSwapV2Router",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.TELOS_URL,
  },
  lightlink: {
    networkName: "lightlink",
    chainId: 1890,
    chainName: "lightlink",
    wethAddress: "", // To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "ETH",
    create2FactoryAddress: "", // Safe Singleton Factory not available on LightLink
    supportedRouters: ["icecreamswap"],
    knownSwapTargets: [
      {
        address: "0xE578184bC88EB48485Bba23a37B5509578d2aE38",
        name: "IceCreamSwapV2Router",
        protocol: "icecreamswap",
      },
      {
        address: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.LIGHTLINK_URL,
  },
  hemi: {
    networkName: "hemi",
    chainId: 43111,
    chainName: "hemi",
    wethAddress: "", // To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x864DDc9B50B9A0dF676d826c9B9EDe9F8913a160",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.HEMI_URL,
  },
  xdc: {
    networkName: "xdc",
    chainId: 50,
    chainName: "xdc",
    wethAddress: "0x951857744785E80e2De051c32EE7b25f9c458C42", // WXDC
    usdcAddress: "0x2a8e898b6242355c290e1f4fc966b8788729a4d4", // USDC.e (Bridged)
    nativeSymbol: "XDC",
    create2FactoryAddress: "", // Safe Singleton Factory not available on XDC
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0x0EE6f0900990b23A2a96a6F41EB56693c9076031",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.XDC_URL,
  },
  unichain: {
    networkName: "unichain",
    chainId: 130,
    chainName: "unichain",
    wethAddress: "0x4200000000000000000000000000000000000006", // WETH on Unichain (OP Stack standard)
    usdcAddress: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", // Native USDC on Unichain
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "odos",
      "kyberswap",
      "openocean",
      "propellerswap",
      "enso",
      "icecreamswap",
      "okx",
      "paraswap",
      "usor",
      "zeroex",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001ff3684f28c67538d4d072c22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x972655fACb8Df3CdF40395E4262f874f81674D46",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x6409722F3a1C4486A3b1FE566cBDd5e9D946A1f3",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xFfA5ec2e444e4285108e4a17b82dA495c178427B",
        name: "TychoRouter",
        protocol: "propellerswap",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0x3FFc2315A992b01dc4B3f79C8EEa1921091Ee24f",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6733Eb2E75B1625F1Fe5f18aD2cB2BaBDA510d19",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x73855d06de49d0fe4a9c42636ba96c62da12ff9c",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.UNICHAIN_URL,
  },
  sonic: {
    networkName: "sonic",
    chainId: 146,
    chainName: "sonic",
    wethAddress: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", // Wrapped S (wS)
    usdcAddress: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", // USDC on Sonic
    nativeSymbol: "S",
    create2FactoryAddress: "", // Safe Singleton Factory not confirmed on Sonic - needs verification
    supportedRouters: ["kyberswap", "odos", "openocean"],
    knownSwapTargets: [
      {
        address: "0xaC041Df48dF9791B0654f1Dbbf2CC8450C5f2e9D",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.SONIC_URL,
  },
  redbelly: {
    networkName: "redbelly",
    chainId: 151,
    chainName: "redbelly",
    wethAddress: "", // WRBNT - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "RBNT",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["usor"],
    knownSwapTargets: [
      {
        address: "0x1b35fbA9357fD9bda7ed0429C8BbAbe1e8CC88fc",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.REDBELLY_URL,
  },
  lens: {
    networkName: "lens",
    chainId: 232,
    chainName: "lens",
    wethAddress: "", // WETH - To be confirmed (zkSync-based)
    usdcAddress: "", // To be confirmed
    nativeSymbol: "GHO",
    create2FactoryAddress: "", // Safe Singleton Factory not available on Lens
    supportedRouters: [
      // Router support to be verified
    ],
    knownSwapTargets: [
      {
        address: "0x6ddD32cd941041D8b61df213B9f515A7D288Dc13",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.LENS_URL,
  },
  goat: {
    networkName: "goat",
    chainId: 2345,
    chainName: "goat",
    wethAddress: "", // WBTC - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "BTC",
    create2FactoryAddress: "", // Safe Singleton Factory not available on GOAT
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.GOAT_URL,
  },
  mantle: {
    networkName: "mantle",
    chainId: 5000,
    chainName: "mantle",
    wethAddress: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", // WMNT
    usdcAddress: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", // USDC on Mantle
    nativeSymbol: "MNT",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "odos",
      "zeroex",
      "icecreamswap",
      "openocean",
      "okx",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000005e88410ccdfade4a5efae4b49562",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0xe3fBE7889A51d62AcD4E056d756F6eA04a3d8D2d",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745",
        name: "OdosRouterV2",
        protocol: "odos",
      },
      {
        address: "0x3FFc2315A992b01dc4B3f79C8EEa1921091Ee24f",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xcF76984119C7f6ae56fAfE680d39C08278b7eCF4",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x447B8E40B0CdA8e55F405C86bC635D02d0540aB8",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.MANTLE_URL,
  },
  nibiru: {
    networkName: "nibiru",
    chainId: 6900,
    chainName: "nibiru",
    wethAddress: "", // WNIBI - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "NIBI",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["usor"],
    knownSwapTargets: [
      {
        address: "0xA7E6cB0A6B1BE8b779022A6aFcb097cF0d3Ff4A2",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.NIBIRU_URL,
  },
  plasma: {
    networkName: "plasma",
    chainId: 9745,
    chainName: "plasma",
    wethAddress: "", // WXPL - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "XPL",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "kyberswap",
      "openocean",
      "enso",
      "icecreamswap",
      "okx",
      "usor",
      "zeroex",
    ],
    knownSwapTargets: [
      {
        address: "0x0000000000001ff3684f28c67538d4d072c22734",
        name: "AllowanceHolder",
        protocol: "0x",
      },
      {
        address: "0x7F2194E8d4D5B5F889b17aeCe891F89Da74F5384",
        name: "Settler",
        protocol: "0x",
      },
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xCfBAa9Cfce952Ca4F4069874fF1Df8c05e37a3c7",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x19D345f95A80cc136d898f41b490E023cFF78658",
        name: "OkxRouter",
        protocol: "okx",
      },
      {
        address: "0x1b35fbA9357fD9bda7ed0429C8BbAbe1e8CC88fc",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.PLASMA_URL,
  },
  etherlink: {
    networkName: "etherlink",
    chainId: 42793,
    chainName: "etherlink",
    wethAddress: "", // WXTZ - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "XTZ",
    create2FactoryAddress: "", // Safe Singleton Factory not available on Etherlink
    supportedRouters: ["kyberswap", "threeroute", "usor"],
    knownSwapTargets: [
      {
        address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        name: "MetaAggregationRouterV2",
        protocol: "kyberswap",
      },
      {
        address: "0x1B62C2CEf163E3120E512F71F6e6E99058c80F6E",
        name: "ThreeRouteRouter",
        protocol: "threeroute",
      },
      {
        address: "0x9db70E29712Cc8Af10c2B597BaDA6784544FF407",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.ETHERLINK_URL,
  },
  bob: {
    networkName: "bob",
    chainId: 60808,
    chainName: "bob",
    wethAddress: "0x4200000000000000000000000000000000000006", // WETH on BOB (OP Stack standard)
    usdcAddress: "", // USDC - To be confirmed (CCIP upgraded)
    nativeSymbol: "ETH",
    create2FactoryAddress: "", // Safe Singleton Factory not available on BOB
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x346239972d1fa486FC4a521031BC81bFB7D6e8a4",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.BOB_URL,
  },
  corn: {
    networkName: "corn",
    chainId: 21000000, // Corn Maizenet chainId
    chainName: "corn",
    wethAddress: "", // WBTCN - To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "BTCN",
    create2FactoryAddress: "", // Safe Singleton Factory not available on Corn
    supportedRouters: [
      // Router support to be verified
    ],
    knownSwapTargets: [
      {
        address: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.CORN_URL,
  },
  gnosis: {
    networkName: "gnosis",
    chainId: 100,
    chainName: "gnosis",
    wethAddress: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
    usdcAddress: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", // USDC on Gnosis
    nativeSymbol: "XDAI",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: [
      "oneinch",
      "paraswap",
      "openocean",
      "enso",
      "icecreamswap",
      "usor",
    ],
    knownSwapTargets: [
      {
        address: "0x111111125421ca6dc452d289314280a0f8842a65",
        name: "AggregationRouterV6",
        protocol: "oneinch",
      },
      {
        address: "0x6a000f20005980200259b80c5102003040001068",
        name: "AugustusV6.2",
        protocol: "paraswap",
      },
      {
        address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
        name: "OpenOceanExchangeV2",
        protocol: "openocean",
      },
      {
        address: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        name: "EnsoRouter",
        protocol: "enso",
      },
      {
        address: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x75FC67473A91335B5b8F8821277262a13B38c9b3",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.GNOSIS_URL,
  },
  gensyn: {
    networkName: "gensyn",
    chainId: 685689,
    chainName: "gensyn",
    wethAddress: "", // To be confirmed
    usdcAddress: "", // To be confirmed
    nativeSymbol: "ETH",
    create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
    supportedRouters: ["icecreamswap", "usor"],
    knownSwapTargets: [
      {
        address: "0x9E6d21E759A7A288b80eef94E4737D313D31c13f",
        name: "IceCreamSwapRouter",
        protocol: "icecreamswap",
      },
      {
        address: "0x447B8E40B0CdA8e55F405C86bC635D02d0540aB8",
        name: "UsorRouter",
        protocol: "usor",
      },
      {
        address: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
        name: "SwapRouter02",
        protocol: "uniswap",
      },
    ],
    ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
    rpcUrl: process.env.GENSYN_URL,
  },
};

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
