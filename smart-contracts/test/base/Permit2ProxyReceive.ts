/**
 * Regression tests for Info-02 (Chain Defenders audit, July 2026):
 * "Stray ETH Sent To Permit2Proxy Is Permanently Locked".
 *
 * Permit2Proxy has no owner and no sweep function, so any ETH accepted
 * from a sender other than OkuRouter would be permanently stuck: the
 * balance-diff snapshot in `_forwardAndReturn` re-includes pre-existing
 * ETH on every subsequent call, so it is never forwarded to any caller.
 *
 * The fix restricts `receive()` to `msg.sender == okuRouter`, since that
 * is the only legitimate sender of ETH to the proxy (the output of a
 * token-to-ETH swap via `_fillQuoteTokenToEth`).
 *
 * These tests deploy Permit2Proxy bound to a regular signer's address (so
 * we can send ETH *from* that address to exercise the allowed path)
 * rather than a real OkuRouter, since only the constructor address
 * matters for this check.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { type Signer } from "ethers";
import { type Permit2Proxy, Permit2Proxy__factory } from "../../typechain-types";

describe("Permit2Proxy.receive() ETH intake restriction (Info-02 regression)", function () {
    let proxy: Permit2Proxy;
    let proxyAddress: string;
    let routerStandIn: Signer; // acts as the "okuRouter" address bound in the constructor
    let stranger: Signer;

    before(async function () {
        const signers = await ethers.getSigners();
        routerStandIn = signers[0];
        stranger = signers[1];

        proxy = await new Permit2Proxy__factory(routerStandIn).deploy(
            await routerStandIn.getAddress(),
        );
        await proxy.waitForDeployment();
        proxyAddress = await proxy.getAddress();
    });

    it("rejects a plain ETH transfer from anyone other than okuRouter", async function () {
        await expect(
            stranger.sendTransaction({ to: proxyAddress, value: ethers.parseEther("1") }),
        ).to.be.revertedWith("ONLY_ROUTER");

        // No ETH was accepted — confirms it isn't partially credited before reverting.
        expect(await ethers.provider.getBalance(proxyAddress)).to.equal(0n);
    });

    it("accepts a plain ETH transfer from okuRouter", async function () {
        const amount = ethers.parseEther("1");
        await routerStandIn.sendTransaction({ to: proxyAddress, value: amount });

        expect(await ethers.provider.getBalance(proxyAddress)).to.equal(amount);
    });
});
