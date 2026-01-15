# Oku Router

A secure swap aggregator intermediary smart contract that provides a unified interface for executing token swaps across multiple DEX aggregators.

## Key Features

- **Multi-Aggregator Support**: Single interface for 1inch, Odos, Paraswap, KyberSwap, OKX, 0x, and more
- **Gasless Approvals**: Supports EIP-2612, DAI-style, and Permit2 for one-transaction swaps
- **Backend Authorization**: Warrant signature system ensures swap calldata is fresh and validated
- **Transfer Proxy Support**: Compatible with dual-contract aggregator architectures (e.g., OKX, 0x AllowanceHolder, CoW Protocol)
- **Fee Collection**: Configurable fees on input tokens or output ETH
- **Security**: Reentrancy protection, target whitelisting, balance verification

## Architecture

```
User -> Backend API -> Oku Router -> DEX Aggregator -> DEX Protocol -> Token Swap
          (quote +      (security     (1inch, Odos,    (Uniswap,
           warrant)      validation)   Paraswap...)     Curve...)
```

## Development

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run tests (standard)
npm test

# Run tests (requires archive RPC - set OP_URL and ARB_URL in .env)
npm run test:archive
```

## License

GPL-3.0
