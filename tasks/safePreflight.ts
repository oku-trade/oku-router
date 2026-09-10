/**
 * safePreflight.ts
 *
 * Read-only GO/NO-GO gate for the Safe rollout. Sends no transactions ever.
 *
 * What it proves, per chain:
 *   1. The RPC is reachable and actually reports the chainId we expect.
 *   2. Safe's canonical v1.4.1 contracts are present at their canonical
 *      addresses (we deploy none of these).
 *   3. The factory's `proxyCreationCode()` matches our pinned hash. A chain
 *      with a *different* proxy implementation at the canonical factory
 *      address would silently yield a different Safe address; this is the
 *      check that catches it.
 *   4. Our predicted Safe address is free -- or, if already deployed, that it
 *      really is our Safe with our owners and threshold.
 *   5. Every intended owner is an EOA (no bytecode). A contract owner cannot
 *      produce an ECDSA signature, so this would silently break the 2-of-3.
 *   6. The deployer EOA can actually afford the deploy. We estimate the real
 *      `createProxyWithNonce` gas on each chain and price it with that
 *      chain's fee data (honouring hardhat.config.ts gasPrice overrides),
 *      rather than comparing against an arbitrary balance floor -- Saga mines
 *      zero-price transactions, so a fixed floor is meaningless there.
 *   7. The live OkuRouter `owner()` matches the registry, so we know the true
 *      pre-migration state rather than trusting the JSON.
 *   8. Safe Transaction Service coverage, verified by comparing the service's
 *      indexing height to the chain's own head. This is what distinguishes a
 *      wrong shortname or a testnet endpoint from real coverage.
 *
 * Transient failures (HTTP 429 from Safe's shared API, flaky public RPCs) are
 * retried and then reported as notes rather than problems, so preflight does
 * not cry NO-GO over rate limiting.
 *
 * Usage:
 *   npx hardhat safe:preflight
 *   npx hardhat safe:preflight --networks gensyn,telos
 *   npx hardhat safe:preflight --all-notes
 */
import { task } from "hardhat/config";
import { formatEther, getAddress, keccak256, ZeroAddress } from "ethers";
import type { JsonRpcProvider } from "ethers";
import {
  OKU_DEPLOYER_EOA,
  OKU_SAFE_OWNERS,
  OKU_SAFE_THRESHOLD,
  SAFE_FALLBACK_HANDLER,
  SAFE_L1_SINGLETON,
  SAFE_L2_SINGLETON,
  SAFE_MULTISEND_CALL_ONLY,
  SAFE_PROXY_CREATION_CODE_HASH,
  SAFE_PROXY_FACTORY,
  SAFE_PROXY_FACTORY_IFACE,
  SAFE_TO_L2_SETUP,
  assertOkuSafeConfig,
  getOkuSafeDeployment,
  hasSafeTxService,
  safeTxServiceUrl,
} from "../util/safeConfig";
import { SAFE_IFACE } from "../util/safeTx";
import { SAFE_SINGLETON_FACTORY } from "../util/contractMeta";
import {
  gasOverrides,
  listSafeChains,
  makeProvider,
  mapLimit,
  pad,
  resolveDeployerKey,
  type SafeChain,
} from "../util/safeChains";
import { withRetry } from "../util/rpcRetry";
import { OkuRouter__factory } from "../typechain-types";

/**
 * Safety multiplier applied to the estimated deploy cost when deciding
 * whether the deployer is funded. 3x covers fee-market movement between
 * preflight and deploy without demanding a large float on 34 chains.
 */
const FUNDING_HEADROOM = 3n;

interface Row {
  network: string;
  chainId: number;
  infra: string;
  proxyCode: string;
  safeSlot: string;
  owners: string;
  balance: string;
  needed: string;
  funded: string;
  router: string;
  txsvc: string;
  problems: string[];
  notes: string[];
}

/** Retry wrapper that records transient failures as notes, never problems. */
async function soft<T>(
  row: Row,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withRetry(fn, `${row.network}:${label}`, 3, 1_500);
  } catch (e) {
    row.notes.push(`${label} unavailable after retries: ${errText(e)}`);
    return undefined;
  }
}

