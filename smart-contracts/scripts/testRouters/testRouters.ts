/**
 * testRouters.ts
 *
 * Generic Router Testing Script for All Networks
 * Consolidates testRoutersOP.ts, testRoutersBase.ts, and testRoutersWorldchain.ts
 * into a single configurable script.
 *
 * Pulls all configuration from networkConfig.ts and supports any network
 * via hardhat's --network flag.
 *
 * Test Order (for new chain onboarding):
 * 1. Native → USDC (establishes USDC balance from native)
 * 2. Native → WETH (establishes WETH balance)
 * 3. USDC → WETH (token to token)
 * 4. WETH → Native (token to native)
 *
 * Usage:
 *   npx hardhat run scripts/testRouters/testRouters.ts --network op
 *   npx hardhat run scripts/testRouters/testRouters.ts --network base
 *   npx hardhat run scripts/testRouters/testRouters.ts --network arbitrum
 */

import { parseUnits } from "ethers";
import hre from "hardhat";
import {
  getRouterQuote,
  getOkuExecution,
  ensureTargetIsWhitelisted,
  handleERC20Approval,
  extractTargetsFromRouterData,
  canoeParams,
} from "../../util/canoeHelper";
import { NETWORK_CONFIGS, NetworkConfig } from "../../util/deploymentConfig";
import { getCurrentAddress } from "../../util/deploymentsRegistry";
import { IERC20__factory, OkuRouter__factory } from "../../typechain-types";
import { Signer } from "ethers";
import { OkuRouter } from "../../typechain-types";
import { IERC20 } from "../../typechain-types/contracts/interfaces/openzeppelin";

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Test amounts (hardcoded small values)
// Designed for ~$2 total native balance budget
// Each swap uses ~$0.25-0.50 worth to allow multiple router tests
const TEST_AMOUNTS = {
  NATIVE_TO_USDC: "0.0001",   // ~$0.35 at $3500/ETH
  NATIVE_TO_WETH: "0.0001",   // ~$0.35 at $3500/ETH
  USDC_TO_WETH: "0.25",       // $0.25 USDC
  WETH_TO_NATIVE: "0.0001",   // ~$0.35 at $3500/ETH
};

// Trade phases (ordered for new chain onboarding)
const TRADE_PHASES = [
  { name: "Native → USDC", inToken: "NATIVE", outToken: "USDC", amount: TEST_AMOUNTS.NATIVE_TO_USDC },
  { name: "Native → WETH", inToken: "NATIVE", outToken: "WETH", amount: TEST_AMOUNTS.NATIVE_TO_WETH },
  { name: "USDC → WETH", inToken: "USDC", outToken: "WETH", amount: TEST_AMOUNTS.USDC_TO_WETH },
  { name: "WETH → Native", inToken: "WETH", outToken: "NATIVE", amount: TEST_AMOUNTS.WETH_TO_NATIVE },
];

// Skip pairs per router (known limitations)
const SKIP_PAIRS: Record<string, string[]> = {
  icecreamswap: ["USDC-NATIVE", "WETH-NATIVE"],  // Doesn't support output to native ETH
  kyberswap: ["NATIVE-WETH", "WETH-NATIVE"],     // Doesn't support native <-> wrapped native swaps
};

// Global skip patterns (apply to all networks)
const GLOBAL_SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /request limit.*exceeded/i, reason: "Rate limit exceeded" },
  { pattern: /429.*1inch/i, reason: "1inch rate limit" },
  { pattern: /no routes found/i, reason: "No routes available" },
  { pattern: /timed out/i, reason: "Backend timeout" },
];

// Network-specific skip patterns (errors that are expected and should be skipped)
// These patterns match against the detailed backend error message
const NETWORK_SKIP_PATTERNS: Record<string, Array<{ pattern: RegExp; reason: string }>> = {
  op: [
    { pattern: /insufficient amount/i, reason: "Insufficient amount for this router" },
    { pattern: /swapping wrapped token to native is disabled/i, reason: "WETH→Native disabled (wrap/unwrap)" },
    { pattern: /request timeout on the free tier/i, reason: "Free tier rate limit" },
  ],
  polygon: [
    { pattern: /OpenOcean external call failed.*TRANSFER_FROM_FAILED/i, reason: "OpenOcean routing bug (routes through WETH without wrapping native POL)" },
  ],
};

