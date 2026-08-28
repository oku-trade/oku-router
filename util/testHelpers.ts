import { AddressLike, BigNumberish, BytesLike, Signer } from "ethers";
import { ISwapRouter02__factory } from "../typechain-types";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { IERC20__factory } from "../typechain-types/factories/contracts/interfaces/openzeppelin";
import { network, ethers } from "hardhat";

export type ExactInputSingleParams = {
    tokenIn: AddressLike,
    tokenOut: AddressLike,
    fee: BigNumberish,
    recipient: AddressLike,
    amountIn: BigNumberish,
    amountOutMinimum: BigNumberish,
    sqrtPriceLimitX96: BigNumberish
}

export const generateUniTxData = async (
    tokenIn: AddressLike,
    tokenOut: AddressLike,
    amountIn: bigint,
    router: AddressLike,
    poolFee: number,
    target: AddressLike,
    amountOutMin: bigint
): Promise<BytesLike> => {
    const signer = await ethers.getSigner(target.toString())
    const ROUTER = ISwapRouter02__factory.connect(router.toString(), signer)
    const params: ExactInputSingleParams = {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        fee: poolFee,
        recipient: target,
        amountIn: amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n
    }

    const txData = (await ROUTER.exactInputSingle.populateTransaction(params)).data
    return txData
}

export const stealMoney = async (
    from: string,
    to: string,
    tokenAddr: string,
    amount: BigNumberish
) => {
    await setBalance(from, ethers.parseEther("5"))

    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [from],
    });
    const robberee = await ethers.getSigner(from);
    const money = IERC20__factory.connect(tokenAddr, robberee);
    await money.connect(robberee).transfer(to, amount);
    await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [from],
    });
    return;
};
