import { AbiCoder, AddressLike, BigNumberish, BytesLike, formatUnits, Interface, keccak256, parseUnits, Signer, TransactionResponse, TypedDataDomain, ZeroAddress } from "ethers";
import { ERC20__factory, ISwapRouter02__factory, OkuRouter, OkuRouter__factory } from "../typechain-types";
import hre, { ethers, network } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { IERC20__factory } from "../typechain-types/factories/contracts/interfaces/openzeppelin";
import { IERC20 } from "../typechain-types/contracts/interfaces/openzeppelin";
import axios from "axios";
import { NETWORK_CONFIGS } from "./networkConfig";
import { getCurrentAddress } from "./deploymentsRegistry";


//response types
// A generic type for unknown nested objects, can be refined if their structure is known
type AnyObject = Record<string, any>;

// Execution and signing request interfaces
export interface ExecutionRequest {
    coupon: Coupon;
    signingRequest?: SigningRequest;
    blockaidSim?: boolean;
    useOkuRouter?: boolean;
}

export interface SigningRequest {
    typedData?: TypedDataSignature[];
    permit2Address?: string;
}

export interface TypedDataSignature {
    payload: TypedData;
    signature?: string;
}

export interface TypedData {
    types: Record<string, any>;
    domain: Record<string, any>;
    message: Record<string, any>;
    primaryType: string;
}

export interface RainbowExecutionInfo {
    // Response from execution_information API
    approvals?: any[];
    transactions?: any[];
    trade?: any;
    analysis?: any;
    warrant?: any;
    warrantTypedData?: any;
    [key: string]: any;
}

// Permit signature interfaces
export interface PermitOutput {
    value: bigint;
    nonce: bigint;
    deadline: bigint;
    permitStyle: 0 | 1 | 2;  // 0 = DAI, 1 = EIP-2612, 2 = PERMIT_2
    v: number;
    r: string;
    s: string;
}

export interface BridgeInfo {
    sourceChainId?: number;
    destinationChainId?: number;
    tokenAddressOnSource?: string;
    tokenAddressOnDestination?: string;
}

export interface TokenExtensions {
    bridgeInfo?: BridgeInfo | AnyObject;
}

export interface Token {
    chainId: number;
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI: string;
    extensions?: TokenExtensions;
    price?: number;
}
export interface Fees {
    gas: string;
}


export interface RawCouponData {
    executionInformation: AnyObject;
    routeSummary: AnyObject;
}

export interface Coupon {
    chainId: number;
    account: string;
    raw: RawCouponData;
}

export interface CandidateTrade {
    chainId: number;
    data: string;
    to: string;
    value: string;
}

export interface SwapQuoteResponse {
    inAmount: string;
    outAmount: string;
    slippage: number;
    fees: Fees;
    coupon: Coupon;
    candidateTrade: CandidateTrade;
    chainId: number;
    market: string; // Consider using the MarketId enum if this string is constrained to those values
    isExactIn: boolean;
    inToken: Token;
    outToken: Token;
    amountRatio: number;
    tokenInUsdValue?: number;
    gasInUsdValue?: number;
    inUsdValue?: number;
    tokenOutUsdValue?: number;
    outUsdValue?: number;
    timestamp: number;       // Unix timestamp
}

export type RainbwoDomainInfo = {
    name: string,
    version: string,
    address: string
}

export type SimResult = {
    success: boolean,
    market: MarketId,
    txData: string
}


export enum MarketId {
    AIRSWAP = 'airswap',
    ENSO = 'enso',
    KYBERSWAP = 'kyberswap',
    ODOS = 'odos',
    OKX = 'okx',
    ONEINCH = 'oneinch',
    OPENOCEAN = 'openocean',
    PARASWAP = 'paraswap',
    USOR = 'usor',
    ZEROEX = 'zeroex',
    COWSWAP = 'cowswap',
    ICECREAMSWAP = 'icecreamswap'
}

export enum RainbowTxType {
    ETH2TOKEN = "ETH2TOKEN",
    TOKEN2TOKEN = "TOKEN2TOKEN",
    TOKEN2ETH = "TOKEN2ETH",
    TOKEN2ETH_PERMIT = "TOKEN2ETH_PERMIT",
    TOKEN2TOKEN_PERMIT = "TOKEN2TOKEN_PERMIT",
}

export type canoeParams = {
    chain: string,
    account: string,
    userAddress?: string, // Optional: User wallet address (for permit owner when using usePermit/usePermit2)
    isExactIn: boolean,
    inTokenAddress: string,
    outTokenAddress: string,
    inTokenAmount: string, //human readable terms
    slippage: number,
    useOkuRouter?: boolean, // Optional flag for Oku Router (Rainbow Router) optimization
    getCalldata?: boolean, // Optional flag to get calldata, needed for oneinch
    usePermit?: boolean, // Optional flag to enable EIP-2612 permit signatures (deprecated)
    usePermit2?: boolean // Optional flag to enable Permit2 signatures (recommended)
}

