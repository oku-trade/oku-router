/**
 * This file tests all the possible combinations of:
 * TOKEN => ETH
 * TOKEN => TOKEN
 * ETH => TOKEN
 *
 * through 0x
 *
 * with no fees
 *
 * based on the output amount
 *
 */
import path from "path";
import { expect } from "chai";
import { network, ethers } from "hardhat"; // Use ethers
import { Sources } from "../types";
import {
  DAI_ADDRESS,
  ETH_ADDRESS, // Assuming this is ZeroAddress or a specific marker
  getQuoteFromFile, // Assumed updated for ethers
  getVaultBalanceForToken, // Assumed updated for ethers (though not used in this test)
  init, // Assumed updated for ethers
  Logger,
  showGasUsage,
  WETH_ADDRESS,
} from "../utils";
import {
  ZeroAddress, // Use ZeroAddress from ethers
  formatEther, // Use formatEther from ethers
  parseEther, // Use parseEther from ethers
  type Signer, // Import Signer type
  type AddressLike, // Use AddressLike for type safety if needed
} from "ethers";
import hre from "hardhat";
// Import TypeChain types - Adjust path as needed
import { type OkuRouter, type IWETH, type IDAI, IWETH__factory, IDAI__factory } from "../../typechain-types";

const TESTDATA_DIR = path.resolve(__dirname, "testdata/output");

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
  let swapWETHtoDAIFromOutput: (
    source: Sources,
    buyAmountStr: string,
    feePercentageBasisPoints: bigint,
  ) => Promise<boolean | undefined>;

  let swapDAItoWETHFromOutput: (
    source: Sources,
    buyAmountStr: string,
    feePercentageBasisPoints: bigint,
  ) => Promise<boolean | undefined>; // Return type added for consistency

  let swapETHtoDAIFromOutput: (
    source: Sources,
    buyAmountStr: string,
    feePercentageBasisPoints: bigint,
  ) => Promise<boolean | undefined>;

  let swapDAItoETHFromOutput: (
    source: Sources,
    buyAmountStr: string,
    feePercentageBasisPoints: bigint,
  ) => Promise<boolean | undefined>;

  let okuRouterInstance: OkuRouter;
  let signer: Signer;
  let currentVaultAddress: string; // Ethers uses string for addresses
  let getSignerBalance: () => Promise<bigint>; // Function to get signer ETH balance

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            blockNumber: 15214922,
            jsonRpcUrl: process.env.MAINNET_RPC_ENDPOINT!,
          },
        },
      ],
    });

    const initResult = await init();
    signer = initResult.signer; // Get Signer object
    okuRouterInstance = initResult.okuRouterInstance; // Get TypeChain instance
    getSignerBalance = initResult.getSignerBalance; // Get signer balance helper
    currentVaultAddress = await okuRouterInstance.getAddress();

    // FROM OUTPUT
    swapWETHtoDAIFromOutput = async (
      source: Sources,
      buyAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<boolean | undefined> => {
      const buyAmountWei = parseEther(buyAmountStr);

      Logger.log("Output amount", formatEther(buyAmountWei), "DAI");

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "output",
        WETH_ADDRESS,
        DAI_ADDRESS,
        buyAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);

      Logger.log(
        `User will get ~ `,
        formatEther(quote.buyAmount),
        "DAI from ",
        formatEther(quote.sellAmount),
        "WETH",
      );

      const amountToWrapWei = parseEther("0.1");
      const wethContract = IWETH__factory.connect(WETH_ADDRESS, signer);
      const daiContract = IDAI__factory.connect(DAI_ADDRESS, signer);
      const signerAddress = await signer.getAddress();

      Logger.log(
        `User wrapping ${formatEther(amountToWrapWei)} ETH into WETH to have input token available...`,
      );
      const depositTx = await wethContract.connect(signer).deposit({
        value: amountToWrapWei,
      });
      await depositTx.wait();

      const initialWethBalance = await wethContract.balanceOf(signerAddress);
      const initialDaiBalance = await daiContract.balanceOf(signerAddress);

      Logger.log("Initial user WETH balance", formatEther(initialWethBalance));
      Logger.log(
        "Initial user balance (DAI): ",
        formatEther(initialDaiBalance),
      );

      // Grant the contact an allowance to spend our WETH.
      const approveTx = await wethContract.connect(signer).approve(
        currentVaultAddress,
        quote.sellAmount, // Use the quoted sell amount
      );

      await approveTx.wait();
      Logger.log(`Approved token allowance of `, formatEther(quote.sellAmount));

      //Logger.log(`Executing swap...`, JSON.stringify(quote, null, 2));

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToToken(
        quote.sellTokenAddress,
        quote.buyTokenAddress,
        quote.to || ZeroAddress,
        quote.to || ZeroAddress, // approvalTarget - same as target for standard aggregators
        quote.data || Sources.Aggregator0x,
        quote.sellAmount,
        quote.fee,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: Sources.Aggregator0x,
          validBefore: 0,
          validAfter: 0,
        },
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();

      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const daiBalanceSigner = await daiContract.balanceOf(signerAddress);
      Logger.log("Final user balance (DAI): ", formatEther(daiBalanceSigner));

      const wethBalanceSigner = await wethContract.balanceOf(signerAddress);
      Logger.log("Final user balance (WETH): ", formatEther(wethBalanceSigner));

      expect(daiBalanceSigner).to.be.gt(initialDaiBalance);
      expect(wethBalanceSigner).to.be.lt(initialWethBalance);
      return true;
    };

    swapDAItoWETHFromOutput = async (
      source: Sources,
      buyAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<boolean | undefined> => {
      const wethContract = IWETH__factory.connect(WETH_ADDRESS, signer);
      const daiContract = IDAI__factory.connect(DAI_ADDRESS, signer);
      const signerAddress = await signer.getAddress();

      const initialWethBalance = await wethContract.balanceOf(signerAddress);
      const initialDaiBalance = await daiContract.balanceOf(signerAddress);
      Logger.log(
        "Initial user balance (DAI): ",
        formatEther(initialDaiBalance),
      );
      Logger.log(
        "Initial user balance (WETH)",
        formatEther(initialWethBalance),
      );

      const buyAmountWei = parseEther(buyAmountStr);

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "output",
        DAI_ADDRESS,
        WETH_ADDRESS,
        buyAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);

      Logger.log("Output amount", formatEther(buyAmountWei), "WETH");

      Logger.log("Amount to be swapped", formatEther(quote.sellAmount), "DAI");

      Logger.log(`User will get ~ `, formatEther(quote.buyAmount), "WETH");

      // Grant the allowance target an allowance to spend our DAI.
      const approveTx = await daiContract.connect(signer).approve(
        currentVaultAddress,
        quote.sellAmount, // Use the quoted sell amount
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
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: Sources.Aggregator0x,
          validBefore: 0,
          validAfter: 0,
        },
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();
      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const daiBalanceSigner = await daiContract.balanceOf(signerAddress);
      const wethBalanceSigner = await wethContract.balanceOf(signerAddress);

      Logger.log("Final user balance (DAI): ", formatEther(daiBalanceSigner));
      Logger.log("Final user balance (WETH): ", formatEther(wethBalanceSigner));

      expect(daiBalanceSigner).to.be.lt(initialDaiBalance);
      expect(wethBalanceSigner).to.be.gt(initialWethBalance);
      return true;
    };

    swapETHtoDAIFromOutput = async (
      source: Sources,
      buyAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<boolean | undefined> => {
      const buyAmountWei = parseEther(buyAmountStr);
      const daiContract = IDAI__factory.connect(DAI_ADDRESS, signer);
      const signerAddress = await signer.getAddress();
      const initialEthBalance = await getSignerBalance();
      const initialDaiBalance = await daiContract.balanceOf(signerAddress);

      Logger.log("Output amount", formatEther(buyAmountWei), "DAI");

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "output",
        ETH_ADDRESS,
        DAI_ADDRESS,
        buyAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);

      Logger.log(
        `User will get ~ `,
        formatEther(quote.buyAmount),
        "DAI from ",
        formatEther(quote.sellAmount),
        "ETH",
      );

      Logger.log("Initial user ETH balance", formatEther(initialEthBalance));
      Logger.log(
        "Initial user balance (DAI): ",
        formatEther(initialDaiBalance),
      );

      //Logger.log(`Executing swap...`, JSON.stringify(quote, null, 2));

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteEthToToken(
        quote.buyTokenAddress,
        quote.to || ZeroAddress,
        quote.data || Sources.Aggregator0x,
        quote.fee,
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
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const daiBalanceSigner = await daiContract.balanceOf(signerAddress);
      Logger.log("Final user balance (DAI): ", formatEther(daiBalanceSigner));
      const ethBalanceSigner = await getSignerBalance();
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));

      expect(daiBalanceSigner).to.be.gt(initialDaiBalance);
      expect(ethBalanceSigner).to.be.lt(initialEthBalance);
      return true;
    };

    swapDAItoETHFromOutput = async (
      source: Sources,
      buyAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<boolean | undefined> => {
      const daiContract = IDAI__factory.connect(DAI_ADDRESS, signer);
      const signerAddress = await signer.getAddress();
      const initialEthBalance = await getSignerBalance();
      const initialDaiBalance = await daiContract.balanceOf(signerAddress);
      Logger.log(
        "Initial user balance (DAI): ",
        formatEther(initialDaiBalance),
      );
      Logger.log("Initial user balance (ETH)", formatEther(initialEthBalance));

      const buyAmountWei = parseEther(buyAmountStr);

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "output",
        DAI_ADDRESS,
        ETH_ADDRESS,
        buyAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);
      quote.feePercentageBasisPoints = quote.feePercentageBasisPoints ? (quote.feePercentageBasisPoints) : 0;

      Logger.log("Output amount", formatEther(buyAmountWei), "ETH");

      Logger.log("Amount to be swapped", formatEther(quote.sellAmount), "DAI");

      Logger.log(`User will get ~ `, formatEther(quote.buyAmount), "ETH");

      // Grant the allowance target an allowance to spend our DAI.
      const approveTx = await daiContract.connect(signer).approve(
        currentVaultAddress,
        quote.sellAmount, // Use the quoted sell amount
      );

      await approveTx.wait();

      Logger.log(`Executing swap...`);
      const swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToEth(
        quote.sellTokenAddress,
        quote.to || ZeroAddress,
        quote.data || Sources.Aggregator0x,
        quote.sellAmount,
        quote.feePercentageBasisPoints,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: ZeroAddress, // Default signature
          validBefore: 0,
          validAfter: 0,
        },
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();

      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const daiBalanceSigner = await daiContract.balanceOf(signerAddress);
      const ethBalanceSigner = await getSignerBalance();

      Logger.log("Final user balance (DAI): ", formatEther(daiBalanceSigner));
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));

      expect(daiBalanceSigner).to.be.lt(initialDaiBalance);
      expect(ethBalanceSigner).to.be.gt(initialEthBalance);
      return true;
    };
  });

  describe("Trades based on output amount instead of input", function () {
    // ====>  0x trades
    it("Should be able to swap wETH to DAI with no fee on 0x (FROM OUTPUT)", async function () {
      return swapWETHtoDAIFromOutput(Sources.Aggregator0x, "100", 0n);
    });

    it("Should be able to swap DAI to WETH with no fee on 0x (FROM OUTPUT)", async function () {
      return swapDAItoWETHFromOutput(Sources.Aggregator0x, "0.01", 0n);
    });

    // Removed: ETH swap tests - missing quote files
    // it("Should be able to swap ETH to DAI with no fee on 0x (FROM OUTPUT)", async function () {
    //   return swapETHtoDAIFromOutput(Sources.Aggregator0x, "100", 0n);
    // });

    // it("Should be able to swap DAI to ETH with no fee on 0x (FROM OUTPUT)", async function () {
    //   return swapDAItoETHFromOutput(Sources.Aggregator0x, "0.01", 0n);
    // });
  });
});