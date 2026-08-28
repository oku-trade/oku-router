/**
 * verifyDeployments.ts
 *
 * Standalone verification sweep across every chain in deployments/*.json,
 * independent of @nomicfoundation/hardhat-verify's Etherscan V2-only
 * `apiKey` coupling (see the long comment in hardhat.config.ts's `etherscan`
 * block for why the built-in `verify:verify` task can't reach Blockscout /
 * Routescan / Teloscan / Alchemy-explorer chains as configured).
 *
 * This task hits each chain's "Etherscan-compatible" HTTP API directly:
 *   --check   GET  ?module=contract&action=getsourcecode  (no API key needed
 *             on Blockscout/Routescan; Etherscan V2 uses MAINNET_API_KEY)
 *   --submit  POST ?module=contract&action=verifysourcecode with the exact
 *             standard-JSON-input recorded in artifacts/build-info at
 *             deploy time, so the submitted source is byte-identical to
 *             what's on chain.
 *
 * Both modes skip Permit2Proxy entries (only OkuRouter is checked/verified
 * here) and any network passed via --skip (comma-separated).
 *
 * Usage:
 *   npx hardhat verify-deployments --check
 *   npx hardhat verify-deployments --submit --networks plasma,monad
 *   npx hardhat verify-deployments --check --skip filecoin,scroll
 */
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import { AbiCoder } from "ethers";
import { CONTRACT_NAME, CONTRACT_VERSION } from "../util/contractMeta";
import { NETWORK_CONFIGS } from "../util/deploymentConfig";

interface ExplorerConfig {
  /** Base URL for the Etherscan-compatible `api?module=...` endpoint. */
  apiUrl: string;
  /** Human explorer URL, for printing links only. */
  browserUrl: string;
  /** Etherscan V2 chains need `chainid` appended; others don't. */
  etherscanV2ChainId?: number;
  /** Any non-empty string works as apikey on most Blockscout/Routescan instances. */
  apiKey?: string;
}

