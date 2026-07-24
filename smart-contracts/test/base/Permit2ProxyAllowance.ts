/**
 * Tests for the Permit2Proxy `executeAllowance` entry point — the
 * AllowanceTransfer-based flow required by MiniKit v2 / World App.
 *
 * The MiniKit v2 flow batches two calls in one UserOp:
 *   1. Permit2.approve(sellToken, proxy, amount, expiration=0)
 *   2. proxy.executeAllowance(sellToken, amount, buyToken, routerCalldata)
 *
 * Because hardhat tests do not have UserOp batching semantics, we
 * approximate the batch by calling Permit2.approve() and then
 * proxy.executeAllowance() back-to-back from the same signer. That's a
 * stricter test (no atomic batching protection) and exercises the exact
 * Permit2 state transitions we care about.
 *
 * The tests fork Optimism (same Permit2 deployment as worldchain,
 * canonical 0x0000…22D473…) so we can reuse the existing fork helpers
 * without requiring a worldchain archive RPC.
 */
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

// Minimal ABI for the two Permit2 entry points we need to read/write from
// the test harness. Mirrors the canonical AllowanceTransfer surface.
const PERMIT2_ABI = [
    "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
    "function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

describe("Permit2Proxy.executeAllowance (MiniKit v2 / AllowanceTransfer)", function () {
    const name = "Oku Router";
    const version = "1.1";
    // Balancer vault on Optimism — large USDC holder, used as test whale.
    const usdcWhale = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    let Rainbow: OkuRouter;
    let proxy: Permit2Proxy;
    let owner: Signer;
    let user: Signer;
    let attacker: Signer;
    let USDC: any;
    let WETH: any;
    let permit2: any;
    let rainbowAddress: string;
    let proxyAddress: string;

    before(async function () {
        this.timeout(30000);

        // Fork Optimism — skip if archive RPC unavailable.
        const success = await tryFork(FORK_CONFIGS.OPTIMISM);
        if (!success) {
            this.skip();
        }

        const signers = await ethers.getSigners();
        owner = signers[0];
        user = signers[1];
        attacker = signers[2];

        const ownerAddress = await owner.getAddress();

        // Deploy a fresh OkuRouter at v1.1 (post-sweepAll). The proxy
        // bytecode does not depend on the router version, but using the
        // current version here keeps the test fixture honest.
        Rainbow = await new OkuRouter__factory(owner).deploy(name, version, ownerAddress, ZeroAddress);
        await Rainbow.waitForDeployment();
        rainbowAddress = await Rainbow.getAddress();

        // Register swap target + zero-address signer (warrant bypass mode).
        await Rainbow.connect(owner).updateSwapTargets(UNISWAP_V3_ROUTER, true);
        await Rainbow.connect(owner).updateValidSigner(ZeroAddress, true);

        // Deploy the (refactored) Permit2Proxy.
        proxy = await new Permit2Proxy__factory(owner).deploy(rainbowAddress);
        await proxy.waitForDeployment();
        proxyAddress = await proxy.getAddress();

        USDC = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.USDC, owner);
        WETH = IERC20Metadata__factory.connect(OPTIMISM_TOKENS.WETH, owner);
        permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, owner);
    });

    // Zero-address warrant — bypass warrant verification (matches the
    // pattern used by the existing Permit2Proxy SignatureTransfer tests).
    const zeroWarrant = {
        nonce: 0n,
        validBefore: 0,
        validAfter: 0,
        verifyingSigner: ZeroAddress,
        signature: "0x",
    };

    /**
     * Build OkuRouter calldata for a USDC->WETH swap with optional fee.
     * Extracted so the tests below stay focused on the Permit2 mechanics.
     */
    async function buildSwapCalldata(sellAmount: bigint, feeAmount: bigint) {
        const swapCallData = await createDummySwapCalldata(
            OPTIMISM_TOKENS.USDC,
            OPTIMISM_TOKENS.WETH,
            sellAmount - feeAmount,
            rainbowAddress,
        );
        return Rainbow.interface.encodeFunctionData("fillQuoteTokenToToken", [
            OPTIMISM_TOKENS.USDC,
            OPTIMISM_TOKENS.WETH,
            UNISWAP_V3_ROUTER,
            UNISWAP_V3_ROUTER,
            swapCallData,
            sellAmount,
            feeAmount,
            proxyAddress,
            zeroWarrant,
        ]);
    }

    /**
     * Approximate the MiniKit v2 batched UserOp:
     *  1. Permit2.approve(token, proxy, amount, expiration)
     *  2. proxy.executeAllowance(...)
     *
     * Crucial subtlety: Permit2's `approve` special-cases `expiration = 0`
     * by storing `block.timestamp` as the expiration. `_transfer` then
     * requires `block.timestamp <= stored_expiration`, so the transferFrom
     * MUST happen in the SAME block as the approve. MiniKit v2's UserOp
     * batches both calls into one transaction, so this invariant holds
     * naturally on-chain. In hardhat each await mines a new block by
     * default, which would put the executeAllowance call one block AFTER
     * the approve and trip `AllowanceExpired`. We therefore disable
     * automining, queue both transactions, mine one block, and check the
     * results — that faithfully models the MiniKit batched-UserOp
     * semantics.
     */
    async function miniKitBatch(
        signer: Signer,
        sellAmount: bigint,
        feeAmount: bigint,
        expiration: number = 0,
    ): Promise<void> {
        const routerCalldata = await buildSwapCalldata(sellAmount, feeAmount);

        // For the same-block invariant, we MUST disable automining when
        // expiration == 0. For non-zero (future) expirations a regular
        // sequential send works fine and exercises the "pre-approved
        // allowance" path.
        if (expiration === 0) {
            await ethers.provider.send("evm_setAutomine", [false]);
            try {
                // We MUST bypass ethers' default eth_estimateGas, because
                // estimation runs against the latest MINED block — which
                // doesn't yet contain the approve tx, so it would revert
                // with AllowanceExpired (allowance.expiration is 0 by
                // default for an unset slot). Hard-code a generous limit.
                const approveTx = await permit2
                    .connect(signer)
                    .approve(OPTIMISM_TOKENS.USDC, proxyAddress, sellAmount, expiration, {
                        gasLimit: 200_000,
                    });
                const execTx = await proxy
                    .connect(signer)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        routerCalldata,
                        { gasLimit: 1_500_000 },
                    );

                // Mine one block containing both pooled transactions.
                await ethers.provider.send("evm_mine", []);

                // Surface any in-block reverts to the caller.
                const approveReceipt = await approveTx.wait();
                const execReceipt = await execTx.wait();
                if (!approveReceipt || approveReceipt.status !== 1) {
                    throw new Error("Permit2.approve reverted in batch");
                }
                if (!execReceipt || execReceipt.status !== 1) {
                    throw new Error("Permit2Proxy.executeAllowance reverted in batch");
                }
            } finally {
                // ALWAYS re-enable automining, even on failure, so later
                // tests are not silently affected by leaked state.
                await ethers.provider.send("evm_setAutomine", [true]);
            }
            return;
        }

        // Non-zero expiration: sequential calls are fine; the allowance
        // is valid for ~`expiration` seconds, so the second tx in the
        // next block still passes the `block.timestamp <= expiration` check.
        await permit2
            .connect(signer)
            .approve(OPTIMISM_TOKENS.USDC, proxyAddress, sellAmount, expiration);
        await proxy
            .connect(signer)
            .executeAllowance(
                OPTIMISM_TOKENS.USDC,
                sellAmount,
                OPTIMISM_TOKENS.WETH,
                routerCalldata,
            );
    }

    describe("Token-to-Token swap (USDC -> WETH)", () => {
        it("Should swap USDC -> WETH via the MiniKit v2 batched approve+execute flow", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6); // 10 USDC

            // Token-level approval to Permit2 is normally auto-granted by
            // World App; replicate that manually in the test fixture.
            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            const wethBefore = await WETH.balanceOf(userAddress);

            await miniKitBatch(user, sellAmount, 0n);

            const wethAfter = await WETH.balanceOf(userAddress);
            expect(wethAfter).to.be.gt(wethBefore);

            // Proxy must end with zero balances of both tokens.
            expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);
            expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);

            // CRITICAL invariant: the Permit2 allowance must have been
            // fully consumed by the transferFrom call. Otherwise a future
            // call from anyone could spend the residual. (Permit2 zeroes
            // the slot on full consumption.)
            const [residualAmount] = await permit2.allowance(
                userAddress,
                OPTIMISM_TOKENS.USDC,
                proxyAddress,
            );
            expect(residualAmount).to.equal(0n);
        });

        it("Should swap USDC -> WETH with a non-zero fee retained on OkuRouter", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("100", 6); // 100 USDC
            const feeAmount = ethers.parseUnits("1", 6); // 1 USDC fee

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            const routerUsdcBefore = await USDC.balanceOf(rainbowAddress);
            const wethBefore = await WETH.balanceOf(userAddress);

            await miniKitBatch(user, sellAmount, feeAmount);

            // User received WETH; OkuRouter retained the USDC fee.
            expect(await WETH.balanceOf(userAddress)).to.be.gt(wethBefore);
            const routerUsdcAfter = await USDC.balanceOf(rainbowAddress);
            expect(routerUsdcAfter - routerUsdcBefore).to.equal(feeAmount);

            // Proxy is clean.
            expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
            expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);
        });

        it("Should also accept a pre-approved Permit2 allowance with a future expiration (non-MiniKit caller)", async function () {
            this.timeout(30000);
            // This proves executeAllowance is not coupled to the MiniKit
            // `expiration = 0` quirk; a normal Permit2 user with a
            // long-lived allowance can call it directly too.
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("5", 6);
            const futureExpiration = Math.floor(Date.now() / 1000) + 86_400; // +1 day

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            await miniKitBatch(user, sellAmount, 0n, futureExpiration);

            // Allowance should now reflect amount=0 after consumption.
            const [residualAmount] = await permit2.allowance(
                userAddress,
                OPTIMISM_TOKENS.USDC,
                proxyAddress,
            );
            expect(residualAmount).to.equal(0n);
        });
    });

    describe("Revert cases", () => {
        it("Should revert when the Permit2 allowance is missing entirely", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // Intentionally skip the Permit2.approve step.
            const routerCalldata = await buildSwapCalldata(sellAmount, 0n);

            await expect(
                proxy
                    .connect(user)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        routerCalldata,
                    ),
            ).to.be.reverted; // Permit2 reverts with InsufficientAllowance.
        });

        it("Should revert when the Permit2 allowance is insufficient", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);
            const shortAllowance = sellAmount - 1n;

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            await permit2
                .connect(user)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, shortAllowance, 0);

            const routerCalldata = await buildSwapCalldata(sellAmount, 0n);

            await expect(
                proxy
                    .connect(user)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        routerCalldata,
                    ),
            ).to.be.reverted;
        });

        it("Should revert when the Permit2 allowance has already expired", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            // Set an expiration in the past — Permit2 should reject the transferFrom.
            // NOTE: `expiration = 0` is special-cased by Permit2 as "consume in
            // same block" and is NOT treated as expired, so we use 1 instead.
            await permit2
                .connect(user)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, sellAmount, 1);

            const routerCalldata = await buildSwapCalldata(sellAmount, 0n);

            await expect(
                proxy
                    .connect(user)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        routerCalldata,
                    ),
            ).to.be.reverted;
        });

        it("Should revert with bad router calldata (revert bubbles up untouched)", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);
            await permit2
                .connect(user)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, sellAmount, 0);

            const badCalldata = "0xdeadbeef"; // not a valid OkuRouter selector

            await expect(
                proxy
                    .connect(user)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        badCalldata,
                    ),
            ).to.be.reverted;
        });

        it("Should not let an attacker spend the victim's allowance for someone else (only the granted spender can call)", async function () {
            this.timeout(30000);
            // Permit2 allowance is indexed by (owner, token, spender), and
            // `spender = msg.sender` at the transferFrom call site.
            // Therefore an attacker calling executeAllowance themselves
            // can only spend allowances granted to the proxy by the
            // attacker — not the victim's. We exercise that boundary:
            // grant proxy allowance from the *victim*, then have the
            // attacker call executeAllowance and confirm it reverts.
            const victimAddress = await user.getAddress();
            const attackerAddress = await attacker.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            // Fund both — victim with USDC to set the allowance, attacker
            // with nothing relevant (they're the front-runner here).
            await stealMoney(usdcWhale, victimAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);
            await permit2
                .connect(user)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, sellAmount, 0);

            const routerCalldata = await buildSwapCalldata(sellAmount, 0n);

            // Attacker calls executeAllowance — Permit2 will check
            // allowance[attacker][USDC][proxy], which is zero. Reverts.
            await expect(
                proxy
                    .connect(attacker)
                    .executeAllowance(
                        OPTIMISM_TOKENS.USDC,
                        sellAmount,
                        OPTIMISM_TOKENS.WETH,
                        routerCalldata,
                    ),
            ).to.be.reverted;

            // Victim's allowance should still be intact (no partial consumption).
            const [residualAmount] = await permit2.allowance(
                victimAddress,
                OPTIMISM_TOKENS.USDC,
                proxyAddress,
            );
            expect(residualAmount).to.equal(sellAmount);

            // Cleanup: revoke so this test doesn't bleed state into the next one.
            await permit2
                .connect(user)
                .approve(OPTIMISM_TOKENS.USDC, proxyAddress, 0, 0);
        });
    });

    describe("Backward compatibility with execute() (SignatureTransfer)", () => {
        // Smoke test: prove the refactor (lifting steps 2-5 into
        // _forwardAndReturn) did not break the existing SignatureTransfer
        // entry point. The dedicated SignatureTransfer test file
        // (test/base/Permit2Proxy.ts) already covers this exhaustively;
        // this just nails the regression boundary right here next to the
        // new entry point so a future change to _forwardAndReturn is
        // caught by both files.
        it("execute() still works after the refactor", async function () {
            this.timeout(30000);
            const userAddress = await user.getAddress();
            const sellAmount = ethers.parseUnits("10", 6);

            await stealMoney(usdcWhale, userAddress, OPTIMISM_TOKENS.USDC, sellAmount);
            await USDC.connect(user).approve(PERMIT2_ADDRESS, sellAmount);

            const chainId = (await ethers.provider.getNetwork()).chainId;
            const latestBlock = await ethers.provider.getBlock("latest");
            const blockTimestamp = latestBlock
                ? Number(latestBlock.timestamp)
                : Math.floor(Date.now() / 1000);
            const deadline = blockTimestamp + 3600;
            const nonce =
                BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

            const domain = {
                name: "Permit2",
                chainId,
                verifyingContract: PERMIT2_ADDRESS,
            };
            const types = {
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
            const value = {
                permitted: { token: OPTIMISM_TOKENS.USDC, amount: sellAmount },
                spender: proxyAddress,
                nonce,
                deadline,
            };

            const signature = await user.signTypedData(domain, types, value);
            const permit = {
                permitted: { token: OPTIMISM_TOKENS.USDC, amount: sellAmount },
                nonce,
                deadline,
            };

            const routerCalldata = await buildSwapCalldata(sellAmount, 0n);

            const wethBefore = await WETH.balanceOf(userAddress);
            await proxy
                .connect(user)
                .execute(permit, signature, OPTIMISM_TOKENS.WETH, routerCalldata);
            const wethAfter = await WETH.balanceOf(userAddress);

            expect(wethAfter).to.be.gt(wethBefore);
            expect(await USDC.balanceOf(proxyAddress)).to.equal(0n);
            expect(await WETH.balanceOf(proxyAddress)).to.equal(0n);
        });
    });
});