// Permit signature generation
export const generatePermitSignature = async (
    signer: Signer,
    chainId: number,
    tokenAddress: string, // Address of the ERC-20 token
    amount: bigint,      // The 'value' for the permit
    spender: string,     // Address granted allowance
    permitStyle: 0 | 1 | 2 = 1, // 0 = DAI, 1 = EIP-2612 (default), 2 = PERMIT_2
    // Nonce will be fetched from the token contract
    expiration?: number, // Optional: custom expiration timestamp (in seconds)
): Promise<PermitOutput> => { // Return the desired Permit struct data

    const ownerAddress = await signer.getAddress();
    let deadline: number;

    if (expiration == undefined) {
        deadline = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now (default)
    } else {
        deadline = expiration;
    }

    // Handle Permit2 separately (different signature structure)
    if (permitStyle === 2) {
        // Permit2 SignatureTransfer
        const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

        // Generate a unique nonce (Permit2 SignatureTransfer uses bitmap, not sequential nonces)
        // Each nonce bit can only be used once. Common practice: use timestamp or random value
        const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

        // Define Permit2 domain
        const domain: TypedDataDomain = {
            name: 'Permit2',
            chainId: chainId,
            verifyingContract: PERMIT2_ADDRESS,
        };

        // Define Permit2 SignatureTransfer types
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

        // Define values
        const values = {
            permitted: {
                token: tokenAddress,
                amount: amount.toString()
            },
            spender: spender,
            nonce: nonce.toString(),
            deadline: deadline.toString()
        };

        // Sign the typed data
        const signature = await signer.signTypedData(domain, types, values);
        const { v, r, s } = ethers.Signature.from(signature);

        return {
            value: amount,
            nonce: nonce,
            deadline: BigInt(deadline),
            permitStyle: 2,
            v, r, s
        };
    }

    // Handle DAI and EIP-2612 permits (both use token-based nonces)
    const tokenContract = ERC20__factory.connect(tokenAddress, signer);
    let nonce: bigint = 0n;

    try {
        nonce = await (tokenContract as any).nonces(ownerAddress);
    } catch (error: any) {
        console.warn(`WARN: Could not fetch nonce for ${tokenAddress}. This token might not support EIP-2612 (permit). Defaulting nonce to 0.`);
    }

    // Fetch the token name for the EIP-712 domain
    let tokenName = "Unknown Token";
    try {
        tokenName = await tokenContract.name();
    } catch (e) {
        console.warn(`Could not fetch name for token ${tokenAddress}. Using default.`);
    }

    // Define the EIP-712 domain separator
    const domain: TypedDataDomain = {
        name: tokenName,
        version: permitStyle === 0 ? '1' : '2', // DAI uses version '1', EIP-2612 uses '2'
        chainId: chainId,
        verifyingContract: tokenAddress,
    };

    // Define the EIP-712 types (DAI vs EIP-2612)
    let types: any;
    let values: any;

    if (permitStyle === 0) {
        // DAI-style permit
        types = {
            Permit: [
                { name: "holder", type: "address" },
                { name: "spender", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
                { name: "allowed", type: "bool" }
            ]
        };
        values = {
            holder: ownerAddress,
            spender: spender,
            nonce: nonce.toString(),
            expiry: deadline.toString(),
            allowed: true
        };
    } else {
        // EIP-2612 permit
        types = {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        };
        values = {
            owner: ownerAddress,
            spender: spender,
            value: amount.toString(),
            nonce: nonce.toString(),
            deadline: deadline.toString(),
        };
    }

    // Sign the typed data
    const signature = await signer.signTypedData(domain, types, values);
    const { v, r, s } = ethers.Signature.from(signature);

    return {
        value: amount,
        nonce: nonce,
        deadline: BigInt(deadline),
        permitStyle: permitStyle,
        v, r, s
    };
};

//depricated
export const getCanoeQuote = async (market: string, params: canoeParams) => {
    const baseURL = `https://canoe.icarus.tools/market/${market}/swap_quote`
    let txData = "0x"
    let recipient = ZeroAddress

    try {
        const response = await axios.post(baseURL, params, {
            timeout: 30000 // 30 second timeout
        })

        txData = response.data.candidateTrade.data
        recipient = response.data.candidateTrade.to

    }
    catch (error: any) {
        // Error will be caught and logged by caller if needed
        // Return empty data on error
    }

    return { txData, recipient, }
}

export const getRawCanoeQuote = async (market: string, params: canoeParams) => {
    const baseURL = `https://canoe.icarus.tools/market/${market}/swap_quote`
    // console.log("Getting swap quote...", baseURL)
    //console.log(params)

    let digest = {}

    try {
        const response = await axios.post(baseURL, params, {
            timeout: 30000 // 30 second timeout
        })
        digest = response.data


    }
    catch (error: any) {
        // Error will be caught and logged by caller if needed
        // Return empty digest on error
    }

    return digest
}


export const constructCanoeSwap = async (
    signer: Signer,
    params: canoeParams,
    RainbwoDomainInfo: RainbwoDomainInfo,
    txType: RainbowTxType,
    market: MarketId,
    chainId?: number,//required to be set to currentNetwork by `await ethers.provider.getNetwork()` for testing
    retry?: boolean

): Promise<SimResult> => {

    let readyTx: SimResult = {
        success: false,
        market: market,
        txData: "0x"
    }


    //get quote
    const digest: SwapQuoteResponse = await getRawCanoeQuote(market, params) as SwapQuoteResponse
    //console.log(digest)

    if (!(digest && digest.candidateTrade && digest.candidateTrade.data && digest.candidateTrade.to)) {
        //console.error("Invalid API response structure:", digest);
        //throw new Error("Invalid data from Canoe API");
    } else {
        if (chainId == undefined) {
            chainId = digest.chainId
        }
        readyTx = await simulateSwap(signer, RainbwoDomainInfo, txType, market, digest, chainId)
    }

    if (readyTx.success) {
        console.log("Successful route found for ", market)
    } else {
        if (retry) {

            //try more routers until we have a success tx
            const markets = Object.values(MarketId)
            let i = 0
            while (!readyTx.success && i < markets.length) {
                const tryMarket = markets[i]
                console.log("")

                console.log("Retrying with ", tryMarket)

                //get quote
                const newDigest: SwapQuoteResponse = await getRawCanoeQuote(tryMarket, params) as SwapQuoteResponse

                if (!(newDigest && newDigest.candidateTrade && newDigest.candidateTrade.data && newDigest.candidateTrade.to)) {
                    //console.error("Invalid API response structure:", newDigest);
                    //throw new Error("Invalid data from Canoe API");
                } else {
                    if (chainId == undefined) {
                        chainId = digest.chainId
                    }
                    readyTx = await simulateSwap(signer, RainbwoDomainInfo, txType, tryMarket, newDigest, chainId)
                }
                i++
            }

        }
    }
    return readyTx
}


export const simulateSwap = async (signer: Signer, RainbwoDomainInfo: RainbwoDomainInfo, txType: RainbowTxType, market: MarketId, digest: SwapQuoteResponse, chainId: number): Promise<SimResult> => {

    //format input amount
    const inputAmount = parseUnits(digest.inAmount, digest.inToken.decimals);
    // console.log("input amount: ", inputAmount)

    const swapCallDataFromApi = digest.candidateTrade.data;
    const routerAddrFromApi = digest.candidateTrade.to;

    const swapCallDataHash = keccak256(swapCallDataFromApi);
    // Set approvalTarget to target for now (warrant system not fully implemented)
    const approvalTarget = routerAddrFromApi;

    const dataHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'address', 'bytes32', 'uint256', 'uint256'],
            [digest.inToken.address, digest.outToken.address, routerAddrFromApi, approvalTarget, swapCallDataHash, inputAmount, 0]
        )
    );

    const clientCurrentTimeSec = Math.floor(Date.now() / 1000);
    const warrantValidAfter = BigInt(clientCurrentTimeSec - 300); // 5 minutes ago
    const warrantValidBefore = BigInt(clientCurrentTimeSec + 3600); // 1 hour from now

    const warrantNonce: bigint = BigInt(await signer.getNonce());

    const verifyingSignerAddress: string = await signer.getAddress();

    const packedValidationData = warrantNonce | (warrantValidBefore << 160n) | (warrantValidAfter << 208n);


    const warrantDomain = {
        name: RainbwoDomainInfo.name,
        version: RainbwoDomainInfo.version,
        chainId: chainId,
        verifyingContract: RainbwoDomainInfo.address,
    };

    const warrantTypes = {
        CanoeWarrant: [
            { name: 'packedValidationData', type: 'uint256' },
            { name: 'dataHash', type: 'bytes32' },
        ],
    };

    const warrantValueToSign = {
        packedValidationData: packedValidationData,
        dataHash: dataHash,
    };


    const warrantSignature = await signer.signTypedData(warrantDomain, warrantTypes, warrantValueToSign);
    const warrant = {
        nonce: warrantNonce,
        validBefore: warrantValidBefore,
        validAfter: warrantValidAfter,
        verifyingSigner: verifyingSignerAddress,
        signature: warrantSignature,
    };




    //sim tx
    const Rainbow = OkuRouter__factory.connect(RainbwoDomainInfo.address, signer);


    try {
        let SimResult: SimResult = {
            success: false,
            market: market,
            txData: "0x"
        }

        if (txType === RainbowTxType.TOKEN2TOKEN_PERMIT) {
            //format permit data
            const permitData = await generatePermitSignature(
                signer,
                chainId,
                digest.inToken.address,
                inputAmount,        // Raw BigInt amount
                RainbwoDomainInfo.address
            );

            //simulate tx, this will revert if the inputs are bad
            await Rainbow.connect(signer)["fillQuoteTokenToTokenWithPermit"].staticCall(
                digest.inToken.address,
                digest.outToken.address,
                digest.candidateTrade.to,
                approvalTarget,
                digest.candidateTrade.data,
                inputAmount,
                0n,
                verifyingSignerAddress, // recipient - the signer's own address
                permitData,
                warrant
            )

            //generate tx data so we can send the tx since it did not revert if we have reached this point
            const txData = await Rainbow.connect(signer).fillQuoteTokenToTokenWithPermit.populateTransaction(
                digest.inToken.address,
                digest.outToken.address,
                digest.candidateTrade.to,
                approvalTarget,
                digest.candidateTrade.data,
                inputAmount,
                0n,
                verifyingSignerAddress, // recipient - the signer's own address
                permitData,
                warrant
            )

            SimResult.success = true
            SimResult.txData = txData.data
        }

        if (txType === RainbowTxType.TOKEN2ETH_PERMIT) {
            //format permit data
            const permitData = await generatePermitSignature(
                signer,
                chainId,
                digest.inToken.address,
                inputAmount,        // Raw BigInt amount
                RainbwoDomainInfo.address
            );

            //simulate tx, this will revert if the inputs are bad
            await Rainbow.connect(signer)["fillQuoteTokenToEthWithPermit"].staticCall(
                digest.inToken.address,
                digest.candidateTrade.to,
                approvalTarget,
                digest.candidateTrade.data,
                inputAmount,
                0n,
                verifyingSignerAddress, // recipient - the signer's own address
                permitData,
                warrant
            )

            //generate tx data so we can send the tx since it did not revert if we have reached this point
            const txData = await Rainbow.connect(signer).fillQuoteTokenToEthWithPermit.populateTransaction(
                digest.inToken.address,
                digest.candidateTrade.to,
                approvalTarget,
                digest.candidateTrade.data,
                inputAmount,
                0n,
                verifyingSignerAddress, // recipient - the signer's own address
                permitData,
                warrant
            )

            SimResult.success = true
            SimResult.txData = txData.data
        }
        if (SimResult.success) {
            console.log("SUCCESS WITH ", market)
        }
        return SimResult

    } catch (error: any) {
        console.error("TRANSACTION SIMULATION FAILED or error during preparation.");
        if (error.code) {
            console.error(`Error Code: ${error.code}`); // E.g., CALL_EXCEPTION, UNPREDICTABLE_GAS_LIMIT
        }

        if (error.reason) {
            console.error(`Revert Reason (from error.reason): ${error.reason}`);
        }

        if (error.data && error.data !== "0x") {
            //console.error(`Revert Data (from error.data): ${error.data}`);
            try {
                const decodedError = Rainbow.interface.parseError(error.data);
                if (decodedError) {
                    console.error(`Decoded Custom Error: ${decodedError.name}(${decodedError.args.join(', ')})`);
                } else {
                    if (error.data.startsWith("0x08c379a0")) {
                        const reasonString = AbiCoder.defaultAbiCoder().decode(['string'], '0x' + error.data.substring(10))[0];
                        console.error(`Decoded string revert reason: ${reasonString}`);
                    } else {
                        console.error("Could not decode error data using OkuRouter interface, or it's not a custom error.");
                    }
                }
            } catch (parseErr) {
                console.error("Failed to parse error data:", parseErr);
            }
        }

        // If the error object has a 'transaction' or 'receipt' property (less common for staticCall errors but possible)
        if (error.transaction) {
            console.error("Associated transaction (if any):", error.transaction);
        }

        let readyTx: SimResult = {
            success: false,
            market: market,
            txData: "0x"
        }

        return readyTx
    }



}

