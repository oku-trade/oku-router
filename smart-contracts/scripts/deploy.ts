
import { Signer, Contract } from "ethers";
import { OkuRouter__factory } from "../typechain-types"
import hre, { network } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { getNetworkConfig } from "../util/networkConfig";

const { ethers } = require("hardhat");

// Parse CLI args for --deterministic flag
const args = process.argv.slice(2);
const deterministicMode = args.includes('--deterministic');

// Safe Singleton Factory - canonical address on all major EVM chains
// https://github.com/safe-global/safe-singleton-factory
const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";

const name = "Oku Router"
const version = "1.0"


const userAddr = "0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89"
const gfxOwner = "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5"

/**
 * Generate a version-based salt for deterministic deployment
 * This ensures the same address across all chains for a given version
 */
function getVersionSalt(ver: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`oku-router-${ver}`));
}

/**
 * Compute the deterministic address without deploying
 */
async function computeDeterministicAddress(
  contractName: string,
  ver: string,
  initCodeHash: string
): Promise<string> {
  const salt = getVersionSalt(ver);

  // CREATE2 address formula: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  const packed = ethers.solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", SAFE_SINGLETON_FACTORY, salt, initCodeHash]
  );
  const hash = ethers.keccak256(packed);
  return ethers.getAddress("0x" + hash.slice(-40));
}

/**
 * Deploy contract deterministically using Safe Singleton Factory (CREATE2)
 */
