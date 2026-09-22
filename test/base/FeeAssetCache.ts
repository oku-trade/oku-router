/**
 * FeeAssetCache.ts
 *
 * Offline tests for incremental fee-asset discovery. No network: the RPC is a
 * scripted fake, so the rules that decide WHERE THE NEXT SCAN RESUMES can be
 * exercised deterministically, including the failure modes a live chain only
 * produces occasionally.
 *
 * The bug this file exists to prevent
 * ----------------------------------
 * A refused eth_getLogs window does not abort a scan -- giving up would throw
 * away everything already discovered. But that leaves a hole. If the resume
 * point advanced past it anyway, those blocks would never be scanned by any
 * future run, and any asset first traded inside the hole would be invisible
 * forever: not reported by fees:scan, not swept by safe:build, silently
 * stranded on the router. Nothing on-chain would look wrong.
 *
 * So the invariant under test is: the persisted resume point is the highest
 * block with NO refusal below it, never simply the head of the chain.
 */
import { expect } from "chai";
import { getAddress } from "ethers";
import { scanLogWindow, toChecksum, type LogScanProvider } from "../../util/feeScan";
import {
  cacheUsable,
  clearCache,
  discoverFeeAssets,
  readCache,
  writeCache,
  type FeeAssetCacheEntry,
} from "../../util/feeAssetCache";
import { envPrefix, logsEnvVar } from "../../util/safeChains";

const ROUTER = getAddress("0xb1f3a7B816B0681188F54dFa400991B93ADf00ed");
const OTHER_ROUTER = getAddress("0x7B060A98BA242Ae42D6027a60937787eBe33DEBe");

const TOKEN_A = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN_B = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN_C = getAddress("0x3333333333333333333333333333333333333333");

/**
 * An OrderFilled log body. Only `tokenIn` -- the first non-indexed field --
 * is read, by slicing chars 26..65 of the data string, so the remaining five
 * words just need to be present.
 */
function orderFilledLog(token: string): { data: string } {
  const word = token.slice(2).toLowerCase().padStart(64, "0");
  return { data: `0x${word}${"0".repeat(64 * 5)}` };
}

interface FakeOptions {
  head: number;
  /** Largest block span the endpoint will accept, or 0 to refuse everything. */
  maxRange: number;
  /** block number -> tokens emitted in that block. */
  logs?: Record<number, string[]>;
  /** Refuse a scan window (probe calls are unaffected). */
  refuse?: (from: number, to: number) => boolean;
}

class FakeProvider {
  readonly probeCalls: [number, number][] = [];
  readonly scanCalls: [number, number][] = [];

  constructor(private readonly opts: FakeOptions) {}

  async getBlockNumber(): Promise<number> {
    return this.opts.head;
  }

  async getLogs(filter: {
    fromBlock: number;
    toBlock: number;
    topics?: unknown[];
  }): Promise<{ data: string }[]> {
    const { fromBlock, toBlock } = filter;
    const isProbe = !filter.topics;
    (isProbe ? this.probeCalls : this.scanCalls).push([fromBlock, toBlock]);

    if (this.opts.maxRange === 0) throw new Error("logs disabled");
    if (toBlock - fromBlock + 1 > this.opts.maxRange) {
      throw new Error("query returned more than 10000 results / range too wide");
    }
    if (!isProbe && this.opts.refuse?.(fromBlock, toBlock)) {
      throw new Error("-32005 limit exceeded");
    }

    const out: { data: string }[] = [];
    for (const [blockStr, tokens] of Object.entries(this.opts.logs ?? {})) {
      const b = Number(blockStr);
      if (b < fromBlock || b > toBlock) continue;
      for (const t of tokens) out.push(orderFilledLog(t));
    }
    return out;
  }

  asProvider(): LogScanProvider {
    return this as unknown as LogScanProvider;
  }
}

function chainFor(network: string) {
  return { network, chainId: 480, router: ROUTER };
}

