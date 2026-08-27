import "@nomicfoundation/hardhat-toolbox"; // Includes ethers, chai-matchers, typechain, verify, etc.
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import { HardhatUserConfig, task } from 'hardhat/config';
import { config as dotEnvConfig } from "dotenv";
import { networkByName } from "@gfxlabs/oku-chains";
import "./tasks/deploy";
import "./tasks/deployPermit2Proxy";
import "./tasks/predictAll";


dotEnvConfig();

const zaddr =
  "0000000000000000000000000000000000000000000000000000000000000000";

// chainId, keyed by @gfxlabs/oku-chains internalName. Sourced from
// chain-config (the single source of truth for chain identity) rather than
// hardcoded per network, so this can never drift from deploymentConfig.ts.
// "mainnet" -> "optimism" and "avax" -> "avalanche" are the only hardhat
// network names that don't match chain-config's internalName 1:1.
function chainIdFor(internalName: string): number {
  return networkByName(internalName).id;
}

// A chain-config-sourced public RPC, used as a last-resort fallback (after
// env var override and Alchemy) for any chain not covered by the
// hand-curated PUBLIC_RPCS map below.
function chainConfigRpc(internalName: string): string | undefined {
  return networkByName(internalName).rpcUrls.default.http[0];
}

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

// Chains with confirmed Alchemy RPC support
const ALCHEMY_SUPPORTED = new Set([
  "eth-mainnet", "opt-mainnet", "arb-mainnet", "base-mainnet",
  "bnb-mainnet", "polygon-mainnet", "avax-mainnet",
  "linea-mainnet", "blast-mainnet", "scroll-mainnet", "zksync-mainnet",
  "mantle-mainnet", "worldchain-mainnet", "unichain-mainnet",
]);

// Public RPC fallbacks for all chains (used when no Alchemy key or chain not on Alchemy)
const PUBLIC_RPCS: Record<string, string> = {
  "eth-mainnet":        "https://ethereum-rpc.publicnode.com",
  "opt-mainnet":        "https://mainnet.optimism.io",
  "arb-mainnet":        "https://arb1.arbitrum.io/rpc",
  "base-mainnet":       "https://mainnet.base.org",
  "bnb-mainnet":        "https://bsc-dataseed.binance.org",
  "polygon-mainnet":    "https://polygon-rpc.com",
  "avax-mainnet":       "https://api.avax.network/ext/bc/C/rpc",
  "linea-mainnet":      "https://rpc.linea.build",
  "blast-mainnet":      "https://rpc.blast.io",
  "scroll-mainnet":     "https://rpc.scroll.io",
  "zksync-mainnet":     "https://mainnet.era.zksync.io",
  "mantle-mainnet":     "https://rpc.mantle.xyz",
  "gnosis-mainnet":     "https://rpc.gnosischain.com",
  "worldchain-mainnet": "https://worldchain-mainnet.g.alchemy.com/public",
  "unichain-mainnet":   "https://mainnet.unichain.org",
  "filecoin-mainnet":   "https://rpc.ankr.com/filecoin",
  "boba-mainnet":       "https://mainnet.boba.network",
  "telos-mainnet":      "https://rpc.telos.net",
  "hemi-mainnet":       "https://rpc.hemi.network/rpc",
  "nibiru-mainnet":     "https://evm-rpc.nibiru.fi",
  "redbelly-mainnet":   "https://governors.mainnet.redbelly.network",
  "gensyn-mainnet":     "https://gensyn-mainnet.g.alchemy.com/public",
  "sonic-mainnet":      "https://rpc.soniclabs.com",
  "taiko-mainnet":      "https://rpc.mainnet.taiko.xyz",
  "celo-mainnet":       "https://forno.celo.org",
  "rootstock-mainnet":  "https://public-node.rsk.co",
};

// Resolve RPC URL: Alchemy if supported, else public fallback
function alchemyUrl(network: string): string {
  if (ALCHEMY_API_KEY && ALCHEMY_SUPPORTED.has(network)) {
    return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  }
  return PUBLIC_RPCS[network] || "";
}

