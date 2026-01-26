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
    // const rainbowRouterInstance = await routerFactory.attach("YOUR_ROUTER_ADDRESS") as OkuRouter; // Or deploy if needed
    // const wethFactory = await hre.ethers.getContractFactory("IWETH", deployerSigner);
    // const wethContract = await wethFactory.attach(WETH_ADDRESS) as IWETH;
    // return { rainbowRouterInstance, wethContract, deployer: deployerSigner };
    let { okuRouterInstance, signer, wethContract, } = await init(); // Assuming init returns TypeChain types
    instance = okuRouterInstance;
    weth = wethContract;
    deployer = signer
    // deployer = initDeployer; // Store deployer if returned by init

    // Get signers using ethers
    signers = await hre.ethers.getSigners();
  });

  it("Should be able to withdraw tokens", async function () {
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

    // 3 - Withdraw the tokens (owner makes the call)
    const withdrawTokenTx = instance.connect(owner).withdrawToken(
      wethAddress,
      receiverAddress,
      amount
    );

    // 4 - Assert event emission
    await expect(withdrawTokenTx)
      .to.emit(instance, "TokenWithdrawn")
      .withArgs(
        // Custom predicate for the first address argument (wethAddress)
        (emittedWethAddress: any) => {
          // Basic type check and case-insensitive comparison
          return typeof emittedWethAddress === 'string' &&
            emittedWethAddress.toLowerCase() === wethAddress.toLowerCase();
        },
        // Custom predicate for the second address argument (receiverAddress)
        (emittedReceiverAddress: any) => {
          // Basic type check and case-insensitive comparison
          return typeof emittedReceiverAddress === 'string' &&
            emittedReceiverAddress.toLowerCase() === receiverAddress.toLowerCase();
        },
        // Direct comparison for the third argument (amount)
        amount
      );

    const wethBalanceInContractAfterWithdraw = await weth.balanceOf(instanceAddress);
    const wethBalanceInReceiver = await weth.balanceOf(receiverAddress);

    // 5 - Confirm the tokens were moved
    expect(wethBalanceInContractAfterWithdraw).to.equal(0n);
    expect(wethBalanceInReceiver).to.equal(amount);
  });


  it("Should revert if attempting to withdraw tokens when sender is not the owner", async function () {
    // 1 - Send some tokens to the contract
    const amount = 10000000n;
    const [owner, nonOwner, receiver] = signers;

    const instanceAddress = await instance.getAddress();
    const wethAddress = await weth.getAddress();
    const receiverAddress = await receiver.getAddress();

    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(instanceAddress, amount);

    // 2 - Check that the router contract is holding some tokens
    const wethBalanceInContractBeforeWithdraw = await weth.balanceOf(instanceAddress);
    expect(wethBalanceInContractBeforeWithdraw).to.equal(amount);

    // 3 - Attempt to withdraw the tokens using a non-owner account
    await expect(
      instance.connect(nonOwner).withdrawToken(wethAddress, receiverAddress, amount)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
  });

  it("Should be able to withdraw ETH", async function () {
    // 1 - Send some ETH to the contract
    const amount = 10000000n;
    const [owner, , receiver] = signers;
    const instanceAddress = await instance.getAddress();
    const receiverAddress = await receiver.getAddress();

    // Send ETH from owner to the contract instance
    await owner.sendTransaction({ to: instanceAddress, value: amount });

    // 2 - Check that the router contract is holding some ETH
    const startingEthBalanceInReceiver = await hre.ethers.provider.getBalance(receiverAddress);
    const ethBalanceInContractBeforeWithdraw = await hre.ethers.provider.getBalance(instanceAddress);
    expect(ethBalanceInContractBeforeWithdraw).to.equal(amount);

    // 3 - Withdraw the ETH
    const withdrawEthTx = instance.connect(owner).withdrawEth(receiverAddress, amount);

    // Assert event emission
    await expect(withdrawEthTx)
      .to.emit(instance, "EthWithdrawn")
      .withArgs(receiverAddress, amount);

    const ethBalanceInContractAfterWithdraw = await hre.ethers.provider.getBalance(instanceAddress);
    const ethBalanceInReceiver = await hre.ethers.provider.getBalance(receiverAddress);

    // 4 - Confirm the ETH was moved
    expect(ethBalanceInContractAfterWithdraw).to.equal(0n);

    // Calculate expected balance (ignoring gas costs for the withdrawal tx itself)
    const finalReceiverExpectedBalance = startingEthBalanceInReceiver + amount;
    expect(ethBalanceInReceiver).to.equal(finalReceiverExpectedBalance);
  });


  it("Should revert if attempting to withdraw ETH when sender is not the owner", async function () {
    // 1 - Send some ETH to the contract
    const amount = 10000000n;
    const [owner, nonOwner, receiver] = signers;
    const instanceAddress = await instance.getAddress();
    const receiverAddress = await receiver.getAddress();

    await owner.sendTransaction({ to: instanceAddress, value: amount });

    // 2 - Check that the router contract is holding some ETH
    const ethBalanceInContractBeforeWithdraw = await hre.ethers.provider.getBalance(instanceAddress);
    expect(ethBalanceInContractBeforeWithdraw).to.equal(amount);

    // 3 - Attempt to withdraw the ETH using a non-owner account
    await expect(
      instance.connect(nonOwner).withdrawEth(receiverAddress, amount)
    ).to.be.revertedWithCustomError(instance, "OwnableUnauthorizedAccount");
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

    // 2 - Approve the Rainbow contract to transfer WETH from the victim's account
    await weth.connect(victim).approve(instanceAddress, amount);

    // 3 - Get some WETH to the attacker
    await weth.connect(attacker).deposit({ value: attackerSellAmount });

    // 4 - Approve the Rainbow contract to transfer WETH from the attacker's account
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

    // 3 - Approve the Rainbow contract to transfer WETH from the attacker's account
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

    it("should allow withdrawToken when paused", async () => {
      const amount = 10000000n;
      const [owner, , receiver] = signers;

      const instanceAddress = await instance.getAddress();
      const wethAddress = await weth.getAddress();
      const receiverAddress = await receiver.getAddress();

      // Setup: Send tokens to contract
      await weth.connect(owner).deposit({ value: amount });
      await weth.connect(owner).transfer(instanceAddress, amount);

      // Pause
      await instance.connect(owner).pause();

      // Withdraw should still work
      await expect(
        instance.connect(owner).withdrawToken(wethAddress, receiverAddress, amount)
      ).to.not.be.reverted;

      const receiverBalance = await weth.balanceOf(receiverAddress);
      expect(receiverBalance).to.be.gte(amount);

      // Cleanup
      await instance.connect(owner).unpause();
    });

    it("should allow withdrawEth when paused", async () => {
      const amount = 10000000n;
      const [owner, , receiver] = signers;
      const instanceAddress = await instance.getAddress();
      const receiverAddress = await receiver.getAddress();

      // Setup: Send ETH to contract
      await owner.sendTransaction({ to: instanceAddress, value: amount });

      const initialReceiverBalance = await hre.ethers.provider.getBalance(receiverAddress);

      // Pause
      await instance.connect(owner).pause();

      // Withdraw should still work
      await expect(
        instance.connect(owner).withdrawEth(receiverAddress, amount)
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