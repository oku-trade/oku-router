// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.7.0;

/**
 * @title IOKXDexRouter
 * @notice Interface for OKX DEX Aggregator Router on Optimism
 * @dev OKX uses a dual-contract architecture:
 *      - Router Contract (0xC44C6550a3B13116F6fD593e1ec963d5aE78C4C8): Receives swap calldata
 *      - Approval Target (0x68D6B739D2020067D1e2F713b999dA97E4d54812): Needs token approval
 */
interface IOKXDexRouter {
    /**
     * @notice Base swap request structure used across OKX swap functions
     * @dev This struct is typically passed to swap functions like dagSwapTo, smartSwapTo, etc.
     */
    struct BaseRequest {
        address fromToken;          // Source token address
        address toToken;            // Destination token address
        uint256 fromTokenAmount;    // Input amount
        uint256 minReturnAmount;    // Minimum output amount (slippage protection)
        uint256 deadLine;           // Transaction expiration timestamp
    }

    /**
     * @notice DAG-based swap function (Directed Acyclic Graph routing)
     * @dev One of the primary swap functions used by OKX for multi-hop swaps
     * @param baseRequest Core swap parameters (tokens, amounts, deadline)
     * @param callDataConcat Encoded routing data from OKX API
     * @param useInternalBalance Whether to use internal balance (typically false)
     * @param toAddress Recipient address for output tokens
     * @return returnAmount Actual amount of output tokens received
     */
    function dagSwapTo(
        BaseRequest calldata baseRequest,
        bytes calldata callDataConcat,
        bool useInternalBalance,
        address toAddress
    ) external payable returns (uint256 returnAmount);

    /**
     * @notice Smart swap function with optimized routing
     * @dev Alternative swap function for simpler routing cases
     * @param baseRequest Core swap parameters
     * @param callDataConcat Encoded routing data from OKX API
     * @param toAddress Recipient address
     * @return returnAmount Actual amount received
     */
    function smartSwapTo(
        BaseRequest calldata baseRequest,
        bytes calldata callDataConcat,
        address toAddress
    ) external payable returns (uint256 returnAmount);

    /**
     * @notice Uniswap V3 specific swap function
     * @dev Used when OKX routes through Uniswap V3 pools
     * @param baseRequest Core swap parameters
     * @param callDataConcat V3-specific routing data
     * @param toAddress Recipient address
     * @return returnAmount Actual amount received
     */
    function uniswapV3SwapTo(
        BaseRequest calldata baseRequest,
        bytes calldata callDataConcat,
        address toAddress
    ) external payable returns (uint256 returnAmount);
}