interface ParsedError {
  message: string;
  category: TestResult["errorCategory"];
  httpStatus?: number;
  backendError?: string;
}

/**
 * Parse error details from axios/backend errors
 */
function parseError(error: any): ParsedError {
  let message = error.message || "Unknown error";
  let category: TestResult["errorCategory"] = "unknown";
  let httpStatus: number | undefined;
  let backendError: string | undefined;

  // Check if it's an axios error with response data
  if (error.response) {
    httpStatus = error.response.status;
    const responseData = error.response.data;

    if (responseData) {
      // Try to extract the nested error message from our backend
      if (typeof responseData === "object") {
        if (responseData.error) {
          backendError = typeof responseData.error === "string"
            ? responseData.error
            : JSON.stringify(responseData.error);

          // Parse the nested error structure (e.g., "400 response from unizen: {...}")
          const nestedMatch = backendError!.match(/\d+ response from \w+: (.+)/);
          if (nestedMatch) {
            try {
              const nestedJson = JSON.parse(nestedMatch[1]);
              // Try to extract detailed error info from various nested structures
              if (nestedJson.details?.[0]?.fieldViolations?.[0]?.description) {
                // Kyberswap style: { details: [{ fieldViolations: [{ description: "..." }] }] }
                backendError = nestedJson.details[0].fieldViolations[0].description;
              } else if (nestedJson.message) {
                backendError = nestedJson.message;
              } else if (nestedJson.error?.description) {
                backendError = nestedJson.error.description;
              } else if (nestedJson.error && typeof nestedJson.error === "string") {
                // Paraswap style: { error: "Unable to build transaction" }
                backendError = nestedJson.error;
              }
            } catch {
              // Keep the original backendError if parsing fails
            }
          }
        } else if (responseData.message) {
          backendError = responseData.message;
        }
      } else if (typeof responseData === "string") {
        backendError = responseData;
      }
    }
  }

  // Categorize the error based on content
  const errorText = (backendError || message).toLowerCase();

  if (errorText.includes("insufficient amount") || errorText.includes("amount too low")) {
    category = "insufficient_amount";
    message = backendError || "Insufficient amount";
  } else if (errorText.includes("native and wrapped native") ||
             errorText.includes("wrapped token to native") ||
             errorText.includes("invalid pair") ||
             errorText.includes("not allowed")) {
    category = "invalid_pair";
    message = backendError || "Invalid trading pair";
  } else if (errorText.includes("timeout") || errorText.includes("rate limit") || errorText.includes("free tier")) {
    category = "timeout";
    message = backendError || "Request timeout/rate limit";
  } else if (errorText.includes("permit2") || errorText.includes("signingrequest")) {
    category = "permit2";
    message = backendError || message;
  } else if (errorText.includes("simulation failed") || errorText.includes("execution reverted")) {
    category = "simulation";
    message = backendError || message;
  } else if (httpStatus && httpStatus >= 400) {
    category = "backend";
    message = backendError || `HTTP ${httpStatus} error`;
  }

  return { message, category, httpStatus, backendError };
}

/**
 * Check if an error should be skipped for a given network
 */
function shouldSkipError(networkKey: string, error: ParsedError): { skip: boolean; reason?: string } {
  const errorText = error.backendError || error.message;

  // Check global patterns first
  for (const { pattern, reason } of GLOBAL_SKIP_PATTERNS) {
    if (pattern.test(errorText)) {
      return { skip: true, reason };
    }
  }

  // Check network-specific patterns
  const patterns = NETWORK_SKIP_PATTERNS[networkKey];
  if (patterns) {
    for (const { pattern, reason } of patterns) {
      if (pattern.test(errorText)) {
        return { skip: true, reason };
      }
    }
  }

  return { skip: false };
}

