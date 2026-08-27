/**
 * whitelistUniswapRouters.ts
 *
 * Backfill: whitelist the Uniswap `universalRouter` / `swapRouter02` addresses
 * (from chain-config's `uniswap` block) on already-deployed OkuRouters where
 * they are NOT already covered by `marketRouters.uniswap`.
 *
 * Background: the deploy whitelist (`buildKnownSwapTargets` ->
 * `marketRouterEntries`) reads ONLY `chain.marketRouters`. On almost every
 * chain the UR/SR02 already appear inside `marketRouters.uniswap`, so they're
 * whitelisted at deploy time. Celo is the exception: it has a
 * `uniswap.universalRouter` but an empty `marketRouters.uniswap`, so the UR was
 * never whitelisted. This script closes that gap without redeploying.
 *
 * It is idempotent and safe to re-run: any address already whitelisted (or
 * already present in marketRouters) is skipped. Ownership is preflighted
 * (`updateSwapTargets` is onlyOwner) and each write is verified after mining.
 *
 * Usage:
 *   npx hardhat run scripts/whitelistUniswapRouters.ts
 *   WHITELIST_DRY_RUN=1 npx hardhat run scripts/whitelistUniswapRouters.ts
 *   WHITELIST_ONLY=celo npx hardhat run scripts/whitelistUniswapRouters.ts
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { getCurrentEntry } from "../util/deploymentsRegistry";
import { getSupportedNetworks, getNetworkConfig } from "../util/deploymentConfig";
import { networkByName } from "@gfxlabs/oku-chains";

const DRY_RUN = !!process.env.WHITELIST_DRY_RUN;
const ONLY = (process.env.WHITELIST_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Target {
  label: string; // "universalRouter" | "swapRouter02"
  address: string;
}

interface Result {
  network: string;
  router: string;
  owner?: string;
  added: string[];
  alreadySet: string[];
  txHashes: string[];
  status: "OK" | "WOULD_ADD" | "NO_DEPLOYMENT" | "NO_RPC" | "NOT_OWNER" | "NO_TARGETS" | "ERROR";
  error?: string;
}

function resolveAccountKey(networkName: string): string | undefined {
  const netCfg = (hre.config.networks as any)[networkName];
  const accounts = netCfg?.accounts;
  const key = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof key !== "string") return undefined;
  if (/^0x?0{64}$/.test(key) || /^0{64}$/.test(key)) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

/**
 * Collect the Uniswap UR/SR02 addresses for a chain that are NOT already in
 * the deploy-time `knownSwapTargets` (i.e. not already covered by
 * `marketRouters.uniswap`). These are the addresses that a plain redeploy
 * would miss.
 */
function uniswapGapTargets(networkName: string): Target[] {
  const cfg = getNetworkConfig(networkName);
  const known = new Set(
    cfg.knownSwapTargets.map((t) => t.address.toLowerCase()),
  );
  const uni = (networkByName(cfg.chainName) as any).uniswap ?? {};
  const out: Target[] = [];
  for (const label of ["universalRouter", "swapRouter02"] as const) {
    const addr: string | undefined = uni[label];
    if (addr && !known.has(addr.toLowerCase())) {
      out.push({ label, address: addr });
    }
  }
  return out;
}

