/**
 * whitelistMarketRouters.ts
 *
 * One-off backfill: whitelist newly-confirmed aggregator market routers on the
 * already-deployed v2.0 OkuRouters, for entries that are present in
 * chain-config SOURCE (master) but not yet in the published
 * `@gfxlabs/oku-chains` package this repo installs. Because the on-chain
 * whitelist normally derives from the installed package's `marketRouters`,
 * these newly-added source entries would be missed until the package is
 * published + re-pinned -- so we whitelist them explicitly here.
 *
 * Entries below were determined authoritatively (aggregator APIs / official
 * deployment docs) and verified to have contract code on-chain:
 *   - celo      icecreamswap  0x911a744ab8eccB504173fBCAbBD7C34648F2A773
 *   - robinhood openocean     0x6352a56caadC4F1E25CD6c75970Fa768A3304e64
 *   - robinhood enso          0xCfBAa9Cfce952Ca4F4069874fF1Df8c05e37a3c7
 *   - robinhood fabric        0x3A7f029E3ad003AB5Aa78ccf101b1B543eaed6F9
 *
 * Idempotent + ownership-preflighted, mirroring whitelistUniswapRouters.ts.
 *
 * Usage:
 *   npx hardhat run scripts/whitelistMarketRouters.ts
 *   WHITELIST_DRY_RUN=1 npx hardhat run scripts/whitelistMarketRouters.ts
 *   WHITELIST_ONLY=celo npx hardhat run scripts/whitelistMarketRouters.ts
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { OkuRouter__factory } from "../typechain-types";
import { getCurrentEntry } from "../util/deploymentsRegistry";

const DRY_RUN = !!process.env.WHITELIST_DRY_RUN;
const ONLY = (process.env.WHITELIST_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Entry {
  network: string; // hardhat network name
  market: string;
  address: string;
}

const ENTRIES: Entry[] = [
  { network: "celo", market: "icecreamswap", address: "0x911a744ab8eccB504173fBCAbBD7C34648F2A773" },
  { network: "celo", market: "uniswap(swapRouter02)", address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" },
  { network: "robinhood", market: "openocean", address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64" },
  { network: "robinhood", market: "enso", address: "0xCfBAa9Cfce952Ca4F4069874fF1Df8c05e37a3c7" },
  { network: "robinhood", market: "fabric", address: "0x3A7f029E3ad003AB5Aa78ccf101b1B543eaed6F9" },
];

function resolveAccountKey(networkName: string): string | undefined {
  const netCfg = (hre.config.networks as any)[networkName];
  const accounts = netCfg?.accounts;
  const key = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof key !== "string") return undefined;
  if (/^0x?0{64}$/.test(key) || /^0{64}$/.test(key)) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

async function main() {
  let networks = Array.from(new Set(ENTRIES.map((e) => e.network)));
  if (ONLY.length) networks = networks.filter((n) => ONLY.includes(n));
  networks.sort();

  console.log(
    `\nWhitelisting market routers${DRY_RUN ? "  [DRY RUN — no txs will be sent]" : ""}`,
  );

  let problems = 0;
  for (const networkName of networks) {
    const entry = getCurrentEntry(networkName, "OkuRouter");
    console.log(`\n=== ${networkName} (router ${entry?.address ?? "MISSING"}) ===`);
    if (!entry?.address) {
      console.log("  NO_DEPLOYMENT — skipping");
      problems++;
      continue;
    }

    const netCfg = (hre.config.networks as any)[networkName];
    const rpcUrl: string | undefined = netCfg?.url;
    const accountKey = resolveAccountKey(networkName);
    if (!rpcUrl || !accountKey) {
      console.log(`  NO_RPC/KEY — url=${!!rpcUrl} key=${!!accountKey}`);
      problems++;
      continue;
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(accountKey, provider);
    const router = OkuRouter__factory.connect(entry.address, wallet);

    const owner = await router.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`  NOT_OWNER — owner()=${owner}, signer=${wallet.address}`);
      problems++;
      provider.destroy();
      continue;
    }

    const overrides: Record<string, unknown> = {};
    if (netCfg?.gasPrice !== undefined && netCfg.gasPrice !== "auto") {
      overrides.gasPrice = BigInt(netCfg.gasPrice);
    }

    for (const e of ENTRIES.filter((x) => x.network === networkName)) {
      const code = await provider.getCode(e.address);
      if (code === "0x") {
        console.log(`  ⚠ ${e.market} ${e.address} — NO CODE on chain, skipping`);
        problems++;
        continue;
      }
      const already = await router.swapTargets(e.address);
      if (already) {
        console.log(`  [already registered] ${e.market} ${e.address}`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`  [would add]          ${e.market} ${e.address}`);
        continue;
      }
      const tx = await router.updateSwapTargets(e.address, true, overrides);
      const receipt = await tx.wait();
      const ok = await router.swapTargets(e.address);
      if (!ok) {
        console.log(`  ✗ ${e.market} ${e.address} — post-write verify FALSE [tx ${receipt?.hash}]`);
        problems++;
      } else {
        console.log(`  ✓ ${e.market} ${e.address} [tx ${receipt?.hash}]`);
      }
    }

    provider.destroy();
  }

  console.log(
    problems === 0
      ? "\n✓ Done. No unresolved problems."
      : `\n⚠ Done with ${problems} problem(s) — review above.`,
  );
  if (problems > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
