import { promises as fs } from "fs";
import {
  ethers,
  ZeroAddress // Ethers v6 ZeroAddress
} from "ethers";
import type {
  Signer,
  Provider,
  Contract,
  AddressLike,
  BigNumberish,
  BytesLike,
  Signature,
  TransactionResponse, // For type hinting deployment tx
  Overrides, // For transaction overrides like gas price
  ContractTransactionResponse // For type hinting contract write txs
} from "ethers";

import hre from "hardhat";


// Import relevant TypeChain types (adjust paths as needed)
import {
  type IERC20,
  type IWETH,
  type IDAI,
  type IERC20Metadata,
  type IERC2612,
  type IERC2612Extension, // Assuming this interface exists for _nonces
  type OkuRouter,
  OkuRouter__factory,
  IDAI__factory,
  IWETH__factory
} from "../../typechain-types";

// Keep your types, potentially update Address/Hex if needed, or use ethers types
import { DomainParam, MessageParam, Quote } from "../types";

// --- Constants remain the same ---
const debug = false;
const showGasUsage = false;
const MAINNET_ADDRESS_1INCH = "0x1111111254fb6c44bac0bed2854e76f90643097d";
const MAINNET_ADDRESS_0X = "0xdef1c0ded9bec7f1a1670819833240f027b25eff";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const DAI_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f";
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000"; // Zero address for native ETH
const ENS_ADDRESS = "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72";
const RAD_ADDRESS = "0x31c8eacbffdd875c74b94b077895bd78cf1e64a3";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const INCH_ADDRESS = "0x111111111117dc0aa78b770fa6a738034120c302";
const WNXM_ADDRESS = "0x0d438f3b5175bebc262bf23753c1e53d03432bde";
const VSP_ADDRESS = "0x1b40183efb4dd766f11bda7a7c3ad8982e998421";
const LQTY_ADDRESS = "0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d";
const TORN_ADDRESS = "0x77777feddddffc19ff86db637967013e6c6a116c";
const BAL_ADDRESS = "0xba100000625a3754423978a60c9317c58a424e3d";
const OPIUM_ADDRESS = "0x888888888889c00c67689029d7856aac1065ec11";
const MIST_ADDRESS = "0x88acdd2a6425c3faae4bc9650fd7e27e0bebb7ab";
const TRIBE_ADDRESS = "0xc7283b66eb1eb5fb86327f08e1b5816b0720212b";
const FEI_ADDRESS = "0x956f47f50a910163d8bf957cf5846d573e7f87ca";

// --- bigIntReplacer remains the same ---
function bigIntReplacer(key: string, value: any): any {
  if (typeof value === "bigint") {
    // Keep standard serialization for ethers if needed, or use custom if required elsewhere
    return value.toString(); // Standard toString() is often sufficient
    // return value.toString() + 'n'; // Keep if your custom parsing needs the 'n'
  }
  return value;
}

// --- Logger remains the same ---
const Logger = {
  info(...args: any[]) {
    console.info(...args);
  },
  log(...args: any[]) {
    debug && console.log(...args);
  },
};

// --- Refactored Functions ---

/**
 * Gets the ERC20 balance of a vault/address.
 * @param tokenAddress The address of the ERC20 token.
 * @param vaultAddress The address of the vault/owner.
 * @param provider An ethers Provider instance.
 * @returns Promise<bigint> The balance.
 */
const getVaultBalanceForToken = async (
  tokenAddress: AddressLike,
  vaultAddress: AddressLike,
  provider: Provider, // Accept provider directly
): Promise<bigint> => {
  // Use ethers.Contract for read-only calls with a provider
  const tokenContract = new ethers.Contract(tokenAddress.toString(), [
    // Minimal ABI for balanceOf
    "function balanceOf(address owner) view returns (uint256)"
  ], provider) as unknown as IERC20; // Cast to TypeChain type
  return tokenContract.balanceOf(vaultAddress);
};

/**
 * Initializes contracts, signer, and utility functions using Hardhat environment.
 * This function NEEDS hre to access the Hardhat ethers plugin.
 */
