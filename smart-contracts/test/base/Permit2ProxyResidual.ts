/**
 * Regression tests for the Permit2Proxy residual-theft finding (Mid-01,
 * Chain Defenders audit, July 2026).
 *
 * `_forwardAndReturn` pulls `sellAmount` from msg.sender and approves
 * OkuRouter for that amount, but OkuRouter independently pulls whatever
 * sell amount is encoded in `routerCalldata`. If a caller pulls more than
 * the router calldata actually sells (slippage padding, conservative
 * frontend pulls, quote drift, etc.), the difference used to stay parked
 * in the proxy as both a token balance and a leftover proxy->router
 * ERC20 allowance — which a later caller could fold into their own swap
 * to steal the residual (see the audit PoC for the full attack).
 *
 * These tests exercise the real fork (real Uniswap V3, which only pulls
 * exactly what `routerCalldata` tells it to) to reproduce the "pulled >
 * sold" condition, and assert that `_forwardAndReturn` now:
 *   1. Refunds any residual sellToken balance to msg.sender in the same
 *      call, and
 *   2. Zeroes the leftover proxy->router allowance,
 * so nothing is left behind for a later caller to steal.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroAddress, type Signer } from "ethers";
import type { OkuRouter, Permit2Proxy, IERC20Metadata } from "../../typechain-types";
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

const PERMIT2_ABI = [
    "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
    "function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

describe("Permit2Proxy residual theft (Mid-01 regression)", function () {
    const name = "Oku Router";
    const version = "1.1";
    const usdcWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    let Rainbow: OkuRouter;
    let proxy: Permit2Proxy;
    let owner: Signer;
    let victim: Signer;
    let attacker: Signer;
    let USDC: IERC20Metadata;
    let WETH: IERC20Metadata;
    let permit2: any;
    let rainbowAddress: string;
    let proxyAddress: string;

    before(async function () {
        this.timeout(30000);

        const success = await tryFork(FORK_CONFIGS.OPTIMISM);
        if (!success) {
            this.skip();
        }

        const signers = await ethers.getSigners();
        owner = signers[0];
        victim = signers[1];
        attacker = signers[2];

        const ownerAddress = await owner.getAddress();

        Rainbow = await new OkuRouter__factory(owner).deploy(name, version, ownerAddress, ZeroAddress);
        await Rainbow.waitForDeployment();
        rainbowAddress = await Rainbow.getAddress();

        await Rainbow.connect(owner).updateSwapTargets(UNISWAP_V3_ROUTER, true);
        await Rainbow.connect(owner).updateValidSigner(ZeroAddress, true);

        proxy = await new Permit2Proxy__factory(owner).deploy(rainbowAddress);
        await proxy.waitForDeployment();
        proxyAddress = await proxy.getAddress();

        USDC = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.USDC, owner);
        WETH = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.WETH, owner);
        permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, owner);
    });

    const zeroWarrant = {
        nonce: 0n,
        validBefore: 0,
        validAfter: 0,
        verifyingSigner: ZeroAddress,
        signature: "0x",
    };

    /**
     * Build OkuRouter calldata that sells exactly `calldataSellAmount` of
     * USDC (independent of whatever amount the proxy actually pulled from
     * the caller via Permit2).
     */
    async function buildSwapCalldata(calldataSellAmount: bigint) {
        const swapCallData = await createDummySwapCalldata(
            OPTIMISM_TOKENS.USDC,
            OPTIMISM_TOKENS.WETH,
            calldataSellAmount,
            rainbowAddress,
        );
        return Rainbow.interface.encodeFunctionData("fillQuoteTokenToToken", [
            OPTIMISM_TOKENS.USDC,
            OPTIMISM_TOKENS.WETH,
            UNISWAP_V3_ROUTER,
            UNISWAP_V3_ROUTER,
            swapCallData,
            calldataSellAmount,
            0n,
            proxyAddress,
            zeroWarrant,
        ]);
    }

    /**
     * Approximate the MiniKit v2 batched UserOp (approve + executeAllowance
     * in the same block), same pattern as Permit2ProxyAllowance.ts.
     */
    async function miniKitBatch(
        signer: Signer,
        pulledAmount: bigint,
        routerCalldata: string,
    ): Promise<void> {
        await ethers.provider.send("evm_setAutomine", [false]);
        try {
            const approveTx = await permit2
                .connect(signer)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, pulledAmount, 0, {
                    gasLimit: 200_000,
                });
            const execTx = await proxy
                .connect(signer)
                .executeAllowance(
                    OPTIMISM_TOKENS.USDC,
                    pulledAmount,
                    OPTIMISM_TOKENS.WETH,
                    routerCalldata,
                    { gasLimit: 1_500_000 },
                );

            await ethers.provider.send("evm_mine", []);

            const approveReceipt = await approveTx.wait();
            const execReceipt = await execTx.wait();
            if (!approveReceipt || approveReceipt.status !== 1) {
                throw new Error("Permit2.approve reverted in batch");
            }
            if (!execReceipt || execReceipt.status !== 1) {
                throw new Error("Permit2Proxy.executeAllowance reverted in batch");
            }
        } finally {
            await ethers.provider.send("evm_setAutomine", [true]);
        }
    }

    it("refunds the residual sellToken and zeroes the leftover allowance when pulled > sold", async function () {
        this.timeout(30000);
        const victimAddress = await victim.getAddress();

        const pulled = ethers.parseUnits("100", 6); // proxy pulls 100 USDC
        const sold = ethers.parseUnits("80", 6); // router calldata only sells 80 USDC

        await stealMoney(usdcWhale, victimAddress, OPTIMISM_TOKENS.USDC, pulled);
        await USDC.connect(victim).approve(PERMIT2_ADDRESS, pulled);

        const usdcBefore = await USDC.balanceOf(victimAddress);
        const wethBefore = await WETH.balanceOf(victimAddress);

        const routerCalldata = await buildSwapCalldata(sold);
        await miniKitBatch(victim, pulled, routerCalldata);

        // Victim received WETH for the 80 USDC that was actually sold.
        expect(await WETH.balanceOf(victimAddress)).to.be.gt(wethBefore);

        // Victim was refunded the 20 USDC residual in the same call —
        // net USDC spend equals exactly what was sold, not what was pulled.
        const usdcAfter = await USDC.balanceOf(victimAddress);
        expect(usdcBefore - usdcAfter).to.equal(sold);

        // Nothing is left parked in the proxy: no residual balance...
        expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
        expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);

        // ...and no leftover proxy->router allowance for a later caller
        // to fold into their own swap.
        expect(await USDC.allowance(proxyAddress, rainbowAddress)).to.equal(0n);
    });

    it("leaves nothing behind for a later caller to steal by wrapping a fresh swap", async function () {
        this.timeout(30000);
        const attackerAddress = await attacker.getAddress();

        // Same "pulled > sold" setup as above, run by a different signer
        // so we don't depend on state left over from the previous test.
        const pulled = ethers.parseUnits("50", 6);
        const sold = ethers.parseUnits("40", 6);

        await stealMoney(usdcWhale, attackerAddress, OPTIMISM_TOKENS.USDC, pulled);
        await USDC.connect(attacker).approve(PERMIT2_ADDRESS, pulled);

        const routerCalldata = await buildSwapCalldata(sold);
        await miniKitBatch(attacker, pulled, routerCalldata);

        // Proxy is fully clean after the call — the pre-fix "residual"
        // that a subsequent caller could have wrapped into their own
        // swap (fresh + residual pulled from the proxy) no longer exists.
        expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
        expect(await USDC.allowance(proxyAddress, rainbowAddress)).to.equal(0n);

        // A follow-up caller trying to claim a "residual" by overselling
        // relative to what they actually pull now simply fails, because
        // there is nothing left in the proxy to combine with their fresh
        // pull: the router's transferFrom for the combined amount reverts.
        const victimAddress = await victim.getAddress();
        const fresh = ethers.parseUnits("1", 6);
        const wouldBeCombined = fresh + ethers.parseUnits("10", 6); // fresh + a hoped-for residual

        await stealMoney(usdcWhale, victimAddress, OPTIMISM_TOKENS.USDC, fresh);
        await USDC.connect(victim).approve(PERMIT2_ADDRESS, fresh);

        const greedyCalldata = await buildSwapCalldata(wouldBeCombined);

        await ethers.provider.send("evm_setAutomine", [false]);
        try {
            const approveTx = await permit2
                .connect(victim)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, fresh, 0, { gasLimit: 200_000 });
            const execTx = await proxy
                .connect(victim)
                .executeAllowance(
                    OPTIMISM_TOKENS.USDC,
                    fresh,
                    OPTIMISM_TOKENS.WETH,
                    greedyCalldata,
                    { gasLimit: 1_500_000 },
                );
            await ethers.provider.send("evm_mine", []);

            const approveReceipt = await approveTx.wait();
            expect(approveReceipt?.status).to.equal(1);
            // The exec tx must fail: the router tries to pull
            // `wouldBeCombined` from the proxy, but the proxy only holds
            // (and only approved) `fresh`. ethers v6 throws on `.wait()`
            // for a reverted transaction.
            let execFailed = false;
            try {
                await execTx.wait();
            } catch {
                execFailed = true;
            }
            expect(execFailed).to.equal(true);
        } finally {
            await ethers.provider.send("evm_setAutomine", [true]);
        }
    });
});
