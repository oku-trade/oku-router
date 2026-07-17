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

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const PERMIT2_DOMAIN = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
};

const PERMIT2_TYPES = {
    PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
    ],
};

async function signPermit2(
    signer: Signer,
    proxyAddress: string,
    token: string,
    amount: bigint,
    chainId: bigint
) {
    const latestBlock = await ethers.provider.getBlock("latest");
    const blockTimestamp = latestBlock
        ? Number(latestBlock.timestamp)
        : Math.floor(Date.now() / 1000);
    const deadline = blockTimestamp + 3600; // 1 hour from now
    const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

    const domain = {
        ...PERMIT2_DOMAIN,
        chainId,
    };

    const value = {
        permitted: {
            token,
            amount,
        },
        spender: proxyAddress,
        nonce,
        deadline,
    };

    const signature = await signer.signTypedData(domain, PERMIT2_TYPES, value);

    const permit = {
        permitted: { token, amount },
        nonce,
        deadline,
    };

    return { permit, signature };
}

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
    let chainId: bigint;

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

        chainId = (await ethers.provider.getNetwork()).chainId;

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
        it("Should swap USDC -> WETH through the proxy with Permit2 signature", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6); // 10 USDC

            // 1. Fund user with USDC
            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);

            // 2. User approves Permit2 to spend USDC
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // 3. Sign Permit2 typed data
            const { permit, signature } = await signPermit2(
                user,
                proxyAddress,
                OPTIMISM_TOKENS.USDC,
                sellAmount,
                chainId
            );

            // 4. Build OkuRouter calldata
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount,
                rainbowAddress
            );
            const routerCalldata = Rainbow.interface.encodeFunctionData(
                "fillQuoteTokenToToken",
                [
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    0n,
                    ZeroAddress,
                    zeroWarrant,
                ]
            );

            const wethBefore = await WETH.balanceOf(userAddress);

            // 5. Call proxy.execute
            await proxy
                .connect(user)
                .execute(permit, signature, OPTIMISM_TOKENS.WETH, routerCalldata);

            const wethAfter = await WETH.balanceOf(userAddress);
            expect(wethAfter).to.be.gt(wethBefore);

            // Proxy should have zero balances
            expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);
            expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
        });

        it("Should swap USDC -> WETH with fee", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("100", 6); // 100 USDC
            const feeAmount = ethers.parseUnits("1", 6); // 1 USDC fee

            // 1. Fund user with USDC
            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);

            // 2. User approves Permit2
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // 3. Sign Permit2 typed data
            const { permit, signature } = await signPermit2(
                user,
                proxyAddress,
                OPTIMISM_TOKENS.USDC,
                sellAmount,
                chainId
            );

            // 4. Build OkuRouter calldata (swap amount is sellAmount - feeAmount)
            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount - feeAmount,
                rainbowAddress
            );
            const routerCalldata = Rainbow.interface.encodeFunctionData(
                "fillQuoteTokenToToken",
                [
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    feeAmount,
                    ZeroAddress,
                    zeroWarrant,
                ]
            );

            const wethBefore = await WETH.balanceOf(userAddress);

            // 5. Call proxy.execute
            await proxy
                .connect(user)
                .execute(permit, signature, OPTIMISM_TOKENS.WETH, routerCalldata);

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
        it("Should revert with expired Permit2 deadline", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // Create permit with expired deadline
            const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
            const expiredDeadline = 1; // Unix timestamp 1 = long expired

            const domain = {
                ...PERMIT2_DOMAIN,
                chainId,
            };

            const value = {
                permitted: { token: OPTIMISM_TOKENS.USDC, amount: sellAmount },
                spender: proxyAddress,
                nonce,
                deadline: expiredDeadline,
            };

            const signature = await user.signTypedData(domain, PERMIT2_TYPES, value);
            const permit = {
                permitted: { token: OPTIMISM_TOKENS.USDC, amount: sellAmount },
                nonce,
                deadline: expiredDeadline,
            };

            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount,
                rainbowAddress
            );
            const routerCalldata = Rainbow.interface.encodeFunctionData(
                "fillQuoteTokenToToken",
                [
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    0n,
                    ZeroAddress,
                    zeroWarrant,
                ]
            );

            await expect(
                proxy.connect(user).execute(permit, signature, OPTIMISM_TOKENS.WETH, routerCalldata)
            ).to.be.reverted;
        });

        it("Should revert with wrong signer", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // Sign with owner but call as user (Permit2 checks owner == msg.sender)
            const { permit, signature } = await signPermit2(
                owner, // wrong signer
                proxyAddress,
                OPTIMISM_TOKENS.USDC,
                sellAmount,
                chainId
            );

            const swapCallData = await createDummySwapCalldata(
                OPTIMISM_TOKENS.USDC,
                OPTIMISM_TOKENS.WETH,
                sellAmount,
                rainbowAddress
            );
            const routerCalldata = Rainbow.interface.encodeFunctionData(
                "fillQuoteTokenToToken",
                [
                    OPTIMISM_TOKENS.USDC,
                    OPTIMISM_TOKENS.WETH,
                    UNISWAP_V3_ROUTER,
                    UNISWAP_V3_ROUTER,
                    swapCallData,
                    sellAmount,
                    0n,
                    ZeroAddress,
                    zeroWarrant,
                ]
            );

            await expect(
                proxy.connect(user).execute(permit, signature, OPTIMISM_TOKENS.WETH, routerCalldata)
            ).to.be.reverted;
        });

        it("Should revert with bad swap calldata (OkuRouter reverts, bubbles up)", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            const { permit, signature } = await signPermit2(
                user,
                proxyAddress,
                OPTIMISM_TOKENS.USDC,
                sellAmount,
                chainId
            );

            // Bad calldata — not a valid OkuRouter function
            const badCalldata = "0xdeadbeef";

            await expect(
                proxy.connect(user).execute(permit, signature, OPTIMISM_TOKENS.WETH, badCalldata)
            ).to.be.reverted;
        });

        it("Should revert constructor with zero address", async function () {
            await expect(
                new Permit2Proxy__factory(owner).deploy(ZeroAddress)
            ).to.be.revertedWith("ZERO_ROUTER");
        });
    });

    describe("Immutables", () => {
        it("Should return the correct okuRouter address", async function () {
            expect(await proxy.okuRouter()).to.equal(rainbowAddress);
        });

        it("Should return the correct permit2 address", async function () {
            expect(await proxy.permit2()).to.equal(PERMIT2_ADDRESS);
        });
    });
});