// Constants
export const OKU_ROUTER_EIP712_NAME = "Oku Router";
export const OKU_ROUTER_EIP712_VERSION = "1.0";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const BACKEND_WARRANT_SIGNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

// Network and token setup
export interface NetworkConfig {
    rainbowAddress: string;
    ownerAddr: string;
    usdcAddress: string;
    wethAddress: string;
    usdcWhale: string;
    forkUrl: string;
}

export const getNetworkConfig = (networkName: string): NetworkConfig => {
    // Get centralized network config
    const centralConfig = NETWORK_CONFIGS[networkName];

    if (!centralConfig) {
        // Default to Optimism config if network not found
        console.warn(`⚠️  Network ${networkName} not found in centralized config, defaulting to Optimism`);
        return {
            rainbowAddress: "0x80dCD2C737cAFE9f86559bBCed9938eFfB7f7D1A",
            ownerAddr: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
            usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            wethAddress: "0x4200000000000000000000000000000000000006",
            usdcWhale: "0xc0E17AD342AFABD36b3971F8305fF147006962ae",
            forkUrl: process.env.OP_URL!
        };
    }

    // Map centralized config to local NetworkConfig format. The live OkuRouter
    // address comes from the on-disk registry (`deployments/<network>.json`);
    // if no deployment exists yet, fall back to the zero address so callers can
    // still drive the test harness against a freshly deployed router they'll
    // attach below.
    const liveRouter =
        getCurrentAddress(networkName, "OkuRouter") ?? ZERO_ADDRESS;
    return {
        rainbowAddress: liveRouter,
        ownerAddr: centralConfig.ownerAddress,
        usdcAddress: centralConfig.usdcAddress || "0x0000000000000000000000000000000000000000",
        wethAddress: centralConfig.wethAddress,
        usdcWhale: networkName === "op" ? "0xc0E17AD342AFABD36b3971F8305fF147006962ae" : "0x0000000000000000000000000000000000000000", // Only known for Optimism
        forkUrl: centralConfig.rpcUrl || process.env.OP_URL!
    };
};

