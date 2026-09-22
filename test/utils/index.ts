/**
 * Shared fixture for the contract test suite.
 *
 * Scope note: this module used to also carry EIP-2612 permit signing, quote
 * loading from `testdata/`, and a table of ~19 mainnet token addresses. All of
 * that existed for the aggregator replay tests, which have been removed --
 * DEX routing is owned by the Oku backend, and `test/base/Recipient.ts`
 * already covers every live swap entrypoint against mocks with no network.
 * What remains is the minimum `test/base/Admin.ts` needs.
 */
import { ZeroAddress, type ContractTransactionResponse } from "ethers";
import { IWETH__factory, OkuRouter__factory } from "../../typechain-types";

/** 1inch v4 aggregation router — registered as a swap target by `init()`. */
export const MAINNET_ADDRESS_1INCH = "0x1111111254fb6c44bac0bed2854e76f90643097d";
/** 0x exchange proxy — the second swap target registered by `init()`. */
export const MAINNET_ADDRESS_0X = "0xdef1c0ded9bec7f1a1670819833240f027b25eff";
/** Canonical mainnet WETH; `Admin.ts` funds the router through it. */
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/**
 * Deploy a fresh OkuRouter owned by signers[0] and attach to mainnet WETH.
 *
 * Assumes the caller has already forked mainnet (Admin.ts does this in its
 * `before` hook), because it attaches to the live WETH contract rather than a
 * mock.
 */
export const init = async () => {
  // Imported dynamically so this module stays usable outside a hardhat run.
  const hre = await import("hardhat");

  const [signer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;

  const wethContract = IWETH__factory.connect(WETH_ADDRESS, signer);

  const ownerAddress = await signer.getAddress();
  const okuRouterInstance = await new OkuRouter__factory(signer).deploy(
    "Oku Router",
    "1.0",
    ownerAddress,
    hre.ethers.ZeroAddress,
  );
  await okuRouterInstance.waitForDeployment();
  const instanceAddress = await okuRouterInstance.getAddress();

  let tx: ContractTransactionResponse;
  tx = await okuRouterInstance.connect(signer).updateSwapTargets(MAINNET_ADDRESS_1INCH, true);
  await tx.wait();
  tx = await okuRouterInstance.connect(signer).updateSwapTargets(MAINNET_ADDRESS_0X, true);
  await tx.wait();
  // ZeroAddress as a valid warrant signer disables warrant enforcement for
  // these tests, which are about admin surface rather than quote validation.
  tx = await okuRouterInstance.connect(signer).updateValidSigner(ZeroAddress, true);
  await tx.wait();

  const getEthVaultBalance = async () => provider.getBalance(instanceAddress);
  const getSignerBalance = async () => provider.getBalance(signer.address);

  return {
    getSignerBalance,
    getEthVaultBalance,
    okuRouterInstance,
    signer,
    wethContract,
    provider,
  };
};

export default init;
