/**
 * safeDeploy.ts
 *
 * Deterministic deployment of the production Safe to every chain, at one
 * identical address.
 *
 *   safe:predict  -- fully offline. Prints the address and initializer and
 *                    proves cross-chain parity without touching the network.
 *   safe:deploy   -- DRY RUN BY DEFAULT. Simulates the deploy with eth_call
 *                    and only sends transactions when given --broadcast.
 *
 * We deploy no Safe *contracts*: the singleton, factory, fallback handler and
 * MultiSend are Safe's own deployments and already exist on all 34 chains.
 * What we deploy is our own Safe *proxy*, once per chain -- a Safe account is
 * a smart contract, so it does not exist on a chain until its proxy is there.
 * That is unavoidable and is not something app.safe.global can do for us on
 * the 12 chains it does not support.
 *
 * Why script all 34 instead of using app.safe.global for the 22 it supports:
 *   - One byte-identical code path instead of two divergent ones.
 *   - We choose the saltNonce; the UI picks its own, so the address would not
 *     be knowable in advance.
 *   - The Safe Transaction Service indexes the canonical factory's
 *     ProxyCreation event regardless of who called it (verified: the previous
 *     Oku Safe was created through a relayer intermediary, not a direct
 *     factory call, and indexed fully). So a Safe deployed by this task still
 *     shows up in app.safe.global with full UI and Proposers on all 22
 *     supported chains.
 *
 * Usage:
 *   npx hardhat safe:predict
 *   npx hardhat safe:deploy                            # dry run, all chains
 *   npx hardhat safe:deploy --networks telos           # dry run, one chain
 *   npx hardhat safe:deploy --networks telos --broadcast
 */
import { task } from "hardhat/config";
import { Wallet, getAddress, keccak256 } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  OKU_DEPLOYER_EOA,
  OKU_SAFE_OWNERS,
  OKU_SAFE_THRESHOLD,
  SAFE_FALLBACK_HANDLER,
  SAFE_L1_SINGLETON,
  SAFE_L2_SINGLETON,
  SAFE_PROXY_CREATION_CODE_HASH,
  SAFE_PROXY_FACTORY,
  SAFE_PROXY_FACTORY_IFACE,
  SAFE_TO_L2_SETUP,
  SAFE_TO_L2_SETUP_CREATION_CODE,
  SAFE_HELPER_DEPLOY_SALT,
  assertOkuSafeConfig,
  assertSafeToL2SetupBytecode,
  getOkuSafeDeployment,
  hasSafeTxService,
} from "../util/safeConfig";
import { SAFE_IFACE, decodeRevert } from "../util/safeTx";
import { SAFE_SINGLETON_FACTORY } from "../util/contractMeta";
import { recordDeployment } from "../util/deploymentsRegistry";
import {
  confirmTx,
  gasOverrides,
  listSafeChains,
  makeProvider,
  pad,
  resolveDeployerKey,
  waitForCode,
  type SafeChain,
} from "../util/safeChains";
import { withRetry } from "../util/rpcRetry";

/** Safe storage layout: slot 0 is the singleton ("masterCopy") pointer. */
const SLOT_SINGLETON = "0x0";
/** keccak256("fallback_manager.handler.address") */
const SLOT_FALLBACK_HANDLER =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

type Status =
  | "would-deploy"
  | "deployed"
  | "already-ours"
  | "skipped"
  | "failed";

interface Result {
  network: string;
  chainId: number;
  status: Status;
  detail: string;
  txHash?: string;
}

/**
 * Read the singleton pointer (slot 0) and fallback handler from a deployed
 * Safe, so we can assert the SafeToL2Setup delegatecall actually ran.
 */
async function readSafeSlots(
  provider: JsonRpcProvider,
  safe: string,
): Promise<{ singleton: string; fallbackHandler: string }> {
  const [s0, sf] = await Promise.all([
    provider.getStorage(safe, SLOT_SINGLETON),
    provider.getStorage(safe, SLOT_FALLBACK_HANDLER),
  ]);
  return {
    singleton: getAddress("0x" + s0.slice(-40)),
    fallbackHandler: getAddress("0x" + sf.slice(-40)),
  };
}