// Configuration constants
const DELAY_BETWEEN_TESTS = 3000; // ms
const SLIPPAGE = 1000; // 10%
const AUTO_WHITELIST = false; // Set to true to automatically whitelist missing targets/signers

interface TokenConfig {
  address: string;
  decimals: number;
  symbol: string;
  isNative: boolean;
}

interface TestResult {
  router: string;
  phase: string;
  success: boolean;
  error?: string;
  errorCategory?: "insufficient_amount" | "invalid_pair" | "timeout" | "rate_limit" | "simulation" | "permit2" | "backend" | "unknown";
  httpStatus?: number;
  backendError?: string; // Detailed error from backend response
  warning?: string;
  gasEstimate?: string;
  whitelistingPerformed?: boolean;
  usingPermit2?: boolean;
  directWethWrap?: boolean; // True when backend returns direct WETH wrap/unwrap (bypasses Oku Router)
  skipped?: boolean; // True when skipped due to known limitation
  skipReason?: string;
}

interface TestSetup {
  testSigner: Signer;
  Router: OkuRouter;
  /**
   * The live OkuRouter address on this chain, pulled from the on-disk
   * registry (`deployments/<networkName>.json`) once at startup. Cached on
   * the setup struct so downstream call sites don't have to re-resolve it.
   */
  routerAddress: string;
  USDC: IERC20 | null;
  WETH: IERC20 | null;
  config: NetworkConfig;
}

/**
 * Map hardhat network name to networkConfig key
 */
function getConfigKey(networkName: string): string {
  const networkMap: Record<string, string> = {
    'op': 'op',
    'optimism': 'op',
    'base': 'base',
    'worldchain': 'worldchain',
    'arbitrum': 'arbitrum',
    'polygon': 'polygon',
    'bsc': 'bsc',
    'avax': 'avax',
    'avalanche': 'avax',
    'linea': 'linea',
    'blast': 'blast',
    'scroll': 'scroll',
    'zksync': 'zksync',
    'mantle': 'mantle',
    'gnosis': 'gnosis',
    'taiko': 'taiko',
    'celo': 'celo',
    'rootstock': 'rootstock',
    'boba': 'boba',
    'telos': 'telos',
    'lightlink': 'lightlink',
    'xdc': 'xdc',
    'unichain': 'unichain',
    'sonic': 'sonic',
    'plasma': 'plasma',
    'etherlink': 'etherlink',
    'bob': 'bob',
  };

  return networkMap[networkName] || networkName;
}

// USDC decimals vary by network (BSC uses 18, most others use 6)
const USDC_DECIMALS: Record<string, number> = {
  bsc: 18,
  // Most networks use 6 decimals (default)
};

/**
 * Get token configuration based on token type
 */
function getTokenConfig(tokenType: string, config: NetworkConfig): TokenConfig {
  switch (tokenType) {
    case "NATIVE":
      return {
        address: ZERO_ADDRESS,
        decimals: 18,
        symbol: config.nativeSymbol,
        isNative: true,
      };
    case "WETH":
      return {
        address: config.wethAddress,
        decimals: 18,
        symbol: "W" + config.nativeSymbol,
        isNative: false,
      };
    case "USDC":
      return {
        address: config.usdcAddress || "",
        decimals: USDC_DECIMALS[config.networkName] || 6,
        symbol: "USDC",
        isNative: false,
      };
    default:
      throw new Error(`Unknown token type: ${tokenType}`);
  }
}

/**
 * Validate that the network config has required fields for testing.
 * `routerAddress` is resolved from the on-disk registry by the caller.
 */
function validateConfig(config: NetworkConfig, routerAddress: string | undefined): void {
  if (!routerAddress) {
    throw new Error(`Oku Router not deployed on ${config.chainName}. Deploy first.`);
  }
  if (!config.wethAddress) {
    throw new Error(`WETH address not configured for ${config.chainName}`);
  }
  if (!config.usdcAddress) {
    console.warn(`⚠️  USDC address not configured for ${config.chainName}. Native→USDC and USDC→WETH tests will be skipped.`);
  }
  if (config.supportedRouters.length === 0) {
    throw new Error(`No supported routers configured for ${config.chainName}`);
  }
}

