/**
 * safeAdmin.ts
 *
 * Three-stage admin flow for driving 34 OkuRouters from one Safe.
 *
 *   safe:build  -- diff desired vs on-chain state, emit one SafeTx per chain
 *                  into a bundle file. Verifies every safeTxHash against the
 *                  Safe's own getTransactionHash() before anyone signs.
 *   safe:sign   -- attach signatures to a bundle (local key, or import
 *                  signatures produced by an external hardware-wallet tool).
 *   safe:exec   -- merge signatures and broadcast execTransaction on every
 *                  chain from the hot deployer EOA.
 *   safe:status -- per-chain Safe + router state at a glance.
 *
 * Why this exists
 * ---------------
 * `execTransaction` is permissionless: once `threshold` signatures exist,
 * ANY address can broadcast it. That is the single most useful property for
 * our situation. It means the hot deployer EOA can relay and pay gas on all
 * 34 chains while holding zero authority, and our hardware wallets never need
 * a gas balance anywhere.
 *
 * By contrast a Safe *Proposer* (delegate) cannot sign and cannot execute --
 * it only pre-fills the Safe{Wallet} queue, and only on the 22 chains that
 * have a hosted Transaction Service. It is a UI convenience, not a throughput
 * mechanism. These tasks deliberately do not depend on it.
 *
 * Signature collection is the one step that cannot be collapsed: chainId is
 * inside the SafeTx EIP-712 domain and the nonce is per-chain, so each chain
 * needs its own signature from each signer. There is no stock-Safe way around
 * that. Practical routes, both supported here:
 *   - the 22 tx-service chains: owners sign in app.safe.global with their
 *     hardware wallet, then `safe:exec --from-service` pulls the collected
 *     signatures and relays so the owners never pay gas.
 *   - all 34 chains: `safe:build` writes EIP-712 payloads that safe-cli
 *     (`--trezor` / `--ledger`) or any offline signer can consume, and
 *     `safe:sign --import` folds the results back in.
 *
 * Bundles are bearer authorizations -- anyone holding a bundle with
 * `threshold` signatures can execute it. safe-bundles/ is gitignored.
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { TypedDataEncoder, Wallet, getAddress } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  OKU_DEPLOYER_EOA,
  SAFE_MULTISEND_CALL_ONLY,
  assertOkuSafeConfig,
  getOkuSafeDeployment,
  hasSafeTxService,
  safeTxServiceUrl,
} from "../util/safeConfig";
import {
  SAFE_IFACE,
  SAFE_TX_TYPES,
  SafeOperation,
  buildBatchedSafeTx,
  decodeRevert,
  hashSafeTx,
  packSignatures,
  recoverSafeTxSigner,
  safeDomain,
  verifySafeTxHashOnChain,
  type SafeTransactionData,
} from "../util/safeTx";
import {
  confirmTx,
  gasOverrides,
  listSafeChains,
  makeProvider,
  mapLimit,
  pad,
  resolveDeployerKey,
  type SafeChain,
} from "../util/safeChains";
import { withRetry } from "../util/rpcRetry";
import { NETWORK_CONFIGS, type SwapTarget } from "../util/deploymentConfig";
import { MAINNET_CHAINS } from "@gfxlabs/oku-chains";
import { OkuRouter__factory } from "../typechain-types";

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");
const ROUTER_IFACE = OkuRouter__factory.createInterface();

/** Supported build intents. */
type Intent =
  | "accept-ownership"
  | "pause"
  | "unpause"
  | "swap-targets"
  | "valid-signer"
  | "max-warrant-duration";

interface BundleCall {
  to: string;
  data: string;
  value: string;
  /** Human-readable description, shown at sign-off time. */
  label: string;
}

/**
 * Wallet-facing chain metadata, embedded so the offline signing page can
 * call `wallet_addEthereumChain` for networks the signer's wallet has never
 * seen (Gensyn, Saga, Redbelly, ...).
 *
 * This is not cosmetic: `eth_signTypedData_v4` is rejected by MetaMask unless
 * the active network matches the SafeTx domain's chainId, so the page must be
 * able to switch to -- and therefore possibly add -- every chain in a bundle.
 */
interface BundleChainMeta {
  chainName: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrl?: string;
}

interface BundleChain {
  network: string;
  chainId: number;
  router: string;
  nonce: string;
  chainMeta?: BundleChainMeta;
  calls: BundleCall[];
  tx: {
    to: string;
    value: string;
    data: string;
    operation: number;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: string;
    refundReceiver: string;
    nonce: string;
  };
  safeTxHash: string;
  /** EIP-712 payload, for external/hardware signers. */
  eip712: unknown;
  signatures: { signer: string; signature: string }[];
  /**
   * Owners known to have signed already. Present only in the copy embedded
   * into a distributed sign.html, where signature bytes are stripped -- it
   * lets the page grey out completed rows without carrying authorization
   * material.
   */
  signedBy?: string[];
  note?: string;
}

interface Bundle {
  name: string;
  intent: Intent;
  params: Record<string, unknown>;
  safe: string;
  threshold: number;
  owners: string[];
  createdAt: string;
  chains: BundleChain[];
}