async function checkChain(chain: SafeChain, expectedSafe: string): Promise<Row> {
  const row: Row = {
    network: chain.network,
    chainId: chain.chainId,
    infra: "?",
    proxyCode: "?",
    safeSlot: "?",
    owners: "?",
    balance: "?",
    needed: "?",
    funded: "?",
    router: "?",
    txsvc: hasSafeTxService(chain.chainId) ? "yes" : "none",
    problems: [],
    notes: [],
  };

  if (!chain.rpcUrl) {
    row.problems.push("NO_RPC configured in hardhat.config.ts");
    for (const k of ["infra", "proxyCode", "safeSlot", "owners", "balance", "needed", "funded", "router"] as const) {
      row[k] = "-";
    }
    return row;
  }

  const provider = makeProvider(chain.rpcUrl, chain.chainId);
  try {
    // 1. chainId sanity. staticNetwork pins what we *expect*, so ask the node.
    const reported = await soft(row, "eth_chainId", () =>
      provider.send("eth_chainId", []),
    );
    if (reported !== undefined) {
      const reportedId = Number(BigInt(reported as string));
      if (reportedId !== chain.chainId) {
        row.problems.push(
          `CHAIN_ID_MISMATCH: registry says ${chain.chainId}, RPC reports ${reportedId}`,
        );
      }
    }

    // 2. Safe infrastructure presence.
    const infra: Record<string, string> = {
      proxyFactory: SAFE_PROXY_FACTORY,
      safeL1: SAFE_L1_SINGLETON,
      safeL2: SAFE_L2_SINGLETON,
      fallback: SAFE_FALLBACK_HANDLER,
      multiSend: SAFE_MULTISEND_CALL_ONLY,
      toL2Setup: SAFE_TO_L2_SETUP,
      singletonFactory: SAFE_SINGLETON_FACTORY,
    };
    const missing: string[] = [];
    let infraReadFailed = false;
    for (const [label, addr] of Object.entries(infra)) {
      const code = await soft(row, `getCode(${label})`, () => provider.getCode(addr));
      if (code === undefined) {
        infraReadFailed = true;
        break;
      }
      if (code === "0x") missing.push(label);
    }
    if (infraReadFailed) {
      row.infra = "ERR";
    } else if (missing.length === 0) {
      row.infra = "all 7";
    } else if (missing.length === 1 && missing[0] === "toL2Setup") {
      // The one gap we can repair ourselves: SafeToL2Setup is deployed via
      // the Safe Singleton Factory at a salt-0 canonical address, and its
      // bytecode is self-verifying (see assertSafeToL2SetupBytecode).
      row.infra = "need toL2";
      row.notes.push(
        "SafeToL2Setup absent -- `safe:deploy` deploys it to its canonical address " +
          "first. It is part of the initializer preimage, so it cannot be skipped " +
          "without forking the Safe address on this chain.",
      );
    } else {
      row.infra = `MISS:${missing.length}`;
      row.problems.push(`Safe infrastructure missing: ${missing.join(", ")}`);
    }

    // 3. proxyCreationCode() must match the pinned hash exactly.
    if (!missing.includes("proxyFactory") && !infraReadFailed) {
      const raw = await soft(row, "proxyCreationCode()", () =>
        provider.call({
          to: SAFE_PROXY_FACTORY,
          data: SAFE_PROXY_FACTORY_IFACE.encodeFunctionData("proxyCreationCode"),
        }),
      );
      if (raw === undefined) {
        row.proxyCode = "ERR";
      } else {
        const [code] = SAFE_PROXY_FACTORY_IFACE.decodeFunctionResult(
          "proxyCreationCode",
          raw,
        );
        const h = keccak256(code as string);
        if (h === SAFE_PROXY_CREATION_CODE_HASH) {
          row.proxyCode = "match";
        } else {
          row.proxyCode = "DIFFERS";
          row.problems.push(
            `proxyCreationCode hash ${h} != pinned ${SAFE_PROXY_CREATION_CODE_HASH}. ` +
              `The Safe address on this chain would NOT match the other chains.`,
          );
        }
      }
    } else {
      row.proxyCode = "-";
    }

    // 4. Is the predicted address free, ours, or squatted?
    const existing = await soft(row, `getCode(safe)`, () => provider.getCode(expectedSafe));
    let safeIsFree = false;
    if (existing === undefined) {
      row.safeSlot = "ERR";
    } else if (existing === "0x") {
      row.safeSlot = "free";
      safeIsFree = true;
    } else {
      try {
        const call = async (fn: string) =>
          SAFE_IFACE.decodeFunctionResult(
            fn,
            await provider.call({
              to: expectedSafe,
              data: SAFE_IFACE.encodeFunctionData(fn),
            }),
          )[0];
        const ownersRaw = (await call("getOwners")) as string[];
        const thresholdRaw = (await call("getThreshold")) as bigint;
        const versionRaw = (await call("VERSION")) as string;
        const got = new Set(ownersRaw.map((o) => getAddress(o)));
        const want = new Set(OKU_SAFE_OWNERS.map((o) => getAddress(o)));
        const sameOwners = got.size === want.size && [...want].every((o) => got.has(o));
        if (sameOwners && Number(thresholdRaw) === OKU_SAFE_THRESHOLD) {
          row.safeSlot = `ours v${versionRaw}`;
        } else {
          row.safeSlot = "MISMATCH";
          row.problems.push(
            `A Safe exists at ${expectedSafe} but its config differs: ` +
              `threshold=${thresholdRaw} owners=[${ownersRaw.join(",")}]`,
          );
        }
      } catch {
        row.safeSlot = "SQUATTED";
        row.problems.push(
          `${expectedSafe} has bytecode but does not respond as a Safe. ` +
            `Do NOT hand over ownership on this chain.`,
        );
      }
    }

    // 5. Owners must be EOAs.
    const contractOwners: string[] = [];
    let ownerReadFailed = false;
    for (const owner of OKU_SAFE_OWNERS) {
      const code = await soft(row, `getCode(owner)`, () => provider.getCode(owner));
      if (code === undefined) {
        ownerReadFailed = true;
        break;
      }
      if (code !== "0x") contractOwners.push(owner);
    }
    if (ownerReadFailed) {
      row.owners = "ERR";
    } else if (contractOwners.length === 0) {
      row.owners = `${OKU_SAFE_OWNERS.length} eoa`;
    } else {
      row.owners = "HAS_CODE";
      row.problems.push(
        `Intended owner(s) have bytecode on this chain: ${contractOwners.join(", ")}. ` +
          `A contract cannot produce an ECDSA signature for execTransaction.`,
      );
    }

    // 6. Can the deployer actually afford the deploy?
    const bal = await soft(row, "getBalance", () => provider.getBalance(OKU_DEPLOYER_EOA));
    if (bal === undefined) {
      row.balance = row.needed = row.funded = "ERR";
    } else {
      row.balance = trim(formatEther(bal));
      const cost = safeIsFree
        ? await estimateDeployCost(row, provider, chain)
        : 0n;
      if (cost === undefined) {
        row.needed = row.funded = "?";
      } else {
        const required = cost * FUNDING_HEADROOM;
        row.needed = trim(formatEther(required));
        if (bal >= required) {
          row.funded = "ok";
        } else {
          row.funded = "SHORT";
          row.problems.push(
            `Underfunded: deployer holds ${formatEther(bal)} but the Safe deploy ` +
              `costs ~${formatEther(cost)} (need ${formatEther(required)} with ` +
              `${FUNDING_HEADROOM}x headroom). Short by ` +
              `${formatEther(required - bal)}.`,
          );
        }
      }
    }

    // 7. Live router owner vs registry.
    if (!chain.router) {
      row.router = "NO_ROUTER";
    } else {
      const router = OkuRouter__factory.connect(chain.router, provider);
      const liveOwner = await soft(row, "router.owner()", () => router.owner());
      if (liveOwner === undefined) {
        row.router = "ERR";
      } else {
        const live = getAddress(liveOwner);
        if (live === getAddress(expectedSafe)) row.router = "SAFE";
        else if (live === getAddress(OKU_DEPLOYER_EOA)) row.router = "deployer";
        else {
          row.router = `other`;
          row.notes.push(`router owner() is ${live}, neither deployer nor Safe`);
        }
        if (chain.recordedOwner && getAddress(chain.recordedOwner) !== live) {
          row.problems.push(
            `Registry drift: deployments/${chain.network}.json records owner ` +
              `${chain.recordedOwner} but the chain says ${live}`,
          );
        }
        const pending = await soft(row, "router.pendingOwner()", () =>
          router.pendingOwner(),
        );
        if (pending !== undefined && getAddress(pending) !== ZeroAddress) {
          row.router += "+pend";
          row.notes.push(
            `pendingOwner() already set to ${getAddress(pending)} ` +
              `(Ownable2Step transfer in flight, awaiting acceptOwnership)`,
          );
        }
      }
    }

    // 8. Transaction Service coverage, verified against chain head.
    const svc = safeTxServiceUrl(chain.chainId);
    if (svc) {
      const head = await soft(row, "eth_blockNumber", () =>
        provider.send("eth_blockNumber", []),
      );
      const probe = await soft(row, "safe tx service", async () => {
        const res = await fetch(`${svc}/v1/about/indexing/`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429) {
          // Safe's public API is shared and rate limited; make withRetry
          // treat this as transient so we back off rather than fail.
          throw new Error("429 Too Many Requests from Safe API");
        }
        if (!res.ok) return { httpError: res.status } as const;
        return (await res.json()) as { currentBlockNumber?: number };
      });
      if (probe === undefined) {
        row.txsvc = "rate-lim";
      } else if ("httpError" in probe) {
        row.txsvc = `HTTP${probe.httpError}`;
        row.notes.push(`Safe tx service returned HTTP ${probe.httpError}`);
      } else if (head === undefined) {
        row.txsvc = "up";
      } else {
        const headNum = Number(BigInt(head as string));
        const svcBlock = Number(probe.currentBlockNumber ?? 0);
        const lag = Math.abs(headNum - svcBlock);
        // 2% of head (floor 500 blocks) is generous enough for indexing lag
        // while still catching a service pointed at a different chain.
        if (svcBlock > 0 && lag < Math.max(headNum * 0.02, 500)) {
          row.txsvc = `sync ${lag}`;
        } else {
          row.txsvc = `LAG ${lag}`;
          row.notes.push(
            `tx service height ${svcBlock} vs chain head ${headNum} -- shortname may be wrong`,
          );
        }
      }
    }
  } finally {
    provider.destroy();
  }

  return row;
}

