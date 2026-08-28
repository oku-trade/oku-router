// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Test-only ERC20 used by the World Chain smoke fixture so we do
///         not have to depend on a real on-chain USDC whale (which can
///         drift between deployment blocks). Anyone can mint to any
///         address — this contract MUST NEVER be deployed to a live chain.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