function serializeTx(tx: SafeTransactionData) {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: Number(tx.operation),
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

function deserializeTx(t: BundleChain["tx"]): SafeTransactionData {
  return {
    to: getAddress(t.to),
    value: BigInt(t.value),
    data: t.data,
    operation: t.operation as SafeOperation,
    safeTxGas: BigInt(t.safeTxGas),
    baseGas: BigInt(t.baseGas),
    gasPrice: BigInt(t.gasPrice),
    gasToken: getAddress(t.gasToken),
    refundReceiver: getAddress(t.refundReceiver),
    nonce: BigInt(t.nonce),
  };
}

/**
 * Resolve an intent into the concrete calls for one chain.
 *
 * Returns an empty array when the chain is already in the desired state, so
 * the bundle only contains chains that actually need work -- a no-op SafeTx
 * would still burn a nonce and a signing ceremony.
 */
async function callsForIntent(
  intent: Intent,
  params: Record<string, unknown>,
  chain: SafeChain,
  provider: JsonRpcProvider,
  safeAddress: string,
): Promise<{ calls: BundleCall[]; note?: string }> {
  const router = OkuRouter__factory.connect(chain.router!, provider);

  switch (intent) {
    case "accept-ownership": {
      const [owner, pending] = await Promise.all([router.owner(), router.pendingOwner()]);
      if (getAddress(owner) === getAddress(safeAddress)) {
        return { calls: [], note: "Safe already owns this router" };
      }
      if (getAddress(pending) !== getAddress(safeAddress)) {
        return {
          calls: [],
          note:
            `pendingOwner is ${getAddress(pending)}, not the Safe. Run ` +
            `\`safe:handover --broadcast\` first (transferOwnership is an EOA tx).`,
        };
      }
      return {
        calls: [
          {
            to: chain.router!,
            data: ROUTER_IFACE.encodeFunctionData("acceptOwnership"),
            value: "0",
            label: `acceptOwnership() -- Safe takes ownership of OkuRouter ${chain.router}`,
          },
        ],
      };
    }

    case "pause":
    case "unpause": {
      const paused = await router.paused();
      if (intent === "pause" && paused) return { calls: [], note: "already paused" };
      if (intent === "unpause" && !paused) return { calls: [], note: "already unpaused" };
      return {
        calls: [
          {
            to: chain.router!,
            // Branch explicitly: typechain's generated Interface is typed on
            // literal function names, so a "pause" | "unpause" union is not
            // assignable to encodeFunctionData.
            data:
              intent === "pause"
                ? ROUTER_IFACE.encodeFunctionData("pause")
                : ROUTER_IFACE.encodeFunctionData("unpause"),
            value: "0",
            label: `${intent}() on OkuRouter ${chain.router}`,
          },
        ],
      };
    }

    case "swap-targets": {
      const cfg = NETWORK_CONFIGS[chain.network];
      if (!cfg) return { calls: [], note: "NO_NETWORK_CONFIG" };
      const targets: readonly SwapTarget[] = cfg.knownSwapTargets;
      if (targets.length === 0) return { calls: [], note: "NO_TARGETS_IN_CHAIN_CONFIG" };

      const calls: BundleCall[] = [];
      const skipped: string[] = [];
      for (const t of targets) {
        if (await router.swapTargets(t.address)) continue;
        // Never whitelist an address with no bytecode: a swap target receives
        // ERC20 approvals and arbitrary calls from the router.
        const code = await provider.getCode(t.address);
        if (code === "0x") {
          skipped.push(`${t.name} (no code)`);
          continue;
        }
        calls.push({
          to: chain.router!,
          data: ROUTER_IFACE.encodeFunctionData("updateSwapTargets", [t.address, true]),
          value: "0",
          label: `updateSwapTargets(${t.address}, true)  ${t.name} [${t.protocol}]`,
        });
      }
      return {
        calls,
        note: skipped.length ? `skipped: ${skipped.join(", ")}` : undefined,
      };
    }

    case "valid-signer": {
      const signer = getAddress(String(params.address));
      const add = Boolean(params.add);
      const current = await router.validSigners(signer);
      if (current === add) return { calls: [], note: `already ${add ? "valid" : "invalid"}` };
      return {
        calls: [
          {
            to: chain.router!,
            data: ROUTER_IFACE.encodeFunctionData("updateValidSigner", [signer, add]),
            value: "0",
            label: `updateValidSigner(${signer}, ${add})`,
          },
        ],
      };
    }

    case "max-warrant-duration": {
      const seconds = BigInt(String(params.seconds));
      const current = await router.maxWarrantDuration();
      if (current === seconds) return { calls: [], note: `already ${seconds}` };
      return {
        calls: [
          {
            to: chain.router!,
            data: ROUTER_IFACE.encodeFunctionData("setMaxWarrantDuration", [seconds]),
            value: "0",
            label: `setMaxWarrantDuration(${seconds})  [was ${current}]`,
          },
        ],
      };
    }
  }
}

/**
 * Resolve wallet-facing chain metadata from chain-config for the signing
 * page. Returns undefined rather than throwing if a chain is unknown -- the
 * page degrades to requiring the signer to add the network manually.
 */
function resolveChainMeta(chainId: number): BundleChainMeta | undefined {
  const n = MAINNET_CHAINS.find((x) => Number(x.id) === chainId);
  if (!n) return undefined;
  return {
    chainName: n.name,
    rpcUrl: n.rpcUrls.default.http[0],
    nativeCurrency: {
      name: n.nativeCurrency.name,
      symbol: n.nativeCurrency.symbol,
      decimals: n.nativeCurrency.decimals,
    },
    blockExplorerUrl: n.blockExplorers?.default?.url,
  };
}

// ---------------------------------------------------------------------------
// Signature storage
//
// Signatures are kept in per-signer sidecar files, never inside the bundle:
//
//   safe-bundles/<name>.json                     transaction definition (committed)
//   safe-bundles/<name>/signatures-<signer>.json signature material (gitignored)
//
// This split is what makes the bundle safe to commit. A bundle that has
// accumulated `threshold` signatures is a bearer authorization -- anyone
// holding it can execute it -- so it must never enter git history. The
// definition on its own authorizes nothing, is derivable from public chain
// state, and is genuinely useful to have under version control: it is the
// record of exactly what was approved, and co-signers can pull it instead of
// being emailed a file.
//
// `safe:exec` reads sidecars and merges them with any legacy in-bundle
// signatures, so older bundles still work.
// ---------------------------------------------------------------------------

export interface SignatureEntry {
  safeTxHash: string;
  signer: string;
  signature: string;
}

function sidecarDir(name: string): string {
  return path.join(BUNDLE_DIR, name);
}

function sidecarFile(name: string, signer: string): string {
  return path.join(sidecarDir(name), `signatures-${getAddress(signer)}.json`);
}

/** Read every per-signer sidecar for a bundle. */
function readSidecars(name: string): SignatureEntry[] {
  const dir = sidecarDir(name);
  if (!fs.existsSync(dir)) return [];
  const out: SignatureEntry[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^signatures-0x[0-9a-fA-F]{40}\.json$/.test(f)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(arr)) out.push(...arr);
    } catch {
      console.log(`  ⚠ ignoring unreadable sidecar ${f}`);
    }
  }
  return out;
}