export interface TestSetup {
    testSigner: Signer;
    contractOwner: Signer;
    mainnet: boolean;
    Rainbow: OkuRouter;
    USDC: IERC20;
    WETH: IERC20;
    config: NetworkConfig;
}

export const setupTestEnvironment = async (): Promise<TestSetup> => {
    const networkName = hre.network.name;
    const config = getNetworkConfig(networkName);
    let mainnet = true;
    let testSigner: Signer;
    let contractOwner: Signer;

    if (networkName === "hardhat" || networkName === "localhost") {
        mainnet = false;
        
        // Reset to fork with recent block
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: config.forkUrl,
                    blockNumber: undefined // Use latest block, or specify a recent block number
                },
            }],
        });
        
        const blockNumber = await hre.ethers.provider.getBlockNumber();
        const chainId = (await hre.ethers.provider.getNetwork()).chainId;
        console.log(`✅ Reset to fork, block number: ${blockNumber}, chainId: ${chainId}`);
        
        const signers = await hre.ethers.getSigners();
        testSigner = signers[0];
        console.log("Test signer address:", await testSigner.getAddress());
        
        // Impersonate contract owner
        contractOwner = await hre.ethers.getSigner(config.ownerAddr);
        await setBalance(config.ownerAddr, hre.ethers.parseEther("1000"));
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [config.ownerAddr],
        });
        console.log("Impersonated contract owner:", config.ownerAddr);
        
    } else {
        const signers = await hre.ethers.getSigners();
        testSigner = signers[0];
        contractOwner = signers[0];
        
        const testAddress = await testSigner.getAddress();
        
        if (testAddress.toLowerCase() !== config.ownerAddr.toLowerCase()) {
            console.warn(`⚠️  Warning: Expected testing account ${config.ownerAddr}, got ${testAddress}`);
        }
    }

    // Initialize contracts
    const USDC = IERC20__factory.connect(config.usdcAddress, testSigner);
    const WETH = IERC20__factory.connect(config.wethAddress, testSigner);
    const Rainbow = OkuRouter__factory.connect(config.rainbowAddress, testSigner);

    // Fund test account if on fork
    if (!mainnet) {
        await fundTestAccountWithUSDC(testSigner, USDC, config);
    } else {
        // Skip balance check for live networks - let the test handle insufficient balance errors
        // await checkLiveAccountBalances(testSigner, USDC, WETH);
    }

    return {
        testSigner,
        contractOwner,
        mainnet,
        Rainbow,
        USDC,
        WETH,
        config
    };
};

