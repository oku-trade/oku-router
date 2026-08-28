# Rainbow Router Diff Analysis

These diffs compare the **OpenZeppelin-audited Rainbow Router** (February 25, 2022) against the current implementation.

## Source

- **Audited Code**: https://github.com/rainbow-me/swaps
- **Audit Report**: [OpenZeppelin Audit (2022-02-25)](https://github.com/rainbow-me/swaps/blob/main/smart-contracts/audits/2022-02-25-OpenZeppelin-Rainbow-Swap-Aggregator.pdf)
- **Audited Contract Address**: `0x00000000009726632680fb29d3f7a9734e3010e2`

## Diff Files

| File | Description | Lines Changed |
|------|-------------|---------------|
| `BaseAggregator.diff` | Core aggregator logic changes | ~600 |
| `RainbowRouter_vs_OkuRouter.diff` | Main router contract (renamed) | ~180 |
| `PermitHelper.diff` | Permit handling library | ~94 |

## Summary of Changes

### BaseAggregator.sol
- Solidity 0.8.11 → 0.8.27
- Solmate → OpenZeppelin SafeERC20
- Added EIP712 inheritance for typed signatures
- Added `validSigners` whitelist mapping
- Added `CanoeHelper.Warrant` verification to all swap functions
- Added `approvalTarget` parameter (separate from swap target)
- Changed `safeApprove` → `safeIncreaseAllowance`
- Added Pausable functionality
- Added OrderFilled events

### OkuRouter.sol (was RainbowRouter.sol)
- Renamed contract
- Added EIP712 name/version parameters
- Added `validSigners` management
- Uses OpenZeppelin Ownable instead of custom owner
- Added pause/unpause functionality

### PermitHelper.sol
- Added Permit2 support (Uniswap's universal permit)
- Changed from `bool isDaiStylePermit` to `enum PermitStyle`
- Three permit styles: DAI, EIP-2612, PERMIT_2

## Audited Reference

The audited baseline is stored in `audited-reference/` directory on the `rainbow-router-audited-baseline` branch.
