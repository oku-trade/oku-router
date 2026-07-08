import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Signer } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { getNetworkConfig } from "../util/networkConfig";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  getOkuRouterSalt,
  computeCreate2Address,
} from "../util/contractMeta";
import { recordDeployment } from "../util/deploymentsRegistry";
import { sleep, withRetry } from "../util/rpcRetry";

// Address used to impersonate the deployer on local Hardhat forks.
const userAddr = "0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89";
// gfxOwner is the eventual production owner. Ownership transfer is left to
// a separate manual step (see README runbook) so that each deployment can
// be smoke-tested by the deployer EOA before handing over control.
const gfxOwner = "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5";

/**
 * Compute the predicted OkuRouter address for this version+owner pair.
 *
 * Note: changing `owner` changes the constructor args, which changes the
 * init code, which changes the CREATE2 address. That's why for a stable
 * cross-chain address we have to deploy with the same `owner` everywhere
 * (currently: the deployer EOA, with ownership transferred post-deploy).
 */
async function predictOkuRouterAddress(
  hre: HardhatRuntimeEnvironment,
  owner: string,
): Promise<{ address: string; initCode: string; salt: string }> {
  const OkuRouter = await hre.ethers.getContractFactory("OkuRouter");
  const deployTx = await OkuRouter.getDeployTransaction(
    CONTRACT_NAME,
    CONTRACT_VERSION,
    owner,
  );
  const initCode = deployTx.data;
  if (!initCode) {
    throw new Error("Failed to generate init code");
  }
  const initCodeHash = hre.ethers.keccak256(initCode);
  const salt = getOkuRouterSalt();
  const address = computeCreate2Address(SAFE_SINGLETON_FACTORY, salt, initCodeHash);
  return { address, initCode, salt };
}

/**
 * Deploy OkuRouter deterministically via the Safe Singleton Factory.
 *
 * Returns the address regardless of whether we actually had to deploy:
 *   - If code already exists at the predicted address, the existing
 *     deployment is reused (idempotent re-runs).
 *   - Otherwise we send the CREATE2 transaction.
 *
 * The factory exists at the same canonical address on every major EVM
 * chain. If it's missing on a chain, we surface that loudly rather than
 * silently falling back to a non-deterministic deploy (which would defeat
 * the whole point of having matching addresses across chains).
 */
async function deployDeterministic(
  hre: HardhatRuntimeEnvironment,
  signer: Signer,
  owner: string,
): Promise<{ address: string; blockNumber: number | null; txHash: string | null; reused: boolean }> {
  const { address, initCode, salt } = await predictOkuRouterAddress(hre, owner);

  // Idempotency check: if something already lives at the predicted
  // address, treat it as a successful deploy and skip the tx. Wrapped in
  // withRetry because rate-limited public RPCs (e.g. zan.top, alchemy
  // public tier) occasionally 429 on getCode reads under load.
  const existingCode = await withRetry(
    () => hre.ethers.provider.getCode(address),
    `getCode(${address})`,
  );
  if (existingCode !== "0x") {
    console.log("✓ Contract already deployed at:", address);
    return { address, blockNumber: null, txHash: null, reused: true };
  }

  const factoryCode = await withRetry(
    () => hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY),
    `getCode(${SAFE_SINGLETON_FACTORY})`,
  );
  if (factoryCode === "0x") {
    throw new Error(
      `Safe Singleton Factory not deployed on this chain at ${SAFE_SINGLETON_FACTORY}. ` +
        `Deploy the factory first (see https://github.com/safe-global/safe-singleton-factory) ` +
        `or skip deterministic deployment for this chain.`,
    );
  }

  // The factory's calldata convention is `salt ++ initCode`. It returns
  // the deployed address on success and reverts otherwise.
  //
  // We retry the *submission* (eth_sendRawTransaction can 429 on public
  // RPCs) but NOT the wait — once a tx is broadcast we don't want a
  // second copy on chain. If the receipt poll itself 429s, we retry it
  // separately because that's a pure read.
  const deploymentData = hre.ethers.concat([salt, initCode]);

  // Estimate gas for the CREATE2 deploy. Some chains (e.g. Filecoin) charge
  // for on-chain message storage and require a gasLimit well above the EVM
  // execution cost. We estimate + 30% buffer, with a floor of 5M.
  const signerAddress = await signer.getAddress();
  let gasLimit: bigint;
  try {
    const est = await withRetry(
      () => hre.ethers.provider.estimateGas({
        from: signerAddress,
        to: SAFE_SINGLETON_FACTORY,
        data: deploymentData,
      }),
      "estimateGas(CREATE2)",
    );
    gasLimit = est * 130n / 100n; // 30% buffer
  } catch {
    gasLimit = 5_000_000n; // fallback
  }

  console.log(`Deploying via Safe Singleton Factory (CREATE2, gasLimit: ${gasLimit})...`);
  const tx = await withRetry(
    () =>
      signer.sendTransaction({
        to: SAFE_SINGLETON_FACTORY,
        data: deploymentData,
        gasLimit,
      }),
    "sendTransaction(CREATE2)",
  );
  const receipt = await withRetry(() => tx.wait(), `tx.wait(${tx.hash})`);
  if (!receipt) {
    throw new Error("Transaction receipt is null");
  }

  // Defensive: confirm CREATE2 actually placed code at the predicted slot.
  const deployedCode = await withRetry(
    () => hre.ethers.provider.getCode(address),
    `getCode(${address}) post-deploy`,
  );
  if (deployedCode === "0x") {
    throw new Error("Deployment failed - no code at expected address");
  }

  console.log("✓ Deployed to:", address);
  return {
    address,
    blockNumber: receipt.blockNumber ?? null,
    txHash: tx.hash,
    reused: false,
  };
}



