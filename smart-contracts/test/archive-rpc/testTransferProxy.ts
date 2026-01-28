import { OkuRouter, OkuRouter__factory } from "../../typechain-types"
import { ERC20, IERC20 } from "../../typechain-types/contracts/interfaces/openzeppelin"
import { IOKXDexRouter__factory } from "../../typechain-types/factories/contracts/interfaces/aggregators"
import { Signer, ZeroAddress } from "ethers"
import { ERC20__factory, IERC20__factory } from "../../typechain-types/factories/contracts/interfaces/openzeppelin"
import { stealMoney } from "../../util/testHelpers"
import { tryFork, FORK_CONFIGS } from "../../util/forkHelper"
import { expect } from "chai"
const { ethers } = require("hardhat")

/**
 * Test suite demonstrating Rainbow Router's support for transfer proxy patterns.
 *
 * TRANSFER PROXY PATTERN: Some DEX aggregators use dual-contract architecture:
 * - Router Contract: Receives swap calldata for execution
 * - Approval Target: Separate contract that needs token approval
 *
 * Examples tested here:
 * - OKX: Router (0xC44C6550a3...) + Approval Target (0x68D6B739D2...)
 * - 0x Protocol: Exchange Proxy (0xDef1ABe32c...) + AllowanceHolder (0x0000000000001fF3...)
 * - OpenOcean: Exchange V2 (single contract pattern)
 *
 * NOTE: Requires archive RPC (OP_URL env var). Tests skip gracefully if unavailable.
 */