/**
 * Setup test environment - connect to contracts.
 *
 * `routerAddress` is passed in by the caller after resolving it from the
 * on-disk registry; we do not re-read it here.
 */
async function setupTestEnvironment(
  config: NetworkConfig,
  routerAddress: string,
): Promise<TestSetup> {
  const signers = await hre.ethers.getSigners();
  const testSigner = signers[0];
  const testAddress = await testSigner.getAddress();

  console.log(`\n🔧 Test Setup`);
  console.log(`  Signer: ${testAddress}`);
  console.log(`  Oku Router: ${routerAddress}`);

  const Router = OkuRouter__factory.connect(routerAddress, testSigner);

  // Connect to tokens if addresses are configured
  const USDC = config.usdcAddress
    ? IERC20__factory.connect(config.usdcAddress, testSigner)
    : null;
  const WETH = config.wethAddress
    ? IERC20__factory.connect(config.wethAddress, testSigner)
    : null;

  // Check native balance
  const nativeBalance = await hre.ethers.provider.getBalance(testAddress);
  console.log(`  Native Balance: ${hre.ethers.formatEther(nativeBalance)} ${config.nativeSymbol}`);

  if (nativeBalance === 0n) {
    throw new Error(`No native balance. Fund ${testAddress} with ${config.nativeSymbol} first.`);
  }

  return {
    testSigner,
    Router,
    routerAddress,
    USDC,
    WETH,
    config,
  };
}

/**
 * Test a single router with a specific trade phase
 */
