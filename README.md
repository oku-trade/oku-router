# Oku Router

A secure swap aggregator intermediary smart contract that provides a unified interface for executing token swaps across multiple DEX aggregators.

## Key Features

- **Multi-Aggregator Support**: Single interface for 1inch, Odos, Paraswap, KyberSwap, OKX, 0x, and more
- **Gasless Approvals**: Supports EIP-2612, DAI-style, and Permit2 for one-transaction swaps
- **Backend Authorization**: Warrant signature system ensures swap calldata is fresh and validated
- **Transfer Proxy Support**: Compatible with dual-contract aggregator architectures (e.g., OKX, 0x AllowanceHolder, CoW Protocol)
- **Fee Collection**: Configurable fees on input tokens or output ETH; multi-token sweeping via `sweepAll`
- **Security**: Reentrancy protection, target whitelisting, balance verification
- **MiniKit v2 / World App**: Permit2 AllowanceTransfer entry point on `Permit2Proxy` so mini apps can batch
  `Permit2.approve` + swap in a single UserOp

## Permit2Proxy

`Permit2Proxy` is a thin, stateless forwarder that pulls tokens via Permit2 and hands them to `OkuRouter`.
It exposes two entry points so the same contract works for every Permit2-capable wallet:

- `execute(permit, signature, buyToken, routerCalldata)` — Permit2 **SignatureTransfer**. Used by Safe smart
  wallets and any EOA signing a fresh permit per swap.
- `executeAllowance(sellToken, sellAmount, buyToken, routerCalldata)` — Permit2 **AllowanceTransfer**. Used by
  **World App / MiniKit v2** mini apps, which dropped SignatureTransfer support in v2. The mini app batches
  `Permit2.approve(sellToken, proxy, sellAmount, 0)` and the proxy call into a single UserOp; the
  `expiration = 0` allowance is consumed in the same transaction.

Both paths share `_forwardAndReturn` internally so swap behavior cannot drift between them.

### AllowanceTransfer — what the contract change actually is

The MiniKit v2 / World App flow lives **entirely inside `Permit2Proxy.sol`**. No edits were made to
`OkuRouter`, `BaseAggregator`, `PermitHelper`, or any other audited contract — the audit boundary is
preserved. The only on-chain logic added is `executeAllowance` plus a refactor that lifts the post-pull
pipeline (approve OkuRouter → snapshot output → forward call → return proceeds) into a shared
`_forwardAndReturn` helper that both entry points call. That means SignatureTransfer and AllowanceTransfer
cannot drift in swap behavior by construction.

The single line that distinguishes the two entry points is **how tokens land in the proxy**:

| Entry point | How tokens arrive in the proxy |
|---|---|
| `execute` (existing — Safe wallets, EOAs) | `permit2.permitTransferFrom(permit, ..., owner, signature)` — Permit2 verifies a one-shot EIP-712 signature **and** transfers in one call |
| `executeAllowance` (new — **World App / MiniKit v2**) | `permit2.transferFrom(msg.sender, address(this), sellAmount, sellToken)` — Permit2 consumes a **pre-existing on-chain allowance** that `msg.sender` granted to the proxy |

After that single divergent step, both entry points funnel into the same `_forwardAndReturn` and the rest
of the swap is identical.

### Why this is World App / MiniKit v2 compatible