describe("fee asset discovery cache", function () {
  const networks: string[] = [];

  function scratch(name: string): string {
    const n = `__test-${name}-${process.pid}`;
    networks.push(n);
    return n;
  }

  afterEach(function () {
    for (const n of networks.splice(0)) clearCache(n);
  });

  describe("scanLogWindow resume point", function () {
    it("reports the head when every window succeeds", async function () {
      const p = new FakeProvider({ head: 999, maxRange: 100, logs: { 50: [TOKEN_A] } });
      const r = await scanLogWindow(p.asProvider(), ROUTER, 0, 999, 100);

      expect(r.refusedWindows).to.equal(0);
      expect(r.scannedThrough).to.equal(999);
      expect([...r.tokens]).to.deep.equal([TOKEN_A]);
    });

    it("HOLDS the resume point at the last clean window when one is refused", async function () {
      // Refuse the window covering blocks 300-399. Everything above it still
      // gets scanned -- but the resume point must not move past 299, or those
      // 100 blocks are skipped by every future run.
      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 350: [TOKEN_B], 700: [TOKEN_C] },
        refuse: (from) => from === 300,
      });
      const r = await scanLogWindow(p.asProvider(), ROUTER, 0, 999, 100);

      expect(r.refusedWindows).to.equal(1);
      expect(r.scannedThrough).to.equal(299);
      // TOKEN_C was found above the hole and is kept; TOKEN_B was inside it.
      expect([...r.tokens]).to.deep.equal([TOKEN_C]);
    });

    it("reports no safe resume point when the very first window is refused", async function () {
      const p = new FakeProvider({ head: 999, maxRange: 100, refuse: (from) => from === 0 });
      const r = await scanLogWindow(p.asProvider(), ROUTER, 0, 999, 100);
      expect(r.scannedThrough).to.equal(null);
    });

    it("resumes from fromBlock-1 when a mid-history window is refused first", async function () {
      const p = new FakeProvider({ head: 999, maxRange: 100, refuse: (from) => from === 500 });
      const r = await scanLogWindow(p.asProvider(), ROUTER, 500, 999, 100);
      expect(r.scannedThrough).to.equal(499);
    });
  });

  describe("cold scan", function () {
    it("walks full history and records a complete interval", async function () {
      const net = scratch("cold");
      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 10: [TOKEN_A], 550: [TOKEN_B] },
      });

      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), {});

      expect(r.cacheHit).to.equal(false);
      expect(r.historyComplete).to.equal(true);
      expect([...r.tokens].sort()).to.deep.equal([TOKEN_A, TOKEN_B].sort());

      const entry = readCache(net)!;
      expect(entry.firstScannedBlock).to.equal(0);
      expect(entry.lastScannedBlock).to.equal(999);
      expect(entry.historyComplete).to.equal(true);
      expect(entry.router).to.equal(ROUTER);
    });

    it("does not persist a resume point past a hole", async function () {
      const net = scratch("hole");
      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 350: [TOKEN_B] },
        refuse: (from) => from === 300,
      });

      await discoverFeeAssets(p.asProvider(), chainFor(net), {});
      const entry = readCache(net)!;

      expect(entry.lastScannedBlock).to.equal(299);
      expect(entry.tokens).to.not.include(TOKEN_B);

      // A later clean run must re-walk the hole and recover the asset, rather
      // than resuming at the head and losing it permanently.
      const p2 = new FakeProvider({ head: 999, maxRange: 100, logs: { 350: [TOKEN_B] } });
      const r2 = await discoverFeeAssets(p2.asProvider(), chainFor(net), {});

      expect(r2.cacheHit).to.equal(true);
      expect([...r2.tokens]).to.include(TOKEN_B);
      expect(readCache(net)!.lastScannedBlock).to.equal(999);
      expect(readCache(net)!.historyComplete).to.equal(true);
    });
  });

  describe("incremental resume", function () {
    it("scans only new blocks on the second run and keeps prior tokens", async function () {
      const net = scratch("resume");
      const first = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      await discoverFeeAssets(first.asProvider(), chainFor(net), {});
      expect(first.scanCalls.length).to.equal(10);

      const second = new FakeProvider({
        head: 1099,
        maxRange: 100,
        logs: { 10: [TOKEN_A], 1050: [TOKEN_B] },
      });
      const r = await discoverFeeAssets(second.asProvider(), chainFor(net), {});

      // 1000..1099 is a single window: the 10 windows below it are not re-read.
      expect(second.scanCalls.length).to.equal(1);
      expect(second.scanCalls[0]).to.deep.equal([1000, 1099]);
      expect(r.cacheHit).to.equal(true);
      expect(r.forwardBlocks).to.equal(100);
      // TOKEN_A came from the cache, TOKEN_B from the new window.
      expect([...r.tokens].sort()).to.deep.equal([TOKEN_A, TOKEN_B].sort());
      expect(readCache(net)!.lastScannedBlock).to.equal(1099);
    });

    it("is a no-op scan when the chain has not advanced", async function () {
      const net = scratch("noop");
      const first = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      await discoverFeeAssets(first.asProvider(), chainFor(net), {});

      const second = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      const r = await discoverFeeAssets(second.asProvider(), chainFor(net), {});

      expect(second.scanCalls.length).to.equal(0);
      expect(r.forwardBlocks).to.equal(0);
      expect([...r.tokens]).to.deep.equal([TOKEN_A]);
    });
  });

  describe("budget and backfill", function () {
    it("truncates to recent history when the budget is too small, and says so", async function () {
      const net = scratch("budget");
      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 10: [TOKEN_A], 950: [TOKEN_B] },
      });

      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), { maxRequests: 2 });

      expect(r.historyComplete).to.equal(false);
      expect(r.coverage!.partial).to.equal(true);
      expect(r.coverage!.fromBlock).to.equal(800);
      expect([...r.tokens]).to.deep.equal([TOKEN_B]);
      expect([...r.tokens]).to.not.include(TOKEN_A);
    });

    it("extends coverage backward on later runs until history is complete", async function () {
      const net = scratch("backfill");
      const logs = { 10: [TOKEN_A], 450: [TOKEN_C], 950: [TOKEN_B] };

      // Run 1: budget covers only the top 200 blocks.
      await discoverFeeAssets(new FakeProvider({ head: 999, maxRange: 100, logs }).asProvider(), chainFor(net), {
        maxRequests: 2,
      });
      expect(readCache(net)!.firstScannedBlock).to.equal(800);

      // Run 2: chain has not moved, so the whole budget goes to backfill.
      const r2 = await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100, logs }).asProvider(),
        chainFor(net),
        { maxRequests: 4 },
      );
      expect(readCache(net)!.firstScannedBlock).to.equal(400);
      expect(r2.backfillBlocks).to.equal(400);
      expect([...r2.tokens].sort()).to.deep.equal([TOKEN_B, TOKEN_C].sort());

      // Run 3: reaches genesis and flips historyComplete.
      const r3 = await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100, logs }).asProvider(),
        chainFor(net),
        { maxRequests: 10 },
      );
      expect(r3.historyComplete).to.equal(true);
      expect(readCache(net)!.firstScannedBlock).to.equal(0);
      expect([...r3.tokens].sort()).to.deep.equal([TOKEN_A, TOKEN_B, TOKEN_C].sort());
    });

    it("does not extend backward through a refused backfill window", async function () {
      const net = scratch("backfill-refused");
      await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100 }).asProvider(),
        chainFor(net),
        { maxRequests: 2 },
      );
      expect(readCache(net)!.firstScannedBlock).to.equal(800);

      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 650: [TOKEN_C] },
        refuse: (from) => from === 600,
      });
      await discoverFeeAssets(p.asProvider(), chainFor(net), { maxRequests: 4 });

      // The window was holed, so the lower bound stays put and the range is
      // re-scanned next run. The token found alongside it is still kept.
      expect(readCache(net)!.firstScannedBlock).to.equal(800);
      expect(readCache(net)!.tokens).to.not.include(TOKEN_C);
    });
  });

  describe("invalidation", function () {
    it("rejects a cache recorded against a different router", function () {
      const entry: FeeAssetCacheEntry = {
        schemaVersion: 1,
        network: "x",
        chainId: 480,
        router: OTHER_ROUTER,
        firstScannedBlock: 0,
        lastScannedBlock: 500,
        historyComplete: true,
        rangeUsed: 100,
        tokens: [TOKEN_A],
        updatedAt: new Date().toISOString(),
      };
      expect(cacheUsable(entry, ROUTER, 999)).to.equal(false);
      expect(cacheUsable({ ...entry, router: ROUTER }, ROUTER, 999)).to.equal(true);
    });

    it("rejects a resume point ahead of the chain head", function () {
      // Almost always means the endpoint is pointed at the wrong network.
      // Resuming there would skip every block of real history.
      const entry: FeeAssetCacheEntry = {
        schemaVersion: 1,
        network: "x",
        chainId: 480,
        router: ROUTER,
        firstScannedBlock: 0,
        lastScannedBlock: 5_000_000,
        historyComplete: true,
        rangeUsed: 100,
        tokens: [],
        updatedAt: new Date().toISOString(),
      };
      expect(cacheUsable(entry, ROUTER, 999)).to.equal(false);
    });

    it("falls back to a cold scan when the router changed", async function () {
      const net = scratch("redeploy");
      writeCache({
        schemaVersion: 1,
        network: net,
        chainId: 480,
        router: OTHER_ROUTER,
        firstScannedBlock: 0,
        lastScannedBlock: 999,
        historyComplete: true,
        rangeUsed: 100,
        tokens: [TOKEN_C],
        updatedAt: new Date().toISOString(),
      });

      const p = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), {});

      expect(r.cacheHit).to.equal(false);
      expect(p.scanCalls.length).to.equal(10);
      // The old router's assets are not carried onto the new one.
      expect([...r.tokens]).to.deep.equal([TOKEN_A]);
      expect(readCache(net)!.router).to.equal(ROUTER);
    });

    it("treats a corrupt cache file as absent", async function () {
      const net = scratch("corrupt");
      writeCache({
        schemaVersion: 1,
        network: net,
        chainId: 480,
        router: ROUTER,
        // lastScannedBlock below firstScannedBlock is structurally impossible.
        firstScannedBlock: 900,
        lastScannedBlock: 100,
        historyComplete: false,
        rangeUsed: 100,
        tokens: [],
        updatedAt: new Date().toISOString(),
      });
      expect(readCache(net)).to.equal(undefined);

      const p = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), {});
      expect(r.cacheHit).to.equal(false);
      expect([...r.tokens]).to.deep.equal([TOKEN_A]);
    });
  });

  describe("endpoint refuses logs entirely", function () {
    it("returns previously-discovered assets rather than regressing to none", async function () {
      const net = scratch("nologs");
      await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } }).asProvider(),
        chainFor(net),
        {},
      );

      const dead = new FakeProvider({ head: 999, maxRange: 0 });
      const r = await discoverFeeAssets(dead.asProvider(), chainFor(net), {});

      // Cached entries are ADDRESSES, not balances: they stay valid even when
      // the endpoint can no longer serve logs. Balances are always re-read.
      expect(r.coverage).to.equal(null);
      expect([...r.tokens]).to.deep.equal([TOKEN_A]);
      // Nothing was learned, so the resume point must not move.
      expect(readCache(net)!.lastScannedBlock).to.equal(999);
    });

    it("yields nothing on a cold cache, and writes no resume point", async function () {
      const net = scratch("nologs-cold");
      const r = await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 0 }).asProvider(),
        chainFor(net),
        {},
      );
      expect(r.coverage).to.equal(null);
      expect(r.tokens.size).to.equal(0);
      expect(readCache(net)).to.equal(undefined);
    });
  });

  describe("--no-cache", function () {
    it("re-walks history from scratch", async function () {
      const net = scratch("nocache");
      await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } }).asProvider(),
        chainFor(net),
        {},
      );

      const p = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } });
      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), { useCache: false });

      expect(r.cacheHit).to.equal(false);
      expect(p.scanCalls.length).to.equal(10);
      expect(readCache(net)!.historyComplete).to.equal(true);
    });

    it("does NOT forget known assets a truncated re-scan cannot reach", async function () {
      // "Ignore the cache" must not mean "shrink the known asset list". An
      // address that once took a fee always did; dropping it here would let a
      // budget-limited re-scan quietly lose long-tail assets, which is the
      // exact failure the cache exists to prevent.
      const net = scratch("nocache-keep");
      await discoverFeeAssets(
        new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A] } }).asProvider(),
        chainFor(net),
        {},
      );

      const p = new FakeProvider({ head: 999, maxRange: 100, logs: { 10: [TOKEN_A], 950: [TOKEN_B] } });
      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), {
        useCache: false,
        maxRequests: 1,
      });

      expect(r.cacheHit).to.equal(false);
      expect(r.tokensBefore).to.equal(1);
      // Block 10 was outside the budget this run, but TOKEN_A survives.
      expect([...r.tokens].sort()).to.deep.equal([TOKEN_A, TOKEN_B].sort());
      expect(readCache(net)!.tokens).to.include(TOKEN_A);
    });
  });

  describe("address checksums", function () {
    // Rootstock uses EIP-1191, which mixes chainId into the checksum. ethers
    // implements EIP-55 only, so getAddress() rejects Rootstock's own USDC as
    // "bad address checksum". That threw out of priceAssets and took the
    // ENTIRE rootstock scan with it -- the chain reported as unreadable and
    // could never be swept, with nothing on-chain looking wrong.
    const RSK_USDC = "0x3A15461d8AE0f0Fb5fA2629e9dA7D66A794a6E37";

    it("accepts an address whose checksum is not EIP-55", function () {
      expect(() => getAddress(RSK_USDC)).to.throw(/checksum/i);
      expect(toChecksum(RSK_USDC)).to.equal(getAddress(RSK_USDC.toLowerCase()));
    });

    it("still rejects genuinely malformed addresses", function () {
      expect(toChecksum("0x1234")).to.equal(undefined);
      expect(toChecksum("not-an-address")).to.equal(undefined);
      expect(toChecksum("")).to.equal(undefined);
      expect(toChecksum(undefined)).to.equal(undefined);
    });

    it("keeps such an address in the discovery cache instead of dropping it", async function () {
      const net = scratch("eip1191");
      const p = new FakeProvider({
        head: 999,
        maxRange: 100,
        logs: { 10: [RSK_USDC] },
      });
      const r = await discoverFeeAssets(p.asProvider(), chainFor(net), {});
      expect([...r.tokens]).to.deep.equal([getAddress(RSK_USDC.toLowerCase())]);
      expect(readCache(net)!.tokens).to.have.lengthOf(1);
    });
  });

  describe("logs endpoint env vars", function () {
    it("shadows the _URL family exactly, including the arbitrum deviation", function () {
      // hardhat.config.ts reads ARB_URL for the `arbitrum` network, so the
      // logs override must be ARB_LOGS_URL -- not ARBITRUM_LOGS_URL, which
      // would be silently ignored.
      expect(envPrefix("arbitrum")).to.equal("ARB");
      expect(logsEnvVar("arbitrum")).to.equal("ARB_LOGS_URL");
      expect(logsEnvVar("op")).to.equal("OP_LOGS_URL");
      expect(logsEnvVar("avax")).to.equal("AVAX_LOGS_URL");
      expect(logsEnvVar("mainnet")).to.equal("MAINNET_LOGS_URL");
      expect(logsEnvVar("worldchain")).to.equal("WORLDCHAIN_LOGS_URL");
    });
  });
});
