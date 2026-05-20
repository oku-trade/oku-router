import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Permit2Proxy__factory } from "../typechain-types";
import { getNetworkConfig } from "../util/networkConfig";
import {
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  computeCreate2Address,
  getPermit2ProxySalt,
} from "../util/contractMeta";
import {
  getLatestEntry,
  recordDeployment,
} from "../util/deploymentsRegistry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the predicted Permit2Proxy address for a given OkuRouter address.
 *
 * Salt = keccak256("Permit2Proxy+<okuRouter address>"). This binds the
 * proxy's deterministic address to the router it forwards to, so a stale
 * proxy can never collide with a new one even if both are deployed.
 */
async function predictPermit2ProxyAddress(
  hre: HardhatRuntimeEnvironment,
  okuRouterAddress: string,
): Promise<{ address: string; initCode: string; salt: string }> {
  const Proxy = await hre.ethers.getContractFactory("Permit2Proxy");
  const deployTx = await Proxy.getDeployTransaction(okuRouterAddress);
  const initCode = deployTx.data;
  if (!initCode) {
    throw new Error("Failed to generate init code for Permit2Proxy");
  }
  const initCodeHash = hre.ethers.keccak256(initCode);
  const salt = getPermit2ProxySalt(okuRouterAddress);
  const address = computeCreate2Address(SAFE_SINGLETON_FACTORY, salt, initCodeHash);
  return { address, initCode, salt };
}

task("deploy-permit2-proxy", "Deploy Permit2Proxy contract (deterministic, CREATE2)")
  .setAction(async (_taskArgs, hre) => {
    const networkName = hre.network.name;

    if (networkName === "hardhat" || networkName === "localhost") {
      throw new Error("Use a live network (e.g. --network worldchain)");
    }

    const [signer] = await hre.ethers.getSigners();
    const signerAddress = await signer.getAddress();
    console.log(`\nDeploying Permit2Proxy to ${networkName} as ${signerAddress}`);

    // The proxy is bonded by bytecode to a specific OkuRouter address.
    // We pull that address from the registry (via networkConfig) and
    // refuse to deploy if it's missing or not on the current version --
    // otherwise we'd be wiring a brand-new proxy to a deprecated router.
    const config = getNetworkConfig(networkName);
    const okuRouterAddress = config.rainbowRouterAddress;
    if (!okuRouterAddress) {
      throw new Error(
        `No OkuRouter address configured for network: ${networkName}. Deploy OkuRouter first.`,
      );
    }

    const routerEntry = getLatestEntry(networkName, "OkuRouter");
    if (!routerEntry) {
      throw new Error(
        `No OkuRouter history entry in deployments/${networkName}.json. Deploy OkuRouter first.`,
      );
    }
    if (routerEntry.version !== CONTRACT_VERSION) {
      throw new Error(
        `Refusing to bond Permit2Proxy to OkuRouter v${routerEntry.version}; current version is v${CONTRACT_VERSION}. ` +
          `Redeploy OkuRouter at v${CONTRACT_VERSION} first (or update CONTRACT_VERSION).`,
      );
    }
    if (routerEntry.deprecated) {
      throw new Error(
        `Latest OkuRouter entry on ${networkName} is marked deprecated. ` +
          `Redeploy OkuRouter at v${CONTRACT_VERSION} before deploying a new Permit2Proxy.`,
      );
    }

    console.log(`Bonding to OkuRouter v${CONTRACT_VERSION}: ${okuRouterAddress}`);

    // Predict the deterministic address up front so the operator can
    // sanity-check it before we send the deploy tx.
    const { address: predictedAddress, initCode, salt } = await predictPermit2ProxyAddress(
      hre,
      okuRouterAddress,
    );
    console.log(`Predicted Permit2Proxy address: ${predictedAddress}`);

    // Idempotency: if code already lives at the predicted address, treat
    // the deploy as a no-op success. This matters for re-running the
    // task after a partial failure (e.g. verification timed out).
    const existingCode = await hre.ethers.provider.getCode(predictedAddress);
    let contractAddress = predictedAddress;
    let blockNumber: number | null = null;
    let txHash: string | null = null;
    let reused = false;

    if (existingCode !== "0x") {
      console.log("✓ Permit2Proxy already deployed at predicted address; skipping CREATE2 tx.");
      reused = true;
    } else {
      const factoryCode = await hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
      if (factoryCode === "0x") {
        throw new Error(
          `Safe Singleton Factory not deployed on this chain at ${SAFE_SINGLETON_FACTORY}. ` +
            `Permit2Proxy requires CREATE2 for deterministic addresses; deploy the factory first.`,
        );
      }

      // Factory calldata: `salt ++ initCode`.
      const deploymentData = hre.ethers.concat([salt, initCode]);
      const tx = await signer.sendTransaction({
        to: SAFE_SINGLETON_FACTORY,
        data: deploymentData,
        gasLimit: 5_000_000,
      });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error("Transaction receipt is null");
      }

      const deployedCode = await hre.ethers.provider.getCode(predictedAddress);
      if (deployedCode === "0x") {
        throw new Error("Deployment failed - no code at expected address");
      }

      blockNumber = receipt.blockNumber ?? null;
      txHash = tx.hash;
      console.log("✓ Permit2Proxy deployed to:", contractAddress);
    }

    // Auto-log to the registry before verification, so the address is
    // captured even if explorer verification fails.
    if (!reused) {
      try {
        const chainIdBig = (await hre.ethers.provider.getNetwork()).chainId;
        recordDeployment(networkName, Number(chainIdBig), {
          contract: "Permit2Proxy",
          address: contractAddress,
          deploymentBlock: blockNumber,
          txHash,
          deployer: signerAddress,
          deployedAt: new Date().toISOString(),
          okuRouter: okuRouterAddress,
          notes: `Deterministic deploy bonded to OkuRouter v${CONTRACT_VERSION}.`,
        });
        console.log(`✓ Logged deployment to deployments/${networkName}.json`);
      } catch (err: any) {
        console.warn(`⚠ Failed to write deployments/${networkName}.json:`, err.message);
      }
    }

    console.log("\nWaiting 5s before verification...");
    await sleep(5000);

    console.log("Verifying contract on block explorer...");
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [okuRouterAddress],
      });
    } catch (err: any) {
      // Verification is best-effort; the deployment is already recorded.
      console.warn(`⚠ Verification failed (manual retry needed): ${err.message}`);
    }

    // Silence the import-not-used warning while keeping the factory
    // import available for future enhancements (e.g. proxy-side admin txs).
    void Permit2Proxy__factory;

    console.log("\nDeployment complete!");
  });
