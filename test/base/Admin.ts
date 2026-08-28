/**
 * This file tests all the "admin" features:
 * - fee withdrawals
 * - token approvals
 */

import { expect } from "chai";
import { network, ethers } from "hardhat";
import { init, MAINNET_ADDRESS_1INCH, WETH_ADDRESS } from "../utils"; // Assuming init is updated for ethers
import hre from "hardhat";
import { ZeroAddress, type Signer } from "ethers"; // Import Signer type from ethers

// Import TypeChain generated types
// Adjust the path based on your TypeChain output directory
import type { OkuRouter, IWETH } from "../../typechain-types";

// Define a placeholder type for the return value of your updated init function using TypeChain types
type EthersInitReturnType = {
  okuRouterInstance: OkuRouter;
  wethContract: IWETH;
  deployer: Signer; // Assuming init might return the deployer signer
  // Add other return values from init if necessary
};

describe("Admin", function () {
  let instance: OkuRouter;
  let weth: IWETH;

  let signers: Signer[];
  let deployer: Signer;

  before(async () => {

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            blockNumber: 15214922,
            jsonRpcUrl: process.env.MAINNET_RPC_ENDPOINT,
          },
        },
      ],
    });

    // Assume init is updated to use ethers and returns TypeChain contract instances & potentially a signer
    // It might look something like this internally:
    // const [deployerSigner] = await hre.ethers.getSigners();
    // const routerFactory = await hre.ethers.getContractFactory("OkuRouter", deployerSigner);
    // const okuRouterInstance = await routerFactory.attach("YOUR_ROUTER_ADDRESS") as OkuRouter; // Or deploy if needed
    // const wethFactory = await hre.ethers.getContractFactory("IWETH", deployerSigner);
    // const wethContract = await wethFactory.attach(WETH_ADDRESS) as IWETH;
    // return { okuRouterInstance, wethContract, deployer: deployerSigner };
    let { okuRouterInstance, signer, wethContract, } = await init(); // Assuming init returns TypeChain types
    instance = okuRouterInstance;
    weth = wethContract;
    deployer = signer
    // deployer = initDeployer; // Store deployer if returned by init

    // Get signers using ethers
    signers = await hre.ethers.getSigners();
  });

  it("Should be able to sweep a single token's full balance", async function () {
    // 1 - Send some tokens to the contract
    const amount = 10000000n;
    const [owner, , receiver] = signers; // Get owner and receiver signers

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Deposit WETH using the owner account
    await weth.connect(owner).deposit({ value: amount });
    // Transfer WETH to the router instance
    await weth.connect(owner).transfer(instanceAddress, amount);

    // 2 - Check that the router contract is holding some tokens
    const wethBalanceInContractBeforeWithdraw = await weth.balanceOf(instanceAddress);
    expect(wethBalanceInContractBeforeWithdraw).to.equal(amount);

    const receiverBalanceBefore = await weth.balanceOf(receiverAddress);

    // 3 - Sweep the tokens (owner makes the call)
    const sweepTx = instance.connect(owner).sweepAll(
      [wethAddress],
      false,
      receiverAddress
    );

    // 4 - Assert event emission
    await expect(sweepTx)
      .to.emit(instance, "TokenWithdrawn")
      .withArgs(
        (emittedWethAddress: string) => {
          return emittedWethAddress.toLowerCase() === wethAddress.toLowerCase();
        },
        (emittedReceiverAddress: string) => {
          return emittedReceiverAddress.toLowerCase() === receiverAddress.toLowerCase();
        },
        amount
      );

    const wethBalanceInContractAfterWithdraw = await weth.balanceOf(instanceAddress);
    const wethBalanceInReceiver = await weth.balanceOf(receiverAddress);

    // 5 - Confirm the tokens were moved
    expect(wethBalanceInContractAfterWithdraw).to.equal(0n);
    expect(wethBalanceInReceiver).to.equal(receiverBalanceBefore + amount);
  });

  it("Should silently skip zero-balance tokens when sweeping", async function () {
    const amount = 10000000n;
    const [owner, , receiver] = signers;

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Pre-sweep cleanup so we know the contract has zero WETH to start.
    const startingContractBalance = await weth.balanceOf(instanceAddress);
    if (startingContractBalance > 0n) {
      await instance.connect(owner).sweepAll([wethAddress], false, receiverAddress);
    }
    expect(await weth.balanceOf(instanceAddress)).to.equal(0n);

    // Sweeping a zero-balance token should not revert and should NOT emit TokenWithdrawn.
    const tx = instance.connect(owner).sweepAll([wethAddress], false, receiverAddress);
    await expect(tx).to.not.emit(instance, "TokenWithdrawn");

    // Now seed the contract and confirm a mixed call sweeps real balances and skips zero.
    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(instanceAddress, amount);

    // Duplicate the token to also exercise the "second pass is a no-op" path.
    await expect(
      instance.connect(owner).sweepAll([wethAddress, wethAddress], false, receiverAddress)
    )
      .to.emit(instance, "TokenWithdrawn"); // first pass emits; second pass is a silent no-op.

    expect(await weth.balanceOf(instanceAddress)).to.equal(0n);
  });

  it("Should revert sweepAll if sender is not the owner", async function () {
    const amount = 10000000n;
    const [owner, nonOwner, receiver] = signers;

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const receiverAddress = await receiver.getAddress();

    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(instanceAddress, amount);

    await expect(
      instance.connect(nonOwner).sweepAll([wethAddress], false, receiverAddress)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");

    // Cleanup
    await instance.connect(owner).sweepAll([wethAddress], false, receiverAddress);
  });

  it("Should revert sweepAll if `to` is the zero address", async function () {
    const [owner] = signers;
    const wethAddress = await weth.getAddress();

    await expect(
      instance.connect(owner).sweepAll([wethAddress], false, ZeroAddress)
    ).to.be.revertedWith("ZERO_ADDRESS");
  });

  it("Should revert sweepAll when tokens is empty and includeEth is false", async function () {
    const [owner, , receiver] = signers;
    const receiverAddress = await receiver.getAddress();

    await expect(
      instance.connect(owner).sweepAll([], false, receiverAddress)
    ).to.be.revertedWith("NOTHING_TO_SWEEP");
  });

  it("Should be able to sweep ETH via includeEth", async function () {
    const amount = 10000000n;
    const [owner, , receiver] = signers;
    const instanceAddress = await instance.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Send ETH from owner to the contract instance
    await owner.sendTransaction({ to: instanceAddress, value: amount });

    const startingEthBalanceInReceiver = await hre.ethers.provider.getBalance(receiverAddress);
    const ethBalanceInContractBeforeWithdraw = await hre.ethers.provider.getBalance(instanceAddress);
    expect(ethBalanceInContractBeforeWithdraw).to.equal(amount);

    const sweepTx = instance.connect(owner).sweepAll([], true, receiverAddress);

    await expect(sweepTx)
      .to.emit(instance, "EthWithdrawn")
      .withArgs(receiverAddress, amount);

    const ethBalanceInContractAfterWithdraw = await hre.ethers.provider.getBalance(instanceAddress);
    const ethBalanceInReceiver = await hre.ethers.provider.getBalance(receiverAddress);

    expect(ethBalanceInContractAfterWithdraw).to.equal(0n);
    expect(ethBalanceInReceiver).to.equal(startingEthBalanceInReceiver + amount);
  });

  it("Should not emit EthWithdrawn when includeEth is true but ETH balance is zero", async function () {
    const [owner, , receiver] = signers;
    const instanceAddress = await instance.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Drain any residual ETH first.
    if ((await hre.ethers.provider.getBalance(instanceAddress)) > 0n) {
      await instance.connect(owner).sweepAll([], true, receiverAddress);
    }
    expect(await hre.ethers.provider.getBalance(instanceAddress)).to.equal(0n);

    await expect(
      instance.connect(owner).sweepAll([], true, receiverAddress)
    ).to.not.emit(instance, "EthWithdrawn");
  });

  it("Should sweep multiple tokens and ETH in a single call", async function () {
    const amount = 10000000n;
    const ethAmount = 5000000n;
    const [owner, , receiver] = signers;
    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Seed contract with WETH and ETH.
    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(instanceAddress, amount);
    await owner.sendTransaction({ to: instanceAddress, value: ethAmount });

    const receiverWethBefore = await weth.balanceOf(receiverAddress);
    const receiverEthBefore = await hre.ethers.provider.getBalance(receiverAddress);

    const tx = instance.connect(owner).sweepAll([wethAddress], true, receiverAddress);
    await expect(tx).to.emit(instance, "TokenWithdrawn");
    await expect(tx).to.emit(instance, "EthWithdrawn").withArgs(receiverAddress, ethAmount);

    expect(await weth.balanceOf(instanceAddress)).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(instanceAddress)).to.equal(0n);
    expect(await weth.balanceOf(receiverAddress)).to.equal(receiverWethBefore + amount);
    expect(await hre.ethers.provider.getBalance(receiverAddress)).to.equal(receiverEthBefore + ethAmount);
  });

  it("Should be able to add swap targets", async function () {
    const [owner] = signers;
    const targetAddress = hre.ethers.getAddress(MAINNET_ADDRESS_1INCH); // Ensure checksum

    const addTargetTx = instance.connect(owner).updateSwapTargets(targetAddress, true);

    await expect(addTargetTx)
      .to.emit(instance, "SwapTargetAdded")
      .withArgs(targetAddress);

    const exists = await instance.swapTargets(targetAddress);
    expect(exists).to.equal(true);
  });

  it("Should be able to remove swap targets", async function () {
    const [owner] = signers;
    const targetAddress = hre.ethers.getAddress(MAINNET_ADDRESS_1INCH); // Ensure checksum

    // Ensure the target exists first (add it if necessary, or assume previous test ran)
    if (!(await instance.swapTargets(targetAddress))) {
      await instance.connect(owner).updateSwapTargets(targetAddress, true);
    }

    const removeTargetTx = instance.connect(owner).updateSwapTargets(targetAddress, false);

    await expect(removeTargetTx)
      .to.emit(instance, "SwapTargetRemoved")
      .withArgs(targetAddress);

    const exists = await instance.swapTargets(targetAddress);
    expect(exists).to.equal(false);
  });


  it("Should revert if attempting to add swap targets when sender is not the owner", async function () {
    const [, nonOwner] = signers;
    const targetAddress = hre.ethers.getAddress(MAINNET_ADDRESS_1INCH);

    await expect(
      instance.connect(nonOwner).updateSwapTargets(targetAddress, true)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
  });

  it("Should revert if attempting to remove swap targets when sender is not the owner", async function () {
    const [owner, nonOwner] = signers;
    const targetAddress = hre.ethers.getAddress(MAINNET_ADDRESS_1INCH);

    // Make sure target exists so removal attempt is valid logic (owner adds it first)
    if (!(await instance.swapTargets(targetAddress))) {
      await instance.connect(owner).updateSwapTargets(targetAddress, true);
    }

    await expect(
      instance.connect(nonOwner).updateSwapTargets(targetAddress, false)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
  });

  it("Should allow setting zero address as pending owner (but cannot accept)", async function () {
    const [owner] = signers;

    const transferTx = instance.connect(owner).transferOwnership(hre.ethers.ZeroAddress);

    await expect(transferTx)
      .to.emit(instance, "OwnershipTransferStarted")
      .withArgs(await owner.getAddress(), hre.ethers.ZeroAddress);

    expect(await instance.pendingOwner()).to.equal(hre.ethers.ZeroAddress);
    expect(await instance.owner()).to.equal(await owner.getAddress()); // Still old owner
  });

  it("Should be able to transfer ownership (two-step process)", async function () {
    const [owner, newOwner] = signers;
    const previousOwnerAddress = await owner.getAddress();
    const newOwnerAddress = await newOwner.getAddress();

    // Step 1: Current owner initiates transfer
    const transferTx = instance.connect(owner).transferOwnership(newOwnerAddress);
    await expect(transferTx)
      .to.emit(instance, "OwnershipTransferStarted")
      .withArgs(previousOwnerAddress, newOwnerAddress);

    expect(await instance.pendingOwner()).to.equal(newOwnerAddress);
    expect(await instance.owner()).to.equal(previousOwnerAddress); // Not changed yet

    // Step 2: New owner accepts ownership
    const acceptTx = instance.connect(newOwner).acceptOwnership();
    await expect(acceptTx)
      .to.emit(instance, "OwnershipTransferred")
      .withArgs(previousOwnerAddress, newOwnerAddress);

    expect(await instance.owner()).to.equal(newOwnerAddress);
    expect(await instance.pendingOwner()).to.equal(hre.ethers.ZeroAddress); // Cleared

    // IMPORTANT: Transfer ownership back for subsequent tests (two-step)
    await instance.connect(newOwner).transferOwnership(previousOwnerAddress);
    await instance.connect(owner).acceptOwnership();
    expect(await instance.owner()).to.equal(previousOwnerAddress); // Verify it's back
  });

  it("Should revert if attempting transferOwnership when sender is not the owner", async function () {
    const [, newOwnerCandidate, nonOwner] = signers; // owner is signers[0] due to reset or transfer back
    const newOwnerAddress = await newOwnerCandidate.getAddress();

    await expect(
      instance.connect(nonOwner).transferOwnership(newOwnerAddress)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
  });

  describe("Ownable2Step Functionality", function () {

    it("Should allow pending owner to accept ownership", async function () {
      const [owner, newOwner] = signers;
      const ownerAddress = await owner.getAddress();
      const newOwnerAddress = await newOwner.getAddress();

      await instance.connect(owner).transferOwnership(newOwnerAddress);

      const acceptTx = instance.connect(newOwner).acceptOwnership();
      await expect(acceptTx)
        .to.emit(instance, "OwnershipTransferred")
        .withArgs(ownerAddress, newOwnerAddress);

      expect(await instance.owner()).to.equal(newOwnerAddress);

      // Cleanup
      await instance.connect(newOwner).transferOwnership(ownerAddress);
      await instance.connect(owner).acceptOwnership();
    });

    it("Should revert if non-pending owner tries to accept", async function () {
      const [owner, newOwner, otherAccount] = signers;
      const newOwnerAddress = await newOwner.getAddress();
      const otherAddress = await otherAccount.getAddress();

      await instance.connect(owner).transferOwnership(newOwnerAddress);

      await expect(
        instance.connect(otherAccount).acceptOwnership()
      ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount")
        .withArgs(otherAddress);
    });

    it("Should allow owner to replace pending owner before acceptance", async function () {
      const [owner, firstCandidate, secondCandidate] = signers;
      const firstAddress = await firstCandidate.getAddress();
      const secondAddress = await secondCandidate.getAddress();

      await instance.connect(owner).transferOwnership(firstAddress);
      expect(await instance.pendingOwner()).to.equal(firstAddress);

      // Replace with second pending owner
      await instance.connect(owner).transferOwnership(secondAddress);
      expect(await instance.pendingOwner()).to.equal(secondAddress);

      // First candidate can no longer accept
      await expect(
        instance.connect(firstCandidate).acceptOwnership()
      ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");

      // Second candidate can accept
      await instance.connect(secondCandidate).acceptOwnership();
      expect(await instance.owner()).to.equal(secondAddress);

      // Cleanup
      await instance.connect(secondCandidate).transferOwnership(await owner.getAddress());
      await instance.connect(owner).acceptOwnership();
    });

    it("Should clear pending owner after acceptance", async function () {
      const [owner, newOwner] = signers;
      const ownerAddress = await owner.getAddress();
      const newOwnerAddress = await newOwner.getAddress();

      await instance.connect(owner).transferOwnership(newOwnerAddress);
      expect(await instance.pendingOwner()).to.equal(newOwnerAddress);

      await instance.connect(newOwner).acceptOwnership();
      expect(await instance.pendingOwner()).to.equal(hre.ethers.ZeroAddress);

      // Cleanup
      await instance.connect(newOwner).transferOwnership(ownerAddress);
      await instance.connect(owner).acceptOwnership();
    });

    it("Should handle admin functions during pending transfer", async function () {
      const [owner, newOwner] = signers;
      const newOwnerAddress = await newOwner.getAddress();
      const targetAddress = "0x1111111111111111111111111111111111111111";

      // Initiate transfer
      await instance.connect(owner).transferOwnership(newOwnerAddress);

      // Current owner can still execute admin functions
      await expect(
        instance.connect(owner).updateSwapTargets(targetAddress, true)
      ).to.not.be.reverted;

      // Pending owner cannot execute admin functions yet
      await expect(
        instance.connect(newOwner).updateSwapTargets(targetAddress, false)
      ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");

      // After acceptance, new owner can execute
      await instance.connect(newOwner).acceptOwnership();
      await expect(
        instance.connect(newOwner).updateSwapTargets(targetAddress, false)
      ).to.not.be.reverted;

      // Cleanup
      await instance.connect(newOwner).transferOwnership(await owner.getAddress());
      await instance.connect(owner).acceptOwnership();
    });
  });

  it('Should revert if an attacker attempts "Approval snatching" from a victim that previously approved an ERC20 token on OkuRouter', async function () {
    const amount = 10000000n;
    const attackerSellAmount = 1n;
    const [, victim, attacker] = signers; // Get specific signers

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const victimAddress = await victim.getAddress();
    const attackerAddress = await attacker.getAddress();


    // 1 - Get some WETH to the victim
    await weth.connect(victim).deposit({ value: amount });

    // 2 - Approve the Router contract to transfer WETH from the victim's account
    await weth.connect(victim).approve(instanceAddress, amount);

    // 3 - Get some WETH to the attacker
    await weth.connect(attacker).deposit({ value: attackerSellAmount });

    // 4 - Approve the Router contract to transfer WETH from the attacker's account
    await weth.connect(attacker).approve(instanceAddress, attackerSellAmount);

    // 5 - Encode malicious calldata using ethers Interface (available on TypeChain instance)
    const maliciousCalldata = weth.interface.encodeFunctionData("transferFrom", [
      victimAddress,
      attackerAddress,
      amount,
    ]);

    //placeholder warrant
    const warrant = {
      nonce: await attacker.getNonce(),
      validBefore: (Math.floor(Date.now() / 1000)) + 5000,
      validAfter: (Math.floor(Date.now() / 1000)) - 5000,
      verifyingSigner: ZeroAddress,
      signature: "0x"
    }

    //validate zaddr as signer to bypass warrant for now
    await instance.connect(deployer).updateValidSigner(ZeroAddress, true)

    // 6 - Call swap aggregator with the malicious calldata
    // Assume fillQuoteTokenToEth exists and takes these args
    await expect(
      instance.connect(attacker).fillQuoteTokenToEth(
        wethAddress, // tokenToSell? - Assuming WETH
        wethAddress, // target token address? Needs clarification based on function signature
        wethAddress, // approvalTarget - same as target for this test
        maliciousCalldata, // The swap calldata to the target
        attackerSellAmount, // amountToSell
        0n, // minAmountOut
        attackerAddress, // recipient
        warrant,
        { value: 0n } // msg.value if needed
      )
    ).to.be.revertedWith("TARGET_NOT_AUTH"); // Assuming this is the correct revert string
  });

  // This test assumes the contract holds WETH from a previous failed withdrawal or requires setup
  it('Should revert if an attacker attempts "Approval snatching" trying to steal collected fees from OkuRouter', async function () {
    const setupAmount = 10000000n; // Amount assumed to be in the contract
    const attackerSellAmount = 1n;
    const [owner, _, attacker] = signers; // Get owner and attacker

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const attackerAddress = await attacker.getAddress();

    // Ensure the contract has WETH balance (e.g., deposit directly for test isolation)
    await weth.connect(owner).deposit({ value: setupAmount });
    await weth.connect(owner).transfer(instanceAddress, setupAmount);

    // 1 - Check that the router contract is holding some tokens
    const wethBalanceInContract = await weth.balanceOf(instanceAddress);
    expect(wethBalanceInContract).to.be.gt(0n); // Check it has *some* balance

    // 2 - Get some WETH to the attacker
    await weth.connect(attacker).deposit({ value: attackerSellAmount });

    // 3 - Approve the Router contract to transfer WETH from the attacker's account
    await weth.connect(attacker).approve(instanceAddress, attackerSellAmount);

    // 4 - Encode malicious calldata to steal funds *from* the router contract
    const maliciousCalldata = weth.interface.encodeFunctionData("transferFrom", [
      instanceAddress,      // Steal FROM instance
      attackerAddress,      // Send TO attacker
      wethBalanceInContract, // Steal the entire balance
    ]);

    //placeholder warrant
    const warrant = {
      nonce: await attacker.getNonce(),
      validBefore: (Math.floor(Date.now() / 1000)) + 5000,
      validAfter: (Math.floor(Date.now() / 1000)) - 5000,
      verifyingSigner: ZeroAddress,
      signature: "0x"
    }

    // 5 - Call swap aggregator with the malicious calldata
    await expect(
      instance.connect(attacker).fillQuoteTokenToEth(
        wethAddress,
        wethAddress, // Adjust if needed
        wethAddress, // approvalTarget - same as target for this test
        maliciousCalldata,
        attackerSellAmount,
        0n,
        attackerAddress, // recipient
        warrant,
        { value: 0n }
      )
    ).to.be.revertedWith("TARGET_NOT_AUTH");
  });

  // This test might fail if the contract has a receive() or fallback() payable function
  // unless specifically designed to reject ETH from non-targets.
  it("Should revert if someone that is not an allowed swap target sends eth", async function () {
    const [, sender] = signers; // Use any signer (assuming they are not an allowed target)
    const instanceAddress = await instance.getAddress();

    // Check if the contract can actually receive ETH via fallback/receive
    // If it's designed to *only* receive ETH via specific functions, this test is valid.
    // If it has a general payable fallback, this test might need adjustment or may indicate
    // a design flaw if the intent was to block direct sends.

    // The revert reason "NO_RECEIVE" suggests a specific check, possibly in receive() or fallback()
    await expect(
      sender.sendTransaction({
        to: instanceAddress,
        value: ethers.parseEther("0.001"), // Send a small amount of ETH
      })
    ).to.be.revertedWith("NO_RECEIVE"); // Match the expected custom error
    // OR ).to.be.reverted(); // If no specific reason is given / no fallback exists
  });

  describe("Pausable Functionality", () => {
    // Ensure contract starts in unpaused state before each test
    beforeEach(async () => {
      const [owner] = signers;
      const isPaused = await instance.paused();
      if (isPaused) {
        await instance.connect(owner).unpause();
      }
    });

    it("should allow owner to pause the contract", async () => {
      const [owner] = signers;
      const ownerAddress = await owner.getAddress();

      await expect(instance.connect(owner).pause())
        .to.emit(instance, "Paused")
        .withArgs(ownerAddress);

      expect(await instance.paused()).to.equal(true);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should allow owner to unpause the contract", async () => {
      const [owner] = signers;
      const ownerAddress = await owner.getAddress();

      await instance.connect(owner).pause();
      await expect(instance.connect(owner).unpause())
        .to.emit(instance, "Unpaused")
        .withArgs(ownerAddress);

      expect(await instance.paused()).to.equal(false);
    });

    it("should revert if non-owner tries to pause", async () => {
      const [, nonOwner] = signers;

      await expect(instance.connect(nonOwner).pause())
        .to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
    });

    it("should revert if non-owner tries to unpause", async () => {
      const [owner, nonOwner] = signers;

      await instance.connect(owner).pause();
      await expect(instance.connect(nonOwner).unpause())
        .to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");

      // Cleanup: unpause for next tests
      await instance.connect(owner).unpause();
    });

    it("should revert if trying to pause when already paused", async () => {
      const [owner] = signers;

      await instance.connect(owner).pause();
      await expect(instance.connect(owner).pause())
        .to.be.revertedWithCustomError(instance, "EnforcedPause");

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should revert if trying to unpause when not paused", async () => {
      const [owner] = signers;

      await expect(instance.connect(owner).unpause())
        .to.be.revertedWithCustomError(instance, "ExpectedPause");
    });

    it("should emit ContractPaused event", async () => {
      const [owner] = signers;
      const ownerAddress = await owner.getAddress();

      await expect(instance.connect(owner).pause())
        .to.emit(instance, "ContractPaused")
        .withArgs(ownerAddress);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should emit ContractUnpaused event", async () => {
      const [owner] = signers;
      const ownerAddress = await owner.getAddress();

      await instance.connect(owner).pause();
      await expect(instance.connect(owner).unpause())
        .to.emit(instance, "ContractUnpaused")
        .withArgs(ownerAddress);
    });

    it("should preserve swap target whitelist when paused", async () => {
      const [owner] = signers;
      const target = "0x1234567890123456789012345678901234567890";

      await instance.connect(owner).updateSwapTargets(target, true);
      await instance.connect(owner).pause();

      expect(await instance.swapTargets(target)).to.equal(true);

      await instance.connect(owner).unpause();
      expect(await instance.swapTargets(target)).to.equal(true);
    });

    it("should preserve valid signers when paused", async () => {
      const [owner] = signers;
      const signer = "0x1234567890123456789012345678901234567890";

      await instance.connect(owner).updateValidSigner(signer, true);
      await instance.connect(owner).pause();

      expect(await instance.validSigners(signer)).to.equal(true);

      await instance.connect(owner).unpause();
      expect(await instance.validSigners(signer)).to.equal(true);
    });

    it("should allow updateSwapTargets when paused", async () => {
      const [owner] = signers;
      const target = "0x2234567890123456789012345678901234567890";

      await instance.connect(owner).pause();

      await expect(instance.connect(owner).updateSwapTargets(target, true))
        .to.not.be.reverted;

      expect(await instance.swapTargets(target)).to.equal(true);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should allow updateValidSigner when paused", async () => {
      const [owner] = signers;
      const signer = "0x2234567890123456789012345678901234567890";

      await instance.connect(owner).pause();

      await expect(instance.connect(owner).updateValidSigner(signer, true))
        .to.not.be.reverted;

      expect(await instance.validSigners(signer)).to.equal(true);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should allow sweepAll (tokens) when paused", async () => {
      const amount = 10000000n;
      const [owner, , receiver] = signers;

      const instanceAddress = await instance.getAddress();
      const wethAddress = await weth.getAddress();
      const receiverAddress = await receiver.getAddress();

      // Setup: Send tokens to contract
      await weth.connect(owner).deposit({ value: amount });
      await weth.connect(owner).transfer(instanceAddress, amount);

      const receiverBalanceBefore = await weth.balanceOf(receiverAddress);
      const contractBalanceBefore = await weth.balanceOf(instanceAddress);

      // Pause
      await instance.connect(owner).pause();

      // Sweep should still work
      await expect(
        instance.connect(owner).sweepAll([wethAddress], false, receiverAddress)
      ).to.not.be.reverted;

      // Contract is fully drained; receiver gained the entire contract balance.
      expect(await weth.balanceOf(instanceAddress)).to.equal(0n);
      expect(await weth.balanceOf(receiverAddress)).to.equal(
        receiverBalanceBefore + contractBalanceBefore
      );

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should allow sweepAll (ETH) when paused", async () => {
      const amount = 10000000n;
      const [owner, , receiver] = signers;
      const instanceAddress = await instance.getAddress();
      const receiverAddress = await receiver.getAddress();

      // Setup: Send ETH to contract
      await owner.sendTransaction({ to: instanceAddress, value: amount });

      const initialReceiverBalance = await hre.ethers.provider.getBalance(receiverAddress);

      // Pause
      await instance.connect(owner).pause();

      // Sweep should still work
      await expect(
        instance.connect(owner).sweepAll([], true, receiverAddress)
      ).to.not.be.reverted;

      const finalReceiverBalance = await hre.ethers.provider.getBalance(receiverAddress);
      expect(finalReceiverBalance).to.equal(initialReceiverBalance + amount);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should block fillQuoteTokenToEth when paused", async () => {
      const [owner] = signers;
      const wethAddress = await weth.getAddress();
      const targetAddress = hre.ethers.getAddress(MAINNET_ADDRESS_1INCH);

      // Setup
      await instance.connect(owner).updateSwapTargets(targetAddress, true);
      await instance.connect(owner).updateValidSigner(ZeroAddress, true);

      const warrant = {
        nonce: 0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        validAfter: Math.floor(Date.now() / 1000) - 60,
        verifyingSigner: ZeroAddress,
        signature: "0x"
      };

      // Pause
      await instance.connect(owner).pause();

      // Attempt swap - should revert
      await expect(
        instance.connect(owner).fillQuoteTokenToEth(
          wethAddress,
          targetAddress,
          targetAddress,
          "0x",
          1000000n,
          0n,
          await owner.getAddress(), // recipient
          warrant
        )
      ).to.be.revertedWithCustomError(instance, "EnforcedPause");

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should handle multiple pause/unpause cycles correctly", async () => {
      const [owner] = signers;

      // First cycle
      await instance.connect(owner).pause();
      expect(await instance.paused()).to.equal(true);
      await instance.connect(owner).unpause();
      expect(await instance.paused()).to.equal(false);

      // Second cycle
      await instance.connect(owner).pause();
      expect(await instance.paused()).to.equal(true);
      await instance.connect(owner).unpause();
      expect(await instance.paused()).to.equal(false);

      // Third cycle
      await instance.connect(owner).pause();
      expect(await instance.paused()).to.equal(true);
      await instance.connect(owner).unpause();
      expect(await instance.paused()).to.equal(false);
    });
  });
});