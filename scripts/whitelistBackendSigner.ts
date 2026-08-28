/**
 * whitelistBackendSigner.ts
 *
 * Backfill: whitelist the production backend warrant signer
 * (`BACKEND_WARRANT_SIGNER` in util/contractMeta.ts) on every already-deployed
 * OkuRouter by calling the owner-only `updateValidSigner(signer, true)`.
 *
 * New/redeployed chains get this automatically via tasks/deploy.ts; this
 * script exists to catch up the chains that were deployed before the signer
 * existed. It is idempotent: any chain where the signer is already whitelisted
 * is skipped, so re-runs (e.g. to retry a chain whose RPC flaked) are safe.
 *
 * For each chain that has a deployments/<name>.json entry it:
 *   1. Resolves the RPC URL exactly like hardhat.config.ts does (via
 *      `hre.config.networks[name].url`), so the same env-var / chain-config
 *      fallbacks apply.
 *   2. Builds an ethers Wallet from the same account key hardhat is
 *      configured with for that network (the deployer EOA that owns every
 *      router).
 *   3. Preflights: asserts `owner() == wallet.address`. `updateValidSigner`
 *      is onlyOwner, so a mismatch means we cannot whitelist here (e.g. the
 *      router was already handed over to the production owner) — reported,
 *      not silently skipped.
 *   4. Honors per-network `gasPrice` (saga mines zero-price txs from a
 *      zero-balance wallet; its config sets gasPrice: 0).
 *   5. Calls `updateValidSigner(signer, true)` and verifies the result.
 *
 * One chain's failure never aborts the rest — failures are collected and
 * printed at the end for targeted retry.
 *
 * Usage:
 *   npx hardhat run scripts/whitelistBackendSigner.ts
 *
 *   # dry run: preflight + report what WOULD be written, send no txs
 *   WHITELIST_DRY_RUN=1 npx hardhat run scripts/whitelistBackendSigner.ts
 *
 *   # limit to a subset of chains (comma-separated hardhat network names)
 *   WHITELIST_ONLY=saga,celo npx hardhat run scripts/whitelistBackendSigner.ts
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { BACKEND_WARRANT_SIGNER } from "../util/contractMeta";
import { getCurrentEntry } from "../util/deploymentsRegistry";
import { getSupportedNetworks } from "../util/deploymentConfig";

const DRY_RUN = !!process.env.WHITELIST_DRY_RUN;
const ONLY = (process.env.WHITELIST_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Status =
  | "ADDED"
  | "ALREADY_SET"
  | "WOULD_ADD" // dry-run
  | "NO_DEPLOYMENT"
  | "NO_RPC"
  | "NOT_OWNER"
  | "ERROR";

interface Result {
  network: string;
  status: Status;
  router: string;
  owner?: string;
  txHash?: string;
  error?: string;
}

/**
 * Resolve the account private key hardhat is configured to use for a given
 * network. Mirrors hardhat.config.ts, where every network's `accounts` is a
 * single-element array holding the deployer key (or the zero-address
 * placeholder when the env var is unset).
 */
function resolveAccountKey(networkName: string): string | undefined {
  const netCfg = (hre.config.networks as any)[networkName];
  const accounts = netCfg?.accounts;
  const key = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof key !== "string") return undefined;
  // hardhat.config.ts uses a 64-hex zero string as the "no key" placeholder.
  if (/^0x?0{64}$/.test(key) || /^0{64}$/.test(key)) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

