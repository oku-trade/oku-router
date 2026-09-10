/**
 * safeProposer.ts
 *
 * Register the hot deployer EOA as a Safe *Proposer* (a Transaction Service
 * "delegate") on every chain where Safe runs a hosted service.
 *
 * What a proposer can and cannot do
 * ---------------------------------
 * A proposer can POST a transaction to the Safe Transaction Service so it
 * appears in the app.safe.global queue for owners to review and sign. It
 * CANNOT sign, and it CANNOT execute. It has zero on-chain authority --
 * registering one grants no ability to move funds or change router config.
 *
 * So this is a convenience, not a capability: it lets the hot wallet stage
 * work for the hardware wallets to approve in a familiar UI. It does not
 * reduce the number of signatures required by even one. The genuinely useful
 * unprivileged role for the hot wallet is *executor*, which needs no
 * registration at all (see tasks/safeAdmin.ts).
 *
 * Coverage: 22 of our 34 chains. The other 12 have no hosted service, so
 * there is nothing to register and nothing is lost -- those chains are driven
 * by safe:build / safe:sign / safe:exec, which never contact Safe's API.
 *
 * Registration protocol (Transaction Service API v2)
 * --------------------------------------------------
 *   POST <service>/v2/delegates/
 *   { safe?, delegate, delegator, signature, label }
 *
 * The signature is EIP-712 over:
 *   domain { name: "Safe Transaction Service", version: "1.0", chainId }
 *   Delegate { address delegateAddress, uint256 totp }
 * signed by `delegator`, which must be a Safe owner. `totp` is
 * floor(unixSeconds / 3600), so a signature is only valid within its hour --
 * generate and submit in one go.
 *
 * Because the delegator must be an OWNER, this task cannot run from the
 * deployer key. It needs one of the hardware-wallet owners to sign. Two
 * modes:
 *   --key-env VAR  sign with a local key (only useful if an owner key is
 *                  available in software; not the case for our 3 signers)
 *   --print        emit the exact EIP-712 payloads and a ready-to-run curl
 *                  for each chain, so an owner can sign with their hardware
 *                  wallet via any EIP-712 signer and submit.
 *
 * In practice the simplest route for a hardware-wallet owner is the UI:
 * app.safe.global -> Settings -> Setup -> Proposers -> Add proposer, per
 * chain. This task exists for scripted/audited runs and to document the
 * exact payload.
 *
 * Usage:
 *   npx hardhat safe:proposer --print
 *   npx hardhat safe:proposer --key-env OWNER_KEY --broadcast
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { TypedDataEncoder, Wallet, getAddress } from "ethers";
import type { TypedDataField } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  OKU_DEPLOYER_EOA,
  assertOkuSafeConfig,
  getOkuSafeDeployment,
  hasSafeTxService,
  safeTxServiceUrl,
} from "../util/safeConfig";
import { listSafeChains, pad } from "../util/safeChains";

const DELEGATE_TYPES: Record<string, TypedDataField[]> = {
  Delegate: [
    { name: "delegateAddress", type: "address" },
    { name: "totp", type: "uint256" },
  ],
};

function delegateDomain(chainId: number) {
  return { name: "Safe Transaction Service", version: "1.0", chainId };
}

/** floor(unixSeconds / 3600) -- the hour bucket the service accepts. */
function totp(): number {
  return Math.floor(Date.now() / 1000 / 3600);
}