/**
 * Post-deploy verification. Anything failing here means we must NOT record
 * the deployment or hand ownership to it.
 */
async function verifyDeployedSafe(
  provider: JsonRpcProvider,
  chain: SafeChain,
  safe: string,
): Promise<{ ok: boolean; version: string; owners: string[]; threshold: number; problems: string[] }> {
  const problems: string[] = [];
  const call = async (fn: string) =>
    SAFE_IFACE.decodeFunctionResult(
      fn,
      await provider.call({ to: safe, data: SAFE_IFACE.encodeFunctionData(fn) }),
    )[0];

  const owners = ((await call("getOwners")) as string[]).map((o) => getAddress(o));
  const threshold = Number((await call("getThreshold")) as bigint);
  const version = String(await call("VERSION"));

  const want = new Set(OKU_SAFE_OWNERS.map((o) => getAddress(o)));
  const got = new Set(owners);
  if (got.size !== want.size || ![...want].every((o) => got.has(o))) {
    problems.push(`owner set mismatch: got [${owners.join(", ")}]`);
  }
  if (threshold !== OKU_SAFE_THRESHOLD) {
    problems.push(`threshold is ${threshold}, expected ${OKU_SAFE_THRESHOLD}`);
  }

  const slots = await readSafeSlots(provider, safe);
  // SafeToL2Setup only switches the singleton when chainid != 1. On mainnet
  // the Safe legitimately stays on the L1 singleton.
  const expectedSingleton =
    chain.chainId === 1 ? getAddress(SAFE_L1_SINGLETON) : getAddress(SAFE_L2_SINGLETON);
  if (slots.singleton !== expectedSingleton) {
    problems.push(
      `singleton (slot 0) is ${slots.singleton}, expected ${expectedSingleton}. ` +
        `The SafeToL2Setup delegatecall did not run as expected` +
        (hasSafeTxService(chain.chainId)
          ? ` -- on this chain that also means Safe's Transaction Service will not index it correctly.`
          : `.`),
    );
  }
  if (slots.fallbackHandler !== getAddress(SAFE_FALLBACK_HANDLER)) {
    problems.push(
      `fallback handler is ${slots.fallbackHandler}, expected ${SAFE_FALLBACK_HANDLER}`,
    );
  }

  // A freshly deployed Safe must have no modules enabled. A module bypasses
  // the threshold entirely, so an unexpected one is a critical finding.
  try {
    const raw = await provider.call({
      to: safe,
      data: SAFE_IFACE.encodeFunctionData("getModulesPaginated", [
        "0x0000000000000000000000000000000000000001",
        10,
      ]),
    });
    const [modules] = SAFE_IFACE.decodeFunctionResult("getModulesPaginated", raw);
    if ((modules as string[]).length > 0) {
      problems.push(`unexpected modules enabled: ${(modules as string[]).join(", ")}`);
    }
  } catch {
    problems.push("could not read modules (getModulesPaginated failed)");
  }

  return { ok: problems.length === 0, version, owners, threshold, problems };
}

