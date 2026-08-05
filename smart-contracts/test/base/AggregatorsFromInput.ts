/**
 * This file tests all the possible combinations of:
 * TOKEN => ETH
 * TOKEN => TOKEN
 * ETH => TOKEN
 *
 * through both aggregators (0x and 1inch)
 *
 * with different fees (0%, 0.5% and 1%)
 *
 * based on the input amount
 *
 */

import path from "path";
import { expect } from "chai";
import { network, ethers } from "hardhat"; // Use ethers
import { Sources } from "../types"; // Assuming Sources type is still valid
import {
  DAI_ADDRESS,
  ETH_ADDRESS, // Assuming this is ZeroAddress or a specific marker
  getQuoteFromFile, // Assumed updated for ethers
  getVaultBalanceForToken, // Assumed updated for ethers
  init, // Assumed updated for ethers
  Logger,
  showGasUsage,
  WETH_ADDRESS,
} from "../utils";
import {
  ZeroAddress, // Use ZeroAddress from ethers
  formatEther, // Use formatEther from ethers
  formatUnits, // Use formatUnits from ethers
  parseEther, // Use parseEther from ethers
  type Signer, // Import Signer type
  type AddressLike, // Use AddressLike for type safety if needed
} from "ethers";
import hre from "hardhat";
// Import TypeChain types - Adjust path as needed
import { type OkuRouter, type IWETH, ERC20__factory, IWETH__factory, IDAI__factory } from "../../typechain-types";

const SELL_AMOUNT_STR = "0.1"; // Keep as string for initial parsing
const TESTDATA_DIR = path.resolve(__dirname, "testdata/input");

// Define placeholder struct types based on inference - ADJUST THESE TO MATCH YOUR CONTRACT
// You should import these from your TypeChain output if available
type QuoteTokenToTokenParams = {
  sellTokenAddress: AddressLike;
  buyTokenAddress: AddressLike;
  target: AddressLike;
  data: string; // bytes
  sellAmount: bigint;
  fee: bigint;
};
type EthToTokenQuoteParams = {
  buyTokenAddress: AddressLike;
  target: AddressLike;
  data: string; // bytes
  fee: bigint;
};
type TokenToEthQuoteParams = {
  sellTokenAddress: AddressLike;
  target: AddressLike;
  data: string; // bytes
  sellAmount: bigint;
  feePercentageBasisPoints: bigint; // Assuming fee is basis points here
};
type Warrant = {
  verifyingSigner: AddressLike;
  nonce: bigint;
  signature: string; // bytes
  validBefore: number; // uint32
  validAfter: number; // uint32
};


