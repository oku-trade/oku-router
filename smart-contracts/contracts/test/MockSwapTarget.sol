// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title MockSwapTarget
/// @notice Test-only contract that simulates a DEX aggregator.
///         This contract MUST NEVER be deployed to a live chain.
contract MockSwapTarget {
    /// @dev Simulates a token-to-token swap.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    /// @dev Simulates a token-to-ETH swap.
    function swapToEth(
        address tokenIn,
        uint256 amountIn
    ) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "ETH_SEND_FAILED");
    }

    /// @dev Simulates an ETH-to-token swap.
    function swapFromEth(
        address tokenOut,
        uint256 amountOut
    ) external payable {
        require(msg.value > 0, "NO_ETH");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    receive() external payable {}
}
