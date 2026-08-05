/**
 * testAllChains.ts
 *
 * Sequential test runner for all deployed Oku Router chains
 *
 * This script automatically detects all chains with Oku Router deployments
 * from networkConfig.ts and runs testRouters.ts for each one sequentially.
 *
 * Usage:
 *   npx hardhat run scripts/testRouters/testAllChains.ts
 */

import { NETWORK_CONFIGS } from "../../util/deploymentConfig";
import { getCurrentAddress } from "../../util/deploymentsRegistry";
import { exec } from "child_process";
import { promisify } from "util";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

const execAsync = promisify(exec);

// Timeout for each chain test (5 minutes)
const CHAIN_TIMEOUT_MS = 5 * 60 * 1000;

interface ChainTestResult {
  networkName: string;
  chainName: string;
  success: boolean;
  error?: string;
}

/**
 * Execute command with timeout
 */
async function execWithTimeout(
  command: string,
  options: any,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return Promise.race([
    execAsync(command, options) as unknown as Promise<{ stdout: string; stderr: string }>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
    ),
  ]);
}

async function testChain(networkName: string, chainName: string): Promise<ChainTestResult> {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🧪 Testing ${chainName.toUpperCase()}`);
  console.log(`${"=".repeat(80)}`);

  try {
    const { stdout, stderr } = await execWithTimeout(
      `npx hardhat run scripts/testRouters/testRouters.ts --network ${networkName}`,
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }, // 10MB buffer for large output
      CHAIN_TIMEOUT_MS
    );

    console.log(stdout);
    if (stderr) console.error(stderr);

    return { networkName, chainName, success: true };
  } catch (error: any) {
    console.error(`❌ Failed to test ${chainName}`);
    console.error(error.message);
    return {
      networkName,
      chainName,
      success: false,
      error: error.message
    };
  }
}

/**
 * Check if RPC URL is configured for a network
 */
function isRpcConfigured(networkName: string): boolean {
  const config = NETWORK_CONFIGS[networkName];
  if (!config) return false;

  const rpcUrl = config.rpcUrl;
  return !!rpcUrl && rpcUrl !== "" && !rpcUrl.match(/^0+$/);
}

async function main() {
  console.log(`\n🚀 Testing All Deployed Oku Routers`);
  console.log(`${"=".repeat(80)}\n`);

  // Filter for deployed chains with valid RPC URLs. "Deployed" is now
  // determined by the on-disk registry (deployments/<network>.json) rather
  // than a hardcoded field on the static NetworkConfig.
  const deployedChains = Object.entries(NETWORK_CONFIGS)
    .map(([networkName, config]) => ({
      networkName,
      chainName: config.chainName,
      address: getCurrentAddress(networkName, "OkuRouter"),
      hasRpc: isRpcConfigured(networkName),
    }))
    .filter((c): c is { networkName: string; chainName: string; address: string; hasRpc: boolean } =>
      !!c.address,
    );

  const chainsWithRpc = deployedChains.filter(c => c.hasRpc);
  const chainsWithoutRpc = deployedChains.filter(c => !c.hasRpc);

  console.log(`Found ${deployedChains.length} deployed chains:`);
  chainsWithRpc.forEach(({ chainName, address }) => {
    console.log(`  ✅ ${chainName}: ${address}`);
  });
  chainsWithoutRpc.forEach(({ chainName, address, networkName }) => {
    console.log(`  ⏭️  ${chainName}: ${address} (skipped - RPC URL not configured)`);
  });

  const results: ChainTestResult[] = [];

  // Test each chain sequentially (only those with RPC configured)
  for (const { networkName, chainName, hasRpc } of deployedChains) {
    if (!hasRpc) {
      results.push({
        networkName,
        chainName,
        success: false,
        error: `RPC URL not configured`
      });
      continue;
    }

    const result = await testChain(networkName, chainName);
    results.push(result);
  }

  // Print summary
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 ALL CHAINS TEST SUMMARY`);
  console.log(`${"=".repeat(80)}`);

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  successful.forEach(r => console.log(`  - ${r.chainName}`));

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach(r => console.log(`  - ${r.chainName}: ${r.error}`));
  }

  console.log(`\n${"=".repeat(80)}`);

  // Exit with error code if any tests failed
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ Fatal Error:", error.message);
  process.exit(1);
});
