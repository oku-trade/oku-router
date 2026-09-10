# Signing instructions — Oku Router multisig handover

You are one of three hardware-wallet signers on the Oku multisig. We need
your approval to move ownership of the Oku Router contracts on 32 blockchains
to that multisig.

**Time needed:** about 20–30 minutes. Most of it is pressing "confirm" on
your hardware wallet 32 times.

**What this costs you:** nothing. No gas, no transactions from your wallet.
You are only producing signatures; someone else pays to submit them.

**What you are approving:** exactly one action per chain, called
`acceptOwnership()`. It makes the multisig the owner of the Oku Router on that
chain. It cannot move funds. It cannot do anything else.

---

## Before you start — what you need

1. A computer with **Google Chrome** (or Brave/Edge).
2. **MetaMask** installed in that browser, with your **hardware wallet
   connected through it**. If you normally use your Trezor or Ledger via
   MetaMask, you are already set up.
3. Your hardware wallet and its PIN.
4. Two things sent to you by the person coordinating this:
   - the **project folder** (the `okuRouter` repository)
   - a file called **`accept-all.json`**

You do **not** need any private key, seed phrase, or `.env` file. Never type
your seed phrase into anything during this process. Nothing here will ever ask
for it.

---

## Step 1 — Install Node.js (one time only)

Skip this if you already have it.

Go to **https://nodejs.org** and install the version labelled **LTS**. Accept
all the defaults.

To confirm it worked, open a terminal:

- **macOS:** press `Cmd+Space`, type `Terminal`, press Enter
- **Windows:** press the Start key, type `PowerShell`, press Enter
- **Linux:** press `Ctrl+Alt+T`

Type this and press Enter:

```
node --version
```

You should see something like `v20.11.0`. Any version starting with `v20` or
higher is fine.

---

## Step 2 — Open the project folder in the terminal

In your terminal, type `cd ` (the letters c and d, then a **space**), then
drag the `okuRouter` folder from your file manager into the terminal window
and press Enter.

Your terminal should now show the folder name in the prompt. Confirm with:

```
ls
```

You should see names including `contracts`, `scripts`, `tasks`, and
`package.json`. If you do not, you are in the wrong folder — repeat this step.

---

## Step 3 — Install the project (one time only)

```
npm install
```

This takes a few minutes and prints a lot of text. Warnings are normal. Wait
until you get your prompt back.

---

## Step 4 — Put the bundle file in place

Create a folder named `safe-bundles` inside the project folder, and move the
`accept-all.json` file you were sent into it.

The result must look exactly like this:

```
okuRouter/
  safe-bundles/
    accept-all.json
```

You can do that in your file manager, or in the terminal:

```
mkdir -p safe-bundles
```

then drag `accept-all.json` into the new `safe-bundles` folder.

---

## Step 5 — Build your signing page

```
npx hardhat safe:sign-page --name accept-all
```

You should see:

```
Self-contained signing page written:
  .../safe-bundles/accept-all/sign.html
  safe             : 0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F  2 of 3
```

If instead you see `bundle not found`, the file from Step 4 is in the wrong
place or has the wrong name.

---

## Step 6 — Start the local page

```
npm run sign-page
```

You will see something like:

```
bound to  http://127.0.0.1:8547  (loopback only -- not exposed to your LAN)

Open:

  http://127.0.0.1:8547/accept-all/sign.html
      32 chain(s), 0 signature(s) collected, 0/32 ready to execute
```

**Leave this terminal window open and running for the rest of the process.**
It is what saves your signatures to disk. If you close it, you lose the
safety net.

Copy the `http://127.0.0.1:8547/accept-all/sign.html` address into Chrome.

> Do not open `sign.html` by double-clicking it. MetaMask does not work on
> `file://` pages. You must use the `http://127.0.0.1:8547/...` address.

---

## Step 7 — Connect your wallet

The page shows a list of 32 chains.

1. Plug in and unlock your hardware wallet.
2. Click **Connect wallet**.
3. Approve the connection in the MetaMask popup.
4. Choose the account that is your **multisig signer address**. The
   coordinator will have told you which address that is.

**Check the badge next to your address:**

- **✓ Safe owner** — correct, continue.
- **✗ NOT a Safe owner** — you selected the wrong account in MetaMask. Switch
  accounts in MetaMask and click Connect again. Do not continue until this
  reads ✓.

If it says "no injected wallet found", read the box on the page — it lists the
exact cause and fix.

---

## Step 8 — Sign

Click **Sign all remaining**.

Then, repeating 32 times:

1. MetaMask may ask permission to **switch network**, or to **add a network**
   you have not used before. **Approve it.** This is required — a signature is
   only valid on the correct network, and some of these chains are unusual.
2. A signing request appears. Confirm it on your **hardware wallet screen**.
3. The row turns green: **signed · saved ✓**

Watch the line under the buttons. It should say:

```
✓ autosaved to disk — 12 signature(s) in safe-bundles/accept-all/signatures-0x....json
```

> If that line ever turns red and says **NOT saved to disk**, stop and tell the
> coordinator before closing the browser. Your work is only in the browser at
> that point.

### Things you may see on your hardware wallet

- **"Unknown network"** or a strange token name — **this is expected.** Many
  of these 32 chains are not in your device's built-in list. It does not mean
  anything is wrong.
- Instead of the network name, verify these two things on the device:
  - the **contract / verifying contract** is
    `0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F`
  - the long `safeTxHash` value matches the one shown on that chain's row in
    the page

### If you need to stop partway

Just close the browser tab. Nothing is lost — everything signed so far is
already on disk. To continue later, repeat Step 6, reconnect, and click
**Sign all remaining** again. It skips what you have already done.

---

## Step 9 — Send your signatures back

When all 32 rows are green, find this file inside the project folder:

```
safe-bundles/accept-all/signatures-0xYOURADDRESS.json
```

(`0xYOURADDRESS` will be your own signer address.)

Send that one file to the coordinator — Slack, email, or any normal channel is
fine. It is not a secret and it cannot be used on its own: two of the three
signers are required, so your file alone cannot move anything.

Do **not** send your seed phrase, your PIN, or any other file. Only this one.

Then press `Ctrl+C` in the terminal to stop the server.

---

## That's it

The coordinator combines your signatures with the other signer's and submits
them, paying all the fees. You will not need to do anything else.

---

## Quick answers

**Is this going to spend my money?**
No. You are signing messages, not sending transactions. Your wallet needs no
funds on any of these chains.

**What if I approve the wrong thing?**
Every one of the 32 requests is the same single action, `acceptOwnership()`.
There is nothing else in this batch. Signatures are also checked twice more
before anything is submitted, and are rejected if they do not come from a
real multisig owner.

**MetaMask is asking to add a network I have never heard of.**
Expected. Oku Router runs on 34 chains and some are new. Approve it.

**Can I do this on my phone?**
No. Use a desktop browser with MetaMask and your hardware wallet.

**I got an error I do not understand.**
Copy the exact text and send it to the coordinator. Nothing you do here can
break anything — until two signers are combined and submitted, no change
happens on any blockchain.

**How long are my signatures valid?**
Indefinitely. There is no expiry. They only stop being usable if the multisig
does some other transaction first, which the coordinator is avoiding.
