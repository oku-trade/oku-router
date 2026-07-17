import { OkuRouter, OkuRouter__factory } from "../../typechain-types"
import { ERC20, IERC20 } from "../../typechain-types/contracts/interfaces/openzeppelin"
import { Interface, Signer, ZeroAddress } from "ethers"
import { ERC20__factory, IERC20__factory } from "../../typechain-types/factories/contracts/interfaces/openzeppelin"
import { generatePermitSignature } from "../../util/canoeHelper"
import { generateUniTxData, stealMoney } from "../../util/testHelpers"
import { tryFork, FORK_CONFIGS } from "../../util/forkHelper"
import { expect } from "chai"
const { ethers } = require("hardhat")

/**
 * Permit Signature Tests
 * NOTE: Requires archive RPC (OP_URL env var). Tests skip gracefully if unavailable.
 */
describe("Permit Signature", function () {
    let Rainbow: OkuRouter
    const routerAddr = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    const universalRouter = "0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8" // Example address, adjust if needed
    const ownerAddr = "0x085909388fc0cE9E5761ac8608aF8f2F52cb8B89"
    const wethAmount = ethers.parseEther("0.0001")
    const usdcAmount = ethers.parseUnits("0.01", 6)
    const usdcNativeWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" // Balancer Vault on Optimism

    const name = "Oku Router" // EIP-712 Domain Name
    const version = "1.0" // EIP-712 Domain Version

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

        const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" // Optimism USDC
        USDC = ERC20__factory.connect(usdcAddress, signer)
        WETH = IERC20__factory.connect("0x4200000000000000000000000000000000000006", signer) // Optimism WETH
    })

    it("Deploy", async () => {
        const ownerAddress = await signer.getAddress();
        Rainbow = await new OkuRouter__factory(signer).deploy(name, version, ownerAddress)

        let tx = await Rainbow.connect(signer).updateSwapTargets(routerAddr, true)
        await tx.wait()
        tx = await Rainbow.connect(signer).updateSwapTargets(universalRouter, true)
        await tx.wait()
        tx = await Rainbow.connect(signer).updateSwapTargets("0xE592427A0AEce92De3Edee1F18E0157C05861564", true) // Uniswap V3 Router
        await tx.wait()

        tx = await Rainbow.connect(signer).updateValidSigner(await signer.getAddress(), true)
        await tx.wait()
        tx = await Rainbow.connect(signer).updateValidSigner(ZeroAddress, true) // Allow warrants with ZeroAddress signer (no signature needed)
        await tx.wait()
    })

    it("Do Token => Token", async () => {
        const txData = await generateUniTxData(
            await USDC.getAddress(),
            await WETH.getAddress(),
            usdcAmount,
            routerAddr,
            500,
            await Rainbow.getAddress(),
            0n
        )

        const millisecondsSinceEpoch: number = Date.now()
        const time: number = Math.floor(millisecondsSinceEpoch / 1000)

        const warrant = {
            nonce: await signer.getNonce(), // Example nonce, manage appropriately
            validBefore: time + 5000,
            validAfter: time - 5000,
            verifyingSigner: ZeroAddress, // Using ZeroAddress means warrant check passes without signature validation
            signature: "0x"
        }

        const network = await ethers.provider.getNetwork()
        const permitData = await generatePermitSignature(
            signer,
            network.chainId,
            await USDC.getAddress(),
            usdcAmount,
            await Rainbow.getAddress()
        )

        await stealMoney(usdcNativeWhale, await signer.getAddress(), await USDC.getAddress(), usdcAmount)

        let tx = await Rainbow.connect(signer).fillQuoteTokenToTokenWithPermit(
            await USDC.getAddress(),
            await WETH.getAddress(),
            routerAddr,
            routerAddr, // approvalTarget - same as target
            txData,
            usdcAmount,
            0n,
            ZeroAddress,
            permitData,
            warrant
        )
        await tx.wait()
    })

    it("Test swapRouter", async () => {
        await stealMoney(usdcNativeWhale, await signer.getAddress(), await USDC.getAddress(), usdcAmount)
        expect(await USDC.balanceOf(await signer.getAddress())).to.eq(usdcAmount, "Insufficient balance")

        const swapRouter = new ethers.Contract(
            "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 SwapRouter address
            [
                `function exactInputSingle(
                    tuple(
                        address tokenIn, address tokenOut, uint24 fee, address recipient,
                        uint256 deadline, uint256 amountIn, uint256 amountOutMinimum,
                        uint160 sqrtPriceLimitX96
                    ) params
                ) external payable returns (uint256)`
            ],
            signer
        )

        await USDC.connect(signer).approve("0xE592427A0AEce92De3Edee1F18E0157C05861564", usdcAmount)
        const allowance = await USDC.allowance(await signer.getAddress(), "0xE592427A0AEce92De3Edee1F18E0157C05861564")

        const params = {
            tokenIn: await USDC.getAddress(),
            tokenOut: await WETH.getAddress(),
            fee: 500,
            recipient: await signer.getAddress(),
            deadline: Math.floor(Date.now() / 1000) + 1800,
            amountIn: usdcAmount,
            amountOutMinimum: 1, // Minimal expectation for test
            sqrtPriceLimitX96: 0
        }

        // Static call to simulate the swap without sending a transaction
        const result = await swapRouter.getFunction("exactInputSingle").staticCall(params)
    })

    it("Native Ether to Token", async () => {
        const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
        const wethAddress = "0x4200000000000000000000000000000000000006"
        const uniswapV3RouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
        const wethUsdcPoolFee = 500

        const uniswapV3RouterABI = [
            "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"
        ]
        const uniswapRouterInterface = new Interface(uniswapV3RouterABI)

        const [signer] = await ethers.getSigners()
        const USDC = ERC20__factory.connect(usdcAddress, signer)

        const wethAmountToSend = ethers.parseEther("0.0001")
        // Minimum output should be calculated based on expected price and slippage tolerance
        const usdcAmountOutMinimum = 0n // Using 0 for simplicity in test, CALCULATE FOR PRODUCTION

        const buyTokenAddress = await USDC.getAddress()
        const targetAddress = uniswapV3RouterAddress
        const deadline = Math.floor(Date.now() / 1000) + 60 * 10

        const exactInputSingleParams = {
            tokenIn: wethAddress,
            tokenOut: usdcAddress,
            fee: wethUsdcPoolFee,
            recipient: await Rainbow.getAddress(), // Swap output goes to Rainbow contract
            deadline: BigInt(deadline),
            amountIn: wethAmountToSend,
            amountOutMinimum: usdcAmountOutMinimum,
            sqrtPriceLimitX96: 0n
        }

        const swapCallData = uniswapRouterInterface.encodeFunctionData("exactInputSingle", [exactInputSingleParams])
        const feeAmount = 0n
        const millisecondsSinceEpoch: number = Date.now()
        const time: number = Math.floor(millisecondsSinceEpoch / 1000)
        const warrantNonce = Date.now()

        const warrant = {
            nonce: warrantNonce,
            validBefore: BigInt(time + 5000),
            validAfter: BigInt(time - 5000),
            verifyingSigner: ZeroAddress, // Using ZeroAddress bypasses signature check
            signature: "0x"
        }

        const tx = await Rainbow.fillQuoteEthToToken(
            buyTokenAddress,
            targetAddress,
            swapCallData,
            feeAmount,
            ZeroAddress,
            warrant,
            {
                value: wethAmountToSend // Send ETH with the call
            }
        )
        const receipt = await tx.wait()

        const signerEthBalanceAfter = await ethers.provider.getBalance(signer.address)
        const rainbowUsdcBalanceAfter = await USDC.balanceOf(await Rainbow.getAddress()) // Check Rainbow contract balance
    })

    it("Test warrant validation using EIP-712", async () => {
        const feeAmount = 0n
        const sellTokenAddress = await USDC.getAddress()
        const buyTokenAddress = await WETH.getAddress()
        const rainbowAddress = await Rainbow.getAddress()

        const swapCallData = await generateUniTxData(
            sellTokenAddress, buyTokenAddress, usdcAmount, routerAddr,
            500, rainbowAddress, 0n
        )

        // Use block timestamp instead of Date.now() since we're on a pinned fork
        const latestBlock = await ethers.provider.getBlock('latest')
        const time: number = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)
        const validBefore: number = time + 3600
        const validAfter: number = time - 300
        const nonce: bigint = 1n
        const verifyingSignerAddress: string = await signer.getAddress()

        const swapCallDataHash = ethers.keccak256(swapCallData)

        const dataHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
                [sellTokenAddress, buyTokenAddress, routerAddr, routerAddr, swapCallDataHash, usdcAmount, feeAmount]
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

        // Using signTypedData (adjust _signTypedData for ethers v5 if needed)
        const signature = await signer.signTypedData(domain, types, value)

        const warrant = {
            nonce: nonce,
            validBefore: validBefore,
            validAfter: validAfter,
            verifyingSigner: verifyingSignerAddress,
            signature: signature
        }

        const network = await ethers.provider.getNetwork()
        const permitData = await generatePermitSignature(
            signer, network.chainId, sellTokenAddress, usdcAmount, rainbowAddress
        )

        await stealMoney(usdcNativeWhale, await signer.getAddress(), sellTokenAddress, usdcAmount)

        const signerUsdcBalanceBefore = await USDC.balanceOf(await signer.getAddress())
        // Check recipient balance based on swapCallData recipient (rainbowAddress)
        const recipientWethBalanceBefore = await WETH.balanceOf(rainbowAddress)

        let tx = await Rainbow.connect(signer).fillQuoteTokenToTokenWithPermit(
            sellTokenAddress,
            buyTokenAddress,
            routerAddr,
            routerAddr, // approvalTarget - same as target
            swapCallData,
            usdcAmount,
            feeAmount,
            ZeroAddress,
            permitData,
            warrant
        )
        const receipt = await tx.wait()

        const signerUsdcBalanceAfter = await USDC.balanceOf(await signer.getAddress())
        const recipientWethBalanceAfter = await WETH.balanceOf(await signer.getAddress())

        expect(signerUsdcBalanceAfter).to.equal(signerUsdcBalanceBefore - usdcAmount, "Signer USDC balance did not decrease correctly")
        expect(recipientWethBalanceAfter).to.be.gt(recipientWethBalanceBefore, "Recipient WETH balance did not increase")
    })

    it("Test Permit2 signature transfer (requires Permit2 deployed at 0x000000000022D473030F116dDEE9F6B43aC78BA3)", async () => {
        const feeAmount = 0n
        const sellTokenAddress = await USDC.getAddress()
        const buyTokenAddress = await WETH.getAddress()
        const rainbowAddress = await Rainbow.getAddress()
        const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

        const swapCallData = await generateUniTxData(
            sellTokenAddress, buyTokenAddress, usdcAmount, routerAddr,
            500, rainbowAddress, 0n
        )

        // Use block timestamp instead of Date.now() since we're on a pinned fork
        const latestBlock = await ethers.provider.getBlock('latest')
        const time: number = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000)
        const validBefore: number = time + 3600
        const validAfter: number = time - 300
        const nonce: bigint = 2n
        const verifyingSignerAddress: string = await signer.getAddress()

        const swapCallDataHash = ethers.keccak256(swapCallData)

        const dataHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
                [sellTokenAddress, buyTokenAddress, routerAddr, routerAddr, swapCallDataHash, usdcAmount, feeAmount]
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

        const warrant = {
            nonce: nonce,
            validBefore: validBefore,
            validAfter: validAfter,
            verifyingSigner: verifyingSignerAddress,
            signature: signature
        }

        const network = await ethers.provider.getNetwork()
        // Generate Permit2 signature (permitStyle = 2)
        const permitData = await generatePermitSignature(
            signer, network.chainId, sellTokenAddress, usdcAmount, rainbowAddress, 2
        )

        await stealMoney(usdcNativeWhale, await signer.getAddress(), sellTokenAddress, usdcAmount)

        // CRITICAL: Approve Permit2 to spend USDC (prerequisite for permitTransferFrom)
        await USDC.connect(signer).approve(PERMIT2_ADDRESS, ethers.MaxUint256)

        const signerUsdcBalanceBefore = await USDC.balanceOf(await signer.getAddress())
        const recipientWethBalanceBefore = await WETH.balanceOf(rainbowAddress)

        let tx = await Rainbow.connect(signer).fillQuoteTokenToTokenWithPermit(
            sellTokenAddress,
            buyTokenAddress,
            routerAddr,
            routerAddr, // approvalTarget - same as target
            swapCallData,
            usdcAmount,
            feeAmount,
            ZeroAddress,
            permitData,
            warrant
        )
        const receipt = await tx.wait()

        const signerUsdcBalanceAfter = await USDC.balanceOf(await signer.getAddress())
        const recipientWethBalanceAfter = await WETH.balanceOf(await signer.getAddress())

        expect(signerUsdcBalanceAfter).to.equal(signerUsdcBalanceBefore - usdcAmount, "Signer USDC balance did not decrease correctly")
        expect(recipientWethBalanceAfter).to.be.gt(recipientWethBalanceBefore, "Recipient WETH balance did not increase")
    })
})