/**
 * safeConfig.ts
 *
 * Single source of truth for the production Safe (Gnosis Safe) multisig that
 * owns every OkuRouter deployment.
 *
 * Why this file exists
 * --------------------
 * A Safe account is itself a CREATE2-deployed proxy, so its address is a pure
 * function of (proxy factory, singleton, proxy creation code, initializer,
 * saltNonce). To get the SAME Safe address on all 34 chains, every one of
 * those inputs must be byte-identical on every chain. Centralizing them here
 * -- exactly as util/contractMeta.ts does for OkuRouter -- removes any chance
 * of two scripts disagreeing on the predicted address.
 *
 * The owner array ORDER is part of the initializer preimage, and therefore
 * part of the address. Reordering OKU_SAFE_OWNERS silently produces a
 * different Safe. `assertOkuSafeConfig()` guards against that by checking the
 * computed address against a pinned expected value.
 *
 * Contract layer (deployed by Safe, not by us)
 * --------------------------------------------
 * We deploy no Safe contracts. The canonical v1.4.1 singleton, proxy factory,
 * fallback handler and MultiSendCallOnly already exist at identical addresses
 * on all 34 chains we ship OkuRouter to (verified on-chain, see
 * `npx hardhat safe:preflight`). The only thing we deploy is our own Safe
 * *proxy*, once per chain.
 *
 * Known exception: SAFE_TO_L2_SETUP is absent on Gensyn (685689). Because it
 * is referenced by the initializer (`to`), it is part of the address preimage,
 * so we cannot simply drop it there without forking the address. Instead
 * `safe:deploy` deploys the canonical SafeToL2Setup bytecode to its canonical
 * address first (see SAFE_TO_L2_SETUP_CREATION_CODE). Note that
 * @safe-global/safe-deployments does not list Gensyn at all and wrongly lists
 * Telos as lacking SafeToL2Setup -- on-chain `eth_getCode` is the only
 * trustworthy source here, which is why safe:preflight probes rather than
 * trusting a registry.
 */
