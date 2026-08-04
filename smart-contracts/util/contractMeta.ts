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
 *   `withdrawEth`. It is no longer live anywhere; the deployments/<network>.json
 *   files track only the currently-live contract per chain, so v1.0 addresses
 *   only survive in git history.
 * - "1.1" replaces them with `sweepAll(tokens, includeEth, to)`. Same
 *   audited shape otherwise.
 * - "1.2" makes the Permit2 address a constructor argument (stored as an
 *   immutable) instead of a hardcoded constant. This allows correct Permit2
 *   usage on chains with non-canonical deployments. Because the constructor
 *   args now vary per chain (different Permit2 addresses), the CREATE2
 *   address will differ across chains that use different Permit2 contracts.
 * - "1.3" is the Chain Defenders audit-fix boundary (July 2026). Bumped
 *   specifically so the fixed bytecode gets a fresh deterministic address
 *   distinct from the pre-audit "1.2" deployments already live on 17
 *   chains (bumping the CREATE2 salt without changing this string would
 *   otherwise have left two different "1.2" bytecodes with no version
 *   boundary between them). Behavioral changes in this bump:
 *     - Mid-01: Permit2Proxy._forwardAndReturn refunds residual sellToken
 *       and zeroes the leftover router allowance after every call.
 *     - Low-01: fillQuoteEthToToken's warrant dataHash now binds
 *       `msg.value - feeAmount`, so a signed ETH-input size can't be
 *       replayed with a different msg.value.
 *     - Low-02: _validateWarrantDuration guards against underflow on
 *       reversed timestamps (validAfter > validBefore) with a clean
 *       "CANOE: INVALID_TIMESTAMPS" revert instead of an opaque Panic(0x11).
 *     - Info-02: Permit2Proxy.receive() is restricted to `okuRouter` only.
 *   OKU_ROUTER_EIP712_VERSION in canoeHelper.ts MUST be bumped in lockstep
 *   with this constant (see Info-01) or all warrants will fail signature
 *   verification.
 */
export const CONTRACT_VERSION = "1.3";

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