/** Ensure SafeToL2Setup exists, deploying it if missing (Gensyn only today). */
async function ensureSafeToL2Setup(
  provider: JsonRpcProvider,
  wallet: Wallet | undefined,
  chain: SafeChain,
  broadcast: boolean,
  log: (s: string) => void,
): Promise<{ present: boolean; txHash?: string }> {
  const code = await withRetry(
    () => provider.getCode(SAFE_TO_L2_SETUP),
    `${chain.network}:getCode(SafeToL2Setup)`,
  );
  if (code !== "0x") return { present: true };

  // Self-verifying: refuses to proceed unless the embedded creation code
  // provably CREATE2s to the canonical address.
  assertSafeToL2SetupBytecode();
  log(
    `  SafeToL2Setup missing. It is part of the initializer preimage, so it must ` +
      `exist at ${SAFE_TO_L2_SETUP} before the Safe can be deployed here.`,
  );

  const factoryCode = await provider.getCode(SAFE_SINGLETON_FACTORY);
  if (factoryCode === "0x") {
    throw new Error(
      `Safe Singleton Factory absent at ${SAFE_SINGLETON_FACTORY}; cannot deploy ` +
        `SafeToL2Setup deterministically on ${chain.network}.`,
    );
  }

  // Safe Singleton Factory calldata convention: salt ++ initCode.
  const data = SAFE_HELPER_DEPLOY_SALT + SAFE_TO_L2_SETUP_CREATION_CODE.slice(2);

  if (!broadcast) {
    log(`  [dry run] would deploy SafeToL2Setup -> ${SAFE_TO_L2_SETUP}`);
    return { present: false };
  }
  if (!wallet) throw new Error("no signer available");

  const overrides = gasOverrides(chain);
  const tx = await withRetry(
    () =>
      wallet.sendTransaction({ to: SAFE_SINGLETON_FACTORY, data, ...overrides }),
    `${chain.network}:deploy SafeToL2Setup`,
  );
  // Bounded receipt poll rather than tx.wait(); see confirmTx() for why.
  await confirmTx(provider, tx.hash);
  if (!(await waitForCode(provider, SAFE_TO_L2_SETUP))) {
    throw new Error(`SafeToL2Setup deploy produced no code at ${SAFE_TO_L2_SETUP}`);
  }
  log(`  ✓ SafeToL2Setup deployed at ${SAFE_TO_L2_SETUP} [tx ${tx.hash}]`);
  return { present: true, txHash: tx.hash };
}

