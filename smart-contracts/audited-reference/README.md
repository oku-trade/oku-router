# Rainbow Router - Audited Reference

This directory contains the original Rainbow Router smart contracts as audited by OpenZeppelin.

## Source

- **Repository**: https://github.com/rainbow-me/swaps
- **Commit**: Retrieved from main branch on 2026-01-16
- **Solidity Version**: 0.8.11

## Audit Information

- **Auditor**: OpenZeppelin
- **Date**: February 25, 2022
- **Report**: [2022-02-25-OpenZeppelin-Rainbow-Swap-Aggregator.pdf](https://github.com/rainbow-me/swaps/blob/main/smart-contracts/audits/2022-02-25-OpenZeppelin-Rainbow-Swap-Aggregator.pdf)

## Deployed Addresses

The audited contract is deployed at:
- **All Major Networks**: `0x00000000009726632680fb29d3f7a9734e3010e2`

## Files

```
contracts/
├── RainbowRouter.sol           # Main router contract
├── routers/
│   └── BaseAggregator.sol      # Core aggregator logic
├── libraries/
│   └── PermitHelper.sol        # ERC2612/DAI permit helper
└── interfaces/
    ├── IDAI.sol                # DAI permit interface
    ├── IERC2612.sol            # ERC2612 permit interface
    ├── IERC2612Extension.sol   # Extended permit interface
    └── IWETH.sol               # WETH interface
```

## Dependencies

The original contracts use:
- `@rari-capital/solmate` for SafeTransferLib and ERC20
- `@openzeppelin/contracts` for interfaces
- `@uniswap/v3-periphery` for IERC20PermitAllowed

## Purpose

This reference is used to diff against the current OkuRouter implementation to identify changes made to the audited baseline.