const init = async () => {
  // hre is necessary here to access the Hardhat ethers plugin features
  const hre = await import("hardhat"); // Dynamically import hre if preferred

  const [signer] = await hre.ethers.getSigners(); // Use ethers signers
  const provider = hre.ethers.provider; // Get provider from Hardhat ethers

  Logger.log("User address", signer.address);

  // Attach to existing contracts
  const wethContract = IWETH__factory.connect(WETH_ADDRESS, signer);
  const daiContract = IDAI__factory.connect(DAI_ADDRESS, signer);

  // Deploy OkuRouter using ethers v6
  // Note: Pass constructor args if any, then overrides
  const okuRouterInstance = await new OkuRouter__factory(signer).deploy("Oku Router", "1.0")
  await okuRouterInstance.waitForDeployment(); // Wait for deployment confirmation
  const instanceAddress = await okuRouterInstance.getAddress();
  Logger.log("Contract address", instanceAddress);

  // Perform write operations using connect(signer)
  let tx: ContractTransactionResponse;
  tx = await okuRouterInstance.connect(signer).updateSwapTargets(
    MAINNET_ADDRESS_1INCH,
    true,
  );
  await tx.wait(); // Wait for transaction confirmation

  tx = await okuRouterInstance.connect(signer).updateSwapTargets(
    MAINNET_ADDRESS_0X,
    true,
  );
  await tx.wait();

  tx = await okuRouterInstance.connect(signer).updateValidSigner(ZeroAddress, true);
  await tx.wait();

  // Utility functions using the provider instance
  const getEthVaultBalance = async () => provider.getBalance(instanceAddress);
  const getSignerBalance = async () => provider.getBalance(signer.address);

  return {
    getSignerBalance,
    daiContract,
    getEthVaultBalance,
    okuRouterInstance,
    signer, // Return the ethers Signer
    wethContract,
    provider, // Return the ethers Provider
  };
};

// --- EIP-712 and Permit Logic Refactoring ---

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const EIP712_DOMAIN_TYPE_NO_VERSION = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const EIP2612_TYPE = { // Use object for ethers v6 types
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ]
};

const PERMIT_ALLOWED_TYPE = { // Use object for ethers v6 types (DAI style)
  Permit: [
    { name: "holder", type: "address" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "allowed", type: "bool" },
  ]
};

/**
 * Tries to determine the EIP-2612 permit version ("1", "2", etc., or null).
 * @param tokenAddress Address of the ERC20 token.
 * @param provider Ethers Provider.
 * @returns Promise<string | null> The version string or null.
 */
const getPermitVersion = async (
  tokenAddress: AddressLike,
  provider: Provider, // Accept provider
): Promise<string | null> => {
  const tokenContract = new ethers.Contract(tokenAddress.toString(), [
    // Minimal ABI for version() and DOMAIN_SEPARATOR()
    "function version() view returns (string)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)"
  ], provider) as unknown as IERC2612; // Cast to a suitable TypeChain type

  const name = await new ethers.Contract(tokenAddress.toString(), ["function name() view returns (string)"], provider).name();
  const { chainId } = await provider.getNetwork();

  try {
    const version = await tokenContract.version();
    // Basic check if version looks valid (e.g., not empty)
    if (version && typeof version === 'string') {
      return version;
    }
    // Fall through if version() reverts or returns non-string/empty
  } catch (e) {
    // version() might not exist or revert, try DOMAIN_SEPARATOR approach
  }

  // Try DOMAIN_SEPARATOR approach for version "1" guessing
  const versionGuess = "1";
  try {
    const domainSeparator = await tokenContract.DOMAIN_SEPARATOR();

    // Reconstruct the domain separator locally for version "1"
    const domain: ethers.TypedDataDomain = {
      name: name,
      version: versionGuess,
      chainId: chainId,
      verifyingContract: await ethers.resolveAddress(tokenAddress, provider),
    };
    const reconstructedSeparator = ethers.TypedDataEncoder.hashDomain(domain);

    if (domainSeparator === reconstructedSeparator) {
      return versionGuess;
    }
  } catch (_) {
    // DOMAIN_SEPARATOR() might not exist or revert
    // Handle known edge cases without DOMAIN_SEPARATOR or version()
    const lowerCaseAddress = (await ethers.resolveAddress(tokenAddress, provider)).toLowerCase();
    if (
      [TORN_ADDRESS, WNXM_ADDRESS, VSP_ADDRESS]
        .map((t) => t.toLowerCase())
        .includes(lowerCaseAddress)
    ) {
      return "1"; // Assume version 1 for these specific tokens
    }
    return null; // Cannot determine version
  }

  return null; // No version found
};

