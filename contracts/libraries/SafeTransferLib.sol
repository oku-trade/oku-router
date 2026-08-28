// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;


library SafeTransferLib {



    /// @dev from https://github.com/transmissions11/solmate/blob/v6/src/utils/SafeTransferLib.sol#L15-L24
    function safeTransferETH(address to, uint256 amount) internal {
        bool callStatus;

        assembly ("memory-safe") {
            // Transfer the ETH and store if it succeeded or not.
            callStatus := call(gas(), to, amount, 0, 0, 0, 0)
        }

        require(callStatus, "ETH_TRANSFER_FAILED");
    }



}
