/**
 * Predict deterministic CREATE2 addresses across every supported chain.
 *
 * Pure math -- no RPC calls, no signer. Use it before a multi-chain deploy to
 * confirm which chains share an address and which do not.
 *
 * IMPORTANT -- why chains do NOT all share one address: the OkuRouter
 * constructor takes `permit2` as its fourth argument, so the init code (and
 * therefore the CREATE2 address) differs on any chain whose Permit2 is not at
 * the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`. An earlier
 * version of this task passed `ZeroAddress` for that argument, which made it
 * report one identical address for all 34 chains -- an address that is
 * deployed nowhere. Anyone checking parity against a live deployment would
 * have concluded the deployment was wrong. The prediction must use each
 * chain's real Permit2, which is what the deploy task does.
 *
 * Usage:
 *   npx hardhat predict-all --owner 0x<addr>
 *   npx hardhat predict-all --owner 0x<addr> --contract permit2proxy
 *   npx hardhat predict-all --owner 0x<addr> --verify
 */
import { task } from "hardhat/config";
import { AbiCoder, concat, keccak256 } from "ethers";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  SAFE_SINGLETON_FACTORY,
  computeCreate2Address,
  getOkuRouterSalt,
  getPermit2ProxySalt,
} from "../util/contractMeta";
import { NETWORK_CONFIGS, getSupportedNetworks } from "../util/deploymentConfig";
import { getCurrentAddress } from "../util/deploymentsRegistry";

/** Placeholder owner, clearly not a real deployer, for hypothetical runs. */
const SENTINEL_OWNER = "0x0000000000000000000000000000000000000001";

