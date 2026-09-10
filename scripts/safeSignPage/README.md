# Safe batch signer — operator guide

Everything needed to collect hardware-wallet signatures for a multi-chain Safe
operation lives in this directory.

| file | what it is |
| --- | --- |
| `index.html` | the signing page. Hand-written HTML + JS, no dependencies, no build step |
| `serve.js` | local static server + signature autosave endpoint. Plain node, no dependencies |
| `check.js` | static self-check of the page's security properties (`npm run check:sign-page`) |
| `README.md` | this file |

Generated artifacts live under `safe-bundles/` (gitignored) — see
[Where things end up](#where-things-end-up).

---

## Why this exists

Signature collection is the one part of a 34-chain Safe operation that cannot
be batched on-chain. `chainId` is inside the SafeTx EIP-712 domain and the
nonce is per-chain, so **every chain needs its own signature from every
signer**. There is no stock-Safe way around that.

The two off-the-shelf options both fall short at this scale:

- **app.safe.global** works, and is proven against this Safe — but it covers
  only the 22 of our 34 chains that have a hosted Transaction Service, one
  network at a time.
- **safe-cli** covers the rest, but is interactive per chain and tends to fall
  back to on-chain `approveHash`, which costs the signer gas on *every* chain.

This page reuses the exact path already proven in production — browser →
injected wallet → hardware device — and points it at our own payloads, so one
signer can clear all 32 chains in a single sitting with no gas.

---

## Quick start

```bash
# 1. build the bundle (only needed once per operation)
npx hardhat safe:build --intent accept-ownership --name accept-all

# 2. generate a self-contained page with the bundle embedded
npx hardhat safe:sign-page --name accept-all

# 3. serve it — prints the exact URL
npm run sign-page
```

Then open the printed URL (e.g. `http://127.0.0.1:8547/accept-all/sign.html`),
connect your wallet, confirm the badge reads **“✓ Safe owner”**, and click
**Sign all remaining**.

```bash
# 4. merge each signer's file into the bundle
npx hardhat safe:sign --name accept-all \
  --import safe-bundles/accept-all/signatures-0xYOURADDRESS.json

# 5. relay from the hot wallet (owners pay no gas)
npx hardhat safe:exec --name accept-all             # dry run
npx hardhat safe:exec --name accept-all --broadcast
```

> **Use the `http://127.0.0.1` URL, not a `file://` path.** MetaMask does not
> inject a provider into `file://` pages unless you enable “Allow access to
> file URLs” in `chrome://extensions` → MetaMask → Details. Serving over
> loopback avoids the issue and is required for autosave.

---

## Signatures are saved as you go

Each signature is persisted **the moment it is produced**, in two independent
places, before the page moves to the next chain:

1. **Disk**, via `POST /api/signature` to the local server, which verifies it
   and appends to `safe-bundles/<bundle>/signatures-<signer>.json`.
2. **`localStorage`**, keyed by bundle + signer, restored automatically on
   reload.

The status line under the buttons tells you which of these is true:

```
✓ autosaved to disk — 7 signature(s) in safe-bundles/accept-all/signatures-0x43A9….json
⚠ NOT saved to disk — 7 signature(s) exist only in this tab...
```

If you ever see the red variant, **use Download before closing the tab**.

This behaviour exists because an earlier revision of this page kept signatures
in memory only. A real signature for Optimism was produced on a Trezor and
lost to a page reload, because nothing was written anywhere until the operator
clicked Download. Do not reintroduce that.

### The server verifies before it writes

`POST /api/signature` does not trust the payload. It recovers the signer from
`(safeTxHash, signature)` and rejects the request unless the recovered address
is a **current owner of that bundle's Safe** — the same check
`safe:sign --import` performs, moved earlier so a signer on the wrong account
learns about it on device confirmation #1 rather than after all 32.

Rejections are surfaced in the page log and in the server's stdout:

```
✓ saved  op           0x43A9beCd…  [7/32]  -> safe-bundles/accept-all/signatures-0x43A9….json
✗ rejected signature: signature recovers to 0x74E5…, which is not a Safe owner
```

The endpoint deliberately writes to a **separate** file rather than into
`accept-all.json`. The bundle stays the authoritative record and
`safe:sign --import` remains the single, tested merge path.

---

## What each signer must check on their device

For every chain the page shows the expected `safeTxHash` next to the row.
Confirm the device shows the **same digest**, and that the EIP-712 domain's
`verifyingContract` is the Safe and `chainId` is the intended chain.

On exotic chains a Trezor may display **“unknown network”**. That is expected —
the domain fields are the real check, not the chain name.

### Sign off-chain, never on-chain

Safe's UI may offer to “approve” a transaction with an on-chain `approveHash`
transaction instead of an off-chain signature. **Avoid it.** It costs the
signer gas on every chain, which at 34 chains means funding every hardware
wallet on every network, including chains where obtaining native gas is
awkward. An off-chain signature costs nothing and the relayer pays.

This page can only ever produce off-chain signatures — it contains no
`eth_sendTransaction` at all, which `check.js` asserts.

---

## Security model

The page is a **convenience, not a trusted component**. Every signature it
emits is independently re-verified twice downstream: by
`safe:sign --import` (recovers the signer, rejects non-owners) and again by
`safe:exec` (re-derives each hash, re-validates every signature, and re-checks
the live Safe nonce before spending gas).

What the page itself guarantees, all asserted by `npm run check:sign-page`:

- never broadcasts a transaction — no `eth_sendTransaction`
- never requests open-ended signing — no `eth_sign` / `personal_sign`
- never reads, stores or transmits key material
- no `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `eval`, `new Function`,
  dynamic `import()`, or remote `<script src>`
- at most two `fetch` calls, both to relative same-origin paths: reading the
  local bundle, and posting a signature to `/api/signature`
- re-reads `eth_chainId` immediately before every signature, so a silent
  network mismatch cannot produce a signature over the wrong domain

There is deliberately **no `Content-Security-Policy` meta tag**. An earlier
revision set `default-src 'none'`, which blocked MetaMask from injecting its
provider and left the page unable to detect any wallet. A policy that breaks
the page's only function is not a control; the guarantees above are structural
and grep-checkable instead.

### Server hardening

`serve.js` is a local dev server handling a **write** endpoint, so:

- binds **`127.0.0.1` only**. `python3 -m http.server` binds `0.0.0.0` and
  would publish `safe-bundles/` to your whole LAN — and a bundle carrying
  `threshold` signatures is a *bearer authorization* anyone can execute.
- serves `safe-bundles/` and nothing above it. The repo root is never served,
  because it contains `.env` with a live deployer key. Path traversal out of
  the root is rejected.
- rejects non-loopback peers, and any request whose `Origin`/`Host` is not our
  own. Local servers are reachable from any page in your browser via **DNS
  rebinding**, so loopback binding alone is not sufficient.
- caps request bodies at 8 KB, accepts JSON only, and `405`s any method other
  than `GET`/`HEAD` on static paths or `POST` on the endpoint.
- sends `no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

Override the port with `PORT=8548 npm run sign-page`.

---

## Where things end up

All under `safe-bundles/`, which is **gitignored** — a signed bundle is a
bearer authorization and must never be committed.

```
safe-bundles/
  accept-all.json                        the bundle (authoritative; accumulates signatures)
  accept-all/
    sign.html                            self-contained page, bundle embedded, no signatures
    signatures-0x<signer>.json           autosaved per signer  <-- feeds safe:sign --import
    tx-builder/<chain>.json              importable at app.safe.global (tx-service chains only)
    eip712/<chain>.json                  raw payloads for safe-cli / offline signers
```

`sign.html` contains the full transaction set but **no signatures and no
keys**, so it is safe to hand to each signer.

---

## Troubleshooting

**“no injected wallet found”**
Check the diagnostics panel on the page. Usual causes, in order: you are on a
`file://` URL (use `npm run sign-page`); the extension is locked; the site is
not in MetaMask → Connected sites; or the provider was injected before the
page loaded — hard-reload.

**Multiple wallets installed**
The page discovers wallets via EIP-6963 and shows a dropdown when more than
one is present. Pick the one your hardware device sits behind.

**“✗ NOT a Safe owner”**
You are connected with the wrong account. Signatures from it will be rejected
by the server and by `safe:sign --import`. This is also a safe way to
rehearse the flow with a hot wallet — just expect the red badge.

**Port already in use**
Something else is on 8547 — often a stale server from an earlier run. Find and
stop it, or use `PORT=8548 npm run sign-page`. Note that a stale server will
happily serve *old* code, which is confusing; check the process list if
behaviour looks out of date:

```bash
ss -ltnp | grep 8547
ps -eo pid,etime,cmd | grep '[s]afeSignPage/serve.js'
```

**A signature was rejected**
Read the reason in the page log. The common ones are wrong account
(recovers to a non-owner) and a stale bundle (the `safeTxHash` is not in it —
regenerate with `safe:build` and `safe:sign-page`).

**Signatures stopped being accepted after some other Safe transaction**
Expected. Every signature is bound to a specific Safe nonce. If anything else
executes through that Safe, its nonce advances and the signatures for it are
dead — rebuild with `safe:build` and re-sign. `safe:exec` detects this and
refuses with `STALE` rather than wasting gas.

---

## Do signatures expire?

No. The signed SafeTx struct contains no deadline, expiry or timestamp field —
`Safe.sol` has zero references to any of them. A signature stays valid until
the nonce it targets is consumed. Signing now and executing next week is fine;
this Safe has already executed a transaction whose first signature was **5
days old**.

Because `gasPrice` is `0` in every transaction we build, signatures are also
independent of the fee market — a gas spike between signing and execution
changes nothing.

The only things that invalidate a signature are the Safe's nonce advancing on
that chain, or a change to the owner set or threshold.