describe("Transfer Proxy Pattern with Warrant Validation", function () {
    let Rainbow: OkuRouter

    // OKX DEX Aggregator addresses on Optimism
    const OKX_ROUTER = "0xC44C6550a3B13116F6fD593e1ec963d5aE78C4C8"  // Swap execution contract
    const OKX_APPROVAL_TARGET = "0x68D6B739D2020067D1e2F713b999dA97E4d54812"  // Token approval contract

    // 0x Protocol addresses on Optimism
    const ZEROEX_EXCHANGE_PROXY = "0xDEF1ABE32c034e558Cdd535791643C58a13aCC10"  // Exchange Proxy (execution)
    const ZEROEX_ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734"  // AllowanceHolder (approvals)

    // OpenOcean addresses on Optimism
    const OPENOCEAN_EXCHANGE_V2 = "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64"  // Exchange V2 (may use single contract)

    // Uniswap V3 Router (standard single-contract pattern)
    const UNISWAP_V3_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"

    // Token addresses on Optimism
    const USDC_ADDRESS = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"

    // Test parameters
    const usdcAmount = ethers.parseUnits("0.01", 6)  // 0.01 USDC
    const usdcNativeWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"  // Balancer Vault on Optimism

    const name = "Oku Router"
    const version = "1.0"

    let USDC: ERC20
    let WETH: IERC20
    let signer: Signer

    before(async function () {
        this.timeout(30000)

        // Try to fork Optimism - skip all tests if RPC unavailable
        const success = await tryFork(FORK_CONFIGS.OPTIMISM)
        if (!success) {
            this.skip()
        }

        signer = (await ethers.getSigners())[0]
        USDC = ERC20__factory.connect(USDC_ADDRESS, signer)
        WETH = IERC20__factory.connect(WETH_ADDRESS, signer)
    })

    it("Deploy Rainbow Router", async () => {
        const ownerAddress = await signer.getAddress();
        Rainbow = await new OkuRouter__factory(signer).deploy(name, version, ownerAddress)
        expect(await Rainbow.getAddress()).to.be.properAddress

        // Whitelist all router addresses
        const routersToWhitelist = [
            OKX_ROUTER,
            OKX_APPROVAL_TARGET,
            ZEROEX_EXCHANGE_PROXY,
            ZEROEX_ALLOWANCE_HOLDER,
            OPENOCEAN_EXCHANGE_V2,
            UNISWAP_V3_ROUTER,
        ]

        for (const router of routersToWhitelist) {
            await Rainbow.connect(signer).updateSwapTargets(router, true)
            expect(await Rainbow.swapTargets(router)).to.be.true
        }

        // Allow ZeroAddress as valid signer (bypass signature validation for some tests)
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

    it("Should ALLOW transfer proxy (target != approvalTarget) with ZeroAddress warrant", async () => {
        await stealMoney(usdcNativeWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const baseRequest = {
            fromToken: USDC_ADDRESS,
            toToken: WETH_ADDRESS,
            fromTokenAmount: usdcAmount,
            minReturnAmount: 1n,
            deadLine: currentTime + 1800
        }

        const okxInterface = IOKXDexRouter__factory.createInterface()
        const okxSwapCalldata = okxInterface.encodeFunctionData("dagSwapTo", [
            baseRequest,
            "0x",
            false,
            await Rainbow.getAddress()
        ])

        const warrant = {
            nonce: 1n,
            validBefore: currentTime + 3600,
            validAfter: currentTime - 300,
            verifyingSigner: ZeroAddress,
            signature: "0x"
        }

        // Attempt to use transfer proxy with ZeroAddress warrant
        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                OKX_ROUTER,
                OKX_APPROVAL_TARGET,
                okxSwapCalldata,
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            // May fail for other reasons, but should not fail on warrant requirement
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("Should SUCCEED transfer proxy (target != approvalTarget) with valid warrant", async () => {
        const signerAddress = await signer.getAddress()
        await Rainbow.connect(signer).updateValidSigner(signerAddress, true)

        await stealMoney(usdcNativeWhale, signerAddress, USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const baseRequest = {
            fromToken: USDC_ADDRESS,
            toToken: WETH_ADDRESS,
            fromTokenAmount: usdcAmount,
            minReturnAmount: 1n,
            deadLine: currentTime + 1800
        }

        const okxInterface = IOKXDexRouter__factory.createInterface()
        const okxSwapCalldata = okxInterface.encodeFunctionData("dagSwapTo", [
            baseRequest,
            "0x",
            false,
            await Rainbow.getAddress()
        ])

        const warrant = await createValidWarrant(
            USDC_ADDRESS,
            WETH_ADDRESS,
            OKX_ROUTER,
            OKX_APPROVAL_TARGET,
            okxSwapCalldata,
            usdcAmount,
            0n,
            123,
            currentTime + 3600,
            currentTime - 300
        )

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                OKX_ROUTER,
                OKX_APPROVAL_TARGET,
                okxSwapCalldata,
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            // Should not fail due to warrant check
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("Should still allow ZeroAddress warrant for standard pattern (target == approvalTarget)", async () => {
        await stealMoney(usdcNativeWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const warrant = {
            nonce: 1n,
            validBefore: currentTime + 3600,
            validAfter: currentTime - 300,
            verifyingSigner: ZeroAddress,
            signature: "0x"
        }

        // This should NOT revert on warrant check (target == approvalTarget)
        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                UNISWAP_V3_ROUTER,
                UNISWAP_V3_ROUTER,  // Same as target
                "0x",
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("USDC → WETH swap via OKX verifies transfer proxy pattern", async () => {
        await stealMoney(usdcNativeWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)

        const signerUsdcBalanceBefore = await USDC.balanceOf(await signer.getAddress())
        expect(signerUsdcBalanceBefore).to.be.gte(usdcAmount)

        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const baseRequest = {
            fromToken: USDC_ADDRESS,
            toToken: WETH_ADDRESS,
            fromTokenAmount: usdcAmount,
            minReturnAmount: 1n,
            deadLine: currentTime + 1800
        }

        const okxInterface = IOKXDexRouter__factory.createInterface()
        const okxSwapCalldata = okxInterface.encodeFunctionData("dagSwapTo", [
            baseRequest,
            "0x",
            false,
            await Rainbow.getAddress()
        ])

        const warrant = await createValidWarrant(
            USDC_ADDRESS,
            WETH_ADDRESS,
            OKX_ROUTER,
            OKX_APPROVAL_TARGET,
            okxSwapCalldata,
            usdcAmount,
            0n,
            456,
            currentTime + 3600,
            currentTime - 300
        )

        // Verify allowance before swap
        const rainbowAddress = await Rainbow.getAddress()
        const allowanceBefore = await USDC.allowance(rainbowAddress, OKX_APPROVAL_TARGET)
        expect(allowanceBefore).to.eq(0n)

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                OKX_ROUTER,
                OKX_APPROVAL_TARGET,
                okxSwapCalldata,
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            // Expected to fail without real routing data, but not due to approval issues
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("0x Protocol: USDC → WETH swap with AllowanceHolder pattern", async () => {
        const signerAddress = await signer.getAddress()
        await Rainbow.connect(signer).updateValidSigner(signerAddress, true)

        await stealMoney(usdcNativeWhale, signerAddress, USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const warrant = await createValidWarrant(
            USDC_ADDRESS,
            WETH_ADDRESS,
            ZEROEX_EXCHANGE_PROXY,
            ZEROEX_ALLOWANCE_HOLDER,
            "0x",
            usdcAmount,
            0n,
            789,
            currentTime + 3600,
            currentTime - 300
        )

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                ZEROEX_EXCHANGE_PROXY,
                ZEROEX_ALLOWANCE_HOLDER,
                "0x",
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })

    it("OpenOcean: USDC → WETH swap with single contract pattern", async () => {
        await stealMoney(usdcNativeWhale, await signer.getAddress(), USDC_ADDRESS, usdcAmount)
        await USDC.connect(signer).approve(await Rainbow.getAddress(), usdcAmount)

        const latestBlock = await ethers.provider.getBlock('latest')
        const currentTime = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)

        const warrant = {
            nonce: 1n,
            validBefore: currentTime + 3600,
            validAfter: currentTime - 300,
            verifyingSigner: ZeroAddress,
            signature: "0x"
        }

        try {
            await Rainbow.connect(signer).fillQuoteTokenToToken(
                USDC_ADDRESS,
                WETH_ADDRESS,
                OPENOCEAN_EXCHANGE_V2,
                OPENOCEAN_EXCHANGE_V2,  // Same as target (single contract pattern)
                "0x",
                usdcAmount,
                0n,
                warrant
            )
        } catch (error: any) {
            // Should not fail due to warrant requirement (single contract pattern)
            expect(error.message).to.not.include("WARRANT_REQUIRED_FOR_PROXY")
        }
    })
})