// Deployment-network -> explorer routing. Deliberately NOT reusing
// hardhat.config.ts's `customChains` because that config is inert for
// non-Etherscan-V2 chains once `apiKey` is a plain string (see the comment
// there) -- this map is this task's own source of truth for HTTP routing.
const EXPLORERS: Record<string, ExplorerConfig> = {
  mainnet: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://etherscan.io", etherscanV2ChainId: 1 },
  op: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://optimistic.etherscan.io", etherscanV2ChainId: 10 },
  bsc: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://bscscan.com", etherscanV2ChainId: 56 },
  polygon: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://polygonscan.com", etherscanV2ChainId: 137 },
  base: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://basescan.org", etherscanV2ChainId: 8453 },
  arbitrum: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://arbiscan.io", etherscanV2ChainId: 42161 },
  linea: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://lineascan.build", etherscanV2ChainId: 59144 },
  avax: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://snowtrace.io", etherscanV2ChainId: 43114 },
  celo: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://celoscan.io", etherscanV2ChainId: 42220 },
  gnosis: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://gnosisscan.io", etherscanV2ChainId: 100 },
  worldchain: { apiUrl: "https://worldchain-mainnet.explorer.alchemy.com/api", browserUrl: "https://worldchain-mainnet.explorer.alchemy.com" },
  unichain: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://uniscan.xyz", etherscanV2ChainId: 130 },
  mantle: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://mantlescan.xyz", etherscanV2ChainId: 5000 },
  xdc: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://xdc.blocksscan.io", etherscanV2ChainId: 50 },
  boba: { apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/288/etherscan/api", browserUrl: "https://bobascan.com" },
  hemi: { apiUrl: "https://explorer.hemi.xyz/api", browserUrl: "https://explorer.hemi.xyz" },
  redbelly: { apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/151/etherscan/api", browserUrl: "https://redbelly.routescan.io" },
  rootstock: { apiUrl: "https://rootstock.blockscout.com/api", browserUrl: "https://rootstock.blockscout.com" },
  robinhood: { apiUrl: "https://robinhoodchain.blockscout.com/api", browserUrl: "https://robinhoodchain.blockscout.com" },
  bob: { apiUrl: "https://explorer.gobob.xyz/api", browserUrl: "https://explorer.gobob.xyz" },
  nibiru: { apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/6900/etherscan/api", browserUrl: "https://nibiscan.io" },
  // --- previously-unverified chains this sweep targets ---
  plasma: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://plasmascan.to", etherscanV2ChainId: 9745 },
  monad: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://monadscan.com", etherscanV2ChainId: 143 },
  hyperevm: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://hyperevmscan.io", etherscanV2ChainId: 999 },
  sei: { apiUrl: "https://api.etherscan.io/v2/api", browserUrl: "https://seitrace.com/pacific-1", etherscanV2ChainId: 1329 },
  telos: { apiUrl: "https://api.teloscan.io/api", browserUrl: "https://www.teloscan.io" },
  gensyn: { apiUrl: "https://gensyn-mainnet.explorer.alchemy.com/api", browserUrl: "https://gensyn-mainnet.explorer.alchemy.com" },
  etherlink: { apiUrl: "https://explorer.etherlink.com/api", browserUrl: "https://explorer.etherlink.com" },
  goat: { apiUrl: "https://explorer.goat.network/api", browserUrl: "https://explorer.goat.network" },
  zerog: { apiUrl: "https://chainscan.0g.ai/open/api", browserUrl: "https://chainscan.0g.ai" },
  saga: { apiUrl: "https://sagaevm.sagaexplorer.io/api", browserUrl: "https://sagaevm.sagaexplorer.io" },
  pharos: { apiUrl: "https://pharos.socialscan.io/api", browserUrl: "https://pharos.socialscan.io" },
  // Known blockers -- skipped by default via DEFAULT_SKIP below.
  filecoin: { apiUrl: "https://filecoin.blockscout.com/api", browserUrl: "https://filecoin.blockscout.com" },
  scroll: { apiUrl: "https://api.scrollscan.com/api", browserUrl: "https://scrollscan.com" },
};

// filecoin: explorer has a *different* contract's source attached at this
// address (mismatched verification, not just "unverified") -- needs a
// Blockscout support ticket, not a re-submit. scroll: scrollscan's API key
// is separate from Etherscan V2 and not provisioned; chain isn't in the V2
// chainlist either. Both documented in the report, not auto-attempted.
const DEFAULT_SKIP = new Set(["filecoin", "scroll"]);

function buildinArgs(): string {
  return process.env.MAINNET_API_KEY || "";
}

async function getSourceCode(explorer: ExplorerConfig, address: string): Promise<{ verified: boolean; contractName?: string; raw?: any; error?: string }> {
  const params = new URLSearchParams({ module: "contract", action: "getsourcecode", address });
  if (explorer.etherscanV2ChainId !== undefined) {
    params.set("chainid", String(explorer.etherscanV2ChainId));
    params.set("apikey", buildinArgs());
  }
  const url = `${explorer.apiUrl}?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { verified: false, error: `non-JSON response (${text.slice(0, 80).replace(/\s+/g, " ")})` };
    }
    if (typeof json.result === "string") {
      return { verified: false, error: json.result };
    }
    const entry = Array.isArray(json.result) ? json.result[0] : undefined;
    const hasSource = !!(entry && entry.SourceCode && entry.SourceCode.length > 0);
    return { verified: hasSource, contractName: entry?.ContractName, raw: entry };
  } catch (e: any) {
    return { verified: false, error: e.message };
  }
}

async function submitVerification(
  explorer: ExplorerConfig,
  address: string,
  standardJsonInput: object,
  constructorArgsNo0x: string,
): Promise<{ ok: boolean; message: string }> {
  const params = new URLSearchParams();
  params.set("module", "contract");
  params.set("action", "verifysourcecode");
  params.set("apikey", explorer.etherscanV2ChainId !== undefined ? buildinArgs() : "any");
  if (explorer.etherscanV2ChainId !== undefined) {
    params.set("chainid", String(explorer.etherscanV2ChainId));
  }
  params.set("contractaddress", address);
  params.set("sourceCode", JSON.stringify(standardJsonInput));
  params.set("codeformat", "solidity-standard-json-input");
  params.set("contractname", "contracts/OkuRouter.sol:OkuRouter");
  params.set("compilerversion", "v0.8.27+commit.40a35a09");
  params.set("constructorArguements", constructorArgsNo0x);

  const url = explorer.etherscanV2ChainId !== undefined ? `${explorer.apiUrl}?chainid=${explorer.etherscanV2ChainId}` : explorer.apiUrl;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, message: `non-JSON response (${text.slice(0, 120).replace(/\s+/g, " ")})` };
    }
    if (json.status === "1") {
      return { ok: true, message: `submitted, guid=${json.result}` };
    }
    return { ok: false, message: String(json.result ?? json.message ?? "unknown error") };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

task("verify-deployments", "Check or submit OkuRouter verification across every deployed chain")
  .addFlag("check", "Query each explorer and report verified/unverified")
  .addFlag("submit", "Submit source for verification on unverified chains")
  .addOptionalParam("networks", "Comma-separated list of networks to restrict to")
  .addOptionalParam("skip", "Comma-separated list of networks to skip (default: filecoin,scroll)")
  .setAction(async (taskArgs, hre) => {
    const deploymentsDir = path.resolve(__dirname, "..", "deployments");
    const files = fs.readdirSync(deploymentsDir).filter((f) => f.endsWith(".json"));

    const skip = new Set<string>(taskArgs.skip ? taskArgs.skip.split(",") : DEFAULT_SKIP);
    const only = taskArgs.networks ? new Set<string>(taskArgs.networks.split(",")) : undefined;

    let buildInfo: any;
    if (taskArgs.submit) {
      const buildInfoDir = path.resolve(__dirname, "..", "artifacts", "build-info");
      const biFiles = fs.readdirSync(buildInfoDir).filter((f) => f.endsWith(".json"));
      if (biFiles.length !== 1) {
        console.warn(`⚠ Expected exactly one build-info file, found ${biFiles.length}: ${biFiles.join(", ")}. Using the first.`);
      }
      buildInfo = JSON.parse(fs.readFileSync(path.join(buildInfoDir, biFiles[0]), "utf8"));
    }

    const results: { network: string; chainId: number; address: string; status: string }[] = [];

    for (const file of files) {
      const reg = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), "utf8"));
      const network = reg.networkName as string;
      const chainId = reg.chainId as number;
      const okuRouter = reg.current?.OkuRouter;
      if (!okuRouter) continue;
      if (skip.has(network)) {
        results.push({ network, chainId, address: okuRouter.address, status: "SKIPPED" });
        continue;
      }
      if (only && !only.has(network)) continue;

      const explorer = EXPLORERS[network];
      if (!explorer) {
        results.push({ network, chainId, address: okuRouter.address, status: "NO_EXPLORER_CONFIG" });
        continue;
      }

      // Etherscan V2 enforces a shared 3 req/sec cap across ALL chainids
      // under one API key -- space every explorer call out regardless of
      // which explorer it targets, since most calls in this loop hit V2.
      await new Promise((r) => setTimeout(r, 400));
      const check = await getSourceCode(explorer, okuRouter.address);
      if (check.verified) {
        const nameMatches = check.contractName === "OkuRouter";
        results.push({
          network,
          chainId,
          address: okuRouter.address,
          status: nameMatches ? "VERIFIED" : `MISMATCH(${check.contractName})`,
        });
        continue;
      }

      if (!taskArgs.submit) {
        results.push({ network, chainId, address: okuRouter.address, status: `UNVERIFIED (${check.error ?? "no source"})` });
        continue;
      }

      // --submit path: attempt verification.
      const cfg = NETWORK_CONFIGS[network];
      const permit2 = cfg?.permit2Address;
      if (!permit2) {
        results.push({ network, chainId, address: okuRouter.address, status: "SUBMIT_SKIPPED (no permit2 in config)" });
        continue;
      }
      const constructorArgs = AbiCoder.defaultAbiCoder()
        .encode(["string", "string", "address", "address"], [CONTRACT_NAME, CONTRACT_VERSION, okuRouter.owner, permit2])
        .slice(2);

      const submitResult = await submitVerification(explorer, okuRouter.address, buildInfo.input, constructorArgs);
      results.push({
        network,
        chainId,
        address: okuRouter.address,
        status: submitResult.ok ? `SUBMITTED (${submitResult.message})` : `SUBMIT_FAILED (${submitResult.message})`,
      });

      // Be polite to shared explorer infra.
      await new Promise((r) => setTimeout(r, 1500));
    }

    const widest = Math.max(...results.map((r) => r.network.length), 10);
    console.log("");
    console.log(`${"network".padEnd(widest)}  chainId    status`);
    console.log(`${"-".repeat(widest)}  -------    ------`);
    for (const r of results) {
      console.log(`${r.network.padEnd(widest)}  ${String(r.chainId).padEnd(9)}  ${r.status}`);
    }
    console.log("");
  });
