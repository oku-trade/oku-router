/**
 * contractMeta.ts
 *
 * Single source of truth for contract identifiers used by deterministic
 * (CREATE2) deployments. Anything that participates in computing or
 * predicting an on-chain address MUST import these constants and the
 * salt helpers below instead of redefining them locally.
 *
 * Why this file exists:
 *   - The CREATE2 address of a contract is a pure function of
 *     (factory address, salt, keccak256(initCode)). If two scripts in this
 *     repo disagree on any of those inputs, they disagree on the predicted
 *     address. Centralizing salts + version eliminates that drift.
 *
 * Version policy:
 *   - Bump CONTRACT_VERSION whenever you intentionally want a new
 *     deterministic address (e.g. ABI change, behavioral change, audit
 *     boundary). The previous version's address becomes immutable history.
 */
import { keccak256, toUtf8Bytes, solidityPacked, getAddress } from "ethers";

/** Human-readable contract name baked into the `OkuRouter` constructor. */
export const CONTRACT_NAME = "Oku Router";

/**
 * Deployment version.
 *
 * - "1.0" was the originally-audited deployment with `withdrawToken` and
 *   `withdrawEth`. Those entries live in deployments/<network>.json under
 *   `history` with `deprecated: true`.
 * - "1.1" replaces them with `sweepAll(tokens, includeEth, to)`. Same
 *   audited shape otherwise.
 */
export const CONTRACT_VERSION = "1.1";

/**
 * Safe Singleton Factory — canonical CREATE2 deployer present on all major
 * EVM chains at the same address. See https://github.com/safe-global/safe-singleton-factory
 */
export const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";

/**
 * Salt used for OkuRouter CREATE2 deployments.
 *
 * Format: keccak256("<name>+<version>")
 *
 * Bumping CONTRACT_VERSION is the supported way to invalidate this salt
 * and force a new deterministic address.
 */
export function getOkuRouterSalt(version: string = CONTRACT_VERSION): string {
  return keccak256(toUtf8Bytes(`${CONTRACT_NAME}+${version}`));
}

/**
 * Salt used for Permit2Proxy CREATE2 deployments.
 *
 * Format: keccak256("Permit2Proxy+<okuRouter address>")
 *
 * Binding the salt to the router address means a proxy deployed against a
 * stale router cannot collide with one deployed against the current router.
 * Cross-chain parity is preserved because the OkuRouter address itself is
 * the same on every chain (it's CREATE2-deterministic too).
 */
export function getPermit2ProxySalt(okuRouterAddress: string): string {
  // Normalize to checksum form so a casing difference can't fork the salt.
  const normalized = getAddress(okuRouterAddress);
  return keccak256(toUtf8Bytes(`Permit2Proxy+${normalized}`));
}

/**
 * Pure helper that computes a CREATE2 address from its inputs without
 * touching the network. Used by both the deploy task (to predict before
 * sending the tx) and the predictAddress script.
 *
 * Formula: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
 */
export function computeCreate2Address(
  factory: string,
  salt: string,
  initCodeHash: string
): string {
  const packed = solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", factory, salt, initCodeHash]
  );
  return getAddress("0x" + keccak256(packed).slice(-40));
}