/**
 * Estimate the native-token cost of `createProxyWithNonce` on this chain.
 *
 * Uses eth_estimateGas against the real factory with the real initializer, so
 * this reflects the actual deploy rather than a guess. Falls back to a
 * conservative 400k gas if the node refuses to estimate (some chains reject
 * estimateGas from an unfunded account).
 */
async function estimateDeployCost(
  row: Row,
  provider: JsonRpcProvider,
  chain: SafeChain,
): Promise<bigint | undefined> {
  const dep = getOkuSafeDeployment();
  const data = SAFE_PROXY_FACTORY_IFACE.encodeFunctionData("createProxyWithNonce", [
    SAFE_L1_SINGLETON,
    dep.initializer,
    dep.saltNonce,
  ]);

  let gas = 400_000n;
  const est = await soft(row, "estimateGas(createProxy)", () =>
    provider.estimateGas({ from: OKU_DEPLOYER_EOA, to: SAFE_PROXY_FACTORY, data }),
  );
  if (est !== undefined) {
    gas = (est * 130n) / 100n; // 30% buffer, matching tasks/deploy.ts
  } else {
    row.notes.push("estimateGas failed; assuming 400k gas for the funding check");
  }

  // Honour hardhat.config.ts gasPrice overrides: Saga mines zero-price txs
  // and xdc rejects EIP-1559, so both pin a legacy gasPrice that the fee
  // market reading below would otherwise contradict.
  const overrides = gasOverrides(chain);
  if (overrides.gasPrice !== undefined) {
    return gas * (overrides.gasPrice as bigint);
  }

  const fee = await soft(row, "getFeeData", () => provider.getFeeData());
  if (fee === undefined) return undefined;
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (price == null) {
    row.notes.push("no fee data available; skipping funding check");
    return undefined;
  }
  return gas * price;
}

