/**
 * preDeployCheck.ts
 *
 * Pre-deployment readiness check for target chains. For each chain:
 *   1. Tests RPC connectivity (eth_chainId)
 *   2. Checks if the Safe Singleton Factory exists on-chain
 *   3. Reports whether deterministic (CREATE2) or non-deterministic deployment is available
 *
 * Usage:
 *   npx hardhat run scripts/preDeployCheck.ts
 *
 * This script does NOT send any transactions or modify any state.
 */

import { ethers } from "ethers";
import { config as dotEnvConfig } from "dotenv";
import { SAFE_SINGLETON_FACTORY } from "../util/contractMeta";

dotEnvConfig();

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

const ALCHEMY_SUPPORTED = new Set([
  "eth-mainnet", "opt-mainnet", "arb-mainnet", "base-mainnet",
  "bnb-mainnet", "polygon-mainnet", "avax-mainnet",
  "linea-mainnet", "blast-mainnet", "scroll-mainnet", "zksync-mainnet",
  "mantle-mainnet", "worldchain-mainnet", "unichain-mainnet",
]);

const PUBLIC_RPCS: Record<string, string> = {
  "filecoin-mainnet":   "https://rpc.ankr.com/filecoin",
  "telos-mainnet":      "https://rpc.telos.net",
  "unichain-mainnet":   "https://mainnet.unichain.org",
  "boba-mainnet":       "https://mainnet.boba.network",
  "linea-mainnet":      "https://rpc.linea.build",
  "hemi-mainnet":       "https://rpc.hemi.network/rpc",
  "nibiru-mainnet":     "https://evm-rpc.nibiru.fi",
  "redbelly-mainnet":   "https://governors.mainnet.redbelly.network",
  "mantle-mainnet":     "https://rpc.mantle.xyz",
  "gensyn-mainnet":     "https://gensyn-mainnet.g.alchemy.com/public",
};

function alchemyUrl(network: string): string {
  if (ALCHEMY_API_KEY && ALCHEMY_SUPPORTED.has(network)) {
    return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  }
  return PUBLIC_RPCS[network] || "";
}

interface ChainTarget {
  name: string;
  chainId: number;
  alchemySlug: string;
  envVar: string;
  hasFactoryInConfig: boolean;
}

const TARGET_CHAINS: ChainTarget[] = [
  { name: "filecoin",  chainId: 314,   alchemySlug: "filecoin-mainnet",  envVar: "FILECOIN_URL",  hasFactoryInConfig: false },
  { name: "telos",     chainId: 40,    alchemySlug: "telos-mainnet",     envVar: "TELOS_URL",     hasFactoryInConfig: false },
  { name: "unichain",  chainId: 130,   alchemySlug: "unichain-mainnet",  envVar: "UNICHAIN_URL",  hasFactoryInConfig: true },
  { name: "boba",      chainId: 288,   alchemySlug: "boba-mainnet",      envVar: "BOBA_URL",      hasFactoryInConfig: true },
  { name: "linea",     chainId: 59144, alchemySlug: "linea-mainnet",     envVar: "LINEA_URL",     hasFactoryInConfig: true },
  { name: "hemi",      chainId: 43111, alchemySlug: "hemi-mainnet",      envVar: "HEMI_URL",      hasFactoryInConfig: false },
  { name: "nibiru",    chainId: 6900,  alchemySlug: "nibiru-mainnet",    envVar: "NIBIRU_URL",    hasFactoryInConfig: false },
  { name: "redbelly",  chainId: 151,   alchemySlug: "redbelly-mainnet",  envVar: "REDBELLY_URL",  hasFactoryInConfig: false },
  { name: "mantle",    chainId: 5000,  alchemySlug: "mantle-mainnet",    envVar: "MANTLE_URL",    hasFactoryInConfig: true },
  { name: "gensyn",    chainId: 685689, alchemySlug: "gensyn-mainnet",   envVar: "GENSYN_URL",    hasFactoryInConfig: false },
];

