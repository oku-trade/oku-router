/**
 * testForkDeployPending.ts
 *
 * Local-fork dry run of the v2.0 OkuRouter deployment across every currently
 * outstanding, non-deferred chain:
 *
 *   - linea, mantle, redbelly: already attempted live, blocked on
 *     insufficient dev-wallet funds (see deployments/*.json, still v1.2).
 *   - mainnet (ethereum), saga, zerog, hyperevm: newly-added full-scope
 *     chains (see util/deploymentConfig.ts "Full-scope expansion additions").
 *
 * NOT covered here (handled elsewhere): celo, pharos, saga, and the newly
 * onboarded rootstock/goat/xdc. celo, saga, and pharos are already deployed
 * (see deployments/*.json) and their addresses are back-filled into
 * chain-config's `oku.router`. rootstock/goat/xdc have their own dedicated
 * dry-run harness, `scripts/testForkDeployNewChains.ts`. (Historical note:
 * celo/pharos were previously deferred as "zero marketRouters / no permit2";
 * that no longer holds -- celo now carries an openocean marketRouter in
 * chain-config and pharos uses the canonical permit2.)
 *
 * Unlike the balance-honest `testForkDeployV2.ts` (which intentionally does
 * NOT fund the wallet, to prove "insufficient funds" is a real, expected
 * outcome), this script ARTIFICIALLY funds the impersonated dev wallet on
 * the fork so the full deploy flow (router deploy + swap target whitelist +
 * signer + duration) can be exercised end-to-end as a complete dry run.
 *
 * It also independently reports, for comparison:
 *   - the REAL on-chain balance of the dev wallet (queried before any
 *     funding is applied)
 *   - an estimated TRUE cost to complete the full deploy at current live
 *     gas prices, so you can see exactly how much of a shortfall exists
 *     even though the fork itself succeeds after artificial funding.
 *
 * This script runs entirely on local Hardhat forks. It NEVER sends a
 * transaction to a live network -- `hardhat_setBalance` only mutates local,
 * in-memory fork state.
 *
 * Usage:
 *   npx hardhat run scripts/testForkDeployPending.ts
 */
import hre from "hardhat";
import { formatEther, formatUnits } from "ethers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { OkuRouter__factory } from "../typechain-types";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  getOkuRouterSalt,
} from "../util/contractMeta";
import { getNetworkConfig } from "../util/deploymentConfig";
import { predictOkuRouterAddress, deployDeterministic, registerSwapTargets } from "../tasks/deploy";

const DEV_WALLET = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// Calibrated per-write gas cost (measured via a real estimateGas call
// against the already-deployed v2.0 bytecode on a live chain -- see prior
// session notes). Used only to compute the "true cost" comparison figure;
// the actual fork deploy uses real estimateGas throughout.
const PER_WRITE_GAS = 49_158n;
const ARTIFICIAL_FUND_ETH = "10000"; // comically generous; this is fork-only, never real

const PENDING_CHAINS = ["linea", "mantle", "redbelly", "mainnet", "saga", "zerog", "hyperevm"];

// Same class of harness-only limitation noted in testForkDeployV2.ts. Not a
// deploy-logic issue -- the real `deploy` task talks to these chains via
// plain ethers.js JSON-RPC, not Hardhat's fork machinery.
const FORK_INCOMPATIBLE: Record<string, string> = {
  redbelly: "Redbelly's RPC does not implement net_version, which Hardhat's fork bootstrap requires",
  zerog: "evmrpc.0g.ai is not an archive node -- state is pruned too quickly for Hardhat's fork bootstrap (confirmed via 3 retries, consistent 'missing trie node' error)",
};

type Status = "PASS" | "FAIL" | "FORK_FAIL" | "NO_RPC" | "FORK_INCOMPATIBLE";

interface Result {
  name: string;
  status: Status;
  address: string;
  realBalance: string;
  estimatedTrueCost: string;
  shortfall: string;
  swapTargetsRegistered: number;
  swapTargetsTotal: number;
  error: string | null;
}

