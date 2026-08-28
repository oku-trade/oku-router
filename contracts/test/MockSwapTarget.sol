// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title MockSwapTarget
/// @notice Test-only contract that simulates a DEX aggregator.
///         It consumes the full allowance of tokenIn from the caller,
///         then mints/transfers tokenOut back to the caller (the router).
///         For ETH output swaps, it sends ETH back to the caller.
///         This contract MUST NEVER be deployed to a live chain.
contract MockSwapTarget {
    /// @dev Simulates a token-to-token swap.
    ///      Pulls tokenIn from msg.sender (the router), mints tokenOut to msg.sender.
    /// @param tokenIn The token being sold
    /// @param tokenOut The token being bought (must be a MockERC20)
    /// @param amountIn Amount of tokenIn to pull
    /// @param amountOut Amount of tokenOut to mint
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
    ///      Pulls tokenIn from msg.sender, sends ETH back.
    /// @param tokenIn The token being sold
    /// @param amountIn Amount of tokenIn to pull
    function swapToEth(
        address tokenIn,
        uint256 amountIn
    ) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        // Send the contract's ETH balance to the caller (router)
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "ETH_SEND_FAILED");
    }

    /// @dev Simulates an ETH-to-token swap.
    ///      Accepts ETH via msg.value, mints tokenOut to msg.sender.
    /// @param tokenOut The token being bought (must be a MockERC20)
    /// @param amountOut Amount of tokenOut to mint
    function swapFromEth(
        address tokenOut,
        uint256 amountOut
    ) external payable {
        require(msg.value > 0, "NO_ETH");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    /// @dev Accept ETH (needed for receiving ETH to fund swapToEth)
    receive() external payable {}
}
