/**
 * deploymentsRegistry.ts
 *
 * On-disk registry of the currently-live OkuRouter / Permit2Proxy deployments,
 * one JSON file per network at `deployments/<networkName>.json`.
 *
 * Goals:
 *   - Auto-logged: the deploy tasks call recordDeployment() after every
 *     successful deploy. No manual config edits.
 *   - Active-only: this file tracks ONLY the currently-live deployment for
 *     each contract on each chain. Historical / deprecated addresses are NOT
 *     kept here -- they live in git history and (for OkuRouter) in the
 *     immutable on-chain trail. The on-disk file should always reflect the
 *     truth of what is live right now.
 *   - Sync I/O: the consumer code in networkConfig.ts builds the static
 *     config object at module-load time, so the registry must be readable
 *     synchronously (fs.readFileSync, not async).
 *
 * Schema (one file per network):
 *   {
 *     "networkName": "worldchain",
 *     "chainId": 480,
 *     "current": {
 *       "OkuRouter": {
 *         "address": "0x...",
 *         "version": "1.1",
 *         "owner":   "0x..."         // current on-chain owner() (post any transferOwnership)
 *       },
 *       "Permit2Proxy": {            // worldchain-only; do NOT add to other networks
 *         "address":   "0x...",
 *         "okuRouter": "0x..."       // the OkuRouter this proxy is bonded to (immutable in bytecode)
 *       }
 *     }
 *   }
 *
 * Field rules (enforced by recordDeployment()):
 *   - OkuRouter entries: `address`, `version`, `owner` are required.
 *   - Permit2Proxy entries: `address`, `okuRouter` are required; `owner` is
 *     omitted (the contract is not Ownable).
 *   - Permit2Proxy is intentionally only tracked on worldchain. Do not add
 *     a Permit2Proxy entry to other networks' files.
 */
import * as fs from "fs";
import * as path from "path";

/** Contract identifiers tracked in the registry. */
export type ContractKind = "OkuRouter" | "Permit2Proxy";

/**
 * A live deployment entry. Field presence depends on `contract`:
 *   - OkuRouter:    address, version, owner are required.
 *   - Permit2Proxy: address, okuRouter are required; owner is absent.
 */
export interface DeploymentEntry {
  /** Checksummed contract address. */
  address: string;
  /** Semantic version for OkuRouter (e.g. "1.1"); omitted for Permit2Proxy. */
  version?: string;
  /**
   * Current on-chain owner() at write time. Required for Ownable contracts
   * (OkuRouter). Omitted for non-Ownable contracts (Permit2Proxy). Refresh
   * this field after any transferOwnership / acceptOwnership cycle so the
   * file matches the chain.
   */
  owner?: string;
  /**
   * For Permit2Proxy: the OkuRouter address it forwards to (baked into
   * bytecode at construction time, so this address can never change).
   */
  okuRouter?: string;
}

export interface NetworkRegistry {
  networkName: string;
  chainId: number;
  /** Map of contract kind -> currently-live entry. No history is kept. */
  current: Partial<Record<ContractKind, DeploymentEntry>>;
}

/** Where the JSON files live. Resolved relative to the repo root. */
const REGISTRY_DIR = path.resolve(__dirname, "..", "deployments");

function registryPath(networkName: string): string {
  return path.join(REGISTRY_DIR, `${networkName}.json`);
}

/**
 * Read the registry for a network. Returns an empty shell (no `chainId` set,
 * empty current) if the file doesn't exist yet, so callers can unconditionally
 * read before a chain has been deployed to.
 */
export function readRegistry(networkName: string, chainId?: number): NetworkRegistry {
  const file = registryPath(networkName);
  if (!fs.existsSync(file)) {
    return {
      networkName,
      chainId: chainId ?? 0,
      current: {},
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as NetworkRegistry;
  // Defensive: ensure required container exists even on hand-edited files.
  parsed.current = parsed.current ?? {};
  return parsed;
}

/**
 * Convenience accessor for consumers that just want the address of whatever
 * is currently live on a chain. Returns undefined if the chain hasn't been
 * deployed to yet, so callers can distinguish "not deployed" from "deployed
 * at the zero address".
 *
 * Kept as a string-returning shim so downstream callers (networkConfig
 * consumers, predictAddress, testRouters, canoeHelper) don't have to learn
 * about the entry shape.
 */
export function getCurrentAddress(
  networkName: string,
  contract: ContractKind
): string | undefined {
  const reg = readRegistry(networkName);
  return reg.current[contract]?.address;
}

/**
 * Returns the full current entry (address + metadata) for a contract on a
 * chain, or undefined if not deployed. Used by deployPermit2Proxy.ts to
 * read the OkuRouter `version` and refuse to bond to a stale router.
 */
export function getCurrentEntry(
  networkName: string,
  contract: ContractKind
): DeploymentEntry | undefined {
  const reg = readRegistry(networkName);
  return reg.current[contract];
}

/**
 * Overwrite the current entry for a contract on a network and persist.
 *
 * There is no history bookkeeping: a redeploy simply replaces the previous
 * entry. The previous address is not preserved in this file -- it lives in
 * git history of the JSON file itself.
 *
 * Safe to call when the file doesn't exist yet; it will be created.
 *
 * Field validation:
 *   - OkuRouter:    requires address, version, owner.
 *   - Permit2Proxy: requires address, okuRouter; rejects owner (not Ownable).
 */
export function recordDeployment(
  networkName: string,
  chainId: number,
  contract: ContractKind,
  entry: DeploymentEntry,
): NetworkRegistry {
  validateEntry(contract, entry);

  const reg = readRegistry(networkName, chainId);
  reg.chainId = chainId; // keep up to date in case the file was seeded with 0
  reg.current[contract] = entry;

  writeRegistry(reg);
  return reg;
}

function validateEntry(contract: ContractKind, entry: DeploymentEntry): void {
  if (!entry.address) {
    throw new Error(`recordDeployment(${contract}): address is required`);
  }
  if (contract === "OkuRouter") {
    if (!entry.version) {
      throw new Error("recordDeployment(OkuRouter): version is required");
    }
    if (!entry.owner) {
      throw new Error("recordDeployment(OkuRouter): owner is required");
    }
    if (entry.okuRouter !== undefined) {
      throw new Error("recordDeployment(OkuRouter): okuRouter field is only valid for Permit2Proxy");
    }
  } else if (contract === "Permit2Proxy") {
    if (!entry.okuRouter) {
      throw new Error("recordDeployment(Permit2Proxy): okuRouter is required");
    }
    if (entry.owner !== undefined) {
      throw new Error("recordDeployment(Permit2Proxy): contract is not Ownable; owner must be omitted");
    }
    if (entry.version !== undefined) {
      throw new Error(
        "recordDeployment(Permit2Proxy): version is implied by the bonded OkuRouter; omit it",
      );
    }
  }
}

/** Atomic write: stringify -> write tmp -> rename. Throws on FS failure. */
function writeRegistry(reg: NetworkRegistry): void {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  }
  const file = registryPath(reg.networkName);
  const tmp = `${file}.tmp`;
  // 2-space indent matches the rest of the repo's JSON style and produces
  // readable PR diffs.
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * For test harness use only: clear the in-process state. The registry is
 * pure disk I/O so there's no cache to invalidate today, but exporting
 * this stub future-proofs against adding one.
 */
export function _resetRegistryCache(): void {
  // no-op for now
}