/**
 * Gets the permit nonce for a token owner. Handles DAI-style and standard EIP-2612 nonces.
 * @param tokenAddress Address of the ERC20 token.
 * @param ownerAddress Address of the token owner.
 * @param provider Ethers Provider.
 * @returns Promise<bigint> The nonce.
 */
const getNonces = async (
  tokenAddress: AddressLike,
  ownerAddress: AddressLike,
  provider: Provider, // Accept provider
): Promise<bigint> => {
  const resolvedTokenAddress = await ethers.resolveAddress(tokenAddress, provider);
  const resolvedOwnerAddress = await ethers.resolveAddress(ownerAddress, provider);
  const isDaiStylePermit = resolvedTokenAddress.toLowerCase() === DAI_ADDRESS.toLowerCase();

  try {
    if (isDaiStylePermit) {
      const tokenContract = new ethers.Contract(resolvedTokenAddress, [
        // Minimal DAI ABI for nonces
        "function nonces(address owner) view returns (uint256)"
      ], provider) as unknown as IDAI;
      return await tokenContract.nonces(resolvedOwnerAddress);
    } else {
      // Try standard EIP-2612 nonces() first
      try {
        const tokenContractStd = new ethers.Contract(resolvedTokenAddress, [
          "function nonces(address owner) view returns (uint256)"
        ], provider) as unknown as IERC2612;
        return await tokenContractStd.nonces(resolvedOwnerAddress);
      } catch (e) {
        // Fallback to _nonces() if nonces() doesn't exist (less common now)
        const tokenContractExt = new ethers.Contract(resolvedTokenAddress, [
          "function _nonces(address owner) view returns (uint256)" // Check your exact interface name
        ], provider) as unknown as IERC2612Extension; // Use appropriate interface
        return await tokenContractExt._nonces(resolvedOwnerAddress);
      }
    }
  } catch (e) {
    // If nonces call fails for any reason, assume nonce is 0
    Logger.log(`Could not fetch nonce for ${resolvedTokenAddress}, assuming 0:`, e);
    return 0n;
  }
};


export type PermitData = {
  value: bigint,
  nonce: bigint,
  deadline: bigint,
  permitStyle: 0 | 1 | 2,  // 0 = DAI, 1 = EIP-2612, 2 = PERMIT_2
  v: bigint,
  r: string,
  s: string
}

export type WarrantData = {
  nonce: string,
  validBefore: string,
  validAfter: string,
  verifyingSigner: string,
  signature: string
}
/**
 * Creates an EIP-2612 or DAI-style permit signature.
 * @param signer The ethers Signer to sign the permit.
 * @param tokenAddress Address of the token contract.
 * @param spenderAddress Address of the spender being approved.
 * @param value The amount to approve (for EIP-2612). Use ethers.MaxUint256 for max approval.
 * @param deadline Unix timestamp deadline for the permit.
 * @returns Promise<{ r: string; s: string; v: number; deadline: bigint; nonce: bigint; permitStyle: 0 | 1 | 2 }> The signature components and permit details.
 */
