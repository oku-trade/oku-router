/**
 * safeTx.ts
 *
 * Safe transaction construction, EIP-712 hashing, signature packing and
 * MultiSend batching.
 *
 * Why hand-rolled instead of @safe-global/protocol-kit
 * ----------------------------------------------------
 * 12 of the 34 chains we deploy to have no Safe Transaction Service, and
 * several run RPC nodes that mishandle batched JSON-RPC payloads (see the
 * batchMaxCount note in tasks/whitelistSwapTargets.ts). The SDK is built
 * around the hosted service and its own provider abstraction, so on those
 * chains we would end up bypassing it anyway. The SafeTx EIP-712 struct has
 * been stable since v1.0.0 and is ~40 lines to implement, so implementing it
 * directly keeps one code path for all 34 chains and adds no dependency.
 *
 * The correctness risk of hand-rolling is fully retired by
 * `verifySafeTxHashOnChain()`, which compares our locally computed hash
 * against the Safe's own `getTransactionHash()` view. The build task runs that
 * check on every chain before any signature is collected, so a mismatch is
 * caught before a signer ever touches a device.
 */
import {
  AbiCoder,
  Interface,
  Signature,
  TypedDataEncoder,
  ZeroAddress,
  concat,
  getAddress,
  hexlify,
  recoverAddress,
  solidityPacked,
} from "ethers";
import type { Provider, TypedDataDomain, TypedDataField } from "ethers";
import { SAFE_MULTISEND_CALL_ONLY } from "./safeConfig";

/** Safe `Enum.Operation`. */
export enum SafeOperation {
  Call = 0,
  DelegateCall = 1,
}

/**
 * The 10 fields covered by the SafeTx EIP-712 struct. Everything here is
 * signed, so any change invalidates existing signatures.
 */
export interface SafeTransactionData {
  to: string;
  value: bigint;
  data: string;
  operation: SafeOperation;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

/**
 * EIP-712 type definition for SafeTx. Field order must match the contract's
 * SAFE_TX_TYPEHASH exactly.
 */
export const SAFE_TX_TYPES: Record<string, TypedDataField[]> = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/** ABI surface used against a deployed Safe. */
export const SAFE_IFACE = new Interface([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function isOwner(address owner) view returns (bool)",
  "function VERSION() view returns (string)",
  "function domainSeparator() view returns (bytes32)",
  "function getStorageAt(uint256 offset,uint256 length) view returns (bytes)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "function approveHash(bytes32 hashToApprove)",
  "function approvedHashes(address owner,bytes32 hash) view returns (uint256)",
  "function addOwnerWithThreshold(address owner,uint256 _threshold)",
  "function swapOwner(address prevOwner,address oldOwner,address newOwner)",
  "function changeThreshold(uint256 _threshold)",
]);

/** MultiSendCallOnly v1.4.1. */
export const MULTISEND_IFACE = new Interface([
  "function multiSend(bytes transactions) payable",
]);

/**
 * Build a SafeTx with the gas-refund machinery zeroed out.
 *
 * safeTxGas / baseGas / gasPrice / gasToken / refundReceiver all zero means
 * "no refund accounting": the executor simply pays gas from its own balance
 * and is never reimbursed by the Safe. That is exactly our model -- the hot
 * deployer EOA relays and eats the gas -- and it keeps the signed payload
 * independent of gas conditions, so a signature stays valid regardless of how
 * long it sits or how the chain's fee market moves.
 *
 * A zero `safeTxGas` also means `execTransaction` forwards all remaining gas
 * to the inner call, which avoids having to estimate per-chain gas for the
 * inner OkuRouter admin call at signing time.
 */
export function buildSafeTx(params: {
  to: string;
  data: string;
  nonce: bigint;
  value?: bigint;
  operation?: SafeOperation;
}): SafeTransactionData {
  return {
    to: getAddress(params.to),
    value: params.value ?? 0n,
    data: params.data,
    operation: params.operation ?? SafeOperation.Call,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZeroAddress,
    refundReceiver: ZeroAddress,
    nonce: params.nonce,
  };
}

/**
 * The EIP-712 domain for a Safe.
 *
 * Only chainId and verifyingContract -- no name, no version. This is why the
 * same logical action must be signed once per chain: chainId is inside the
 * domain, so a signature for chain A is cryptographically invalid on chain B.
 * That is a feature (no cross-chain replay), and it is the reason there is no
 * way to collapse 34 chains into one signature with a stock Safe.
 */
export function safeDomain(chainId: number | bigint, safeAddress: string): TypedDataDomain {
  return {
    chainId: Number(chainId),
    verifyingContract: getAddress(safeAddress),
  };
}

/** Locally compute the SafeTx hash (the digest each owner signs). */
export function hashSafeTx(
  chainId: number | bigint,
  safeAddress: string,
  tx: SafeTransactionData,
): string {
  return TypedDataEncoder.hash(safeDomain(chainId, safeAddress), SAFE_TX_TYPES, tx);
}

/**
 * Cross-check our local EIP-712 implementation against the Safe's own view
 * function. Cheap insurance: if these ever disagree, every signature we
 * collect would be worthless, so we fail before asking anyone to sign.
 */
export async function verifySafeTxHashOnChain(
  provider: Provider,
  chainId: number | bigint,
  safeAddress: string,
  tx: SafeTransactionData,
): Promise<{ local: string; onChain: string; match: boolean }> {
  const local = hashSafeTx(chainId, safeAddress, tx);
  const raw = await provider.call({
    to: getAddress(safeAddress),
    data: SAFE_IFACE.encodeFunctionData("getTransactionHash", [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      tx.nonce,
    ]),
  });
  const [onChain] = SAFE_IFACE.decodeFunctionResult("getTransactionHash", raw);
  return { local, onChain, match: local.toLowerCase() === String(onChain).toLowerCase() };
}

/**
 * Encode a batch for MultiSendCallOnly.
 *
 * Wire format is a tightly packed (NOT abi-encoded) concatenation of
 *   operation:uint8 ++ to:address ++ value:uint256 ++ dataLength:uint256 ++ data
 * per sub-call. `operation` is always 0 here: MultiSendCallOnly reverts on
 * DELEGATECALL, which is the property we want -- a batch can never be used to
 * delegatecall into the Safe's own storage.
 */
export function encodeMultiSend(
  calls: readonly { to: string; data: string; value?: bigint }[],
): string {
  if (calls.length === 0) {
    throw new Error("encodeMultiSend: no calls provided");
  }
  const encoded = calls.map((c) =>
    solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [0, getAddress(c.to), c.value ?? 0n, (c.data.length - 2) / 2, c.data],
    ),
  );
  return MULTISEND_IFACE.encodeFunctionData("multiSend", [concat(encoded)]);
}

