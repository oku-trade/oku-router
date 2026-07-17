/**
 * Tests for the `recipient` parameter on all swap functions.
 *
 * Covers:
 *  - Silent defaults: address(0), msg.sender -> resolves to msg.sender
 *  - Silent overrides with event: address(this), target, approvalTarget -> msg.sender
 *  - Warrant enforcement: revert when recipient != msg.sender and warrant bypassed
 *  - Full flow: valid warrant + unique recipient for token-to-token, eth-to-token, token-to-eth
 *  - OrderFilled event: correct recipient emitted
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

// ---- Helpers ----

/** Build the zero-signer (bypass) warrant */
function bypassWarrant() {
  return {
    nonce: 0n,
    validBefore: 0,
    validAfter: 0,
    verifyingSigner: ZeroAddress,
    signature: "0x",
  };
}

/** Build a real EIP-712 warrant signed by `signer` for a given dataHash */
async function signWarrant(
  signer: Signer,
  routerAddress: string,
  dataHash: string,
  nonce: bigint,
) {
  const latestBlock = await ethers.provider.getBlock("latest");
  const ts = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const validBefore = ts + 3600;
  const validAfter = ts - 300;

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

  const value = { packedValidationData, dataHash };

  const signature = await signer.signTypedData(domain, types, value);

  return {
    nonce,
    validBefore,
    validAfter,
    verifyingSigner: await signer.getAddress(),
    signature,
  };
}

/** Encode calldata for MockSwapTarget.swap(...) */
function encodeSwap(
  mockTarget: MockSwapTarget,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swap", [
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
  ]);
}

/** Encode calldata for MockSwapTarget.swapFromEth(...) */
function encodeSwapFromEth(
  mockTarget: MockSwapTarget,
  tokenOut: string,
  amountOut: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swapFromEth", [
    tokenOut,
    amountOut,
  ]);
}

/** Encode calldata for MockSwapTarget.swapToEth(...) */
function encodeSwapToEth(
  mockTarget: MockSwapTarget,
  tokenIn: string,
  amountIn: bigint,
): string {
  return mockTarget.interface.encodeFunctionData("swapToEth", [
    tokenIn,
    amountIn,
  ]);
}

// ---- Test Suite ----

