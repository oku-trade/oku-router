# Signer instructions — Oku Router multisig handover

You are one of three hardware-wallet signers on the Oku multisig
`0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F` (2-of-3). We need your approval to
transfer ownership of the Oku Router contracts on **32 chains** to it.

- **What you approve:** one call per chain, `acceptOwnership()`. It makes the
  multisig the owner of that chain's router. It cannot move funds or do
  anything else.
- **Cost to you:** nothing. You produce signatures only — no transactions from
  your wallet, no gas on any chain.
- **Time:** ~20 minutes, mostly confirming 32 prompts on your device.
- Nothing here will ever ask for your seed phrase.

---

## Requirements

- Node.js 20+ (`node --version`)
- Chrome/Brave/Edge with **MetaMask**, and your Trezor/Ledger connected
  through it
- A clone of the `okuRouter` repo, up to date on the default branch

---

## Steps

**1. Install dependencies**

```bash
npm install
```

**2. Confirm the bundle is present**

It is committed, so a clone or `git pull` is enough:

```bash
ls safe-bundles/accept-all.json
```

**3. Generate your signing page**

```bash
npx hardhat safe:sign-page --name accept-all
```

Expect `safe : 0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F  2 of 3`.

**4. Start the local server and leave it running**

```bash
npm run sign-page
```

It prints the URL, e.g. `http://127.0.0.1:8547/accept-all/sign.html`. This
server is what writes your signatures to disk — keep it open until you're
done.

> Use the printed `http://127.0.0.1` URL. Opening `sign.html` directly as a
> `file://` path will not work — MetaMask does not inject a provider there.

**5. Connect your wallet**

Unlock your device, click **Connect wallet**, and select your signer account.

The badge must read **✓ Safe owner**. If it reads **✗ NOT a Safe owner**,
you've selected the wrong account in MetaMask — switch and reconnect.

**6. Sign**

Click **Sign all remaining**, then for each of the 32 chains:

- Approve the MetaMask **switch network** / **add network** prompt. This is
  required — a signature is only valid for the correct chain, and several of
  these networks are unusual.
- Confirm on your hardware wallet.

The status line should stay green:

```
✓ autosaved to disk — 12 signature(s) in safe-bundles/accept-all/signatures-0x….json
```

If it ever turns red (**NOT saved to disk**), stop and tell the coordinator
before closing the tab.

**7. Send your signatures back**

```
safe-bundles/accept-all/signatures-0xYOURADDRESS.json
```

Send that one file to the coordinator over any normal channel. It is not a
secret and is useless alone — two of three signers are required. Then `Ctrl+C`
the server.

---

## Verifying on the device

Your hardware wallet will likely show **"unknown network"** or an odd token
symbol on many of these chains. That's expected — most aren't in the device's
built-in list. Verify these instead:

- **verifying contract** = `0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F`
- the **`safeTxHash`** matches the value shown on that chain's row in the page

Every one of the 32 requests is the same action. If you see anything other
than `acceptOwnership()` described on the row, stop.

## Sign off-chain, not on-chain

If you also use app.safe.global, note it sometimes offers to "approve" a
transaction via an on-chain `approveHash` transaction. **Don't** — that costs
you gas on every chain, and some signers hold no balance on many of these 32.
This page only ever produces off-chain signatures, so using it avoids the
issue entirely.

## Stopping and resuming

Close the tab whenever you like. Everything signed so far is already on disk.
To continue, repeat steps 4–6; already-signed chains are skipped.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no injected wallet found` | Check the diagnostics box on the page. Usually a `file://` URL, a locked extension, or the site not in MetaMask → Connected sites. Hard-reload after unlocking. |
| Multiple wallets installed | The page lists them (EIP-6963); pick the one your device sits behind. |
| `✗ NOT a Safe owner` | Wrong MetaMask account selected. |
| `bundle not found` at step 3 | You're not in the repo root, or the repo is out of date — `git pull`. |
| `Port 8547 is already in use` | A stale server is running. Stop it, or use `PORT=8548 npm run sign-page`. |
| A signature is rejected | Reason appears in the page log. Usually the wrong account, or a stale bundle — `git pull` and redo step 3. |
| Signatures stop being accepted | The multisig executed something else and nonces moved. The coordinator will rebuild; your old signatures are void. |

Nothing you do here changes any blockchain state. No change occurs until two
signers are combined and submitted by the coordinator.