async function deployOnChain(
  hre: HardhatRuntimeEnvironment,
  chain: SafeChain,
  broadcast: boolean,
): Promise<Result> {
  const dep = getOkuSafeDeployment();
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const flush = () => lines.forEach((l) => console.log(l));

  console.log(`\n=== ${chain.network} (${chain.chainId})`);
  if (!chain.rpcUrl) {
    console.log("  ✗ NO_RPC configured");
    return { network: chain.network, chainId: chain.chainId, status: "skipped", detail: "NO_RPC" };
  }

  const provider = makeProvider(chain.rpcUrl, chain.chainId);
  try {
    let wallet: Wallet | undefined;
    if (broadcast) {
      const key = resolveDeployerKey(hre, chain.network);
      if (!key) {
        console.log("  ✗ NO_KEY configured");
        return {
          network: chain.network,
          chainId: chain.chainId,
          status: "skipped",
          detail: "NO_KEY",
        };
      }
      wallet = new Wallet(key, provider);
    }

    // --- 1. the factory must produce the proxy bytecode we predicted with ---
    const raw = await withRetry(
      () =>
        provider.call({
          to: SAFE_PROXY_FACTORY,
          data: SAFE_PROXY_FACTORY_IFACE.encodeFunctionData("proxyCreationCode"),
        }),
      `${chain.network}:proxyCreationCode`,
    );
    const [onChainCreationCode] = SAFE_PROXY_FACTORY_IFACE.decodeFunctionResult(
      "proxyCreationCode",
      raw,
    );
    const h = keccak256(onChainCreationCode as string);
    if (h !== SAFE_PROXY_CREATION_CODE_HASH) {
      console.log(
        `  ✗ proxyCreationCode mismatch (${h}). Deploying here would produce a ` +
          `DIFFERENT Safe address than the other chains. Refusing.`,
      );
      return {
        network: chain.network,
        chainId: chain.chainId,
        status: "failed",
        detail: "PROXY_CODE_MISMATCH",
      };
    }

    // --- 2. idempotency ---
    const existing = await withRetry(
      () => provider.getCode(dep.address),
      `${chain.network}:getCode(safe)`,
    );
    if (existing !== "0x") {
      const v = await verifyDeployedSafe(provider, chain, dep.address);
      if (!v.ok) {
        console.log(`  ✗ address occupied but not our Safe:`);
        v.problems.forEach((p) => console.log(`      ${p}`));
        return {
          network: chain.network,
          chainId: chain.chainId,
          status: "failed",
          detail: "OCCUPIED_MISMATCH",
        };
      }
      console.log(
        `  ✓ already deployed: ${dep.address}  v${v.version}  ${v.threshold}/${v.owners.length}`,
      );
      if (broadcast) {
        recordDeployment(chain.network, chain.chainId, "Safe", {
          address: dep.address,
          version: `${v.version}${chain.chainId === 1 ? "" : "+L2"}`,
          threshold: v.threshold,
          owners: v.owners,
        });
      }
      return {
        network: chain.network,
        chainId: chain.chainId,
        status: "already-ours",
        detail: `v${v.version}`,
      };
    }

    // --- 3. SafeToL2Setup prerequisite ---
    const l2setup = await ensureSafeToL2Setup(provider, wallet, chain, broadcast, log);
    flush();
    lines.length = 0;

    const deployData = SAFE_PROXY_FACTORY_IFACE.encodeFunctionData(
      "createProxyWithNonce",
      [SAFE_L1_SINGLETON, dep.initializer, dep.saltNonce],
    );

    // --- 4. dry run: simulate and confirm the returned address ---
    if (!broadcast) {
      if (!l2setup.present) {
        console.log(
          `  [dry run] cannot simulate the Safe deploy until SafeToL2Setup exists ` +
            `(setup() would revert GS002). Re-run with --broadcast to do both.`,
        );
        return {
          network: chain.network,
          chainId: chain.chainId,
          status: "would-deploy",
          detail: "needs SafeToL2Setup first",
        };
      }
      try {
        const sim = await withRetry(
          () =>
            provider.call({
              // `from` is mandatory, not cosmetic. Some nodes (Saga) derive
              // the eth_call gas allowance from the caller and fail the inner
              // CREATE2 with "Create2 call failed" when from is the implicit
              // zero address. Using the real deployer also makes the
              // simulation faithful to the transaction we would actually send.
              from: OKU_DEPLOYER_EOA,
              to: SAFE_PROXY_FACTORY,
              data: deployData,
            }),
          `${chain.network}:simulate createProxyWithNonce`,
        );
        const [proxy] = SAFE_PROXY_FACTORY_IFACE.decodeFunctionResult(
          "createProxyWithNonce",
          sim,
        );
        const simulated = getAddress(proxy as string);
        if (simulated !== getAddress(dep.address)) {
          console.log(
            `  ✗ simulation returned ${simulated}, expected ${dep.address}. Refusing.`,
          );
          return {
            network: chain.network,
            chainId: chain.chainId,
            status: "failed",
            detail: "SIM_ADDRESS_MISMATCH",
          };
        }
        console.log(`  ✓ [dry run] simulated OK -> ${simulated}`);
        return {
          network: chain.network,
          chainId: chain.chainId,
          status: "would-deploy",
          detail: "simulated ok",
        };
      } catch (e) {
        const anyE = e as { data?: string; shortMessage?: string; message?: string };
        const reason = anyE.data ? decodeRevert(anyE.data) : undefined;
        console.log(
          `  ✗ [dry run] simulation FAILED: ${reason ?? anyE.shortMessage ?? anyE.message}`,
        );
        return {
          network: chain.network,
          chainId: chain.chainId,
          status: "failed",
          detail: `SIM_REVERT ${reason ?? ""}`.trim(),
        };
      }
    }

    // --- 5. broadcast ---
    if (!wallet) throw new Error("no signer available");
    const overrides = gasOverrides(chain);
    let gasLimit: bigint;
    try {
      const est = await withRetry(
        () =>
          provider.estimateGas({
            from: wallet!.address,
            to: SAFE_PROXY_FACTORY,
            data: deployData,
          }),
        `${chain.network}:estimateGas`,
      );
      gasLimit = (est * 130n) / 100n;
    } catch {
      // Matches the fallback in tasks/deploy.ts: some chains (Filecoin)
      // charge for message storage and need headroom well above EVM cost.
      gasLimit = 2_000_000n;
    }

    const tx = await withRetry(
      () =>
        wallet!.sendTransaction({
          to: SAFE_PROXY_FACTORY,
          data: deployData,
          gasLimit,
          ...overrides,
        }),
      `${chain.network}:sendTransaction(createProxyWithNonce)`,
    );
    const receipt = await confirmTx(provider, tx.hash);
    if (!receipt) {
      console.log(
        `  ⚠ receipt not seen within the timeout for ${tx.hash}; ` +
          `falling through to the authoritative getCode check`,
      );
    }

    // Poll rather than a single read: some chains serve this from a node
    // that has not caught up yet and would report "0x" for a deployed Safe.
    const codeAppeared = await waitForCode(provider, dep.address);
    if (!codeAppeared) {
      console.log(`  ✗ no code at ${dep.address} after deploy [tx ${tx.hash}]`);
      return {
        network: chain.network,
        chainId: chain.chainId,
        status: "failed",
        detail: "NO_CODE_POST_DEPLOY",
        txHash: tx.hash,
      };
    }

    const v = await verifyDeployedSafe(provider, chain, dep.address);
    if (!v.ok) {
      console.log(`  ✗ post-deploy verification FAILED [tx ${tx.hash}]:`);
      v.problems.forEach((p) => console.log(`      ${p}`));
      return {
        network: chain.network,
        chainId: chain.chainId,
        status: "failed",
        detail: "VERIFY_FAILED",
        txHash: tx.hash,
      };
    }

    recordDeployment(chain.network, chain.chainId, "Safe", {
      address: dep.address,
      version: `${v.version}${chain.chainId === 1 ? "" : "+L2"}`,
      threshold: v.threshold,
      owners: v.owners,
    });
    console.log(
      `  ✓ deployed ${dep.address}  v${v.version}  ${v.threshold}/${v.owners.length} [tx ${tx.hash}]`,
    );
    return {
      network: chain.network,
      chainId: chain.chainId,
      status: "deployed",
      detail: `v${v.version}`,
      txHash: tx.hash,
    };
  } catch (e) {
    flush();
    const anyE = e as { shortMessage?: string; message?: string };
    console.log(`  ✗ ${anyE.shortMessage ?? anyE.message ?? e}`);
    return {
      network: chain.network,
      chainId: chain.chainId,
      status: "failed",
      detail: String(anyE.shortMessage ?? anyE.message ?? e).slice(0, 90),
    };
  } finally {
    provider.destroy();
  }
}

