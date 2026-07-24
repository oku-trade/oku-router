import { ethers } from "hardhat";
import { Signer, ZeroAddress, TypedDataDomain } from "ethers";
import { generateUniTxData } from "../../util/testHelpers";

/**
 * Helper functions to create dummy quotes, warrants, and permits for testing
 * without relying on external API calls
 */

// Token addresses on Optimism
export const OPTIMISM_TOKENS = {
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    WETH: "0x4200000000000000000000000000000000000006",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
};

// Uniswap V3 SwapRouter02 on Optimism
export const UNISWAP_V3_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

/**
 * Create a dummy swap calldata using Uniswap V3
 */
export async function createDummySwapCalldata(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    recipient: string,
    feeTier: number = 500, // 0.05%
    amountOutMinimum: bigint = 0n
): Promise<string> {
    return await generateUniTxData(
        tokenIn,
        tokenOut,
        amountIn,
        UNISWAP_V3_ROUTER,
        feeTier,
        recipient,
        amountOutMinimum
    ) as string;
}

/**
 * Create a dummy warrant for testing
 */
export async function createDummyWarrant(
    signer: Signer,
    rainbowAddress: string,
    sellTokenAddress: string,
    buyTokenAddress: string,
    routerAddress: string,
    swapCallData: string,
    sellAmount: bigint,
    feeAmount: bigint,
    options: {
        nonce?: bigint;
        validBefore?: number;
        validAfter?: number;
        useZeroSigner?: boolean;
        approvalTarget?: string;
        name?: string;
        version?: string;
    } = {}
) {
    const latestBlock = await ethers.provider.getBlock('latest');
    const blockTimestamp = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

    const nonce = options.nonce ?? 1n;
    const validBefore = options.validBefore ?? blockTimestamp + 3600;
    const validAfter = options.validAfter ?? blockTimestamp - 300;
    const approvalTarget = options.approvalTarget ?? routerAddress;
    const name = options.name ?? "Rainbow Router";
    const version = options.version ?? "1.0";

    const swapCallDataHash = ethers.keccak256(swapCallData);
    const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
            [sellTokenAddress, buyTokenAddress, routerAddress, approvalTarget, swapCallDataHash, sellAmount, feeAmount]
        )
    );

    const packedValidationData = nonce | (BigInt(validBefore) << 160n) | (BigInt(validAfter) << 208n);

    if (options.useZeroSigner) {
        return {
            nonce,
            validBefore,
            validAfter,
            verifyingSigner: ZeroAddress,
            signature: "0x"
        };
    }

    const domain: TypedDataDomain = {
        name,
        version,
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: rainbowAddress
    };

    const types = {
        CanoeWarrant: [
            { name: 'packedValidationData', type: 'uint256' },
            { name: 'dataHash', type: 'bytes32' }
        ]
    };

    const value = {
        packedValidationData,
        dataHash
    };

    const signature = await signer.signTypedData(domain, types, value);

    return {
        nonce,
        validBefore,
        validAfter,
        verifyingSigner: await signer.getAddress(),
        signature
    };
}

/**
 * Create a dummy warrant with invalid timestamps (for testing error cases)
 */
export async function createInvalidTimestampWarrant(
    signer: Signer,
    rainbowAddress: string,
    sellTokenAddress: string,
    buyTokenAddress: string,
    routerAddress: string,
    swapCallData: string,
    sellAmount: bigint,
    feeAmount: bigint,
    timestampCase: 'expired' | 'not_yet' | 'invalid_range'
) {
    const latestBlock = await ethers.provider.getBlock('latest');
    const blockTimestamp = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

    let validBefore: number;
    let validAfter: number;

    switch (timestampCase) {
        case 'expired':
            // Warrant expired 1 hour ago
            validBefore = blockTimestamp - 3600;
            validAfter = blockTimestamp - 7200;
            break;
        case 'not_yet':
            // Warrant not valid until 1 hour from now
            validBefore = blockTimestamp + 7200;
            validAfter = blockTimestamp + 3600;
            break;
        case 'invalid_range':
            // validAfter > validBefore (invalid)
            validBefore = blockTimestamp - 3600;
            validAfter = blockTimestamp + 3600;
            break;
    }

    return await createDummyWarrant(
        signer,
        rainbowAddress,
        sellTokenAddress,
        buyTokenAddress,
        routerAddress,
        swapCallData,
        sellAmount,
        feeAmount,
        { validBefore, validAfter }
    );
}

