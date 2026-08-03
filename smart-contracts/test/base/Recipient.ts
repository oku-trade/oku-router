/**
 * Tests for the `recipient` parameter on all swap functions.
 *
 * Covers:
 *  - msg.sender works as explicit recipient (no warrant needed)
 *  - address(0) requires warrant (burn path)
 *  - Reverts on bad recipients: address(this), target, approvalTarget
 *  - Warrant enforcement: revert when recipient != msg.sender and warrant bypassed
 *  - Full flow: valid warrant + unique recipient for all 3 swap types
 *  - OrderFilled event: correct recipient emitted
 *  - maxWarrantDuration: enforced when set, bypassed when 0
 *  - Warrant nonce replay protection
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ZeroAddress,
  type Signer,
  type TypedDataDomain,
} from "ethers";
import {
  type OkuRouter,
  type MockERC20,
  type MockSwapTarget,
  OkuRouter__factory,
  MockERC20__factory,
  MockSwapTarget__factory,
} from "../../typechain-types";

function bypassWarrant() {
  return {
    nonce: 0n,
    validBefore: 0,
    validAfter: 0,
    verifyingSigner: ZeroAddress,
    signature: "0x",
  };
}

async function signWarrant(
  signer: Signer,
  routerAddress: string,
  dataHash: string,
  nonce: bigint,
  durationSeconds: number = 300,
) {
  const latestBlock = await ethers.provider.getBlock("latest");
  const ts = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const validAfter = ts - 10;
  const validBefore = validAfter + durationSeconds;

  const packedValidationData =
    nonce |
    (BigInt(validBefore) << 160n) |
    (BigInt(validAfter) << 208n);

  const domain: TypedDataDomain = {
    name: "Oku Router",
    version: "1.0",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: routerAddress,
  };

  const types = {
    CanoeWarrant: [
      { name: "packedValidationData", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
    ],
  };

  const signature = await signer.signTypedData(domain, types, { packedValidationData, dataHash });

  return {
    nonce,
    validBefore,
    validAfter,
    verifyingSigner: await signer.getAddress(),
    signature,
  };
}

// Variant of signWarrant that takes explicit validAfter/validBefore
// instead of deriving them from a duration, so tests can construct
// malformed (reversed) timestamp warrants.
async function signWarrantExplicit(
  signer: Signer,
  routerAddress: string,
  dataHash: string,
  nonce: bigint,
  validAfter: number,
  validBefore: number,
) {
  const packedValidationData =
    nonce |
    (BigInt(validBefore) << 160n) |
    (BigInt(validAfter) << 208n);

  const domain: TypedDataDomain = {
    name: "Oku Router",
    version: "1.0",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: routerAddress,
  };

  const types = {
    CanoeWarrant: [
      { name: "packedValidationData", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
    ],
  };

  const signature = await signer.signTypedData(domain, types, { packedValidationData, dataHash });

  return {
    nonce,
    validBefore,
    validAfter,
    verifyingSigner: await signer.getAddress(),
    signature,
  };
}

function encodeSwap(
  mockTarget: MockSwapTarget,
  tokenIn: string, tokenOut: string,
  amountIn: bigint, amountOut: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swap", [tokenIn, tokenOut, amountIn, amountOut]);
}

function encodeSwapFromEth(
  mockTarget: MockSwapTarget,
  tokenOut: string, amountOut: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swapFromEth", [tokenOut, amountOut]);
}

function encodeSwapToEth(
  mockTarget: MockSwapTarget,
  tokenIn: string, amountIn: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swapToEth", [tokenIn, amountIn]);
}

describe("Recipient parameter", function () {
  let router: OkuRouter;
  let tokenA: MockERC20;
  let tokenB: MockERC20;
  let mockTarget: MockSwapTarget;

  let owner: Signer;
  let user: Signer;
  let recipient: Signer;
  let warrantSigner: Signer;

  let routerAddr: string;
  let targetAddr: string;
  let tokenAAddr: string;
  let tokenBAddr: string;
  let userAddr: string;
  let recipientAddr: string;

  const SELL_AMOUNT = ethers.parseEther("100");
  const BUY_AMOUNT = ethers.parseEther("200");
  const FEE_AMOUNT = ethers.parseEther("1");

  before(async () => {
    [owner, user, recipient, warrantSigner] = await ethers.getSigners();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();

    tokenA = await new MockERC20__factory(owner).deploy("Token A", "TKA", 18);
    tokenB = await new MockERC20__factory(owner).deploy("Token B", "TKB", 18);
    mockTarget = await new MockSwapTarget__factory(owner).deploy();
    router = await new OkuRouter__factory(owner).deploy(
      "Oku Router", "1.0", await owner.getAddress(), ZeroAddress,
    );

    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    await mockTarget.waitForDeployment();
    await router.waitForDeployment();

    routerAddr = await router.getAddress();
    targetAddr = await mockTarget.getAddress();
    tokenAAddr = await tokenA.getAddress();
    tokenBAddr = await tokenB.getAddress();

    await router.connect(owner).updateSwapTargets(targetAddr, true);
    await router.connect(owner).updateValidSigner(ZeroAddress, true);
    await router.connect(owner).updateValidSigner(await warrantSigner.getAddress(), true);
    await router.connect(owner).setMaxWarrantDuration(300);
  });

  async function fundUser(amount: bigint) {
    await tokenA.mint(userAddr, amount);
    await tokenA.connect(user).approve(routerAddr, amount);
  }

  // ==========================================
  // fillQuoteTokenToToken
  // ==========================================
  describe("fillQuoteTokenToToken", function () {
    describe("Valid recipients", function () {
      it("recipient = msg.sender -> tokens go to msg.sender (no warrant needed)", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          userAddr,
          bypassWarrant(),
        );

        expect(await tokenB.balanceOf(userAddr)).to.equal(BUY_AMOUNT);
      });

      it("recipient = address(0) requires warrant (burn path)", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            ZeroAddress,
            bypassWarrant(),
          )
        ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
      });
    });

    describe("Reverts on bad recipients", function () {
      it("recipient = address(this) -> reverts", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            routerAddr,
            bypassWarrant(),
          )
        ).to.be.revertedWith("RECIPIENT_IS_THIS");
      });

      it("recipient = target -> reverts", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            targetAddr,
            bypassWarrant(),
          )
        ).to.be.revertedWith("RECIPIENT_IS_TARGET");
      });

      it("recipient = approvalTarget (distinct from target) -> reverts", async function () {
        const dummyApproval = "0x0000000000000000000000000000000000000042";
        await router.connect(owner).updateSwapTargets(dummyApproval, true);

        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, dummyApproval,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            dummyApproval,
            bypassWarrant(),
          )
        ).to.be.revertedWith("RECIPIENT_IS_APPROVAL_TARGET");
      });
    });

    describe("Warrant enforcement", function () {
      it("reverts when recipient != msg.sender and warrant is bypassed", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            recipientAddr,
            bypassWarrant(),
          )
        ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
      });
    });

    describe("Full flow with warrant and unique recipient", function () {
      it("sends tokens to a different recipient when warrant is valid", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        const recipientBalBefore = await tokenB.balanceOf(recipientAddr);
        const userBalBefore = await tokenB.balanceOf(userAddr);

        const dataHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
            [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
          )
        );

        const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 1n, 300);

        const tx = router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr, warrant,
        );

        await expect(tx)
          .to.emit(router, "OrderFilled")
          .withArgs(userAddr, recipientAddr, tokenAAddr, tokenBAddr, SELL_AMOUNT, BUY_AMOUNT, FEE_AMOUNT, targetAddr);

        expect(await tokenB.balanceOf(recipientAddr)).to.equal(recipientBalBefore + BUY_AMOUNT);
        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore);
      });
    });
  });

  // ==========================================
  // fillQuoteEthToToken
  // ==========================================
  describe("fillQuoteEthToToken", function () {
    const ETH_SELL = ethers.parseEther("1");
    const ETH_FEE = ethers.parseEther("0.01");
    const TOKEN_OUT = ethers.parseEther("500");

    it("recipient = msg.sender -> tokens go to msg.sender", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);
      const userBalBefore = await tokenB.balanceOf(userAddr);

      await router.connect(user).fillQuoteEthToToken(
        tokenBAddr, targetAddr, swapData, ETH_FEE,
        userAddr, bypassWarrant(),
        { value: ETH_SELL },
      );

      expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + TOKEN_OUT);
    });

    it("recipient = address(this) -> reverts", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

      await expect(
        router.connect(user).fillQuoteEthToToken(
          tokenBAddr, targetAddr, swapData, ETH_FEE,
          routerAddr, bypassWarrant(),
          { value: ETH_SELL },
        )
      ).to.be.revertedWith("RECIPIENT_IS_THIS");
    });

    it("reverts when recipient != msg.sender and warrant bypassed", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

      await expect(
        router.connect(user).fillQuoteEthToToken(
          tokenBAddr, targetAddr, swapData, ETH_FEE,
          recipientAddr, bypassWarrant(),
          { value: ETH_SELL },
        )
      ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
    });

    it("sends tokens to different recipient with valid warrant", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);
      const recipientBalBefore = await tokenB.balanceOf(recipientAddr);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256", "address", "uint256"],
          [tokenBAddr, targetAddr, ethers.keccak256(swapData), ETH_FEE, recipientAddr, ETH_SELL - ETH_FEE],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 2n, 300);

      await router.connect(user).fillQuoteEthToToken(
        tokenBAddr, targetAddr, swapData, ETH_FEE,
        recipientAddr, warrant,
        { value: ETH_SELL },
      );

      expect(await tokenB.balanceOf(recipientAddr)).to.equal(recipientBalBefore + TOKEN_OUT);
    });

    // Regression test for Low-01 (Chain Defenders audit, July 2026):
    // "msg.value Not Bound in ETH-Token Warrant dataHash". The dataHash
    // must bind the net ETH amount (msg.value - feeAmount) so a warrant
    // signed for one input size cannot be replayed with a different
    // msg.value.
    it("rejects the warrant when msg.value does not match the signed amount", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256", "address", "uint256"],
          [tokenBAddr, targetAddr, ethers.keccak256(swapData), ETH_FEE, recipientAddr, ETH_SELL - ETH_FEE],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 20n, 300);

      // Same warrant, but submitted with double the signed ETH amount —
      // the dataHash recomputed on-chain will differ, so signature
      // recovery fails.
      await expect(
        router.connect(user).fillQuoteEthToToken(
          tokenBAddr, targetAddr, swapData, ETH_FEE,
          recipientAddr, warrant,
          { value: ETH_SELL * 2n },
        )
      ).to.be.revertedWith("CANOE: INVALID_SIGNATURE");
    });

    it("accepts the warrant when msg.value matches the signed amount exactly", async function () {
      const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);
      const recipientBalBefore = await tokenB.balanceOf(recipientAddr);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256", "address", "uint256"],
          [tokenBAddr, targetAddr, ethers.keccak256(swapData), ETH_FEE, recipientAddr, ETH_SELL - ETH_FEE],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 21n, 300);

      await router.connect(user).fillQuoteEthToToken(
        tokenBAddr, targetAddr, swapData, ETH_FEE,
        recipientAddr, warrant,
        { value: ETH_SELL },
      );

      expect(await tokenB.balanceOf(recipientAddr)).to.equal(recipientBalBefore + TOKEN_OUT);
    });
  });

  // ==========================================
  // fillQuoteTokenToEth
  // ==========================================
  describe("fillQuoteTokenToEth", function () {
    const TOKEN_SELL = ethers.parseEther("100");
    const ETH_OUT = ethers.parseEther("0.5");

    it("recipient = msg.sender -> ETH goes to msg.sender", async function () {
      await fundUser(TOKEN_SELL);
      await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });
      const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);
      const userEthBefore = await ethers.provider.getBalance(userAddr);

      await router.connect(user).fillQuoteTokenToEth(
        tokenAAddr, targetAddr, targetAddr, swapData,
        TOKEN_SELL, 0n, userAddr, bypassWarrant(),
      );

      const userEthAfter = await ethers.provider.getBalance(userAddr);
      expect(userEthAfter).to.be.gt(userEthBefore - ethers.parseEther("0.01"));
    });

    it("reverts when recipient != msg.sender and warrant bypassed", async function () {
      await fundUser(TOKEN_SELL);
      await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });
      const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);

      await expect(
        router.connect(user).fillQuoteTokenToEth(
          tokenAAddr, targetAddr, targetAddr, swapData,
          TOKEN_SELL, 0n, recipientAddr, bypassWarrant(),
        )
      ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
    });

    it("sends ETH to different recipient with valid warrant", async function () {
      await fundUser(TOKEN_SELL);
      await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });

      const targetEthBalance = await ethers.provider.getBalance(targetAddr);
      const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);
      const recipientEthBefore = await ethers.provider.getBalance(recipientAddr);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, targetAddr, targetAddr, ethers.keccak256(swapData), TOKEN_SELL, 0n, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 3n, 300);

      await router.connect(user).fillQuoteTokenToEth(
        tokenAAddr, targetAddr, targetAddr, swapData,
        TOKEN_SELL, 0n, recipientAddr, warrant,
      );

      const recipientEthAfter = await ethers.provider.getBalance(recipientAddr);
      expect(recipientEthAfter).to.equal(recipientEthBefore + targetEthBalance);
    });
  });

  // ==========================================
  // maxWarrantDuration
  // ==========================================
  describe("maxWarrantDuration", function () {
    it("reverts when warrant duration exceeds maxWarrantDuration", async function () {
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 10n, 600);

      await expect(
        router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr, warrant,
        )
      ).to.be.revertedWith("WARRANT_DURATION_EXCEEDED");
    });

    it("allows warrant within maxWarrantDuration", async function () {
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 11n, 200);

      await router.connect(user).fillQuoteTokenToToken(
        tokenAAddr, tokenBAddr, targetAddr, targetAddr,
        swapData, SELL_AMOUNT, FEE_AMOUNT,
        recipientAddr, warrant,
      );
    });

    it("skips duration check when maxWarrantDuration is 0", async function () {
      await router.connect(owner).setMaxWarrantDuration(0);

      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 12n, 3600);

      await router.connect(user).fillQuoteTokenToToken(
        tokenAAddr, tokenBAddr, targetAddr, targetAddr,
        swapData, SELL_AMOUNT, FEE_AMOUNT,
        recipientAddr, warrant,
      );

      await router.connect(owner).setMaxWarrantDuration(300);
    });

    // Regression tests for Low-02 (Chain Defenders audit, July 2026):
    // "Warrant Duration Validation Underflows On Reversed Timestamps".
    // A warrant with validAfter > validBefore used to underflow the
    // `validBefore - validAfter` subtraction in _validateWarrantDuration,
    // producing an opaque Panic(0x11) instead of a clean revert.
    it("reverts cleanly (not an arithmetic panic) on reversed timestamps when maxWarrantDuration is set", async function () {
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const latestBlock = await ethers.provider.getBlock("latest");
      const now = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      // validBefore < validAfter -> validBefore - validAfter would underflow.
      const warrant = await signWarrantExplicit(
        warrantSigner, routerAddr, dataHash, 30n,
        now + 100, // validAfter (in the future)
        now - 100, // validBefore (in the past)
      );

      await expect(
        router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr, warrant,
        )
      ).to.be.revertedWith("CANOE: INVALID_TIMESTAMPS");
    });

    it("still reverts cleanly on reversed timestamps when maxWarrantDuration is 0 (duration check disabled)", async function () {
      await router.connect(owner).setMaxWarrantDuration(0);

      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const latestBlock = await ethers.provider.getBlock("latest");
      const now = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      // Same reversed pair as the previous test, but with the duration
      // check disabled entirely (maxWarrantDuration == 0), so
      // _validateWarrantDuration returns early and CanoeHelper.verifyWarrant
      // is the only check that runs. Its own timestamp checks are ordered
      // EXPIRED -> NOT_YET -> INVALID_TIMESTAMPS, and validBefore is in
      // the past here, so CANOE: EXPIRED fires first — still a clean,
      // meaningful revert rather than an arithmetic panic.
      const warrant = await signWarrantExplicit(
        warrantSigner, routerAddr, dataHash, 31n,
        now + 100, // validAfter (in the future)
        now - 100, // validBefore (in the past)
      );

      await expect(
        router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr, warrant,
        )
      ).to.be.revertedWith("CANOE: EXPIRED");

      await router.connect(owner).setMaxWarrantDuration(300);
    });

    it("skips duration check for bypass warrants (signer = 0x0)", async function () {
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      await router.connect(user).fillQuoteTokenToToken(
        tokenAAddr, tokenBAddr, targetAddr, targetAddr,
        swapData, SELL_AMOUNT, FEE_AMOUNT,
        userAddr,
        bypassWarrant(),
      );
    });

    it("only owner can set maxWarrantDuration", async function () {
      await expect(
        router.connect(user).setMaxWarrantDuration(600)
      ).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
    });

    it("emits MaxWarrantDurationUpdated event", async function () {
      await expect(router.connect(owner).setMaxWarrantDuration(600))
        .to.emit(router, "MaxWarrantDurationUpdated")
        .withArgs(300, 600);

      await router.connect(owner).setMaxWarrantDuration(300);
    });
  });

  // ==========================================
  // Warrant nonce replay protection
  // ==========================================
  describe("Warrant nonce replay protection", function () {
    it("rejects a reused warrant nonce", async function () {
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 100n, 300);

      await router.connect(user).fillQuoteTokenToToken(
        tokenAAddr, tokenBAddr, targetAddr, targetAddr,
        swapData, SELL_AMOUNT, FEE_AMOUNT,
        recipientAddr, warrant,
      );

      await fundUser(SELL_AMOUNT);

      await expect(
        router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr, warrant,
        )
      ).to.be.revertedWith("WARRANT_NONCE_USED");
    });
  });
});
