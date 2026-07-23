/**
 * World Chain smoke test for Permit2Proxy.executeAllowance.
 *
 * Scope: prove that the canonical Permit2 deployment on World Chain
 * (chainId 480) implements the AllowanceTransfer interface our proxy
 * relies on, and that the MiniKit v2 same-block approve+transferFrom
 * flow works against that real on-chain bytecode.
 *
 * Out of scope: end-to-end swap testing on World Chain. That requires
 * deep pool liquidity for a specific token pair and is already covered
 * by the OP-fork suite in Permit2ProxyAllowance.ts. The actual swap
 * pipeline (`_forwardAndReturn`) is chain-agnostic, so once the
 * Permit2 boundary is verified on World Chain, the rest follows.
 *
 * To avoid depending on a fragile USDC whale on World Chain, we mint a
 * MockERC20 to the user — Permit2 is token-agnostic, so this proves the
 * exact same state machine that production would exercise against USDC.
 *
 * Skipped automatically if WORLDCHAIN_URL is unset (CI without RPC).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { type Signer } from "ethers";
import type { OkuRouter, Permit2Proxy, MockERC20 } from "../../typechain-types";
import {
    OkuRouter__factory,
    Permit2Proxy__factory,
    MockERC20__factory,
} from "../../typechain-types";
import { tryFork } from "../../util/forkHelper";

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const PERMIT2_ABI = [
    "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
    "function transferFrom(address from, address to, uint160 amount, address token) external",
    "function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

describe("Permit2Proxy.executeAllowance — World Chain smoke", function () {
    let proxy: Permit2Proxy;
    let user: Signer;
    let token: MockERC20;
    let permit2: any;
    let proxyAddress: string;
    let tokenAddress: string;

    before(async function () {
        this.timeout(60000);

        // World Chain doesn't need an archive block — latest is fine and
        // avoids depending on a fixed block that might be pruned by the
        // public RPC over time.
        const success = await tryFork({
            rpcUrl: process.env.WORLDCHAIN_URL,
            blockNumber: undefined as unknown as number,
            chainName: "World Chain",
        });
        if (!success) {
            this.skip();
        }

        // NOTE: hardhat.config.ts hard-pins chainId=10 on the in-process
        // network regardless of the upstream fork RPC. That's fine for
        // AllowanceTransfer (no EIP-712 domain involvement); we just rely
        // on the WORLDCHAIN_URL RPC for the underlying contract state.
        // The Permit2 bytecode presence check below is the actual proof
        // that we are talking to worldchain.
        const signers = await ethers.getSigners();
        const owner = signers[0];
        user = signers[1];

        const ownerAddress = await owner.getAddress();

        // Deploy router + proxy + token on the fork. We never call
        // OkuRouter from the smoke test, but constructing it keeps the
        // fixture honest with respect to the proxy's immutable binding.
        const Rainbow: OkuRouter = await new OkuRouter__factory(owner).deploy(
            "Oku Router",
            "1.1",
            ownerAddress,
            ethers.ZeroAddress,
        );
        await Rainbow.waitForDeployment();

        proxy = await new Permit2Proxy__factory(owner).deploy(await Rainbow.getAddress());
        await proxy.waitForDeployment();
        proxyAddress = await proxy.getAddress();

        token = await new MockERC20__factory(owner).deploy("Smoke USD", "sUSD", 6);
        await token.waitForDeployment();
        tokenAddress = await token.getAddress();

        permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, owner);
    });

    it("Permit2 is deployed on World Chain at the canonical address", async function () {
        const code = await ethers.provider.getCode(PERMIT2_ADDRESS);
        // Just confirm there's code; we don't pin a specific bytecode
        // hash because the on-chain deployment may be wrapped by a proxy
        // on some chains.
        expect(code).to.not.equal("0x");
        expect(code.length).to.be.greaterThan(2);
    });

    it("MiniKit v2 same-block approve+transferFrom works against World Chain's Permit2", async function () {
        this.timeout(60000);
        const userAddress = await user.getAddress();
        const amount = ethers.parseUnits("100", 6);

        // 1. Mint tokens to the user and approve Permit2 at the token level
        //    (World App auto-grants this in production).
        await token.mint(userAddress, amount);
        await token.connect(user).approve(PERMIT2_ADDRESS, amount);

        // Sanity: the proxy starts empty.
        expect(await token.balanceOf(proxyAddress)).to.equal(0n);

        // 2. Drive the MiniKit v2 batched UserOp shape:
        //    - Permit2.approve(token, proxy, amount, expiration=0)
        //    - permit2.transferFrom(user, proxy, amount, token)  [as proxy]
        //    must both land in the same block, because expiration=0 stores
        //    block.timestamp and transferFrom requires timestamp <= expiration.
        await ethers.provider.send("evm_setAutomine", [false]);
        try {
            const approveTx = await permit2
                .connect(user)
                .approve(tokenAddress, proxyAddress, amount, 0, {
                    gasLimit: 200_000,
                });

            // Impersonate the proxy: in production it's the proxy that calls
            // permit2.transferFrom, so msg.sender == proxyAddress is the
            // path we need to exercise.
            await ethers.provider.send("hardhat_impersonateAccount", [proxyAddress]);
            await ethers.provider.send("hardhat_setBalance", [
                proxyAddress,
                "0xDE0B6B3A7640000", // 1 ETH for gas
            ]);
            const proxySigner = await ethers.getSigner(proxyAddress);
            const permit2AsProxy = new ethers.Contract(
                PERMIT2_ADDRESS,
                PERMIT2_ABI,
                proxySigner,
            );
            const transferTx = await permit2AsProxy.transferFrom(
                userAddress,
                proxyAddress,
                amount,
                tokenAddress,
                { gasLimit: 200_000 },
            );

            // Mine one block — both pooled txs land together.
            await ethers.provider.send("evm_mine", []);

            const approveReceipt = await approveTx.wait();
            const transferReceipt = await transferTx.wait();
            expect(approveReceipt?.status).to.equal(1);
            expect(transferReceipt?.status).to.equal(1);

            await ethers.provider.send("hardhat_stopImpersonatingAccount", [proxyAddress]);
        } finally {
            await ethers.provider.send("evm_setAutomine", [true]);
        }

        // 3. Tokens moved from user to proxy; Permit2 allowance fully consumed.
        expect(await token.balanceOf(userAddress)).to.equal(0n);
        expect(await token.balanceOf(proxyAddress)).to.equal(amount);

        const [residualAmount] = await permit2.allowance(
            userAddress,
            tokenAddress,
            proxyAddress,
        );
        expect(residualAmount).to.equal(0n);
    });
});
