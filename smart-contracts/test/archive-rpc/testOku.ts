import { OkuRouter, OkuRouter__factory } from "../../typechain-types"
import { ERC20, IERC20 } from "../../typechain-types/contracts/interfaces/openzeppelin"
import { AbiCoder, Interface, Signer, ZeroAddress } from "ethers"
import { ERC20__factory, IERC20__factory } from "../../typechain-types/factories/contracts/interfaces/openzeppelin"
import { generatePermitSignature } from "../../util/canoeHelper"
import { generateUniTxData, stealMoney } from "../../util/testHelpers"
import { tryFork, FORK_CONFIGS } from "../../util/forkHelper"
import { expect } from "chai"
import { Sign } from "crypto"
const { ethers } = require("hardhat")

/**
 * Test Rainbow Specific Functions
 * NOTE: Requires archive RPC (OP_URL env var). Tests skip gracefully if unavailable.
 */
describe("Test Oku Specific Functions", function () {

    const name = "Oku Router" // EIP-712 Domain Name
    const version = "1.0" // EIP-712 Domain Version
    const usdcNativeWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" // Balancer Vault on Optimism
    let USDC: ERC20
    let WETH: IERC20

    let nonOwner: Signer
    let newTarget: string
    let owner: Signer
    let recipient: Signer
    let recipientAddress: string
    let Rainbow: OkuRouter

    before(async function () {
        this.timeout(30000)

        // Try to fork Optimism - skip all tests if RPC unavailable
        const success = await tryFork(FORK_CONFIGS.OPTIMISM)
        if (!success) {
            this.skip()
        }

        const signers = await ethers.getSigners()
        owner = signers[0]
        nonOwner = signers[1]
        newTarget = await signers[2].getAddress()
        recipient = signers[3]
        recipientAddress = await recipient.getAddress()

        const ownerAddress = await owner.getAddress();
        Rainbow = await new OkuRouter__factory(owner).deploy(name, version, ownerAddress, ethers.ZeroAddress)

        const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" // Optimism USDC
        USDC = ERC20__factory.connect(usdcAddress, owner)
        WETH = IERC20__factory.connect("0x4200000000000000000000000000000000000006", owner) // Optimism WETH

    })

    it("Should allow owner to receive ETH", async () => {
        const rainbowAddress = await Rainbow.getAddress()
        const amountToSend = ethers.parseEther("0.1")
        const initialBalance = await ethers.provider.getBalance(rainbowAddress)

        const tx = await owner.sendTransaction({
            to: rainbowAddress,
            value: amountToSend
        })
        await tx.wait()

        const finalBalance = await ethers.provider.getBalance(rainbowAddress)
        expect(finalBalance).to.equal(initialBalance + amountToSend)
    })

    it("Should NOT allow non-owner to receive ETH directly", async () => {
        const rainbowAddress = await Rainbow.getAddress()
        const amountToSend = ethers.parseEther("0.1")

        await expect(nonOwner.sendTransaction({
            to: rainbowAddress,
            value: amountToSend
        })).to.be.revertedWith("NO_RECEIVE")
    })

    describe("updateSwapTargets", () => {

        it("Should allow owner to add a swap target", async () => {
            await expect(Rainbow.connect(owner).updateSwapTargets(newTarget, true))
                .to.emit(Rainbow, "SwapTargetAdded")
                .withArgs(newTarget)
            expect(await Rainbow.swapTargets(newTarget)).to.be.true
        })

        it("Should allow owner to remove a swap target", async () => {
            // Ensure target is added first for removal test
            await Rainbow.connect(owner).updateSwapTargets(newTarget, true)
            expect(await Rainbow.swapTargets(newTarget)).to.be.true // Verify it was added

            await expect(Rainbow.connect(owner).updateSwapTargets(newTarget, false))
                .to.emit(Rainbow, "SwapTargetRemoved")
                .withArgs(newTarget)
            expect(await Rainbow.swapTargets(newTarget)).to.be.false
        })

        it("Should prevent non-owner from updating swap targets", async () => {
            await expect(Rainbow.connect(nonOwner).updateSwapTargets(newTarget, true))
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })

        it("Should handle multiple add/remove cycles correctly", async () => {
            const target = newTarget
            // Add -> Remove -> Add -> Remove
            await Rainbow.connect(owner).updateSwapTargets(target, true)
            expect(await Rainbow.swapTargets(target)).to.be.true

            await Rainbow.connect(owner).updateSwapTargets(target, false)
            expect(await Rainbow.swapTargets(target)).to.be.false

            await Rainbow.connect(owner).updateSwapTargets(target, true)
            expect(await Rainbow.swapTargets(target)).to.be.true

            await Rainbow.connect(owner).updateSwapTargets(target, false)
            expect(await Rainbow.swapTargets(target)).to.be.false
        })

        it("Should allow adding zero address as swap target", async () => {
            // Edge case: zero address technically allowed for swap targets
            // (contract will check target approval, not zero-ness)
            await Rainbow.connect(owner).updateSwapTargets(ZeroAddress, true)
            expect(await Rainbow.swapTargets(ZeroAddress)).to.be.true
        })
    })

    describe("updateValidSigner", () => {
        const newSigner = ethers.Wallet.createRandom().address

        it("Should allow owner to add a valid signer", async () => {
            await expect(Rainbow.connect(owner).updateValidSigner(newSigner, true))
                .to.emit(Rainbow, "ValidSignerAdded")
                .withArgs(newSigner)
            expect(await Rainbow.validSigners(newSigner)).to.be.true
        })

        it("Should allow owner to remove a valid signer", async () => {
            // Ensure signer is added first for removal test
            await Rainbow.connect(owner).updateValidSigner(newSigner, true)
            expect(await Rainbow.validSigners(newSigner)).to.be.true // Verify it was added

            await expect(Rainbow.connect(owner).updateValidSigner(newSigner, false))
                .to.emit(Rainbow, "ValidSignerRemoved")
                .withArgs(newSigner)
            expect(await Rainbow.validSigners(newSigner)).to.be.false
        })

        it("Should prevent non-owner from updating valid signers", async () => {
            await expect(Rainbow.connect(nonOwner).updateValidSigner(newSigner, true))
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })

        it("Should allow adding zero address as valid signer (to bypass signature check)", async () => {
            // Zero address signer allows warrants without signature verification
            await Rainbow.connect(owner).updateValidSigner(ZeroAddress, true)
            expect(await Rainbow.validSigners(ZeroAddress)).to.be.true
        })

        it("Should handle multiple add/remove cycles for signers correctly", async () => {
            const signer = newSigner
            // Add -> Remove -> Add -> Remove
            await Rainbow.connect(owner).updateValidSigner(signer, true)
            expect(await Rainbow.validSigners(signer)).to.be.true

            await Rainbow.connect(owner).updateValidSigner(signer, false)
            expect(await Rainbow.validSigners(signer)).to.be.false

            await Rainbow.connect(owner).updateValidSigner(signer, true)
            expect(await Rainbow.validSigners(signer)).to.be.true

            await Rainbow.connect(owner).updateValidSigner(signer, false)
            expect(await Rainbow.validSigners(signer)).to.be.false
        })
    })

    describe("withdrawToken", () => {
        const withdrawAmount = ethers.parseUnits("5", 6) // 5 USDC
        let rainbowAddress: string
        let usdcAddress: string

        beforeEach(async () => {
            usdcAddress = await USDC.getAddress()
            rainbowAddress = await Rainbow.getAddress()
            await stealMoney(usdcNativeWhale, rainbowAddress, usdcAddress, withdrawAmount * 2n)
        })

        it("Should allow owner to withdraw ERC20 tokens", async () => {
            const initialContractBalance = await USDC.balanceOf(rainbowAddress)
            const initialRecipientBalance = await USDC.balanceOf(recipientAddress)

            await expect((Rainbow.connect(owner) as any).withdrawToken(usdcAddress, recipientAddress, withdrawAmount))
                .to.emit(Rainbow, "TokenWithdrawn")
                .withArgs(usdcAddress, recipientAddress, withdrawAmount)

            const finalContractBalance = await USDC.balanceOf(rainbowAddress)
            const finalRecipientBalance = await USDC.balanceOf(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance - withdrawAmount)
            expect(finalRecipientBalance).to.equal(initialRecipientBalance + withdrawAmount)
        })

        it("Should prevent withdrawing tokens to the zero address", async () => {
            await expect((Rainbow.connect(owner) as any).withdrawToken(usdcAddress, ZeroAddress, withdrawAmount))
                .to.be.revertedWith("ZERO_ADDRESS")
        })

        it("Should prevent non-owner from withdrawing tokens", async () => {
            await expect((Rainbow.connect(nonOwner) as any).withdrawToken(usdcAddress, recipientAddress, withdrawAmount))
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })

        it("Should revert if withdrawing more tokens than balance (via SafeERC20)", async () => {
            const currentBalance = await USDC.balanceOf(rainbowAddress);
            const excessAmount = currentBalance + 1n // Calculate amount just over balance
            await expect((Rainbow.connect(owner) as any).withdrawToken(usdcAddress, recipientAddress, excessAmount))
                .to.be.reverted // SafeERC20 reverts without specific message usually, or with "ERC20: transfer amount exceeds balance"
        })

        it("Should allow withdrawing zero tokens", async () => {
            // Edge case: zero amount withdrawal should succeed (no-op)
            const initialContractBalance = await USDC.balanceOf(rainbowAddress)
            const initialRecipientBalance = await USDC.balanceOf(recipientAddress)

            await expect((Rainbow.connect(owner) as any).withdrawToken(usdcAddress, recipientAddress, 0n))
                .to.emit(Rainbow, "TokenWithdrawn")
                .withArgs(usdcAddress, recipientAddress, 0n)

            const finalContractBalance = await USDC.balanceOf(rainbowAddress)
            const finalRecipientBalance = await USDC.balanceOf(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance)
            expect(finalRecipientBalance).to.equal(initialRecipientBalance)
        })

        it("Should allow withdrawing minimum token amount (1 wei)", async () => {
            const minAmount = 1n
            const initialContractBalance = await USDC.balanceOf(rainbowAddress)
            const initialRecipientBalance = await USDC.balanceOf(recipientAddress)

            await expect((Rainbow.connect(owner) as any).withdrawToken(usdcAddress, recipientAddress, minAmount))
                .to.emit(Rainbow, "TokenWithdrawn")
                .withArgs(usdcAddress, recipientAddress, minAmount)

            const finalContractBalance = await USDC.balanceOf(rainbowAddress)
            const finalRecipientBalance = await USDC.balanceOf(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance - minAmount)
            expect(finalRecipientBalance).to.equal(initialRecipientBalance + minAmount)
        })
    })

    describe("withdrawEth", () => {
        const withdrawAmount = ethers.parseEther("0.05")
        let rainbowAddress: string

        beforeEach(async () => {
            rainbowAddress = await Rainbow.getAddress()
            const fundTx = await owner.sendTransaction({ to: rainbowAddress, value: withdrawAmount * 2n })
            await fundTx.wait()
        })

        it("Should allow owner to withdraw ETH", async () => {
            const initialContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            const tx = await (Rainbow.connect(owner) as any).withdrawEth(recipientAddress, withdrawAmount)
            const receipt = await tx.wait()
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice // Calculate gas cost for accurate balance check if owner is recipient

            await expect(tx)
                .to.emit(Rainbow, "EthWithdrawn")
                .withArgs(recipientAddress, withdrawAmount)

            const finalContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const finalRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance - withdrawAmount)
            // Recipient balance check needs to account for potential gas costs if recipient is the tx sender (owner)
            if (recipientAddress === await owner.getAddress()) {
                // This case is less common for withdrawal tests but handled for completeness
                expect(finalRecipientBalance).to.equal(initialRecipientBalance + withdrawAmount - gasUsed)
            } else {
                expect(finalRecipientBalance).to.equal(initialRecipientBalance + withdrawAmount)
            }
        })

        it("Should prevent withdrawing ETH to the zero address", async () => {
            await expect((Rainbow.connect(owner) as any).withdrawEth(ZeroAddress, withdrawAmount))
                .to.be.revertedWith("ZERO_ADDRESS")
        })

        it("Should prevent non-owner from withdrawing ETH", async () => {
            await expect((Rainbow.connect(nonOwner) as any).withdrawEth(recipientAddress, withdrawAmount))
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })

        it("Should revert if withdrawing more ETH than balance", async () => {
            const currentBalance = await ethers.provider.getBalance(rainbowAddress);
            const excessAmount = currentBalance + ethers.parseEther("1") // Calculate amount clearly over balance
            await expect((Rainbow.connect(owner) as any).withdrawEth(recipientAddress, excessAmount))
                .to.be.reverted // Reverts due to insufficient balance (no specific message needed usually)
        })

        it("Should allow withdrawing zero ETH", async () => {
            // Edge case: zero amount withdrawal should succeed (no-op)
            const initialContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            await expect((Rainbow.connect(owner) as any).withdrawEth(recipientAddress, 0n))
                .to.emit(Rainbow, "EthWithdrawn")
                .withArgs(recipientAddress, 0n)

            const finalContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const finalRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance)
            expect(finalRecipientBalance).to.equal(initialRecipientBalance)
        })

        it("Should allow withdrawing minimum ETH amount (1 wei)", async () => {
            const minAmount = 1n
            const initialContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            await expect((Rainbow.connect(owner) as any).withdrawEth(recipientAddress, minAmount))
                .to.emit(Rainbow, "EthWithdrawn")
                .withArgs(recipientAddress, minAmount)

            const finalContractBalance = await ethers.provider.getBalance(rainbowAddress)
            const finalRecipientBalance = await ethers.provider.getBalance(recipientAddress)

            expect(finalContractBalance).to.equal(initialContractBalance - minAmount)
            expect(finalRecipientBalance).to.equal(initialRecipientBalance + minAmount)
        })
    })

    describe("transferOwnership", () => {
        let currentOwnerAddress: string
        let newOwnerAddress: string

        before(async () => {
            // Set the target new owner address once
            newOwnerAddress = await nonOwner.getAddress()
        })

        beforeEach(async () => {
            currentOwnerAddress = await owner.getAddress()
            // Ensure ownership is reset to the original 'owner' before each test in this block
            const currentContractOwner = await Rainbow.owner()
            if (currentContractOwner !== currentOwnerAddress) {
                // If the owner isn't the original one (e.g., from a prior test run), transfer it back.
                const tempOwnerSigner = await ethers.getSigner(currentContractOwner) // Get signer for the current contract owner
                await Rainbow.connect(tempOwnerSigner).transferOwnership(currentOwnerAddress)
                await Rainbow.connect(owner).acceptOwnership()
            }
            expect(await Rainbow.owner()).to.equal(currentOwnerAddress) // Verify owner is reset correctly
        })

        it("Should allow current owner to transfer ownership", async () => {
            // Step 1: Initiate transfer
            await expect(Rainbow.connect(owner).transferOwnership(newOwnerAddress))
                .to.emit(Rainbow, "OwnershipTransferStarted")
                .withArgs(currentOwnerAddress, newOwnerAddress)
            expect(await Rainbow.owner()).to.equal(currentOwnerAddress) // Owner not changed yet
            expect(await Rainbow.pendingOwner()).to.equal(newOwnerAddress) // Pending owner set

            // Step 2: Accept transfer
            await expect(Rainbow.connect(nonOwner).acceptOwnership())
                .to.emit(Rainbow, "OwnershipTransferred")
                .withArgs(currentOwnerAddress, newOwnerAddress)
            expect(await Rainbow.owner()).to.equal(newOwnerAddress)
            expect(await Rainbow.pendingOwner()).to.equal(ZeroAddress) // Pending cleared
        })

        it("Should allow setting zero address as pending owner (but cannot accept)", async () => {
            // Ownable2Step allows setting zero address as pending (validation happens on accept)
            await expect(Rainbow.connect(owner).transferOwnership(ZeroAddress))
                .to.emit(Rainbow, "OwnershipTransferStarted")
                .withArgs(currentOwnerAddress, ZeroAddress)
            expect(await Rainbow.pendingOwner()).to.equal(ZeroAddress)
            expect(await Rainbow.owner()).to.equal(currentOwnerAddress) // Owner unchanged
        })

        it("Should prevent non-owner from transferring ownership", async () => {
            await expect(Rainbow.connect(nonOwner).transferOwnership(recipientAddress)) // Attempt to transfer to recipient
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })

        it("New owner should be able to call owner-only functions", async () => {
            // Step 1: Initiate transfer
            await Rainbow.connect(owner).transferOwnership(newOwnerAddress)
            expect(await Rainbow.owner()).to.equal(currentOwnerAddress) // Owner not changed yet

            // Step 2: Accept transfer
            await Rainbow.connect(nonOwner).acceptOwnership()
            expect(await Rainbow.owner()).to.equal(newOwnerAddress) // Confirm transfer

            // Test an owner-only function (updateValidSigner) using the new owner (nonOwner signer)
            const testSigner = ethers.Wallet.createRandom().address
            await expect(Rainbow.connect(nonOwner).updateValidSigner(testSigner, true))
                .to.not.be.reverted
            expect(await Rainbow.validSigners(testSigner)).to.be.true // Verify state change
        })

        it("Old owner should NOT be able to call owner-only functions", async () => {
            // Step 1: Initiate transfer
            await Rainbow.connect(owner).transferOwnership(newOwnerAddress)
            expect(await Rainbow.owner()).to.equal(currentOwnerAddress) // Owner not changed yet

            // Step 2: Accept transfer
            await Rainbow.connect(nonOwner).acceptOwnership()
            expect(await Rainbow.owner()).to.equal(newOwnerAddress) // Confirm transfer

            // Test an owner-only function using the old owner (owner signer)
            const testSigner = ethers.Wallet.createRandom().address
            await expect(Rainbow.connect(owner).updateValidSigner(testSigner, true))
                .to.be.revertedWithCustomError(Rainbow, "OwnableUnauthorizedAccount")
        })
    })
})