async function testRouter(
  router: string,
  phase: typeof TRADE_PHASES[0],
  setup: TestSetup,
  networkKey: string,
): Promise<TestResult> {
  const { testSigner, Router, routerAddress, USDC, WETH, config } = setup;
  const testAddress = await testSigner.getAddress();

  const inToken = getTokenConfig(phase.inToken, config);
  const outToken = getTokenConfig(phase.outToken, config);

  // Skip if USDC not configured and needed
  if ((phase.inToken === "USDC" || phase.outToken === "USDC") && !config.usdcAddress) {
    return {
      router,
      phase: phase.name,
      success: false,
      error: "USDC not configured for this network",
    };
  }

  const inputAmount = parseUnits(phase.amount, inToken.decimals);

  const params: canoeParams = {
    chain: config.chainName,
    account: routerAddress,
    isExactIn: true,
    inTokenAddress: inToken.address,
    outTokenAddress: outToken.address,
    inTokenAmount: phase.amount,
    slippage: SLIPPAGE,
    useOkuRouter: true,
    getCalldata: true,
    usePermit2: !inToken.isNative,
    userAddress: testAddress,
  };

  // Get token contracts for approvals
  const inTokenContract = inToken.isNative ? null :
    phase.inToken === "WETH" ? WETH :
    phase.inToken === "USDC" ? USDC :
    IERC20__factory.connect(inToken.address, testSigner);

  let whitelistingPerformed = false;

  try {
    // 1. Get quote from backend
    const quoteResponse = await getRouterQuote(router, params);

    if (!quoteResponse || !quoteResponse.coupon) {
      throw new Error("Failed to get valid quote response");
    }

    // 2. Handle Permit2 signing if needed
    let permit2SigningRequest: any = undefined;
    let permit2SignatureGenerated = false;

    if (quoteResponse.signingRequest?.typedData && quoteResponse.signingRequest.typedData.length > 0) {
      try {
        const typedDataPayload = quoteResponse.signingRequest.typedData[0].payload;
        const signature = await testSigner.signTypedData(
          typedDataPayload.domain,
          typedDataPayload.types,
          typedDataPayload.message
        );

        permit2SigningRequest = {
          typedData: [{
            payload: typedDataPayload,
            signature: signature
          }]
        };
        permit2SignatureGenerated = true;
      } catch (error: any) {
        throw new Error(`Permit2 signature failed: ${error.message}`);
      }
    }
    // Note: If usePermit2 is true but no signingRequest was returned, don't throw here.
    // Backend may return a direct WETH wrap/unwrap which doesn't require Permit2.
    // If Permit2 was actually needed, the simulation will fail with a clear error.

    // 3. Get execution info from backend
    const okuExecution = await getOkuExecution(
      quoteResponse.coupon,
      router,
      permit2SigningRequest
    );

    const trade = okuExecution.trade;
    if (!trade) {
      throw new Error("No trade data found");
    }

    // Check if this is a direct WETH wrap/unwrap (backend returns tx directly to WETH contract)
    const isDirectWethWrap = trade.to.toLowerCase() === config.wethAddress.toLowerCase();

    if (isDirectWethWrap) {
      // Direct WETH wrap/unwrap - simulate the transaction directly to WETH contract
      // This bypasses Oku Router entirely (no whitelisting needed)
      let gasEstimate: bigint | undefined;
      try {
        gasEstimate = await hre.ethers.provider.estimateGas({
          to: trade.to,
          data: trade.data,
          value: trade.value,
          from: testAddress,
        });
      } catch (simError: any) {
        // Check if this is a known/skipped issue
        const parsedSimError = parseError(simError);
        const skipCheck = shouldSkipError(networkKey, parsedSimError);

        if (!skipCheck.skip) {
          // Unknown error - output full transaction details for Tenderly debugging
          console.log(`\n    ⚠️  Direct WETH wrap/unwrap simulation failed - Tenderly debugging:`);
          console.log(`    ────────────────────────────────────────────────────────`);
          console.log(`    From: ${testAddress}`);
          console.log(`    To: ${trade.to}`);
          console.log(`    Value: ${trade.value} (${hre.ethers.formatEther(trade.value)} ETH)`);
          console.log(`    Data: ${trade.data}`);
          console.log(`    Error: ${simError.message}`);
          console.log(`    ────────────────────────────────────────────────────────\n`);
        }
        throw new Error(`Direct WETH wrap/unwrap simulation failed: ${simError.message}`);
      }

      return {
        router,
        phase: phase.name,
        success: true,
        gasEstimate: gasEstimate?.toString(),
        directWethWrap: true,
      };
    }

    // Normal path - transaction goes through Oku Router
    if (trade.to.toLowerCase() !== routerAddress.toLowerCase()) {
      throw new Error(`Expected Oku Router, got ${trade.to}`);
    }

    // 4. Decode transaction and extract targets
    const okuInterface = OkuRouter__factory.createInterface();
    const decoded = okuInterface.parseTransaction({ data: trade.data });

    if (!decoded) {
      throw new Error("Failed to decode transaction");
    }

    const { target: targetAddress, approvalTarget: approvalTargetAddress } = extractTargetsFromRouterData(trade.data);

    // Validate target contract exists
    if (targetAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      const targetCode = await hre.ethers.provider.getCode(targetAddress);
      if (targetCode === "0x") {
        throw new Error(`Target contract ${targetAddress} does not exist`);
      }
    }

    const functionName = decoded.name;
    const usingPermit2 = functionName.includes("WithPermit");

    // 5. Handle ERC20 approval if needed
    if (!inToken.isNative && inTokenContract) {
      const tokenApprovalTarget = usingPermit2
        ? PERMIT2_ADDRESS
        : routerAddress;

      await handleERC20Approval(
        testSigner,
        inTokenContract,
        tokenApprovalTarget,
        inputAmount,
        inToken.symbol,
        inToken.decimals
      );
    }

    // 6. Whitelist targets and signers (real transactions if needed, or log if AUTO_WHITELIST is false)
    const targetWhitelisted = await Router.swapTargets(targetAddress);

    if (!targetWhitelisted) {
      if (AUTO_WHITELIST) {
        await ensureTargetIsWhitelisted(testSigner, Router, targetAddress);
        whitelistingPerformed = true;
      } else {
        console.log(`    ⚠️  Target not whitelisted: ${targetAddress}`);
      }
    }

    // Whitelist approvalTarget for transfer proxy dexes (e.g., OKX, ZeroEx)
    // Skip if approvalTarget is a token address (WETH, USDC) - these should never be swap targets
    const tokenAddresses = [
      config.wethAddress.toLowerCase(),
      config.usdcAddress?.toLowerCase(),
    ].filter(Boolean);

    if (approvalTargetAddress &&
        approvalTargetAddress.toLowerCase() !== targetAddress.toLowerCase() &&
        approvalTargetAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
        !tokenAddresses.includes(approvalTargetAddress.toLowerCase())) {
      const approvalTargetWhitelisted = await Router.swapTargets(approvalTargetAddress);
      if (!approvalTargetWhitelisted) {
        if (AUTO_WHITELIST) {
          await ensureTargetIsWhitelisted(testSigner, Router, approvalTargetAddress);
          whitelistingPerformed = true;
        } else {
          console.log(`    ⚠️  ApprovalTarget not whitelisted: ${approvalTargetAddress}`);
        }
      }
    }

    // Check warrant signer is whitelisted (backend returns 0x0 which should already be whitelisted by deploy script)
    if (okuExecution.warrant) {
      const warrantSignerWhitelisted = await Router.validSigners(okuExecution.warrant.verifyingSigner);
      if (!warrantSignerWhitelisted) {
        console.log(`    ⚠️  Warrant signer not whitelisted: ${okuExecution.warrant.verifyingSigner}`);
      }
    }

    // 7. Simulate the transaction (gas estimation)
    let gasEstimate: bigint | undefined;
    try {
      gasEstimate = await hre.ethers.provider.estimateGas({
        to: trade.to,
        data: trade.data,
        value: trade.value,
        from: testAddress,
      });
    } catch (simError: any) {
      const errorMsg = simError.message || "";

      // Quick check: is this a known issue that will be skipped?
      const parsedSimError = parseError(simError);
      const skipCheck = shouldSkipError(networkKey, parsedSimError);

      if (skipCheck.skip) {
        // Known issue - skip verbose logging, just throw clean error
        throw new Error(`Simulation failed: ${simError.message}`);
      }

      // Unknown error - print full debugging info
      if (errorMsg.includes("TARGET_NOT_AUTH")) {
        console.log(`    🔑 TARGET_NOT_AUTH - Need to whitelist: ${targetAddress}`);
        if (approvalTargetAddress && approvalTargetAddress.toLowerCase() !== targetAddress.toLowerCase()) {
          console.log(`    🔑 Also check approvalTarget: ${approvalTargetAddress}`);
        }
      }

      console.log(`\n    ⚠️  Simulation failed - Full transaction for Tenderly debugging:`);
      console.log(`    ────────────────────────────────────────────────────────`);
      console.log(`    From: ${testAddress}`);
      console.log(`    To: ${trade.to}`);
      console.log(`    Value: ${trade.value} (${hre.ethers.formatEther(trade.value)} ETH)`);
      console.log(`    Data: ${trade.data}`);
      console.log(`    ────────────────────────────────────────────────────────`);
      console.log(`    Target: ${targetAddress}`);
      console.log(`    ApprovalTarget: ${approvalTargetAddress || 'N/A'}`);
      console.log(`    Function: ${functionName}`);
      console.log(`    Error: ${errorMsg}`);
      console.log(`    ────────────────────────────────────────────────────────\n`);

      throw new Error(`Simulation failed: ${simError.message}`);
    }

    return {
      router,
      phase: phase.name,
      success: true,
      gasEstimate: gasEstimate?.toString(),
      whitelistingPerformed,
      usingPermit2,
    };

  } catch (error: any) {
    // Parse the error to extract detailed info
    const parsedError = parseError(error);

    // Check if this error should be skipped for this network
    const skipCheck = shouldSkipError(networkKey, parsedError);

    if (skipCheck.skip) {
      return {
        router,
        phase: phase.name,
        success: false,
        skipped: true,
        skipReason: skipCheck.reason,
        error: parsedError.message,
        errorCategory: parsedError.category,
        httpStatus: parsedError.httpStatus,
        backendError: parsedError.backendError,
        whitelistingPerformed,
      };
    }

    return {
      router,
      phase: phase.name,
      success: false,
      error: parsedError.message,
      errorCategory: parsedError.category,
      httpStatus: parsedError.httpStatus,
      backendError: parsedError.backendError,
      whitelistingPerformed,
    };
  }
}