/** Merge new entries into the signer's sidecar, deduped. Returns count added. */
function writeSidecar(name: string, entries: readonly SignatureEntry[]): number {
  const bySigner = new Map<string, SignatureEntry[]>();
  for (const e of entries) {
    const s = getAddress(e.signer);
    if (!bySigner.has(s)) bySigner.set(s, []);
    bySigner.get(s)!.push({ ...e, signer: s });
  }
  let added = 0;
  fs.mkdirSync(sidecarDir(name), { recursive: true });
  for (const [signer, list] of bySigner) {
    const file = sidecarFile(name, signer);
    let existing: SignatureEntry[] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) existing = parsed;
      } catch {
        existing = [];
      }
    }
    for (const e of list) {
      const dup = existing.some(
        (x) =>
          x.safeTxHash.toLowerCase() === e.safeTxHash.toLowerCase() &&
          getAddress(x.signer) === signer,
      );
      if (!dup) {
        existing.push(e);
        added++;
      }
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
  return added;
}

/**
 * All valid signatures for one chain: sidecars plus any legacy in-bundle
 * entries, deduped by signer and filtered to current owners.
 */
function signaturesFor(
  bundle: Bundle,
  chain: BundleChain,
  sidecars: readonly SignatureEntry[],
): { signer: string; signature: string }[] {
  const owners = new Set(bundle.owners.map((o) => getAddress(o)));
  const out: { signer: string; signature: string }[] = [];
  const seen = new Set<string>();
  const consider = [
    ...chain.signatures.map((s) => ({ ...s, safeTxHash: chain.safeTxHash })),
    ...sidecars,
  ];
  for (const e of consider) {
    if (e.safeTxHash.toLowerCase() !== chain.safeTxHash.toLowerCase()) continue;
    let signer: string;
    try {
      signer = getAddress(e.signer);
    } catch {
      continue;
    }
    if (!owners.has(signer) || seen.has(signer)) continue;
    seen.add(signer);
    out.push({ signer, signature: e.signature });
  }
  return out;
}

function bundlePath(name: string): string {
  return path.join(BUNDLE_DIR, `${name}.json`);
}

