// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/uniswapV3/IPermit2.sol";

/// @title Permit2Proxy
/// @notice Stateless proxy that pulls tokens via Permit2, forwards arbitrary
///         calldata to OkuRouter, and returns the output to the caller.
///
///         Two entry points are supported so the same proxy contract can
///         serve every Permit2-capable wallet on every chain:
///
///         1. `execute` — Permit2 SignatureTransfer (`permitTransferFrom`).
///            Used by Safe smart wallets and any EOA that signs a fresh
///            permit per swap. The signature *is* the authorization; no
///            on-chain Permit2 allowance is required.
///
///         2. `executeAllowance` — Permit2 AllowanceTransfer (`transferFrom`).
///            Used by World App / MiniKit v2 mini apps, which dropped
///            SignatureTransfer support in v2 and now batch
///            `Permit2.approve(token, proxy, amount, 0)` + the proxy call
///            into a single UserOp. The proxy consumes the just-granted
///            Permit2 allowance via `permit2.transferFrom`.
///
///         Both paths share the same downstream pipeline
///         (`_forwardAndReturn`), so behavioral drift between them is
///         impossible by construction.
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

    /// @notice Accept ETH from OkuRouter during token-to-ETH swaps.
    /// @dev Unrestricted: this proxy holds no funds between calls and any
    ///      stray ETH would be swept out via the next caller's
    ///      `_forwardAndReturn` accounting (output diff vs. snapshot).
    receive() external payable {}

    /// @notice Permit2 SignatureTransfer entry point.
    /// @dev    Used by Safe smart wallets and EOAs that sign a fresh permit
    ///         per swap. The signed permit *is* the authorization; tokens
    ///         move into the proxy as part of signature verification.
    /// @param permit          Permit2 SignatureTransfer permit (token, amount, nonce, deadline).
    /// @param signature       Permit2 bytes signature (EIP-1271 compatible for smart wallets).
    /// @param buyToken        Output token address (`address(0)` for ETH).
    /// @param routerCalldata  Raw calldata forwarded to OkuRouter.
    function execute(
        IPermit2.PermitTransferFrom calldata permit,
        bytes calldata signature,
        address buyToken,
        bytes calldata routerCalldata
    ) external payable nonReentrant {
        // 1. Pull tokens from msg.sender via Permit2 SignatureTransfer.
        permit2.permitTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            msg.sender,
            signature
        );

        // 2..5. Approve, snapshot, forward, return.
        _forwardAndReturn(
            permit.permitted.token,
            permit.permitted.amount,
            buyToken,
            routerCalldata
        );
    }

    /// @notice Permit2 AllowanceTransfer entry point (MiniKit v2 / World App).
    /// @dev    Expects msg.sender to have an active Permit2 allowance for
    ///         (`sellToken`, this proxy, ≥ `sellAmount`). MiniKit v2's
    ///         standard pattern is to batch `Permit2.approve(sellToken,
    ///         proxy, sellAmount, 0)` and this call in a single UserOp:
    ///         the `expiration = 0` allowance is consumed in the same
    ///         transaction by the `permit2.transferFrom` below. Pre-existing
    ///         non-expired allowances are also acceptable, so this entry
    ///         point doubles as a generic AllowanceTransfer flow for
    ///         non-MiniKit callers.
    /// @param sellToken       ERC20 to pull from msg.sender via Permit2.
    /// @param sellAmount      Amount to pull (Permit2 AllowanceTransfer is
    ///                        bounded to uint160 by spec).
    /// @param buyToken        Output token address (`address(0)` for ETH).
    /// @param routerCalldata  Raw calldata forwarded to OkuRouter.
    function executeAllowance(
        address sellToken,
        uint160 sellAmount,
        address buyToken,
        bytes calldata routerCalldata
    ) external payable nonReentrant {
        // 1. Pull tokens from msg.sender via Permit2 AllowanceTransfer.
        //    Permit2 enforces the allowance + expiration check; the
        //    allowance amount decrements by `sellAmount` on success.
        permit2.transferFrom(msg.sender, address(this), sellAmount, sellToken);

        // 2..5. Approve, snapshot, forward, return. Widen sellAmount to
        //       uint256 for the ERC20 / OkuRouter side, which expects uint256.
        _forwardAndReturn(sellToken, uint256(sellAmount), buyToken, routerCalldata);
    }

    /// @dev Shared post-pull pipeline for both entry points. Approves
    ///      OkuRouter, snapshots the buy-token balance, forwards the
    ///      caller-supplied calldata verbatim, then forwards any output
    ///      delta back to msg.sender. Calldata MUST be forwarded verbatim
    ///      because OkuRouter's warrant signature is over
    ///      `keccak256(routerCalldata)` — any re-encoding here would
    ///      invalidate the warrant.
    function _forwardAndReturn(
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        bytes calldata routerCalldata
    ) internal {
        // 2. Approve OkuRouter to pull sell tokens. The router pulls via
        //    plain ERC20 transferFrom in its `_fillQuoteTokenTo{Token,Eth}`
        //    paths; we don't have to differentiate based on which entry
        //    point landed the tokens here.
        IERC20(sellToken).safeIncreaseAllowance(okuRouter, sellAmount);

        // 3. Snapshot output balance before the swap, excluding any ETH
        //    the caller attached as msg.value so we don't credit it back.
        uint256 outputBefore = (buyToken == address(0))
            ? address(this).balance - msg.value
            : IERC20(buyToken).balanceOf(address(this));

        // 4. Forward call to OkuRouter. Bubble revert reason untouched.
        (bool success, bytes memory result) = okuRouter.call{value: msg.value}(routerCalldata);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        // 5. Forward output to caller. `received > 0` is the only swap-
        //    validity check this proxy enforces; OkuRouter is responsible
        //    for slippage / minOut checks via its swap targets.
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
