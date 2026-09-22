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
import { TypedDataEncoder, Wallet, formatUnits, getAddress } from "ethers";
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
import {
  NATIVE_SENTINEL,
  fmtAmount,
  priceAssets,
  readNonZeroBalances,
  scanChainFees,
  totalUsd,
  type PricedFeeAsset,
} from "../util/feeScan";
import { discoverFeeAssets } from "../util/feeAssetCache";
import { readSnapshot, type SnapshotAsset } from "../util/feeSnapshot";
import { OKU_FEE_RECIPIENT } from "../util/safeConfig";
import { accountForSweepTx, writeAccounting } from "./feeAccounting";

const BUNDLE_DIR = path.resolve(__dirname, "..", "safe-bundles");
const ROUTER_IFACE = OkuRouter__factory.createInterface();

/** Supported build intents. */
type Intent =
  | "accept-ownership"
  | "pause"
  | "unpause"
  | "swap-targets"
  | "valid-signer"
  | "max-warrant-duration"
  | "sweep";

/**
 * Per-asset record pinned into a sweep bundle's `params`.
 *
 * This is the audit trail and the signer-facing manifest in one. The sign
 * page renders it directly (buildPage.js ships the whole bundle minus
 * signatures), because a 32-token sweep collapses into a single unreadable
 * line if the only description is the call label.
 *
 * Balances here are a snapshot from build time. `sweepAll` always moves the
 * FULL balance at execution time, so actual amounts will be >= these. The
 * accounting artifact records what actually moved.
 */