function readBundle(name: string): Bundle {
  const p = bundlePath(name);
  if (!fs.existsSync(p)) throw new Error(`bundle not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Bundle;
}

function writeBundle(b: Bundle): string {
  if (!fs.existsSync(BUNDLE_DIR)) fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const p = bundlePath(b.name);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
  return p;
}

/** Safe Transaction Builder JSON, importable at app.safe.global. */
function txBuilderJson(chain: BundleChain, safe: string) {
  return {
    version: "1.0",
    chainId: String(chain.chainId),
    createdAt: Date.now(),
    meta: {
      name: `oku-${chain.network}`,
      description: chain.calls.map((c) => c.label).join(" | "),
      createdFromSafeAddress: safe,
    },
    transactions: chain.calls.map((c) => ({
      to: c.to,
      value: c.value,
      data: c.data,
    })),
  };
}

// ---------------------------------------------------------------------------
// safe:build
// ---------------------------------------------------------------------------

task("safe:build", "Diff on-chain state and emit a per-chain SafeTx bundle")
  .addParam(
    "intent",
    "accept-ownership | pause | unpause | swap-targets | valid-signer | max-warrant-duration",
  )
  .addOptionalParam("name", "Bundle name (default: <intent>-<timestamp>)")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addOptionalParam("address", "For valid-signer: the signer address")
  .addOptionalParam("add", "For valid-signer: true|false")
  .addOptionalParam("seconds", "For max-warrant-duration: the new duration")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const intent = String(taskArgs.intent) as Intent;
    const valid: Intent[] = [
      "accept-ownership",
      "pause",
      "unpause",
      "swap-targets",
      "valid-signer",
      "max-warrant-duration",
    ];
    if (!valid.includes(intent)) {
      throw new Error(`unknown --intent ${intent}. Expected one of: ${valid.join(", ")}`);
    }
    const params: Record<string, unknown> = {};
    if (intent === "valid-signer") {
      if (!taskArgs.address) throw new Error("--address is required for valid-signer");
      if (taskArgs.add === undefined) throw new Error("--add true|false is required");
      params.address = getAddress(String(taskArgs.address));
      params.add = String(taskArgs.add) === "true";
    }
    if (intent === "max-warrant-duration") {
      if (!taskArgs.seconds) throw new Error("--seconds is required");
      params.seconds = String(taskArgs.seconds);
    }

    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = String(taskArgs.name ?? `${intent}-${stamp}`);

    console.log("\n" + "=".repeat(96));
    console.log(`SAFE BUILD  intent=${intent}`);
    console.log("=".repeat(96));
    console.log(`Safe   : ${dep.address}  (${dep.threshold} of ${dep.owners.length})`);
    console.log(`Bundle : ${name}`);
    console.log(`Chains : ${chains.length}`);

    const built = await mapLimit(chains, 5, async (chain): Promise<BundleChain | null> => {
      if (!chain.rpcUrl) {
        console.log(`  ${pad(chain.network, 12)} skip: NO_RPC`);
        return null;
      }
      const provider = makeProvider(chain.rpcUrl, chain.chainId);
      try {
        // The Safe must exist before we can read its nonce or hash a tx.
        const code = await withRetry(
          () => provider.getCode(dep.address),
          `${chain.network}:getCode(safe)`,
        );
        if (code === "0x") {
          console.log(`  ${pad(chain.network, 12)} skip: Safe not deployed on this chain`);
          return null;
        }

        const { calls, note } = await callsForIntent(
          intent,
          params,
          chain,
          provider,
          dep.address,
        );
        if (calls.length === 0) {
          console.log(`  ${pad(chain.network, 12)} nothing to do${note ? ` (${note})` : ""}`);
          return null;
        }

        const nonceRaw = await withRetry(
          () =>
            provider.call({
              to: dep.address,
              data: SAFE_IFACE.encodeFunctionData("nonce"),
            }),
          `${chain.network}:safe.nonce()`,
        );
        const nonce = SAFE_IFACE.decodeFunctionResult("nonce", nonceRaw)[0] as bigint;

        const tx = buildBatchedSafeTx(
          calls.map((c) => ({ to: c.to, data: c.data, value: BigInt(c.value) })),
          nonce,
        );

        // Cross-check our EIP-712 against the Safe's own view function. If
        // these disagree every signature we collect would be worthless, so
        // we refuse to emit the bundle rather than waste a signing ceremony.
        const check = await verifySafeTxHashOnChain(provider, chain.chainId, dep.address, tx);
        if (!check.match) {
          throw new Error(
            `safeTxHash mismatch: local ${check.local} vs on-chain ${check.onChain}`,
          );
        }

        // Simulate the whole execTransaction with a fabricated-but-structurally
        // valid signature set is not possible (signatures are checked), so we
        // instead simulate the inner calls from the Safe to catch reverts like
        // "not the owner" or a bad target before signing.
        for (const c of calls) {
          try {
            await provider.call({ from: dep.address, to: c.to, data: c.data });
          } catch (e) {
            const anyE = e as { data?: string; shortMessage?: string; message?: string };
            const reason = anyE.data ? decodeRevert(anyE.data) : undefined;
            throw new Error(
              `inner call would revert (${c.label}): ${reason ?? anyE.shortMessage ?? anyE.message}`,
            );
          }
        }

        const batched = tx.to === getAddress(SAFE_MULTISEND_CALL_ONLY);
        console.log(
          `  ${pad(chain.network, 12)} ${calls.length} call(s)` +
            `${batched ? " [MultiSend]" : ""}  nonce=${nonce}  hash=${check.local.slice(0, 18)}…`,
        );

        return {
          network: chain.network,
          chainId: chain.chainId,
          router: chain.router!,
          nonce: nonce.toString(),
          chainMeta: resolveChainMeta(chain.chainId),
          calls,
          tx: serializeTx(tx),
          safeTxHash: check.local,
          eip712: TypedDataEncoder.getPayload(
            safeDomain(chain.chainId, dep.address),
            SAFE_TX_TYPES,
            tx,
          ),
          signatures: [],
          note,
        };
      } catch (e) {
        const anyE = e as { shortMessage?: string; message?: string };
        console.log(
          `  ${pad(chain.network, 12)} ✗ ${anyE.shortMessage ?? anyE.message ?? e}`,
        );
        return null;
      } finally {
        provider.destroy();
      }
    });

    const chainsOut = built.filter((b): b is BundleChain => b !== null);
    if (chainsOut.length === 0) {
      console.log("\nNothing to do on any chain. No bundle written.");
      return;
    }
    chainsOut.sort((a, b) => a.chainId - b.chainId);

    const bundle: Bundle = {
      name,
      intent,
      params,
      safe: dep.address,
      threshold: dep.threshold,
      owners: [...dep.owners],
      createdAt: new Date().toISOString(),
      chains: chainsOut,
    };
    const p = writeBundle(bundle);

    // Companion artifacts: Transaction Builder JSON for the Safe UI chains,
    // and raw EIP-712 payloads for offline / hardware signers everywhere.
    const auxDir = path.join(BUNDLE_DIR, name);
    fs.mkdirSync(path.join(auxDir, "tx-builder"), { recursive: true });
    fs.mkdirSync(path.join(auxDir, "eip712"), { recursive: true });
    for (const c of chainsOut) {
      if (hasSafeTxService(c.chainId)) {
        fs.writeFileSync(
          path.join(auxDir, "tx-builder", `${c.network}.json`),
          JSON.stringify(txBuilderJson(c, dep.address), null, 2) + "\n",
        );
      }
      fs.writeFileSync(
        path.join(auxDir, "eip712", `${c.network}.json`),
        JSON.stringify(c.eip712, null, 2) + "\n",
      );
    }

    console.log("\n" + "-".repeat(96));
    console.log(`Bundle written : ${p}`);
    console.log(`  chains needing action : ${chainsOut.length}`);
    console.log(`  total calls           : ${chainsOut.reduce((a, c) => a + c.calls.length, 0)}`);
    console.log(`  signatures needed     : ${chainsOut.length} x ${dep.threshold}`);
    console.log(`  tx-builder JSON       : ${path.join(auxDir, "tx-builder")}  (import at app.safe.global)`);
    console.log(`  EIP-712 payloads      : ${path.join(auxDir, "eip712")}  (safe-cli / offline signers)`);
    console.log(
      `\nEvery safeTxHash above was verified against the Safe's own ` +
        `getTransactionHash(),\nand every inner call was simulated from the Safe ` +
        `address to prove it will not revert.`,
    );
    console.log("");
  });