/**
 * Wrap a set of calls into a single SafeTx, using MultiSend only when there
 * is more than one call.
 *
 * Batching matters a lot here: whitelisting N swap targets on a chain becomes
 * one signature instead of N, which is the difference between a tolerable and
 * an intolerable hardware-wallet ceremony at 34 chains.
 *
 * The batch wrapper MUST be a DELEGATECALL into MultiSendCallOnly. That is
 * counter-intuitive but load-bearing: delegatecall runs the MultiSend loop in
 * the Safe's own context, so each sub-call is made BY the Safe and arrives at
 * OkuRouter with `msg.sender == Safe`. Every OkuRouter admin function is
 * `onlyOwner`, so a plain CALL into MultiSendCallOnly would make the
 * sub-calls originate from the MultiSend contract and revert with
 * `Ownable: caller is not the owner`.
 *
 * Safety is preserved by the choice of *which* MultiSend: the `CallOnly`
 * variant hard-rejects any sub-call with operation != 0, so even though we
 * delegatecall into it, the batch cannot delegatecall onward into the Safe's
 * storage. This is the same pairing Safe{Wallet} uses by default.
 */
export function buildBatchedSafeTx(
  calls: readonly { to: string; data: string; value?: bigint }[],
  nonce: bigint,
): SafeTransactionData {
  if (calls.length === 1) {
    return buildSafeTx({
      to: calls[0].to,
      data: calls[0].data,
      value: calls[0].value ?? 0n,
      nonce,
    });
  }
  return buildSafeTx({
    to: SAFE_MULTISEND_CALL_ONLY,
    data: encodeMultiSend(calls),
    nonce,
    operation: SafeOperation.DelegateCall,
  });
}

/**
 * Pack owner signatures into the `signatures` blob `execTransaction` expects.
 *
 * Safe iterates the blob in ascending owner-address order and requires the
 * recovered signers to be strictly increasing, so the sort is mandatory --
 * an unsorted blob reverts with GS026 even when every signature is valid.
 *
 * Each entry is 65 bytes: r ++ s ++ v. For EIP-712 signatures v stays 27/28.
 * (Safe adds 4 to v to denote an eth_sign/EIP-191 payload; we always sign
 * typed data, so we never do that.)
 */
export function packSignatures(
  sigs: readonly { signer: string; signature: string }[],
): string {
  if (sigs.length === 0) {
    throw new Error("packSignatures: no signatures provided");
  }
  const seen = new Set<string>();
  for (const s of sigs) {
    const key = getAddress(s.signer).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`packSignatures: duplicate signature from ${s.signer}`);
    }
    seen.add(key);
  }
  const sorted = [...sigs].sort((a, b) =>
    BigInt(getAddress(a.signer)) < BigInt(getAddress(b.signer)) ? -1 : 1,
  );
  return concat(
    sorted.map((s) => {
      // Normalizes 0/1 style v values and rejects malformed input.
      const parsed = Signature.from(s.signature);
      return concat([parsed.r, parsed.s, hexlify(Uint8Array.from([parsed.v]))]);
    }),
  );
}

/**
 * Recover the signer of a SafeTx signature.
 *
 * SafeTx signatures are produced over the raw EIP-712 digest (not
 * personal-sign wrapped), so recovery is a plain `recoverAddress` over the
 * safeTxHash. Used at merge time so a mislabeled or corrupted signature file
 * is rejected locally instead of costing 34 reverted transactions.
 */
export function recoverSafeTxSigner(safeTxHash: string, signature: string): string {
  return getAddress(recoverAddress(safeTxHash, Signature.from(signature)));
}

/** Human-readable one-line summary of a SafeTx, for logs and sign-off. */
export function describeSafeTx(tx: SafeTransactionData): string {
  const dataLen = (tx.data.length - 2) / 2;
  return (
    `to=${tx.to} value=${tx.value} op=${SafeOperation[tx.operation]} ` +
    `nonce=${tx.nonce} dataLen=${dataLen} selector=${tx.data.slice(0, 10)}`
  );
}

/** Decode the ABI-encoded revert reason from a failed `eth_call`, if present. */
export function decodeRevert(data: string): string | undefined {
  if (!data || data === "0x" || !data.startsWith("0x08c379a0")) return undefined;
  try {
    const [reason] = AbiCoder.defaultAbiCoder().decode(
      ["string"],
      "0x" + data.slice(10),
    );
    return String(reason);
  } catch {
    return undefined;
  }
}