async function testChain(name: string): Promise<Result> {
  const netConfig = (hre.config.networks as any)[name];
  const rpcUrl: string | undefined = netConfig?.url;

  if (!rpcUrl || rpcUrl === "0000000000000000000000000000000000000000000000000000000000000000") {
    return { name, status: "NO_RPC", address: "", realBalance: "N/A", estimatedTrueCost: "N/A", shortfall: "N/A", swapTargetsRegistered: 0, swapTargetsTotal: 0, error: "No RPC URL configured" };
  }

  let cfg;
  try {
    cfg = getNetworkConfig(name);
  } catch (e: any) {
    return { name, status: "FAIL", address: "", realBalance: "N/A", estimatedTrueCost: "N/A", shortfall: "N/A", swapTargetsRegistered: 0, swapTargetsTotal: 0, error: `getNetworkConfig failed: ${e.message}` };
  }

  if (FORK_INCOMPATIBLE[name]) {
    console.log(`\n${"=".repeat(90)}\n${name} (chainId ${cfg.chainId}) -- SKIPPED\n${"=".repeat(90)}`);
    console.log(`  ${FORK_INCOMPATIBLE[name]}`);
    return { name, status: "FORK_INCOMPATIBLE", address: "", realBalance: "N/A", estimatedTrueCost: "N/A", shortfall: "N/A", swapTargetsTotal: cfg.knownSwapTargets.length, swapTargetsRegistered: 0, error: FORK_INCOMPATIBLE[name] };
  }

  console.log(`\n${"=".repeat(90)}\n${name} (chainId ${cfg.chainId})\n${"=".repeat(90)}`);

  try {
    // Fork the real chain. Retried up to 3x: public RPCs occasionally hit
    // transient "historical state not available" / pruning-race errors that
    // resolve on retry (observed with linea, polygon in earlier sessions).
    let forkOk = false;
    let lastForkErr: any;
    for (let attempt = 1; attempt <= 3 && !forkOk; attempt++) {
      try {
        await hre.network.provider.request({
          method: "hardhat_reset",
          params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber: undefined } }],
        });
        await hre.ethers.provider.getBlockNumber(); // confirm fork is usable
        forkOk = true;
      } catch (e) {
        lastForkErr = e;
      }
    }
    if (!forkOk) throw lastForkErr;

    // 1. Real (unfunded) balance, queried BEFORE any artificial funding.
    const realBalance = await hre.ethers.provider.getBalance(DEV_WALLET);
    console.log(`  Dev wallet:        ${DEV_WALLET}`);
    console.log(`  REAL balance:      ${formatEther(realBalance)} ${cfg.nativeSymbol}`);
    console.log(`  Permit2:           ${cfg.permit2Address} (canonical=${cfg.canonicalPermit2})`);
    console.log(`  Swap targets:      ${cfg.knownSwapTargets.length} known`);

    // 2. Estimate the TRUE cost of a full deploy at current live gas price.
    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const OkuRouter = await hre.ethers.getContractFactory("OkuRouter");
    const deployTx = await OkuRouter.getDeployTransaction(CONTRACT_NAME, CONTRACT_VERSION, DEV_WALLET, cfg.permit2Address);
    const salt = getOkuRouterSalt();
    let deployGasEst: bigint;
    try {
      deployGasEst = await hre.ethers.provider.estimateGas({ from: DEV_WALLET, to: SAFE_SINGLETON_FACTORY, data: hre.ethers.concat([salt, deployTx.data!]) });
      deployGasEst = (deployGasEst * 130n) / 100n;
    } catch {
      deployGasEst = 5_000_000n;
    }
    const numTargets = BigInt(cfg.knownSwapTargets.length);
    const totalGas = deployGasEst + numTargets * PER_WRITE_GAS + PER_WRITE_GAS + PER_WRITE_GAS; // + signer + duration
    const trueCost = totalGas * gasPrice;
    const shortfall = trueCost > realBalance ? trueCost - realBalance : 0n;
    console.log(`  Gas price:         ${formatUnits(gasPrice, "gwei")} gwei`);
    console.log(`  Est. TRUE cost:    ${formatEther(trueCost)} ${cfg.nativeSymbol} (deploy + ${numTargets} targets + signer + duration)`);
    console.log(`  SHORTFALL vs real: ${formatEther(shortfall)} ${cfg.nativeSymbol}`);

    // 3. Artificially fund the wallet on the fork ONLY, so we can exercise
    // the full deploy flow end-to-end. This never touches the real chain.
    await setBalance(DEV_WALLET, hre.ethers.parseEther(ARTIFICIAL_FUND_ETH));
    console.log(`  [fork-only] Artificially funded to ${ARTIFICIAL_FUND_ETH} ${cfg.nativeSymbol} for this dry run.`);

    const factoryCode = await hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
    if (factoryCode === "0x") {
      return { name, status: "FAIL", address: "", realBalance: formatEther(realBalance), estimatedTrueCost: formatEther(trueCost), shortfall: formatEther(shortfall), swapTargetsTotal: cfg.knownSwapTargets.length, swapTargetsRegistered: 0, error: "Safe Singleton Factory not present on this chain" };
    }

    const { address } = await predictOkuRouterAddress(hre, DEV_WALLET, cfg.permit2Address);
    console.log(`  Predicted router:  ${address}`);

    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [DEV_WALLET] });
    const signer = await hre.ethers.getSigner(DEV_WALLET);

    const deployResult = await deployDeterministic(hre, signer, DEV_WALLET, cfg.permit2Address);
    const contract = OkuRouter__factory.connect(deployResult.address, signer);
    console.log(`  Deployed:          ${await contract.name()} v${await contract.version()}`);

    const { alreadyRegistered, newlyRegistered } = await registerSwapTargets(hre, contract, cfg.knownSwapTargets, {});

    const zero = hre.ethers.ZeroAddress;
    if (!(await contract.validSigners(zero))) {
      const tx = await contract.updateValidSigner(zero, true);
      await tx.wait();
      console.log("  ✓ Zero address approved as valid signer");
    }
    const DEFAULT_DURATION = 300;
    if (Number(await contract.maxWarrantDuration()) !== DEFAULT_DURATION) {
      const tx = await contract.setMaxWarrantDuration(DEFAULT_DURATION);
      await tx.wait();
      console.log(`  ✓ Max warrant duration set to ${DEFAULT_DURATION}s`);
    }

    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [DEV_WALLET] });

    return {
      name,
      status: "PASS",
      address: deployResult.address,
      realBalance: formatEther(realBalance),
      estimatedTrueCost: formatEther(trueCost),
      shortfall: formatEther(shortfall),
      swapTargetsRegistered: alreadyRegistered.length + newlyRegistered.length,
      swapTargetsTotal: cfg.knownSwapTargets.length,
      error: null,
    };
  } catch (err: any) {
    const msg = err.message?.slice(0, 300) || "Unknown error";
    console.log(`  ERROR: ${msg}`);
    return { name, status: "FORK_FAIL", address: "", realBalance: "N/A", estimatedTrueCost: "N/A", shortfall: "N/A", swapTargetsTotal: 0, swapTargetsRegistered: 0, error: msg };
  }
}

