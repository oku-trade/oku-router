/**
 * networkConfig.ts
 *
 * Centralized network configuration for Oku Router deployments.
 * This file contains all network-specific addresses, supported routers,
 * and token configurations for supported chains:
 *
 * Deployed: Optimism, Base, Worldchain
 *
 * Pending deployment:
 * - L2s: BSC, Polygon, Arbitrum, Avalanche, Linea, Blast, Scroll, zkSync, Mantle, Gnosis
 * - Newer L2s: Unichain, Sonic, Plasma, Etherlink, BOB
 * - Alt L1s: Taiko, Celo, Monad, Sei, Rootstock, Filecoin, Boba, Telos, Nibiru
 * - Emerging: LightLink, Hemi, XDC, Redbelly, Lens, GOAT, Corn
 *
 * Supported Routers:
 * - 1inch (AggregationRouterV6): 0x111111125421ca6dc452d289314280a0f8842a65
 * - KyberSwap (MetaAggregationRouterV2): 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5
 * - Paraswap (AugustusV6.2): 0x6a000f20005980200259b80c5102003040001068
 * - OpenOcean (ExchangeV2): 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64 (zkSync: 0x36A1aCbbCAfca2468b85011DDD16E7Cb4d673230)
 * - Odos (RouterV2): Chain-specific addresses
 * - IceCreamSwap: Chain-specific V2 router addresses
 * - PropellerSwap/Tycho: Ethereum, Base, Unichain only
 * - 0x/Matcha: AllowanceHolder varies by hardfork (Cancun/Shanghai/London)
 * - OKX: Chain-specific DexRouter + TokenApprove addresses
 * - Enso, Unizen, Gluex: API-dependent (addresses fetched dynamically)
 */

export interface SwapTarget {
    address: string;
    name: string;
    protocol: string;
}