interface SweepAssetSnapshot {
  token: string;
  symbol: string;
  decimals: number;
  amountRaw: string;
  amount: string;
  usdValue?: number;
  realizableUsd?: number;
}

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
  /**
   * Itemized fund-movement manifest, present only on `sweep` bundles.
   * Rendered by the signing page so a signer approving a 32-token sweep can
   * see every asset and the recipient, rather than one truncated call label.
   */
  sweep?: {
    recipient: string;
    includeEth: boolean;
    assets: SweepAssetSnapshot[];
    usdNotional: number;
    usdRealizable: number;
  };
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

    case "sweep": {
      const cfg = NETWORK_CONFIGS[chain.network];
      if (!cfg) return { calls: [], note: "NO_NETWORK_CONFIG" };

      const to = getAddress(String(params.to));
      const includeEth = params.includeEth !== false;
      const maxTokens = Number(params.maxTokens ?? 40);
      const minUsd = Number(params.minUsd ?? 0);

      // What sweepAll actually needs is the TOKEN ADDRESS LIST and nothing
      // else. It takes no amounts: it reads balanceOf(address(this)) at
      // execution time and moves the full balance, skipping zero balances
      // silently. Amounts and USD figures never enter the calldata -- they
      // exist only to let an operator judge whether a chain is worth a
      // ceremony, and to itemize the manifest for signers.
      //
      // So the token set is resolved in descending order of trust:
      //   1. --tokens    : honoured verbatim, minus zero balances
      //   2. --from-scan : the list the operator just reviewed. Reused as-is,
      //                    including its valuations -- re-reading balances and
      //                    re-probing pools here would repeat the scan that
      //                    finished seconds ago to produce figures that are
      //                    equally stale by signing time and equally absent
      //                    from the transaction.
      //   3. incremental discovery over OrderFilled history
      const explicit = params.tokens as string[] | undefined;
      const fromScan = scanAssetsByNetwork.get(chain.network);
      let assets: PricedFeeAsset[];
      let nativeBalance = 0n;
      // Valuation of the NATIVE balance, kept separately from `assets`
      // because native does not ride in the tokens array -- it is the
      // includeEth flag. It still belongs in the chain's total, or the
      // bundle would report a smaller figure than the scan it came from.
      let nativeValue: PricedFeeAsset | undefined;

      if (explicit && explicit.length > 0) {
        const found = await readNonZeroBalances(provider, chain.router!, explicit);
        const { priced } = await priceAssets(provider, cfg, found);
        assets = priced;
        nativeBalance = await provider.getBalance(chain.router!);
      } else if (fromScan) {
        const toPriced = (a: SnapshotAsset): PricedFeeAsset => ({
          token: a.token,
          symbol: a.symbol,
          decimals: a.decimals,
          balance: BigInt(a.amountRaw),
          usdPrice: a.usdPrice,
          usdValue: a.usdValue,
          poolDepthUsd: a.poolDepthUsd,
          realizableUsd: a.realizableUsd,
          priceSource: a.priceSource,
        });
        assets = fromScan.filter((a) => a.token !== NATIVE_SENTINEL).map(toPriced);
        const nat = fromScan.find((a) => a.token === NATIVE_SENTINEL);
        if (nat) {
          nativeValue = toPriced(nat);
          nativeBalance = nativeValue.balance;
        }
      } else {
        const discovery = await discoverFeeAssets(
          provider,
          { network: chain.network, chainId: chain.chainId, router: chain.router! },
          {},
        );
        const scan = await scanChainFees(provider, cfg, chain.router!, {
          price: true,
          discovery: { tokens: discovery.tokens, coverage: discovery.coverage },
        });
        assets = scan.assets.filter((a) => a.token !== NATIVE_SENTINEL);
        const nat = scan.assets.find((a) => a.token === NATIVE_SENTINEL);
        if (nat) {
          nativeValue = nat;
          nativeBalance = nat.balance;
        }
      }

      const sweepEth = includeEth && nativeBalance > 0n;
      if (assets.length === 0 && !sweepEth) {
        // Preserves the idempotent-diff model: a chain with nothing to sweep
        // is dropped entirely rather than burning a nonce on a no-op that
        // would in fact revert with NOTHING_TO_SWEEP.
        return { calls: [], note: "no idle fees on this chain" };
      }

      // Optional economic floor. Defaults to 0 (build everything): what is
      // worth a hardware-wallet ceremony is the operator's call, not a
      // constant here. When it IS set, the comparison is against realizable,
      // and the note reports how many assets carried no price at all -- those
      // contribute 0 and would otherwise silently drag a chain under.
      if (minUsd > 0) {
        const { realizable } = totalUsd(assets);
        if (realizable < minUsd) {
          const unpriced = assets.filter((a) => a.usdValue === undefined).length;
          return {
            calls: [],
            note:
              `below --min-usd: realizable $${realizable.toFixed(2)} < $${minUsd.toFixed(2)}` +
              `${unpriced ? ` (${unpriced} asset(s) unpriced, counted as $0)` : ""}`,
          };
        }
      }

      // Chunk so one call cannot grow an unbounded loop. Multiple calls are
      // batched through MultiSend by buildBatchedSafeTx.
      const chunks: PricedFeeAsset[][] = [];
      for (let i = 0; i < assets.length; i += maxTokens) {
        chunks.push(assets.slice(i, i + maxTokens));
      }
      if (chunks.length === 0) chunks.push([]);

      const calls: BundleCall[] = chunks.map((chunk, idx) => {
        // ETH rides along with the final chunk only, so it is swept exactly once.
        const withEth = sweepEth && idx === chunks.length - 1;
        const addrs = chunk.map((a) => a.token);
        const summary = chunk.map((a) => `${a.symbol} ${fmtAmount(a)}`).join(", ");
        const ethPart = withEth
          ? `${chunk.length ? " + " : ""}${formatUnits(nativeBalance, 18)} ${cfg.nativeSymbol}`
          : "";
        return {
          to: chain.router!,
          data: ROUTER_IFACE.encodeFunctionData("sweepAll", [addrs, withEth, to]),
          value: "0",
          label:
            `sweepAll(${addrs.length} token(s)${withEth ? " + native ETH" : ""}) -> ${to}` +
            `${chunks.length > 1 ? ` [part ${idx + 1}/${chunks.length}]` : ""}` +
            `  ::  ${summary}${ethPart}`,
        };
      });

      const snapshot: SweepAssetSnapshot[] = assets.map((a) => ({
        token: a.token,
        symbol: a.symbol,
        decimals: a.decimals,
        amountRaw: a.balance.toString(),
        amount: fmtAmount(a),
        usdValue: a.usdValue,
        realizableUsd: a.realizableUsd,
      }));
      if (sweepEth) {
        snapshot.push({
          token: NATIVE_SENTINEL,
          symbol: cfg.nativeSymbol,
          decimals: 18,
          amountRaw: nativeBalance.toString(),
          amount: formatUnits(nativeBalance, 18),
          usdValue: nativeValue?.usdValue,
          realizableUsd: nativeValue?.realizableUsd,
        });
      }
      // Native is counted in the chain total when it is being swept. It is
      // not in `assets` because it travels as the includeEth flag rather than
      // an array entry, and omitting it made the bundle report a smaller
      // figure than the scan it was built from.
      const totals = totalUsd(sweepEth && nativeValue ? [...assets, nativeValue] : assets);

      // Stash the manifest on the chain entry so the sign page can render an
      // itemized fund-movement panel per chain.
      sweepManifests.set(`${chain.network}`, {
        recipient: to,
        includeEth: sweepEth,
        assets: snapshot,
        usdNotional: totals.notional,
        usdRealizable: totals.realizable,
      });

      return { calls };
    }
  }
}

