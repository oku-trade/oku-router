# Router Testing Scripts

Network-specific router testing scripts for Rainbow Router deployments.

## Test Types

### Rainbow Router Tests
Tests routers through the Rainbow Router contract (with `useOkuRouter=true`). These scripts validate the full Rainbow Router flow including whitelisting, permits, and warrant signatures.

### Sanity Tests
Tests routers with direct DEX swaps (with `useOkuRouter=false`). These scripts validate that the backend returns correct DEX target addresses and transaction data without going through Rainbow Router.

## Scripts

### Optimism (`testRoutersOP.ts`)
Tests all supported routers on Optimism mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersOP.ts --network op
```

**Configuration:**
- Rainbow Router: `0x80dCD2C737cAFE9f86559bBCed9938eFfB7f7D1A`
- Supported Routers: enso, icecreamswap, odos, oneinch, paraswap, kyberswap, unizen
- Default Test: 0.001 ETH → WETH

### Base (`testRoutersBase.ts`)
Tests all supported routers on Base mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersBase.ts --network base
```

**Configuration:**
- Rainbow Router: `0xA89A26c4d81A2cca4d0670F77f0FC88362b72248`
- Supported Routers: kyberswap
- Default Test: 0.001 ETH → WETH

### Worldchain (`testRoutersWorldchain.ts`)
Tests all supported routers on Worldchain mainnet.

**Usage:**
```bash
npx hardhat run scripts/testRouters/testRoutersWorldchain.ts --network worldchain
```

**Configuration:**
- Rainbow Router: `0x25cf2128F603754179379351B805B4F8C0B8dCA4`
- Supported Routers: icecreamswap, enso, kyberswap
- Default Test: 0.001 ETH → WETH

### Optimism Sanity Test (`sanityTestOP.ts`)
Tests routers with direct DEX swaps (no Rainbow Router) on Optimism.

**Usage:**
```bash
npx hardhat run scripts/testRouters/sanityTestOP.ts --network op
```

**Configuration:**
- Direct user swaps (no Rainbow Router)
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