const fundTestAccountWithUSDC = async (testSigner: Signer, USDC: IERC20, config: NetworkConfig) => {
    console.log("\n💰 Funding test account with USDC...");
    
    const testAddress = await testSigner.getAddress();
    
    // Impersonate USDC whale
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [config.usdcWhale],
    });
    await setBalance(config.usdcWhale, hre.ethers.parseEther("1000"));
    
    const whaleUSDC = IERC20__factory.connect(config.usdcAddress, await hre.ethers.getSigner(config.usdcWhale));
    
    // Transfer USDC to test account
    const transferAmount = hre.ethers.parseUnits("1000", 6);
    await whaleUSDC.transfer(testAddress, transferAmount);
    
    const testBalance = await USDC.balanceOf(testAddress);
    console.log(`✅ Test account USDC balance: ${formatUnits(testBalance, 6)} USDC`);
    
    await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [config.usdcWhale],
    });
};

const checkLiveAccountBalances = async (testSigner: Signer, USDC: IERC20, WETH: IERC20) => {
    const testAddress = await testSigner.getAddress();
    const usdcBalance = await USDC.balanceOf(testAddress);

    const requiredAmount = parseUnits("5", 6);
    if (usdcBalance < requiredAmount) {
        throw new Error(`Insufficient USDC balance. Need: ${formatUnits(requiredAmount, 6)} USDC, Have: ${formatUnits(usdcBalance, 6)} USDC`);
    }
};

