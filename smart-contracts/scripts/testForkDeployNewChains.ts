/**
 * testForkDeployNewChains.ts
 *
 * Local-fork dry run of the v2.0 OkuRouter deployment for the three chains
 * being newly brought online: rootstock, goat, xdc.
 *
 * All three:
 *   - have a full `marketRouters` block in chain-config (swap targets to
 *     whitelist),
 *   - use a NON-canonical permit2, so each gets a UNIQUE deterministic
 *     OkuRouter address (unlike the canonical 0xb1f3...00ed chains),
 *   - had `create2FactoryAddress` added to their deploymentConfig override.
 *
 * This forks each real chain, artificially funds the dev wallet ON THE FORK
 * ONLY, then exercises the complete deploy flow (CREATE2 router deploy +
 * swap-target whitelist + zero-signer + backend warrant signer + max warrant
 * duration) end-to-end. It NEVER broadcasts to a live network.
 *
 * Usage:
 *   npx hardhat run scripts/testForkDeployNewChains.ts
 */
import hre from "hardhat";
import { formatEther, formatUnits } from "ethers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { OkuRouter__factory } from "../typechain-types";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  BACKEND_WARRANT_SIGNER,
  getOkuRouterSalt,
} from "../util/contractMeta";
import { getNetworkConfig } from "../util/deploymentConfig";
import { predictOkuRouterAddress, deployDeterministic, registerSwapTargets } from "../tasks/deploy";

const DEV_WALLET = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";
const PER_WRITE_GAS = 49_158n;
const ARTIFICIAL_FUND_ETH = "10000"; // fork-only, never real

const NEW_CHAINS = ["rootstock", "goat", "xdc"];

// Expected deterministic addresses (from pure CREATE2 math with real permit2).
const EXPECTED: Record<string, string> = {
  rootstock: "0x0906896E8564c61F40778E2B7A46E1269Aaa681e",
  goat: "0x7B060A98BA242Ae42D6027a60937787eBe33DEBe",
  xdc: "0x7B060A98BA242Ae42D6027a60937787eBe33DEBe",
};

type Status = "PASS" | "FAIL" | "FORK_FAIL" | "NO_RPC";

interface Result {
  name: string;
  status: Status;
  address: string;
  addressMatch: boolean;
  realBalance: string;
  estimatedTrueCost: string;
  shortfall: string;
  swapTargetsRegistered: number;
  swapTargetsTotal: number;
  backendSignerSet: boolean;
  error: string | null;
}