task("deploy", "Deploy OkuRouter contract")
  .addFlag("deterministic", "Use deterministic deployment via CREATE2")
  .setAction(async (taskArgs, hre) => {
    const deterministicMode = taskArgs.deterministic;

    let networkName = hre.network.name;
    const testNetwork = "worldchain";
    let mainnet = true;
    let signer: Signer;

    if (networkName === "hardhat" || networkName === "localhost") {
      // Local fork: CREATE2 via Safe Singleton Factory does not behave
      // reliably here (state-overrides interfere with deterministic
      // address computation), so we hard-block --deterministic locally.
      mainnet = false;

      if (deterministicMode) {
        throw new Error(
          "Deterministic deployment (--deterministic flag) is not supported on Hardhat forks.\n" +
            "This is due to known limitations with CREATE2 on forked networks.\n" +
            "Please remove the --deterministic flag for local testing, or deploy to a live network.",
        );
      }

      // Reset to a fresh worldchain fork pinned at chainId 10 (Optimism)
      // so EIP-712 hardfork-dependent paths behave identically to a real
      // OP-stack chain.
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.WORLDCHAIN_URL!,
              blockNumber: undefined,
            },
            chainId: 10,
          },
        ],
      });
      networkName = testNetwork;

      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [userAddr],
      });
      signer = await hre.ethers.getSigner(userAddr);

      const balance = await hre.ethers.provider.getBalance(userAddr);
      if (balance < hre.ethers.parseEther("0.01")) {
        await setBalance(userAddr, hre.ethers.parseEther("1"));
      }
    } else {
      [signer] = await hre.ethers.getSigners();
      console.log(`\nDeploying to ${networkName} as ${await signer.getAddress()}`);
    }

    const ownerAddress = await signer.getAddress();
    console.log(`Contract: ${CONTRACT_NAME} v${CONTRACT_VERSION}`);
    console.log(`Owner (constructor): ${ownerAddress}`);

    let contractAddress: string;
    let blockNumber: number | null = null;
    let txHash: string | null = null;
    let reused = false;
    let contract;

    try {
      if (deterministicMode) {
        const result = await deployDeterministic(hre, signer, ownerAddress);
        contractAddress = result.address;
        blockNumber = result.blockNumber;
        txHash = result.txHash;
        reused = result.reused;
        contract = OkuRouter__factory.connect(contractAddress, signer);
      } else {
        // Non-deterministic fallback: useful only for local forks. The
        // resulting address is nonce-dependent and will NOT match other
        // chains' deployments, so consumers of the registry shouldn't
        // rely on cross-chain parity in this path.
        contract = await new OkuRouter__factory()
          .connect(signer)
          .deploy(CONTRACT_NAME, CONTRACT_VERSION, ownerAddress, { gasLimit: 5_000_000 });
        const deployTx = contract.deploymentTransaction();
        await contract.waitForDeployment();
        contractAddress = await contract.getAddress();
        if (deployTx) {
          const receipt = await deployTx.wait();
          blockNumber = receipt?.blockNumber ?? null;
          txHash = deployTx.hash;
        }
        console.log("✓ Deployed to:", contractAddress);
      }
    } catch (error: any) {
      console.error("✗ Deployment failed:", error.message);
      throw error;
    }

    if (mainnet) {
      // Brief settle to let the chain propagate before we start reading
      // state and sending follow-up txs against the new contract.
      await sleep(5000);
    }

    // Record in the on-disk registry. We do this BEFORE swap-target
    // wiring so that even if a later admin call fails, the deployment
    // itself is captured. The registry is the source of truth that
    // networkConfig.ts reads on startup.
    //
    // IMPORTANT: this branch is intentionally gated by `mainnet` because
    // the local-fork code path above hard-rewrites `networkName` to
    // "worldchain" (line ~160) even when hre.network.name was
    // "hardhat"/"localhost". Without the `mainnet` guard we would
    // overwrite the production worldchain registry with a local-fork
    // address. Do NOT remove that guard.
    if (mainnet && !reused) {
      try {
        const chainIdBig = (await hre.ethers.provider.getNetwork()).chainId;
        // `ownerAddress` is the constructor `_owner` arg, which Ownable2Step
        // installs as the initial owner. If a subsequent transferOwnership /
        // acceptOwnership cycle has already happened on this chain by the
        // time we get here, this record will be stale until manually
        // refreshed -- standard practice is to redeploy then transfer in
        // separate steps, and to commit a follow-up edit to this JSON after
        // the multisig accepts ownership.
        recordDeployment(networkName, Number(chainIdBig), "OkuRouter", {
          address: contractAddress,
          version: CONTRACT_VERSION,
          owner: ownerAddress,
        });
        console.log(`✓ Logged deployment to deployments/${networkName}.json`);
      } catch (err: any) {
        // Don't fail the whole task if disk I/O hiccups -- the on-chain
        // deploy succeeded and the operator can re-record manually.
        console.warn(`⚠ Failed to write deployments/${networkName}.json:`, err.message);
      }
    } else if (reused) {
      console.log(`ℹ Skipping registry write: address ${contractAddress} already had code on-chain.`);
    }

    // Pull network config (swap targets, signers) AFTER recording the
    // deployment, since networkConfig.ts will now resolve the new address
    // from the registry we just wrote.
    let config;
    try {
      config = getNetworkConfig(networkName);
    } catch (e) {
      // No config found, skip
    }

    if (config && config.knownSwapTargets.length > 0) {
      const targets = config.knownSwapTargets;
      const targetsToAdd: typeof targets = [];
      for (const target of targets) {
        const isRegistered = await withRetry(
          () => contract.swapTargets(target.address),
          `swapTargets(${target.address})`,
        );
        if (!isRegistered) {
          targetsToAdd.push(target);
        }
      }

      if (targetsToAdd.length > 0) {
        console.log(`\nRegistering ${targetsToAdd.length} new swap targets:`);
        for (let i = 0; i < targetsToAdd.length; i++) {
          const target = targetsToAdd[i];
          console.log(`  ✓ ${target.name} (${target.protocol}): ${target.address}`);
          // Wrap submission + wait separately so a 429 on either side
          // doesn't double-submit the tx. updateSwapTargets is idempotent
          // anyway (writes a bool), so a retried second copy on chain
          // would be harmless — but we still avoid wasting gas on dupes.
          const updateTx = await withRetry(
            () =>
              contract.updateSwapTargets(target.address, true),
            `updateSwapTargets(${target.address})`,
          );
          await withRetry(() => updateTx.wait(), `tx.wait(${updateTx.hash})`);
          if (mainnet && i < targetsToAdd.length - 1) {
            await sleep(2000);
          }
        }
      } else {
        console.log(`\n✓ All ${targets.length} swap targets already registered`);
      }
    }

    const zeroAddress = hre.ethers.ZeroAddress;
    const isZeroAddressSigner = await withRetry(
      () => contract.validSigners(zeroAddress),
      `validSigners(${zeroAddress})`,
    );
    if (!isZeroAddressSigner) {
      const validSignerTx = await withRetry(
        () =>
          contract.updateValidSigner(zeroAddress, true),
        `updateValidSigner(${zeroAddress})`,
      );
      await withRetry(() => validSignerTx.wait(), `tx.wait(${validSignerTx.hash})`);
      console.log("✓ Zero address approved as valid signer");
    } else {
      console.log("✓ Zero address already approved as valid signer");
    }

    if (mainnet) {
      console.log("\nVerifying contract on block explorer...");
      try {
        await hre.run("verify:verify", {
          address: contractAddress,
          constructorArguments: [CONTRACT_NAME, CONTRACT_VERSION, ownerAddress],
        });
      } catch (err: any) {
        // Verification is best-effort; the deployment is already recorded.
        console.warn(`⚠ Verification failed (will need manual retry): ${err.message}`);
      }
    }

    // Ownership reminder. Ownable2Step requires the new owner to call
    // acceptOwnership(), so this is intentionally a manual step.
    console.log(
      `\nℹ Ownership currently held by deployer ${ownerAddress}.\n` +
        `  When ready, transfer to ${gfxOwner} via:\n` +
        `    contract.transferOwnership("${gfxOwner}")\n` +
        `  followed by ${gfxOwner} calling acceptOwnership() (Ownable2Step).`,
    );

    console.log("\n✓ Deployment complete!");
  });
