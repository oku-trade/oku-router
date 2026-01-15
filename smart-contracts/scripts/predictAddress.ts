/**
 * Utility script to predict deterministic deployment addresses
 * without actually deploying the contract.
 *
 * Usage:
 *   npx hardhat run scripts/predictAddress.ts
 *   npx hardhat run scripts/predictAddress.ts --network op
 */

import hre from "hardhat";

const { ethers } = require("hardhat");

// Safe Singleton Factory - canonical address on all major EVM chains
const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";

const name = "Oku Router";
const version = "1.0";

/**
 * Generate a version-based salt for deterministic deployment
 */
function getVersionSalt(ver: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`oku-router-${ver}`));
}

/**
 * Compute the deterministic address
 */
function computeCreate2Address(
  factoryAddress: string,
  salt: string,
  initCodeHash: string
): string {
  // CREATE2 address formula: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  const packed = ethers.solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", factoryAddress, salt, initCodeHash]
  );
  const hash = ethers.keccak256(packed);
  return ethers.getAddress("0x" + hash.slice(-40));
}

async function main() {
  const networkName = hre.network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("\n=== Oku Router Address Prediction ===\n");
  console.log("Network:", networkName);
  console.log("Chain ID:", chainId.toString());
  console.log("Contract Name:", name);
  console.log("Contract Version:", version);
  console.log("");

  // Check if Safe Singleton Factory exists
  const factoryCode = await ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
  if (factoryCode === "0x") {
    console.log("⚠️  WARNING: Safe Singleton Factory NOT deployed on this chain");
    console.log(`   Factory address: ${SAFE_SINGLETON_FACTORY}`);
    console.log("   Deterministic deployment will fail on this network.");
    console.log("");
  } else {
    console.log("✅ Safe Singleton Factory found at:", SAFE_SINGLETON_FACTORY);
    console.log("");
  }

  // Get init code
  const OkuRouter = await ethers.getContractFactory("OkuRouter");
  const deployTx = await OkuRouter.getDeployTransaction(name, version);
  const initCode = deployTx.data;

  if (!initCode) {
    throw new Error("Failed to generate init code");
  }

  const salt = getVersionSalt(version);
  const initCodeHash = ethers.keccak256(initCode);
  const predictedAddress = computeCreate2Address(SAFE_SINGLETON_FACTORY, salt, initCodeHash);

  console.log("=== Deployment Parameters ===");
  console.log("Salt (version-based):", salt);
  console.log("Init code length:", initCode.length, "bytes");
  console.log("Init code hash:", initCodeHash);
  console.log("");

  console.log("=== Predicted Address ===");
  console.log("📍 ", predictedAddress);
  console.log("");

  // Check if already deployed
  const existingCode = await ethers.provider.getCode(predictedAddress);
  if (existingCode !== "0x") {
    console.log("✅ Contract ALREADY DEPLOYED at this address");
    console.log("   Code size:", (existingCode.length - 2) / 2, "bytes");
  } else {
    console.log("❌ Contract NOT YET deployed at this address");
  }

  console.log("\n=== Usage ===");
  console.log("To deploy with this deterministic address:");
  console.log(`  npx hardhat run scripts/deploy.ts --network ${networkName} --deterministic`);
  console.log("");
}

main().catch(console.error);