async function testChain(name: string): Promise<Result> {
  const netConfig = (hre.config.networks as any)[name];
  const rpcUrl: string | undefined = netConfig?.url;

  const base = {
    name,
    address: "",
    addressMatch: false,
    realBalance: "N/A",
    estimatedTrueCost: "N/A",
    shortfall: "N/A",
    swapTargetsRegistered: 0,
    swapTargetsTotal: 0,
    backendSignerSet: false,
    error: null as string | null,
  };

  if (!rpcUrl) {
    return { ...base, status: "NO_RPC", error: "No RPC URL configured" };
  }

  let cfg;
  try {
    cfg = getNetworkConfig(name);
  } catch (e: any) {
    return { ...base, status: "FAIL", error: `getNetworkConfig failed: ${e.message}` };
  }
  base.swapTargetsTotal = cfg.knownSwapTargets.length;

  console.log(`\n${"=".repeat(90)}\n${name} (chainId ${cfg.chainId})\n${"=".repeat(90)}`);

  try {
    let forkOk = false;
    let lastForkErr: any;
    for (let attempt = 1; attempt <= 3 && !forkOk; attempt++) {
      try {
        await hre.network.provider.request({
          method: "hardhat_reset",
          params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber: undefined } }],
        });
        await hre.ethers.provider.getBlockNumber();
        forkOk = true;
      } catch (e) {
        lastForkErr = e;
      }
    }
    if (!forkOk) throw lastForkErr;

    const realBalance = await hre.ethers.provider.getBalance(DEV_WALLET);
    console.log(`  Dev wallet:        ${DEV_WALLET}`);
    console.log(`  REAL balance:      ${formatEther(realBalance)} ${cfg.nativeSymbol}`);
    console.log(`  Permit2:           ${cfg.permit2Address} (canonical=${cfg.canonicalPermit2})`);
    console.log(`  Swap targets:      ${cfg.knownSwapTargets.length} known`);

    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const OkuRouter = await hre.ethers.getContractFactory("OkuRouter");
    const deployTx = await OkuRouter.getDeployTransaction(
      CONTRACT_NAME,
      CONTRACT_VERSION,
      DEV_WALLET,
      cfg.permit2Address,
    );
    const salt = getOkuRouterSalt();
    let deployGasEst: bigint;
    try {
      deployGasEst = await hre.ethers.provider.estimateGas({
        from: DEV_WALLET,
        to: SAFE_SINGLETON_FACTORY,
        data: hre.ethers.concat([salt, deployTx.data!]),
      });
      deployGasEst = (deployGasEst * 130n) / 100n;
    } catch {
      deployGasEst = 5_000_000n;
    }
    const numTargets = BigInt(cfg.knownSwapTargets.length);
    // deploy + N targets + zeroSigner + backendSigner + duration
    const totalGas = deployGasEst + numTargets * PER_WRITE_GAS + 3n * PER_WRITE_GAS;
    const trueCost = totalGas * gasPrice;
    const shortfall = trueCost > realBalance ? trueCost - realBalance : 0n;
    console.log(`  Gas price:         ${formatUnits(gasPrice, "gwei")} gwei`);
    console.log(`  Est. TRUE cost:    ${formatEther(trueCost)} ${cfg.nativeSymbol}`);
    console.log(`  SHORTFALL vs real: ${formatEther(shortfall)} ${cfg.nativeSymbol}`);

    await setBalance(DEV_WALLET, hre.ethers.parseEther(ARTIFICIAL_FUND_ETH));
    console.log(`  [fork-only] Artificially funded to ${ARTIFICIAL_FUND_ETH} ${cfg.nativeSymbol}.`);

    const factoryCode = await hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
    if (factoryCode === "0x") {
      return {
        ...base,
        status: "FAIL",
        realBalance: formatEther(realBalance),
        estimatedTrueCost: formatEther(trueCost),
        shortfall: formatEther(shortfall),
        error: "Safe Singleton Factory not present on this chain",
      };
    }

    const { address } = await predictOkuRouterAddress(hre, DEV_WALLET, cfg.permit2Address);
    const addressMatch = address.toLowerCase() === EXPECTED[name].toLowerCase();
    console.log(`  Predicted router:  ${address} (expected ${EXPECTED[name]}, match=${addressMatch})`);

    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [DEV_WALLET] });
    const signer = await hre.ethers.getSigner(DEV_WALLET);

    const deployResult = await deployDeterministic(hre, signer, DEV_WALLET, cfg.permit2Address);
    const contract = OkuRouter__factory.connect(deployResult.address, signer);
    console.log(`  Deployed:          ${await contract.name()} v${await contract.version()}`);

    const { alreadyRegistered, newlyRegistered } = await registerSwapTargets(
      hre,
      contract,
      cfg.knownSwapTargets,
      {},
    );

    const zero = hre.ethers.ZeroAddress;
    if (!(await contract.validSigners(zero))) {
      await (await contract.updateValidSigner(zero, true)).wait();
      console.log("  ✓ Zero address approved as valid signer");
    }
    // Backend warrant signer -- mirror the live deploy task exactly.
    let backendSignerSet = await contract.validSigners(BACKEND_WARRANT_SIGNER);
    if (!backendSignerSet) {
      await (await contract.updateValidSigner(BACKEND_WARRANT_SIGNER, true)).wait();
      backendSignerSet = await contract.validSigners(BACKEND_WARRANT_SIGNER);
      console.log(`  ✓ Backend warrant signer ${BACKEND_WARRANT_SIGNER} approved (=${backendSignerSet})`);
    }
    const DEFAULT_DURATION = 300;
    if (Number(await contract.maxWarrantDuration()) !== DEFAULT_DURATION) {
      await (await contract.setMaxWarrantDuration(DEFAULT_DURATION)).wait();
      console.log(`  ✓ Max warrant duration set to ${DEFAULT_DURATION}s`);
    }

    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [DEV_WALLET] });

    return {
      ...base,
      status: "PASS",
      address: deployResult.address,
      addressMatch,
      realBalance: formatEther(realBalance),
      estimatedTrueCost: formatEther(trueCost),
      shortfall: formatEther(shortfall),
      swapTargetsRegistered: alreadyRegistered.length + newlyRegistered.length,
      backendSignerSet,
      error: null,
    };
  } catch (err: any) {
    const msg = err.message?.slice(0, 300) || "Unknown error";
    console.log(`  ERROR: ${msg}`);
    return { ...base, status: "FORK_FAIL", error: msg };
  }
}

async function main() {
  console.log("=".repeat(90));
  console.log("Local Fork Deploy Test (v2.0) -- NEW chains: rootstock, goat, xdc");
  console.log("(artificially funded on fork only; real balances reported for comparison)");
  console.log("=".repeat(90));
  console.log(`Contract:   ${CONTRACT_NAME} v${CONTRACT_VERSION}`);
  console.log(`Dev wallet: ${DEV_WALLET}`);

  const results: Result[] = [];
  for (const name of NEW_CHAINS) {
    results.push(await testChain(name));
  }

  console.log("\n" + "=".repeat(120));
  console.log("SUMMARY");
  console.log("=".repeat(120));
  console.log(
    "Chain".padEnd(10) +
      "Status".padEnd(12) +
      "AddrMatch".padEnd(11) +
      "SwapTargets".padEnd(13) +
      "BackendSig".padEnd(12) +
      "Address",
  );
  console.log("-".repeat(120));
  for (const r of results) {
    console.log(
      r.name.padEnd(10) +
        r.status.padEnd(12) +
        String(r.addressMatch).padEnd(11) +
        `${r.swapTargetsRegistered}/${r.swapTargetsTotal}`.padEnd(13) +
        String(r.backendSignerSet).padEnd(12) +
        r.address,
    );
    if (r.error) console.log(`  -> ${r.error}`);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.length - pass;
  console.log(`\n${pass} PASS (full dry-run succeeded on fork), ${fail} FAIL/OTHER`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
