/**
 * testForkDeploy.ts
 *
 * Forks each target chain locally, impersonates the real dev wallet
 * (derived from MAINNET_PRIVATE_KEY), and tests deterministic deploy:
 *   1. Fork the chain via Hardhat's built-in forking
 *   2. Impersonate the dev wallet (NO balance manipulation)
 *   3. Check on-chain balance — if insufficient, report and move on
 *   4. Verify the Safe Singleton Factory exists
 *   5. Predict the CREATE2 address and confirm it matches worldchain
 *   6. Deploy via the factory
 *   7. Verify code at the predicted address
 *
 * Usage:
 *   npx hardhat run scripts/testForkDeploy.ts
 *
 * This script runs entirely on local Hardhat forks — no live transactions.
 */

import hre from "hardhat";
import { ethers } from "hardhat";
import { formatEther } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  getOkuRouterSalt,
  computeCreate2Address,
} from "../util/contractMeta";

// Expected address from worldchain deployment
const EXPECTED_ADDRESS = "0x25132a6F4f0A993d62e57D0510df1395729125ad";

// Minimum balance to attempt deployment (conservative floor; actual cost
// depends on chain gas price — most L2s need < 0.001, Telos needs ~16 TLOS)
const MIN_BALANCE = ethers.parseEther("0.0001");

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

// Dev wallet address used for all deployments
const DEV_WALLET = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