task("predict-all", "Predict deterministic addresses for all chains")
  .addOptionalParam("owner", "Owner passed to the OkuRouter constructor")
  .addOptionalParam("contract", "okurouter | permit2proxy (default: okurouter)")
  .addFlag("verify", "Compare predictions against deployments/*.json")
  .setAction(async (taskArgs, hre) => {
    const which = String(taskArgs.contract ?? "okurouter").toLowerCase();
    if (which !== "okurouter" && which !== "permit2proxy") {
      throw new Error(`--contract must be okurouter or permit2proxy, got "${which}"`);
    }
    const owner = taskArgs.owner ?? SENTINEL_OWNER;
    const networks = getSupportedNetworks();
    const widest = Math.max(...networks.map((n) => n.length));

    console.log(`\nPredicting ${which === "okurouter" ? `OkuRouter v${CONTRACT_VERSION}` : "Permit2Proxy"} addresses`);
    if (which === "okurouter") {
      console.log(`Owner (constructor arg): ${owner}`);
      if (owner === SENTINEL_OWNER) {
        console.log("  (placeholder -- pass --owner for a real prediction)");
      }
      console.log(`Salt: ${getOkuRouterSalt()}`);
    }
    console.log("");

    const routerFactory = await hre.ethers.getContractFactory("OkuRouter");
    const routerCreationCode = (await routerFactory.getDeployTransaction(
      CONTRACT_NAME,
      CONTRACT_VERSION,
      owner,
      hre.ethers.ZeroAddress,
    )).data;
    if (!routerCreationCode) throw new Error("failed to build OkuRouter init code");
    // Strip the encoded constructor args so they can be re-encoded per chain
    // with that chain's Permit2.
    const argLen = AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "address", "address"],
      [CONTRACT_NAME, CONTRACT_VERSION, owner, hre.ethers.ZeroAddress],
    ).length - 2;
    const routerBytecode = routerCreationCode.slice(0, routerCreationCode.length - argLen);

    const proxyFactory = await hre.ethers.getContractFactory("Permit2Proxy");

    const rows: { network: string; chainId: number; factory: boolean; predicted: string; actual?: string }[] = [];
    for (const name of networks) {
      const cfg = NETWORK_CONFIGS[name];
      let predicted: string;

      if (which === "okurouter") {
        const args = AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "address", "address"],
          [CONTRACT_NAME, CONTRACT_VERSION, owner, cfg.permit2Address],
        );
        predicted = computeCreate2Address(
          SAFE_SINGLETON_FACTORY,
          getOkuRouterSalt(),
          keccak256(concat([routerBytecode, args])),
        );
      } else {
        // Permit2Proxy's init code and salt both bind to the router address,
        // so a chain with no router yet has no predictable proxy address.
        const router = getCurrentAddress(name, "OkuRouter");
        if (!router) continue;
        const tx = await proxyFactory.getDeployTransaction(router);
        if (!tx.data) throw new Error(`failed to build Permit2Proxy init code for ${name}`);
        predicted = computeCreate2Address(
          SAFE_SINGLETON_FACTORY,
          getPermit2ProxySalt(router),
          keccak256(tx.data),
        );
      }

      rows.push({
        network: name,
        chainId: cfg.chainId,
        factory: !!cfg.create2FactoryAddress,
        predicted,
        actual: taskArgs.verify
          ? getCurrentAddress(name, which === "okurouter" ? "OkuRouter" : "Permit2Proxy")
          : undefined,
      });
    }

    const header = `${"network".padEnd(widest)}  chainId   factory  predictedAddress`;
    console.log(taskArgs.verify ? `${header}  registry` : header);
    console.log("-".repeat(taskArgs.verify ? widest + 100 : widest + 62));
    let mismatches = 0;
    for (const r of rows) {
      let suffix = "";
      if (taskArgs.verify) {
        if (!r.actual) suffix = "  (not deployed)";
        else if (r.actual.toLowerCase() === r.predicted.toLowerCase()) suffix = "  MATCH";
        else if (which === "permit2proxy") {
          // Permit2Proxy defaults to a plain nonce-based deploy (CREATE2 is
          // opt-in via --deterministic), so a live address that differs from
          // the CREATE2 prediction is the NORMAL case, not a fault. Calling
          // it a mismatch would train the operator to ignore this check.
          suffix = `  nonce-deployed at ${r.actual}`;
        } else {
          suffix = `  MISMATCH ${r.actual}`;
          mismatches++;
        }
      }
      console.log(
        `${r.network.padEnd(widest)}  ${String(r.chainId).padEnd(7)}   ${r.factory ? "yes" : "NO "}      ${r.predicted}${suffix}`,
      );
    }

    // Group so the operator sees the real parity picture at a glance rather
    // than inferring it from 34 lines.
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const g = groups.get(r.predicted) ?? [];
      g.push(r.network);
      groups.set(r.predicted, g);
    }
    console.log("");
    console.log(`Distinct addresses: ${groups.size} across ${rows.length} chain(s)`);
    for (const [addr, nets] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${addr}  x${nets.length}  ${nets.join(", ")}`);
    }
    if (groups.size > 1) {
      console.log(
        "\nAddresses differ where a chain's Permit2 is not the canonical one -- that is\n" +
          "expected, because Permit2 is a constructor argument and therefore part of the\n" +
          "CREATE2 preimage.",
      );
    }

    const noFactory = rows.filter((r) => !r.factory).map((r) => r.network);
    if (noFactory.length) {
      console.log(
        `\nNo Safe Singleton Factory (deterministic deploy will fail): ${noFactory.join(", ")}`,
      );
    }
    if (taskArgs.verify) {
      if (which === "permit2proxy") {
        console.log(
          "\nPermit2Proxy is deployed nonce-based by default, so a live address that\n" +
            "differs from the CREATE2 prediction above is expected, not an error.",
        );
      } else {
        console.log(
          mismatches === 0
            ? "\nAll deployed addresses match their prediction."
            : `\n${mismatches} chain(s) MISMATCH the registry.`,
        );
        if (mismatches) process.exitCode = 1;
      }
    }
  });