Per the [MiniKit v2 docs](https://docs.world.org/mini-apps/commands/send-transaction), **World App dropped
Permit2 SignatureTransfer support in v2 and now only supports AllowanceTransfer**. The supported pattern
is to batch two calls into a single `MiniKit.sendTransaction` UserOp:

1. `Permit2.approve(sellToken, permit2ProxyAddress, sellAmount, expiration=0)` — grants the proxy a
   Permit2 allowance. Permit2 special-cases `expiration = 0` by storing `block.timestamp`, meaning the
   allowance is only spendable in the same block as the approve call.
2. `Permit2Proxy.executeAllowance(sellToken, sellAmount, buyToken, routerCalldata)` — the proxy's
   `permit2.transferFrom(...)` consumes that allowance. Permit2 enforces `block.timestamp <= expiration`,
   so this MUST land in the same block as the approve. MiniKit's UserOp batching guarantees atomicity;
   the proxy itself does not need to enforce same-block consumption — Permit2 does it.

Token-level approval to Permit2 (`ERC20.approve(PERMIT2, ...)`) is **auto-granted by World App** the first
time a mini app references a new ERC20, so users never see a separate ERC20 approval prompt.

`executeAllowance` is not coupled to the MiniKit `expiration = 0` quirk — a non-MiniKit caller (e.g. a
regular EOA) that has pre-approved Permit2 with any future expiration can also call it directly. The test
suite includes a dedicated case for that path
(`test/base/Permit2ProxyAllowance.ts` → "Should also accept a pre-approved Permit2 allowance with a future
expiration").

### MiniKit v2 frontend shape (World App mini app)

```ts
import { MiniKit } from "@worldcoin/minikit-js";
import { encodeFunctionData } from "viem";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

await MiniKit.sendTransaction({
  chainId: 480, // World Chain
  transactions: [
    // 1. Approve the proxy via Permit2 with expiration=0.
    //    Per MiniKit v2 spec: always set expiration=0; the allowance is
    //    consumed in the same UserOp by the executeAllowance call below.
    {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: [{ name: "approve", type: "function", inputs: [
          { name: "token", type: "address" }, { name: "spender", type: "address" },
          { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" },
        ], outputs: [], stateMutability: "nonpayable" }],
        functionName: "approve",
        args: [sellToken, permit2ProxyAddress, sellAmount, 0],
      }),
    },
    // 2. Execute the swap through Permit2Proxy.executeAllowance.
    {
      to: permit2ProxyAddress,
      data: encodeFunctionData({
        abi: Permit2ProxyABI,
        functionName: "executeAllowance",
        args: [sellToken, sellAmount, buyToken, routerCalldata],
      }),
    },
  ],
});
```

The `routerCalldata` is generated by the Oku backend exactly as for any other chain: a warrant-signed
`fillQuoteTokenTo{Token,Eth}` call on `OkuRouter`. The proxy is invisible to warrant signing, so no
backend changes are required to support World App.

### World Developer Portal allowlisting

Before a mini app can use the proxy in production, the following must be allowlisted in the
[World Developer Portal](https://developer.world.org/) under **Mini App > Permissions**:

- **Contract Entrypoints** — the deployed `Permit2Proxy` address on World Chain.
- **Permit2 Tokens** — every ERC-20 the mini app will sell through the proxy. World App's auto-approval
  to Permit2 only fires for tokens on this allowlist.

Transactions that touch non-allowlisted contracts or tokens will be rejected by the World App backend with
an `invalid_contract` error before they ever reach the chain.

### What changed outside `Permit2Proxy.sol`

Nothing functional in any production contract. The other diffs in this change set are:

- `contracts/OkuRouter.sol` — NatSpec only on `TokenWithdrawn` and `EthWithdrawn` (no bytecode change).
- `contracts/interfaces/uniswapV3/IPermit2.sol` — NatSpec only on the AllowanceTransfer `transferFrom`
  declaration (which was already present at the interface level).
- `contracts/test/MockERC20.sol` — new, test-only ERC20 used by the World Chain smoke fixture. Never
  deployed to a live chain.
- `tasks/deployPermit2Proxy.ts` — added `--deterministic` opt-in flag; default is now a plain nonce-based
  deploy (since the proxy is World Chain only and we don't need CREATE2 parity across chains).
- `deployments/worldchain.json` — `current.Permit2Proxy` now points at the proxy bonded to the
  current `2.0` router. The earlier testing-only proxy at `0x1B361B7c…` is no longer tracked here
  (the file records active deployments only); it survives only in git history.
- `test/base/Permit2ProxyAllowance.ts` (new) — MiniKit v2 happy/fee/revert/reentrancy coverage on an
  Optimism fork (Permit2 is at the same canonical address on every chain, so OP fixture coverage is
  representative).
- `test/archive-rpc/Permit2ProxyWorldchainSmoke.ts` (new) — World-Chain-specific smoke test that confirms
  Permit2 is deployed at the canonical address on chainId 480 and that the same-block
  approve+transferFrom invariant holds against World Chain's real on-chain Permit2 bytecode. Run via
  `npm run test:archive` (kept out of the default `npm test` glob to avoid hammering the World Chain RPC
  in CI).

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

# Lint (TypeScript only -- see the formatting freeze note below)
npm run lint
```

### Contract formatting is frozen

**Do not reformat anything under `contracts/`.** The Solidity sources are audited
and byte-frozen. solc appends an IPFS metadata hash to the deployed bytecode, and
that hash covers the keccak of every source file — so changing even a comment or a
line break changes the bytecode, which changes the CREATE2 address, which
invalidates the on-chain verification of every live deployment (all 34 of them, at
`0xb1f3a7B816B0681188F54dFa400991B93ADf00ed` and its per-chain Permit2 variants).

For this reason:

- `npm run lint` runs **ESLint only**. There is deliberately no Prettier check on
  `contracts/**/*.sol`, and no `prettier-sol` write script. 24 of the 25 `.sol`
  files are not Prettier-formatted, and that is intentional and permanent.
- CI (`.github/workflows/main.yml`) is lint-only for the same reason.
- If a genuine contract change is ever required, it must go through a
  `CONTRACT_VERSION` bump in `util/contractMeta.ts` and a full redeploy — see
  "Redeploying" below. Formatting alone is never a sufficient reason.

## Deployments

Currently-live contract addresses are tracked in `deployments/<networkName>.json`, one
file per chain. Each file contains a single `current` map of contract kind → entry, where
each entry carries the live `address` plus the metadata appropriate for that contract:

- `OkuRouter` entries: `{ address, version, owner }`. `owner` is the current on-chain
  `owner()` (refresh this field after any `transferOwnership` / `acceptOwnership` cycle).
- `Permit2Proxy` entries: `{ address, okuRouter }`. The proxy is not Ownable, so no
  `owner` field is recorded. `Permit2Proxy` is currently only deployed on worldchain;
  do not add it to other networks' files.

The files track only what is live right now — there is no `history` or `deprecated`
section. Previous deployments survive only in git history of the JSON file itself.

The deploy tasks write these files automatically via `util/deploymentsRegistry.ts`, which
enforces the per-contract field requirements above. Read sites go through the same module
(`getCurrentAddress`, `getCurrentEntry`).

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
   This overwrites `current.OkuRouter` in `deployments/<chain>.json` with the new
   `{ address, version, owner }` entry; the previous entry is dropped (it's still in
   git history). Swap targets and the zero-address signer are re-registered idempotently.
5. (World Chain only — the only chain that currently needs it) Deploy the Permit2Proxy:
   ```bash
   npx hardhat deploy-permit2-proxy --network worldchain
   ```
   By default this is a plain nonce-based deploy — appropriate because the proxy is only
   needed on World Chain and we don't want to pay the CREATE2 ceremony tax. Pass
   `--deterministic` to deploy via the Safe Singleton Factory instead; the salt is
   `keccak256("Permit2Proxy+<current OkuRouter address>")` so a stale proxy can never
   collide with a new one. Either way, the task refuses to run if `current.OkuRouter.version`
   on that chain does not match `CONTRACT_VERSION`, and it overwrites
   `current.Permit2Proxy` with the new `{ address, okuRouter }` entry.

   The proxy supports both `execute` (Permit2 SignatureTransfer) and `executeAllowance`
   (Permit2 AllowanceTransfer / MiniKit v2). One deployment serves Safe wallets and World App
   users. Do not add `Permit2Proxy` entries to other networks' deployment files.
6. Transfer ownership to the production multisig manually (Ownable2Step):
   ```solidity
   contract.transferOwnership(<gfxOwner>); // from deployer
   contract.acceptOwnership();             // from <gfxOwner>
   ```
   Then refresh the `owner` field in `deployments/<chain>.json` so the file matches the
   new on-chain owner.
7. Commit the updated `deployments/<chain>.json` files.

## License

GPL-3.0
