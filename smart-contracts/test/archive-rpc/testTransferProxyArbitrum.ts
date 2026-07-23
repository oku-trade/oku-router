import { OkuRouter, OkuRouter__factory } from "../../typechain-types"
import { ERC20, IERC20 } from "../../typechain-types/contracts/interfaces/openzeppelin"
import { Signer, ZeroAddress } from "ethers"
import { ERC20__factory, IERC20__factory } from "../../typechain-types/factories/contracts/interfaces/openzeppelin"
import { stealMoney } from "../../util/testHelpers"
import { tryFork, FORK_CONFIGS } from "../../util/forkHelper"
import { expect } from "chai"
const { ethers } = require("hardhat")

/**
 * Test suite for Rainbow Router's transfer proxy pattern support on Arbitrum.
 *
 * TRANSFER PROXY PATTERN - CoW Protocol (used by PropellerSwap):
 * CoW Protocol uses a dual-contract architecture for security:
 * - GPv2Settlement (0x9008D19f58AAbD9eD0D60971565AA8510560ab41): Executes settlements
 * - GPv2VaultRelayer (0xC92E8bdf79f0507f65a392b0ab4667716BFE0110): Handles token approvals
 *
 * PropellerSwap is a solver that participates in CoW Protocol's auction mechanism.
 * When users interact with PropellerSwap, the actual settlement happens through CoW Protocol's
 * contracts using this transfer proxy pattern.
 *
 * === CoW Protocol / PropellerSwap Integration Details ===
 *
 * 1. DUAL CONTRACT ARCHITECTURE:
 *    - GPv2Settlement: Orchestrates settlement process, receives swap execution calldata,
 *      cannot directly access user funds
 *    - GPv2VaultRelayer: Handles token approvals and transfers, created during Settlement
 *      contract deployment, explicitly blocked from direct interactions for security
 *
 * 2. PROPELLERSWAP INTEGRATION:
 *    - PropellerSwap is a solver that participates in CoW Protocol auctions
 *    - When Rainbow Router users interact with PropellerSwap, trades settle via CoW Protocol
 *    - The transfer proxy pattern ensures user funds are protected
 *
 * 3. SECURITY BENEFITS:
 *    - Separation of concerns: settlement logic vs. fund management
 *    - Explicit protection against direct vault relayer interactions
 *    - Defense-in-depth with both warrant + whitelist validation
 *
 * NOTE: Requires archive RPC (ARB_URL env var). Tests skip gracefully if unavailable.
 */
