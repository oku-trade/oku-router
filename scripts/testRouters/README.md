# Router Testing Scripts

Network-specific router testing scripts for Oku Router deployments.

> Note: the network-specific scripts referenced below (`testRoutersOP.ts`,
> `testRoutersBase.ts`, `testRoutersWorldchain.ts`, `sanityTestOP.ts`) have
> since been consolidated into `testRouters.ts` / `testAllChains.ts` in this
> directory. The addresses below have been refreshed to the current `2.0`
> deployment but the per-network script names are stale; left as-is here
> since untangling that is a separate cleanup from this pass.

## Test Types

### Oku Router Tests
Tests routers through the Oku Router contract (with `useOkuRouter=true`). These scripts validate the full Oku Router flow including whitelisting, permits, and warrant signatures.

### Sanity Tests
Tests routers with direct DEX swaps (with `useOkuRouter=false`). These scripts validate that the backend returns correct DEX target addresses and transaction data without going through Oku Router.

## Scripts

### Optimism (`testRoutersOP.ts`)
Tests all supported routers on Optimism mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersOP.ts --network op
```

**Configuration:**
- Oku Router: `0xb1f3a7B816B0681188F54dFa400991B93ADf00ed`
- Supported Routers: enso, icecreamswap, odos, oneinch, paraswap, kyberswap, unizen
- Default Test: 0.001 ETH → WETH

### Base (`testRoutersBase.ts`)
Tests all supported routers on Base mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersBase.ts --network base
```

**Configuration:**
- Oku Router: `0xb1f3a7B816B0681188F54dFa400991B93ADf00ed`
- Supported Routers: kyberswap
- Default Test: 0.001 ETH → WETH

### Worldchain (`testRoutersWorldchain.ts`)
Tests all supported routers on Worldchain mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersWorldchain.ts --network worldchain
```

**Configuration:**
- Oku Router: `0xb1f3a7B816B0681188F54dFa400991B93ADf00ed`
- Supported Routers: icecreamswap, enso, kyberswap
- Default Test: 0.001 ETH → WETH

### Optimism Sanity Test (`sanityTestOP.ts`)
Tests routers with direct DEX swaps (no Oku Router) on Optimism.

**Usage:**
```bash
npx hardhat run scripts/testRouters/sanityTestOP.ts --network op
```

**Configuration:**
- Direct user swaps (no Oku Router)
- Validates backend returns correct DEX targets
- Tests: enso, odos
- Default Test: 0.001 ETH → WETH

## Customizing Tests

Each script has a `CONFIG` object at the top that you can modify:

```typescript
const CONFIG = {
  // Network settings (DO NOT change these)
  chain: "optimism",
  chainId: 10,
  userWalletAddress: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",

  // Supported tokens
  tokens: { ETH, WETH, USDC },

  // Routers to test (customize this list)
  routers: ["enso", "odos", "kyberswap"],

  // Test settings (customize these)
  testAmount: "0.001",
  slippage: 1000, // 10%
  usePermit: false,
  simulateOnly: true,
  delayBetweenTests: 3000,
};
```

> **Note:** the live OkuRouter address is no longer specified here. It is read
> at runtime from `deployments/<networkName>.json` via
> `getCurrentAddress(networkName, "OkuRouter")` (see
> `util/deploymentsRegistry.ts`). To point the test scripts at a different
> deployment, update that registry file rather than this `CONFIG` block.

## Legacy Script

`testAllRouters.ts` is the original multi-network script. Use the network-specific scripts above for simpler, more maintainable testing.
