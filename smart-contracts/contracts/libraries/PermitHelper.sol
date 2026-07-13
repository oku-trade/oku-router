//SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;
import "../interfaces/IERC2612.sol";
import "../interfaces/IDAI.sol";
import "../interfaces/uniswapV3/IPermit2.sol";

/// @title PermitHelper
/// @dev Helper methods for using ERC20 Permit (ERC2612, DAI, or Permit2)
library PermitHelper {
    enum PermitStyle {
        DAI,
        EIP, //2612 / 2616
        PERMIT_2
    }

    struct Permit {
        uint256 value;
        uint256 nonce;
        uint256 deadline;
        PermitStyle permitStyle;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev permit method helper that will handle all known permit implementations
    /// @notice For Permit2, this executes permitTransferFrom which transfers tokens directly to spender
    /// @notice For DAI/EIP-2612, this grants allowance only (tokens transferred later by caller)
    /// @param permitData bytes containing the encoded permit signature
    /// @param tokenAddress address of the token that will be permitted/transferred
    /// @param holder address that holds the tokens to be permitted
    /// @param spender address that will receive the tokens (for Permit2) or be granted allowance (for DAI/EIP-2612)
    /// @param permit2Address address of the Permit2 contract on this chain
    function permit(
        Permit memory permitData,
        address tokenAddress,
        address holder,
        address spender,
        address permit2Address
    ) internal {
        if (permitData.permitStyle == PermitStyle.DAI) {
            IDAI(tokenAddress).permit(
                holder,
                spender,
                permitData.nonce,
                permitData.deadline,
                true,
                permitData.v,
                permitData.r,
                permitData.s
            );
        } else if (permitData.permitStyle == PermitStyle.PERMIT_2) {
            // Permit2 uses SignatureTransfer: signature authorizes immediate transfer
            // This is different from DAI/EIP-2612 which only grant allowances
            IPermit2 permit2 = IPermit2(permit2Address);

            // Build the permit transfer struct
            IPermit2.PermitTransferFrom memory permitTransferFrom = IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({
                    token: tokenAddress,
                    amount: permitData.value
                }),
                nonce: permitData.nonce,
                deadline: permitData.deadline
            });

            // Build the transfer details (where tokens go)
            IPermit2.SignatureTransferDetails memory transferDetails =
                IPermit2.SignatureTransferDetails({
                    to: spender,  // Tokens transferred directly to spender
                    requestedAmount: permitData.value
                });

            // Encode signature (Permit2 expects bytes, not split v,r,s)
            bytes memory signature = abi.encodePacked(permitData.r, permitData.s, permitData.v);

            // Execute the transfer (this both verifies signature AND transfers tokens)
            permit2.permitTransferFrom(
                permitTransferFrom,
                transferDetails,
                holder,
                signature
            );
        } else {
            IERC2612(tokenAddress).permit(
                holder,
                spender,
                permitData.value,
                permitData.deadline,
                permitData.v,
                permitData.r,
                permitData.s
            );
        }
    }
}