async function checkChain(chain: ChainTarget): Promise<{
  name: string;
  rpcOk: boolean;
  rpcUrl: string;
  chainIdMatch: boolean;
  actualChainId: number | null;
  factoryExists: boolean;
  deployMode: string;
  error: string | null;
}> {
  const url = process.env[chain.envVar] || alchemyUrl(chain.alchemySlug);
  if (!url) {
    return {
      name: chain.name,
      rpcOk: false,
      rpcUrl: "(none)",
      chainIdMatch: false,
      actualChainId: null,
      factoryExists: false,
      deployMode: "BLOCKED",
      error: "No RPC URL available (no Alchemy key, no env var, no public fallback)",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(url, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });

    // Test 1: connectivity + chain ID
    const network = await Promise.race([
      provider.getNetwork(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC timeout (10s)")), 10000)
      ),
    ]);
    const actualChainId = Number(network.chainId);
    const chainIdMatch = actualChainId === chain.chainId;

    // Test 2: Safe Singleton Factory existence
    let factoryExists = false;
    try {
      const code = await Promise.race([
        provider.getCode(SAFE_SINGLETON_FACTORY),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getCode timeout (10s)")), 10000)
        ),
      ]);
      factoryExists = code !== "0x" && code !== "0x0" && code.length > 2;
    } catch {
      // getCode failed, assume no factory
    }

    const deployMode = factoryExists ? "DETERMINISTIC (CREATE2)" : "NON-DETERMINISTIC (nonce)";

    return {
      name: chain.name,
      rpcOk: true,
      rpcUrl: url.replace(ALCHEMY_API_KEY, "***"),
      chainIdMatch,
      actualChainId,
      factoryExists,
      deployMode,
      error: chainIdMatch ? null : `Expected chainId ${chain.chainId}, got ${actualChainId}`,
    };
  } catch (err: any) {
    return {
      name: chain.name,
      rpcOk: false,
      rpcUrl: url.replace(ALCHEMY_API_KEY, "***"),
      chainIdMatch: false,
      actualChainId: null,
      factoryExists: false,
      deployMode: "BLOCKED",
      error: err.message?.slice(0, 120) || "Unknown error",
    };
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("Pre-Deploy Readiness Check");
  console.log(`Safe Singleton Factory: ${SAFE_SINGLETON_FACTORY}`);
  console.log(`Alchemy API key: ${ALCHEMY_API_KEY ? "set" : "NOT SET"}`);
  console.log("=".repeat(80));
  console.log();

  const results = await Promise.all(TARGET_CHAINS.map(checkChain));

  // Print results
  for (const r of results) {
    const status = r.rpcOk ? (r.chainIdMatch ? "OK" : "CHAIN_ID_MISMATCH") : "FAIL";
    const factoryIcon = r.factoryExists ? "YES" : "no";

    console.log(`--- ${r.name.toUpperCase()} ---`);
    console.log(`  RPC:      ${status} (${r.rpcUrl})`);
    if (r.error) console.log(`  Error:    ${r.error}`);
    const chainDef = TARGET_CHAINS.find(c => c.name === r.name);
    console.log(`  Factory:  ${factoryIcon}${chainDef?.hasFactoryInConfig ? "" : " (not in config either)"}`);
    console.log(`  Deploy:   ${r.deployMode}`);
    console.log();
  }

  // Summary table
  console.log("=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(
    "Chain".padEnd(12) +
    "RPC".padEnd(8) +
    "Factory".padEnd(10) +
    "Deploy Mode".padEnd(30) +
    "Command"
  );
  console.log("-".repeat(80));

  for (const r of results) {
    const rpcStatus = r.rpcOk && r.chainIdMatch ? "OK" : "FAIL";
    const factory = r.factoryExists ? "YES" : "no";
    const cmd = r.rpcOk && r.chainIdMatch
      ? (r.factoryExists
        ? `npx hardhat deploy --network ${r.name} --deterministic`
        : `npx hardhat deploy --network ${r.name}`)
      : "(fix RPC first)";

    console.log(
      r.name.padEnd(12) +
      rpcStatus.padEnd(8) +
      factory.padEnd(10) +
      r.deployMode.padEnd(30) +
      cmd
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