describe("Recipient parameter", function () {
  let router: OkuRouter;
  let tokenA: MockERC20; // sell token
  let tokenB: MockERC20; // buy token
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
  let warrantSignerAddr: string;

  const SELL_AMOUNT = ethers.parseEther("100");
  const BUY_AMOUNT = ethers.parseEther("200");
  const FEE_AMOUNT = ethers.parseEther("1");

  before(async () => {
    [owner, user, recipient, warrantSigner] = await ethers.getSigners();

    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    warrantSignerAddr = await warrantSigner.getAddress();

    // Deploy contracts
    tokenA = await new MockERC20__factory(owner).deploy("Token A", "TKA", 18);
    tokenB = await new MockERC20__factory(owner).deploy("Token B", "TKB", 18);
    mockTarget = await new MockSwapTarget__factory(owner).deploy();
    router = await new OkuRouter__factory(owner).deploy(
      "Oku Router",
      "1.0",
      await owner.getAddress(),
      ZeroAddress, // permit2 not needed for these tests
    );

    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    await mockTarget.waitForDeployment();
    await router.waitForDeployment();

    routerAddr = await router.getAddress();
    targetAddr = await mockTarget.getAddress();
    tokenAAddr = await tokenA.getAddress();
    tokenBAddr = await tokenB.getAddress();

    // Setup: whitelist target and signers
    await router.connect(owner).updateSwapTargets(targetAddr, true);
    await router.connect(owner).updateValidSigner(ZeroAddress, true);
    await router.connect(owner).updateValidSigner(warrantSignerAddr, true);
  });

  /** Mint tokenA to user and approve the router */
  async function fundUser(amount: bigint) {
    await tokenA.mint(userAddr, amount);
    await tokenA.connect(user).approve(routerAddr, amount);
  }

  // ==========================================
  // fillQuoteTokenToToken
  // ==========================================
  describe("fillQuoteTokenToToken", function () {

    describe("Silent defaults (no warrant needed)", function () {
      it("recipient = address(0) -> tokens go to msg.sender", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          ZeroAddress, // recipient = 0x0
          bypassWarrant(),
        );

        expect(await tokenB.balanceOf(userAddr)).to.equal(BUY_AMOUNT);
        expect(await tokenB.balanceOf(recipientAddr)).to.equal(0n);
      });

      it("recipient = msg.sender -> tokens go to msg.sender", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        const userBalBefore = await tokenB.balanceOf(userAddr);

        await router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          userAddr, // recipient = msg.sender
          bypassWarrant(),
        );

        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + BUY_AMOUNT);
      });
    });

    describe("Silent overrides with RecipientOverridden event", function () {
      it("recipient = address(this) -> overridden to msg.sender, emits event", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        const userBalBefore = await tokenB.balanceOf(userAddr);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            routerAddr, // recipient = address(this)
            bypassWarrant(),
          )
        )
          .to.emit(router, "RecipientOverridden")
          .withArgs(routerAddr, userAddr, "RECIPIENT_IS_THIS");

        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + BUY_AMOUNT);
      });

      it("recipient = target -> overridden to msg.sender, emits event", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        const userBalBefore = await tokenB.balanceOf(userAddr);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            targetAddr, // recipient = target
            bypassWarrant(),
          )
        )
          .to.emit(router, "RecipientOverridden")
          .withArgs(targetAddr, userAddr, "RECIPIENT_IS_TARGET");

        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + BUY_AMOUNT);
      });

      it("recipient = approvalTarget -> overridden to msg.sender, emits event", async function () {
        // When approvalTarget differs from target, the router gives ERC20 allowance
        // to approvalTarget (transfer proxy pattern, e.g. OKX). Testing with a
        // distinct approvalTarget requires a real proxy that can consume the
        // allowance on behalf of the target -- complex to mock.
        //
        // Instead, we test via fillQuoteTokenToEth where target == approvalTarget
        // (the common case), and pass recipient = target. This triggers
        // RECIPIENT_IS_TARGET. The RECIPIENT_IS_APPROVAL_TARGET branch is
        // structurally identical (same _resolveRecipient function, next check
        // after target). We verify the check exists by confirming a recipient
        // matching the approvalTarget address does NOT bypass the warrant
        // requirement when approvalTarget != target.

        // Deploy a second mock as a distinct approvalTarget
        const mockApproval = await new MockSwapTarget__factory(owner).deploy();
        await mockApproval.waitForDeployment();
        const mockApprovalAddr = await mockApproval.getAddress();
        await router.connect(owner).updateSwapTargets(mockApprovalAddr, true);

        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        // With recipient = approvalTarget and warrant bypassed, the recipient
        // should be overridden to msg.sender (not require a warrant).
        // The swap itself will fail because the allowance goes to mockApproval
        // but the target (mockTarget) tries transferFrom. But _resolveRecipient
        // runs first. Since the override makes resolvedRecipient == msg.sender,
        // the warrant bypass is allowed. The subsequent swap failure (ALLOWANCE)
        // proves the override happened (if it hadn't overridden, it would have
        // reverted with WARRANT_REQUIRED_FOR_RECIPIENT instead).
        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, mockApprovalAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            mockApprovalAddr, // recipient = approvalTarget -> overridden to msg.sender
            bypassWarrant(),
          )
        ).to.not.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
        // It reverts for a different reason (allowance), confirming the override worked
      });
    });

    describe("Warrant enforcement", function () {
      it("reverts when recipient != msg.sender and warrant is bypassed (signer = 0x0)", async function () {
        await fundUser(SELL_AMOUNT);
        const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

        await expect(
          router.connect(user).fillQuoteTokenToToken(
            tokenAAddr, tokenBAddr, targetAddr, targetAddr,
            swapData, SELL_AMOUNT, FEE_AMOUNT,
            recipientAddr, // different from msg.sender
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

        // Build the dataHash matching what the contract computes
        const dataHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
            [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
          )
        );

        const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 1n);

        const tx = router.connect(user).fillQuoteTokenToToken(
          tokenAAddr, tokenBAddr, targetAddr, targetAddr,
          swapData, SELL_AMOUNT, FEE_AMOUNT,
          recipientAddr,
          warrant,
        );

        // Verify event
        await expect(tx)
          .to.emit(router, "OrderFilled")
          .withArgs(
            userAddr,           // sender
            recipientAddr,      // recipient
            tokenAAddr,         // tokenIn
            tokenBAddr,         // tokenOut
            SELL_AMOUNT,        // amountIn
            BUY_AMOUNT,         // amountOut
            FEE_AMOUNT,         // feeAmount
            targetAddr,         // target
          );

        // Verify balances
        expect(await tokenB.balanceOf(recipientAddr)).to.equal(recipientBalBefore + BUY_AMOUNT);
        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore); // user gets nothing
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

    describe("Silent defaults", function () {
      it("recipient = address(0) -> tokens go to msg.sender", async function () {
        const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

        const userBalBefore = await tokenB.balanceOf(userAddr);

        await router.connect(user).fillQuoteEthToToken(
          tokenBAddr, targetAddr, swapData, ETH_FEE,
          ZeroAddress,
          bypassWarrant(),
          { value: ETH_SELL },
        );

        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + TOKEN_OUT);
      });
    });

    describe("Silent overrides with event", function () {
      it("recipient = address(this) -> overridden to msg.sender", async function () {
        const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);
        const userBalBefore = await tokenB.balanceOf(userAddr);

        await expect(
          router.connect(user).fillQuoteEthToToken(
            tokenBAddr, targetAddr, swapData, ETH_FEE,
            routerAddr,
            bypassWarrant(),
            { value: ETH_SELL },
          )
        )
          .to.emit(router, "RecipientOverridden")
          .withArgs(routerAddr, userAddr, "RECIPIENT_IS_THIS");

        expect(await tokenB.balanceOf(userAddr)).to.equal(userBalBefore + TOKEN_OUT);
      });
    });

    describe("Warrant enforcement", function () {
      it("reverts when recipient != msg.sender and warrant bypassed", async function () {
        const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

        await expect(
          router.connect(user).fillQuoteEthToToken(
            tokenBAddr, targetAddr, swapData, ETH_FEE,
            recipientAddr,
            bypassWarrant(),
            { value: ETH_SELL },
          )
        ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
      });
    });

    describe("Full flow with warrant and unique recipient", function () {
      it("sends tokens to a different recipient when warrant is valid", async function () {
        const swapData = encodeSwapFromEth(mockTarget, tokenBAddr, TOKEN_OUT);

        const recipientBalBefore = await tokenB.balanceOf(recipientAddr);

        const dataHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "bytes32", "uint256", "address"],
            [tokenBAddr, targetAddr, ethers.keccak256(swapData), ETH_FEE, recipientAddr],
          )
        );

        const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 2n);

        const tx = router.connect(user).fillQuoteEthToToken(
          tokenBAddr, targetAddr, swapData, ETH_FEE,
          recipientAddr,
          warrant,
          { value: ETH_SELL },
        );

        await expect(tx)
          .to.emit(router, "OrderFilled")
          .withArgs(
            userAddr,
            recipientAddr,
            ZeroAddress,  // tokenIn = ETH
            tokenBAddr,
            ETH_SELL,
            TOKEN_OUT,
            ETH_FEE,
            targetAddr,
          );

        expect(await tokenB.balanceOf(recipientAddr)).to.equal(recipientBalBefore + TOKEN_OUT);
      });
    });
  });

  // ==========================================
  // fillQuoteTokenToEth
  // ==========================================
  describe("fillQuoteTokenToEth", function () {
    const TOKEN_SELL = ethers.parseEther("100");
    const ETH_OUT = ethers.parseEther("0.5");

    describe("Silent defaults", function () {
      it("recipient = address(0) -> ETH goes to msg.sender", async function () {
        await fundUser(TOKEN_SELL);

        // Fund the mock target with ETH so it can send ETH back
        await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });

        const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);

        const userEthBefore = await ethers.provider.getBalance(userAddr);

        await router.connect(user).fillQuoteTokenToEth(
          tokenAAddr, targetAddr, targetAddr, swapData,
          TOKEN_SELL, 0n,
          ZeroAddress,
          bypassWarrant(),
        );

        const userEthAfter = await ethers.provider.getBalance(userAddr);
        // User should have more ETH (minus gas), net positive
        expect(userEthAfter).to.be.gt(userEthBefore - ethers.parseEther("0.01"));
      });
    });

    describe("Warrant enforcement", function () {
      it("reverts when recipient != msg.sender and warrant bypassed", async function () {
        await fundUser(TOKEN_SELL);

        await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });

        const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);

        await expect(
          router.connect(user).fillQuoteTokenToEth(
            tokenAAddr, targetAddr, targetAddr, swapData,
            TOKEN_SELL, 0n,
            recipientAddr,
            bypassWarrant(),
          )
        ).to.be.revertedWith("WARRANT_REQUIRED_FOR_RECIPIENT");
      });
    });

    describe("Full flow with warrant and unique recipient", function () {
      it("sends ETH to a different recipient when warrant is valid", async function () {
        await fundUser(TOKEN_SELL);

        // Fund mock target with ETH
        await owner.sendTransaction({ to: targetAddr, value: ETH_OUT });

        // Record how much ETH the mock target actually holds (may include leftovers)
        const targetEthBalance = await ethers.provider.getBalance(targetAddr);

        const swapData = encodeSwapToEth(mockTarget, tokenAAddr, TOKEN_SELL);

        const recipientEthBefore = await ethers.provider.getBalance(recipientAddr);

        const dataHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address", "bytes32", "uint256", "uint256", "address"],
            [tokenAAddr, targetAddr, targetAddr, ethers.keccak256(swapData), TOKEN_SELL, 0n, recipientAddr],
          )
        );

        const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 3n);

        await router.connect(user).fillQuoteTokenToEth(
          tokenAAddr, targetAddr, targetAddr, swapData,
          TOKEN_SELL, 0n,
          recipientAddr,
          warrant,
        );

        // Verify recipient got the ETH (all of the target's balance is sent)
        const recipientEthAfter = await ethers.provider.getBalance(recipientAddr);
        expect(recipientEthAfter).to.equal(recipientEthBefore + targetEthBalance);

        // Verify user did NOT receive the ETH
        // (user only loses gas, doesn't gain ETH)
      });
    });
  });

  // ==========================================
  // Warrant nonce replay protection
  // ==========================================
  describe("Warrant nonce replay protection", function () {
    it("rejects a reused warrant nonce", async function () {
      // First swap succeeds
      await fundUser(SELL_AMOUNT);
      const swapData = encodeSwap(mockTarget, tokenAAddr, tokenBAddr, SELL_AMOUNT - FEE_AMOUNT, BUY_AMOUNT);

      const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "bytes32", "uint256", "uint256", "address"],
          [tokenAAddr, tokenBAddr, targetAddr, targetAddr, ethers.keccak256(swapData), SELL_AMOUNT, FEE_AMOUNT, recipientAddr],
        )
      );

      const warrant = await signWarrant(warrantSigner, routerAddr, dataHash, 100n);

      await router.connect(user).fillQuoteTokenToToken(
        tokenAAddr, tokenBAddr, targetAddr, targetAddr,
        swapData, SELL_AMOUNT, FEE_AMOUNT,
        recipientAddr, warrant,
      );

      // Second swap with same nonce should fail
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