/**
 * Per-chain sweep manifests produced during callsForIntent, keyed by network.
 *
 * callsForIntent's return type is shared by every intent, so this side channel
 * carries the richer sweep data out to the bundle assembler without
 * distorting the other five intents.
 */
const sweepManifests = new Map<
  string,
  {
    recipient: string;
    includeEth: boolean;
    assets: SweepAssetSnapshot[];
    usdNotional: number;
    usdRealizable: number;
  }
>();

/**
 * Per-chain asset lists taken from a `--from-scan` snapshot, keyed by network.
 *
 * Populated before the build loop so the sweep intent can skip discovery
 * entirely. Only the token ADDRESSES are load-bearing -- they are what
 * sweepAll receives. The amounts ride along solely to itemize the signing
 * page, where they are labelled as an estimate.
 */
const scanAssetsByNetwork = new Map<string, SnapshotAsset[]>();

/**
 * Chains that FAILED to build, as opposed to chains with nothing to do.
 *
 * The build loop turns both into `null`, which means a transient RPC error is
 * indistinguishable from "already in the desired state" -- on a 34-chain
 * sweep that is a silent loss of collectable fees. Recorded here so the
 * summary can name them and the process can exit non-zero.
 */
const buildErrors: { network: string; message: string }[] = [];

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
    "accept-ownership | pause | unpause | swap-targets | valid-signer | max-warrant-duration | sweep",
  )
  .addOptionalParam("name", "Bundle name (default: <intent>-<timestamp>)")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addOptionalParam("address", "For valid-signer: the signer address")
  .addOptionalParam("add", "For valid-signer: true|false")
  .addOptionalParam("seconds", "For max-warrant-duration: the new duration")
  .addOptionalParam("to", "For sweep: recipient (default: OKU_FEE_RECIPIENT)")
  .addOptionalParam("tokens", "For sweep: comma-separated token list, or omit to auto-discover")
  .addOptionalParam("maxTokens", "For sweep: max tokens per sweepAll call (default 40)")
  .addOptionalParam(
    "fromScan",
    "For sweep: path to a fees:cycle / fees:scan snapshot. Uses its asset lists instead " +
      "of re-discovering, so the bundle matches the report that was reviewed.",
  )
  .addOptionalParam(
    "minUsd",
    "For sweep: skip chains whose realizable total is below this (default 0 = no filter)",
  )
  .addOptionalParam(
    "rpc",
    "Override RPC URL (single --networks only). For multi-chain sweeps set <NET>_LOGS_URL " +
      "instead; the default endpoints on several chains restrict eth_getLogs.",
  )
  .addFlag("noEth", "For sweep: do NOT sweep the native balance")
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
      "sweep",
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
    if (intent === "sweep") {
      // Defaults to the committed constant so the destination of an
      // irreversible transfer is reviewed in a diff, not retyped per ceremony.
      const to = getAddress(String(taskArgs.to ?? OKU_FEE_RECIPIENT));
      if (to === "0x0000000000000000000000000000000000000000") {
        throw new Error("sweep recipient cannot be the zero address");
      }
      params.to = to;
      params.includeEth = !taskArgs.noEth;
      if (taskArgs.tokens) {
        params.tokens = String(taskArgs.tokens)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((s: string) => getAddress(s));
      }
      if (taskArgs.maxTokens) params.maxTokens = Number(taskArgs.maxTokens);
      if (taskArgs.minUsd) params.minUsd = Number(taskArgs.minUsd);
      sweepManifests.clear();
      scanAssetsByNetwork.clear();
      if (taskArgs.fromScan) {
        const snapPath = path.resolve(String(taskArgs.fromScan));
        const snap = readSnapshot(snapPath);
        for (const c of snap.chains) {
          if (c.status !== "has-fees") continue;
          scanAssetsByNetwork.set(c.network, c.assets);
        }
        // Recorded so the bundle says which observation it was built from.
        // The snapshot itself is gitignored and will not survive; the
        // reference still pins the date and generation time.
        params.scanRef = path.relative(path.resolve(__dirname, ".."), snapPath);
        params.scanGeneratedAt = snap.generatedAt;
        console.log(`\nUsing scan       : ${params.scanRef}  (${snap.generatedAt})`);
        console.log(
          `  chains with fees: ${scanAssetsByNetwork.size}` +
            `${snap.totals.chainsErrored ? `, ${snap.totals.chainsErrored} errored during scan` : ""}`,
        );
      }
      console.log(`\nSweep recipient: ${to}${taskArgs.to ? " (explicit --to)" : " (OKU_FEE_RECIPIENT)"}`);
      console.log(`Include native  : ${params.includeEth}`);
      if (params.minUsd) console.log(`Minimum USD     : $${Number(params.minUsd).toFixed(2)}`);
    }
    buildErrors.length = 0;

    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    if (taskArgs.rpc && chains.length !== 1) {
      throw new Error(
        `--rpc applies to one chain, but ${chains.length} were selected. ` +
          `Pass --networks <single network> alongside --rpc, or set <NET>_LOGS_URL ` +
          `per chain (e.g. WORLDCHAIN_LOGS_URL) for a multi-chain run.`,
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = String(taskArgs.name ?? `${intent}-${stamp}`);

    console.log("\n" + "=".repeat(96));
    console.log(`SAFE BUILD  intent=${intent}`);
    console.log("=".repeat(96));
    console.log(`Safe   : ${dep.address}  (${dep.threshold} of ${dep.owners.length})`);
    console.log(`Bundle : ${name}`);
    console.log(`Chains : ${chains.length}`);

    const built = await mapLimit(chains, 5, async (chain): Promise<BundleChain | null> => {
      const rpc = taskArgs.rpc ? String(taskArgs.rpc) : chain.rpcUrl;
      if (!rpc) {
        console.log(`  ${pad(chain.network, 12)} skip: NO_RPC`);
        return null;
      }
      const provider = makeProvider(rpc, chain.chainId);
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
        const message = String(anyE.shortMessage ?? anyE.message ?? e);
        // Recorded, not just logged: a failure here excludes the chain from
        // the bundle exactly as "nothing to do" does, and the two must not
        // look alike in the summary.
        buildErrors.push({ network: chain.network, message });
        console.log(`  ${pad(chain.network, 12)} ✗ ${message}`);
        return null;
      } finally {
        provider.destroy();
      }
    });

    const chainsOut = built.filter((b): b is BundleChain => b !== null);
    if (chainsOut.length === 0) {
      console.log("\nNothing to do on any chain. No bundle written.");
      reportBuildErrors();
      return;
    }
    chainsOut.sort((a, b) => a.chainId - b.chainId);

    // Attach the per-chain sweep manifest so the signing page can render an
    // itemized fund-movement panel, and so the bundle is self-describing when
    // audited later. Carries no authorization material.
    if (intent === "sweep") {
      for (const c of chainsOut) {
        const m = sweepManifests.get(c.network);
        if (m) c.sweep = m;
      }
      params.recipient = params.to;
      params.totalUsdNotional = chainsOut.reduce((s, c) => s + (c.sweep?.usdNotional ?? 0), 0);
      params.totalUsdRealizable = chainsOut.reduce((s, c) => s + (c.sweep?.usdRealizable ?? 0), 0);
    }

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
    reportBuildErrors();
    console.log("");
  });