export interface NetworkConfig {
    networkName: string;
    chainId: number;
    chainName: string; // Backend chain name (e.g., "optimism", "base", "worldchain")
    rainbowRouterAddress: string;
    deploymentBlock: number; // Block number when the contract was deployed
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
        rainbowRouterAddress: "0x822CFA9749d16Fb4B4F2B0515924cec69512893b",  // PROD deterministic deployment post audit
        deploymentBlock: 143955053, // Nov 18, 2025 - tx: 0x6c495af96a3af0848131a132951d635419a9558b30a391bdb7094575fd5413c5
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
            "okx",     // Now supported with transfer proxy!
            "zeroex",  // Now supported with transfer proxy!
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05", name: "OdosRouterV3", protocol: "odos" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x68d6b739d2020067d1e2f713b999da97e4d54812", name: "TokenApprove", protocol: "okx" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0x98c43b751ff87b4dd0bc3b7aabef66c230c08445", name: "OptimismSettler", protocol: "0x" },
            { address: "0xa575f37e869e6887564f87c07e2885e08d542c4a", name: "AggregatorGuard", protocol: "icecreamswap" },
            { address: "0xad1d43efcf92133a9a0f33e5936f5ca10f2b012e", name: "TransparentUpgradeableProxy", protocol: "unizen" },
            { address: "0xc44c6550a3b13116f6fd593e1ec963d5ae78c4c8", name: "DexRouter", protocol: "okx" },
            { address: "0xca423977156bb05b13a2ba3b76bc5419e2fe9680", name: "OdosRouterV2", protocol: "odos" },
            { address: "0xdef1abe32c034e558cdd535791643c58a13acc10", name: "ExchangeProxy", protocol: "0x" },
            { address: "0xef58b643240178c2bc37681f8d4e50d7ec37ee22", name: "TransparentUpgradeableProxy", protocol: "unizen" },
            { address: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", name: "EnsoRouter", protocol: "enso" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.OP_URL,
    },
    base: {
        networkName: "base",
        chainId: 8453,
        chainName: "base",
        rainbowRouterAddress: "0x822CFA9749d16Fb4B4F2B0515924cec69512893b",  // PROD deterministic deployment post audit
        deploymentBlock: 38624971,
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
            // "velora",  // Commented - may need verification
            // "unison",  // Commented - may need verification
            // "luxor",   // Commented - may need verification
            "zeroex",  // Commented - may need verification
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05", name: "OdosRouterV3", protocol: "odos" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x19ceead7105607cd444f5ad10dd51356436095a1", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", name: "UniversalRouter", protocol: "uniswap" },
            { address: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6352a56caadc4f1e25cd6c75970fa768a3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0xc87de04e2ec1f4282dff2933a2d58199f688fc3d", name: "Settler", protocol: "0x" },
            { address: "0xef58b643240178c2bc37681f8d4e50d7ec37ee22", name: "TransparentUpgradeableProxy", protocol: "unizen" },
            { address: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", name: "EnsoRouter", protocol: "enso" },
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0xea3207778e39EB02D72C9D3c4Eac7E224ac5d369", name: "TychoRouter", protocol: "propellerswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.BASE_URL,
    },
    worldchain: {
        networkName: "worldchain",
        chainId: 480,
        chainName: "worldchain",
        rainbowRouterAddress: "0x822CFA9749d16Fb4B4F2B0515924cec69512893b",  // PROD deterministic deployment post audit
        deploymentBlock: 22351271,
        wethAddress: "0x4200000000000000000000000000000000000006",
        usdcAddress: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", // Native USDC on World Chain
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "icecreamswap",
            "enso",
            // "kyberswap",  // Not supported on worldchain per API
            // "lusor"  // Commented - may need verification
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x8ac7bee993bb44dab564ea4bc9ea67bf9eb5e743", name: "AggregatorGuard", protocol: "icecreamswap" },
            { address: "0xc87de04e2ec1f4282dff2933a2d58199f688fc3d", name: "Settler", protocol: "0x" },
            { address: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", name: "EnsoRouter", protocol: "enso" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "1inch Router (TEST)", protocol: "oneinch" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.WORLDCHAIN_URL,
    },
    bsc: {
        networkName: "bsc",
        chainId: 56,
        chainName: "bsc",
        rainbowRouterAddress: "0x822CFA9749d16Fb4B4F2B0515924cec69512893b",  // PROD deterministic deployment post audit
        deploymentBlock: 70161721,
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
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05", name: "OdosRouterV3", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0xd547Eafde2410e63300Fc5308CceA0b356E7b5d8", name: "OKXDexRouter", protocol: "okx" },
            { address: "0xB403c6c93446eD1453CAa51d69A492053e008240", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x1a3304cBef66de00FbE1548CC4C6585aD22FbCFf", name: "IceCreamSwapAggregator", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.BSC_URL,
    },
    polygon: {
        networkName: "polygon",
        chainId: 137,
        chainName: "polygon",
        rainbowRouterAddress: "0xA89A26c4d81A2cca4d0670F77f0FC88362b72248",
        deploymentBlock: 79796004,
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
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.POLYGON_URL,
    },
    arbitrum: {
        networkName: "arbitrum",
        chainId: 42161,
        chainName: "arbitrum",
        rainbowRouterAddress: "0x822CFA9749d16Fb4B4F2B0515924cec69512893b",  // PROD deterministic deployment post audit
        deploymentBlock: 406509419,
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
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0xf332761c673b59B21fF6dfa8adA44d78c12dEF09", name: "DexRouter", protocol: "okx" },
            { address: "0x70cBb871E8f30Fc8Ce23609E9E0Ea87B6b222F58", name: "TokenApprove", protocol: "okx" },
            { address: "0xA1d3462AFbFFe3BA45A5044FB899e6E219Ec842A", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.ARB_URL,
    },
    // ==================== NEW CHAINS ====================
    taiko: {
        networkName: "taiko",
        chainId: 167000,
        chainName: "taiko",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0xA51894664A773981C6C112C43ce576f315d5b1B6", // WETH on Taiko
        usdcAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b", // USDC on Taiko
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            // Limited router support on Taiko - needs verification
            "kyberswap",
        ],
        knownSwapTargets: [
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.TAIKO_URL,
    },
    celo: {
        networkName: "celo",
        chainId: 42220,
        chainName: "celo",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO (native wrapped)
        usdcAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // Native USDC on Celo
        nativeSymbol: "CELO",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "icecreamswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0xA1d3462AFbFFe3BA45A5044FB899e6E219Ec842A", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.CELO_URL,
    },
    avax: {
        networkName: "avax",
        chainId: 43114,
        chainName: "avalanche",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
        usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Native USDC on Avalanche
        nativeSymbol: "AVAX",
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
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x88de50B233052e4Fb783d4F6db78Cc34fEa3e9FC", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0x1daC23e41Fc8ce857E86fD8C1AE5b6121C67D96d", name: "DexRouter", protocol: "okx" },
            { address: "0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f", name: "TokenApprove", protocol: "okx" },
            { address: "0x3FFc2315A992b01dc4B3f79C8EEa1921091Ee24f", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.AVAX_URL,
    },
    linea: {
        networkName: "linea",
        chainId: 59144,
        chainName: "linea",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
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
        ],
        knownSwapTargets: [
            { address: "0x000000000000175a8b9bC6d539B3708EEd92EA6c", name: "AllowanceHolder", protocol: "0x" }, // London hardfork address
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x2d8879046f1559E53eb052E949e9544bCB72f414", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0xa575f37e869e6887564f87c07e2885e08d542c4a", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.LINEA_URL,
    },
    blast: {
        networkName: "blast",
        chainId: 81457,
        chainName: "blast",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x4300000000000000000000000000000000000004", // WETH on Blast
        usdcAddress: "0x4300000000000000000000000000000000000003", // USDB (Blast native stablecoin)
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "zeroex",
            "icecreamswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x0000000000001fF3684f28c67538d4D072C22734", name: "AllowanceHolder", protocol: "0x" },
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.BLAST_URL,
    },
    scroll: {
        networkName: "scroll",
        chainId: 534352,
        chainName: "scroll",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
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
            { address: "0x0000000000005E88410CcDFaDe4a5EfaE4b49562", name: "AllowanceHolder", protocol: "0x" }, // Shanghai hardfork address
            { address: "0xbFe03C9E20a9Fc0b37de01A172F207004935E0b1", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.SCROLL_URL,
    },
    // ==================== ADDITIONAL CHAINS ====================
    zksync: {
        networkName: "zksync",
        chainId: 324,
        chainName: "zksync",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x8Ebe4A94740515945ad826238Fc4D56c6B8b0e60", // WETH on zkSync Era
        usdcAddress: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", // USDC on zkSync Era
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "odos",
            "kyberswap",
            "oneinch",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x4bBa932E9792A2b917D47830C93a9BC79320E4f7", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x36A1aCbbCAfca2468b85011DDD16E7Cb4d673230", name: "OpenOceanExchangeV2", protocol: "openocean" }, // zkSync-specific address
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.ZKSYNC_URL,
    },
    monad: {
        networkName: "monad",
        chainId: 143, // Monad mainnet chainId
        chainName: "monad",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WMON - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "MON",
        create2FactoryAddress: "", // Safe Singleton Factory not yet deployed on Monad
        supportedRouters: [
            // New chain - router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.MONAD_URL,
    },
    sei: {
        networkName: "sei",
        chainId: 1329,
        chainName: "sei",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WSEI - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "SEI",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            // SEI EVM router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.SEI_URL,
    },
    rootstock: {
        networkName: "rootstock",
        chainId: 30,
        chainName: "rootstock",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x967f8799aF07DF1534d48A95a5C9FEBE92c53ae0", // WRBTC
        usdcAddress: "", // Bridged USDC - To be confirmed
        nativeSymbol: "RBTC",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Rootstock
        supportedRouters: [
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.ROOTSTOCK_URL,
    },
    filecoin: {
        networkName: "filecoin",
        chainId: 314,
        chainName: "filecoin",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x60E1773636CF5E4A227d9AC24F20fEca034ee25A", // WFIL
        usdcAddress: "", // To be confirmed
        nativeSymbol: "FIL",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Filecoin
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.FILECOIN_URL,
    },
    boba: {
        networkName: "boba",
        chainId: 288,
        chainName: "boba",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000", // WETH on Boba
        usdcAddress: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc", // USDC on Boba
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "icecreamswap",
        ],
        knownSwapTargets: [
            { address: "0x698a912F8CA34Df9b46E6Ea4A2B2DB0B7151b083", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.BOBA_URL,
    },
    telos: {
        networkName: "telos",
        chainId: 40,
        chainName: "telos",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0xD102cE6A4dB07D247fcc28F366A623Df0938CA9E", // WTLOS
        usdcAddress: "", // To be confirmed
        nativeSymbol: "TLOS",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Telos
        supportedRouters: [
            "icecreamswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.TELOS_URL,
    },
    lightlink: {
        networkName: "lightlink",
        chainId: 1890,
        chainName: "lightlink",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "ETH",
        create2FactoryAddress: "", // Safe Singleton Factory not available on LightLink
        supportedRouters: [
            "icecreamswap",
        ],
        knownSwapTargets: [
            { address: "0xE578184bC88EB48485Bba23a37B5509578d2aE38", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.LIGHTLINK_URL,
    },
    hemi: {
        networkName: "hemi",
        chainId: 43111,
        chainName: "hemi",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "ETH",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Hemi
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.HEMI_URL,
    },
    xdc: {
        networkName: "xdc",
        chainId: 50,
        chainName: "xdc",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x951857744785E80e2De051c32EE7b25f9c458C42", // WXDC
        usdcAddress: "0x2a8e898b6242355c290e1f4fc966b8788729a4d4", // USDC.e (Bridged)
        nativeSymbol: "XDC",
        create2FactoryAddress: "", // Safe Singleton Factory not available on XDC
        supportedRouters: [
            "icecreamswap",
        ],
        knownSwapTargets: [
            { address: "0xBb5e1777A331ED93E07cF043363e48d320eb96c4", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.XDC_URL,
    },
    unichain: {
        networkName: "unichain",
        chainId: 130,
        chainName: "unichain",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x4200000000000000000000000000000000000006", // WETH on Unichain (OP Stack standard)
        usdcAddress: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", // Native USDC on Unichain
        nativeSymbol: "ETH",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "odos",
            "kyberswap",
            "openocean",
            "propellerswap",
        ],
        knownSwapTargets: [
            { address: "0x6409722F3a1C4486A3b1FE566cBDd5e9D946A1f3", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
            { address: "0xFfA5ec2e444e4285108e4a17b82dA495c178427B", name: "TychoRouter", protocol: "propellerswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.UNICHAIN_URL,
    },
    sonic: {
        networkName: "sonic",
        chainId: 146,
        chainName: "sonic",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", // Wrapped S (wS)
        usdcAddress: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", // USDC on Sonic
        nativeSymbol: "S",
        create2FactoryAddress: "", // Safe Singleton Factory not confirmed on Sonic - needs verification
        supportedRouters: [
            "kyberswap",
            "odos",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0xaC041Df48dF9791B0654f1Dbbf2CC8450C5f2e9D", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.SONIC_URL,
    },
    redbelly: {
        networkName: "redbelly",
        chainId: 151,
        chainName: "redbelly",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WRBNT - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "RBNT",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Redbelly
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.REDBELLY_URL,
    },
    lens: {
        networkName: "lens",
        chainId: 232,
        chainName: "lens",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WETH - To be confirmed (zkSync-based)
        usdcAddress: "", // To be confirmed
        nativeSymbol: "GHO",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Lens
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.LENS_URL,
    },
    goat: {
        networkName: "goat",
        chainId: 2345,
        chainName: "goat",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WBTC - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "BTC",
        create2FactoryAddress: "", // Safe Singleton Factory not available on GOAT
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.GOAT_URL,
    },
    mantle: {
        networkName: "mantle",
        chainId: 5000,
        chainName: "mantle",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", // WMNT
        usdcAddress: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", // USDC on Mantle
        nativeSymbol: "MNT",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "odos",
            "kyberswap",
            "zeroex",
            "icecreamswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x0000000000005E88410CcDFaDe4a5EfaE4b49562", name: "AllowanceHolder", protocol: "0x" }, // Shanghai hardfork
            { address: "0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745", name: "OdosRouterV2", protocol: "odos" },
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0xb4FE60CD05A3e68668007Cee83DDFD9A50A45B36", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.MANTLE_URL,
    },
    nibiru: {
        networkName: "nibiru",
        chainId: 6900,
        chainName: "nibiru",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WNIBI - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "NIBI",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Nibiru
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.NIBIRU_URL,
    },
    plasma: {
        networkName: "plasma",
        chainId: 9745,
        chainName: "plasma",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WXPL - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "XPL",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "kyberswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.PLASMA_URL,
    },
    etherlink: {
        networkName: "etherlink",
        chainId: 42793,
        chainName: "etherlink",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WXTZ - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "XTZ",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Etherlink
        supportedRouters: [
            "kyberswap",
        ],
        knownSwapTargets: [
            { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2", protocol: "kyberswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.ETHERLINK_URL,
    },
    bob: {
        networkName: "bob",
        chainId: 60808,
        chainName: "bob",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0x4200000000000000000000000000000000000006", // WETH on BOB (OP Stack standard)
        usdcAddress: "", // USDC - To be confirmed (CCIP upgraded)
        nativeSymbol: "ETH",
        create2FactoryAddress: "", // Safe Singleton Factory not available on BOB
        supportedRouters: [
            "icecreamswap",
        ],
        knownSwapTargets: [
            { address: "0x698a912F8CA34Df9b46E6Ea4A2B2DB0B7151b083", name: "IceCreamSwapV2Router", protocol: "icecreamswap" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.BOB_URL,
    },
    corn: {
        networkName: "corn",
        chainId: 21000000, // Corn Maizenet chainId
        chainName: "corn",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "", // WBTCN - To be confirmed
        usdcAddress: "", // To be confirmed
        nativeSymbol: "BTCN",
        create2FactoryAddress: "", // Safe Singleton Factory not available on Corn
        supportedRouters: [
            // Router support to be verified
        ],
        knownSwapTargets: [],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.CORN_URL,
    },
    gnosis: {
        networkName: "gnosis",
        chainId: 100,
        chainName: "gnosis",
        rainbowRouterAddress: "", // To be deployed
        deploymentBlock: 0,
        wethAddress: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
        usdcAddress: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", // USDC on Gnosis
        nativeSymbol: "XDAI",
        create2FactoryAddress: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
        supportedRouters: [
            "oneinch",
            "paraswap",
            "openocean",
        ],
        knownSwapTargets: [
            { address: "0x111111125421ca6dc452d289314280a0f8842a65", name: "AggregationRouterV6", protocol: "oneinch" },
            { address: "0x6a000f20005980200259b80c5102003040001068", name: "AugustusV6.2", protocol: "paraswap" },
            { address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", name: "OpenOceanExchangeV2", protocol: "openocean" },
        ],
        ownerAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        rpcUrl: process.env.GNOSIS_URL,
    },
};

// Get network config by network name (e.g., "op", "base", "worldchain")
export function getNetworkConfig(networkName: string): NetworkConfig {
    const config = NETWORK_CONFIGS[networkName];

    if (!config) {
        throw new Error(
            `No configuration found for network: ${networkName}. ` +
            `Available networks: ${Object.keys(NETWORK_CONFIGS).join(", ")}`
        );
    }

    return config;
}

// Get network config by chain ID
export function getNetworkConfigByChainId(chainId: number): NetworkConfig {
    const config = Object.values(NETWORK_CONFIGS).find(c => c.chainId === chainId);

    if (!config) {
        throw new Error(
            `No configuration found for chain ID: ${chainId}. ` +
            `Available chain IDs: ${Object.values(NETWORK_CONFIGS).map(c => c.chainId).join(", ")}`
        );
    }

    return config;
}

// Check if a network supports a specific router
export function isRouterSupported(networkName: string, routerName: string): boolean {
    const config = NETWORK_CONFIGS[networkName];
    return config ? config.supportedRouters.includes(routerName) : false;
}

// Get all supported network names
export function getSupportedNetworks(): string[] {
    return Object.keys(NETWORK_CONFIGS);
}