import {
  AbiCoder,
  Interface,
  ZeroAddress,
  concat,
  getAddress,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import { SAFE_SINGLETON_FACTORY, computeCreate2Address } from "./contractMeta";

// ---------------------------------------------------------------------------
// Canonical Safe v1.4.1 contract addresses
//
// These are Safe's own deployments, present at these exact addresses on all
// 34 chains in deployments/. Do not edit without re-running safe:preflight.
// ---------------------------------------------------------------------------

/** SafeProxyFactory v1.4.1. `createProxyWithNonce` is the deploy entrypoint. */
export const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";

/**
 * Safe v1.4.1 (L1) singleton. This is the singleton passed to
 * `createProxyWithNonce`, and therefore the one baked into the CREATE2
 * preimage, on EVERY chain including L2s.
 *
 * On chains where chainid != 1 the SafeToL2Setup delegatecall in the
 * initializer immediately rewrites storage slot 0 to SAFE_L2_SINGLETON, so
 * the deployed Safe ends up running SafeL2 code. On mainnet the setup is a
 * deliberate no-op and the Safe stays on the L1 singleton. Either way the
 * address is the same, because the address depends on the singleton passed to
 * the factory (always L1), not on the post-setup slot-0 value.
 */
export const SAFE_L1_SINGLETON = "0x41675C099F32341bf84BFc5382aF534df5C7461a";

/**
 * SafeL2 v1.4.1 singleton. Emits per-transaction events, which is what the
 * Safe Transaction Service indexes on non-mainnet chains. Reached via
 * SafeToL2Setup, never passed to the factory directly.
 */
export const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";

/** CompatibilityFallbackHandler v1.4.1 (EIP-1271 + EIP-712 helpers). */
export const SAFE_FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

/**
 * MultiSendCallOnly v1.4.1. Batches N calls into one Safe transaction, i.e.
 * one signature per signer instead of N. `CallOnly` refuses DELEGATECALL
 * sub-calls, which is the variant we want for admin batching -- a batch can
 * never be tricked into delegatecalling into the Safe's own storage.
 */
export const SAFE_MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

/** SafeToL2Setup v1.4.1. See the module docstring for the Gensyn caveat. */
export const SAFE_TO_L2_SETUP = "0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54";

/**
 * SafeProxy v1.4.1 creation code, as returned by
 * `SafeProxyFactory.proxyCreationCode()`.
 *
 * Pinned here so `safe:predict` can compute the address fully offline. It is
 * also re-read from each chain's factory and compared against
 * SAFE_PROXY_CREATION_CODE_HASH during deploy: a chain that has *a* contract
 * at SAFE_PROXY_FACTORY but with different proxy creation code would silently
 * produce a different Safe address, which is exactly the failure mode this
 * check exists to catch. Verified byte-identical on mainnet, op, base, xdc,
 * gensyn, saga and filecoin.
 */
export const SAFE_PROXY_CREATION_CODE =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";

/** keccak256(SAFE_PROXY_CREATION_CODE). */
export const SAFE_PROXY_CREATION_CODE_HASH = keccak256(SAFE_PROXY_CREATION_CODE);

/**
 * SafeToL2Setup v1.4.1 creation code, from
 * @safe-global/safe-contracts@1.4.1-2 (the only published version of that
 * package that ships this artifact -- 1.4.1 and 1.4.1-build.0 do not, and
 * @safe-global/safe-smart-account@1.5.0 ships a different, non-matching
 * build).
 *
 * Embedded rather than taken as a dependency because it is needed for exactly
 * one chain (Gensyn), and because it is self-verifying: deploying it through
 * the Safe Singleton Factory with salt 0 must reproduce SAFE_TO_L2_SETUP.
 * `assertSafeToL2SetupBytecode()` enforces that identity, so a corrupted or
 * substituted literal cannot be deployed.
 */
export const SAFE_TO_L2_SETUP_CREATION_CODE =
  "0x60a060405234801561001057600080fd5b503073ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff1660601b8152505060805160601c61033461006460003980607652506103346000f3fe608060405234801561001057600080fd5b506004361061002b5760003560e01c8063fe51f64314610030575b600080fd5b6100726004803603602081101561004657600080fd5b81019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050610074565b005b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff163073ffffffffffffffffffffffffffffffffffffffff161415610119576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260348152602001806102a96034913960400191505060405180910390fd5b600060055414610174576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806102dd6022913960400191505060405180910390fd5b80600061018082610295565b14156101f4576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252601c8152602001807f4163636f756e7420646f65736e277420636f6e7461696e20636f64650000000081525060200191505060405180910390fd5b60016101fe6102a0565b1461029157816000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055507f75e41bc35ff1bf14d81d1d2f649c0084a0f974f9289c803ec9898eeec4c8d0b882604051808273ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390a15b5050565b6000813b9050919050565b60004690509056fe53616665546f4c3253657475702073686f756c64206f6e6c792062652063616c6c6564207669612064656c656761746563616c6c53616665206d7573742068617665206e6f7420657865637574656420616e79207478a264697066735822122023649cd94e3067c8a913b2bbb4a32dc4fea9be2d0f070a4b7403c3e4e8db452464736f6c63430007060033";

/**
 * Salt used by Safe's own singleton-factory deployments. Safe deploys its
 * helper contracts with an all-zero salt; this is what makes
 * SAFE_TO_L2_SETUP land on its canonical address.
 */
export const SAFE_HELPER_DEPLOY_SALT = zeroPadValue("0x00", 32);

/**
 * `paymentReceiver` used by Safe{Wallet}'s standard creation flow. It is a
 * marker value, not a real recipient: `payment` is 0, so nothing is ever
 * transferred. It matters only because it is part of the initializer, and
 * therefore part of the address.
 */
export const SAFE_PAYMENT_RECEIVER = "0x5afe7A11E7000000000000000000000000000000";

// ---------------------------------------------------------------------------
// The Oku production Safe
// ---------------------------------------------------------------------------

/**
 * The three hardware-wallet signers, in the order they are passed to
 * `setup()`.
 *
 * ORDER IS LOAD-BEARING. It is part of the initializer preimage and therefore
 * part of the Safe address. Never reorder, never reformat, never "sort for
 * tidiness". `assertOkuSafeConfig()` will refuse to proceed if you do.
 *
 * Rotating a signer after deployment is done on-chain via
 * `swapOwner`/`addOwnerWithThreshold` through a normal 2-of-3 Safe
 * transaction; it does NOT change the Safe address, and this constant should
 * then be updated to match reality (it is only consulted for the initial
 * deploy and by safe:preflight's drift check).
 */
export const OKU_SAFE_OWNERS: readonly string[] = Object.freeze([
  "0x9B68c14e936104e9a7a24c712BEecdc220002984",
  "0x5227a7404631Eb7De411232535E36dE8dad318f0",
  "0x43A9beCdC1323c1dFcfA776cE9bF57F9F8Ce8200",
]);

/**
 * Signatures required to execute. 2-of-3 survives the loss of any single
 * device while keeping the signing ceremony practical across 34 chains.
 *
 * Accepted risk, recorded deliberately: any two compromised devices can call
 * `sweepAll` on all 34 routers, and `renounceOwnership()` remains callable
 * (it is present in the OkuRouter ABI and is not disabled).
 */
export const OKU_SAFE_THRESHOLD = 2;

/** saltNonce for `createProxyWithNonce`. Fixed so the address is stable. */
export const OKU_SAFE_SALT_NONCE = 0n;

/**
 * Pinned expected Safe address, identical on all 34 chains.
 *
 * This is NOT the source of truth -- it is a tripwire. The address is always
 * computed from the config above; this constant only exists so that an
 * accidental change to the owner set, order, threshold or saltNonce fails
 * loudly instead of quietly deploying a different Safe.
 */
export const OKU_SAFE_EXPECTED_ADDRESS = "0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F";

/**
 * The hot deployer EOA that currently owns every OkuRouter.
 *
 * After the handover its on-chain authority drops to zero. It keeps two
 * unprivileged operational roles:
 *   - executor: `execTransaction` is permissionless once the threshold of
 *     signatures exists, so this key broadcasts and pays gas on all 34
 *     chains. Requires no permissions whatsoever.
 *   - proposer: registered as a Safe Transaction Service delegate on the 22
 *     chains that have the service, letting it queue transactions into the
 *     Safe{Wallet} UI. Delegates cannot sign and cannot execute.
 */
export const OKU_DEPLOYER_EOA = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// ---------------------------------------------------------------------------
// Safe Transaction Service coverage
// ---------------------------------------------------------------------------

/**
 * Chains where Safe runs a hosted Transaction Service, keyed by chainId with
 * the API shortname as the value. Endpoint:
 *   https://api.safe.global/tx-service/<shortname>/api/...
 *
 * These 22 chains get the Safe{Wallet} UI and the Proposers feature. Each
 * shortname was verified by comparing the service's reported indexing height
 * against the chain's own `eth_blockNumber` (see safe:preflight), which rules
 * out both wrong shortnames and testnet mix-ups.
 *
 * The other 12 deployed chains -- rootstock(30), telos(40), redbelly(151),
 * boba(288), filecoin(314), sei(1329), goat(2345), saga(5464), nibiru(6900),
 * etherlink(42793), bob(60808), gensyn(685689) -- have no hosted service and
 * no Safe UI. They are driven entirely by the safe:build / safe:sign /
 * safe:exec tasks in this repo, which never contact Safe's API.
 */
export const SAFE_TX_SERVICE_CHAINS: Readonly<Record<number, string>> = Object.freeze({
  1: "eth",
  10: "oeth",
  50: "xdc",
  56: "bnb",
  100: "gno",
  130: "unichain",
  137: "pol",
  143: "monad",
  480: "wc",
  999: "hyper",
  1672: "pharos",
  4663: "robinhood",
  5000: "mantle",
  8453: "base",
  9745: "plasma",
  16661: "0g",
  42161: "arb1",
  42220: "celo",
  43111: "hemi",
  43114: "avax",
  59144: "linea",
  534352: "scr",
});

/** Base URL for a chain's Safe Transaction Service, or undefined if none. */
export function safeTxServiceUrl(chainId: number): string | undefined {
  const shortName = SAFE_TX_SERVICE_CHAINS[chainId];
  return shortName ? `https://api.safe.global/tx-service/${shortName}/api` : undefined;
}

/** True if Safe runs a hosted Transaction Service (and UI) for this chain. */
export function hasSafeTxService(chainId: number): boolean {
  return SAFE_TX_SERVICE_CHAINS[chainId] !== undefined;
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/** Minimal ABI surface we need from the Safe contracts. */
export const SAFE_SETUP_IFACE = new Interface([
  "function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
]);

export const SAFE_TO_L2_SETUP_IFACE = new Interface([
  "function setupToL2(address l2Singleton)",
]);

export const SAFE_PROXY_FACTORY_IFACE = new Interface([
  "function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() view returns (bytes)",
]);

/**
 * Build the `setup()` initializer calldata.
 *
 * This exact byte string is hashed into the CREATE2 salt, so it must be
 * reproduced identically on every chain. Every field below is fixed except
 * the owners and threshold.
 */
export function buildSafeInitializer(
  owners: readonly string[] = OKU_SAFE_OWNERS,
  threshold: number = OKU_SAFE_THRESHOLD,
): string {
  if (owners.length === 0) {
    throw new Error("buildSafeInitializer: owners must not be empty");
  }
  if (threshold < 1 || threshold > owners.length) {
    throw new Error(
      `buildSafeInitializer: threshold ${threshold} out of range for ${owners.length} owners`,
    );
  }
  // Normalize to checksum form so a casing difference can never fork the
  // initializer (and thus the address). abi.encode lowercases anyway, but
  // being explicit documents the intent.
  const normalized = owners.map((o) => getAddress(o));

  // The SafeToL2Setup delegatecall payload: switch slot 0 to SafeL2 when
  // chainid != 1. Constant on every chain.
  const setupToL2Data = SAFE_TO_L2_SETUP_IFACE.encodeFunctionData("setupToL2", [
    SAFE_L2_SINGLETON,
  ]);

  return SAFE_SETUP_IFACE.encodeFunctionData("setup", [
    normalized,
    threshold,
    SAFE_TO_L2_SETUP, // to
    setupToL2Data, // data
    SAFE_FALLBACK_HANDLER,
    ZeroAddress, // paymentToken
    0, // payment
    SAFE_PAYMENT_RECEIVER,
  ]);
}

/**
 * Predict a Safe proxy address, fully offline.
 *
 * Mirrors SafeProxyFactory.createProxyWithNonce:
 *   salt = keccak256(keccak256(initializer) ++ saltNonce)
 *   initCode = proxyCreationCode ++ abi.encode(uint256(singleton))
 *
 * Note the salt does NOT include msg.sender, which is why the address is
 * deployer-independent: anyone can deploy our Safe at our address, and we can
 * deploy it on a new chain years later from a different key.
 */
export function predictSafeAddress(
  owners: readonly string[] = OKU_SAFE_OWNERS,
  threshold: number = OKU_SAFE_THRESHOLD,
  saltNonce: bigint = OKU_SAFE_SALT_NONCE,
  proxyCreationCode: string = SAFE_PROXY_CREATION_CODE,
): { address: string; initializer: string; salt: string; initCodeHash: string } {
  const initializer = buildSafeInitializer(owners, threshold);
  const salt = keccak256(
    concat([keccak256(initializer), zeroPadValue(toBeHex(saltNonce), 32)]),
  );
  const initCode = concat([
    proxyCreationCode,
    AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(SAFE_L1_SINGLETON)]),
  ]);
  const initCodeHash = keccak256(initCode);
  const address = computeCreate2Address(SAFE_PROXY_FACTORY, salt, initCodeHash);
  return { address, initializer, salt, initCodeHash };
}

