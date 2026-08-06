/**
 * testForkDeployV2.ts
 *
 * Local-fork dry run of the v2.0 OkuRouter deployment across all 17 chains
 * that currently have a live (v1.2) deployment. For each chain:
 *
 *   1. Reset the Hardhat network to a fresh fork of that chain (via its
 *      real RPC URL, resolved the same way hardhat.config.ts resolves it).
 *   2. Impersonate the real dev wallet (0x3CB68a67...) -- NO balance
 *      manipulation. Whatever the wallet's real on-chain balance is on
 *      that chain at the forked block is what gets used.
 *   3. Resolve permit2Address from util/deploymentConfig.ts (chain-config
 *      backed) exactly like the real `deploy` task does.
 *   4. Predict the CREATE2 address via the exact same
 *      `predictOkuRouterAddress` helper the real `deploy` task uses.
 *   5. Attempt the real `deployDeterministic` CREATE2 deploy against the
 *      Safe Singleton Factory -- entirely on the local fork. This never
 *      touches the real chain; it's a completely safe way to prove the
 *      deploy pipeline (config resolution, gas estimation, CREATE2 send)
 *      works end-to-end, using the exact code path production uses.
 *   6. If the dev wallet's real balance is insufficient for gas, that is
 *      reported as an explicit, EXPECTED "LOW_FUNDS" result -- not a
 *      failure of the harness.
 *
 * Usage:
 *   npx hardhat run scripts/testForkDeployV2.ts
 *
 * This script runs entirely on local Hardhat forks. It never sends a
 * transaction to a live network.
 */
import hre from "hardhat";
import { formatEther } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { CONTRACT_NAME, CONTRACT_VERSION, SAFE_SINGLETON_FACTORY } from "../util/contractMeta";
import { getNetworkConfig } from "../util/deploymentConfig";
import { predictOkuRouterAddress, deployDeterministic } from "../tasks/deploy";

const DEV_WALLET = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// The 17 chains with a live (v1.2) OkuRouter deployment today, per
// deployments/*.json. Hardhat network name == deploymentConfig.ts key.
const LEGACY_DEPLOYED_CHAINS = [
  "arbitrum", "base", "boba", "bsc", "filecoin", "gensyn", "hemi",
  "linea", "mantle", "nibiru", "op", "polygon", "redbelly", "robinhood",
  "telos", "unichain", "worldchain",
];

// Fallback RPC to try (in addition to hardhat.config's resolved URL) if the
// primary is unreachable from this environment. This only affects the local
// test harness's RPC selection -- it does not change hardhat.config.ts or
// the real deploy task.
const FALLBACK_RPC: Record<string, string> = {
  bsc: `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ""}`,
};

// Chains whose public RPC is known to be incompatible with Hardhat's fork
// mechanism (independent of our deploy logic):
//   - filecoin: FEVM's eth_getBlockByNumber response includes non-standard
//     field shapes (e.g. stateRoot) that Hardhat's strict block parser
//     rejects during forking.
//   - redbelly: its RPC does not implement `net_version`, which Hardhat's
//     forking bootstrap calls to detect the chain ID.
// These are harness/RPC-compatibility limitations, not failures of the
// deploy pipeline itself (the real `deploy` task talks to these chains via
// plain ethers.js JSON-RPC calls, not Hardhat's fork machinery).
const FORK_INCOMPATIBLE: Record<string, string> = {
  filecoin: "Hardhat fork's block parser rejects Filecoin FEVM's non-standard eth_getBlockByNumber response shape",
  redbelly: "Redbelly's RPC does not implement net_version, which Hardhat's fork bootstrap requires",
};

type Status = "PASS" | "LOW_FUNDS" | "FAIL" | "FORK_FAIL" | "NO_RPC" | "FORK_INCOMPATIBLE";

interface Result {
  name: string;
  status: Status;
  address: string;
  balance: string;
  permit2: string;
  canonicalPermit2: boolean;
  error: string | null;
}

