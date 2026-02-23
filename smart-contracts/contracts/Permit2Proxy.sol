// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/uniswapV3/IPermit2.sol";

/// @title Permit2Proxy
/// @notice Stateless proxy that pulls tokens via Permit2 SignatureTransfer,
///         forwards arbitrary calldata to OkuRouter, and returns output to caller.
///         Designed for Safe smart wallets that only support Permit2 with bytes signatures.
contract Permit2Proxy {
    using SafeERC20 for IERC20;

    address public immutable okuRouter;
    IPermit2 public constant permit2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

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

    /// @notice Pull tokens via Permit2, forward calldata to OkuRouter, return output to caller.
    /// @param permit  Permit2 SignatureTransfer permit (token, amount, nonce, deadline)
    /// @param signature  Permit2 bytes signature (EIP-1271 compatible)
    /// @param buyToken  Output token address (address(0) for ETH)
    /// @param routerCalldata  Raw calldata forwarded to OkuRouter
    function execute(
        IPermit2.PermitTransferFrom calldata permit,
        bytes calldata signature,
        address buyToken,
        bytes calldata routerCalldata
    ) external payable nonReentrant {
        // 1. Pull tokens from msg.sender via Permit2
        permit2.permitTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            msg.sender,
            signature
        );

        // 2. Approve OkuRouter to pull sell tokens
        IERC20(permit.permitted.token).safeIncreaseAllowance(okuRouter, permit.permitted.amount);

        // 3. Record output balance before
        uint256 outputBefore = (buyToken == address(0))
            ? address(this).balance - msg.value
            : IERC20(buyToken).balanceOf(address(this));

        // 4. Forward call to OkuRouter
        (bool success, bytes memory result) = okuRouter.call{value: msg.value}(routerCalldata);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        // 5. Forward output to caller
        uint256 received = (buyToken == address(0))
            ? address(this).balance - outputBefore
            : IERC20(buyToken).balanceOf(address(this)) - outputBefore;
        require(received > 0, "NO_OUTPUT");

        if (buyToken == address(0)) {
            (bool ok, ) = msg.sender.call{value: received}("");
            require(ok, "ETH_TRANSFER_FAILED");
        } else {
            IERC20(buyToken).safeTransfer(msg.sender, received);
        }
    }
}