function trim(s: string): string {
  return s.length > 11 ? s.slice(0, 11) : s;
}

function errText(e: unknown): string {
  const anyE = e as { shortMessage?: string; message?: string };
  return String(anyE?.shortMessage ?? anyE?.message ?? e).slice(0, 110);
}

task("safe:preflight", "Read-only GO/NO-GO checks for the production Safe rollout")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addFlag("allNotes", "Print all notes, including transient RPC/API blips")
  .setAction(async (taskArgs, hre) => {
    // Fail immediately if the pinned constants and the derivation disagree.
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

    console.log("\n" + "=".repeat(108));
    console.log("SAFE PREFLIGHT  (read-only, sends no transactions)");
    console.log("=".repeat(108));
    console.log(`Safe address     : ${dep.address}   (identical on every chain)`);
    console.log(`Threshold        : ${dep.threshold} of ${dep.owners.length}`);
    dep.owners.forEach((o, i) => console.log(`  owner[${i}]       : ${o}`));
    console.log(`saltNonce        : ${dep.saltNonce}`);
    console.log(`initializer hash : ${keccak256(dep.initializer)}`);
    console.log(`Deployer/relayer : ${OKU_DEPLOYER_EOA}`);
    console.log(`Chains to check  : ${chains.length}`);

    const keyless = chains.filter((c) => !resolveDeployerKey(hre, c.network));
    if (keyless.length) {
      console.log(
        `\n⚠ No deployer key resolvable for: ${keyless.map((c) => c.network).join(", ")}`,
      );
    }

    // Concurrency 4 rather than 8: Safe's public API is shared and rate
    // limited, and a wider fan out produces 429s that look like failures.
    const rows = await mapLimit(chains, 4, (c) => checkChain(c, dep.address));

    const w = {
      network: 12,
      chainId: 9,
      infra: 11,
      proxyCode: 10,
      safeSlot: 11,
      owners: 9,
      balance: 13,
      needed: 13,
      funded: 8,
      router: 14,
      txsvc: 10,
    };
    console.log("");
    console.log(
      pad("network", w.network) +
        pad("chainId", w.chainId) +
        pad("safeInfra", w.infra) +
        pad("proxyCode", w.proxyCode) +
        pad("safeAddr", w.safeSlot) +
        pad("owners", w.owners) +
        pad("deployerBal", w.balance) +
        pad("needToDeploy", w.needed) +
        pad("funded", w.funded) +
        pad("routerOwner", w.router) +
        pad("txService", w.txsvc),
    );
    console.log("-".repeat(108));
    for (const r of rows) {
      console.log(
        pad(r.network, w.network) +
          pad(r.chainId, w.chainId) +
          pad(r.infra, w.infra) +
          pad(r.proxyCode, w.proxyCode) +
          pad(r.safeSlot, w.safeSlot) +
          pad(r.owners, w.owners) +
          pad(r.balance, w.balance) +
          pad(r.needed, w.needed) +
          pad(r.funded, w.funded) +
          pad(r.router, w.router) +
          pad(r.txsvc, w.txsvc),
      );
    }

    // ---- notes ----
    const transient = /unavailable after retries|rate|429|HTTP5|timeout|408/i;
    const noted = rows
      .map((r) => ({
        network: r.network,
        notes: taskArgs.allNotes ? r.notes : r.notes.filter((n) => !transient.test(n)),
      }))
      .filter((r) => r.notes.length);
    if (noted.length) {
      console.log("\nNOTES");
      console.log("-".repeat(108));
      for (const r of noted) for (const n of r.notes) console.log(`  ${r.network}: ${n}`);
    }
    const hidden = rows.reduce(
      (acc, r) => acc + r.notes.filter((n) => transient.test(n)).length,
      0,
    );
    if (hidden && !taskArgs.allNotes) {
      console.log(`\n  (${hidden} transient RPC/API note(s) hidden; re-run with --all-notes)`);
    }

    // ---- verdict ----
    //
    // Three states, not two. A transient RPC failure leaves a check
    // *unverified*, which is not the same as passing -- reporting GO on an
    // unknown is exactly how a chain ends up stranded mid-migration. So any
    // ERR cell downgrades the verdict and names the chains to re-run.
    const checkCells = [
      "infra",
      "proxyCode",
      "safeSlot",
      "owners",
      "balance",
      "router",
    ] as const;
    const incomplete = rows
      .map((r) => ({
        network: r.network,
        chainId: r.chainId,
        unverified: checkCells.filter((k) => r[k] === "ERR" || r[k] === "?"),
      }))
      .filter((r) => r.unverified.length);
    const bad = rows.filter((r) => r.problems.length);

    console.log("\n" + "=".repeat(108));
    if (bad.length === 0 && incomplete.length === 0) {
      const free = rows.filter((r) => r.safeSlot === "free").length;
      const ours = rows.filter((r) => r.safeSlot.startsWith("ours")).length;
      const svc = rows.filter((r) => r.txsvc.startsWith("sync")).length;
      console.log("RESULT: GO");
      console.log("=".repeat(108));
      console.log(`  ${rows.length} chains checked, 0 problems, 0 unverified`);
      console.log(`  Safe address: free on ${free}, already ours on ${ours}`);
      console.log(`  Safe Transaction Service confirmed synced on ${svc} chain(s)`);
      console.log(`  The other chains are driven entirely by safe:build / safe:sign / safe:exec`);
    } else {
      const verdict = bad.length ? "NO-GO" : "INCOMPLETE";
      console.log(
        `RESULT: ${verdict}  ` +
          `(${bad.length} chain(s) with problems, ${incomplete.length} with unverified checks)`,
      );
      console.log("=".repeat(108));
      for (const r of bad) {
        console.log(`\n  ${r.network} (${r.chainId}):`);
        for (const p of r.problems) console.log(`    ✗ ${p}`);
      }
      if (incomplete.length) {
        console.log(
          `\n  Unverified due to RPC failures -- these are NOT passes. Re-run:\n` +
            `    npx hardhat safe:preflight --networks ` +
            incomplete.map((r) => r.network).join(","),
        );
        for (const r of incomplete) {
          console.log(`    ? ${r.network}: could not verify ${r.unverified.join(", ")}`);
        }
      }
      process.exitCode = 1;
    }
    console.log("");
  });