// Generic quote fetching
export const getRouterQuote = async (market: string, params: any, baseUrl?: string): Promise<any> => {
    const url = baseUrl || `http://localhost:3333/market/${market}/swap_quote`;

    try {
        const response = await axios.post(url, params, {
            timeout: 30000 // 30 second timeout
        });
        return response.data;
    } catch (error: any) {
        // Error will be caught and logged by caller if needed
        throw error;
    }
};

export const getRainbowExecution = async (
    coupon: Coupon,
    market: string,
    signingRequest?: any,
    baseUrl?: string
): Promise<RainbowExecutionInfo> => {
    const url = baseUrl || `http://localhost:3333/market/${market}/execution_information`;

    const requestBody: ExecutionRequest = {
        coupon: coupon,
        useOkuRouter: true,
        signingRequest: signingRequest
    };

    try {
        const response = await axios.post(url, requestBody, {
            timeout: 30000 // 30 second timeout
        });
        const executionInfo = response.data as RainbowExecutionInfo;
        return executionInfo;
    } catch (error: any) {
        // Error will be caught and logged by caller if needed
        throw error;
    }
};

// Contract interaction helpers
export const ensureTargetIsWhitelisted = async (ownerSigner: Signer, Rainbow: OkuRouter, targetAddress: string) => {
    // Skip validation for zero address (native ETH)
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    if (targetAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        return;
    }

    const isWhitelisted = await Rainbow.swapTargets(targetAddress);

    if (isWhitelisted) {
        return;
    }

    try {
        const tx = await Rainbow.connect(ownerSigner).updateSwapTargets(targetAddress, true);
        await tx.wait();

        const nowWhitelisted = await Rainbow.swapTargets(targetAddress);
        if (!nowWhitelisted) {
            throw new Error("Target whitelisting verification failed");
        }
    } catch (error: any) {
        console.error("❌ Failed to whitelist target:", error.message);
        throw error;
    }
};

export const ensureSignerIsWhitelisted = async (ownerSigner: Signer, Rainbow: OkuRouter, signerAddress: string) => {
    const isWhitelisted = await Rainbow.validSigners(signerAddress);

    if (isWhitelisted) {
        return;
    }

    try {
        const tx = await Rainbow.connect(ownerSigner).updateValidSigner(signerAddress, true);
        await tx.wait();

        const nowWhitelisted = await Rainbow.validSigners(signerAddress);
        if (!nowWhitelisted) {
            throw new Error("Signer whitelisting verification failed");
        }
    } catch (error: any) {
        console.error("❌ Failed to whitelist signer:", error.message);
        throw error;
    }
};

export const handleERC20Approval = async (
    signer: Signer,
    token: IERC20,
    spenderAddress: string,
    amount: BigNumberish,
    tokenSymbol: string = "TOKEN",
    tokenDecimals: number = 18
) => {
    const signerAddress = await signer.getAddress();

    const currentAllowance = await token.allowance(signerAddress, spenderAddress);

    if (currentAllowance >= BigInt(amount.toString())) {
        return;
    }

    try {
        const approveTx = await token.connect(signer).approve(spenderAddress, amount);
        await approveTx.wait();

        // Add small delay to ensure state propagation on mainnet
        await new Promise(resolve => setTimeout(resolve, 1000));

        const newAllowance = await token.allowance(signerAddress, spenderAddress);

        if (newAllowance < BigInt(amount.toString())) {
            throw new Error(`Approval failed: expected ${formatUnits(amount, tokenDecimals)}, got ${formatUnits(newAllowance, tokenDecimals)}`);
        }
    } catch (error: any) {
        console.error(`❌ Approval failed: ${error.message}`);
        throw error;
    }
};

// Transaction execution and analysis
export interface ExtractedTargets {
    target: string;
    approvalTarget: string | null;
    functionName: string;
}

export const extractTargetFromRainbowData = (txData: string): string => {
    const targets = extractTargetsFromRainbowData(txData);
    return targets.target;
};