async function main() {
  console.log("=".repeat(90));
  console.log("Local Fork Deploy Test (v2.0) -- outstanding non-deferred chains");
  console.log("(artificially funded on fork only; real balances reported for comparison)");
  console.log("=".repeat(90));
  console.log(`Contract:   ${CONTRACT_NAME} v${CONTRACT_VERSION}`);
  console.log(`Dev wallet: ${DEV_WALLET}`);

  const results: Result[] = [];
  for (const name of PENDING_CHAINS) {
    results.push(await testChain(name));
  }

  console.log("\n" + "=".repeat(110));
  console.log("SUMMARY");
  console.log("=".repeat(110));
  console.log(
    "Chain".padEnd(10) +
      "Status".padEnd(20) +
      "RealBalance".padEnd(20) +
      "EstTrueCost".padEnd(20) +
      "Shortfall".padEnd(20) +
      "SwapTargets"
  );
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(
      r.name.padEnd(10) +
        r.status.padEnd(20) +
        r.realBalance.padEnd(20) +
        r.estimatedTrueCost.padEnd(20) +
        r.shortfall.padEnd(20) +
        `${r.swapTargetsRegistered}/${r.swapTargetsTotal}`
    );
    if (r.error) console.log(`  -> ${r.error}`);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL" || r.status === "FORK_FAIL" || r.status === "NO_RPC").length;
  const skipped = results.filter((r) => r.status === "FORK_INCOMPATIBLE").length;
  console.log(`\n${pass} PASS (full dry-run succeeded on fork), ${fail} FAIL, ${skipped} SKIPPED (harness incompatibility)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