async function processChain(networkName: string): Promise<Result> {
  const base: Result = {
    network: networkName,
    router: "",
    added: [],
    alreadySet: [],
    txHashes: [],
    status: "ERROR",
  };

  const entry = getCurrentEntry(networkName, "OkuRouter");
  if (!entry?.address) return { ...base, status: "NO_DEPLOYMENT" };
  base.router = entry.address;

  const targets = uniswapGapTargets(networkName);
  if (targets.length === 0) return { ...base, status: "NO_TARGETS" };

  const netCfg = (hre.config.networks as any)[networkName];
  const rpcUrl: string | undefined = netCfg?.url;
  if (!rpcUrl) return { ...base, status: "NO_RPC", error: "No url in hardhat network config" };
  const accountKey = resolveAccountKey(networkName);
  if (!accountKey) return { ...base, status: "NO_RPC", error: "No account key configured (env var unset)" };

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(accountKey, provider);
  const router = OkuRouter__factory.connect(entry.address, wallet);

  // Filter out any already whitelisted on-chain (idempotency).
  const pending: Target[] = [];
  for (const t of targets) {
    if (await router.swapTargets(t.address)) base.alreadySet.push(`${t.label}:${t.address}`);
    else pending.push(t);
  }
  if (pending.length === 0) return { ...base, status: "OK" };

  const owner = await router.owner();
  base.owner = owner;
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    return {
      ...base,
      status: "NOT_OWNER",
      error: `owner()=${owner} but signer wallet=${wallet.address}; updateSwapTargets is onlyOwner`,
    };
  }

  if (DRY_RUN) {
    return { ...base, status: "WOULD_ADD", added: pending.map((t) => `${t.label}:${t.address}`) };
  }

  const overrides: Record<string, unknown> = {};
  if (netCfg?.gasPrice !== undefined && netCfg.gasPrice !== "auto") {
    overrides.gasPrice = BigInt(netCfg.gasPrice);
  }

  for (const t of pending) {
    const tx = await router.updateSwapTargets(t.address, true, overrides);
    const receipt = await tx.wait();
    const ok = await router.swapTargets(t.address);
    if (!ok) {
      return {
        ...base,
        status: "ERROR",
        txHashes: [...base.txHashes, receipt?.hash ?? ""],
        error: `post-write verification returned false for ${t.label} ${t.address}`,
      };
    }
    base.added.push(`${t.label}:${t.address}`);
    base.txHashes.push(receipt?.hash ?? "");
  }
  return { ...base, status: "OK" };
}

async function main() {
  let networks = getSupportedNetworks().filter(
    (n) => !!getCurrentEntry(n, "OkuRouter")?.address,
  );
  if (ONLY.length) networks = networks.filter((n) => ONLY.includes(n));
  networks.sort();

  console.log(
    `\nWhitelisting Uniswap UR/SR02 gap targets${DRY_RUN ? "  [DRY RUN — no txs will be sent]" : ""}`,
  );
  console.log(`Scanning chains (${networks.length}): ${networks.join(", ")}\n`);

  const results: Result[] = [];
  for (const name of networks) {
    process.stdout.write(`  ${name.padEnd(12)} ... `);
    try {
      const r = await processChain(name);
      results.push(r);
      let detail = "";
      if (r.added.length) detail = `added [${r.added.join(", ")}] tx ${r.txHashes.join(",")}`;
      else if (r.status === "NO_TARGETS") detail = "(no UR/SR02 gap — already covered by marketRouters)";
      else if (r.status === "OK") detail = `(already whitelisted: ${r.alreadySet.join(", ")})`;
      else if (r.error) detail = `(${r.error})`;
      console.log(`${r.status} ${detail}`);
    } catch (e: any) {
      const r: Result = {
        network: name,
        router: getCurrentEntry(name, "OkuRouter")?.address ?? "",
        added: [],
        alreadySet: [],
        txHashes: [],
        status: "ERROR",
        error: e?.shortMessage ?? e?.message ?? String(e),
      };
      results.push(r);
      console.log(`ERROR (${r.error})`);
    }
  }

  console.log("\n=== Summary ===");
  const touched = results.filter((r) => r.added.length);
  console.log(`  chains with writes: ${touched.length}`);
  for (const r of touched) console.log(`    ${r.network}: ${r.added.join(", ")}`);
  const problems = results.filter(
    (r) => r.status === "ERROR" || r.status === "NOT_OWNER" || r.status === "NO_RPC",
  );
  if (problems.length) {
    console.log("\n⚠ Chains needing attention (safe to re-run after fixing):");
    for (const p of problems) console.log(`  - ${p.network}: ${p.status}${p.error ? ` — ${p.error}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ Done. No unresolved problems.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