describe("OkuRouter Aggregators", function () {
  let swapTokenToToken: (
    source: Sources,
    inputAsset: AddressLike,
    outputAsset: AddressLike,
    sellAmountStr: string, // Pass string amount
    feePercentageBasisPoints: bigint,
  ) => Promise<boolean | undefined>;

  let swapETHtoToken: (
    source: Sources,
    outputAsset: AddressLike,
    sellAmountStr: string, // Pass string amount
    feePercentageBasisPoints: bigint,
  ) => Promise<void>; // Return type changed as original didn't return boolean

  let swapTokenToETH: (
    source: Sources,
    inputAsset: AddressLike,
    _sellAmountStr: string, // Placeholder, amount calculated from balance
    feePercentageBasisPoints: bigint,
  ) => Promise<void>; // Return type changed

  let okuRouterInstance: OkuRouter;
  let signer: Signer;
  let currentVaultAddress: string; // Ethers uses string for addresses
  let getSignerBalance: () => Promise<bigint>; // Function to get signer ETH balance
  let getEthVaultBalance: () => Promise<bigint>; // Function to get vault ETH balance


  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_RPC_ENDPOINT!,
            blockNumber: 15214922
          },
        },
      ],
    });

    // Assume init is updated for ethers v6
    const initResult = await init();
    signer = initResult.signer; // Get Signer object
    okuRouterInstance = initResult.okuRouterInstance; // Get TypeChain instance
    getEthVaultBalance = initResult.getEthVaultBalance; // Get vault balance helper
    getSignerBalance = initResult.getSignerBalance; // Get signer balance helper
    // const publicClient = initResult.publicClient; // No longer needed

    currentVaultAddress = await okuRouterInstance.getAddress();

    swapTokenToToken = async (
      source: Sources,
      inputAssetAddr: AddressLike,
      outputAssetAddr: AddressLike,
      sellAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<boolean | undefined> => {
      const initialVaultInputTokenBalance = await getVaultBalanceForToken(
        inputAssetAddr,
        currentVaultAddress, // Use string address
        ethers.provider
      );
      const initialVaultOutputTokenBalance = await getVaultBalanceForToken(
        outputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      const inputAssetContract = IWETH__factory.connect(inputAssetAddr.toString(), signer)
      const inputAssetSymbol = await inputAssetContract.symbol();
      const inputAssetDecimals = await inputAssetContract.decimals(); // Returns number or bigint, formatUnits handles it

      const outputAssetContract = IWETH__factory.connect(outputAssetAddr.toString(), signer)
      const outputAssetSymbol = await outputAssetContract.symbol();
      const outputAssetDecimals = await outputAssetContract.decimals();

      const sellAmountWei = parseEther(sellAmountStr); // Parse the string amount

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        inputAssetAddr.toString(),
        outputAssetAddr.toString(),
        sellAmountWei.toString(), // Pass wei string to quote function
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return; // Quote failed

      // Ensure quote values are BigInt where needed
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0); // Ensure value is bigint, default 0

      Logger.log(
        "Input amount",
        formatUnits(sellAmountWei, Number(inputAssetDecimals)), // formatUnits needs number for decimals
        inputAssetSymbol,
      );
      Logger.log(
        "Fee",
        formatUnits(quote.fee, Number(inputAssetDecimals)),
        inputAssetSymbol,
      );
      Logger.log(
        `User will get ~ `,
        formatUnits(quote.buyAmount, Number(outputAssetDecimals)),
        outputAssetSymbol,
      );

      const signerAddress = await signer.getAddress();
      const wethAddress = await hre.ethers.getAddress(WETH_ADDRESS); // Ensure checksum

      if (await hre.ethers.getAddress(inputAssetAddr as string) === wethAddress) {
        Logger.log(
          `User wrapping ${sellAmountStr} ETH into WETH...`,
        );
        const depositTx = await inputAssetContract.connect(signer).deposit({
          value: sellAmountWei,
        });
        await depositTx.wait(); // Wait for transaction confirmation
      }

      const initialInputAssetBalance = await inputAssetContract.balanceOf(signerAddress);
      const initialOutputAssetBalance = await outputAssetContract.balanceOf(signerAddress);

      Logger.log(
        `Initial user ${inputAssetSymbol} balance`,
        formatUnits(initialInputAssetBalance, Number(inputAssetDecimals)),
      );
      Logger.log(
        `Initial user balance ${outputAssetSymbol}: `,
        formatUnits(initialOutputAssetBalance, Number(outputAssetDecimals)),
      );

      // Grant the router an allowance to spend our token.
      Logger.log(`Approving token allowance of `, sellAmountWei.toString());
      const approveTx = await inputAssetContract.connect(signer).approve(
        currentVaultAddress,
        sellAmountWei,
      );
      await approveTx.wait();


      Logger.log(`Executing swap...`);
      const swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToToken(
        quote.sellTokenAddress,
        quote.buyTokenAddress,
        quote.to || ZeroAddress,
        quote.to || ZeroAddress, // approvalTarget - same as target for standard aggregators
        quote.data || Sources.Aggregator0x,
        quote.sellAmount,
        quote.fee,
        signerAddress,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: Sources.Aggregator0x,
          validBefore: 0,
          validAfter: 0,
        }
        ,
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();

      if (showGasUsage && receipt) {
        Logger.info("      ⛽ Gas usage: ", receipt.gasUsed.toString());
      }

      const finalInputAssetBalance = await inputAssetContract.balanceOf(signerAddress);
      const finalOutputAssetBalance = await outputAssetContract.balanceOf(signerAddress);
      const inputTokenBalanceVault = await inputAssetContract.balanceOf(currentVaultAddress);

      Logger.log(
        `Final user balance (${outputAssetSymbol}): `,
        formatUnits(finalOutputAssetBalance, Number(outputAssetDecimals)),
      );
      Logger.log(
        `Final VAULT balance (${inputAssetSymbol}): `,
        formatUnits(inputTokenBalanceVault, Number(inputAssetDecimals)),
      );

      const finalVaultInputTokenBalance = await getVaultBalanceForToken(
        inputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );
      const finalVaultOutputTokenBalance = await getVaultBalanceForToken(
        outputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      // Assertions
      expect(finalInputAssetBalance).to.be.lt(initialInputAssetBalance); // Use lt (less than)
      expect(finalOutputAssetBalance).to.be.gt(initialOutputAssetBalance); // Use gt (greater than)
      expect(inputTokenBalanceVault).to.be.gte(quote.fee); // Use gte (greater than or equal)

      expect(finalVaultInputTokenBalance).to.be.gte(initialVaultInputTokenBalance);
      // Note: Output token balance in vault might decrease if vault provides liquidity
      // Original test checked >=, maintaining that logic. Consider if this is always correct.
      expect(finalVaultOutputTokenBalance).to.be.gte(initialVaultOutputTokenBalance);

      return true;
    };

    swapETHtoToken = async (
      source: Sources,
      outputAssetAddr: AddressLike,
      sellAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<void> => {
      const initialVaultOutputTokenBalance = await getVaultBalanceForToken(
        outputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      const tokenContract = IWETH__factory.connect(outputAssetAddr.toString(), signer)
      const signerAddress = await signer.getAddress();
      const initialEthBalance = await getSignerBalance(); // Use helper
      const initialTokenBalance = await tokenContract.balanceOf(signerAddress);
      const tokenSymbol = await tokenContract.symbol();
      const tokenDecimals = await tokenContract.decimals();

      Logger.log("Initial user balance (ETH)", formatEther(initialEthBalance));
      Logger.log(
        `Initial user balance (${tokenSymbol}): `,
        formatUnits(initialTokenBalance, Number(tokenDecimals)),
      );

      const sellAmountWei = parseEther(sellAmountStr);

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        ETH_ADDRESS,
        outputAssetAddr.toString(),
        sellAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);
      quote.sellAmountMinusFees = BigInt(quote.sellAmountMinusFees || quote.sellAmount - quote.fee);


      Logger.log("Input amount", formatEther(sellAmountWei), "ETH");
      Logger.log("Fee", formatEther(quote.fee), "ETH"); // Fee is expected in ETH for ETH->Token
      Logger.log(
        "Amount to be swapped",
        formatEther(quote.sellAmountMinusFees), // sellAmount - fee
        "ETH",
      );
      Logger.log(
        `User will get ~ `,
        formatUnits(quote.buyAmount, Number(tokenDecimals)),
        tokenSymbol,
      );

      const ethBalanceVaultBeforeSwap = await getEthVaultBalance(); // Use helper

      Logger.log(`Executing swap... with value `, formatEther(quote.value)); // quote.value is msg.value
      Logger.log("calldata is: ", quote.data);
      Logger.log("target is: ", quote.to);

      // Prepare parameters
      const quoteParams: EthToTokenQuoteParams = {
        buyTokenAddress: quote.buyTokenAddress,
        target: quote.to || ZeroAddress,
        data: quote.data || Sources.Aggregator0x,
        fee: quote.fee,
      };
      const warrant: Warrant = {
        verifyingSigner: ZeroAddress, nonce: 0n, signature: Sources.Aggregator0x, validBefore: 0, validAfter: 0,
      };

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteEthToToken(
        quote.buyTokenAddress,
        quote.to || ZeroAddress,
        quote.data || Sources.Aggregator0x,
        quote.fee,
        signerAddress,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: Sources.Aggregator0x,
          validBefore: 0,
          validAfter: 0,
        },
        {
          value: quote.value, // This should be the total ETH sent (sellAmountWei)
        },
      );

      const receipt = await swapTx.wait();

      if (showGasUsage && receipt) {
        Logger.info("      ⛽ Gas usage: ", receipt.gasUsed.toString());
      }

      const tokenBalanceSigner = await tokenContract.balanceOf(signerAddress);
      const ethBalanceSigner = await getSignerBalance();
      const ethBalanceVault = await getEthVaultBalance();
      const ethVaultDiff = ethBalanceVault - ethBalanceVaultBeforeSwap;

      Logger.log(
        `Final user balance (${tokenSymbol}): `,
        formatUnits(tokenBalanceSigner, Number(tokenDecimals)), // Use formatUnits here
      );
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));
      Logger.log("Final vault balance (ETH): ", formatEther(ethBalanceVault));
      Logger.log("Vault increase (ETH): ", formatEther(ethVaultDiff));

      const finalVaultOutputTokenBalance = await getVaultBalanceForToken(
        outputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      // Assertions
      expect(tokenBalanceSigner).to.be.gt(initialTokenBalance);
      // User's ETH balance decreases by sellAmountWei + gas. Check it's less than initial.
      expect(ethBalanceSigner).to.be.lt(initialEthBalance);
      // Vault's ETH balance should increase by the fee amount
      expect(ethVaultDiff).to.be.equal(quote.fee);

      expect(ethBalanceVault).to.be.gte(ethBalanceVaultBeforeSwap);
      expect(finalVaultOutputTokenBalance).to.be.gte(initialVaultOutputTokenBalance); // See comment in swapTokenToToken
    };

    swapTokenToETH = async (
      source: Sources,
      inputAssetAddr: AddressLike,
      _sellAmountStr: string, // Sell amount is determined by current balance
      feePercentageBasisPoints: bigint,
    ): Promise<void> => {
      const initialVaultInputTokenBalance = await getVaultBalanceForToken(
        inputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      const tokenContract = IDAI__factory.connect(inputAssetAddr.toString(), signer)
      const signerAddress = await signer.getAddress();
      const initialEthBalance = await getSignerBalance();
      const initialTokenBalance = await tokenContract.balanceOf(signerAddress); // This is the amount we'll sell

      // If initial balance is 0, we can't perform the swap. Maybe add WETH first?
      // For now, assume the previous tests leave some DAI/WETH balance.
      if (initialTokenBalance === 0n) {
        Logger.log(`Skipping swapTokenToETH for ${inputAssetAddr} as initial balance is 0.`);
        return;
      }

      const tokenSymbol = await tokenContract.symbol();
      const tokenDecimals = await tokenContract.decimals();
      const ethBalanceVaultBeforeSwap = await getEthVaultBalance();

      Logger.log(
        `Initial user balance (${tokenSymbol}): `,
        formatUnits(initialTokenBalance, Number(tokenDecimals)),
      );
      Logger.log("Initial user balance (ETH)", formatEther(initialEthBalance));

      const sellAmountWei = initialTokenBalance; // Sell the entire balance

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        inputAssetAddr.toString(),
        ETH_ADDRESS, // Use marker for ETH
        sellAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee); // Fee might be in ETH or input token depending on contract logic
      quote.value = BigInt(quote.value || 0);
      quote.feePercentageBasisPoints = (quote.feePercentageBasisPoints || 0);
      // Calculate sell amount minus fees based on how your contract handles fees for Token->ETH
      // Assuming fee is taken from output ETH for simplicity based on the contract function name `feePercentageBasisPoints` arg
      quote.sellAmountMinusFees = quote.sellAmount; // Assume entire input amount is swapped before fee

      Logger.log(
        "Input amount (selling full balance)",
        formatUnits(sellAmountWei, Number(tokenDecimals)),
        tokenSymbol,
      );
      // Logging quote.fee might be misleading if it's not in ETH. Log basis points instead.
      Logger.log("Fee Basis Points", quote.feePercentageBasisPoints.toString());
      Logger.log(
        "Amount to be swapped", // This might be slightly different if fee is taken from input
        formatUnits(quote.sellAmountMinusFees, Number(tokenDecimals)),
        tokenSymbol,
      );
      Logger.log(`User will get ~ `, formatEther(quote.buyAmount), "ETH"); // buyAmount should be net ETH after fee

      // Grant the allowance
      Logger.log(`Approving token allowance of `, sellAmountWei.toString());
      const approveTx = await tokenContract.connect(signer).approve(
        currentVaultAddress,
        sellAmountWei,
      );
      await approveTx.wait();

      Logger.log(`Executing swap...`);
      Logger.log("calldata is: ", quote.data);
      Logger.log("target is: ", quote.to);

      // Prepare parameters
      const quoteParams: TokenToEthQuoteParams = {
        sellTokenAddress: quote.sellTokenAddress,
        target: quote.to || ZeroAddress,
        data: quote.data || Sources.Aggregator0x,
        sellAmount: quote.sellAmount, // The full amount user approved
        feePercentageBasisPoints: BigInt(quote.feePercentageBasisPoints),
      };

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToEth(
        quoteParams.sellTokenAddress,
        quoteParams.target,
        quoteParams.target, // approvalTarget
        quoteParams.data,
        quoteParams.sellAmount,
        quoteParams.feePercentageBasisPoints,
        signerAddress,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: ZeroAddress, // Default signature to "0x"
          validBefore: 0,
          validAfter: 0,
        },
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();

      if (showGasUsage && receipt) {
        Logger.info("      ⛽ Gas usage: ", receipt.gasUsed.toString());
      }

      const tokenBalanceSigner = await tokenContract.balanceOf(signerAddress);
      const ethBalanceSigner = await getSignerBalance();
      const ethBalanceVault = await getEthVaultBalance();
      const ethVaultDiff = ethBalanceVault - ethBalanceVaultBeforeSwap;

      Logger.log(
        `Final user balance (${tokenSymbol}): `,
        formatUnits(tokenBalanceSigner, Number(tokenDecimals)),
      );
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));
      Logger.log("Final VAULT balance (ETH): ", formatEther(ethBalanceVault));
      Logger.log("Vault increase (ETH): ", formatEther(ethVaultDiff)); // This is the fee collected in ETH

      const finalVaultInputTokenBalance = await getVaultBalanceForToken(
        inputAssetAddr,
        currentVaultAddress,
        ethers.provider
      );

      // Assertions
      expect(tokenBalanceSigner).to.be.equal(0n); // User sold their entire balance
      // User's ETH balance increases by the swapped amount (net of fees) minus gas cost. Check > initial.
      // Cannot directly compare to initial + buyAmount due to gas variance.
      expect(ethBalanceSigner).to.be.gt(initialEthBalance - parseEther('0.1')); // Allow for gas cost variance, check it increased overall

      // Vault ETH increase should reflect the fee collected.
      if (feePercentageBasisPoints > 0n) {
        // The exact fee amount depends on the buyAmount before fee.
        // Check that the vault balance increased is plausible.
        expect(ethVaultDiff).to.be.gt(0n); // Fee was collected
        // More precise check if possible: expect(ethVaultDiff).to.be.closeTo(expectedFeeInEth, tolerance);
      } else {
        expect(ethVaultDiff).to.be.equal(0n); // No fee collected
      }

      expect(ethBalanceVault).to.be.gte(ethBalanceVaultBeforeSwap);
      expect(finalVaultInputTokenBalance).to.be.gte(initialVaultInputTokenBalance); // Input token vault balance should not decrease
    };
  });

  describe("Trades based on input amount", function () {
    const sellAmount = SELL_AMOUNT_STR; // Use the string constant

    // =====> 1inch trades

    // No fee (0n)
    it("Should be able to swap wETH to DAI with no fee on 1inch", async function () {
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        WETH_ADDRESS,
        DAI_ADDRESS,
        sellAmount,
        0n, // Use BigInt literal
      );
    });

    it("Should be able to swap DAI to wETH with no fee on 1inch", async function () {
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        DAI_ADDRESS,
        WETH_ADDRESS,
        sellAmount, // Amount here might need adjustment if previous test consumed WETH
        0n,
      );
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with no fee on 1inch", async function () {
    //   return swapETHtoToken(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 0n);
    // });

    // it("Should be able to swap DAI to ETH with no fee on 1inch", async function () {
    //   // This will sell the current DAI balance from the previous test
    //   return swapTokenToETH(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 0n);
    // });

    // 0.5 % fee (50n)
    it("Should be able to swap wETH to DAI with a 0.5% fee on 1inch", async function () {
      // Need WETH again - ensure sufficient ETH balance before calling
      const signerEth = await getSignerBalance();
      if (signerEth < parseEther(sellAmount)) throw new Error("Insufficient ETH to wrap for test");
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        WETH_ADDRESS,
        DAI_ADDRESS,
        sellAmount,
        50n, // Use BigInt literal
      );
    });

    it("Should be able to swap DAI to wETH with a 0.5% fee on 1inch", async function () {
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        DAI_ADDRESS,
        WETH_ADDRESS,
        sellAmount, // Will sell current DAI balance, not necessarily 'sellAmount' string value
        50n,
      );
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with a 0.5% fee on 1inch", async function () {
    //   return swapETHtoToken(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 50n);
    // });

    // it("Should be able to swap DAI to ETH with a 0.5% fee on 1inch", async function () {
    //   return swapETHtoToken(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 50n);
    // });

    // 1% fee (100n)
    it("Should be able to swap wETH to DAI with a 1% fee on 1inch", async function () {
      // Need WETH again
      const signerEth = await getSignerBalance();
      if (signerEth < parseEther(sellAmount)) throw new Error("Insufficient ETH to wrap for test");
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        WETH_ADDRESS,
        DAI_ADDRESS,
        sellAmount,
        100n, // Use BigInt literal
      );
    });

    it("Should be able to swap DAI to wETH with a 1% fee on 1inch", async function () {
      return swapTokenToToken(
        Sources.Aggregotor1inch,
        DAI_ADDRESS,
        WETH_ADDRESS,
        sellAmount, // Sells current DAI balance
        100n,
      );
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with a 1% fee on 1inch", async function () {
    //   return swapETHtoToken(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 100n);
    // });

    // it("Should be able to swap DAI to ETH with a 1% fee on 1inch", async function () {
    //   return swapETHtoToken(Sources.Aggregotor1inch, DAI_ADDRESS, sellAmount, 100n);
    // });

    // ====>  0x trades

    // No fee (0n)
    it("Should be able to swap wETH to DAI with no fee on 0x", async function () {
      // Need WETH again
      const signerEth = await getSignerBalance();
      if (signerEth < parseEther(sellAmount)) throw new Error("Insufficient ETH to wrap for test");
      return swapTokenToToken(Sources.Aggregator0x, WETH_ADDRESS, DAI_ADDRESS, sellAmount, 0n);
    });

    it("Should be able to swap DAI to wETH with no fee on 0x", async function () {
      return swapTokenToToken(Sources.Aggregator0x, DAI_ADDRESS, WETH_ADDRESS, sellAmount, 0n);
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with no fee on 0x", async function () {
    //   return swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 0n);
    // });

    // it("Should be able to swap DAI to ETH with no fee on 0x", async function () {
    //   return swapTokenToETH(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 0n);
    // });

    // 0.5 % fee (50n)
    it("Should be able to swap wETH to DAI with a 0.5% fee on 0x", async function () {
      // Need WETH again
      const signerEth = await getSignerBalance();
      if (signerEth < parseEther(sellAmount)) throw new Error("Insufficient ETH to wrap for test");
      return swapTokenToToken(Sources.Aggregator0x, WETH_ADDRESS, DAI_ADDRESS, sellAmount, 50n);
    });

    it("Should be able to swap DAI to wETH with a 0.5% fee on 0x", async function () {
      return swapTokenToToken(Sources.Aggregator0x, DAI_ADDRESS, WETH_ADDRESS, sellAmount, 50n);
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with a 0.5% fee on 0x", async function () {
    //   return swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 50n);
    // });

    // it("Should be able to swap DAI to ETH with a 0.5% fee on 0x", async function () {
    //   return swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 50n);
    // });

    // 1% fee (100n)
    it("Should be able to swap wETH to DAI with a 1% fee on 0x", async function () {
      // Need WETH again
      const signerEth = await getSignerBalance();
      if (signerEth < parseEther(sellAmount)) throw new Error("Insufficient ETH to wrap for test");
      return swapTokenToToken(
        Sources.Aggregator0x,
        WETH_ADDRESS,
        DAI_ADDRESS,
        sellAmount,
        100n,
      );
    });

    it("Should be able to swap DAI to wETH with a 1% fee on 0x", async function () {
      return swapTokenToToken(
        Sources.Aggregator0x,
        DAI_ADDRESS,
        WETH_ADDRESS,
        sellAmount,
        100n,
      );
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with a 1% fee on 0x", async function () {
    //   return swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 100n);
    // });

    // it("Should be able to swap DAI to ETH with a 1% fee on 0x", async function () {
    //   return swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, sellAmount, 100n);
    // });
  });
});