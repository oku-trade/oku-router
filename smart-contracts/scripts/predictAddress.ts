/**
 * Predict the deterministic deployment address(es) for OkuRouter and/or
 * Permit2Proxy on the current Hardhat network without actually deploying.
 *
 * Usage:
 *   npx hardhat run scripts/predictAddress.ts --network op
 *
 * Notes:
 *   - The OkuRouter init code depends on (CONTRACT_NAME, CONTRACT_VERSION,
 *     ownerAddress). For cross-chain address parity, ownerAddress must be
 *     the same on every chain at deploy time. This script uses the
 *     current signer's address; pass a fixed deployer to compare across
 *     chains.
 *   - The Permit2Proxy init code depends on the OkuRouter address (its
 *     constructor arg). We read that address from the registry via
 *     networkConfig.ts.
 */
import hre from "hardhat";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  computeCreate2Address,
  getOkuRouterSalt,
  getPermit2ProxySalt,
} from "../util/contractMeta";
import { getCurrentAddress } from "../util/deploymentsRegistry";

async function main() {
  const { ethers } = hre;
  const networkName = hre.network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("\n=== Oku Router Address Prediction ===\n");
  console.log("Network:        ", networkName);
  console.log("Chain ID:       ", chainId.toString());
  console.log("Contract:       ", CONTRACT_NAME);
  console.log("Version:        ", CONTRACT_VERSION);

  // Sanity-check that the Safe Singleton Factory is reachable. Without
  // it, deterministic deployment isn't possible -- predictions would
  // still compute, but they wouldn't be actionable.
  const factoryCode = await ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
  const factoryAvailable = factoryCode !== "0x";
  console.log(
    `Safe Singleton Factory: ${factoryAvailable ? "✅ present" : "⚠️  NOT deployed"} at ${SAFE_SINGLETON_FACTORY}`,
  );
  console.log("");

  // Pick an owner for the OkuRouter constructor. The signer's address is
  // a good default but should match the actual deployer used in
  // production to get a matching predicted address.
  let ownerAddress: string;
  try {
    const [signer] = await ethers.getSigners();
    ownerAddress = await signer.getAddress();
  } catch {
    ownerAddress = ethers.ZeroAddress;
  }
  console.log("Owner (constructor arg):", ownerAddress);
  if (ownerAddress === ethers.ZeroAddress) {
    console.log("⚠️  No signer available; using address(0). Predicted address will not match a real deploy.");
  }

  // ---- OkuRouter prediction ----
  const OkuRouter = await ethers.getContractFactory("OkuRouter");
  const routerDeployTx = await OkuRouter.getDeployTransaction(
    CONTRACT_NAME,
    CONTRACT_VERSION,
    ownerAddress,
  );
  if (!routerDeployTx.data) throw new Error("Failed to generate OkuRouter init code");
  const routerInitCodeHash = ethers.keccak256(routerDeployTx.data);
  const routerSalt = getOkuRouterSalt();
  const routerAddress = computeCreate2Address(
    SAFE_SINGLETON_FACTORY,
    routerSalt,
    routerInitCodeHash,
  );

  console.log("\n=== OkuRouter ===");
  console.log("Salt:            ", routerSalt);
  console.log("InitCode hash:   ", routerInitCodeHash);
  console.log("Predicted address:", routerAddress);
  const routerExisting = await ethers.provider.getCode(routerAddress);
  console.log(
    routerExisting !== "0x"
      ? "Status:           ✅ ALREADY DEPLOYED at this address"
      : "Status:           ❌ Not yet deployed",
  );

  // ---- Permit2Proxy prediction (only if we have an OkuRouter address) ----
  // Try the registry first (gives us the *currently live* router); if that's
  // missing, fall back to the predicted router address computed above so the
  // operator still sees what the proxy WOULD bind to once the router is live.
  let bondedRouter: string | null =
    getCurrentAddress(networkName, "OkuRouter") ?? null;
  if (!bondedRouter) bondedRouter = routerAddress;

  const Proxy = await ethers.getContractFactory("Permit2Proxy");
  const proxyDeployTx = await Proxy.getDeployTransaction(bondedRouter);
  if (!proxyDeployTx.data) throw new Error("Failed to generate Permit2Proxy init code");
  const proxyInitCodeHash = ethers.keccak256(proxyDeployTx.data);
  const proxySalt = getPermit2ProxySalt(bondedRouter);
  const proxyAddress = computeCreate2Address(
    SAFE_SINGLETON_FACTORY,
    proxySalt,
    proxyInitCodeHash,
  );

  console.log("\n=== Permit2Proxy ===");
  console.log("Bonded OkuRouter: ", bondedRouter);
  console.log("Salt:             ", proxySalt);
  console.log("InitCode hash:    ", proxyInitCodeHash);
  console.log("Predicted address:", proxyAddress);
  const proxyExisting = await ethers.provider.getCode(proxyAddress);
  console.log(
    proxyExisting !== "0x"
      ? "Status:           ✅ ALREADY DEPLOYED at this address"
      : "Status:           ❌ Not yet deployed",
  );

  console.log("\n=== Next steps ===");
  console.log(`  npx hardhat deploy --network ${networkName} --deterministic`);
  console.log(`  npx hardhat deploy-permit2-proxy --network ${networkName}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
