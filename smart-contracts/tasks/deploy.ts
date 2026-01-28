import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Signer, Contract } from "ethers";
import { OkuRouter__factory } from "../typechain-types"
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { getNetworkConfig } from "../util/networkConfig";

// Safe Singleton Factory - canonical address on all major EVM chains
// https://github.com/safe-global/safe-singleton-factory
const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";

const name = "Oku Router"
const version = "1.0"

const userAddr = "0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89"
const gfxOwner = "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5"

/**
 * Generate a salt for deterministic deployment using name and version
 * This ensures the same address across all chains for a given name+version
 */
function getVersionSalt(hre: HardhatRuntimeEnvironment, contractName: string, ver: string): string {
  const saltString = `${contractName}+${ver}`;
  console.log("Salt string:", saltString);
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(saltString));
}

/**
 * Compute the deterministic address without deploying
 */
async function computeDeterministicAddress(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  ver: string,
  initCodeHash: string
): Promise<string> {
  const salt = getVersionSalt(hre, contractName, ver);

  // CREATE2 address formula: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  const packed = hre.ethers.solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", SAFE_SINGLETON_FACTORY, salt, initCodeHash]
  );
  const hash = hre.ethers.keccak256(packed);
  return hre.ethers.getAddress("0x" + hash.slice(-40));
}

/**
 * Deploy contract deterministically using Safe Singleton Factory (CREATE2)
 */
async function deployDeterministic(
  hre: HardhatRuntimeEnvironment,
  signer: Signer,
  contractName: string,
  ver: string,
  owner: string
): Promise<string> {
  const salt = getVersionSalt(hre, contractName, ver);

  // Get init code (deployment bytecode + constructor args)
  const OkuRouter = await hre.ethers.getContractFactory("OkuRouter");
  const deployTx = await OkuRouter.getDeployTransaction(contractName, ver, owner);
  const initCode = deployTx.data;

  if (!initCode) {
    throw new Error("Failed to generate init code");
  }

  // Compute expected address
  const initCodeHash = hre.ethers.keccak256(initCode);
  const expectedAddress = await computeDeterministicAddress(hre, contractName, ver, initCodeHash);

  // Check if already deployed
  const existingCode = await hre.ethers.provider.getCode(expectedAddress);
  if (existingCode !== "0x") {
    console.log("✓ Contract already deployed at:", expectedAddress);
    return expectedAddress;
  }

  // Check if Safe Singleton Factory exists on this chain
  const factoryCode = await hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
  if (factoryCode === "0x") {
    throw new Error(
      `Safe Singleton Factory not deployed on this chain at ${SAFE_SINGLETON_FACTORY}. ` +
      `Please deploy the factory first or use non-deterministic deployment.`
    );
  }

  // Deploy via CREATE2
  const deploymentData = hre.ethers.concat([salt, initCode]);

  console.log("Deploying via Safe Singleton Factory (CREATE2)...");
  const tx = await signer.sendTransaction({
    to: SAFE_SINGLETON_FACTORY,
    data: deploymentData,
    gasLimit: 5000000
  });

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Transaction receipt is null");
  }

  // Verify deployment
  const deployedCode = await hre.ethers.provider.getCode(expectedAddress);
  if (deployedCode === "0x") {
    throw new Error("Deployment failed - no code at expected address");
  }

  console.log("✓ Deployed to:", expectedAddress);
  return expectedAddress;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

