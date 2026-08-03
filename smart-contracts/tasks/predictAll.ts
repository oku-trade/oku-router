/**
 * Predict the deterministic OkuRouter address on every supported chain.
 *
 * Pure CREATE2 math -- no RPC calls, no signer needed. Use this as a
 * pre-flight check before kicking off a multi-chain redeploy to confirm
 * that the new version yields the same address on every chain (it
 * should, given identical name+version+owner constructor args).
 *
 * Usage:
 *   npx hardhat predict-all
 *   npx hardhat predict-all --owner 0x<addr>
 */
import { task } from "hardhat/config";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  computeCreate2Address,
  getOkuRouterSalt,
} from "../util/contractMeta";
import { NETWORK_CONFIGS, getSupportedNetworks } from "../util/deploymentConfig";

task("predict-all", "Predict deterministic OkuRouter address for all chains")
  .addOptionalParam(
    "owner",
    "Owner address passed to the OkuRouter constructor (defaults to a placeholder)",
  )
  .setAction(async (taskArgs, hre) => {
    // OkuRouter init code depends on the owner constructor arg. For a
    // realistic prediction the operator should pass --owner with the
    // actual deployer EOA they'll use across chains. Without it we use a
    // recognizable placeholder so the output is clearly hypothetical.
    const owner =
      taskArgs.owner ??
      "0x0000000000000000000000000000000000000001"; // sentinel
    console.log(`\nPredicting OkuRouter v${CONTRACT_VERSION} addresses`);
    console.log(`Owner (constructor arg): ${owner}`);
    console.log(`Salt: ${getOkuRouterSalt()}`);
    console.log("");

    const OkuRouter = await hre.ethers.getContractFactory("OkuRouter");
    const deployTx = await OkuRouter.getDeployTransaction(
      CONTRACT_NAME,
      CONTRACT_VERSION,
      owner,
    );
    if (!deployTx.data) throw new Error("Failed to generate init code");
    const initCodeHash = hre.ethers.keccak256(deployTx.data);
    const salt = getOkuRouterSalt();
    const predicted = computeCreate2Address(SAFE_SINGLETON_FACTORY, salt, initCodeHash);

    // A single prediction would suffice (the address is identical on
    // every chain that uses the Safe Singleton Factory at the canonical
    // address), but we still iterate so the operator gets per-chain
    // visibility into where the factory is or isn't available.
    const networks = getSupportedNetworks();
    const widest = Math.max(...networks.map((n) => n.length));

    console.log(`Predicted address: ${predicted}`);
    console.log("");
    console.log(
      `${"network".padEnd(widest)}  chainId   factoryAvail  predictedAddress`,
    );
    console.log(
      `${"-".repeat(widest)}  -------   ------------  ${"-".repeat(42)}`,
    );
    for (const name of networks) {
      const cfg = NETWORK_CONFIGS[name];
      const factoryAvail = !!cfg.create2FactoryAddress;
      console.log(
        `${name.padEnd(widest)}  ${String(cfg.chainId).padEnd(7)}   ${
          factoryAvail ? "✅" : "❌"
        }            ${predicted}`,
      );
    }

    console.log("");
    console.log(
      "Note: chains marked ❌ do not have the Safe Singleton Factory at the canonical address. " +
        "Deterministic deployment will fail on those chains until the factory is deployed.",
    );
  });
