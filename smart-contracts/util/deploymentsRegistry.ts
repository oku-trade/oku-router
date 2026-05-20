/**
 * deploymentsRegistry.ts
 *
 * On-disk registry of all OkuRouter / Permit2Proxy deployments, one JSON
 * file per network at `deployments/<networkName>.json`.
 *
 * Goals:
 *   - Auto-logged: the deploy tasks call recordDeployment() after every
 *     successful CREATE2 deploy. No manual config edits.
 *   - Append-only history: deprecating an entry preserves it for auditing,
 *     event indexing, and user off-ramping. The `current` map is the only
 *     thing consumers should treat as authoritative for new traffic.
 *   - Sync I/O: the consumer code in networkConfig.ts builds the static
 *     config object at module-load time, so the registry must be readable
 *     synchronously (fs.readFileSync, not async).
 *
 * Schema (one file per network):
 *   {
 *     "networkName": "worldchain",
 *     "chainId": 480,
 *     "current": {
 *       "OkuRouter": "0x...",
 *       "Permit2Proxy": "0x..."
 *     },
 *     "history": [
 *       {
 *         "contract": "OkuRouter",
 *         "version": "1.0",
 *         "address": "0x...",
 *         "deploymentBlock": 22351271,
 *         "txHash": "0x...",            // may be null for legacy seed entries
 *         "deployer": "0x...",          // may be null for legacy seed entries
 *         "deployedAt": "2025-11-18T00:00:00Z",
 *         "deprecated": true,
 *         "notes": "Pre-sweepAll. withdrawToken/withdrawEth ABI.",
 *         "okuRouter": "0x..."          // present only for Permit2Proxy entries
 *       }
 *     ]
 *   }
 */
import * as fs from "fs";
import * as path from "path";

/** Contract identifiers tracked in the registry. */
export type ContractKind = "OkuRouter" | "Permit2Proxy";

export interface DeploymentEntry {
  contract: ContractKind;
  /** Semantic version for OkuRouter; omitted for Permit2Proxy (its salt is the bonded router addr). */
  version?: string;
  address: string;
  /** Block at which the contract was created; useful for backend event indexing. */
  deploymentBlock: number | null;
  txHash: string | null;
  deployer: string | null;
  /** ISO-8601 UTC timestamp. */
  deployedAt: string | null;
  /** Latest deployment of a given contract is `false`; older entries flip to `true`. */
  deprecated: boolean;
  /** For Permit2Proxy: the OkuRouter address it forwards to (immutable in bytecode). */
  okuRouter?: string;
  /** Free-form note attached at deploy time (e.g. audit cycle, breaking-change summary). */
  notes?: string;
}

export interface NetworkRegistry {
  networkName: string;
  chainId: number;
  /** Map of contract kind -> latest, non-deprecated address. */
  current: Partial<Record<ContractKind, string>>;
  history: DeploymentEntry[];
}

/** Where the JSON files live. Resolved relative to the repo root. */
const REGISTRY_DIR = path.resolve(__dirname, "..", "deployments");

function registryPath(networkName: string): string {
  return path.join(REGISTRY_DIR, `${networkName}.json`);
}

/**
 * Read the registry for a network. Returns an empty shell (no `chainId` set,
 * empty history, empty current) if the file doesn't exist yet, so callers can
 * unconditionally read before a chain has been deployed to.
 */
export function readRegistry(networkName: string, chainId?: number): NetworkRegistry {
  const file = registryPath(networkName);
  if (!fs.existsSync(file)) {
    return {
      networkName,
      chainId: chainId ?? 0,
      current: {},
      history: [],
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as NetworkRegistry;
  // Defensive: ensure required containers exist even on hand-edited files.
  parsed.current = parsed.current ?? {};
  parsed.history = parsed.history ?? [];
  return parsed;
}

/**
 * Convenience accessor for consumers (networkConfig.ts, deploy scripts) that
 * just want the address of whatever is currently live on a chain.
 *
 * Returns `undefined` if the chain hasn't been deployed to yet, so callers
 * can distinguish "not deployed" from "deployed at the zero address".
 */
export function getCurrentAddress(
  networkName: string,
  contract: ContractKind
): string | undefined {
  const reg = readRegistry(networkName);
  return reg.current[contract];
}

/** Returns the most recent (deprecated or not) entry of a given kind, or undefined. */
export function getLatestEntry(
  networkName: string,
  contract: ContractKind
): DeploymentEntry | undefined {
  const reg = readRegistry(networkName);
  // history is appended chronologically; scan from the end.
  for (let i = reg.history.length - 1; i >= 0; i--) {
    if (reg.history[i].contract === contract) return reg.history[i];
  }
  return undefined;
}

/**
 * Atomically record a new deployment:
 *   1. Mark any previous entry of the same contract kind as deprecated.
 *   2. Append the new entry to history.
 *   3. Update the `current` map.
 *   4. Write the file via tmp-rename to avoid leaving a half-written JSON
 *      on disk if the process is killed mid-write.
 *
 * Safe to call when the file doesn't exist yet; it will be created.
 */
export function recordDeployment(
  networkName: string,
  chainId: number,
  entry: Omit<DeploymentEntry, "deprecated"> & { deprecated?: boolean }
): NetworkRegistry {
  const reg = readRegistry(networkName, chainId);
  reg.chainId = chainId; // keep up to date in case the file was seeded with 0

  // Deprecate every prior non-deprecated entry of this contract kind. We
  // deprecate ALL of them (not just the latest) because in theory a manual
  // edit could leave multiple non-deprecated entries; we treat that as a
  // bug we silently fix on next deploy.
  for (const h of reg.history) {
    if (h.contract === entry.contract && !h.deprecated) {
      h.deprecated = true;
    }
  }

  const newEntry: DeploymentEntry = { deprecated: false, ...entry };
  reg.history.push(newEntry);
  reg.current[entry.contract] = entry.address;

  writeRegistry(reg);
  return reg;
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