/**
 * Create a warrant signed by the wrong signer (for testing signature validation)
 */
export async function createWrongSignerWarrant(
    correctSigner: Signer,
    wrongSigner: Signer,
    rainbowAddress: string,
    sellTokenAddress: string,
    buyTokenAddress: string,
    routerAddress: string,
    swapCallData: string,
    sellAmount: bigint,
    feeAmount: bigint,
    approvalTarget?: string
) {
    const latestBlock = await ethers.provider.getBlock('latest');
    const blockTimestamp = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

    const nonce = 1n;
    const validBefore = blockTimestamp + 3600;
    const validAfter = blockTimestamp - 300;
    const approvalTargetAddr = approvalTarget ?? routerAddress;

    const swapCallDataHash = ethers.keccak256(swapCallData);
    const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
            [sellTokenAddress, buyTokenAddress, routerAddress, approvalTargetAddr, swapCallDataHash, sellAmount, feeAmount]
        )
    );

    const packedValidationData = nonce | (BigInt(validBefore) << 160n) | (BigInt(validAfter) << 208n);

    const domain: TypedDataDomain = {
        name: "Rainbow Router",
        version: "1.0",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: rainbowAddress
    };

    const types = {
        CanoeWarrant: [
            { name: 'packedValidationData', type: 'uint256' },
            { name: 'dataHash', type: 'bytes32' }
        ]
    };

    const value = {
        packedValidationData,
        dataHash
    };

    const signature = await wrongSigner.signTypedData(domain, types, value);

    return {
        nonce,
        validBefore,
        validAfter,
        verifyingSigner: await correctSigner.getAddress(),
        signature
    };
}

/**
 * Create a dummy permit (DAI, EIP-2612, or Permit2)
 */
export async function createDummyPermit(
    signer: Signer,
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
    tokenNonce: bigint,
    permitStyle: 0 | 1 | 2 = 1  // 0 = DAI, 1 = EIP-2612 (default), 2 = PERMIT_2
): Promise<{
    value: bigint;
    nonce: bigint;
    deadline: bigint;
    permitStyle: 0 | 1 | 2;
    v: number;
    r: string;
    s: string;
}> {
    const latestBlock = await ethers.provider.getBlock('latest');
    const blockTimestamp = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
    const deadline = BigInt(blockTimestamp + 3600); // 1 hour from now

    // Handle Permit2 separately
    if (permitStyle === 2) {
        const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

        // Generate a unique nonce (Permit2 SignatureTransfer uses bitmap, not sequential nonces)
        // Each nonce bit can only be used once. Common practice: use timestamp or random value
        const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

        const domain = {
            name: 'Permit2',
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: PERMIT2_ADDRESS,
        };

        const types = {
            PermitTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' }
            ],
            TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' }
            ]
        };

        const value = {
            permitted: {
                token: tokenAddress,
                amount: amount
            },
            spender: spenderAddress,
            nonce: nonce,
            deadline: deadline
        };

        const signature = await signer.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        return {
            value: amount,
            nonce: nonce,
            deadline,
            permitStyle: 2,
            v: sig.v,
            r: sig.r,
            s: sig.s
        };
    }

    // Handle DAI and EIP-2612 permits
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    const name = await token.name();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
        name,
        version: permitStyle === 0 ? "1" : "2", // DAI uses "1", EIP-2612 uses "2"
        chainId,
        verifyingContract: tokenAddress
    };

    let types, value;

    if (permitStyle === 0) {
        // DAI-style permit (holder, spender)
        types = {
            Permit: [
                { name: "holder", type: "address" },
                { name: "spender", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
                { name: "allowed", type: "bool" }
            ]
        };
        value = {
            holder: await signer.getAddress(),
            spender: spenderAddress,
            nonce: tokenNonce,
            expiry: deadline,
            allowed: true
        };
    } else {
        // EIP-2612 standard permit (owner, spender)
        types = {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        };
        value = {
            owner: await signer.getAddress(),
            spender: spenderAddress,
            value: amount,
            nonce: tokenNonce,
            deadline
        };
    }

    const signature = await signer.signTypedData(domain, types, value);
    const sig = ethers.Signature.from(signature);

    return {
        value: amount,
        nonce: tokenNonce,
        deadline,
        permitStyle: permitStyle,
        v: sig.v,
        r: sig.r,
        s: sig.s
    };
}