task("deploy", "Deploy OkuRouter contract")
  .addFlag("deterministic", "Use deterministic deployment via CREATE2")
  .setAction(async (taskArgs, hre) => {
    const deterministicMode = taskArgs.deterministic;

    let networkName = hre.network.name
    let testNetwork = 'worldchain'
    let mainnet = true
    let signer: Signer

    if (networkName == "hardhat" || networkName == "localhost") {
      //testing
      mainnet = false

      // IMPORTANT: Deterministic CREATE2 deployment via Safe Singleton Factory
      // does not work reliably on Hardhat forks due to known issues with
      // CREATE2 handling. For local testing, use standard deployment.
      // Deterministic mode only works on live networks.
      if (deterministicMode) {
        throw new Error(
          "Deterministic deployment (--deterministic flag) is not supported on Hardhat forks.\n" +
          "This is due to known limitations with CREATE2 on forked networks.\n" +
          "Please remove the --deterministic flag for local testing, or deploy to a live network."
        );
      }

      //reset - fork worldchain but keep chainId as 10 (Optimism) for hardfork compatibility
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.WORLDCHAIN_URL!,
              blockNumber: undefined // Use latest block
            },
            chainId: 10, // Keep as Optimism chainId for EVM hardfork compatibility
          },
        ],
      });
      networkName = testNetwork

      // Impersonate first, then get signer
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [userAddr],
      });

      signer = await hre.ethers.getSigner(userAddr)

      const balance = await hre.ethers.provider.getBalance(userAddr)
      // If balance is insufficient for testing, top up (local fork only)
      if (balance < hre.ethers.parseEther("0.01")) {
        await setBalance(userAddr, hre.ethers.parseEther("1"))
      }

    } else {
      [signer] = await hre.ethers.getSigners()
      console.log(`\nDeploying to ${networkName} as ${await signer.getAddress()}`)
    }


    let contractAddress: string;
    let contract;
    const ownerAddress = await signer.getAddress();

    try {
      if (deterministicMode) {
        // Deterministic deployment via CREATE2 (Safe Singleton Factory)
        contractAddress = await deployDeterministic(hre, signer, name, version, ownerAddress);
        contract = OkuRouter__factory.connect(contractAddress, signer);
      } else {
        // Standard deployment
        contract = await new OkuRouter__factory().connect(signer).deploy(name, version, ownerAddress, {
          gasLimit: 5000000
        })
        await contract.waitForDeployment()
        contractAddress = await contract.getAddress()
        console.log("✓ Deployed to:", contractAddress)
      }
    } catch (error: any) {
      console.error("✗ Deployment failed:", error.message)
      throw error
    }

    if (mainnet) {
      await sleep(5000)
    }

    // Get network config for swap targets
    let config;
    try {
      config = getNetworkConfig(networkName);
    } catch (e) {
      // No config found, skip
    }

    // Register swap targets from config (only add missing ones)
    if (config && config.knownSwapTargets.length > 0) {
      const targets = config.knownSwapTargets;

      // Check which targets are already registered
      const targetsToAdd = [];
      for (const target of targets) {
        const isRegistered = await contract.swapTargets(target.address);
        if (!isRegistered) {
          targetsToAdd.push(target);
        }
      }

      if (targetsToAdd.length > 0) {
        console.log(`\nRegistering ${targetsToAdd.length} new swap targets:`)
        for (let i = 0; i < targetsToAdd.length; i++) {
          const target = targetsToAdd[i];
          console.log(`  ✓ ${target.name} (${target.protocol}): ${target.address}`)
          const updateTx = await contract.updateSwapTargets(target.address, true, {
            gasLimit: 100000
          })
          await updateTx.wait()

          // Add delay between transactions to avoid overloading RPC (only for mainnet)
          if (mainnet && i < targetsToAdd.length - 1) {
            await sleep(2000)
          }
        }
      } else {
        console.log(`\n✓ All ${targets.length} swap targets already registered`)
      }
    }

    // Approve zero address as valid signer (only if not already set)
    const zeroAddress = hre.ethers.ZeroAddress
    const isZeroAddressSigner = await contract.validSigners(zeroAddress);
    if (!isZeroAddressSigner) {
      const validSignerTx = await contract.updateValidSigner(zeroAddress, true, {
        gasLimit: 5000000
      })
      await validSignerTx.wait()
      console.log("✓ Zero address approved as valid signer")
    } else {
      console.log("✓ Zero address already approved as valid signer")
    }


    //console.log("Transferring ownership to ", gfxOwner)
    //await contract.transferOwnership(gfxOwner)

    if (mainnet) {
      console.log("\nVerifying contract on block explorer...")
      await hre.run("verify:verify", {
        address: await contract.getAddress(),
        constructorArguments: [name, version, ownerAddress]
      })
    }

    console.log("\n✓ Deployment complete!")
  });