// ---------------------------------------------------------------------------
// safe:sign-page
// ---------------------------------------------------------------------------

task(
  "safe:sign-page",
  "Emit a self-contained signing page with the bundle embedded (no file picker, no fetch)",
)
  .addParam("name", "Bundle name")
  .setAction(async (taskArgs) => {
    assertOkuSafeConfig();
    const bundle = readBundle(String(taskArgs.name));
    const tpl = path.resolve(__dirname, "..", "scripts", "safeSignPage", "index.html");
    if (!fs.existsSync(tpl)) {
      throw new Error(`signing page template not found at ${tpl}`);
    }
    let html = fs.readFileSync(tpl, "utf8");

    // Strip signature material from the embedded copy.
    //
    // This file gets emailed or Slacked to co-signers, so it should carry no
    // authorization material at all. The page does not need other signers'
    // signature bytes -- it only needs to know WHICH owners have already
    // signed each chain, so it can grey those rows out. `signedBy` carries
    // exactly that and nothing more.
    //
    // Without this, `sign.html` would embed every signature collected so far
    // (32 of them once the first signer imports), turning a file meant for
    // distribution into a partial authorization set.
    const sidecars = readSidecars(bundle.name);
    const shared: Bundle = {
      ...bundle,
      chains: bundle.chains.map((c) => ({
        ...c,
        signatures: [],
        signedBy: signaturesFor(bundle, c, sidecars).map((s) => s.signer),
      })),
    };
    const embeddedSigs = shared.chains.reduce((a, c) => a + c.signatures.length, 0);

    // Injected ahead of the main script so autoloadBundle() finds it in
    // window.__BUNDLE__ and never needs to fetch or prompt. Embedded via a
    // JSON-typed script tag rather than a JS literal so no bundle content can
    // be interpreted as code -- and "</" is escaped so a nested string cannot
    // terminate the tag early.
    const json = JSON.stringify(shared).replace(/<\//g, "<\\/");
    const inject =
      `<script id="__bundle_json" type="application/json">${json}</script>\n` +
      `<script>window.__BUNDLE__ = JSON.parse(` +
      `document.getElementById("__bundle_json").textContent);</script>\n`;

    if (!html.includes("<script>")) {
      throw new Error("signing page template has no <script> block to anchor injection");
    }
    html = html.replace("<script>", `${inject}<script>`);

    const outDir = path.join(BUNDLE_DIR, bundle.name);
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, "sign.html");
    fs.writeFileSync(out, html, "utf8");

    const chains = bundle.chains.length;
    const need = bundle.chains.filter(
      (c) => signaturesFor(bundle, c, sidecars).length < bundle.threshold,
    ).length;
    const alreadySigned = new Set(
      bundle.chains.flatMap((c) =>
        signaturesFor(bundle, c, sidecars).map((s) => s.signer),
      ),
    );
    console.log("");
    console.log(`Self-contained signing page written:`);
    console.log(`  ${out}`);
    console.log(`  bundle embedded  : ${bundle.name} (${chains} chain(s), ${need} still short)`);
    console.log(`  safe             : ${bundle.safe}  ${bundle.threshold} of ${bundle.owners.length}`);
    console.log(`  signatures inside: ${embeddedSigs}  (stripped -- safe to distribute)`);
    if (alreadySigned.size) {
      console.log(
        `  already signed by: ${[...alreadySigned].join(", ")}` +
          `  (recorded as signedBy, no signature bytes)`,
      );
    }
    console.log("");
    console.log(`Next:`);
    console.log(`  npm run sign-page`);
    console.log(`  then open  http://127.0.0.1:8547/${bundle.name}/sign.html`);
    console.log("");
    console.log(
      `Use that URL, not a file:// path -- MetaMask does not inject a provider into\n` +
        `file:// pages unless "Allow access to file URLs" is enabled. The server binds\n` +
        `loopback only and serves safe-bundles/ (never the repo root, which holds .env).`,
    );
    console.log("");
    console.log(
      `This file contains the full transaction set but NO signature bytes and NO\n` +
        `keys, so it is safe to send to a co-signer. Their output comes back via:\n` +
        `  npx hardhat safe:sign --name ${bundle.name} --import <signatures.json>`,
    );
    console.log("");
  });

// ---------------------------------------------------------------------------
// safe:sign
// ---------------------------------------------------------------------------

