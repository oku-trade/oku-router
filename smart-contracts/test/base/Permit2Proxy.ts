import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroAddress, type Signer } from "ethers";
import type { OkuRouter, Permit2Proxy } from "../../typechain-types";
import {
    OkuRouter__factory,
    Permit2Proxy__factory,
    IERC20Metadata__factory,
} from "../../typechain-types";
import { stealMoney } from "../../util/testHelpers";
import { tryFork, FORK_CONFIGS } from "../../util/forkHelper";
import {
    createDummySwapCalldata,
    OPTIMISM_TOKENS,
    UNISWAP_V3_ROUTER,
} from "../helpers/dummyQuotes";

describe("Permit2Proxy", function () {
    const name = "Rainbow Router";
    const version = "1.0";
    const usdcWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    let Rainbow: OkuRouter;
    let proxy: Permit2Proxy;
    let owner: Signer;
    let user: Signer;
    let USDC: any;
    let WETH: any;
    let rainbowAddress: string;
    let proxyAddress: string;

    before(async function () {
        this.timeout(30000);

        // Fork Optimism — skip if archive RPC unavailable
        const success = await tryFork(FORK_CONFIGS.OPTIMISM);
        if (!success) {
            this.skip();
        }

        const signers = await ethers.getSigners();
        owner = signers[0];
        user = signers[1];

        const ownerAddress = await owner.getAddress();

        // Deploy OkuRouter
        Rainbow = await new OkuRouter__factory(owner).deploy(name, version, ownerAddress);
        await Rainbow.waitForDeployment();
        rainbowAddress = await Rainbow.getAddress();

        // Register swap target and valid signer
        await Rainbow.connect(owner).updateSwapTargets(UNISWAP_V3_ROUTER, true);
        await Rainbow.connect(owner).updateValidSigner(ZeroAddress, true);

        // Deploy Permit2Proxy
        proxy = await new Permit2Proxy__factory(owner).deploy(rainbowAddress);
        await proxy.waitForDeployment();
        proxyAddress = await proxy.getAddress();

        USDC = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.USDC, owner);
        WETH = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.WETH, owner);
    });

    // Zero-address warrant (bypass mode)
    const zeroWarrant = {
        nonce: 0n,
        validBefore: 0,
        validAfter: 0,
        verifyingSigner: ZeroAddress,
        signature: "0x",
    };

    describe("Token-to-Token swap", () => {
        it("Should swap USDC -> WETH through the proxy", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6); // 10 USDC

            // Simulate Permit2 delivery: send tokens to proxy
            await stealMoney(usdcWhale, proxyAddress, OPTIMISM_TOKENS.USDC, sellAmount);

            // Generate swap calldata with OkuRouter as recipient
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount, // no fee, so full amount to swap
                rainbowAddress
            );

            const wethBefore = await WETH.balanceOf(userAddress);

            // User calls proxy
            await proxy.connect(user).fillQuoteTokenToToken(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                UNISWAP_V3_ROUTER,
                UNISWAP_V3_ROUTER,
                swapCallData,
                sellAmount,
                0n,
                zeroWarrant
            );

            const wethAfter = await WETH.balanceOf(userAddress);
            expect(wethAfter).to.be.gt(wethBefore);

            // Proxy should have zero WETH remaining
            const proxyWeth = await WETH.balanceOf(proxyAddress);
            expect(proxyWeth).to.equal(0n);

            // Proxy should have zero USDC remaining
            const proxyUsdc = await USDC.balanceOf(proxyAddress);
            expect(proxyUsdc).to.equal(0n);
        });

        it("Should swap USDC -> WETH with fee", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("100", 6); // 100 USDC
            const feeAmount = ethers.parseUnits("1", 6); // 1 USDC fee

            await stealMoney(usdcWhale, proxyAddress, OPTIMISM_TOKENS.USDC, sellAmount);

            // Swap calldata should only swap (sellAmount - feeAmount)
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount - feeAmount,
                rainbowAddress
            );

            const wethBefore = await WETH.balanceOf(userAddress);

            await proxy.connect(user).fillQuoteTokenToToken(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                UNISWAP_V3_ROUTER,
                UNISWAP_V3_ROUTER,
                swapCallData,
                sellAmount,
                feeAmount,
                zeroWarrant
            );

            const wethAfter = await WETH.balanceOf(userAddress);
            expect(wethAfter).to.be.gt(wethBefore);

            // Fee tokens should be in OkuRouter (not proxy)
            const routerUsdc = await USDC.balanceOf(rainbowAddress);
            expect(routerUsdc).to.equal(feeAmount);

            // Proxy should be clean
            expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
            expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);
        });
    });

    describe("Revert cases", () => {
        it("Should revert with INSUFFICIENT_TOKENS when proxy has no tokens", async function () {
            const sellAmount = ethers.parseUnits("10", 6);
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount,
                rainbowAddress
            );

            await expect(
                proxy.connect(user).fillQuoteTokenToToken(
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    0n,
                    zeroWarrant
                )
            ).to.be.revertedWith("INSUFFICIENT_TOKENS");
        });

        it("Should revert with bad swap calldata", async function () {
            const sellAmount = ethers.parseUnits("10", 6);
            await stealMoney(usdcWhale, proxyAddress, OPTIMISM_TOKENS.USDC, sellAmount);

            // Invalid calldata
            const badCalldata = "0xdeadbeef";

            await expect(
                proxy.connect(user).fillQuoteTokenToToken(
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    badCalldata,
                    sellAmount,
                    0n,
                    zeroWarrant
                )
            ).to.be.reverted;
        });

        it("Should revert constructor with zero address", async function () {
            await expect(
                new Permit2Proxy__factory(owner).deploy(ZeroAddress)
            ).to.be.revertedWith("ZERO_ROUTER");
        });

        it("Should revert fillQuoteTokenToEth with INSUFFICIENT_TOKENS when proxy has no tokens", async function () {
            // Use a large amount that the proxy definitely doesn't have
            const sellAmount = ethers.parseUnits("1000000", 6);
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount,
                rainbowAddress
            );

            await expect(
                proxy.connect(user).fillQuoteTokenToEth(
                    OPTIMISM_TOKENS.USDC,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    0n,
                    zeroWarrant
                )
            ).to.be.revertedWith("INSUFFICIENT_TOKENS");
        });
    });

    describe("Immutables", () => {
        it("Should return the correct okuRouter address", async function () {
            expect(await proxy.okuRouter()).to.equal(rainbowAddress);
        });
    });
});
