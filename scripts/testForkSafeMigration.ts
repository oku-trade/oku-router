/**
 * testForkSafeMigration.ts
 *
 * Full local-fork rehearsal of the entire Safe migration, end to end, using
 * the same production code paths the live tasks use. Never touches a real
 * chain.
 *
 * For each chain under test:
 *
 *   1. Reset the Hardhat network to a fresh fork of that chain.
 *   2. Deploy a Safe through the REAL SafeProxyFactory v1.4.1 that already
 *      exists on the fork, with the REAL initializer shape produced by
 *      util/safeConfig.buildSafeInitializer -- but with three throwaway test
 *      owners, because we obviously cannot sign for the production hardware
 *      wallets. Address derivation, SafeToL2Setup delegatecall, singleton
 *      migration and fallback handler are all exercised for real.
 *   3. Assert the deployed Safe's address equals the offline prediction, that
 *      slot 0 migrated to SafeL2 (chainid != 1), and that no modules exist.
 *   4. Impersonate the real router owner and run the real Ownable2Step
 *      handover: transferOwnership(safe).
 *   5. Build a SafeTx for acceptOwnership() using the production
 *      buildSafeTx/hashSafeTx helpers, cross-check the hash against the
 *      Safe's own getTransactionHash(), sign with 2 of 3 test owners, pack
 *      the signatures with the production packSignatures(), and execute.
 *   6. Assert the Safe now owns the router.
 *   7. Prove the executor model: relay a MultiSend batch of two real admin
 *      calls (setMaxWarrantDuration + updateValidSigner) from a RANDOM
 *      unfunded-of-authority relayer account that is not an owner, and
 *      confirm both took effect. This is the property that lets the hot
 *      deployer EOA pay all the gas on 34 chains while holding zero
 *      permissions.
 *   8. Prove threshold enforcement: a single signature must be rejected.
 *
 * Why this matters: it validates the whole plan -- address parity, the
 * DELEGATECALL MultiSend batching, signature sorting/packing, Ownable2Step
 * sequencing and the permissionless executor -- before a single real
 * transaction is sent.
 *
 * Usage:
 *   npx hardhat run scripts/testForkSafeMigration.ts
 */
import hre from "hardhat";
import { HDNodeWallet, Wallet, getAddress, parseEther, toBeHex } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import {
  SAFE_L1_SINGLETON,
  SAFE_L2_SINGLETON,
  SAFE_FALLBACK_HANDLER,
  SAFE_MULTISEND_CALL_ONLY,
  SAFE_PROXY_FACTORY,
  SAFE_PROXY_FACTORY_IFACE,
  SAFE_TO_L2_SETUP,
  buildSafeInitializer,
  predictSafeAddress,
} from "../util/safeConfig";
import {
  SAFE_IFACE,
  SAFE_TX_TYPES,
  buildBatchedSafeTx,
  buildSafeTx,
  hashSafeTx,
  packSignatures,
  recoverSafeTxSigner,
  safeDomain,
  verifySafeTxHashOnChain,
} from "../util/safeTx";
import { readRegistry } from "../util/deploymentsRegistry";

/** keccak256("fallback_manager.handler.address") */
const SLOT_FALLBACK_HANDLER =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

/**
 * Chains to rehearse on. Kept small and OP-stack-plus-others diverse: the
 * point is to exercise the code paths, not to re-prove address parity (which
 * safe:preflight already verifies on all 34 by checking proxyCreationCode).
 */
const CHAINS = ["op", "base", "arbitrum", "bsc", "gnosis"];

/**
 * Fallback RPCs for chains whose configured public endpoint is unreliable
 * from a fork harness (1rpc.io returns 410, publicnode 403s on some hosts).
 * Mirrors the FALLBACK_RPC pattern in scripts/testForkDeployV2.ts. This only
 * affects the local harness's RPC choice, never production config.
 */
const FALLBACK_RPC: Record<string, string> = {
  base: process.env.ALCHEMY_API_KEY
    ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : "https://base.llamarpc.com",
  bsc: process.env.ALCHEMY_API_KEY
    ? `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : "https://binance.llamarpc.com",
};

/** Three deterministic throwaway owners, derived from a fixed test mnemonic. */
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

/**
 * Unique saltNonce per run.
 *
 * The mnemonic above is the well-known public Hardhat test phrase, so a Safe
 * with these exact owners at saltNonce 0 already exists on several real
 * chains (observed on Base) -- CREATE2 then reverts with "Create2 call
 * failed". Randomising the nonce keeps each rehearsal on a virgin address.
 * The address is irrelevant to what we assert; only predicted == deployed
 * matters.
 */
const RUN_SALT_NONCE = BigInt(Date.now());

interface Result {
  chain: string;
  status: string;
  detail: string;
}

function testOwners(): HDNodeWallet[] {
  return [0, 1, 2].map((i) =>
    HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`),
  );
}