/**
 * The production Safe deployment descriptor, with the pinned-address tripwire
 * enforced. Every task that needs the Safe address should call this rather
 * than reading OKU_SAFE_EXPECTED_ADDRESS directly, so the constants can never
 * drift apart from the derivation.
 */
export function getOkuSafeDeployment(): {
  address: string;
  initializer: string;
  salt: string;
  initCodeHash: string;
  owners: readonly string[];
  threshold: number;
  saltNonce: bigint;
} {
  const predicted = predictSafeAddress();
  if (getAddress(predicted.address) !== getAddress(OKU_SAFE_EXPECTED_ADDRESS)) {
    throw new Error(
      `Safe config drift detected.\n` +
        `  computed: ${predicted.address}\n` +
        `  expected: ${OKU_SAFE_EXPECTED_ADDRESS}\n` +
        `The owner set, owner ORDER, threshold or saltNonce in util/safeConfig.ts ` +
        `changed. If that was intentional, update OKU_SAFE_EXPECTED_ADDRESS -- but ` +
        `be aware this is a DIFFERENT Safe, and any chain already handed over to ` +
        `the old address will still be owned by the old Safe.`,
    );
  }
  return {
    ...predicted,
    owners: OKU_SAFE_OWNERS,
    threshold: OKU_SAFE_THRESHOLD,
    saltNonce: OKU_SAFE_SALT_NONCE,
  };
}

