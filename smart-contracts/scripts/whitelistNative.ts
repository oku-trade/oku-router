/**
 * One-shot script to whitelist the Native router on all chains that have
 * an existing OkuRouter deployment.
 *
 * Usage:
 *   npx tsx scripts/whitelistNative.ts
 *
 * Requires MAINNET_PRIVATE_KEY in .env (the deployer/owner key).
 */
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

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
  {
    chain: "arbitrum",
    rpcUrl: process.env.ARB_URL || "https://arb1.arbitrum.io/rpc",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: "0x0FC85a171bD0b53BF0bBace74F04B66170Ae3eAb", name: "NativeRouter" }],
  },
  {
    chain: "base",
    rpcUrl: process.env.BASE_URL || "https://mainnet.base.org",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: "0xaEC634d949df14Be76dC317504C7b9a6a8A5f576", name: "NativeRouter" }],
  },
  {
    chain: "bsc",
    rpcUrl: process.env.BSC_URL || "https://bsc-dataseed.binance.org",
    routerAddress: "0x25132a6F4f0A993d62e57D0510df1395729125ad",
    targets: [{ address: "0xF064b069Ed18Eb5c61159247C55C5af79B28a968", name: "NativeRouter" }],
  },
  {
    chain: "robinhood",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    routerAddress: "0x47A708142C348e2B4260cCEf3abC2Aff03486eBc",
    targets: [{ address: "0xa5ec1f0aC784C3620fFDcdf2A7DbcEF9DA658ea4", name: "NativeRouter" }],
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
      await provider.getNetwork();
    } catch (err: any) {
      console.error(`  SKIP: cannot connect to ${job.chain} RPC: ${err.message}`);
      continue;
    }

    const signer = new ethers.Wallet(PRIVATE_KEY!, provider);
    const router = OkuRouter__factory.connect(job.routerAddress, signer);

    for (const target of job.targets) {
      try {
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