const ALCHEMY_SUPPORTED = new Set([
  "linea-mainnet", "mantle-mainnet", "unichain-mainnet",
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

// Native token symbols for display
const NATIVE_SYMBOLS: Record<string, string> = {
  filecoin: "FIL",
  telos: "TLOS",
  unichain: "ETH",
  boba: "ETH",
  linea: "ETH",
  hemi: "ETH",
  nibiru: "NIBI",
  redbelly: "RBNT",
  mantle: "MNT",
  gensyn: "ETH",
};

function getRpcUrl(slug: string): string {
  if (ALCHEMY_API_KEY && ALCHEMY_SUPPORTED.has(slug)) {
    return `https://${slug}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  }
  return PUBLIC_RPCS[slug] || "";
}

interface ChainTarget {
  name: string;
  chainId: number;
  alchemySlug: string;
}

const TARGET_CHAINS: ChainTarget[] = [
  { name: "filecoin",  chainId: 314,    alchemySlug: "filecoin-mainnet" },
  { name: "telos",     chainId: 40,     alchemySlug: "telos-mainnet" },
  { name: "unichain",  chainId: 130,    alchemySlug: "unichain-mainnet" },
  { name: "boba",      chainId: 288,    alchemySlug: "boba-mainnet" },
  { name: "linea",     chainId: 59144,  alchemySlug: "linea-mainnet" },
  { name: "hemi",      chainId: 43111,  alchemySlug: "hemi-mainnet" },
  { name: "nibiru",    chainId: 6900,   alchemySlug: "nibiru-mainnet" },
  { name: "redbelly",  chainId: 151,    alchemySlug: "redbelly-mainnet" },
  { name: "mantle",    chainId: 5000,   alchemySlug: "mantle-mainnet" },
  { name: "gensyn",    chainId: 685689, alchemySlug: "gensyn-mainnet" },
];

type TestStatus = "PASS" | "FAIL" | "SKIP" | "LOW_FUNDS" | "FORK_FAIL";

interface TestResult {
  name: string;
  status: TestStatus;
  address: string;
  matchesWorldchain: boolean;
  balance: string;
  error: string | null;
}

async function testChain(chain: ChainTarget, devAddress: string): Promise<TestResult> {
  const rpcUrl = getRpcUrl(chain.alchemySlug);
  const symbol = NATIVE_SYMBOLS[chain.name] || "???";

  if (!rpcUrl) {
    return { name: chain.name, status: "SKIP", address: "", matchesWorldchain: false, balance: "N/A", error: "No RPC URL" };
  }

  try {
    // Fork the chain
    console.log(`\n--- Forking ${chain.name} (chainId: ${chain.chainId}) ---`);
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: rpcUrl,
          blockNumber: undefined,
        },
      }],
    });

    // Check dev wallet balance (real on-chain balance, no funding)
    const balance = await ethers.provider.getBalance(devAddress);
    const balanceStr = `${formatEther(balance)} ${symbol}`;
    console.log(`  Dev wallet: ${devAddress}`);
    console.log(`  Balance:    ${balanceStr}`);

    // Check factory exists
    const factoryCode = await ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
    if (factoryCode === "0x" || factoryCode === "0x0") {
      return { name: chain.name, status: "FAIL", address: "", matchesWorldchain: false, balance: balanceStr, error: "Safe Singleton Factory not deployed" };
    }
    console.log(`  Factory:    confirmed`);

    // Predict address using the dev wallet as owner (matching real deploy flow)
    const OkuRouter = await ethers.getContractFactory("OkuRouter");
    const deployTx = await OkuRouter.getDeployTransaction(CONTRACT_NAME, CONTRACT_VERSION, devAddress);
    const initCode = deployTx.data;
    if (!initCode) throw new Error("Failed to generate init code");

    const initCodeHash = ethers.keccak256(initCode);
    const salt = getOkuRouterSalt();
    const predictedAddress = computeCreate2Address(SAFE_SINGLETON_FACTORY, salt, initCodeHash);
    const matches = predictedAddress.toLowerCase() === EXPECTED_ADDRESS.toLowerCase();
    console.log(`  Predicted:  ${predictedAddress} ${matches ? "== MATCHES worldchain" : "!= MISMATCH"}`);

    // Check if already deployed at predicted address
    const existingCode = await ethers.provider.getCode(predictedAddress);
    if (existingCode !== "0x") {
      console.log(`  Already deployed at predicted address (idempotent reuse)`);
      return { name: chain.name, status: "PASS", address: predictedAddress, matchesWorldchain: matches, balance: balanceStr, error: null };
    }

    // Check if funds are sufficient to actually deploy
    if (balance < MIN_BALANCE) {
      console.log(`  LOW FUNDS — need at least ${formatEther(MIN_BALANCE)} ${symbol} to deploy`);
      return { name: chain.name, status: "LOW_FUNDS", address: predictedAddress, matchesWorldchain: matches, balance: balanceStr, error: `Insufficient funds: ${balanceStr} (address prediction confirmed)` };
    }

    // Impersonate the dev wallet and deploy via CREATE2
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [devAddress],
    });
    const signer = await ethers.getSigner(devAddress);

    const deploymentData = ethers.concat([salt, initCode]);

    // Estimate gas and query the real chain's gas price so Hardhat's fork
    // doesn't inflate the upfront cost (fork defaults to ~1 gwei; most L2s
    // are 0.001 gwei, making the upfront reservation 1000x too high).
    let gasEstimate: bigint;
    try {
      gasEstimate = await ethers.provider.estimateGas({
        from: devAddress,
        to: SAFE_SINGLETON_FACTORY,
        data: deploymentData,
      });
      gasEstimate = gasEstimate * 120n / 100n; // 20% buffer
    } catch {
      gasEstimate = 5_000_000n; // fallback
    }

    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 1n;
    const estCost = gasEstimate * gasPrice;
    console.log(`  Deploying via CREATE2 (est gas: ${gasEstimate.toString()}, price: ${formatEther(gasPrice * 1000000000n)} gwei, cost: ${formatEther(estCost)})...`);

    if (balance < estCost) {
      console.log(`  LOW FUNDS for deploy — need ~${formatEther(estCost)} ${symbol}, have ${formatEther(balance)}`);
      return { name: chain.name, status: "LOW_FUNDS", address: predictedAddress, matchesWorldchain: matches, balance: balanceStr, error: `Need ~${formatEther(estCost)} ${symbol}, have ${balanceStr} (address prediction confirmed)` };
    }

    const tx = await signer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: deploymentData,
      gasLimit: gasEstimate,
      gasPrice: gasPrice,
    });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("Transaction receipt is null");

    // Verify code at predicted address
    const deployedCode = await ethers.provider.getCode(predictedAddress);
    if (deployedCode === "0x") {
      return { name: chain.name, status: "FAIL", address: predictedAddress, matchesWorldchain: false, balance: balanceStr, error: "No code at predicted address after deploy" };
    }

    // Verify the contract works
    const contract = OkuRouter__factory.connect(predictedAddress, signer);
    const name = await contract.name();
    const version = await contract.version();
    const owner = await contract.owner();
    console.log(`  Deployed:   ${name} v${version}`);
    console.log(`  Owner:      ${owner}`);
    console.log(`  Gas used:   ${receipt.gasUsed.toString()}`);

    // Stop impersonating
    await hre.network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [devAddress],
    });

    return { name: chain.name, status: "PASS", address: predictedAddress, matchesWorldchain: matches, balance: balanceStr, error: null };
  } catch (err: any) {
    const msg = err.message?.slice(0, 200) || "Unknown error";
    console.log(`  ERROR: ${msg}`);
    return { name: chain.name, status: "FORK_FAIL", address: "", matchesWorldchain: false, balance: "N/A", error: msg };
  }
}

async function main() {
  const devAddress = DEV_WALLET;

  console.log("=".repeat(80));
  console.log("Fork Deploy Test — Impersonating Dev Wallet");
  console.log("=".repeat(80));
  console.log(`Contract:     ${CONTRACT_NAME} v${CONTRACT_VERSION}`);
  console.log(`Dev wallet:   ${devAddress}`);
  console.log(`Expected addr: ${EXPECTED_ADDRESS}`);
  console.log("=".repeat(80));

  const results: TestResult[] = [];
  for (const chain of TARGET_CHAINS) {
    const result = await testChain(chain, devAddress);
    results.push(result);
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("RESULTS");
  console.log("=".repeat(80));
  console.log(
    "Chain".padEnd(12) +
    "Status".padEnd(12) +
    "Balance".padEnd(24) +
    "Address".padEnd(46) +
    "Match"
  );
  console.log("-".repeat(80));

  for (const r of results) {
    const matchStr = r.status === "PASS" ? (r.matchesWorldchain ? "YES" : "NO") : "-";
    console.log(
      r.name.padEnd(12) +
      r.status.padEnd(12) +
      r.balance.padEnd(24) +
      (r.address || "(none)").padEnd(46) +
      matchStr
    );
    if (r.error && !["PASS"].includes(r.status)) {
      console.log(`  -> ${r.error}`);
    }
  }

  const passed = results.filter(r => r.status === "PASS");
  const lowFunds = results.filter(r => r.status === "LOW_FUNDS");
  const forkFails = results.filter(r => r.status === "FORK_FAIL");
  const fails = results.filter(r => r.status === "FAIL");
  const matching = results.filter(r => r.matchesWorldchain);

  console.log(`\n${passed.length} PASS, ${lowFunds.length} LOW_FUNDS, ${forkFails.length} FORK_FAIL, ${fails.length} FAIL`);
  console.log(`${matching.length}/${passed.length} matching worldchain address (${EXPECTED_ADDRESS})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
