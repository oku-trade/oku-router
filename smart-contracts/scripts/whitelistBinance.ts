/**
 * One-shot script to whitelist the Binance router on all chains that have
 * an existing OkuRouter deployment, plus whitelist all new targets on robinhood.
 *
 * Usage:
 *   npx hardhat run scripts/whitelistBinance.ts
 *
 * Requires MAINNET_PRIVATE_KEY in .env (the deployer/owner key).
 */
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

const BINANCE_ROUTER = "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5";

const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("MAINNET_PRIVATE_KEY not set in .env");
}

interface WhitelistJob {
  chain: string;
  rpcUrl: string;
  routerAddress: string;
  targets: { address: string; name: string }[];
}

const jobs: WhitelistJob[] = [
  // --- Binance whitelist on 6 chains with deployments ---
  {
    chain: "arbitrum",
    rpcUrl: process.env.ARB_URL || "https://arb1.arbitrum.io/rpc",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  {
    chain: "base",
    rpcUrl: process.env.BASE_URL || "https://mainnet.base.org",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  {
    chain: "bsc",
    rpcUrl: process.env.BSC_URL || "https://bsc-dataseed.binance.org",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  {
    chain: "linea",
    rpcUrl: process.env.LINEA_URL || "https://rpc.linea.build",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  {
    chain: "optimism",
    rpcUrl: process.env.OP_URL || "https://mainnet.optimism.io",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  {
    chain: "polygon",
    rpcUrl: process.env.POLYGON_URL || "https://polygon-rpc.com",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: BINANCE_ROUTER, name: "BinanceRouter" }],
  },
  // --- All new targets on robinhood ---
  {
    chain: "robinhood",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    routerAddress: "0x47A708142C348e2B4260cCEf3abC2Aff03486eBc",
    targets: [
      { address: "0x0000000000001ff3684f28c67538d4d072c22734", name: "AllowanceHolder (0x)" },
      { address: "0xe72688f7d25d7318b9a81f21edda640ca948c83b", name: "Settler (0x)" },
      { address: "0x603206D6105217DD972E4Ab30676A220CA393346", name: "IceCreamSwapRouter" },
      { address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", name: "MetaAggregationRouterV2 (KyberSwap)" },
      { address: "0xE58b3089dF6667fBf99b75595a1671BaF6797D6d", name: "OkxRouter" },
      { address: "0x8876789976decbfcbbbe364623c63652db8c0904", name: "UsorRouter" },
      { address: "0xcaf681a66d020601342297493863e78c959e5cb2", name: "SwapRouter02 (Uniswap)" },
    ],
  },
];

async function main() {
  console.log(`Signer: ${new ethers.Wallet(PRIVATE_KEY!).address}\n`);

  for (const job of jobs) {
    console.log(`\n=== ${job.chain} ===`);
    console.log(`  Router: ${job.routerAddress}`);

    let provider: ethers.JsonRpcProvider;
    try {
      provider = new ethers.JsonRpcProvider(job.rpcUrl);
      await provider.getNetwork(); // connectivity check
    } catch (err: any) {
      console.error(`  SKIP: cannot connect to ${job.chain} RPC: ${err.message}`);
      continue;
    }

    const signer = new ethers.Wallet(PRIVATE_KEY!, provider);
    const router = OkuRouter__factory.connect(job.routerAddress, signer);

    for (const target of job.targets) {
      try {
        // Check if already whitelisted
        const already = await router.swapTargets(target.address);
        if (already) {
          console.log(`  ✓ ${target.name} (${target.address}) — already whitelisted`);
          continue;
        }

        console.log(`  → Whitelisting ${target.name} (${target.address})...`);
        const tx = await router.updateSwapTargets(target.address, true);
        console.log(`    tx: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`    ✓ confirmed in block ${receipt?.blockNumber}`);
      } catch (err: any) {
        console.error(`  ✗ FAILED ${target.name}: ${err.message}`);
      }
    }
  }

  console.log("\n✓ Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
