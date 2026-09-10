/**
 * SafeConfig.ts
 *
 * Offline regression tests for the production Safe configuration and the
 * hand-rolled SafeTx encoding. No network access -- everything here is pure
 * derivation, so it runs anywhere and fails fast in CI.
 *
 * The ground-truth anchor is the previous Oku Safe on Optimism
 * (0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5). Its real on-chain creation
 * parameters are pinned below, so `buildSafeInitializer` and
 * `predictSafeAddress` are validated against a Safe that demonstrably exists
 * rather than against our own assumptions.
 *
 * The complementary on-chain checks (safeTxHash vs the Safe's own
 * getTransactionHash, threshold enforcement, MultiSend behaviour) live in
 * scripts/testForkSafeMigration.ts, which exercises them on real forks.
 */
import { expect } from "chai";
import { ZeroAddress, getAddress, keccak256 } from "ethers";
import {
  OKU_SAFE_EXPECTED_ADDRESS,
  OKU_SAFE_OWNERS,
  OKU_SAFE_SALT_NONCE,
  OKU_SAFE_THRESHOLD,
  SAFE_MULTISEND_CALL_ONLY,
  SAFE_PROXY_CREATION_CODE,
  SAFE_PROXY_CREATION_CODE_HASH,
  SAFE_TX_SERVICE_CHAINS,
  assertOkuSafeConfig,
  assertSafeToL2SetupBytecode,
  buildSafeInitializer,
  getOkuSafeDeployment,
  hasSafeTxService,
  predictSafeAddress,
  safeTxServiceUrl,
} from "../../util/safeConfig";
import {
  SafeOperation,
  buildBatchedSafeTx,
  buildSafeTx,
  encodeMultiSend,
  hashSafeTx,
  packSignatures,
} from "../../util/safeTx";

/** Real creation parameters of the previous Oku Safe on Optimism. */
const GROUND_TRUTH = {
  address: "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5",
  owners: [
    "0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89",
    "0x9B68c14e936104e9a7a24c712BEecdc220002984",
    "0x5227a7404631Eb7De411232535E36dE8dad318f0",
  ],
  threshold: 2,
  saltNonce: 0n,
  setupData:
    "0xb63e800d00000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000bd89a1ce4dde368ffab0ec35506eece0b1ffdc540000000000000000000000000000000000000000000000000000000000000180000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005afe7a11e70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000085909388fc0ce9e5761ac8608af8f2f52cb8b890000000000000000000000009b68c14e936104e9a7a24c712beecdc2200029840000000000000000000000005227a7404631eb7de411232535e36de8dad318f00000000000000000000000000000000000000000000000000000000000000024fe51f64300000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c76200000000000000000000000000000000000000000000000000000000",
};

describe("safeConfig: derivation", () => {
  it("reproduces the real Optimism Safe's initializer byte-for-byte", () => {
    const built = buildSafeInitializer(GROUND_TRUTH.owners, GROUND_TRUTH.threshold);
    expect(built.toLowerCase()).to.equal(GROUND_TRUTH.setupData.toLowerCase());
  });

  it("predicts the real Optimism Safe's address from those parameters", () => {
    const { address } = predictSafeAddress(
      GROUND_TRUTH.owners,
      GROUND_TRUTH.threshold,
      GROUND_TRUTH.saltNonce,
    );
    expect(getAddress(address)).to.equal(getAddress(GROUND_TRUTH.address));
  });

  it("pins the production Safe address, and the tripwire agrees", () => {
    const dep = getOkuSafeDeployment();
    expect(getAddress(dep.address)).to.equal(getAddress(OKU_SAFE_EXPECTED_ADDRESS));
    expect(dep.threshold).to.equal(OKU_SAFE_THRESHOLD);
    expect(dep.saltNonce).to.equal(OKU_SAFE_SALT_NONCE);
    expect(() => assertOkuSafeConfig()).to.not.throw();
  });

  it("treats owner ORDER as part of the address", () => {
    const a = predictSafeAddress(OKU_SAFE_OWNERS, 2, 0n).address;
    const reordered = [OKU_SAFE_OWNERS[1], OKU_SAFE_OWNERS[0], OKU_SAFE_OWNERS[2]];
    const b = predictSafeAddress(reordered, 2, 0n).address;
    expect(a).to.not.equal(b);
  });

  it("treats threshold and saltNonce as part of the address", () => {
    const base = predictSafeAddress(OKU_SAFE_OWNERS, 2, 0n).address;
    expect(predictSafeAddress(OKU_SAFE_OWNERS, 3, 0n).address).to.not.equal(base);
    expect(predictSafeAddress(OKU_SAFE_OWNERS, 2, 1n).address).to.not.equal(base);
  });

  it("is insensitive to owner address casing", () => {
    const lower = OKU_SAFE_OWNERS.map((o) => o.toLowerCase());
    expect(predictSafeAddress(lower, 2, 0n).address).to.equal(
      predictSafeAddress(OKU_SAFE_OWNERS, 2, 0n).address,
    );
  });

  it("rejects a nonsensical threshold", () => {
    expect(() => buildSafeInitializer(OKU_SAFE_OWNERS, 0)).to.throw();
    expect(() => buildSafeInitializer(OKU_SAFE_OWNERS, 4)).to.throw();
    expect(() => buildSafeInitializer([], 1)).to.throw();
  });

  it("keeps the pinned proxy creation code hash consistent", () => {
    expect(keccak256(SAFE_PROXY_CREATION_CODE)).to.equal(SAFE_PROXY_CREATION_CODE_HASH);
    expect((SAFE_PROXY_CREATION_CODE.length - 2) / 2).to.equal(486);
  });

  it("proves the embedded SafeToL2Setup bytecode CREATE2s to its canonical address", () => {
    expect(() => assertSafeToL2SetupBytecode()).to.not.throw();
  });
});