// ---------------------------------------------------------------------------

task("safe:predict", "Print the deterministic Safe address and prove cross-chain parity")
  .setAction(async (_args, hre) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const chains = listSafeChains(hre);

    console.log("\n" + "=".repeat(84));
    console.log("PRODUCTION SAFE  (offline prediction -- no network access)");
    console.log("=".repeat(84));
    console.log(`address           : ${dep.address}`);
    console.log(`threshold         : ${dep.threshold} of ${dep.owners.length}`);
    dep.owners.forEach((o, i) =>
      console.log(`owner[${i}]          : ${o}`),
    );
    console.log(`saltNonce         : ${dep.saltNonce}`);
    console.log(`salt              : ${dep.salt}`);
    console.log(`initializer keccak: ${keccak256(dep.initializer)}`);
    console.log(`initializer bytes : ${(dep.initializer.length - 2) / 2}`);
    console.log(`initCodeHash      : ${dep.initCodeHash}`);
    console.log("");
    console.log(`proxy factory     : ${SAFE_PROXY_FACTORY}`);
    console.log(`singleton (CREATE2): ${SAFE_L1_SINGLETON}  (Safe v1.4.1 L1)`);
    console.log(`post-setup runtime : ${SAFE_L2_SINGLETON}  (SafeL2 v1.4.1, chainid != 1)`);
    console.log(`fallback handler  : ${SAFE_FALLBACK_HANDLER}`);
    console.log(`SafeToL2Setup     : ${SAFE_TO_L2_SETUP}`);

    // The address is a pure function of the constants above, none of which
    // are chain-dependent, so parity is structural rather than empirical.
    // We still enumerate so the operator sees the full target list.
    const svc = chains.filter((c) => hasSafeTxService(c.chainId));
    const noSvc = chains.filter((c) => !hasSafeTxService(c.chainId));
    console.log("");
    console.log(`Target chains     : ${chains.length}`);
    console.log(
      `  with Safe UI + Proposers (${svc.length}): ${svc.map((c) => c.network).join(", ")}`,
    );
    console.log(
      `  no Safe services   (${noSvc.length}): ${noSvc.map((c) => c.network).join(", ")}`,
    );
    console.log("");
    console.log(
      "The address depends only on (factory, singleton, proxy creation code,\n" +
        "initializer, saltNonce). None of those vary by chain, and the salt does\n" +
        "NOT include msg.sender -- so this address is identical on every chain and\n" +
        "reproducible from any deployer key. `safe:preflight` verifies each chain's\n" +
        "factory really returns the pinned proxy creation code.",
    );
    console.log("");
  });