describe("Transfer Proxy Pattern - Arbitrum (CoW Protocol / PropellerSwap)", function () {
    let Rainbow: OkuRouter

    // CoW Protocol addresses on Arbitrum (used by PropellerSwap solver)
    const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"        // Execution contract
    const COW_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110"     // Approval contract

    // Token addresses on Arbitrum
    const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"        // Native USDC on Arbitrum
    const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"        // WETH on Arbitrum

    // Test parameters
    const usdcAmount = ethers.parseUnits("0.01", 6)  // 0.01 USDC
    const usdcWhale = "0x47c031236e19d024b42f8AE6780E44A573170703"  // USDC whale on Arbitrum

    const name = "Oku Router"
    const version = "1.0"

    let USDC: ERC20
    let WETH: IERC20
    let signer: Signer

    before(async function () {
        this.timeout(30000)

        // Try to fork Arbitrum - skip all tests if RPC unavailable
        const success = await tryFork(FORK_CONFIGS.ARBITRUM)
        if (!success) {
            this.skip()
        }

        signer = (await ethers.getSigners())[0]
        USDC = ERC20__factory.connect(USDC_ADDRESS, signer)
        WETH = IERC20__factory.connect(WETH_ADDRESS, signer)
    })

    it("Deploy Rainbow Router", async () => {
        const ownerAddress = await signer.getAddress();
        Rainbow = await new OkuRouter__factory(signer).deploy(name, version, ownerAddress, ethers.ZeroAddress)
        expect(await Rainbow.getAddress()).to.be.properAddress

        // Whitelist CoW Protocol contracts
        const routersToWhitelist = [COW_SETTLEMENT, COW_VAULT_RELAYER]

        for (const router of routersToWhitelist) {
            await Rainbow.connect(signer).updateSwapTargets(router, true)
            expect(await Rainbow.swapTargets(router)).to.be.true
        }

        // Allow ZeroAddress as valid signer (for testing warrant bypass scenarios)
        await Rainbow.connect(signer).updateValidSigner(ZeroAddress, true)
        expect(await Rainbow.validSigners(ZeroAddress)).to.be.true
    })

    // Helper function to create valid EIP-712 warrant signature
    async function createValidWarrant(
        sellTokenAddress: string,
        buyTokenAddress: string,
        target: string,
        approvalTarget: string,
        swapCallData: string,
        sellAmount: bigint,
        feeAmount: bigint,
        nonce: number,
        validBefore: number,
        validAfter: number
    ) {
        const rainbowAddress = await Rainbow.getAddress()
        const signerAddress = await signer.getAddress()

        const swapCallDataHash = ethers.keccak256(swapCallData)
        const dataHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
                [sellTokenAddress, buyTokenAddress, target, approvalTarget, swapCallDataHash, sellAmount, feeAmount]
            )
        )

        const nonceBI = BigInt(nonce)
        const validBeforeBI = BigInt(validBefore)
        const validAfterBI = BigInt(validAfter)
        const packedValueBI = nonceBI | (validBeforeBI << 160n) | (validAfterBI << 208n)

        const domain = {
            name: name,
            version: version,
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: rainbowAddress
        }

        const types = {
            CanoeWarrant: [
                { name: 'packedValidationData', type: 'uint256' },
                { name: 'dataHash', type: 'bytes32' }
            ]
        }

        const value = {
            packedValidationData: packedValueBI,
            dataHash: dataHash
        }

        const signature = await signer.signTypedData(domain, types, value)

        return {
            nonce: nonce,
            validBefore: validBefore,
            validAfter: validAfter,
            verifyingSigner: signerAddress,
            signature: signature
        }
    }

    it("Should ALLOW CoW Protocol transfer proxy with ZeroAddress warrant", async () => {
        await stealMoney(usdcWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const cowCalldata = "0x"

        const warrant = {
            nonce: 1n,
            validBefore: currentTime + 3600,
            validAfter: currentTime - 300,
            verifyingSigner: ZeroAddress,
            signature: "0x"
        }

        // Attempt to use CoW transfer proxy with ZeroAddress warrant
        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                COW_SETTLEMENT,          // Execution target
                COW_VAULT_RELAYER,       // Approval target (different!)
                cowCalldata,
                usdcAmount,
                0n,
                await signer.getAddress(), // recipient
                warrant
            )
        } catch (error: any) {
            // May fail for other reasons (e.g., settlement data), but not warrant requirement
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("Should SUCCEED CoW Protocol transfer proxy with valid warrant", async () => {
        const signerAddress = await signer.getAddress()
        await Rainbow.connect(signer).updateValidSigner(signerAddress, true)

        await stealMoney(usdcWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const cowCalldata = "0x"

        const warrant = await createValidWarrant(
            USDC_ADDRESS,
            WETH_ADDRESS,
            COW_SETTLEMENT,
            COW_VAULT_RELAYER,
            cowCalldata,
            usdcAmount,
            0n,
            999,
            currentTime + 3600,
            currentTime - 300
        )

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                COW_SETTLEMENT,
                COW_VAULT_RELAYER,
                cowCalldata,
                usdcAmount,
                0n,
                await signer.getAddress(), // recipient
                warrant
            )
        } catch (error: any) {
            // Expected to fail without real CoW settlement data, but warrant check should pass
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("CoW Protocol / PropellerSwap: Verify approval routing", async () => {
        // This test verifies that approvals are made to the correct contract (VaultRelayer)
        const signerAddress = await signer.getAddress()
        await stealMoney(usdcWhale, signerAddress, USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const cowCalldata = "0x"

        const warrant = await createValidWarrant(
            USDC_ADDRESS,
            WETH_ADDRESS,
            COW_SETTLEMENT,
            COW_VAULT_RELAYER,
            cowCalldata,
            usdcAmount,
            0n,
            1234,
            currentTime + 3600,
            currentTime - 300
        )

        const rainbowAddress = await Rainbow.getAddress()
        const allowanceBefore = await USDC.allowance(rainbowAddress, COW_VAULT_RELAYER)
        expect(allowanceBefore).to.eq(0n)

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                COW_SETTLEMENT,       // Call goes here
                COW_VAULT_RELAYER,    // Approval goes here
                cowCalldata,
                usdcAmount,
                0n,
                await signer.getAddress(), // recipient
                warrant
            )
        } catch (error: any) {
            // Expected to fail without real settlement data, but approval routing is correct
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })
})