async function signPermit(
  signer: Signer, // Accept the signer directly
  tokenAddress: AddressLike,
  spenderAddress: AddressLike,
  value: BigNumberish,
  deadline: BigNumberish,
) {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Signer must be connected to a provider.");
  }
  const resolvedTokenAddress = await ethers.resolveAddress(tokenAddress, provider);
  const ownerAddress = await signer.getAddress();
  const { chainId } = await provider.getNetwork();

  const tokenContract = new ethers.Contract(resolvedTokenAddress, [
    // Minimal ABI for name
    "function name() view returns (string)"
  ], provider) as unknown as IERC20Metadata;

  const isDaiStyle = resolvedTokenAddress.toLowerCase() === DAI_ADDRESS.toLowerCase();
  const permitStyle: 0 | 1 | 2 = isDaiStyle ? 0 : 1; // 0 = DAI, 1 = EIP-2612 (default for this function)

  const [tokenName, version, nonce] = await Promise.all([
    tokenContract.name(),
    getPermitVersion(resolvedTokenAddress, provider),
    getNonces(resolvedTokenAddress, ownerAddress, provider),
  ]);

  const domain: ethers.TypedDataDomain = {
    name: tokenName,
    chainId: chainId,
    verifyingContract: resolvedTokenAddress,
  };
  if (version) {
    domain.version = version; // Add version if determined
  }

  let message: Record<string, any>;
  let types: Record<string, ethers.TypedDataField[]>;
  if (isDaiStyle) {

    types = PERMIT_ALLOWED_TYPE;
    message = {
      holder: ownerAddress,
      spender: spenderAddress,
      nonce: nonce, // Use fetched nonce
      expiry: deadline, // DAI uses 'expiry'
      allowed: true, // DAI uses boolean 'allowed'
    };
  } else {
    types = EIP2612_TYPE;
    message = {
      owner: ownerAddress,
      spender: spenderAddress,
      value: value, // EIP-2612 uses 'value'
      nonce: nonce, // Use fetched nonce
      deadline: deadline, // EIP-2612 uses 'deadline'
    };
  }

  // Sign the typed data using the provided signer
  const signature = await signer.signTypedData(domain, types, message);

  // Parse the signature using ethers
  const sig = ethers.Signature.from(signature);

  return {
    value: BigInt(value),
    r: sig.r,
    s: sig.s,
    v: BigInt(sig.v), // v is already normalized by ethers
    deadline: BigInt(deadline), // Return deadline as BigInt
    nonce: BigInt(nonce), // Return nonce as BigInt
    permitStyle,
    // value: BigInt(value), // Optionally return value if needed elsewhere
  } as PermitData;
}


/**
 * Reads a JSON quote file.
 */
async function getQuoteFromFile(
  dir: string,
  source: string,
  tradeType: string,
  inputAsset: string,
  outputAsset: string,
  amount: string,
  feePercentageBasisPoints: string,
): Promise<Quote> {
  const fileName = `${dir}/${source}-${tradeType}-${inputAsset}-${outputAsset}-${amount}-${feePercentageBasisPoints}.json`;
  const data = await fs.readFile(fileName, 'utf-8'); // Specify encoding
  // Need to parse BigInts correctly if using the 'n' suffix
  const quote: Quote = JSON.parse(data, (key, value) => {
    if (typeof value === 'string' && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });
  return quote;
}

export const hardhat_mine_timed = async (blocks: number, interval: number) => {
  await hre.network.provider.send("hardhat_mine", [("0x" + blocks.toString(16)), ("0x" + interval.toString(16))])
  return
}


// --- Exports ---
export {
  // Constants
  showGasUsage,
  BAL_ADDRESS,
  DAI_ADDRESS,
  ETH_ADDRESS,
  FEI_ADDRESS,
  INCH_ADDRESS,
  LQTY_ADDRESS,
  MIST_ADDRESS,
  OPIUM_ADDRESS,
  RAD_ADDRESS,
  TORN_ADDRESS,
  TRIBE_ADDRESS,
  ENS_ADDRESS,
  USDC_ADDRESS,
  VSP_ADDRESS,
  WETH_ADDRESS,
  WNXM_ADDRESS,
  MAINNET_ADDRESS_1INCH,
  MAINNET_ADDRESS_0X,
  ZeroAddress, // Export ethers ZeroAddress

  // Functions
  getQuoteFromFile,
  getVaultBalanceForToken,
  init,
  Logger,
  signPermit,
  getNonces, // Export if needed externally
  getPermitVersion, // Export if needed externally

  // Helpers
  bigIntReplacer,
};