// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "../libraries/CanoeHelper.sol";

interface IOkuRouter {
    function fillQuoteTokenToToken(
        address sellTokenAddress,
        address buyTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feeAmount,
        CanoeHelper.Warrant calldata warrant
    ) external payable;

    function fillQuoteTokenToEth(
        address sellTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feePercentageBasisPoints,
        CanoeHelper.Warrant calldata warrant
    ) external payable;
}