export const extractTargetsFromRainbowData = (txData: string): ExtractedTargets => {
    try {
        const rainbowInterface = OkuRouter__factory.createInterface();
        const decoded = rainbowInterface.parseTransaction({ data: txData });

        if (!decoded) {
            throw new Error("Failed to decode transaction data");
        }

        // Handle different Rainbow Router function signatures
        if (decoded.name === "fillQuoteTokenToToken" ||
            decoded.name === "fillQuoteTokenToTokenWithPermit") {
            // For token-to-token functions, target is the 3rd parameter (index 2), approvalTarget is 4th (index 3)
            const target = decoded.args[2] as string;
            const approvalTarget = decoded.args[3] as string;
            if (!target || target === "0x0000000000000000000000000000000000000000") {
                throw new Error(`Invalid target address extracted: ${target}`);
            }
            return { target, approvalTarget, functionName: decoded.name };
        } else if (decoded.name === "fillQuoteEthToToken") {
            // ETH->Token: target is the 2nd parameter (index 1), NO approvalTarget (ETH doesn't require approval)
            const target = decoded.args[1] as string;
            if (!target || target === "0x0000000000000000000000000000000000000000") {
                throw new Error(`Invalid target address extracted: ${target}`);
            }
            return { target, approvalTarget: null, functionName: decoded.name };
        } else if (decoded.name === "fillQuoteTokenToEth" ||
                   decoded.name === "fillQuoteTokenToEthWithPermit") {
            // Token->ETH: target is the 2nd parameter (index 1), approvalTarget is 3rd (index 2)
            const target = decoded.args[1] as string;
            const approvalTarget = decoded.args[2] as string;
            if (!target || target === "0x0000000000000000000000000000000000000000") {
                throw new Error(`Invalid target address extracted: ${target}`);
            }
            return { target, approvalTarget, functionName: decoded.name };
        }

        throw new Error(`Unsupported function: ${decoded.name}`);
    } catch (error: any) {
        throw new Error(`Failed to extract target from Rainbow data: ${error.message}`);
    }
};

export const rebuildTransactionDataWithModifiedWarrant = (originalTxData: string, modifiedWarrant: any): string => {
    try {
        const rainbowInterface = OkuRouter__factory.createInterface();
        const decoded = rainbowInterface.parseTransaction({ data: originalTxData });
        
        if (decoded?.name === "fillQuoteTokenToToken") {
            const [sellToken, buyToken, target, approvalTarget, swapCallData, sellAmount, feeAmount, recipient, originalWarrant] = decoded.args;

            const newWarrant = {
                nonce: originalWarrant.nonce || modifiedWarrant.nonce || "0",
                validBefore: originalWarrant.validBefore || modifiedWarrant.validBefore || "0",
                validAfter: originalWarrant.validAfter || modifiedWarrant.validAfter || "0",
                verifyingSigner: modifiedWarrant.verifyingSigner,
                signature: originalWarrant.signature || modifiedWarrant.signature || "0x"
            };

            const newTxData = rainbowInterface.encodeFunctionData("fillQuoteTokenToToken", [
                sellToken, buyToken, target, approvalTarget, swapCallData, sellAmount, feeAmount, recipient, newWarrant
            ]);

            console.log(`🔄 Warrant signer changed from ${originalWarrant.verifyingSigner} to ${newWarrant.verifyingSigner}`);
            return newTxData;
        } else if (decoded?.name === "fillQuoteTokenToEth") {
            const [sellToken, target, approvalTarget, swapCallData, sellAmount, feePercentageBasisPoints, recipient, originalWarrant] = decoded.args;

            const newWarrant = {
                nonce: originalWarrant.nonce || modifiedWarrant.nonce || "0",
                validBefore: originalWarrant.validBefore || modifiedWarrant.validBefore || "0",
                validAfter: originalWarrant.validAfter || modifiedWarrant.validAfter || "0",
                verifyingSigner: modifiedWarrant.verifyingSigner,
                signature: originalWarrant.signature || modifiedWarrant.signature || "0x"
            };

            const newTxData = rainbowInterface.encodeFunctionData("fillQuoteTokenToEth", [
                sellToken, target, approvalTarget, swapCallData, sellAmount, feePercentageBasisPoints, recipient, newWarrant
            ]);

            console.log(`🔄 Warrant signer changed from ${originalWarrant.verifyingSigner} to ${newWarrant.verifyingSigner}`);
            return newTxData;
        } else if (decoded?.name === "fillQuoteEthToToken") {
            // Note: fillQuoteEthToToken does NOT have approvalTarget (ETH doesn't require approval)
            const [buyToken, target, swapCallData, feeAmount, recipient, originalWarrant] = decoded.args;

            const newWarrant = {
                nonce: originalWarrant.nonce || modifiedWarrant.nonce || "0",
                validBefore: originalWarrant.validBefore || modifiedWarrant.validBefore || "0",
                validAfter: originalWarrant.validAfter || modifiedWarrant.validAfter || "0",
                verifyingSigner: modifiedWarrant.verifyingSigner,
                signature: originalWarrant.signature || modifiedWarrant.signature || "0x"
            };

            const newTxData = rainbowInterface.encodeFunctionData("fillQuoteEthToToken", [
                buyToken, target, swapCallData, feeAmount, recipient, newWarrant
            ]);

            console.log(`🔄 Warrant signer changed from ${originalWarrant.verifyingSigner} to ${newWarrant.verifyingSigner}`);
            return newTxData;
        } else {
            console.warn(`⚠️ Unknown function ${decoded?.name}, cannot rebuild transaction data`);
            return originalTxData;
        }
    } catch (error: any) {
        console.error("❌ Failed to rebuild transaction data:", error.message);
        console.log("🔄 Falling back to original transaction data");
        return originalTxData;
    }
};