task("safe:sign", "Attach signatures to a bundle (local key, or import external sigs)")
  .addParam("name", "Bundle name")
  .addOptionalParam(
    "keyEnv",
    "Env var holding a private key to sign with (e.g. SAFE_SIGNER_KEY)",
  )
  .addOptionalParam("import", "Path to a JSON file of {safeTxHash, signer, signature} entries")
  .setAction(async (taskArgs) => {
    assertOkuSafeConfig();
    const bundle = readBundle(String(taskArgs.name));
    const owners = new Set(bundle.owners.map((o) => getAddress(o)));
    const existing = readSidecars(bundle.name);
    const collected: SignatureEntry[] = [];

    let added = 0;
    let skipped = 0;

    if (taskArgs.keyEnv) {
      const key = process.env[String(taskArgs.keyEnv)];
      if (!key) throw new Error(`env var ${taskArgs.keyEnv} is not set`);
      const wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
      const signer = getAddress(wallet.address);
      if (!owners.has(signer)) {
        throw new Error(
          `${signer} is not a Safe owner. Owners: ${[...owners].join(", ")}`,
        );
      }
      console.log(`\nSigning bundle "${bundle.name}" as ${signer}`);
      for (const c of bundle.chains) {
        // Recompute rather than trusting the stored hash: a tampered bundle
        // must not be able to get a signature over a different payload.
        const tx = deserializeTx(c.tx);
        const localHash = hashSafeTx(c.chainId, bundle.safe, tx);
        if (localHash !== c.safeTxHash) {
          throw new Error(
            `bundle integrity failure on ${c.network}: stored hash ${c.safeTxHash} ` +
              `!= recomputed ${localHash}. Refusing to sign.`,
          );
        }
        if (signaturesFor(bundle, c, existing).some((s) => s.signer === signer)) {
          skipped++;
          continue;
        }
        const signature = await wallet.signTypedData(
          safeDomain(c.chainId, bundle.safe),
          SAFE_TX_TYPES,
          tx,
        );
        if (recoverSafeTxSigner(localHash, signature) !== signer) {
          throw new Error(`self-check failed: signature does not recover to ${signer}`);
        }
        collected.push({ safeTxHash: localHash, signer, signature });
        added++;
        console.log(`  ✓ ${pad(c.network, 12)} ${localHash.slice(0, 18)}…`);
      }
    }

    if (taskArgs.import) {
      const raw = JSON.parse(fs.readFileSync(String(taskArgs.import), "utf8")) as {
        safeTxHash: string;
        signer: string;
        signature: string;
      }[];
      console.log(`\nImporting ${raw.length} signature(s) into "${bundle.name}"`);
      for (const entry of raw) {
        const target = bundle.chains.find(
          (c) => c.safeTxHash.toLowerCase() === entry.safeTxHash.toLowerCase(),
        );
        if (!target) {
          console.log(`  ⚠ no chain in bundle matches hash ${entry.safeTxHash}`);
          continue;
        }
        // Recover rather than trust the claimed signer.
        const recovered = recoverSafeTxSigner(target.safeTxHash, entry.signature);
        if (!owners.has(recovered)) {
          console.log(
            `  ✗ ${pad(target.network, 12)} signature recovers to ${recovered}, not an owner`,
          );
          continue;
        }
        if (entry.signer && getAddress(entry.signer) !== recovered) {
          console.log(
            `  ✗ ${pad(target.network, 12)} claimed signer ${getAddress(entry.signer)} ` +
              `but recovered ${recovered}`,
          );
          continue;
        }
        if (signaturesFor(bundle, target, existing).some((s) => s.signer === recovered)) {
          skipped++;
          continue;
        }
        collected.push({
          safeTxHash: target.safeTxHash,
          signer: recovered,
          signature: entry.signature,
        });
        added++;
        console.log(`  ✓ ${pad(target.network, 12)} from ${recovered}`);
      }
    }

    if (!taskArgs.keyEnv && !taskArgs.import) {
      throw new Error("provide --key-env or --import");
    }

    // Signatures go into per-signer sidecars, never into the bundle -- that
    // is what keeps the bundle committable. See the Signature storage note.
    if (collected.length) writeSidecar(bundle.name, collected);
    const all = readSidecars(bundle.name);
    const count = (c: BundleChain) => signaturesFor(bundle, c, all).length;
    const ready = bundle.chains.filter((c) => count(c) >= bundle.threshold).length;
    console.log("\n" + "-".repeat(96));
    console.log(`added ${added}, skipped ${skipped} (already signed)`);
    if (collected.length) {
      const signers = [...new Set(collected.map((c) => c.signer))];
      for (const s of signers) {
        console.log(`  written to ${path.relative(process.cwd(), sidecarFile(bundle.name, s))}`);
      }
    }
    console.log(
      `${ready}/${bundle.chains.length} chains now have the ${bundle.threshold} ` +
        `signature(s) needed to execute`,
    );
    if (ready < bundle.chains.length) {
      const short = bundle.chains
        .filter((c) => count(c) < bundle.threshold)
        .map((c) => `${c.network}(${count(c)}/${bundle.threshold})`);
      console.log(`still short: ${short.join(", ")}`);
    }
    console.log("");
  });

// ---------------------------------------------------------------------------
// safe:exec
// ---------------------------------------------------------------------------

