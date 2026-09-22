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
  `contracts/**/*.sol`, and no `prettier-sol` write script — Prettier is not even a
  dependency. The `.sol` sources are not Prettier-formatted, and that is intentional
  and permanent.
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
- `Safe` entries: `{ address, version, threshold, owners }`. The production multisig
  that owns the routers. A Safe has `owners` (plural), so no `owner` field is recorded.
  `threshold`/`owners` are a snapshot of the live values at write time — refresh after
  any `addOwnerWithThreshold` / `swapOwner` / `changeThreshold` with
  `npx hardhat safe:refresh-registry`. See [Production multisig](#production-multisig-safe).

The files track only what is live right now — there is no `history` or `deprecated`
section. Previous deployments survive only in git history of the JSON file itself.

The deploy tasks write these files automatically via `util/deploymentsRegistry.ts`, which
enforces the per-contract field requirements above. Read sites go through the same module
(`getCurrentAddress`, `getCurrentEntry`).

The CREATE2 deployment identifiers (contract name, version, salts) live in
`util/contractMeta.ts` and are the single source of truth for any script that computes
or predicts a deterministic address.

**Cross-chain address parity caveat:** The OkuRouter constructor takes
`(name, version, owner, permit2)`, so the predicted CREATE2 address depends on the `owner`
and `permit2` values too. To get the same address on every chain you MUST pass the same
owner on every deploy, and the chain must use the canonical Permit2 (13 chains do not,
which is why their router addresses differ — see the version notes in
`util/contractMeta.ts`). The convention is to deploy with the deployer EOA as constructor
owner, then transfer ownership to the production multisig in a separate post-deploy step.

Transferring ownership afterwards does **not** change the CREATE2 address — `owner` is
baked into the init code at deploy time and then moved via `Ownable2Step`. So the Safe
handover is address-safe. Re-deploying with the Safe as *constructor* owner would produce
a different address on every chain; don't.

## Redeploying

The deployment uses CREATE2 via the [Safe Singleton Factory](https://github.com/safe-global/safe-singleton-factory),
so all chains share the same `OkuRouter` address for a given `(CONTRACT_NAME, CONTRACT_VERSION, owner)` tuple.
Bumping the version invalidates the prior CREATE2 salt and produces a new deterministic address.

1. Bump `CONTRACT_VERSION` in `util/contractMeta.ts`.
2. (Pre-flight) Confirm cross-chain address parity, and check it against what is
   actually deployed:
   ```bash
   npx hardhat predict-all --owner 0x<deployer> --verify
   npx hardhat predict-all --contract permit2proxy --verify
   ```
   Chains do **not** all share one address. `permit2` is a constructor argument,
   so any chain whose Permit2 is not the canonical
   `0x000000000022D473030F116dDEE9F6B43aC78BA3` derives a different CREATE2
   address. The task groups chains by predicted address so the real parity
   picture is visible, and `--verify` diffs every prediction against
   `deployments/*.json`.
3. (Per chain) Deploy:
   ```bash
   npx hardhat deploy --network <chain> --deterministic
   ```
   This overwrites `current.OkuRouter` in `deployments/<chain>.json` with the new
   `{ address, version, owner }` entry; the previous entry is dropped (it's still in
   git history). Swap targets and the zero-address signer are re-registered idempotently.
4. (World Chain only — the only chain that currently needs it) Deploy the Permit2Proxy:
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
5. Transfer ownership to the production Safe (Ownable2Step, two senders):
   ```bash
   npx hardhat safe:handover --networks <chain> --broadcast   # transferOwnership, from deployer
   npx hardhat safe:build --intent accept-ownership           # acceptOwnership, from the Safe
   npx hardhat safe:sign  --name accept-ownership-<stamp> ...
   npx hardhat safe:exec  --name accept-ownership-<stamp> --broadcast
   npx hardhat safe:refresh-registry --networks <chain>
   ```
    See [Production multisig](#production-multisig-safe) for the full runbook.
6. (Per chain) Verify on the block explorer:
   ```bash
   npx hardhat verify-deployments --networks <chain>
   ```
7. Commit the updated `deployments/<chain>.json` files.

## Swap-target whitelisting

`OkuRouter` will only call an aggregator contract that is registered in its `swapTargets`
mapping. The desired set is **derived from chain-config** — `marketRouters` in
`@gfxlabs/oku-chains` — never from a hardcoded list in this repo. When chain-config
publishes a new aggregator router, the workflow is: bump the dependency, detect the gap,
apply it, confirm.

> Hardcoded backfill scripts for this used to live in `scripts/`. They have been
> removed: they stopped working the moment ownership moved to the Safe, and a
> hardcoded address list goes stale as soon as chain-config publishes again.
> Everything now flows through `safe:build --intent swap-targets`, which diffs
> live on-chain state against chain-config. They remain in git history.

### 1. Detect — `yarn check:swap-targets` (chain-config repo)

chain-config ships a read-only auditor that checks every configured `marketRouters`
address against `swapTargets` on that chain's `oku.router`, across all `MAINNET_CHAINS`:

```bash
cd ../chain-config && yarn check:swap-targets
```

Requires the [chain-config](https://gfx.cafe/gfx/chain-config) repo checked out alongside
this one. It reads chain state over the internal proxy `https://venn.lat.gfx.town/{internalName}`,
which is considerably more reliable than the public endpoints this repo falls back to.

It prints `all good` and exits `0` when every router is allowed. Otherwise it groups the
offenders by chain and exits non-zero:

```
ethereum (1):
  - 0xBc1D9760bd6ca468CA9fB5Ff2CFbEAC35d86c973 (bitget)
```

Two caveats worth knowing:

- It resolves the router from chain-config's own `oku.router` field, **not** from
  `deployments/*.json` here. If those two disagree, it is auditing a different contract
  than the tasks below will write to.
- It only checks the config → chain direction. An address whitelisted on-chain but absent
  from chain-config will not be reported, since `swapTargets` is a plain mapping with no
  enumeration — that would need a `SwapTargetAdded` event replay.

### 2. Apply — `whitelist-swap-targets` (this repo)

```bash
# preview only; sends nothing
npx hardhat whitelist-swap-targets --dry-run

# restrict to specific chains
npx hardhat whitelist-swap-targets --dry-run --networks mainnet,base,bsc

# live
npx hardhat whitelist-swap-targets --networks mainnet,base,bsc
```

The task diffs `NETWORK_CONFIGS[<network>].knownSwapTargets` against live `swapTargets()`
and registers whatever is missing. It is:

- **idempotent** — only addresses reading back `false` are submitted, so re-running is a
  no-op, and it never removes anything
- **ownership-preflighted** — a chain whose `owner()` is not the configured signer is
  skipped loudly instead of burning gas on a guaranteed revert
- **bytecode-preflighted** — an address with no code is skipped; whitelisting an EOA as a
  swap target is a security footgun
- **post-write verified** — re-reads `swapTargets()` after each tx and only reports success
  if it actually flipped

Prefer `--networks` over a full sweep when you already know the affected chains: it keeps
the run clear of chains that need no work, and of any chain whose ownership has already
moved to the Safe.

### Which path applies

`updateSwapTargets` is `onlyOwner`, and `OkuRouter` is `Ownable2Step` — so the gate is
`owner()`, not `pendingOwner`.

| `owner()` is | use |
| --- | --- |
| the deployer EOA | `npx hardhat whitelist-swap-targets` (above) — one tx per chain, no signatures |
| the production Safe | `npx hardhat safe:build --intent swap-targets` → `safe:sign` → `safe:exec` |

During the Safe migration these coexist: a chain that has been *armed*
(`pendingOwner` = Safe) but has not yet executed `acceptOwnership` still has the EOA as
`owner()`, so the EOA path keeps working there. That is also the cheaper window — a direct
EOA call consumes no Safe nonce, so it cannot invalidate pre-signed acceptance bundles.
Once acceptance lands, the chain moves to the Safe path. See
[Production multisig](#production-multisig-safe).

### RPC gotcha

Several `.env` entries (`MAINNET_URL`, `BASE_URL`, `BSC_URL`) point at public endpoints
that are now rate-limited or blocking, and `rpcUrl()` in `hardhat.config.ts` prioritises
env overrides **above** Alchemy even when `ALCHEMY_API_KEY` is set and supports the chain.
The failure mode is nasty: the transaction broadcasts fine and then the endpoint dies
during receipt polling, so the task reports a failure for a tx that actually landed.
Always confirm on-chain before retrying. Override per-run:

```bash
MAINNET_URL="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
BASE_URL="https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
BSC_URL="https://bnb-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
npx hardhat whitelist-swap-targets --networks mainnet,base,bsc
```

hyperevm's default RPC (`rpc.hyperliquid.xyz/evm`) also intermittently fails to broadcast
with `could not coalesce error`; `HYPEREVM_URL=https://hyperliquid.drpc.org` works.

### 3. Confirm

Re-run the chain-config auditor — `all good` is the authoritative sign-off that on-chain
state matches published config:

```bash
cd ../chain-config && yarn check:swap-targets
```

## Production multisig (Safe)

All 34 OkuRouter deployments are owned by a single **2-of-3 Safe** at one address on every
chain:

```
address    0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F
type       SafeL2 v1.4.1 (L1 singleton + SafeToL2Setup delegatecall)
threshold  2 of 3
saltNonce  0
```

**Signers — all three are hardware wallets.** No signer key exists in software
anywhere, which is why `safe:sign --key-env` is not usable for production signing; see
[Collecting signatures](#collecting-signatures).

| # | Address |
| --- | --- |
| 1 | `0x9B68c14e936104e9a7a24c712BEecdc220002984` |
| 2 | `0x5227a7404631Eb7De411232535E36dE8dad318f0` |
| 3 | `0x43A9beCdC1323c1dFcfA776cE9bF57F9F8Ce8200` |

Losing any one device is survivable (2 of the remaining signers still meet the
threshold). Losing two is not. Rotation is an on-chain `swapOwner` through a normal
2-of-3 transaction and does **not** change the Safe address — update `OKU_SAFE_OWNERS`
in `util/safeConfig.ts` afterwards so the config matches the chain.

### Migration status

**The handover is complete on 33 of 34 chains.**

| state | chains |
| --- | --- |
| **Safe owns the router** | **33** |
| Still deployer-owned | 1 — robinhood (Safe not deployed; deployer underfunded) |

Verified on-chain for all 33: `owner()` is the Safe, `pendingOwner()` is cleared, no chain
is paused, and every Safe is at nonce 1. All acceptances were relayed by the deployer EOA
`0x3CB68a…` acting purely as an unprivileged executor — the hardware wallets paid no gas
on any chain.

**Remaining work — robinhood (4663):** send ~0.0015 ETH to
`0x3CB68a6762041aA05E762814A8791CA9d98E79A0` on Robinhood, then

```bash
npx hardhat safe:deploy   --networks robinhood --broadcast
npx hardhat safe:handover --networks robinhood --broadcast
npx hardhat safe:build --intent accept-ownership --networks robinhood
# collect 2 signatures, then
npx hardhat safe:exec --name <bundle> --broadcast
npx hardhat safe:refresh-registry --networks robinhood
```

### Day-2 consequences of the handover

- **`whitelist-swap-targets` no longer works.** It preflights `owner() == signer` and now
  reports `NOT_OWNER` on every handed-over chain — meaning it silently verifies *nothing*.
  Use `safe:build --intent swap-targets` instead, which diffs on-chain state and emits a
  bundle only where something is missing.
- The equivalent EOA-era backfill scripts have been deleted for the same reason.
  Use `safe:build --intent valid-signer` for the backend warrant signer.
- Only the Safe can send bare ETH to a router (`receive()` requires `msg.sender == owner()`).
- Every privileged action is now a 2-of-3 ceremony. Chain-config bumps that add new swap
  targets are best reconciled deliberately rather than discovered as drift later.

Bundles and signatures are stored separately, and only one of them is committed:

| path | contents | git |
| --- | --- | --- |
| `safe-bundles/<name>.json` | transaction definition — authorizes nothing | **committed** |
| `safe-bundles/<name>/signatures-0x<addr>.json` | signature material — a `threshold` set is a bearer authorization | gitignored |
| `safe-bundles/<name>/{sign.html,tx-builder,eip712}` | generated, reproducible from the bundle | gitignored |

Committing the definition gives an auditable record of exactly what was approved, lets
co-signers `git pull` instead of being sent a file, and protects work in progress from
`git clean -fdx`. Signatures never enter git history, which cannot be un-published — the
rule is unconditional because it matters far more for a future `sweepAll` or `pause`
bundle than for an `acceptOwnership` batch.

### Deployment status

Live on **33 of 34 chains** at the address above, all verified for owner set, threshold,
`SafeL2` singleton, fallback handler and an empty module list.

- **Robinhood (4663) is outstanding** — the deployer EOA was underfunded at deploy time.
  Send ~0.0015 ETH to `0x3CB68a6762041aA05E762814A8791CA9d98E79A0` on Robinhood, then
  `npx hardhat safe:deploy --networks robinhood --broadcast`. Deploy order and timing do
  not affect the address.
- All 33 Safes are at **nonce 0** and own nothing. Ownership of every OkuRouter is still
  held by the deployer EOA; the handover is a separate, later phase.

> **RPC caveat:** the configured `MAINNET_URL` and `BASE_URL` are unreliable (observed
> `408 Request Timeout` and dropped responses). Both chains were deployed by overriding
> for a single run, e.g.
> `MAINNET_URL=https://ethereum-rpc.publicnode.com BASE_URL=https://mainnet.base.org npx hardhat …`.
> Fix these endpoints before the ownership handover, which is far less forgiving.

Everything is derived from `util/safeConfig.ts`. The address there is *computed*, never
read from a constant — `OKU_SAFE_EXPECTED_ADDRESS` is only a tripwire that fires if the
owner set, **owner order**, threshold or saltNonce ever changes. Owner order is part of
the initializer preimage and therefore part of the address; never reorder it.

### What we do and do not deploy

We deploy **no Safe contracts**. Safe's canonical v1.4.1 `SafeProxyFactory`, `SafeL2`
singleton, `CompatibilityFallbackHandler` and `MultiSendCallOnly` already exist at
identical addresses on all 34 chains. What we deploy is our own Safe **proxy**, once per
chain — a Safe is a smart contract account, so it does not exist on a chain until its
proxy is there. No app, including app.safe.global, can avoid that.

One known gap: `SafeToL2Setup` is absent on **Gensyn**. It is referenced by the
initializer, so it is part of the address preimage and cannot be skipped without forking
the address there. `safe:deploy` deploys the canonical bytecode to its canonical address
first. The embedded bytecode is self-verifying: it must CREATE2 to `0xBD89A1CE…` through
the Safe Singleton Factory or the task refuses to send it.

> `@safe-global/safe-deployments` does not list Gensyn at all and wrongly reports Telos as
> lacking `SafeToL2Setup`. On-chain `eth_getCode` is the only trustworthy source, which is
> why `safe:preflight` probes every chain instead of trusting a registry.

### Why we script all 34 instead of using app.safe.global

app.safe.global supports 22 of our 34 chains; the other 12 aren't in its network list at
all. Scripting all 34 is also strictly better where the UI *is* available: one
byte-identical code path, we choose the `saltNonce` (the UI picks its own, so the address
wouldn't be knowable in advance), and the address is verified before anything is spent.

You still get the full Safe UI on the 22 supported chains. The Transaction Service indexes
the canonical factory's `ProxyCreation` event regardless of who called it — verified
against the previous Oku Safe, whose creation transaction went through a relayer
intermediary rather than a direct factory call and was indexed completely.

### Roles

| Role | Who | On-chain authority |
| --- | --- | --- |
| Owner | the 3 hardware wallets | 2 signatures execute anything |
| **Executor** | `0x3CB68a…` (hot deployer) | **none** — `execTransaction` is permissionless once the threshold of signatures exists |
| Proposer | `0x3CB68a…` (hot deployer) | **none** — can only queue transactions into the Safe UI; cannot sign, cannot execute |

The executor role is the one that matters operationally: it lets the hot wallet relay and
pay gas on all 34 chains while holding zero permissions, so the hardware wallets never
need a gas balance anywhere. Proposers are a UI convenience only, available on 22 chains,
and reduce the signature count by exactly zero.

Signature collection cannot be collapsed across chains: `chainId` is inside the SafeTx
EIP-712 domain and the nonce is per-chain, so every chain needs its own signature from
every signer. There is no stock-Safe way around that. `MultiSendCallOnly` does collapse
*multiple actions on one chain* into one signature, which is where the real saving is.

### Collecting signatures

All three signers are hardware wallets, so `safe:sign --key-env` (software key) is only
useful for testing. Two production routes, both supported:

**1. Batch signing page (recommended, covers all 34 chains)**

Full operator guide, including the security model and troubleshooting:
**[`scripts/safeSignPage/README.md`](scripts/safeSignPage/README.md)**.
Step-by-step instructions to hand to a non-technical co-signer:
**[`scripts/safeSignPage/SIGNER-GUIDE.md`](scripts/safeSignPage/SIGNER-GUIDE.md)**.

Generate a self-contained page with the bundle already embedded, then serve it:

```bash
npx hardhat safe:sign-page --name accept-all     # -> safe-bundles/accept-all/sign.html
npm run sign-page                                # prints the exact URL to open
```

`npm run sign-page` discovers every generated page and prints its link plus a live
signature count, e.g.:

```
bound to  http://127.0.0.1:8547  (loopback only -- not exposed to your LAN)

Open:

  http://127.0.0.1:8547/accept-all/sign.html
      32 chain(s), 0 signature(s) collected, 0/32 ready to execute
```

Connect MetaMask/Rabby with the hardware device behind it and sign every chain in one
sitting. **Each signature is written to disk the moment it is produced** — the server
verifies it against the Safe's owner list and appends to
`safe-bundles/<bundle>/signatures-<signer>.json`, with a `localStorage` mirror as a second
safety net, so a page reload or server restart cannot lose work. Then:

```bash
npx hardhat safe:sign --name accept-all \
  --import safe-bundles/accept-all/signatures-0x<signer>.json
```

> **Use the `http://127.0.0.1` URL, not a `file://` path.** MetaMask does not inject a
> provider into `file://` pages unless you enable "Allow access to file URLs" in
> chrome://extensions → MetaMask → Details.
>
> The server (`scripts/safeSignPage/serve.js`, plain node, no dependencies) binds
> **127.0.0.1 only** and serves `safe-bundles/` — never the repo root, which contains
> `.env` with a live deployer key. Loopback-only matters: a bundle carrying `threshold`
> signatures is a bearer authorization, and `python3 -m http.server` would bind `0.0.0.0`
> and publish it to your whole LAN. Path traversal out of `safe-bundles/` is rejected.
> Override the port with `PORT=8548 npm run sign-page`.

The page walks the bundle in order, switching networks as it goes and calling
`wallet_addEthereumChain` from the bundle's embedded `chainMeta` for networks the wallet has
never seen. That switching is mandatory, not cosmetic: `eth_signTypedData_v4` is refused
when the active chain does not match the SafeTx domain. It re-reads `eth_chainId` before
each signature so a silent mismatch cannot produce a signature over the wrong domain, and
shows the expected `safeTxHash` beside each chain for device comparison. Wallets are
discovered via EIP-6963 (with a `window.ethereum` fallback), so MetaMask and Rabby can
coexist and you can pick which one your device sits behind.

Deliberately narrow: it never broadcasts, never handles key material, has no dependencies
and no build step. `npm run check:sign-page` statically asserts those properties — no
`eth_sendTransaction`, no `XMLHttpRequest`/`WebSocket`/`sendBeacon`, no `eval`, no dynamic
import, no remote script, and at most a single same-origin `fetch` used only to autoload a
local bundle (the generated page embeds the bundle and fetches nothing at all).

It is a convenience, not a trusted component. Every signature is re-verified downstream:
`safe:sign --import` independently recovers the signer and rejects anything that is not a
current owner, and `safe:exec` re-derives each hash, re-validates every signature and
re-checks the live Safe nonce before spending gas.

**2. app.safe.global (the 22 chains with a hosted service)**

Import `<bundle>/tx-builder/<chain>.json` via Transaction Builder, sign with the device,
then relay with `safe:exec --from-service --broadcast` so the owners never pay gas.

> **Sign off-chain, not on-chain.** The Safe UI may offer to "approve" a transaction with
> an on-chain `approveHash` transaction instead of an off-chain signature. Avoid it: it
> costs the signer gas on every chain, which at 34 chains means funding every hardware
> wallet on every network — including exotic ones. An off-chain signature costs nothing and
> the relayer pays. Confirmed working with a Trezor Model T (`signatureType: EOA`).

### Tasks

```bash
npx hardhat safe:predict      # offline: address, initializer, salt, target chain list
npx hardhat safe:preflight    # read-only GO/NO-GO across all 34 chains
npx hardhat safe:deploy       # deploy the Safe proxy       (DRY RUN unless --broadcast)
npx hardhat safe:handover     # transferOwnership from EOA  (DRY RUN unless --broadcast)
npx hardhat safe:build        # diff state -> per-chain SafeTx bundle
npx hardhat safe:sign         # attach signatures to a bundle
npx hardhat safe:exec         # relay execTransaction       (DRY RUN unless --broadcast)
npx hardhat safe:status       # per-chain Safe + router ownership state
npx hardhat safe:proposer     # register the hot wallet as a proposer (22 chains)
npx hardhat safe:refresh-registry   # rewrite deployments/*.json from chain state
npx hardhat fees:cycle        # scan all chains -> sweep bundle -> signing page
npx hardhat fees:scan         # read-only: idle protocol fees per chain
npx hardhat fees:account      # accounting artifact for an executed sweep
npx hardhat fees:report       # roll up collections by date, week or chain
```

Every mutating task is a **dry run by default** and requires `--broadcast`.

## Fee collection

Protocol fees accumulate as the router's own token and ETH balance. There is
**no fee accounting in the contract** — no `collectableFees()` view, no
per-token mapping. The only way to know what is there is to work out which
assets have flowed through (`OrderFilled.tokenIn`) and read `balanceOf`. That
is what `fees:scan` does.

Collection is `sweepAll(address[] tokens, bool includeEth, address to)`, which
is `onlyOwner` and therefore a Safe transaction. It always moves the **full**
balance of each listed asset; there is no amount parameter.

Fees are swept to `OKU_FEE_RECIPIENT` (`util/safeConfig.ts`). It is a
committed constant rather than a `--to` flag because a sweep is irreversible,
so the destination belongs in a reviewable diff instead of being retyped into
a shell each time. `--to` still exists for one-off recoveries.

### Who runs what

The scan is a **coordinator-only** step. Signers never run it.

| Role | Runs | Needs |
| --- | --- | --- |
| Coordinator | `fees:cycle`, then `safe:exec` | RPC endpoints, relayer key, ~15 min |
| Signer | `npm run sign-page`, then signs in the browser | the repo, `npm install`, a hardware wallet |

`fees:cycle` decides which chains are in play and writes that into the bundle,
which **is committed**. A signer pulls, runs `npm run sign-page`, and gets a
page containing exactly the chains that hold fees — no RPC endpoints, no API
keys, no `.env`, no scanning, no waiting. Chains that are empty are dropped
before the bundle exists, so they never reach a signing device. Selection is
by non-zero balance, not by value: a chain holding assets with no USD price
still gets swept.

`sign.html` is gitignored because it is regenerated from the bundle in a
second; `npm run sign-page` rebuilds it, prunes pages for bundles that are
already complete, and prints the URL for what is actually outstanding.

### The regular cycle — `fees:cycle`

One command covers assessing every chain, totalling what is collectable, and
producing the signing page:

```bash
# Look first. Writes a snapshot + markdown report, builds nothing.
npx hardhat fees:cycle --scan-only

# Scan all 34 chains, build the sweep bundle from that exact scan, emit sign.html
npx hardhat fees:cycle

# Then: collect 2 of 3 signatures, dry-run, broadcast.
npm run sign-page                                   # http://127.0.0.1:8547/<name>/sign.html
npx hardhat safe:exec --name sweep-2026-09-22
npx hardhat safe:exec --name sweep-2026-09-22 --broadcast
```

The scan and the build are a single pass on purpose. Discovery — working out
which assets have ever flowed through each router — is the expensive part, and
run separately the two steps pay for it twice. `fees:cycle` scans once and
hands the result to `safe:build --from-scan`.

What the bundle actually needs from the scan is the **token address list**.
`sweepAll(address[] tokens, bool includeEth, address to)` takes no amounts: it
reads `balanceOf` at execution time, moves the entire balance of each listed
token, and silently skips any that are zero. Amounts and USD figures never
enter the calldata. They exist for exactly two purposes — judging whether a
chain is worth a ceremony, and itemizing the manifest signers see — and both
tolerate being approximate. So the snapshot's valuations are reused as-is
rather than re-derived at build time; they would be equally stale by the time
anyone signs, and equally absent from the transaction either way.

This is also why the signing page states plainly that the listed amounts are
an estimate and that what is being approved is "send every listed asset to
this address", not a specific quantity.

It does **not** filter by value. `--min-usd` defaults to `0`, so every chain
holding anything is built. Whether a chain is worth a 2-of-3 hardware ceremony
is an operator judgement, and at 34 chains that decision is worth seeing rather
than inheriting from a constant. The ranked table and the copy-pasteable
`--networks` line make acting on it cheap:

```bash
npx hardhat fees:cycle --min-usd 25                          # apply a floor
npx hardhat fees:cycle --networks base,arbitrum,worldchain   # or pick by hand
```

Useful flags: `--name` (bundle name, default `sweep-<date>`), `--scan-only`,
`--no-cache`, `--no-eth`, `--max-requests`, `--concurrency`, `--force`.

Rebuilding an existing bundle name is refused unless `--force`. A rebuild picks
up fresh Safe nonces, which changes every `safeTxHash` and silently kills any
signatures already collected.

Chains that **could not be read** are reported separately from chains with
nothing to collect, and set a non-zero exit code. Previously both simply
vanished from the bundle, which on a 34-chain sweep is indistinguishable from
a silent loss of collectable fees.

### Log endpoints — `<NET>_LOGS_URL`

Asset discovery walks `OrderFilled` history, and most public endpoints cap
`eth_getLogs` at 10–100 blocks (Alchemy: 100 on the public tier, 10 on free),
which makes long-tail discovery impossible. `--rpc` overrides one chain at a
time; a multi-chain run needs a per-chain override:

```bash
WORLDCHAIN_LOGS_URL=https://...
BASE_LOGS_URL=https://...
```

Same naming as the existing `<NET>_URL` family, including the `arbitrum` →
`ARB_LOGS_URL` deviation. Unset chains fall back to their normal RPC. These
URLs carry API keys, so they live in `.env` and are never written into a
snapshot — only a boolean `usedLogsRpc` is recorded.

### Discovery cache

Discovery is the expensive half of a scan, and re-walking full history on
every run across 34 chains is the difference between minutes and hours. The
scan therefore resumes from a local cache in `.cache/fee-assets/<network>.json`
(gitignored, derived state).

Only the **set of token addresses** ever observed is cached — never balances,
which are re-read live every time. That is what makes it safe: a stale cache
can omit a newly-traded asset, which the next run picks up; it can never
produce a wrong amount.

Each run spends its budget scanning forward from the resume point, then uses
whatever is left to extend coverage *backward*, so a chain converges to full
history over repeated runs instead of being re-decided by whichever endpoint
answered today. A refused log window does **not** advance the resume point:
recording the chain head after a mid-scan refusal would skip those blocks on
every future run, and an asset first traded inside the hole would be
permanently invisible. The hole is re-scanned instead.

The cache is invalidated automatically when the router address changes
(redeployment) or when the stored resume point is ahead of the chain head
(wrong endpoint). `--no-cache` re-walks history from scratch but still retains
known addresses: that an address once took a fee is an append-only fact, and
dropping it would let a budget-limited re-scan quietly shrink the asset list.

### Single chain

```bash
# read-only, any single chain
npx hardhat fees:scan --networks worldchain --rpc <logs-capable-endpoint>

# build by hand, without a cycle snapshot
npx hardhat safe:build --intent sweep --networks worldchain \
  --name sweep-worldchain --rpc <logs-capable-endpoint>

# rehearse against a fork of the real chain, impersonating the Safe
npm run test:fork-sweep
```

`fees:scan --json <path>` writes the same snapshot format `fees:cycle`
produces, so it can be fed straight to `safe:build --from-scan <path>`.

`fees:scan` and `fees:cycle` report two totals and they are not
interchangeable. **Notional** is spot price times balance. **Realizable** caps
each asset at a fraction of its pool depth, because long-tail tokens routinely
quote a real-looking price against a pool holding no quote liquidity. Decide on
realizable.

### Accounting artifacts

`safe:exec` writes the record automatically after a sweep, and
`fees:account --tx <hash>` regenerates it from chain data alone. Layout:

```
fee-reports/
├── data/2026-09-15/worldchain-339173ed.json   machine-readable
├── reports/2026-09-15/worldchain.md           human-readable
├── reports/2026-09-15/SUMMARY.md              cross-chain roll-up for that date
├── ledger.json                                append-only index of every sweep
├── simulations/                               fork rehearsals (gitignored)
└── scans/2026-09-22/17-05-49.{json,md}        pre-sweep snapshots (gitignored)
```

Only what was actually collected is committed. A pre-sweep scan describes money
that merely *exists*, priced off spot pool state, and it is stale the moment the
next swap lands — the same reason fork rehearsals are excluded. The bundle
records which snapshot it was built from in `params.scanRef`.

Human and machine artifacts are separate trees so `data/` can be consumed
programmatically without filtering prose out of it. The date comes from the
**block timestamp**, not the clock, so regenerating a report cannot move it
into the wrong bucket. The JSON filename carries a tx-hash prefix, so a second
sweep of the same chain on the same day cannot overwrite the first — a record
that can be clobbered is not a record.

`ledger.json` and every `SUMMARY.md` are **derived** from `data/`; never edit
them by hand. `fees:report --rebuild` reconstructs both.

Weekly cadence is a filter, not a directory convention — sweeps will not always
land on schedule, and a week-named folder would then either lie or force a
judgement call about which bucket an off-schedule sweep belongs in:

```bash
npx hardhat fees:report                          # everything
npx hardhat fees:report --week 2026-W38          # one ISO week
npx hardhat fees:report --since 2026-07-01 --until 2026-09-30
npx hardhat fees:report --network-name worldchain
npx hardhat fees:report --rebuild                # regenerate ledger + summaries
```

Simulations are diverted to their own gitignored tree. They are rehearsals
describing money that never moved, and letting them sit beside real records
invites someone to read one as an actual collection.

Amounts are derived from two independent sources and cross-checked: the
`TokenWithdrawn`/`EthWithdrawn` events, and the recipient's measured balance
delta. That redundancy is load-bearing — `sweepAll` emits the router's balance
as read *before* the transfer, so a fee-on-transfer or rebasing token delivers
less than the event claims. Any divergence is recorded per-asset as
`deltaMatchesEvent: false` and surfaced in `reconciliation.discrepancies`
rather than being averaged away.

### Forking a chain Hardhat does not know

`hardhat_reset` can change the fork URL but **not** the chainId, and Hardhat
only ships hardfork-activation history for chains it recognises. Set
`FORK_CHAIN_ID` to the real chainId when forking anything else; the config
then reports that chainId and declares the chain post-Cancun, which is what
`npm run test:fork-sweep` relies on. Default behaviour is unchanged.

### Runbook

**0. Rehearse on forks.** Exercises the whole migration — address parity, `SafeToL2Setup`
migration, `Ownable2Step` sequencing, threshold enforcement, MultiSend batching and the
permissionless executor — with zero real transactions:

```bash
npx hardhat run scripts/testForkSafeMigration.ts
npx hardhat test test/base/SafeConfig.ts
```

**1. Preflight.** Must report `GO`. Note it reports `INCOMPLETE` (not `GO`) when an RPC
failure leaves a check unverified — an unknown is not a pass:

```bash
npx hardhat safe:preflight
```

**2. Deploy the Safe.** Canary one cheap chain first and confirm it can actually execute
a transaction; a deployed Safe is not proof the chain can run `execTransaction`:

```bash
npx hardhat safe:deploy                                  # dry run, all 34
npx hardhat safe:deploy --networks telos --broadcast      # canary
npx hardhat safe:deploy --broadcast                       # the rest
```

**3. Register proposers** (optional, 22 chains). The delegator must be a Safe *owner*, so
this needs a hardware wallet. Easiest via the UI (Settings → Setup → Proposers); for a
scripted run, `safe:proposer --print` emits the exact EIP-712 payloads:

```bash
npx hardhat safe:proposer --list
npx hardhat safe:proposer --print
```

**4. Hand over ownership.** `transferOwnership` only sets `pendingOwner`; the deployer
keeps full control until the Safe accepts. That split is the safety net — if the Safe is
missing or can't transact on some chain, `acceptOwnership` never happens and ownership
stays put. A botched handover is a no-op, not a loss. `safe:handover` independently
re-verifies the Safe's owners, threshold, singleton, fallback handler and module list on
each chain before sending.

```bash
npx hardhat safe:handover --networks telos --broadcast    # step 1: from the deployer EOA
npx hardhat safe:build --intent accept-ownership --networks telos
npx hardhat safe:sign --name accept-ownership-<stamp> --key-env SAFE_SIGNER_KEY
npx hardhat safe:exec --name accept-ownership-<stamp> --networks telos --broadcast
npx hardhat safe:refresh-registry --networks telos
```

Prove one real admin action through the Safe on the canary before touching the other 33.

**5. Day-2 admin.** All privileged actions now go through the three-stage flow:

```bash
npx hardhat safe:build --intent swap-targets
npx hardhat safe:build --intent pause
npx hardhat safe:build --intent valid-signer --address 0x… --add true
npx hardhat safe:build --intent max-warrant-duration --seconds 300
```

`safe:build` diffs on-chain state so only chains that need work appear, batches multiple
calls per chain into one `MultiSendCallOnly` transaction, verifies every `safeTxHash`
against the Safe's own `getTransactionHash()`, and simulates each inner call from the Safe
address — all before anyone signs.

It writes three artifacts under `safe-bundles/<name>/`:

- the bundle itself (accumulates signatures)
- `tx-builder/<chain>.json` — importable at app.safe.global (22 chains)
- `eip712/<chain>.json` — raw payloads for `safe-cli --trezor` / offline signers (all 34)

Then collect signatures and relay:

```bash
# owners signed in the Safe UI -> pull their confirmations and relay (hot wallet pays gas)
npx hardhat safe:exec --name <bundle> --from-service --broadcast

# or fold in signatures produced by an external hardware-wallet tool
npx hardhat safe:sign --name <bundle> --import sigs.json
npx hardhat safe:exec --name <bundle> --broadcast
```

`safe:exec` re-derives every hash from the stored fields, recovers each signature to a
real owner, checks the live Safe nonce hasn't advanced (stale signatures), and simulates
the full `execTransaction` before spending gas.

> The bundle definition **is** committed — it authorizes nothing on its own and is the
> record of exactly what was proposed. **Signatures are not.** They live in gitignored
> per-signer sidecars (`signatures-0x<addr>.json`), because a set of `threshold`
> signatures is a bearer authorization: anyone holding it can execute the transaction.

### Accepted limitations

Recorded deliberately, not oversights:

- **Pause latency.** Pausing all 34 routers needs 2 hardware signatures × 34 chains.
  Realistically 30–60 minutes. There is no guardian module and no contract change.
- **2-of-3 with `sweepAll`.** Any two compromised devices can sweep fees on all 34 chains.
  A third lost device is survivable; two are not.
- **`renounceOwnership()`** is present in the OkuRouter ABI and is not disabled. It needs
  a deliberate 2-of-3 to call, but it would permanently brick all admin functions.
- **zkSync Era** is incompatible with this CREATE2 replay (different address derivation).
  `zksync` is configured but not deployed; if OkuRouter ever ships there its Safe will be
  at a *different* address.

## License

GPL-3.0