async function testChain(name: string): Promise<Result> {
  const netConfig = (hre.config.networks as any)[name];
  const primaryRpcUrl: string | undefined = netConfig?.url;

  if (!primaryRpcUrl || primaryRpcUrl === "0000000000000000000000000000000000000000000000000000000000000000") {
    return { name, status: "NO_RPC", address: "", balance: "N/A", permit2: "", canonicalPermit2: false, error: "No RPC URL configured" };
  }

  let cfg;
  try {
    cfg = getNetworkConfig(name);
  } catch (e: any) {
    return { name, status: "FAIL", address: "", balance: "N/A", permit2: "", canonicalPermit2: false, error: `getNetworkConfig failed: ${e.message}` };
  }

  if (FORK_INCOMPATIBLE[name]) {
    console.log(`\n--- Skipping ${name} fork (known Hardhat fork/RPC incompatibility) ---`);
    return { name, status: "FORK_INCOMPATIBLE", address: "", balance: "N/A", permit2: cfg.permit2Address, canonicalPermit2: cfg.canonicalPermit2, error: FORK_INCOMPATIBLE[name] };
  }

  const candidateUrls = [primaryRpcUrl, FALLBACK_RPC[name]].filter(Boolean) as string[];

  try {
    console.log(`\n--- Forking ${name} (chainId: ${cfg.chainId}) ---`);
    let forkOk = false;
    let lastErr: any;
    for (const url of candidateUrls) {
      // Retry each candidate URL up to 2x (transient public-RPC pruning /
      // rate-limit issues resolve on retry more often than not).
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await hre.network.provider.request({
            method: "hardhat_reset",
            params: [{ forking: { jsonRpcUrl: url, blockNumber: undefined } }],
          });
          await hre.ethers.provider.getBlockNumber(); // confirm fork is actually usable
          forkOk = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (forkOk) break;
    }
    if (!forkOk) throw lastErr;

    const balance = await hre.ethers.provider.getBalance(DEV_WALLET);
    const balanceStr = `${formatEther(balance)} ${cfg.nativeSymbol}`;
    console.log(`  Dev wallet:  ${DEV_WALLET}`);
    console.log(`  Balance:     ${balanceStr}`);
    console.log(`  Permit2:     ${cfg.permit2Address} (canonical=${cfg.canonicalPermit2})`);

    const factoryCode = await hre.ethers.provider.getCode(SAFE_SINGLETON_FACTORY);
    if (factoryCode === "0x") {
      return { name, status: "FAIL", address: "", balance: balanceStr, permit2: cfg.permit2Address, canonicalPermit2: cfg.canonicalPermit2, error: "Safe Singleton Factory not present on this chain" };
    }

    const { address } = await predictOkuRouterAddress(hre, DEV_WALLET, cfg.permit2Address);
    console.log(`  Predicted:   ${address}`);

    const existingCode = await hre.ethers.provider.getCode(address);
    if (existingCode !== "0x") {
      console.log(`  Already deployed at predicted address (idempotent reuse)`);
      return { name, status: "PASS", address, balance: balanceStr, permit2: cfg.permit2Address, canonicalPermit2: cfg.canonicalPermit2, error: null };
    }

    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET],
    });
    const signer = await hre.ethers.getSigner(DEV_WALLET);

    let result;
    try {
      result = await deployDeterministic(hre, signer, DEV_WALLET, cfg.permit2Address);
    } catch (err: any) {
      const msg = err.message || "";
      if (/insufficient funds|doesn't have enough funds|enough funds to send/i.test(msg)) {
        console.log(`  LOW FUNDS — deploy tx could not be sent: ${msg.slice(0, 150)}`);
        return { name, status: "LOW_FUNDS", address, balance: balanceStr, permit2: cfg.permit2Address, canonicalPermit2: cfg.canonicalPermit2, error: `Insufficient funds (${balanceStr}) — address prediction confirmed` };
      }
      throw err;
    } finally {
      await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [DEV_WALLET],
      });
    }

    const contract = OkuRouter__factory.connect(result.address, signer);
    const onChainName = await contract.name();
    const onChainVersion = await contract.version();
    const onChainOwner = await contract.owner();
    console.log(`  Deployed:    ${onChainName} v${onChainVersion}`);
    console.log(`  Owner:       ${onChainOwner}`);

    return { name, status: "PASS", address: result.address, balance: balanceStr, permit2: cfg.permit2Address, canonicalPermit2: cfg.canonicalPermit2, error: null };
  } catch (err: any) {
    const msg = err.message?.slice(0, 200) || "Unknown error";
    console.log(`  ERROR: ${msg}`);
    return { name, status: "FORK_FAIL", address: "", balance: "N/A", permit2: "", canonicalPermit2: false, error: msg };
  }
}

async function main() {
  console.log("=".repeat(90));
  console.log("Local Fork Deploy Test (v2.0) — 17 legacy-deployed chains");
  console.log("=".repeat(90));
  console.log(`Contract:   ${CONTRACT_NAME} v${CONTRACT_VERSION}`);
  console.log(`Dev wallet: ${DEV_WALLET} (impersonated, NOT funded)`);
  console.log("=".repeat(90));

  const results: Result[] = [];
  for (const name of LEGACY_DEPLOYED_CHAINS) {
    results.push(await testChain(name));
  }

  console.log("\n" + "=".repeat(90));
  console.log("RESULTS");
  console.log("=".repeat(90));
  console.log(
    "Chain".padEnd(12) + "Status".padEnd(12) + "Balance".padEnd(26) + "Canon".padEnd(7) + "Address"
  );
  console.log("-".repeat(90));
  for (const r of results) {
    console.log(
      r.name.padEnd(12) +
        r.status.padEnd(12) +
        r.balance.padEnd(26) +
        (r.canonicalPermit2 ? "yes" : "no").padEnd(7) +
        (r.address || "(none)")
    );
    if (r.error) console.log(`  -> ${r.error}`);
  }

  const byAddress: Record<string, string[]> = {};
  for (const r of results) {
    if (r.address) {
      byAddress[r.address] = byAddress[r.address] || [];
      byAddress[r.address].push(r.name);
    }
  }
  console.log("\nAddress groupings:");
  for (const [addr, names] of Object.entries(byAddress)) {
    console.log(`  ${addr} => ${names.join(", ")}`);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const lowFunds = results.filter((r) => r.status === "LOW_FUNDS").length;
  const fail = results.filter((r) => r.status === "FAIL" || r.status === "FORK_FAIL" || r.status === "NO_RPC").length;
  console.log(`\n${pass} PASS, ${lowFunds} LOW_FUNDS (expected/valid), ${fail} FAIL`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