// Resolve RPC URL: env var override → Alchemy/curated public fallback →
// chain-config public RPC → zero addr. The chain-config fallback only
// matters for chains missing from the hand-curated PUBLIC_RPCS map above
// (it's a safety net, not a replacement -- PUBLIC_RPCS entries were chosen
// deliberately and take priority).
function rpcUrl(
  envVar: string | undefined,
  alchemyNetwork: string,
  chainConfigFallback?: string,
): string {
  return envVar || alchemyUrl(alchemyNetwork) || chainConfigFallback || zaddr;
}
// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more
const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  namedAccounts: {
    deployer: {
      default: 0, // First account from accounts array
    },
  },
  etherscan: {
    // Etherscan V2 API - single universal API key for all Etherscan-compatible chains.
    // For Blockscout/Alchemy-explorer chains, customChains entries below route to
    // their specific API endpoints (these accept any apiKey value).
    apiKey: process.env.MAINNET_API_KEY || "",
    // Custom chains that are not part of Etherscan's v2 universal API
    customChains: [
      // Worldchain (Alchemy Explorer)
      {
        network: "worldchain",
        chainId: 480,
        urls: {
          apiURL: "https://worldchain-mainnet.explorer.alchemy.com/api",
          browserURL: "https://worldchain-mainnet.explorer.alchemy.com"
        }
      },
      // zkSync Era
      {
        network: "zksync",
        chainId: 324,
        urls: {
          apiURL: "https://api-era.zksync.network/api",
          browserURL: "https://era.zksync.network"
        }
      },
      // Unichain (Blockscout)
      {
        network: "unichain",
        chainId: 130,
        urls: {
          apiURL: "https://unichain.blockscout.com/api",
          browserURL: "https://unichain.blockscout.com"
        }
      },
      // Rootstock (Blockscout)
      {
        network: "rootstock",
        chainId: 30,
        urls: {
          apiURL: "https://rootstock.blockscout.com/api",
          browserURL: "https://rootstock.blockscout.com"
        }
      },
      // Telos (Teloscan)
      {
        network: "telos",
        chainId: 40,
        urls: {
          apiURL: "https://api.teloscan.io/api",
          browserURL: "https://teloscan.io"
        }
      },
      // LightLink (Blockscout)
      {
        network: "lightlink",
        chainId: 1890,
        urls: {
          apiURL: "https://phoenix.lightlink.io/api",
          browserURL: "https://phoenix.lightlink.io"
        }
      },
      // XDC (Blockscout)
      {
        network: "xdc",
        chainId: 50,
        urls: {
          apiURL: "https://xdc.blocksscan.io/api",
          browserURL: "https://xdc.blocksscan.io"
        }
      },
      // BOB (Blockscout)
      {
        network: "bob",
        chainId: 60808,
        urls: {
          apiURL: "https://explorer.gobob.xyz/api",
          browserURL: "https://explorer.gobob.xyz"
        }
      },
      // Mantle (Mantlescan - Etherscan V2)
      {
        network: "mantle",
        chainId: 5000,
        urls: {
          apiURL: "https://api.mantlescan.xyz/api",
          browserURL: "https://mantlescan.xyz"
        }
      },
      // Linea (Lineascan - Etherscan V2)
      {
        network: "linea",
        chainId: 59144,
        urls: {
          apiURL: "https://api.lineascan.build/api",
          browserURL: "https://lineascan.build"
        }
      },
      // Boba (Bobascan)
      {
        network: "boba",
        chainId: 288,
        urls: {
          apiURL: "https://api.bobascan.com/api",
          browserURL: "https://bobascan.com"
        }
      },
      // Hemi (Blockscout)
      {
        network: "hemi",
        chainId: 43111,
        urls: {
          apiURL: "https://explorer.hemi.xyz/api",
          browserURL: "https://explorer.hemi.xyz"
        }
      },
      // Gensyn (Alchemy Explorer)
      {
        network: "gensyn",
        chainId: 685689,
        urls: {
          apiURL: "https://gensyn-mainnet.explorer.alchemy.com/api",
          browserURL: "https://gensyn-mainnet.explorer.alchemy.com"
        }
      },
      // Filecoin (Blockscout)
      {
        network: "filecoin",
        chainId: 314,
        urls: {
          apiURL: "https://filecoin.blockscout.com/api",
          browserURL: "https://filecoin.blockscout.com"
        }
      },
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com"
        }
      }
    ]
  },
  sourcify: {
    enabled: true,
  },
  gasReporter: {
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    currency: 'USD',
  },
  networks: {
    hardhat: {
      chainId: chainIdFor("optimism"), // Use Optimism chainId by default for EIP-712 compatibility
      forking: {
        url: process.env.MAINNET_URL ? process.env.MAINNET_URL : zaddr,
        blockNumber: 14546835,
      },
      mining: {
        auto: true,
      },
    },
    mainnet: {
      url: rpcUrl(process.env.MAINNET_URL, "eth-mainnet", chainConfigRpc("ethereum")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
      chainId: chainIdFor("ethereum"),
    },
    op: {
      url: rpcUrl(process.env.OP_URL, "opt-mainnet", chainConfigRpc("optimism")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
      chainId: chainIdFor("optimism"),
    },
    worldchain: {
      url: rpcUrl(process.env.WORLDCHAIN_URL, "worldchain-mainnet", chainConfigRpc("worldchain")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
      chainId: chainIdFor("worldchain"),
    },
    base: {
      url: rpcUrl(process.env.BASE_URL, "base-mainnet", chainConfigRpc("base")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("base"),
    },
    arbitrum: {
      url: rpcUrl(process.env.ARB_URL, "arb-mainnet", chainConfigRpc("arbitrum")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("arbitrum"),
    },
    polygon: {
      url: rpcUrl(process.env.POLYGON_URL, "polygon-mainnet", chainConfigRpc("polygon")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("polygon"),
    },
    bsc: {
      url: rpcUrl(process.env.BSC_URL, "bnb-mainnet", chainConfigRpc("bsc")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("bsc"),
      timeout: 60000,
      httpHeaders: { "Content-Type": "application/json" },
    },
    avax: {
      url: rpcUrl(process.env.AVAX_URL, "avax-mainnet", chainConfigRpc("avalanche")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("avalanche"),
    },
    linea: {
      url: rpcUrl(process.env.LINEA_URL, "linea-mainnet", chainConfigRpc("linea")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("linea"),
    },
    blast: {
      url: rpcUrl(process.env.BLAST_URL, "blast-mainnet", chainConfigRpc("blast")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("blast"),
    },
    scroll: {
      url: rpcUrl(process.env.SCROLL_URL, "scroll-mainnet", chainConfigRpc("scroll")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("scroll"),
    },
    zksync: {
      url: rpcUrl(process.env.ZKSYNC_URL, "zksync-mainnet", chainConfigRpc("zksync")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("zksync"),
    },
    mantle: {
      url: rpcUrl(process.env.MANTLE_URL, "mantle-mainnet", chainConfigRpc("mantle")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("mantle"),
    },
    gnosis: {
      url: rpcUrl(process.env.GNOSIS_URL, "gnosis-mainnet", chainConfigRpc("gnosis")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("gnosis"),
    },
    taiko: {
      url: rpcUrl(process.env.TAIKO_URL, "taiko-mainnet", chainConfigRpc("taiko")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("taiko"),
    },
    celo: {
      url: rpcUrl(process.env.CELO_URL, "celo-mainnet", chainConfigRpc("celo")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("celo"),
    },
    sonic: {
      url: rpcUrl(process.env.SONIC_URL, "sonic-mainnet", chainConfigRpc("sonic")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("sonic"),
    },
    unichain: {
      url: rpcUrl(process.env.UNICHAIN_URL, "unichain-mainnet", chainConfigRpc("unichain")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("unichain"),
    },
    // Additional networks
    rootstock: {
      url: rpcUrl(process.env.ROOTSTOCK_URL, "rootstock-mainnet", chainConfigRpc("rootstock")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("rootstock"),
    },
    filecoin: {
      url: rpcUrl(process.env.FILECOIN_URL, "filecoin-mainnet", chainConfigRpc("filecoin")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("filecoin"),
    },
    boba: {
      url: rpcUrl(process.env.BOBA_URL, "boba-mainnet", chainConfigRpc("boba")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("boba"),
    },
    telos: {
      url: rpcUrl(process.env.TELOS_URL, "telos-mainnet", chainConfigRpc("telos")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("telos"),
    },
    lightlink: {
      url: rpcUrl(process.env.LIGHTLINK_URL, "lightlink-mainnet", chainConfigRpc("lightlink")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("lightlink"),
    },
    hemi: {
      url: rpcUrl(process.env.HEMI_URL, "hemi-mainnet", chainConfigRpc("hemi")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("hemi"),
    },
    xdc: {
      url: rpcUrl(process.env.XDC_URL, "xdc-mainnet", chainConfigRpc("xdc")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("xdc"),
      // XDC's node rejects EIP-1559 txs that ethers auto-populates here
      // (the balance pre-check fails even though gasLimit*maxFee is well
      // under balance). chain-config marks xdc `transactionType: legacy`;
      // force a legacy tx with an explicit gasPrice above base fee (base
      // ~12.5 gwei; eth_gasPrice ~14 gwei -- use 25 gwei for headroom).
      gasPrice: 25_000_000_000,
    },
    redbelly: {
      url: rpcUrl(process.env.REDBELLY_URL, "redbelly-mainnet", chainConfigRpc("redbelly")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("redbelly"),
    },
    lens: {
      url: rpcUrl(process.env.LENS_URL, "lens-mainnet", chainConfigRpc("lens")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("lens"),
    },
    goat: {
      url: rpcUrl(process.env.GOAT_URL, "goat-mainnet", chainConfigRpc("goat")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("goat"),
    },
    nibiru: {
      url: rpcUrl(process.env.NIBIRU_URL, "nibiru-mainnet", chainConfigRpc("nibiru")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("nibiru"),
    },
    plasma: {
      url: rpcUrl(process.env.PLASMA_URL, "plasma-mainnet", chainConfigRpc("plasma")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("plasma"),
    },
    etherlink: {
      url: rpcUrl(process.env.ETHERLINK_URL, "etherlink-mainnet", chainConfigRpc("etherlink")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("etherlink"),
    },
    bob: {
      url: rpcUrl(process.env.BOB_URL, "bob-mainnet", chainConfigRpc("bob")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("bob"),
    },
    corn: {
      url: rpcUrl(process.env.CORN_URL, "corn-mainnet", chainConfigRpc("corn")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("corn"),
    },
    monad: {
      url: rpcUrl(process.env.MONAD_URL, "monad-mainnet", chainConfigRpc("monad")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("monad"),
    },
    sei: {
      url: rpcUrl(process.env.SEI_URL, "sei-mainnet", chainConfigRpc("sei")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("sei"),
    },
    gensyn: {
      url: rpcUrl(process.env.GENSYN_URL, "gensyn-mainnet", chainConfigRpc("gensyn")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("gensyn"),
    },
    robinhood: {
      url: rpcUrl(process.env.ROBINHOOD_URL, "robinhood-mainnet", chainConfigRpc("robinhood")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("robinhood"),
    },
    // --- Full-scope expansion additions below ---
    // `mainnet` (ethereum) already has a network entry above. `celo` and
    // `pharos` are deliberately NOT added here yet (see the matching note
    // in util/deploymentConfig.ts).
    saga: {
      url: rpcUrl(process.env.SAGA_URL, "saga-mainnet", chainConfigRpc("saga")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("saga"),
      // Saga chainlet mines zero-price txs (baseFee = gasPrice = 0) and the
      // deployer wallet holds a 0 balance. Force a legacy gasPrice of 0 so
      // ethers doesn't auto-populate a non-zero EIP-1559 fee, which would
      // otherwise trip the node's balance check (balance < gasLimit * fee).
      gasPrice: 0,
    },
    zerog: {
      url: rpcUrl(process.env.ZEROG_URL, "zerog-mainnet", chainConfigRpc("zerog")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("zerog"),
    },
    hyperevm: {
      url: rpcUrl(process.env.HYPEREVM_URL, "hyperevm-mainnet", chainConfigRpc("hyperevm")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("hyperevm"),
    },
    pharos: {
      url: rpcUrl(process.env.PHAROS_URL, "pharos-mainnet", chainConfigRpc("pharos")),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: chainIdFor("pharos"),
    },
  },
  solidity: {
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
    version: '0.8.27',
  }
};

export default config