task("safe:exec", "Broadcast a signed bundle from the hot relayer (DRY RUN unless --broadcast)")
  .addParam("name", "Bundle name")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addFlag("broadcast", "Actually send transactions (default is a dry run)")
  .addFlag("fromService", "Fetch collected signatures from Safe's Transaction Service")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const bundle = readBundle(String(taskArgs.name));
    const broadcast: boolean = taskArgs.broadcast;
    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;

    const allChains = listSafeChains(hre);
    const byNetwork = new Map(allChains.map((c) => [c.network, c]));
    // Signatures live in per-signer sidecars alongside the bundle.
    const sidecars = readSidecars(bundle.name);

    console.log("\n" + "=".repeat(96));
    console.log(
      broadcast
        ? `SAFE EXEC  "${bundle.name}"  *** BROADCAST ***`
        : `SAFE EXEC  "${bundle.name}"  [DRY RUN]`,
    );
    console.log("=".repeat(96));
    console.log(`Safe      : ${bundle.safe}  (${bundle.threshold} of ${bundle.owners.length})`);
    console.log(`Relayer   : ${OKU_DEPLOYER_EOA}  (needs no permissions, pays all gas)`);
    console.log(`Intent    : ${bundle.intent}`);

    const targets = bundle.chains.filter((c) => !only || only.has(c.network));
    let ok = 0;
    let failed = 0;
    let skipped = 0;

    for (const c of targets) {
      const chain = byNetwork.get(c.network);
      if (!chain?.rpcUrl) {
        console.log(`\n=== ${c.network}: skip (NO_RPC)`);
        skipped++;
        continue;
      }
      const provider = makeProvider(chain.rpcUrl, chain.chainId);
      try {
        const tx = deserializeTx(c.tx);

        // Integrity: recompute the hash from the stored fields.
        const localHash = hashSafeTx(c.chainId, bundle.safe, tx);
        if (localHash !== c.safeTxHash) {
          console.log(`\n=== ${c.network}: ✗ bundle integrity failure (hash mismatch)`);
          failed++;
          continue;
        }

        // The Safe nonce must still match, otherwise the signatures are
        // stale -- another transaction has executed in the meantime.
        const nonceRaw = await withRetry(
          () =>
            provider.call({ to: bundle.safe, data: SAFE_IFACE.encodeFunctionData("nonce") }),
          `${c.network}:safe.nonce()`,
        );
        const liveNonce = SAFE_IFACE.decodeFunctionResult("nonce", nonceRaw)[0] as bigint;
        if (liveNonce !== tx.nonce) {
          console.log(
            `\n=== ${c.network}: ✗ STALE — Safe nonce is now ${liveNonce}, bundle signed for ` +
              `${tx.nonce}. Rebuild and re-sign.`,
          );
          failed++;
          continue;
        }

        let sigs = signaturesFor(bundle, c, sidecars);
        if (taskArgs.fromService) {
          const fetched = await fetchServiceSignatures(c, bundle);
          if (fetched.length) {
            console.log(`\n=== ${c.network}: pulled ${fetched.length} signature(s) from tx service`);
            const merged = [...sigs];
            const persist: SignatureEntry[] = [];
            for (const f of fetched) {
              if (!merged.some((s) => getAddress(s.signer) === getAddress(f.signer))) {
                merged.push(f);
                persist.push({
                  safeTxHash: c.safeTxHash,
                  signer: getAddress(f.signer),
                  signature: f.signature,
                });
              }
            }
            // Cache them in the sidecar so a re-run does not depend on the
            // hosted service being reachable.
            if (persist.length) writeSidecar(bundle.name, persist);
            sigs = merged;
          }
        }

        if (sigs.length < bundle.threshold) {
          console.log(
            `\n=== ${c.network}: skip — ${sigs.length}/${bundle.threshold} signatures`,
          );
          skipped++;
          continue;
        }

        // Validate every signature locally before spending gas.
        const owners = new Set(bundle.owners.map((o) => getAddress(o)));
        const validated: { signer: string; signature: string }[] = [];
        let bad = false;
        for (const s of sigs) {
          const recovered = recoverSafeTxSigner(localHash, s.signature);
          if (!owners.has(recovered)) {
            console.log(`\n=== ${c.network}: ✗ signature recovers to non-owner ${recovered}`);
            bad = true;
            break;
          }
          validated.push({ signer: recovered, signature: s.signature });
        }
        if (bad) {
          failed++;
          continue;
        }

        const packed = packSignatures(validated.slice(0, Math.max(bundle.threshold, validated.length)));
        const execData = SAFE_IFACE.encodeFunctionData("execTransaction", [
          tx.to,
          tx.value,
          tx.data,
          tx.operation,
          tx.safeTxGas,
          tx.baseGas,
          tx.gasPrice,
          tx.gasToken,
          tx.refundReceiver,
          packed,
        ]);

        // Simulate the real execTransaction with the real signatures. This is
        // a complete end-to-end proof: signature checks, threshold, nonce and
        // the inner call all run.
        try {
          const res = await withRetry(
            () =>
              provider.call({ from: OKU_DEPLOYER_EOA, to: bundle.safe, data: execData }),
            `${c.network}:simulate execTransaction`,
          );
          const [success] = SAFE_IFACE.decodeFunctionResult("execTransaction", res);
          if (!success) {
            console.log(`\n=== ${c.network}: ✗ execTransaction would return false (inner revert)`);
            failed++;
            continue;
          }
        } catch (e) {
          const anyE = e as { data?: string; shortMessage?: string; message?: string };
          const reason = anyE.data ? decodeRevert(anyE.data) : undefined;
          console.log(
            `\n=== ${c.network}: ✗ simulation failed: ${reason ?? anyE.shortMessage ?? anyE.message}`,
          );
          failed++;
          continue;
        }

        if (!broadcast) {
          console.log(
            `\n=== ${c.network}: ✓ [dry run] would execute — ${c.calls.length} call(s), ` +
              `${validated.length} sig(s), nonce ${tx.nonce}`,
          );
          c.calls.forEach((call) => console.log(`      ${call.label}`));
          ok++;
          continue;
        }

        const key = resolveDeployerKey(hre, c.network);
        if (!key) {
          console.log(`\n=== ${c.network}: skip (NO_KEY)`);
          skipped++;
          continue;
        }
        const wallet = new Wallet(key, provider);
        const overrides = gasOverrides(chain);
        let gasLimit: bigint;
        try {
          const est = await provider.estimateGas({
            from: wallet.address,
            to: bundle.safe,
            data: execData,
          });
          gasLimit = (est * 140n) / 100n;
        } catch {
          gasLimit = 2_000_000n;
        }
        const sent = await withRetry(
          () =>
            wallet.sendTransaction({
              to: bundle.safe,
              data: execData,
              gasLimit,
              ...overrides,
            }),
          `${c.network}:execTransaction`,
        );
        const receipt = await confirmTx(provider, sent.hash);
        console.log(
          `\n=== ${c.network}: ✓ executed [tx ${sent.hash}] block ${receipt?.blockNumber}`,
        );
        c.calls.forEach((call) => console.log(`      ${call.label}`));
        ok++;
      } catch (e) {
        const anyE = e as { shortMessage?: string; message?: string };
        console.log(`\n=== ${c.network}: ✗ ${anyE.shortMessage ?? anyE.message ?? e}`);
        failed++;
      } finally {
        provider.destroy();
      }
    }


    console.log("\n" + "-".repeat(96));
    console.log(
      `${broadcast ? "executed" : "would execute"}: ${ok}   skipped: ${skipped}   failed: ${failed}`,
    );
    if (failed) process.exitCode = 1;
    if (!broadcast && ok) {
      console.log(`\nNothing was sent. Re-run with --broadcast to execute.`);
    }
    console.log("");
  });