function rpcFor(chain: string): string[] {
  const cfg = (hre.config.networks as Record<string, { url?: string }>)[chain];
  const urls: string[] = [];
  if (cfg?.url) urls.push(cfg.url);
  if (FALLBACK_RPC[chain]) urls.push(FALLBACK_RPC[chain]);
  return urls;
}

async function rehearse(chain: string): Promise<Result> {
  const reg = readRegistry(chain);
  const router = reg.current.OkuRouter?.address;
  const chainId = reg.chainId;
  if (!router) return { chain, status: "SKIP", detail: "no OkuRouter in registry" };

  const urls = rpcFor(chain);
  if (urls.length === 0) return { chain, status: "SKIP", detail: "no RPC configured" };

  console.log(`\n${"=".repeat(78)}`);
  console.log(`REHEARSAL: ${chain} (registry chainId ${chainId})  router=${router}`);
  console.log("=".repeat(78));

  let forked = false;
  let lastErr = "";
  for (const url of urls) {
    try {
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: url } }],
      });
      forked = true;
      break;
    } catch (e) {
      lastErr = String((e as { message?: string }).message ?? e).slice(0, 80);
    }
  }
  if (!forked) return { chain, status: "SKIP", detail: `fork failed: ${lastErr}` };

  const provider = hre.ethers.provider;

  // IMPORTANT: hardhat_reset cannot change the network's chainId -- it is
  // fixed by hardhat.config.ts (`hardhat: { chainId: ... }`). So the forked
  // EVM's `block.chainid` is NOT the real chain's id. Every EIP-712 domain
  // here must therefore use the chainId the fork actually reports, or our
  // locally computed safeTxHash will not match the Safe's own
  // getTransactionHash(). Reading it back is also a live assertion that our
  // hashing correctly binds chainId.
  const forkChainId = Number((await provider.getNetwork()).chainId);
  if (forkChainId !== chainId) {
    console.log(
      `  note: fork reports chainId ${forkChainId} (not ${chainId}); ` +
        `hardhat pins this in config. Using ${forkChainId} for EIP-712.`,
    );
  }
  const owners = testOwners();
  const ownerAddrs = owners.map((o) => getAddress(o.address));
  console.log(`  test owners: ${ownerAddrs.join(", ")}`);

  // ---- 1. offline prediction with the test owner set ----
  const predicted = predictSafeAddress(ownerAddrs, 2, RUN_SALT_NONCE);
  console.log(`  predicted Safe: ${predicted.address}  (saltNonce ${RUN_SALT_NONCE})`);
  if ((await hre.ethers.provider.getCode(predicted.address)) !== "0x") {
    return { chain, status: "SKIP", detail: "test Safe address already occupied on this fork" };
  }

  // Sanity: the initializer built here must be identical in shape to the
  // production one (same `to`, data, fallback handler, payment receiver).
  const initializer = buildSafeInitializer(ownerAddrs, 2);
  if (initializer !== predicted.initializer) {
    return { chain, status: "FAIL", detail: "initializer mismatch" };
  }

  // ---- 2. deploy the Safe via the real factory on the fork ----
  const [funder] = await hre.ethers.getSigners();
  const deployData = SAFE_PROXY_FACTORY_IFACE.encodeFunctionData(
    "createProxyWithNonce",
    [SAFE_L1_SINGLETON, initializer, RUN_SALT_NONCE],
  );
  // Confirm the fork really has Safe's infrastructure.
  for (const [label, addr] of Object.entries({
    factory: SAFE_PROXY_FACTORY,
    safeL1: SAFE_L1_SINGLETON,
    safeL2: SAFE_L2_SINGLETON,
    toL2Setup: SAFE_TO_L2_SETUP,
    multiSend: SAFE_MULTISEND_CALL_ONLY,
  })) {
    if ((await provider.getCode(addr)) === "0x") {
      return { chain, status: "FAIL", detail: `fork missing ${label} at ${addr}` };
    }
  }

  const deployTx = await funder.sendTransaction({
    to: SAFE_PROXY_FACTORY,
    data: deployData,
  });
  await deployTx.wait();
  const safe = predicted.address;
  if ((await provider.getCode(safe)) === "0x") {
    return { chain, status: "FAIL", detail: "no code at predicted Safe address" };
  }
  console.log(`  ✓ Safe deployed at predicted address`);

  // ---- 3. verify singleton migration + fallback handler + no modules ----
  const slot0 = await provider.getStorage(safe, "0x0");
  const singleton = getAddress("0x" + slot0.slice(-40));
  const expectedSingleton =
    forkChainId === 1 ? getAddress(SAFE_L1_SINGLETON) : getAddress(SAFE_L2_SINGLETON);
  if (singleton !== expectedSingleton) {
    return {
      chain,
      status: "FAIL",
      detail: `singleton ${singleton} != ${expectedSingleton}`,
    };
  }
  const slotFb = await provider.getStorage(safe, SLOT_FALLBACK_HANDLER);
  if (getAddress("0x" + slotFb.slice(-40)) !== getAddress(SAFE_FALLBACK_HANDLER)) {
    return { chain, status: "FAIL", detail: "fallback handler mismatch" };
  }
  const modRaw = await provider.call({
    to: safe,
    data: SAFE_IFACE.encodeFunctionData("getModulesPaginated", [
      "0x0000000000000000000000000000000000000001",
      10,
    ]),
  });
  const [modules] = SAFE_IFACE.decodeFunctionResult("getModulesPaginated", modRaw);
  if ((modules as string[]).length !== 0) {
    return { chain, status: "FAIL", detail: "unexpected modules enabled" };
  }
  console.log(`  ✓ SafeL2 singleton migrated, fallback handler set, 0 modules`);

  // ---- 4. Ownable2Step: transferOwnership from the real current owner ----
  const routerRead = OkuRouter__factory.connect(router, provider);
  const currentOwner = getAddress(await routerRead.owner());
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [currentOwner],
  });
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [currentOwner, toBeHex(parseEther("10"))],
  });
  const ownerSigner = await hre.ethers.getSigner(currentOwner);
  await (
    await OkuRouter__factory.connect(router, ownerSigner).transferOwnership(safe)
  ).wait();
  if (getAddress(await routerRead.pendingOwner()) !== getAddress(safe)) {
    return { chain, status: "FAIL", detail: "pendingOwner not set" };
  }
  // The key Ownable2Step property: owner is UNCHANGED until accept.
  if (getAddress(await routerRead.owner()) !== currentOwner) {
    return { chain, status: "FAIL", detail: "owner changed before acceptOwnership" };
  }
  console.log(`  ✓ transferOwnership set pendingOwner; owner() still ${currentOwner}`);

  // ---- 5. acceptOwnership as a SafeTx signed 2-of-3 ----
  const nonce0 = SAFE_IFACE.decodeFunctionResult(
    "nonce",
    await provider.call({ to: safe, data: SAFE_IFACE.encodeFunctionData("nonce") }),
  )[0] as bigint;

  const acceptTx = buildSafeTx({
    to: router,
    data: OkuRouter__factory.createInterface().encodeFunctionData("acceptOwnership"),
    nonce: nonce0,
  });
  const check = await verifySafeTxHashOnChain(provider, forkChainId, safe, acceptTx);
  if (!check.match) {
    return {
      chain,
      status: "FAIL",
      detail: `safeTxHash local ${check.local} != onchain ${check.onChain}`,
    };
  }
  console.log(`  ✓ safeTxHash matches Safe.getTransactionHash()`);

  const sign = async (w: Wallet | HDNodeWallet) => ({
    signer: getAddress(w.address),
    signature: await w.signTypedData(safeDomain(forkChainId, safe), SAFE_TX_TYPES, acceptTx),
  });
  // Deliberately sign with owners[1] and owners[0] in the "wrong" order to
  // prove packSignatures() sorts ascending as the contract requires.
  const sigs = [await sign(owners[1]), await sign(owners[0])];
  for (const s of sigs) {
    if (recoverSafeTxSigner(check.local, s.signature) !== s.signer) {
      return { chain, status: "FAIL", detail: "signature does not recover" };
    }
  }

  // ---- 8. threshold enforcement: one signature must fail ----
  const oneSig = packSignatures([sigs[0]]);
  let rejected = false;
  try {
    await provider.call({
      from: funder.address,
      to: safe,
      data: SAFE_IFACE.encodeFunctionData("execTransaction", [
        acceptTx.to,
        acceptTx.value,
        acceptTx.data,
        acceptTx.operation,
        acceptTx.safeTxGas,
        acceptTx.baseGas,
        acceptTx.gasPrice,
        acceptTx.gasToken,
        acceptTx.refundReceiver,
        oneSig,
      ]),
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    return { chain, status: "FAIL", detail: "1-of-3 signature was NOT rejected" };
  }
  console.log(`  ✓ single signature correctly rejected (threshold enforced)`);

  // Execute with 2 signatures, from a random relayer that is NOT an owner.
  const relayer = Wallet.createRandom().connect(provider);
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [relayer.address, toBeHex(parseEther("10"))],
  });
  const packed = packSignatures(sigs);
  await (
    await relayer.sendTransaction({
      to: safe,
      data: SAFE_IFACE.encodeFunctionData("execTransaction", [
        acceptTx.to,
        acceptTx.value,
        acceptTx.data,
        acceptTx.operation,
        acceptTx.safeTxGas,
        acceptTx.baseGas,
        acceptTx.gasPrice,
        acceptTx.gasToken,
        acceptTx.refundReceiver,
        packed,
      ]),
    })
  ).wait();

  if (getAddress(await routerRead.owner()) !== getAddress(safe)) {
    return { chain, status: "FAIL", detail: "Safe did not become owner" };
  }
  console.log(
    `  ✓ Safe now owns the router, executed by non-owner relayer ${relayer.address.slice(0, 12)}…`,
  );

  // ---- 7. MultiSend batch through the permissionless executor ----
  const iface = OkuRouter__factory.createInterface();
  const newSigner = getAddress(Wallet.createRandom().address);
  const nonce1 = SAFE_IFACE.decodeFunctionResult(
    "nonce",
    await provider.call({ to: safe, data: SAFE_IFACE.encodeFunctionData("nonce") }),
  )[0] as bigint;

  const batch = buildBatchedSafeTx(
    [
      { to: router, data: iface.encodeFunctionData("setMaxWarrantDuration", [600n]) },
      { to: router, data: iface.encodeFunctionData("updateValidSigner", [newSigner, true]) },
    ],
    nonce1,
  );
  if (batch.to !== getAddress(SAFE_MULTISEND_CALL_ONLY) || batch.operation !== 1) {
    return {
      chain,
      status: "FAIL",
      detail: `batch must DELEGATECALL MultiSendCallOnly, got to=${batch.to} op=${batch.operation}`,
    };
  }
  const batchCheck = await verifySafeTxHashOnChain(provider, forkChainId, safe, batch);
  if (!batchCheck.match) {
    return { chain, status: "FAIL", detail: "batch safeTxHash mismatch" };
  }
  const batchSigs = packSignatures([
    {
      signer: ownerAddrs[0],
      signature: await owners[0].signTypedData(
        safeDomain(forkChainId, safe),
        SAFE_TX_TYPES,
        batch,
      ),
    },
    {
      signer: ownerAddrs[2],
      signature: await owners[2].signTypedData(
        safeDomain(forkChainId, safe),
        SAFE_TX_TYPES,
        batch,
      ),
    },
  ]);
  await (
    await relayer.sendTransaction({
      to: safe,
      data: SAFE_IFACE.encodeFunctionData("execTransaction", [
        batch.to,
        batch.value,
        batch.data,
        batch.operation,
        batch.safeTxGas,
        batch.baseGas,
        batch.gasPrice,
        batch.gasToken,
        batch.refundReceiver,
        batchSigs,
      ]),
    })
  ).wait();

  const dur = await routerRead.maxWarrantDuration();
  const isValid = await routerRead.validSigners(newSigner);
  if (dur !== 600n || !isValid) {
    return {
      chain,
      status: "FAIL",
      detail: `batch did not apply (duration=${dur} validSigner=${isValid})`,
    };
  }
  console.log(
    `  ✓ 2-call MultiSend batch applied in ONE signature set ` +
      `(maxWarrantDuration=${dur}, validSigner set)`,
  );

  return { chain, status: "PASS", detail: `safe=${safe}` };
}

async function main() {
  console.log("\n" + "#".repeat(78));
  console.log("# SAFE MIGRATION FORK REHEARSAL");
  console.log("# Runs entirely on local Hardhat forks. No real transactions.");
  console.log("#".repeat(78));

  const results: Result[] = [];
  for (const chain of CHAINS) {
    try {
      results.push(await rehearse(chain));
    } catch (e) {
      const anyE = e as { shortMessage?: string; message?: string };
      console.log(`  ✗ ${anyE.shortMessage ?? anyE.message ?? e}`);
      results.push({
        chain,
        status: "ERROR",
        detail: String(anyE.shortMessage ?? anyE.message ?? e).slice(0, 90),
      });
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("REHEARSAL SUMMARY");
  console.log("=".repeat(78));
  for (const r of results) {
    console.log(`${r.chain.padEnd(12)}${r.status.padEnd(8)}${r.detail}`);
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL" || r.status === "ERROR").length;
  console.log("-".repeat(78));
  console.log(`PASS: ${pass}   FAIL: ${fail}   SKIP: ${results.length - pass - fail}`);
  if (fail > 0) process.exitCode = 1;
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