task("safe:deploy", "Deploy the production Safe proxy (DRY RUN unless --broadcast)")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addFlag("broadcast", "Actually send transactions (default is a dry run)")
  .addFlag("continueOnError", "Keep going after a chain fails")
  .setAction(async (taskArgs, hre) => {
    assertOkuSafeConfig();
    const dep = getOkuSafeDeployment();
    const broadcast: boolean = taskArgs.broadcast;

    const only = taskArgs.networks
      ? new Set<string>(
          String(taskArgs.networks)
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    const chains = listSafeChains(hre, only);

    console.log("\n" + "=".repeat(84));
    console.log(
      broadcast
        ? "SAFE DEPLOY  *** BROADCAST -- WILL SEND TRANSACTIONS ***"
        : "SAFE DEPLOY  [DRY RUN -- no transactions will be sent]",
    );
    console.log("=".repeat(84));
    console.log(`Safe address : ${dep.address}`);
    console.log(`Owners       : ${dep.threshold} of ${dep.owners.length}`);
    console.log(`Chains       : ${chains.length}`);
    if (!broadcast) {
      console.log(
        `\nDry run simulates createProxyWithNonce via eth_call and asserts the\n` +
          `returned proxy address equals the predicted one. Add --broadcast to send.`,
      );
    }

    // Chains are processed sequentially so a mistake is caught on chain 1 of
    // 34 rather than after 34 broadcasts.
    const results: Result[] = [];
    for (const chain of chains) {
      const r = await deployOnChain(hre, chain, broadcast);
      results.push(r);
      if (r.status === "failed" && !taskArgs.continueOnError) {
        console.log(
          `\n✗ Stopping: ${chain.network} failed. Fix it, or pass --continue-on-error.`,
        );
        break;
      }
    }

    console.log("\n" + "=".repeat(84));
    console.log(broadcast ? "DEPLOY SUMMARY" : "DRY RUN SUMMARY");
    console.log("=".repeat(84));
    for (const r of results) {
      console.log(
        pad(r.network, 13) + pad(r.chainId, 9) + pad(r.status, 15) + (r.detail ?? ""),
      );
    }
    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log("-".repeat(84));
    console.log(
      Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join("   "),
    );
    if (results.some((r) => r.status === "failed")) process.exitCode = 1;
    if (!broadcast && results.length) {
      console.log(
        `\nNothing was sent. When ready, deploy the canary first:\n` +
          `  npx hardhat safe:deploy --networks telos --broadcast\n` +
          `then verify, then roll out the rest.`,
      );
    }
    console.log("");
  });
