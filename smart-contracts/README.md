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

## Deployments

Live and historical contract addresses are tracked in `deployments/<networkName>.json`.
Each file contains a `current` map (latest, non-deprecated address per contract) and an
append-only `history` array. The deploy tasks update these files automatically; consumers
read them via `util/networkConfig.ts`.

The CREATE2 deployment identifiers (contract name, version, salts) live in
`util/contractMeta.ts` and are the single source of truth for any script that computes
or predicts a deterministic address.

**Cross-chain address parity caveat:** The OkuRouter constructor takes `(name, version, owner)`,
so the predicted CREATE2 address depends on the `owner` value too. To get the same address
on every chain you MUST pass the same owner on every deploy. The current convention is to
deploy with the deployer EOA as constructor owner, then transfer ownership to the production
multisig in a separate post-deploy step.

## Redeploying

The deployment uses CREATE2 via the [Safe Singleton Factory](https://github.com/safe-global/safe-singleton-factory),
so all chains share the same `OkuRouter` address for a given `(CONTRACT_NAME, CONTRACT_VERSION, owner)` tuple.
Bumping the version invalidates the prior CREATE2 salt and produces a new deterministic address.

1. Bump `CONTRACT_VERSION` in `util/contractMeta.ts`.
2. (Pre-flight) Confirm cross-chain address parity:
   ```bash
   npx hardhat predict-all --owner 0x<deployer>
   ```
   Every supported chain should report the same predicted address.
3. (Per chain) Predict + sanity-check the network you're about to deploy to:
   ```bash
   npx hardhat run scripts/predictAddress.ts --network <chain>
   ```
4. (Per chain) Deploy:
   ```bash
   npx hardhat deploy --network <chain> --deterministic
   ```
   This auto-records the new address to `deployments/<chain>.json` and marks the prior
   entry as `deprecated: true`. Swap targets and the zero-address signer are re-registered
   idempotently.
5. (World Chain or any chain needing it) Deploy the Permit2Proxy:
   ```bash
   npx hardhat deploy-permit2-proxy --network <chain>
   ```
   The proxy is bonded by its CREATE2 salt to the *current* `OkuRouter` address, so a
   stale proxy can never collide with a new one. The task refuses to run if the latest
   `OkuRouter` entry on that chain is deprecated or on a different version.
6. Transfer ownership to the production multisig manually (Ownable2Step):
   ```solidity
   contract.transferOwnership(<gfxOwner>); // from deployer
   contract.acceptOwnership();             // from <gfxOwner>
   ```
7. Commit the updated `deployments/<chain>.json` files.

## License

GPL-3.0