/**
 * Pull owner confirmations for this exact safeTxHash out of Safe's hosted
 * Transaction Service.
 *
 * This is what lets owners sign in app.safe.global with a hardware wallet
 * while the hot relayer still pays the gas: the UI stores confirmations
 * off-chain, and we fetch and submit them ourselves.
 */
async function fetchServiceSignatures(
  c: BundleChain,
  bundle: Bundle,
): Promise<{ signer: string; signature: string }[]> {
  const base = safeTxServiceUrl(c.chainId);
  if (!base) return [];
  try {
    const res = await fetch(`${base}/v1/multisig-transactions/${c.safeTxHash}/`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      confirmations?: { owner: string; signature: string }[];
    };
    const owners = new Set(bundle.owners.map((o) => getAddress(o)));
    return (j.confirmations ?? [])
      .filter((cf) => cf.signature && owners.has(getAddress(cf.owner)))
      .map((cf) => ({ signer: getAddress(cf.owner), signature: cf.signature }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// safe:status
// ---------------------------------------------------------------------------

task("safe:status", "Per-chain Safe and OkuRouter ownership state")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only);

    console.log("\n" + "=".repeat(96));
    console.log(`SAFE STATUS   safe=${dep.address}`);
    console.log("=".repeat(96));
    console.log(
      pad("network", 12) +
        pad("chainId", 9) +
        pad("safe", 14) +
        pad("nonce", 8) +
        pad("thr", 5) +
        pad("routerOwner", 14) +
        pad("paused", 8) +
        pad("txSvc", 7),
    );
    console.log("-".repeat(96));

    const rows = await mapLimit(chains, 6, async (chain) => {
      const r = {
        network: chain.network,
        safe: "-",
        nonce: "-",
        thr: "-",
        owner: "-",
        paused: "-",
        svc: hasSafeTxService(chain.chainId) ? "yes" : "no",
      };
      if (!chain.rpcUrl) return { ...r, safe: "NO_RPC" };
      const provider = makeProvider(chain.rpcUrl, chain.chainId);
      try {
        const code = await provider.getCode(dep.address);
        if (code === "0x") {
          r.safe = "not-deployed";
        } else {
          r.safe = "deployed";
          const call = async (fn: string) =>
            SAFE_IFACE.decodeFunctionResult(
              fn,
              await provider.call({
                to: dep.address,
                data: SAFE_IFACE.encodeFunctionData(fn),
              }),
            )[0];
          r.nonce = String(await call("nonce"));
          r.thr = String(await call("getThreshold"));
        }
        if (chain.router) {
          const router = OkuRouter__factory.connect(chain.router, provider);
          const [owner, paused] = await Promise.all([router.owner(), router.paused()]);
          const o = getAddress(owner);
          r.owner =
            o === getAddress(dep.address)
              ? "SAFE"
              : o === getAddress(OKU_DEPLOYER_EOA)
                ? "deployer"
                : o.slice(0, 12);
          r.paused = paused ? "PAUSED" : "no";
        }
      } catch {
        r.safe = "ERR";
      } finally {
        provider.destroy();
      }
      return r;
    });

    for (const [i, r] of rows.entries()) {
      console.log(
        pad(r.network, 12) +
          pad(chains[i].chainId, 9) +
          pad(r.safe, 14) +
          pad(r.nonce, 8) +
          pad(r.thr, 5) +
          pad(r.owner, 14) +
          pad(r.paused, 8) +
          pad(r.svc, 7),
      );
    }
    const owned = rows.filter((r) => r.owner === "SAFE").length;
    console.log("-".repeat(96));
    console.log(
      `Safe deployed on ${rows.filter((r) => r.safe === "deployed").length}/${rows.length}, ` +
        `owns the router on ${owned}/${rows.length}`,
    );
    console.log("");
  });