async function processChain(networkName: string): Promise<Result> {
  const base: Result = { network: networkName, status: "ERROR", router: "" };

  // 1. Deployment must exist.
  const entry = getCurrentEntry(networkName, "OkuRouter");
  if (!entry?.address) {
    return { ...base, status: "NO_DEPLOYMENT" };
  }
  base.router = entry.address;

  // 2. Resolve RPC + gas settings the same way hardhat does.
  const netCfg = (hre.config.networks as any)[networkName];
  const rpcUrl: string | undefined = netCfg?.url;
  if (!rpcUrl) {
    return { ...base, status: "NO_RPC", error: "No url in hardhat network config" };
  }
  const accountKey = resolveAccountKey(networkName);
  if (!accountKey) {
    return { ...base, status: "NO_RPC", error: "No account key configured (env var unset)" };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(accountKey, provider);
  const router = OkuRouter__factory.connect(entry.address, wallet);

  // 3. Idempotency + ownership preflight.
  const already = await router.validSigners(BACKEND_WARRANT_SIGNER);
  if (already) {
    return { ...base, status: "ALREADY_SET", owner: undefined };
  }

  const owner = await router.owner();
  base.owner = owner;
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    return {
      ...base,
      status: "NOT_OWNER",
      error: `owner()=${owner} but signer wallet=${wallet.address}; updateValidSigner is onlyOwner`,
    };
  }

  if (DRY_RUN) {
    return { ...base, status: "WOULD_ADD" };
  }

  // 4. Per-network gas overrides (saga => gasPrice 0).
  const overrides: Record<string, unknown> = {};
  if (netCfg?.gasPrice !== undefined && netCfg.gasPrice !== "auto") {
    overrides.gasPrice = BigInt(netCfg.gasPrice);
  }

  // 5. Write + verify.
  const tx = await router.updateValidSigner(BACKEND_WARRANT_SIGNER, true, overrides);
  const receipt = await tx.wait();
  const nowSet = await router.validSigners(BACKEND_WARRANT_SIGNER);
  if (!nowSet) {
    return { ...base, status: "ERROR", txHash: receipt?.hash, error: "post-write verification returned false" };
  }
  return { ...base, status: "ADDED", txHash: receipt?.hash };
}

async function main() {
  // Target only chains that actually have a deployment. getSupportedNetworks
  // returns every configured network; we filter to those with a JSON entry.
  let networks = getSupportedNetworks().filter(
    (n) => !!getCurrentEntry(n, "OkuRouter")?.address,
  );
  if (ONLY.length) {
    networks = networks.filter((n) => ONLY.includes(n));
  }
  networks.sort();

  console.log(
    `\nWhitelisting backend warrant signer ${BACKEND_WARRANT_SIGNER}` +
      `${DRY_RUN ? "  [DRY RUN — no txs will be sent]" : ""}`,
  );
  console.log(`Target chains (${networks.length}): ${networks.join(", ")}\n`);

  const results: Result[] = [];
  for (const name of networks) {
    process.stdout.write(`  ${name.padEnd(12)} ... `);
    try {
      const r = await processChain(name);
      results.push(r);
      const detail =
        r.txHash ? `[tx ${r.txHash}]` : r.error ? `(${r.error})` : "";
      console.log(`${r.status} ${detail}`);
    } catch (e: any) {
      const r: Result = {
        network: name,
        status: "ERROR",
        router: getCurrentEntry(name, "OkuRouter")?.address ?? "",
        error: e?.shortMessage ?? e?.message ?? String(e),
      };
      results.push(r);
      console.log(`ERROR (${r.error})`);
    }
  }

  // Summary
  const by = (s: Status) => results.filter((r) => r.status === s);
  console.log("\n=== Summary ===");
  console.log(`  added:         ${by("ADDED").length}`);
  console.log(`  would add:     ${by("WOULD_ADD").length}`);
  console.log(`  already set:   ${by("ALREADY_SET").length}`);
  console.log(`  not owner:     ${by("NOT_OWNER").length}`);
  console.log(`  no rpc/key:    ${by("NO_RPC").length}`);
  console.log(`  no deployment: ${by("NO_DEPLOYMENT").length}`);
  console.log(`  errors:        ${by("ERROR").length}`);

  const problems = results.filter(
    (r) => r.status === "ERROR" || r.status === "NOT_OWNER" || r.status === "NO_RPC",
  );
  if (problems.length) {
    console.log("\n⚠ Chains needing attention (safe to re-run after fixing):");
    for (const p of problems) {
      console.log(`  - ${p.network}: ${p.status}${p.error ? ` — ${p.error}` : ""}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\n✓ All targeted chains have the backend signer whitelisted.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
