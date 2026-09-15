/**
 * fees:scan
 *
 * Read-only report of idle protocol fees sitting on the OkuRouter of each
 * chain. Sends no transactions and needs no key.
 *
 * This exists because the router has no fee accounting of any kind: there is
 * no `collectableFees()` view, no per-token mapping, nothing. Fees are simply
 * the contract's own balance, so the only way to know what is there is to
 * discover which assets have flowed through and read each balance. See
 * util/feeScan.ts for the discovery rules.
 *
 * Two distinct totals are printed and they are NOT interchangeable:
 *   - notional   : spot price x balance, summed.
 *   - realizable : the same, but each asset capped at a fraction of its pool
 *                  depth. Long-tail tokens routinely quote a real-looking
 *                  price against a pool with no quote liquidity, so notional
 *                  overstates badly. Make decisions on realizable.
 *
 * Usage:
 *   npx hardhat fees:scan
 *   npx hardhat fees:scan --networks worldchain
 *   npx hardhat fees:scan --networks worldchain --json out.json
 *   npx hardhat fees:scan --networks mainnet,op --no-price
 */
import * as fs from "fs";
import { task } from "hardhat/config";
import { listSafeChains, makeProvider, mapLimit, pad } from "../util/safeChains";
import { NETWORK_CONFIGS } from "../util/deploymentConfig";
import {
  NATIVE_SENTINEL,
  fmtAmount,
  scanChainFees,
  totalUsd,
  type FeeScanResult,
} from "../util/feeScan";

function usd(n: number | undefined): string {
  if (n === undefined) return "     -";
  return `$${n.toFixed(2)}`;
}

task("fees:scan", "Report idle protocol fees held by each OkuRouter")
  .addOptionalParam("networks", "Comma-separated hardhat network names")
  .addOptionalParam("json", "Write the full result to this path as JSON")
  .addOptionalParam("maxRequests", "Per-chain eth_getLogs request budget (default 400)")
  .addOptionalParam(
    "rpc",
    "Override RPC URL (requires a single --networks entry). Needed when the " +
      "configured endpoint restricts eth_getLogs, which blocks long-tail asset discovery.",
  )
  .addFlag("noPrice", "Skip USD valuation (much faster)")
  .setAction(async (args, hre) => {
    const only = args.networks
      ? new Set(String(args.networks).split(",").map((s: string) => s.trim()))
      : undefined;
    const maxRequests = args.maxRequests ? Number(args.maxRequests) : undefined;
    const chains = listSafeChains(hre, only).filter((c) => c.router);

    if (args.rpc && chains.length !== 1) {
      throw new Error(
        `--rpc applies to one chain, but ${chains.length} were selected. ` +
          `Pass --networks <single network> alongside --rpc.`,
      );
    }

    if (chains.length === 0) {
      console.log("No chains matched (or none have an OkuRouter in deployments/).");
      return;
    }

    console.log(`\nScanning idle fees on ${chains.length} chain(s)...\n`);

    const results = await mapLimit(chains, 4, async (chain) => {
      const rpc = args.rpc ? String(args.rpc) : chain.rpcUrl;
      if (!rpc) {
        return { chain: chain.network, chainId: chain.chainId, error: "NO_RPC" as const };
      }
      const cfg = NETWORK_CONFIGS[chain.network];
      if (!cfg) {
        return { chain: chain.network, chainId: chain.chainId, error: "NO_NETWORK_CONFIG" as const };
      }
      const provider = makeProvider(rpc, chain.chainId);
      try {
        const res = await scanChainFees(provider, cfg, chain.router!, {
          maxRequests,
          price: !args.noPrice,
        });
        return { chain: chain.network, chainId: chain.chainId, result: res };
      } catch (e) {
        return {
          chain: chain.network,
          chainId: chain.chainId,
          error: String((e as { message?: string }).message ?? e).slice(0, 90),
        };
      } finally {
        provider.destroy();
      }
    });

    let grandNotional = 0;
    let grandRealizable = 0;
    const jsonOut: Record<string, unknown> = {};

    for (const r of results) {
      if ("error" in r && r.error) {
        console.log(`=== ${r.chain} (${r.chainId})  --  ${r.error}`);
        continue;
      }
      const res = (r as { result: FeeScanResult }).result;
      const { notional, realizable } = totalUsd(res.assets);
      grandNotional += notional;
      grandRealizable += realizable;

      console.log(
        `=== ${r.chain} (${r.chainId})  router ${res.router}  ` +
          `${res.assets.length} asset(s)  notional ${usd(notional)}  realizable ${usd(realizable)}`,
      );
      if (res.coverage) {
        console.log(
          `    scan: blocks ${res.coverage.fromBlock}-${res.coverage.toBlock} ` +
            `(range ${res.coverage.rangeUsed}${res.coverage.partial ? ", PARTIAL" : ", full"}), ` +
            `${res.coverage.events} OrderFilled, ${res.coverage.everSeen} assets ever seen`,
        );
      }
      if (res.assets.length) {
        console.log(
          `    ${pad("symbol", 12)}${pad("amount", 26)}${pad("usd", 12)}${pad("depth", 12)}address`,
        );
      }
      for (const a of res.assets) {
        console.log(
          `    ${pad(a.symbol.slice(0, 11), 12)}${pad(fmtAmount(a), 26)}` +
            `${pad(usd(a.usdValue), 12)}${pad(usd(a.poolDepthUsd), 12)}` +
            `${a.token === NATIVE_SENTINEL ? "(native)" : a.token}`,
        );
      }
      for (const w of res.warnings) console.log(`    ! ${w}`);
      console.log("");

      jsonOut[r.chain] = {
        chainId: r.chainId,
        router: res.router,
        coverage: res.coverage,
        warnings: res.warnings,
        totals: { usdNotional: notional, usdRealizable: realizable },
        assets: res.assets.map((a) => ({
          token: a.token,
          symbol: a.symbol,
          decimals: a.decimals,
          amountRaw: a.balance.toString(),
          amount: fmtAmount(a),
          usdPrice: a.usdPrice,
          usdValue: a.usdValue,
          poolDepthUsd: a.poolDepthUsd,
          realizableUsd: a.realizableUsd,
          priceSource: a.priceSource,
        })),
      };
    }

    console.log("-".repeat(92));
    console.log(
      `TOTAL across ${results.length} chain(s):  notional ${usd(grandNotional)}   ` +
        `realizable ${usd(grandRealizable)}`,
    );
    console.log(
      "Notional is spot x balance and overstates long-tail tokens; realizable caps each\n" +
        "asset at a fraction of its pool depth. Decide on realizable.",
    );

    if (args.json) {
      fs.writeFileSync(String(args.json), `${JSON.stringify(jsonOut, null, 2)}\n`, "utf8");
      console.log(`\nJSON written: ${args.json}`);
    }
  });
