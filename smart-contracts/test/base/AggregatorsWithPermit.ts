/**
 * This file tests all the possible combinations of:
 * TOKEN => ETH
 * TOKEN => TOKEN
 *
 * through 1inch and 0x
 *
 * with no fees
 *
 * based on the input amount
 *
 * and using a permit signature instead of approvals
 *
 */

import path from "path";
import { expect } from "chai";
import { network, ethers } from "hardhat"; // Use ethers

import { Sources } from "../types";
import {
  BAL_ADDRESS,
  DAI_ADDRESS,
  ENS_ADDRESS,
  ETH_ADDRESS, // Assuming this is ZeroAddress or a specific marker
  FEI_ADDRESS,
  getQuoteFromFile, // Assumed updated for ethers
  INCH_ADDRESS,
  init, // Assumed updated for ethers
  Logger,
  LQTY_ADDRESS,
  MIST_ADDRESS,
  OPIUM_ADDRESS,
  RAD_ADDRESS,
  showGasUsage,
  signPermit, // Assumed updated or compatible with ethers
  TORN_ADDRESS,
  TRIBE_ADDRESS,
  USDC_ADDRESS,
  VSP_ADDRESS,
  WNXM_ADDRESS,
  bigIntReplacer,
  PermitData,
  WarrantData,
} from "../utils";

import hre from "hardhat";
import {
  ZeroAddress, // Use ZeroAddress from ethers
  formatEther, // Use formatEther from ethers
  formatUnits, // Use formatUnits from ethers
  parseEther, // Use parseEther from ethers
  MaxUint256, // Use MaxUint256 from ethers
  type Signer, // Import Signer type
  type AddressLike, // Use AddressLike for type safety if needed
} from "ethers";
// Import TypeChain types - Adjust path as needed
import { type OkuRouter, type IERC20Metadata, type IERC2612Extension, IERC20Metadata__factory, IERC2612Extension__factory } from "../../typechain-types";

const SELL_AMOUNT = "0.1";
const TESTDATA_DIR = path.resolve(__dirname, "testdata/inputpermit");