/**
 * Name the chains that failed to build and set a non-zero exit code.
 *
 * Without this a sweep that silently dropped six chains to RPC timeouts looks
 * identical to one where those six had nothing to collect.
 */
function reportBuildErrors(): void {
  if (buildErrors.length === 0) return;
  console.log("\n" + "!".repeat(96));
  console.log(
    `${buildErrors.length} chain(s) FAILED to build and are NOT in the bundle. ` +
      `They were not\nproven to be in the desired state -- they could not be read:`,
  );
  for (const e of buildErrors) console.log(`  ${pad(e.network, 12)} ${e.message}`);
  console.log("!".repeat(96));
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// safe:merge
// ---------------------------------------------------------------------------

task(
  "safe:merge",
  "Combine bundles that touch disjoint chains into one, so signers sign once",
)
  .addParam("name", "Name for the merged bundle")
  .addParam("from", "Comma-separated bundle names to merge")
  .setAction(async (taskArgs) => {
    assertOkuSafeConfig();
    const sources = String(taskArgs.from)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (sources.length < 2) {
      throw new Error("--from needs at least two bundle names");
    }
    const outName = String(taskArgs.name);
    if (sources.includes(outName)) {
      throw new Error(`--name ${outName} collides with one of the source bundles`);
    }

    const loaded = sources.map((n) => readBundle(n));

    // Every bundle must target the same Safe with the same owner set and
    // threshold, or the merged bundle would be incoherent to sign.
    const first = loaded[0];
    for (const b of loaded.slice(1)) {
      if (getAddress(b.safe) !== getAddress(first.safe)) {
        throw new Error(`bundle ${b.name} targets a different Safe (${b.safe})`);
      }
      if (b.threshold !== first.threshold) {
        throw new Error(`bundle ${b.name} has threshold ${b.threshold}, expected ${first.threshold}`);
      }
      const a = first.owners.map((o) => getAddress(o)).sort().join(",");
      const c = b.owners.map((o) => getAddress(o)).sort().join(",");
      if (a !== c) throw new Error(`bundle ${b.name} has a different owner set`);
    }

    // Chains must be disjoint. Two entries for one chain would be two
    // transactions competing for the same Safe nonce: only the first could
    // ever execute, and the second's signatures would be silently dead. Fail
    // loudly rather than produce a bundle that is half-unexecutable.
    const byChain = new Map<number, string>();
    for (const b of loaded) {
      for (const c of b.chains) {
        const prev = byChain.get(c.chainId);
        if (prev) {
          throw new Error(
            `chain ${c.network} (${c.chainId}) appears in both "${prev}" and "${b.name}". ` +
              `Both would target Safe nonce ${c.nonce}, so only one could execute. ` +
              `Rebuild them as a single bundle with safe:build instead.`,
          );
        }
        byChain.set(c.chainId, b.name);
      }
    }

    // Pure concatenation: every chain keeps its own safeTxHash untouched, so
    // any signatures already collected against a source bundle stay valid.
    const merged: Bundle = {
      name: outName,
      intent: first.intent,
      params: Object.fromEntries(loaded.map((b) => [b.name, b.params])),
      safe: first.safe,
      threshold: first.threshold,
      owners: [...first.owners],
      createdAt: new Date().toISOString(),
      chains: loaded.flatMap((b) => b.chains).sort((a, b) => a.chainId - b.chainId),
    };
    const p = writeBundle(merged);

    console.log("");
    console.log(`Merged bundle written: ${p}`);
    for (const b of loaded) {
      console.log(
        `  from ${b.name.padEnd(24)} intent=${String(b.intent).padEnd(20)} ` +
          `${b.chains.length} chain(s): ${b.chains.map((c) => c.network).join(", ")}`,
      );
    }
    console.log("");
    console.log(`  total chains        : ${merged.chains.length}`);
    console.log(`  signatures needed   : ${merged.chains.length} x ${merged.threshold}`);
    for (const c of merged.chains) {
      console.log(
        `    ${c.network.padEnd(12)} nonce=${String(c.nonce).padEnd(4)} ` +
          `${c.calls.length} call(s)  ${c.safeTxHash}`,
      );
    }
    console.log("");
    console.log(`Each safeTxHash is carried over unchanged, so signatures already`);
    console.log(`collected against a source bundle remain valid here. Next:`);
    console.log(`  npx hardhat safe:sign-page --name ${outName}`);
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
    const templateHtml = fs.readFileSync(tpl, "utf8");

    // Delegate to the shared builder so this task and `npm run sign-page`
    // cannot drift. The "strip signature bytes before the file is
    // distributed" guarantee therefore lives in exactly one place: the page
    // receives `signedBy` (addresses only) so it can grey out rows the
    // connected account already signed, and no signature material at all.
    const { buildSignPage } = require("../scripts/safeSignPage/buildPage");
    const sidecars = readSidecars(bundle.name);
    const html: string = buildSignPage(templateHtml, bundle, sidecars);
    const embeddedSigs = 0;

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

        // A sweep is irreversible and its amounts are only knowable from the
        // chain, so capture the record immediately. Failure to write the
        // artifact must never be reported as a failure to execute -- the funds
        // have already moved -- hence the isolated catch and the explicit
        // instruction for regenerating it.
        if (bundle.intent === "sweep" && c.sweep) {
          try {
            const report = await accountForSweepTx({
              provider,
              network: c.network,
              chainId: c.chainId,
              router: c.router,
              safe: bundle.safe,
              recipient: c.sweep.recipient,
              txHash: sent.hash,
              mode: "execution",
              bundle: bundle.name,
              safeNonce: c.nonce,
              safeTxHash: c.safeTxHash,
              signers: sigs.map((s) => getAddress(s.signer)),
            });
            const written = writeAccounting(report);
            console.log(`      accounting: ${written.json}`);
            if (!report.reconciliation.allRouterBalancesZero) {
              console.log(`      WARNING: router still holds a balance for a swept asset`);
            }
            if (!report.reconciliation.eventsMatchBalanceDeltas) {
              console.log(`      WARNING: emitted amounts != measured recipient deltas`);
            }
          } catch (e) {
            console.log(
              `      accounting FAILED to write: ` +
                `${String((e as { message?: string }).message ?? e).slice(0, 100)}\n` +
                `      The sweep itself succeeded. Regenerate with:\n` +
                `        npx hardhat fees:account --network-name ${c.network} ` +
                `--tx ${sent.hash} --name ${bundle.name}`,
            );
          }
        }
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
