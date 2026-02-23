import "@nomicfoundation/hardhat-toolbox"; // Includes ethers, chai-matchers, typechain, verify, etc.
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import { HardhatUserConfig, task } from 'hardhat/config';
import { config as dotEnvConfig } from "dotenv";
import "./tasks/deploy";
import "./tasks/deployPermit2Proxy";


dotEnvConfig();

const zaddr =
  "0000000000000000000000000000000000000000000000000000000000000000";
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
    // Etherscan V2 API - single universal API key for all Etherscan-compatible chains
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
      url: process.env.MAINNET_URL ? process.env.MAINNET_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      minGasPrice: 32000000000,
    },
    op: {
      url: process.env.OP_URL ? process.env.OP_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      minGasPrice: 32000000000,
      chainId: 10
    },
    worldchain: {
      url: process.env.WORLDCHAIN_URL ? process.env.WORLDCHAIN_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      minGasPrice: 32000000000,
      chainId: 480
    },
    base: {
      url: process.env.BASE_URL ? process.env.BASE_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 8453
    },
    arbitrum: {
      url: process.env.ARB_URL ? process.env.ARB_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 42161
    },
    polygon: {
      url: process.env.POLYGON_URL ? process.env.POLYGON_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 137
    },
    bsc: {
      url: process.env.BSC_URL ? process.env.BSC_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 56,
      timeout: 60000, // 60 second timeout
      httpHeaders: {
        "Content-Type": "application/json"
      }
    },
    avax: {
      url: process.env.AVAX_URL ? process.env.AVAX_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 43114
    },
    linea: {
      url: process.env.LINEA_URL ? process.env.LINEA_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 59144
    },
    blast: {
      url: process.env.BLAST_URL ? process.env.BLAST_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 81457
    },
    scroll: {
      url: process.env.SCROLL_URL ? process.env.SCROLL_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 534352
    },
    zksync: {
      url: process.env.ZKSYNC_URL ? process.env.ZKSYNC_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 324
    },
    mantle: {
      url: process.env.MANTLE_URL ? process.env.MANTLE_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 5000
    },
    gnosis: {
      url: process.env.GNOSIS_URL ? process.env.GNOSIS_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 100
    },
    taiko: {
      url: process.env.TAIKO_URL ? process.env.TAIKO_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 167000
    },
    celo: {
      url: process.env.CELO_URL ? process.env.CELO_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 42220
    },
    sonic: {
      url: process.env.SONIC_URL ? process.env.SONIC_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 146
    },
    unichain: {
      url: process.env.UNICHAIN_URL ? process.env.UNICHAIN_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 130
    },
    // Additional networks from networkConfig
    rootstock: {
      url: process.env.ROOTSTOCK_URL ? process.env.ROOTSTOCK_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 30
    },
    filecoin: {
      url: process.env.FILECOIN_URL ? process.env.FILECOIN_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 314
    },
    boba: {
      url: process.env.BOBA_URL ? process.env.BOBA_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 288
    },
    telos: {
      url: process.env.TELOS_URL ? process.env.TELOS_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 40
    },
    lightlink: {
      url: process.env.LIGHTLINK_URL ? process.env.LIGHTLINK_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 1890
    },
    hemi: {
      url: process.env.HEMI_URL ? process.env.HEMI_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 43111
    },
    xdc: {
      url: process.env.XDC_URL ? process.env.XDC_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 50
    },
    redbelly: {
      url: process.env.REDBELLY_URL ? process.env.REDBELLY_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 151
    },
    lens: {
      url: process.env.LENS_URL ? process.env.LENS_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 232
    },
    goat: {
      url: process.env.GOAT_URL ? process.env.GOAT_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 2345
    },
    nibiru: {
      url: process.env.NIBIRU_URL ? process.env.NIBIRU_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 6900
    },
    plasma: {
      url: process.env.PLASMA_URL ? process.env.PLASMA_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 9745
    },
    etherlink: {
      url: process.env.ETHERLINK_URL ? process.env.ETHERLINK_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 42793
    },
    bob: {
      url: process.env.BOB_URL ? process.env.BOB_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 60808
    },
    corn: {
      url: process.env.CORN_URL ? process.env.CORN_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 21000000
    },
    monad: {
      url: process.env.MONAD_URL ? process.env.MONAD_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 143
    },
    sei: {
      url: process.env.SEI_URL ? process.env.SEI_URL : zaddr,
      accounts: [
        process.env.MAINNET_PRIVATE_KEY
          ? process.env.MAINNET_PRIVATE_KEY
          : zaddr
      ],
      chainId: 1329
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
