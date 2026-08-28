import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Permit2Proxy__factory } from "../typechain-types";
import { getNetworkConfig } from "../util/deploymentConfig";
import {
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  computeCreate2Address,
  getPermit2ProxySalt,
} from "../util/contractMeta";
import {
  getCurrentEntry,
  recordDeployment,
} from "../util/deploymentsRegistry";
import { sleep, withRetry } from "../util/rpcRetry";

/**
 * Compute the predicted Permit2Proxy address for a given OkuRouter address.
 *
 * Salt = keccak256("Permit2Proxy+<okuRouter address>"). This binds the
 * proxy's deterministic address to the router it forwards to, so a stale
 * proxy can never collide with a new one even if both are deployed.
 *
 * NOTE: deterministic deployment is *opt-in* (--deterministic). The
 * default path is a plain nonce-based deploy because today's Permit2Proxy
 * is only deployed on World Chain — there is no cross-chain parity to
 * preserve, and CREATE2 buys us nothing on a single chain. Leaving the
 * CREATE2 path in for future use only.
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

task("deploy-permit2-proxy", "Deploy Permit2Proxy contract")
  .addFlag(
    "deterministic",
    "Deploy via CREATE2 (Safe Singleton Factory). Default is a plain nonce-based deploy, which is appropriate for chains where we do not need cross-chain address parity (e.g. World Chain only).",
  )
  .setAction(async (taskArgs, hre) => {
    const networkName = hre.network.name;
    const deterministic: boolean = !!taskArgs.deterministic;

    if (networkName === "hardhat" || networkName === "localhost") {
      throw new Error("Use a live network (e.g. --network worldchain)");
    }

    const [signer] = await hre.ethers.getSigners();
    const signerAddress = await signer.getAddress();
    console.log(
      `\nDeploying Permit2Proxy to ${networkName} as ${signerAddress} ` +
        `[${deterministic ? "CREATE2 / deterministic" : "nonce-based / non-deterministic"}]`,
    );

    // The proxy is hard-bound by constructor arg to a specific OkuRouter
    // address. Pull that directly from the on-disk registry (the source of
    // truth for live addresses) and refuse to deploy if it's missing or
    // pinned to a stale version -- otherwise we'd be wiring a brand-new
    // proxy to a stale router.
    //
    // We also keep a getNetworkConfig() call here so the task fails loudly
    // if someone tries to deploy to a chain we have no init parameters for.
    getNetworkConfig(networkName);
    const routerEntry = getCurrentEntry(networkName, "OkuRouter");
    if (!routerEntry) {
      throw new Error(
        `No OkuRouter address configured for network: ${networkName} ` +
          `(deployments/${networkName}.json has no current.OkuRouter entry). ` +
          `Deploy OkuRouter first.`,
      );
    }
    const okuRouterAddress = routerEntry.address;
    if (routerEntry.version !== CONTRACT_VERSION) {
      throw new Error(
        `Refusing to bond Permit2Proxy to OkuRouter v${routerEntry.version}; current version is v${CONTRACT_VERSION}. ` +
          `Redeploy OkuRouter at v${CONTRACT_VERSION} first (or update CONTRACT_VERSION).`,
      );
    }

    console.log(`Bonding to OkuRouter v${CONTRACT_VERSION}: ${okuRouterAddress}`);

    let contractAddress: string;
    let blockNumber: number | null = null;
    let txHash: string | null = null;
    let reused = false;

    if (deterministic) {
      // CREATE2 deploy path -- preserves cross-chain address parity, at
      // the cost of requiring the Safe Singleton Factory at the canonical
      // address on this chain.
      const { address: predictedAddress, initCode, salt } =
        await predictPermit2ProxyAddress(hre, okuRouterAddress);
      console.log(`Predicted Permit2Proxy address: ${predictedAddress}`);

      const existingCode = await withRetry(
        () => hre.ethers.provider.getCode(predictedAddress),
        `getCode(${predictedAddress})`,
      );
      contractAddress = predictedAddress;

      if (existingCode !== "0x") {
        console.log("✓ Permit2Proxy already deployed at predicted address; skipping CREATE2 tx.");
        reused = true;
      } else {
        const factoryCode = await withRetry(
          () => hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY),
          `getCode(${SAFE_SINGLETON_FACTORY})`,
        );
        if (factoryCode === "0x") {
          throw new Error(
            `Safe Singleton Factory not deployed on this chain at ${SAFE_SINGLETON_FACTORY}. ` +
              `Permit2Proxy --deterministic requires CREATE2; deploy the factory first or omit --deterministic.`,
          );
        }

        const deploymentData = hre.ethers.concat([salt, initCode]);
        // Retry submission and wait separately. See util/rpcRetry.ts.
        const tx = await withRetry(
          () =>
            signer.sendTransaction({
              to: SAFE_SINGLETON_FACTORY,
              data: deploymentData,
              gasLimit: 5_000_000,
            }),
          "sendTransaction(CREATE2 Permit2Proxy)",
        );
        const receipt = await withRetry(
          () => tx.wait(),
          `tx.wait(${tx.hash})`,
        );
        if (!receipt) {
          throw new Error("Transaction receipt is null");
        }

        const deployedCode = await withRetry(
          () => hre.ethers.provider.getCode(predictedAddress),
          `getCode(${predictedAddress}) post-deploy`,
        );
        if (deployedCode === "0x") {
          throw new Error("CREATE2 deployment failed — no code at expected address");
        }

        blockNumber = receipt.blockNumber ?? null;
        txHash = tx.hash;
        console.log("✓ Permit2Proxy deployed to:", contractAddress);
      }
    } else {
      // Default: plain nonce-based deploy. Address is non-deterministic
      // across chains; that's intentional for chains where the proxy
      // only needs to exist locally (e.g. World Chain).
      console.log("Deploying via plain nonce-based CREATE (no CREATE2)...");
      const contract = await withRetry(
        () =>
          new Permit2Proxy__factory(signer).deploy(okuRouterAddress, {
            gasLimit: 3_000_000,
          }),
        "deploy(Permit2Proxy)",
      );
      const deployTx = contract.deploymentTransaction();
      await withRetry(() => contract.waitForDeployment(), "waitForDeployment(Permit2Proxy)");
      contractAddress = await contract.getAddress();
      if (deployTx) {
        const receipt = await withRetry(
          () => deployTx.wait(),
          `tx.wait(${deployTx.hash})`,
        );
        blockNumber = receipt?.blockNumber ?? null;
        txHash = deployTx.hash;
      }
      console.log("✓ Permit2Proxy deployed to:", contractAddress);
    }

    // Auto-log to the registry before verification so the address is
    // captured even if explorer verification fails.
    //
    // Permit2Proxy is not Ownable, so we do NOT record an `owner` field --
    // the registry validator will reject it if we try. The bonded
    // `okuRouter` address is the only metadata that matters for this
    // contract (the version is implied by the router it points at).
    if (!reused) {
      try {
        const chainIdBig = (await hre.ethers.provider.getNetwork()).chainId;
        recordDeployment(networkName, Number(chainIdBig), "Permit2Proxy", {
          address: contractAddress,
          okuRouter: okuRouterAddress,
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
    // import available for future enhancements.
    void Permit2Proxy__factory;

    console.log("\nDeployment complete!");
  });