/**
 * Log individual test result
 */
function logResult(result: TestResult, inToken: string): void {
  if (result.success) {
    // Highlight direct WETH wrap/unwrap case
    if (result.directWethWrap) {
      console.log(`  🔄 ${result.router}: Direct WETH wrap/unwrap (bypasses router)`);
      return;
    }
    // Show warning if token swap didn't use permit2
    const isTokenSwap = inToken !== "NATIVE";
    if (isTokenSwap && !result.usingPermit2) {
      console.log(`  ⚠️  ${result.router}: OK but not using permit2`);
    } else {
      console.log(`  ✅ ${result.router}`);
    }
  } else if (result.skipped) {
    // Show skipped results with skip icon
    console.log(`  ⏭️  ${result.router}: Skipped - ${result.skipReason}`);
  } else {
    // Show failed results with category
    const categoryTag = result.errorCategory ? `[${result.errorCategory}] ` : "";
    console.log(`  ❌ ${result.router}: ${categoryTag}${result.error}`);
  }
}

/**
 * Print test summary
 */
function printSummary(results: TestResult[], config: NetworkConfig, phases: typeof TRADE_PHASES): void {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 ${config.chainName.toUpperCase()} TEST RESULTS`);
  console.log(`${"=".repeat(80)}`);

  const successful = results.filter(r => r.success);
  const skipped = results.filter(r => !r.success && r.skipped);
  const failed = results.filter(r => !r.success && !r.skipped);
  const directWethWraps = results.filter(r => r.success && r.directWethWrap);

  // Find token swaps not using permit2 (excluding direct WETH wraps)
  const tokenSwapPhases = phases.filter(p => p.inToken !== "NATIVE").map(p => p.name);
  const notUsingPermit2 = results.filter(r =>
    r.success &&
    !r.directWethWrap &&
    tokenSwapPhases.includes(r.phase) &&
    !r.usingPermit2
  );

  console.log(`\n✅ Success: ${successful.length}/${results.length}`);
  console.log(`⏭️  Skipped: ${skipped.length}/${results.length}`);
  console.log(`❌ Failed: ${failed.length}/${results.length}`);

  if (directWethWraps.length > 0) {
    console.log(`\n🔄 Direct WETH wrap/unwrap (bypassed router): ${directWethWraps.length}`);
    directWethWraps.forEach(r => console.log(`  - ${r.router} | ${r.phase}`));
  }

  if (notUsingPermit2.length > 0) {
    console.log(`\n⚠️  Not using Permit2 (token swaps):`);
    notUsingPermit2.forEach(r => console.log(`  - ${r.router} | ${r.phase}`));
  }

  // Group skipped by reason
  if (skipped.length > 0) {
    console.log(`\n⏭️  Skipped Tests (expected limitations):`);
    const skipReasons = new Map<string, TestResult[]>();
    for (const r of skipped) {
      const reason = r.skipReason || "Unknown";
      if (!skipReasons.has(reason)) {
        skipReasons.set(reason, []);
      }
      skipReasons.get(reason)!.push(r);
    }
    for (const [reason, tests] of skipReasons) {
      console.log(`  ${reason}:`);
      tests.forEach(r => console.log(`    - ${r.router} | ${r.phase}`));
    }
  }

  // Group actual failures by category for better analysis
  if (failed.length > 0) {
    console.log(`\n❌ Failed Tests (requires attention):`);
    const categories = new Map<string, TestResult[]>();
    for (const r of failed) {
      const cat = r.errorCategory || "unknown";
      if (!categories.has(cat)) {
        categories.set(cat, []);
      }
      categories.get(cat)!.push(r);
    }
    for (const [category, tests] of categories) {
      console.log(`\n  [${category}]:`);
      tests.forEach(r => {
        const statusInfo = r.httpStatus ? ` (HTTP ${r.httpStatus})` : "";
        console.log(`    - ${r.router} | ${r.phase}${statusInfo}`);
        console.log(`      ${r.error}`);
      });
    }
  }

  console.log(`\n${"=".repeat(80)}`);
}

/**
 * Delay helper
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Main function
 */
async function main() {
  const networkName = hre.network.name;
  const configKey = getConfigKey(networkName);
  const config = NETWORK_CONFIGS[configKey];

  if (!config) {
    console.error(`\n❌ Network "${networkName}" not found in util/deploymentConfig.ts (check DEPLOYMENT_OVERRIDES and @gfxlabs/oku-chains)`);
    console.error(`Available networks: ${Object.keys(NETWORK_CONFIGS).join(", ")}`);
    process.exit(1);
  }

  // Resolve the live OkuRouter address from the on-disk registry. This is
  // the authoritative source for "what's deployed right now" — networkConfig
  // intentionally no longer carries this field.
  const routerAddress = getCurrentAddress(configKey, "OkuRouter");

  console.log(`\n🚀 Testing Routers on ${config.chainName.toUpperCase()}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Network: ${config.chainName} (chainId: ${config.chainId})`);
  console.log(`Oku Router: ${routerAddress ?? "(not deployed)"}`);
  console.log(`Routers to test: ${config.supportedRouters.length}`);
  console.log(`Trade phases: ${TRADE_PHASES.length}`);

  // Validate config
  try {
    validateConfig(config, routerAddress);
  } catch (error: any) {
    console.error(`\n❌ Configuration Error: ${error.message}`);
    process.exit(1);
  }

  // Setup test environment. validateConfig() above ensures routerAddress is
  // non-undefined before we reach this point.
  const setup = await setupTestEnvironment(config, routerAddress!);

  // Run tests
  const results: TestResult[] = [];

  for (const phase of TRADE_PHASES) {
    console.log(`\n📋 Phase: ${phase.name} (${config.supportedRouters.length} routers)`);

    // Check if we have sufficient balance for this phase (for non-native input tokens)
    const inTokenConfig = getTokenConfig(phase.inToken, config);
    if (!inTokenConfig.isNative) {
      const tokenContract = phase.inToken === "WETH" ? setup.WETH :
        phase.inToken === "USDC" ? setup.USDC : null;

      if (tokenContract) {
        const testAddress = await setup.testSigner.getAddress();
        const balance = await tokenContract.balanceOf(testAddress);
        const requiredAmount = parseUnits(phase.amount, inTokenConfig.decimals);

        if (balance < requiredAmount) {
          console.log(`  ⏭️  Skipping entire phase: Insufficient ${inTokenConfig.symbol} balance`);
          console.log(`     Need ${phase.amount} ${inTokenConfig.symbol}, have ${hre.ethers.formatUnits(balance, inTokenConfig.decimals)}`);
          continue;
        }
      }
    }

    for (const router of config.supportedRouters) {
      // Skip known incompatible pairs
      const pairKey = `${phase.inToken}-${phase.outToken}`;
      if (SKIP_PAIRS[router]?.includes(pairKey)) {
        console.log(`  ⏭️  ${router}: Skipped (unsupported pair)`);
        continue;
      }

      const result = await testRouter(router, phase, setup, configKey);
      results.push(result);
      logResult(result, phase.inToken);

      // Delay between tests to avoid rate limits
      await delay(DELAY_BETWEEN_TESTS);
    }

    // Extra delay between phases
    if (TRADE_PHASES.indexOf(phase) < TRADE_PHASES.length - 1) {
      await delay(2000);
    }
  }

  // Print summary
  printSummary(results, config, TRADE_PHASES);
}

main().catch((error) => {
  console.error("\n❌ Fatal Error:", error.message);
  process.exit(1);
});