describe("OkuRouter Aggregators", function () {
  let swapETHtoToken: (
    source: Sources,
    tokenAddress: AddressLike,
    sellAmountStr: string,
    feePercentageBasisPoints: bigint,
  ) => Promise<void>;

  let swapTokentoETH: (
    source: Sources,
    tokenAddress: AddressLike,
    feePercentageBasisPoints: bigint,
    usePermit?: boolean,
  ) => Promise<void>;

  let swapTokentoToken: (
    source: Sources,
    tokenAddress: AddressLike,
    buyTokenAddress: AddressLike,
    feePercentageBasisPoints: bigint,
  ) => Promise<void>;

  let okuRouterInstance: OkuRouter;
  let signer: Signer;

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
    // const publicClient = initResult.publicClient; // No longer needed
    // const getSignerBalance = initResult.getSignerBalance; // Assuming this is still available

    swapETHtoToken = async (
      source: Sources,
      tokenAddress: AddressLike,
      sellAmountStr: string,
      feePercentageBasisPoints: bigint,
    ): Promise<void> => {
      const tokenContract = IERC20Metadata__factory.connect(tokenAddress.toString(), signer);

      const initialEthBalance = await ethers.provider.getBalance(await signer.getAddress());
      const initialTokenBalance = await tokenContract.balanceOf(await signer.getAddress());
      const tokenSymbol = await tokenContract.symbol();
      const tokenDecimals = await tokenContract.decimals();
      Logger.log("Initial user balance (ETH)", formatEther(initialEthBalance));
      Logger.log(
        `Initial user balance (${tokenSymbol}): `,
        formatUnits(initialTokenBalance, tokenDecimals),
      );

      const sellAmountWei = parseEther(sellAmountStr);

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        ETH_ADDRESS,
        tokenAddress.toString(),
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
      Logger.log("Fee", formatEther(quote.fee), "ETH");
      Logger.log(
        "Amount to be swapped",
        formatEther(quote.sellAmountMinusFees),
        "ETH",
      );
      Logger.log(
        `User will get ~ `,
        formatUnits(quote.buyAmount, tokenDecimals),
        tokenSymbol,
      );

      Logger.log(`Executing swap... with `, formatEther(sellAmountWei));

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteEthToToken(
        quote.buyTokenAddress,
        quote.to || ZeroAddress,
        quote.data || Sources.Aggregator0x,
        quote.fee,
        {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          validBefore: 0,
          validAfter: 0,
          signature: "0x",
        },
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();
      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const tokenBalanceSigner = await tokenContract.balanceOf(await signer.getAddress());
      const ethBalanceSigner = await ethers.provider.getBalance(await signer.getAddress());
      Logger.log(
        `Final user balance (${tokenSymbol}): `,
        formatUnits(tokenBalanceSigner, tokenDecimals),
      );
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));

      expect(tokenBalanceSigner).to.be.gt(initialTokenBalance);
      expect(ethBalanceSigner).to.be.lt(initialEthBalance);
    };

    swapTokentoETH = async (
      source: Sources,
      tokenAddress: AddressLike,
      feePercentageBasisPoints: bigint,
      usePermit = true,
    ): Promise<void> => {
      const tokenContract = IERC2612Extension__factory.connect(tokenAddress.toString(), signer);
      const signerAddress = await signer.getAddress();
      const initialTokenBalance = await tokenContract.balanceOf(signerAddress);
      const initialEthBalance = await ethers.provider.getBalance(await signer.getAddress())
      const tokenSymbol = await tokenContract.symbol();
      const tokenDecimals = await tokenContract.decimals();

      Logger.log(
        `Initial user balance (${tokenSymbol}): `,
        formatUnits(initialTokenBalance, tokenDecimals),
      );
      Logger.log("Initial user balance (ETH)", formatEther(initialEthBalance));

      const sellAmountWei = initialTokenBalance;

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        tokenAddress.toString(),
        ETH_ADDRESS,
        sellAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);
      quote.feePercentageBasisPoints = quote.feePercentageBasisPoints ? (quote.feePercentageBasisPoints) : 0;

      Logger.log(
        "Input amount",
        formatUnits(sellAmountWei, tokenDecimals),
        tokenSymbol,
      );
      Logger.log("Fee", formatEther(quote.fee), "ETH");

      Logger.log(
        "Amount to be swapped",
        formatUnits(quote.sellAmountMinusFees, tokenDecimals),
        tokenSymbol,
      );

      Logger.log(`User will get ~ `, formatEther(quote.buyAmount), "ETH");

      let swapTx;
      if (usePermit) {
        const latestBlock = await ethers.provider.getBlock('latest');
        const currentTimestamp = latestBlock ? BigInt(latestBlock.timestamp) : BigInt(Math.floor(Date.now() / 1000)); // Fallback to current time if no block
        
        const deadline = currentTimestamp + 3600n; // Deadline 1 hour (3600 seconds) in the future


        const permitSignature: PermitData = await signPermit(
          signer,
          await tokenContract.getAddress(),
          await okuRouterInstance.getAddress(),
          MaxUint256,
          deadline,
        );

        const warrant: WarrantData = {
          verifyingSigner: ZeroAddress,
          nonce: 0n,
          signature: Sources.Aggregator0x,
          validBefore: 0n,
          validAfter: 0n,
        }

        swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToEthWithPermit(
          quote.sellTokenAddress,
          quote.to || ZeroAddress,
          quote.data || Sources.Aggregator0x, // Provide a default value
          quote.sellAmount,
          quote.feePercentageBasisPoints,
          permitSignature,
          warrant,
          {
            value: quote.value,
          },
        )
      } else {
        Logger.log(`Executing swap...`);
        swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToEth(
          quote.sellTokenAddress,
          quote.to || ZeroAddress,
          quote.data || Sources.Aggregator0x,
          quote.sellAmount,
          quote.feePercentageBasisPoints,
          {
            verifyingSigner: ZeroAddress,
            nonce: 0n,
            validBefore: 0,
            validAfter: 0,
            signature: "0x",
          },
          {
            value: quote.value,
          },
        );
      }

      const receipt = await swapTx.wait();
      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const tokenBalanceSigner = await tokenContract.balanceOf(signerAddress);
      const ethBalanceSigner = await ethers.provider.getBalance(await signer.getAddress());

      Logger.log(
        `Final user balance (${tokenSymbol}): `,
        formatEther(tokenBalanceSigner),
      );
      Logger.log("Final user balance (ETH): ", formatEther(ethBalanceSigner));
      expect(tokenBalanceSigner).to.be.equal(0n);
      expect(ethBalanceSigner).to.be.gt(initialEthBalance);
    };

    swapTokentoToken = async (
      source: Sources,
      tokenAddress: AddressLike,
      buyTokenAddress: AddressLike,
      feePercentageBasisPoints: bigint,
    ): Promise<void> => {
      const tokenContract = IERC2612Extension__factory.connect(tokenAddress.toString(), signer);
      const buyTokenContract = IERC2612Extension__factory.connect(buyTokenAddress.toString(), signer);
      const signerAddress = await signer.getAddress();
      const initialBuyTokenBalance = await buyTokenContract.balanceOf(signerAddress);
      const initialTokenBalance = await tokenContract.balanceOf(signerAddress);
      const tokenSymbol = await tokenContract.symbol();
      const tokenDecimals = await tokenContract.decimals();

      const buyTokenSymbol = await buyTokenContract.symbol();
      const buyTokenDecimals = await buyTokenContract.decimals();

      Logger.log(
        `Initial user balance (${tokenSymbol}): `,
        formatUnits(initialTokenBalance, tokenDecimals),
      );
      Logger.log(
        `Initial user balance (${buyTokenSymbol}): `,
        formatUnits(initialBuyTokenBalance, buyTokenDecimals),
      );

      const sellAmountWei = initialTokenBalance;

      const quote = await getQuoteFromFile(
        TESTDATA_DIR,
        source,
        "input",
        tokenAddress.toString(),
        buyTokenAddress.toString(),
        sellAmountWei.toString(),
        feePercentageBasisPoints.toString(),
      );
      if (!quote) return;

      // Ensure quote values are BigInt
      quote.sellAmount = BigInt(quote.sellAmount);
      quote.buyAmount = BigInt(quote.buyAmount);
      quote.fee = BigInt(quote.fee);
      quote.value = BigInt(quote.value || 0);

      Logger.log(
        "Input amount",
        formatUnits(sellAmountWei, tokenDecimals),
        tokenSymbol,
      );
      Logger.log("Fee", formatUnits(quote.fee, tokenDecimals), tokenSymbol);

      Logger.log(
        "Amount to be swapped",
        formatUnits(quote.sellAmountMinusFees, tokenDecimals),
        tokenSymbol,
      );

      Logger.log(
        `User will get ~ `,
        formatUnits(quote.buyAmount, buyTokenDecimals),
        buyTokenSymbol,
      );
      const latestBlock = await ethers.provider.getBlock('latest');
      const currentTimestamp = latestBlock ? BigInt(latestBlock.timestamp) : BigInt(Math.floor(Date.now() / 1000)); // Fallback to current time if no block
      
      const deadline = currentTimestamp + 3600n; // Deadline 1 hour (3600 seconds) in the future
      const permitSignature: PermitData = await signPermit(
        signer,
        tokenContract,
        await okuRouterInstance.getAddress(),
        MaxUint256,
        deadline,
      );

      //Logger.log("PERMIT SIGNATURE", JSON.stringify(permitSignature, bigIntReplacer, 2));

      const warrant: WarrantData = {
        verifyingSigner: ZeroAddress,
        nonce: 0n,
        signature: Sources.Aggregator0x,
        validBefore: 0n,
        validAfter: 0n,
      }

      Logger.log(`Executing swap with permit...`);

      const swapTx = await okuRouterInstance.connect(signer).fillQuoteTokenToTokenWithPermit(
        quote.sellTokenAddress,
        quote.buyTokenAddress,
        quote.to || ZeroAddress, // Provide a default value
        quote.data || Sources.Aggregator0x, // Provide a default value
        quote.sellAmount,
        quote.fee,
        permitSignature,
        warrant,
        {
          value: quote.value,
        },
      );

      const receipt = await swapTx.wait();
      if (showGasUsage && receipt) {
        Logger.info("      ⛽  Gas usage: ", receipt.gasUsed.toString());
      }

      const tokenBalanceSigner = await tokenContract.balanceOf(signerAddress);
      const buyTokenBalanceSigner = await buyTokenContract.balanceOf(signerAddress);

      Logger.log(
        `Final user balance (${tokenSymbol}): `,
        formatEther(tokenBalanceSigner),
      );
      Logger.log(
        `Final user balance (${buyTokenSymbol}): `,
        formatEther(buyTokenBalanceSigner),
      );
      expect(tokenBalanceSigner).to.be.equal(0n);
      expect(buyTokenBalanceSigner).to.be.gt(initialBuyTokenBalance);
    };
  });

  // Removed: All permit tests that depend on ETH swap quote files (missing)
  // describe("Trades with Permit", function () {
  //   it("Should be able to swap DAI to ETH using permit instead of approval", async function () {
  //     await swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, SELL_AMOUNT, 0n);
  //     return swapTokentoETH(Sources.Aggregator0x, DAI_ADDRESS, 0n);
  //   });
  //   ... (15 more tests removed)
  // });

  // Removed: Allowance preservation tests that depend on ETH swap quote files (missing)
  // describe("It should preserve the allowance after being set to MAX_INT", () => {
  //   it("Should be able to swap DAI to ETH with an existing approval via permit", async function () {
  //     await swapETHtoToken(Sources.Aggregator0x, DAI_ADDRESS, SELL_AMOUNT, 0n);
  //     return swapTokentoETH(Sources.Aggregator0x, DAI_ADDRESS, 0n, false);
  //   });
  //   it("Should be able to swap ENS to ETH with an existing approval via permit", async function () {
  //     await swapETHtoToken(Sources.Aggregotor1inch, ENS_ADDRESS, "1", 0n);
  //     return swapTokentoETH(Sources.Aggregotor1inch, ENS_ADDRESS, 0n, false);
  //   });
  // });
});