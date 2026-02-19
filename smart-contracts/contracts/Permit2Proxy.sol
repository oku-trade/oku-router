// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IOkuRouter.sol";
import "./libraries/CanoeHelper.sol";

/// @title Permit2Proxy
/// @notice Stateless proxy that accepts tokens via Permit2 SignatureTransfer
///         and forwards swaps through OkuRouter. Designed for environments
///         (e.g. Safe smart wallets) where approve() is unavailable and only
///         Permit2 with bytes signatures is supported.
contract Permit2Proxy {
    using SafeERC20 for IERC20;

    address public immutable okuRouter;

    uint256 private _status;

    modifier nonReentrant() {
        require(_status != 2, "NON_REENTRANT");
        _status = 2;
        _;
        _status = 1;
    }

    constructor(address _okuRouter) {
        require(_okuRouter != address(0), "ZERO_ROUTER");
        okuRouter = _okuRouter;
        _status = 1;
    }

    /// @notice Accept ETH from OkuRouter during token-to-ETH swaps
    receive() external payable {}

    /// @notice Proxy for OkuRouter.fillQuoteTokenToToken.
    ///         Tokens must already be in this contract (delivered via Permit2).
    function fillQuoteTokenToToken(
        address sellTokenAddress,
        address buyTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feeAmount,
        CanoeHelper.Warrant calldata warrant
    ) external payable nonReentrant {
        require(
            IERC20(sellTokenAddress).balanceOf(address(this)) >= sellAmount,
            "INSUFFICIENT_TOKENS"
        );

        IERC20(sellTokenAddress).safeIncreaseAllowance(okuRouter, sellAmount);

        uint256 buyTokenBefore = IERC20(buyTokenAddress).balanceOf(address(this));

        IOkuRouter(okuRouter).fillQuoteTokenToToken{value: msg.value}(
            sellTokenAddress,
            buyTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feeAmount,
            warrant
        );

        uint256 tokensReceived = IERC20(buyTokenAddress).balanceOf(address(this)) - buyTokenBefore;
        require(tokensReceived > 0, "NO_OUTPUT_TOKENS");

        IERC20(buyTokenAddress).safeTransfer(msg.sender, tokensReceived);
    }

    /// @notice Proxy for OkuRouter.fillQuoteTokenToEth.
    ///         Tokens must already be in this contract (delivered via Permit2).
    function fillQuoteTokenToEth(
        address sellTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feePercentageBasisPoints,
        CanoeHelper.Warrant calldata warrant
    ) external payable nonReentrant {
        require(
            IERC20(sellTokenAddress).balanceOf(address(this)) >= sellAmount,
            "INSUFFICIENT_TOKENS"
        );

        IERC20(sellTokenAddress).safeIncreaseAllowance(okuRouter, sellAmount);

        uint256 ethBefore = address(this).balance - msg.value;

        IOkuRouter(okuRouter).fillQuoteTokenToEth{value: msg.value}(
            sellTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feePercentageBasisPoints,
            warrant
        );

        uint256 ethReceived = address(this).balance - ethBefore;
        require(ethReceived > 0, "NO_ETH_RECEIVED");

        (bool success, ) = msg.sender.call{value: ethReceived}("");
        require(success, "ETH_TRANSFER_FAILED");
    }
}