export const executeRainbowTransaction = async (
    txSigner: Signer, 
    trade: any,
    rainbowExecution: RainbowExecutionInfo, 
    originalQuote: any,
    rainbowAddress: string
) => {
    const { to, data, value } = trade;
    const warrant = rainbowExecution.warrant;
    
    if (warrant) {
        console.log("Warrant Signer:", warrant.verifyingSigner);
    } else {
        console.log("No warrant (DEX doesn't use warrant system)");
    }
    
    const inputAmountBN = parseUnits(originalQuote.inAmount, originalQuote.inToken.decimals);
    const signerAddress = await txSigner.getAddress();
    
    // Verify transaction target is Rainbow Router
    if (to.toLowerCase() !== rainbowAddress.toLowerCase()) {
        throw new Error(`Expected Rainbow Router address ${rainbowAddress}, got ${to}`);
    }
    
    console.log(`🔄 Simulating swap transaction... (${(data.length / 2).toLocaleString()} bytes)`);
    
    const txRequest = {
        to: to,
        data: data,
        value: value,
        from: signerAddress
    };
    
    try {
        // Simulate the transaction
        const result = await txSigner.provider!.call(txRequest);
        const gasEstimate = await txSigner.provider!.estimateGas(txRequest);
        console.log(`✅ Swap simulation successful! Estimated gas: ${gasEstimate.toLocaleString()}`);
        
        // Execute the actual transaction
        console.log(`\n🚀 Executing actual swap transaction...`);
        const tx = await txSigner.sendTransaction(txRequest);
        console.log(`📤 Transaction sent: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`✅ Transaction confirmed in block ${receipt!.blockNumber}`);
        console.log(`⛽ Gas used: ${receipt!.gasUsed.toLocaleString()}`);
        
        return {
            success: true,
            result: result,
            gasEstimate: gasEstimate.toString(),
            txHash: tx.hash,
            blockNumber: receipt!.blockNumber,
            gasUsed: receipt!.gasUsed.toString()
        };
        
    } catch (error: any) {
        console.error("❌ Transaction execution failed");
        console.error("Revert reason:", error.reason || error.message);
        console.error("\n=== Tenderly Simulation Data ===");
        console.error("Target:", to);
        console.error("Data:", data);
        console.error("Value:", value);
        console.error("================================\n");
        throw error;
    }
};

// Balance reporting
export const reportBalanceChanges = async (
    testSigner: Signer,
    USDC: IERC20,
    WETH: IERC20,
    initialUsdcBalance: bigint,
    initialWethBalance: bigint,
    originalQuote: any
) => {
    const testAddress = await testSigner.getAddress();
    const finalUsdcBalance = await USDC.balanceOf(testAddress);
    const finalWethBalance = await WETH.balanceOf(testAddress);
    
    const usdcSpent = initialUsdcBalance - finalUsdcBalance;
    const wethReceived = finalWethBalance - initialWethBalance;
    
    console.log(`\n🎉 SWAP COMPLETED SUCCESSFULLY!`);
    console.log(`\n📊 FINAL BALANCES:`);
    console.log(`  USDC: ${formatUnits(finalUsdcBalance, 6)}`);
    console.log(`  WETH: ${formatUnits(finalWethBalance, 18)}`);
    
    console.log(`\n💰 NET CHANGES:`);
    console.log(`  📉 USDC Spent: ${formatUnits(usdcSpent, 6)} (~$${formatUnits(usdcSpent, 6)})`);
    console.log(`  📈 WETH Received: ${formatUnits(wethReceived, 18)}`);
    
    // Calculate approximate USD value
    const wethUsdValue = Number(formatUnits(wethReceived, 18)) * (Number(originalQuote.inAmount) / Number(originalQuote.outAmount));
    console.log(`  💵 WETH USD Value: ~$${wethUsdValue.toFixed(2)}`);
    
    return {
        usdcSpent: formatUnits(usdcSpent, 6),
        wethReceived: formatUnits(wethReceived, 18),
        wethUsdValue: wethUsdValue.toFixed(2)
    };
};