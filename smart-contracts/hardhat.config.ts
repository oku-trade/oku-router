import "@nomicfoundation/hardhat-toolbox"; // Includes ethers, chai-matchers, typechain, verify, etc.
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import { HardhatUserConfig, task } from 'hardhat/config';
import { config as dotEnvConfig } from "dotenv";
import "./tasks/deploy";
import "./tasks/deployPermit2Proxy";
import "./tasks/predictAll";


dotEnvConfig();

const zaddr =
  "0000000000000000000000000000000000000000000000000000000000000000";

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

// Resolve RPC URL: env var override → Alchemy/public fallback → zero addr
function rpcUrl(envVar: string | undefined, alchemyNetwork: string): string {
  return envVar || alchemyUrl(alchemyNetwork) || zaddr;
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
    ]
  },
  gasReporter: {
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    currency: 'USD',
  },
  networks: {
    hardhat: {
      chainId: 10, // Use Optimism chainId by default for EIP-712 compatibility
      forking: {
        url: process.env.MAINNET_URL ? process.env.MAINNET_URL : zaddr,
        blockNumber: 14546835,
      },
      mining: {
        auto: true,
      },
    },
    mainnet: {
      url: rpcUrl(process.env.MAINNET_URL, "eth-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
    },
    op: {
      url: rpcUrl(process.env.OP_URL, "opt-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
      chainId: 10,
    },
    worldchain: {
      url: rpcUrl(process.env.WORLDCHAIN_URL, "worldchain-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      minGasPrice: 32000000000,
      chainId: 480,
    },
    base: {
      url: rpcUrl(process.env.BASE_URL, "base-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 8453,
    },
    arbitrum: {
      url: rpcUrl(process.env.ARB_URL, "arb-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 42161,
    },
    polygon: {
      url: rpcUrl(process.env.POLYGON_URL, "polygon-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 137,
    },
    bsc: {
      url: rpcUrl(process.env.BSC_URL, "bnb-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 56,
      timeout: 60000,
      httpHeaders: { "Content-Type": "application/json" },
    },
    avax: {
      url: rpcUrl(process.env.AVAX_URL, "avax-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 43114,
    },
    linea: {
      url: rpcUrl(process.env.LINEA_URL, "linea-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 59144,
    },
    blast: {
      url: rpcUrl(process.env.BLAST_URL, "blast-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 81457,
    },
    scroll: {
      url: rpcUrl(process.env.SCROLL_URL, "scroll-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 534352,
    },
    zksync: {
      url: rpcUrl(process.env.ZKSYNC_URL, "zksync-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 324,
    },
    mantle: {
      url: rpcUrl(process.env.MANTLE_URL, "mantle-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 5000,
    },
    gnosis: {
      url: rpcUrl(process.env.GNOSIS_URL, "gnosis-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 100,
    },
    taiko: {
      url: rpcUrl(process.env.TAIKO_URL, "taiko-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 167000,
    },
    celo: {
      url: rpcUrl(process.env.CELO_URL, "celo-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 42220,
    },
    sonic: {
      url: rpcUrl(process.env.SONIC_URL, "sonic-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 146,
    },
    unichain: {
      url: rpcUrl(process.env.UNICHAIN_URL, "unichain-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 130,
    },
    // Additional networks
    rootstock: {
      url: rpcUrl(process.env.ROOTSTOCK_URL, "rootstock-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 30,
    },
    filecoin: {
      url: rpcUrl(process.env.FILECOIN_URL, "filecoin-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 314,
    },
    boba: {
      url: rpcUrl(process.env.BOBA_URL, "boba-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 288,
    },
    telos: {
      url: rpcUrl(process.env.TELOS_URL, "telos-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 40,
    },
    lightlink: {
      url: rpcUrl(process.env.LIGHTLINK_URL, "lightlink-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 1890,
    },
    hemi: {
      url: rpcUrl(process.env.HEMI_URL, "hemi-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 43111,
    },
    xdc: {
      url: rpcUrl(process.env.XDC_URL, "xdc-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 50,
    },
    redbelly: {
      url: rpcUrl(process.env.REDBELLY_URL, "redbelly-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 151,
    },
    lens: {
      url: rpcUrl(process.env.LENS_URL, "lens-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 232,
    },
    goat: {
      url: rpcUrl(process.env.GOAT_URL, "goat-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 2345,
    },
    nibiru: {
      url: rpcUrl(process.env.NIBIRU_URL, "nibiru-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 6900,
    },
    plasma: {
      url: rpcUrl(process.env.PLASMA_URL, "plasma-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 9745,
    },
    etherlink: {
      url: rpcUrl(process.env.ETHERLINK_URL, "etherlink-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 42793,
    },
    bob: {
      url: rpcUrl(process.env.BOB_URL, "bob-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 60808,
    },
    corn: {
      url: rpcUrl(process.env.CORN_URL, "corn-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 21000000,
    },
    monad: {
      url: rpcUrl(process.env.MONAD_URL, "monad-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 143,
    },
    sei: {
      url: rpcUrl(process.env.SEI_URL, "sei-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 1329,
    },
    gensyn: {
      url: rpcUrl(process.env.GENSYN_URL, "gensyn-mainnet"),
      accounts: [process.env.MAINNET_PRIVATE_KEY || zaddr],
      chainId: 685689,
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