describe("safeConfig: transaction service coverage", () => {
  it("maps exactly the 22 chains with a hosted service", () => {
    expect(Object.keys(SAFE_TX_SERVICE_CHAINS)).to.have.length(22);
  });

  it("answers hasSafeTxService consistently with the map", () => {
    expect(hasSafeTxService(1)).to.equal(true);
    expect(hasSafeTxService(8453)).to.equal(true);
    // The 12 chains with no hosted service, driven by safe:build/sign/exec.
    for (const id of [30, 40, 151, 288, 314, 1329, 2345, 5464, 6900, 42793, 60808, 685689]) {
      expect(hasSafeTxService(id), `chain ${id}`).to.equal(false);
      expect(safeTxServiceUrl(id), `chain ${id}`).to.equal(undefined);
    }
  });

  it("builds the documented service URL shape", () => {
    expect(safeTxServiceUrl(1)).to.equal("https://api.safe.global/tx-service/eth/api");
    expect(safeTxServiceUrl(42161)).to.equal("https://api.safe.global/tx-service/arb1/api");
  });
});

describe("safeTx: encoding", () => {
  const SAFE = "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5";
  const TARGET = "0xb1f3a7B816B0681188F54dFa400991B93ADf00ed";

  it("zeroes the gas-refund fields so signatures survive fee-market changes", () => {
    const tx = buildSafeTx({ to: TARGET, data: "0xdeadbeef", nonce: 5n });
    expect(tx.safeTxGas).to.equal(0n);
    expect(tx.baseGas).to.equal(0n);
    expect(tx.gasPrice).to.equal(0n);
    expect(tx.gasToken).to.equal(ZeroAddress);
    expect(tx.refundReceiver).to.equal(ZeroAddress);
    expect(tx.operation).to.equal(SafeOperation.Call);
  });

  it("binds chainId, so a signature cannot be replayed on another chain", () => {
    const tx = buildSafeTx({ to: TARGET, data: "0xdeadbeef", nonce: 5n });
    const hashes = [1, 10, 8453, 42161].map((id) => hashSafeTx(id, SAFE, tx));
    expect(new Set(hashes).size).to.equal(hashes.length);
  });

  it("binds the Safe address and the nonce", () => {
    const tx = buildSafeTx({ to: TARGET, data: "0xdeadbeef", nonce: 5n });
    const other = buildSafeTx({ to: TARGET, data: "0xdeadbeef", nonce: 6n });
    expect(hashSafeTx(10, SAFE, tx)).to.not.equal(hashSafeTx(10, TARGET, tx));
    expect(hashSafeTx(10, SAFE, tx)).to.not.equal(hashSafeTx(10, SAFE, other));
  });

  it("emits multiSend(bytes) with the packed sub-call layout", () => {
    const data = encodeMultiSend([
      { to: TARGET, data: "0x1234" },
      { to: TARGET, data: "0x5678", value: 1n },
    ]);
    expect(data.slice(0, 10)).to.equal("0x8d80ff0a");
    // Each sub-call is 1 + 20 + 32 + 32 = 85 bytes of header plus its data.
    expect(data.length).to.be.greaterThan(2 + 8 + 2 * (85 * 2 + 2 + 2));
  });

  it("refuses to encode an empty batch", () => {
    expect(() => encodeMultiSend([])).to.throw();
  });

  it("uses a bare call for one action and DELEGATECALL MultiSend for many", () => {
    const single = buildBatchedSafeTx([{ to: TARGET, data: "0x1234" }], 0n);
    expect(single.to).to.equal(getAddress(TARGET));
    expect(single.operation).to.equal(SafeOperation.Call);

    const many = buildBatchedSafeTx(
      [
        { to: TARGET, data: "0x1234" },
        { to: TARGET, data: "0x5678" },
      ],
      0n,
    );
    expect(many.to).to.equal(getAddress(SAFE_MULTISEND_CALL_ONLY));
    // DELEGATECALL is mandatory: it runs the MultiSend loop in the Safe's
    // context so each sub-call arrives with msg.sender == Safe, which every
    // onlyOwner OkuRouter admin function requires.
    expect(many.operation).to.equal(SafeOperation.DelegateCall);
  });
});

describe("safeTx: signature packing", () => {
  const sigA = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
  const sigB = "0x" + "33".repeat(32) + "44".repeat(32) + "1c";
  const low = "0x00a0bB9dfD2db3a6E447147426aB2D1B5Ac356d5";
  const high = "0xfff3a7b816b0681188f54dfa400991b93adf00ed";

  it("sorts by owner address ascending, as the contract requires", () => {
    const packed = packSignatures([
      { signer: high, signature: sigA },
      { signer: low, signature: sigB },
    ]);
    // The low address's signature (sigB, r = 0x33..) must come first, or the
    // Safe reverts GS026 even though both signatures are individually valid.
    expect(packed.slice(2, 6)).to.equal("3333");
    expect((packed.length - 2) / 2).to.equal(130);
  });

  it("produces the same blob regardless of input order", () => {
    const a = packSignatures([
      { signer: high, signature: sigA },
      { signer: low, signature: sigB },
    ]);
    const b = packSignatures([
      { signer: low, signature: sigB },
      { signer: high, signature: sigA },
    ]);
    expect(a).to.equal(b);
  });

  it("rejects duplicate signers and empty input", () => {
    expect(() =>
      packSignatures([
        { signer: low, signature: sigA },
        { signer: low, signature: sigB },
      ]),
    ).to.throw(/duplicate/i);
    expect(() => packSignatures([])).to.throw();
  });
});