task("safe:proposer", "Register the hot deployer EOA as a Safe proposer (delegate)")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addOptionalParam("delegate", `Address to register (default ${OKU_DEPLOYER_EOA})`)
  .addOptionalParam("label", "Label shown in the Safe UI", "oku-deployer-relayer")
  .addOptionalParam("keyEnv", "Env var holding an OWNER private key to sign with")
  .addFlag("print", "Print EIP-712 payloads + curl commands instead of signing")
  .addFlag("broadcast", "Actually POST to the Safe Transaction Service")
  .addFlag("list", "List currently registered proposers per chain and exit")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const delegate = getAddress(String(taskArgs.delegate ?? OKU_DEPLOYER_EOA));
    const label = String(taskArgs.label);

    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only).filter((c) => hasSafeTxService(c.chainId));
    const skipped = listSafeChains(hre, only).filter((c) => !hasSafeTxService(c.chainId));

    console.log("\n" + "=".repeat(96));
    console.log("SAFE PROPOSER (Transaction Service delegate)");
    console.log("=".repeat(96));
    console.log(`Safe      : ${dep.address}`);
    console.log(`Delegate  : ${delegate}`);
    console.log(`Label     : ${label}`);
    console.log(`Chains    : ${chains.length} with a hosted service`);
    if (skipped.length) {
      console.log(
        `No service (${skipped.length}, nothing to register): ` +
          skipped.map((c) => c.network).join(", "),
      );
    }
    console.log(
      `\nReminder: a proposer cannot sign and cannot execute. This grants no\n` +
        `on-chain authority. It only lets ${delegate.slice(0, 10)}… queue\n` +
        `transactions into the Safe{Wallet} UI for the owners to approve.`,
    );

    // ---- --list ----
    if (taskArgs.list) {
      console.log("");
      console.log(pad("network", 12) + pad("chainId", 9) + "registered proposers");
      console.log("-".repeat(96));
      for (const c of chains) {
        const base = safeTxServiceUrl(c.chainId)!;
        try {
          const res = await fetch(`${base}/v2/delegates/?safe=${dep.address}`, {
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) {
            console.log(pad(c.network, 12) + pad(c.chainId, 9) + `HTTP ${res.status}`);
            continue;
          }
          const j = (await res.json()) as {
            results?: { delegate: string; label: string }[];
          };
          const list = (j.results ?? []).map((r) => `${r.delegate} (${r.label})`);
          console.log(
            pad(c.network, 12) + pad(c.chainId, 9) + (list.length ? list.join(", ") : "none"),
          );
        } catch (e) {
          const anyE = e as { message?: string };
          console.log(pad(c.network, 12) + pad(c.chainId, 9) + `error: ${anyE.message}`);
        }
      }
      console.log("");
      return;
    }

    // ---- --print ----
    if (taskArgs.print || (!taskArgs.keyEnv && !taskArgs.broadcast)) {
      const outDir = path.resolve(__dirname, "..", "safe-bundles", "proposer-payloads");
      fs.mkdirSync(outDir, { recursive: true });
      const t = totp();
      console.log(
        `\nEIP-712 payloads written for an OWNER to sign (totp=${t}, valid this hour only).`,
      );
      console.log(`Output: ${outDir}\n`);
      for (const c of chains) {
        const payload = TypedDataEncoder.getPayload(
          delegateDomain(c.chainId),
          DELEGATE_TYPES,
          { delegateAddress: delegate, totp: t },
        );
        const hash = TypedDataEncoder.hash(
          delegateDomain(c.chainId),
          DELEGATE_TYPES,
          { delegateAddress: delegate, totp: t },
        );
        fs.writeFileSync(
          path.join(outDir, `${c.network}.json`),
          JSON.stringify(
            {
              network: c.network,
              chainId: c.chainId,
              endpoint: `${safeTxServiceUrl(c.chainId)}/v2/delegates/`,
              digestToSign: hash,
              eip712: payload,
              body: {
                safe: dep.address,
                delegate,
                delegator: "<OWNER ADDRESS>",
                signature: "<SIGNATURE>",
                label,
              },
            },
            null,
            2,
          ) + "\n",
        );
        console.log(`  ${pad(c.network, 12)} digest ${hash}`);
      }
      console.log(
        `\nSimplest path for a hardware-wallet owner is the UI instead:\n` +
          `  app.safe.global -> your Safe -> Settings -> Setup -> Proposers -> Add proposer\n` +
          `Repeat on each of the ${chains.length} chains. One owner signature each, no gas.`,
      );
      console.log("");
      return;
    }

    // ---- sign + submit with a local owner key ----
    const keyEnv = String(taskArgs.keyEnv);
    const key = process.env[keyEnv];
    if (!key) throw new Error(`env var ${keyEnv} is not set`);
    const wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
    const delegator = getAddress(wallet.address);
    if (!dep.owners.map((o) => getAddress(o)).includes(delegator)) {
      throw new Error(
        `${delegator} is not a Safe owner. The Transaction Service requires the ` +
          `delegator to be an owner. Owners: ${dep.owners.join(", ")}`,
      );
    }
    console.log(`\nDelegator : ${delegator} (owner)`);
    if (!taskArgs.broadcast) {
      console.log("[DRY RUN] would POST to each service; re-run with --broadcast");
    }

    let ok = 0;
    let failed = 0;
    for (const c of chains) {
      const base = safeTxServiceUrl(c.chainId)!;
      // Recompute totp per chain so a slow run can't submit a stale bucket.
      const t = totp();
      const signature = await wallet.signTypedData(
        delegateDomain(c.chainId),
        DELEGATE_TYPES,
        { delegateAddress: delegate, totp: t },
      );
      const body = {
        safe: dep.address,
        delegate,
        delegator,
        signature,
        label,
      };
      if (!taskArgs.broadcast) {
        console.log(`  ${pad(c.network, 12)} would POST ${base}/v2/delegates/`);
        ok++;
        continue;
      }
      try {
        const res = await fetch(`${base}/v2/delegates/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25_000),
        });
        if (res.ok || res.status === 201 || res.status === 202) {
          console.log(`  ✓ ${pad(c.network, 12)} registered`);
          ok++;
        } else {
          const text = await res.text();
          console.log(`  ✗ ${pad(c.network, 12)} HTTP ${res.status}: ${text.slice(0, 160)}`);
          failed++;
        }
      } catch (e) {
        const anyE = e as { message?: string };
        console.log(`  ✗ ${pad(c.network, 12)} ${anyE.message}`);
        failed++;
      }
    }

    console.log("\n" + "-".repeat(96));
    console.log(`${taskArgs.broadcast ? "registered" : "would register"}: ${ok}   failed: ${failed}`);
    if (failed) process.exitCode = 1;
    console.log("");
  });