/**
 * Verify the embedded SafeToL2Setup creation code really is the contract that
 * lives at the canonical address, by checking the CREATE2 identity:
 *
 *   CREATE2(SafeSingletonFactory, salt=0, keccak(creationCode)) == SAFE_TO_L2_SETUP
 *
 * Called before the Gensyn helper deploy. A tampered or wrong-version literal
 * cannot pass this, which is what lets us embed the bytecode instead of
 * depending on an npm package for it.
 */
export function assertSafeToL2SetupBytecode(): void {
  const predicted = computeCreate2Address(
    SAFE_SINGLETON_FACTORY,
    SAFE_HELPER_DEPLOY_SALT,
    keccak256(SAFE_TO_L2_SETUP_CREATION_CODE),
  );
  if (getAddress(predicted) !== getAddress(SAFE_TO_L2_SETUP)) {
    throw new Error(
      `SafeToL2Setup bytecode check FAILED.\n` +
        `  creationCode would deploy to: ${predicted}\n` +
        `  canonical address:            ${SAFE_TO_L2_SETUP}\n` +
        `Refusing to deploy unverified bytecode.`,
    );
  }
}

/** Fail fast at import-adjacent call sites if the pinned constants drifted. */
export function assertOkuSafeConfig(): void {
  getOkuSafeDeployment();
  assertSafeToL2SetupBytecode();
}