async function deployDeterministic(
  signer: Signer,
  contractName: string,
  ver: string
): Promise<string> {
  const salt = getVersionSalt(ver);

  // Get init code (deployment bytecode + constructor args)
  const OkuRouter = await ethers.getContractFactory("OkuRouter");
  const deployTx = await OkuRouter.getDeployTransaction(contractName, ver);
  const initCode = deployTx.data;

  if (!initCode) {
    throw new Error("Failed to generate init code");
  }

  // Compute expected address
  const initCodeHash = ethers.keccak256(initCode);
  const expectedAddress = await computeDeterministicAddress(contractName, ver, initCodeHash);

  console.log("Expected deterministic address:", expectedAddress);
  console.log("Salt:", salt);
  console.log("Init code hash:", initCodeHash);

  // Check if already deployed
  const existingCode = await ethers.provider.getCode(expectedAddress);
  if (existingCode !== "0x") {
    console.log("Contract already deployed at deterministic address:", expectedAddress);
    return expectedAddress;
  }

  // Check if Safe Singleton Factory exists on this chain
  const factoryCode = await ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
  if (factoryCode === "0x") {
    throw new Error(
      `Safe Singleton Factory not deployed on this chain at ${SAFE_SINGLETON_FACTORY}. ` +
      `Please deploy the factory first or use non-deterministic deployment.`
    );
  }

  // Deploy via CREATE2
  const factory = new Contract(
    SAFE_SINGLETON_FACTORY,
    [
      "function deploy(bytes memory _initCode, bytes32 _salt) public returns (address payable)"
    ],
    signer
  );

  console.log("Deploying via Safe Singleton Factory (CREATE2)...");
  const tx = await factory.deploy(initCode, salt, { gasLimit: 5000000 });
  await tx.wait();

  // Verify deployment
  const deployedCode = await ethers.provider.getCode(expectedAddress);
  if (deployedCode === "0x") {
    throw new Error("Deployment failed - no code at expected address");
  }

  console.log("Successfully deployed at:", expectedAddress);
  return expectedAddress;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function main() {

  console.log("STARTING")
  console.log("Deterministic mode:", deterministicMode ? "ENABLED" : "DISABLED (default)")
  let networkName = hre.network.name
  let testNetwork = 'taiko'
  let mainnet = true
  let signer: Signer

  if (networkName == "hardhat" || networkName == "localhost") {
    //testing
    mainnet = false

    //reset
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.TAIKO_URL!
          },
        },
      ],
    });
    const blockNumber = await ethers.provider.getBlockNumber()
    console.log("Reset to block:", blockNumber)
    networkName = testNetwork

    // Impersonate first, then get signer
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [userAddr],
    });

    signer = await ethers.getSigner(userAddr)

    // Debug: check balance right after getting signer
    console.log("Account:", userAddr)
    const balance = await ethers.provider.getBalance(userAddr)
    console.log("Balance at fork:", ethers.formatEther(balance))

    // If balance is insufficient for testing, top up (local fork only)
    if (balance < ethers.parseEther("0.01")) {
      console.log("Insufficient balance for deployment test, topping up...")
      await setBalance(userAddr, ethers.parseEther("1"))
      console.log("New balance:", ethers.formatEther(await ethers.provider.getBalance(userAddr)))
    }

  } else {
    [signer] = await ethers.getSigners()

    console.log("DEPLOYING TO LIVE NETWORK: ", networkName, " as ", await signer.getAddress())
  }


  let contractAddress: string;
  let contract;

  try {
    console.log("Deploying contract...")
    console.log("Signer balance:", ethers.formatEther(await ethers.provider.getBalance(await signer.getAddress())), "ETH")

    if (deterministicMode) {
      // Deterministic deployment via CREATE2 (Safe Singleton Factory)
      console.log("\n=== DETERMINISTIC DEPLOYMENT ===")
      contractAddress = await deployDeterministic(signer, name, version);
      contract = OkuRouter__factory.connect(contractAddress, signer);
    } else {
      // Standard deployment (default for testing)
      console.log("\n=== STANDARD DEPLOYMENT ===")
      contract = await new OkuRouter__factory().connect(signer).deploy(name, version, {
        gasLimit: 5000000
      })
      await contract.waitForDeployment()
      contractAddress = await contract.getAddress()
    }
  } catch (error: any) {
    console.error("Deployment failed:", error.message)
    if (error.data) {
      console.error("Error data:", error.data)
    }
    if (error.error) {
      console.error("Inner error:", error.error)
    }
    throw error
  }

  if (mainnet) {
    await sleep(5000)
  }
  console.log("DEPLOYED: ", contractAddress)


  // Get network config for swap targets
  let config;
  try {
    config = getNetworkConfig(networkName);
  } catch (e) {
    console.log(`No network config found for ${networkName}, skipping swap target registration`)
  }

  // Register swap targets from config
  if (config && config.knownSwapTargets.length > 0) {
    const targets = config.knownSwapTargets;
    console.log(`\nRegistering ${targets.length} swap targets for ${config.chainName}...`)
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      console.log(`  Adding ${i + 1}/${targets.length}: ${target.name} (${target.protocol}) - ${target.address}`)
      const updateTx = await contract.updateSwapTargets(target.address, true, {
        gasLimit: 100000
      })
      await updateTx.wait()

      // Add delay between transactions to avoid overloading RPC (only for mainnet)
      if (mainnet && i < targets.length - 1) {
        await sleep(2000)
      }
    }
    console.log("All swap targets registered successfully")
  } else {
    console.log(`No swap targets configured for ${networkName}`)
  }

  // Approve zero address as valid signer
  console.log("Approving zero address as valid signer...")
  const zeroAddress = ethers.ZeroAddress
  const validSignerTx = await contract.updateValidSigner(zeroAddress, true, {
    gasLimit: 5000000
  })
  await validSignerTx.wait()
  console.log("Zero address approved as valid signer")


  //console.log("Transferring ownership to ", gfxOwner)
  //await contract.transferOwnership(gfxOwner)

  if (mainnet) {
    console.log("Verifying: ", await contract.getAddress())
    await hre.run("verify:verify", {
      address: await contract.getAddress(),
      constructorArguments: [name, version]
    })
  }

}

main().catch(console.error);

//hh verify --network op 0x003CCe004267597A3FFDA5C1945DA0C2C9276c96 "Oku Router" "1.0"