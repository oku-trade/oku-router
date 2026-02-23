import { task } from "hardhat/config";
import { Permit2Proxy__factory } from "../typechain-types";
import { getNetworkConfig } from "../util/networkConfig";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

task("deploy-permit2-proxy", "Deploy Permit2Proxy contract")
  .setAction(async (_taskArgs, hre) => {
    const networkName = hre.network.name;

    if (networkName === "hardhat" || networkName === "localhost") {
      throw new Error("Use a live network (e.g. --network worldchain)");
    }

    const [signer] = await hre.ethers.getSigners();
    const signerAddress = await signer.getAddress();
    console.log(`\nDeploying Permit2Proxy to ${networkName} as ${signerAddress}`);

    // Look up OkuRouter address from networkConfig
    const config = getNetworkConfig(networkName);
    const okuRouterAddress = config.rainbowRouterAddress;

    if (!okuRouterAddress) {
      throw new Error(`No OkuRouter address configured for network: ${networkName}`);
    }

    console.log(`OkuRouter address: ${okuRouterAddress}`);

    // Deploy Permit2Proxy
    const contract = await new Permit2Proxy__factory()
      .connect(signer)
      .deploy(okuRouterAddress, { gasLimit: 5000000 });

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();
    console.log("Deployed to:", contractAddress);

    // Verify on block explorer
    console.log("\nWaiting 5s before verification...");
    await sleep(5000);

    console.log("Verifying contract on block explorer...");
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [okuRouterAddress],
    });

    console.log("\nDeployment complete!");
  });
