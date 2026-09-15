/**
 * serve.js
 *
 * Tiny static server for the Safe batch signing page. Run with:
 *   npm run sign-page                 # default port 8547
 *   PORT=9000 npm run sign-page
 *
 * Why this exists rather than `python3 -m http.server`
 * ---------------------------------------------------
 *   1. It prints the exact URL of every generated sign.html, so there is no
 *      guessing at paths after `safe:sign-page`.
 *   2. It binds 127.0.0.1 only. `python3 -m http.server` binds 0.0.0.0, which
 *      publishes safe-bundles/ to the entire local network -- and a bundle
 *      that has collected `threshold` signatures is a bearer authorization
 *      anyone can execute. Loopback-only is the correct default here.
 *   3. No Python dependency, no npm dependency: plain node http + fs.
 *
 * It serves safe-bundles/ and nothing above it. The repo root is deliberately
 * NOT served, because it contains .env with a live deployer key.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
let recoverAddress, getAddress, Signature;
try {
  ({ recoverAddress, getAddress, Signature } = require("ethers"));
} catch {
  console.error(
    "\nDependencies are not installed. Run this first:\n\n  npm install\n",
  );
  process.exit(1);
}
const { readSidecars, bundleStatus, buildSignPage } = require("./buildPage");

const ROOT = path.resolve(__dirname, "..", "..", "safe-bundles");
const PORT = Number(process.env.PORT || 8547);
const HOST = "127.0.0.1";

/** Max accepted POST body. A single signature record is ~250 bytes. */
const MAX_BODY = 8 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Bring safe-bundles/ into the state a signer expects, at startup.
 *
 * This exists because `sign.html` is a generated artifact and therefore
 * gitignored, which produced two failure modes for anyone but the author:
 *
 *   1. A `git pull` delivers a new bundle JSON but NOT its page, so the
 *      server listed nothing for it and the signer had no link to open.
 *   2. Deleting a stale page locally does not propagate, so a co-worker kept
 *      being served an old, already-executed bundle -- 32 wasted device
 *      confirmations if they had signed it, since those nonces are spent.
 *
 * So: generate a page for every bundle that still needs signatures, and
 * remove pages that are complete or orphaned. Signature sidecars are never
 * touched. The intended workflow is now: start the server, open the printed
 * link, sign, send the file.
 */
function syncPages() {
  const generated = [];
  const removed = [];
  const complete = [];
  if (!fs.existsSync(ROOT)) return { generated, removed, complete, pages: [] };

  const template = path.join(__dirname, "index.html");
  const templateHtml = fs.existsSync(template)
    ? fs.readFileSync(template, "utf8")
    : null;

  const bundles = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  for (const name of bundles) {
    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), "utf8"));
      if (!bundle || !Array.isArray(bundle.chains) || !bundle.safe) continue;
    } catch {
      continue;
    }
    const pagePath = path.join(ROOT, name, "sign.html");
    const status = bundleStatus(bundle, readSidecars(ROOT, name));

    if (status.complete) {
      // Nothing left to sign. Remove the page so it cannot be opened by
      // mistake; keep the bundle and its sidecars.
      if (fs.existsSync(pagePath)) {
        fs.rmSync(pagePath);
        removed.push(`${name} (all ${status.total} chain(s) already signed)`);
      }
      complete.push(name);
      continue;
    }
    if (!templateHtml) continue;
    fs.mkdirSync(path.join(ROOT, name), { recursive: true });
    const html = buildSignPage(templateHtml, bundle, readSidecars(ROOT, name));
    const existing = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, "utf8") : null;
    if (existing !== html) {
      fs.writeFileSync(pagePath, html, "utf8");
      generated.push(name);
    }
  }

  // Orphaned pages: a directory with a sign.html but no matching bundle
  // JSON, e.g. after a bundle was superseded and deleted upstream.
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pagePath = path.join(ROOT, entry.name, "sign.html");
    if (!fs.existsSync(pagePath)) continue;
    if (bundles.includes(entry.name)) continue;
    fs.rmSync(pagePath);
    removed.push(`${entry.name} (no matching bundle -- superseded or deleted)`);
  }

  return { generated, removed, complete, pages: findSignPages() };
}

function findSignPages() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(ROOT, entry.name, "sign.html");
    if (fs.existsSync(p)) out.push(entry.name);
  }
  return out.sort();
}

/**
 * Summarise progress for a bundle.
 *
 * Signatures must be counted from the per-signer sidecars, not from
 * `bundle.signatures` -- the bundle is deliberately kept signature-free so it
 * can be committed, so reading it always reported 0 collected even after
 * every signer had finished. That was actively misleading: a signer could
 * complete all 32 chains and still be told nothing had been collected.
 */
function bundleSummary(name) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), "utf8"));
    const s = bundleStatus(b, readSidecars(ROOT, name));
    return (
      `${s.total} chain(s), ${s.sigs} signature(s) collected, ` +
      `${s.ready}/${s.total} ready to execute`
    );
  } catch {
    return null;
  }
}

/** True only for genuine loopback peers. */
function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/**
 * Reject cross-origin callers.
 *
 * A local HTTP server is reachable from any page in the user's browser, and
 * DNS rebinding lets a remote site resolve its own hostname to 127.0.0.1 and
 * then talk to us. Binding loopback is therefore not sufficient for a write
 * endpoint: we also require that the request either carries no Origin (a
 * direct curl) or an Origin that is exactly our own.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  const allowed = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
  if (origin && !allowed.includes(origin)) return false;
  const host = req.headers.host;
  if (host && !allowed.some((a) => a.endsWith(host))) return false;
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Resolve a bundle name to its JSON path, refusing anything path-like. */
function bundleJsonPath(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("invalid bundle name");
  }
  const p = path.join(ROOT, `${name}.json`);
  const resolved = path.resolve(p);
  if (!resolved.startsWith(ROOT + path.sep)) throw new Error("invalid bundle name");
  if (!fs.existsSync(resolved)) throw new Error(`bundle not found: ${name}`);
  return resolved;
}

/**
 * Verify and persist one signature.
 *
 * The signature is recovered and checked against the bundle's owner list
 * before it is written -- the same validation `safe:sign --import` performs,
 * done here so a signer using the wrong account finds out on their first
 * device confirmation instead of after all 32.
 *
 * Output goes to safe-bundles/<bundle>/signatures-<signer>.json, never into
 * the bundle itself: the bundle stays the authoritative record and
 * `safe:sign --import` remains the single merge path.
 */
function persistSignature(payload) {
  const { bundle: name, safeTxHash, signer, signature } = payload || {};
  const bundle = JSON.parse(fs.readFileSync(bundleJsonPath(name), "utf8"));

  if (typeof safeTxHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) {
    throw new Error("malformed safeTxHash");
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("malformed signature (expected 65 bytes hex)");
  }
  const chain = bundle.chains.find(
    (c) => c.safeTxHash.toLowerCase() === safeTxHash.toLowerCase(),
  );
  if (!chain) throw new Error(`safeTxHash not present in bundle ${name}`);

  // Cryptographic verification -- the claimed signer is not trusted.
  let recovered;
  try {
    recovered = getAddress(recoverAddress(safeTxHash, Signature.from(signature)));
  } catch {
    throw new Error("signature could not be recovered");
  }
  const owners = bundle.owners.map((o) => getAddress(o));
  if (!owners.includes(recovered)) {
    throw new Error(
      `signature recovers to ${recovered}, which is not a Safe owner`,
    );
  }
  if (signer && getAddress(signer) !== recovered) {
    throw new Error(
      `claimed signer ${getAddress(signer)} but signature recovers to ${recovered}`,
    );
  }

  const outDir = path.join(ROOT, name);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `signatures-${recovered}.json`);

  let existing = [];
  if (fs.existsSync(outFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  const dup = existing.some(
    (e) =>
      String(e.safeTxHash).toLowerCase() === safeTxHash.toLowerCase() &&
      getAddress(e.signer) === recovered,
  );
  if (!dup) {
    existing.push({ safeTxHash, signer: recovered, signature });
    const tmp = `${outFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, outFile);
  }

  return {
    ok: true,
    duplicate: dup,
    network: chain.network,
    signer: recovered,
    saved: existing.length,
    total: bundle.chains.length,
    file: path.relative(path.resolve(__dirname, "..", ".."), outFile),
  };
}

const server = http.createServer((req, res) => {
  // ---- signature autosave endpoint ----
  if (req.url && req.url.split("?")[0] === "/api/signature") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: "POST only" }));
      return;
    }
    if (!isLoopback(req) || !originAllowed(req)) {
      res.writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: "forbidden origin" }));
      return;
    }
    readBody(req)
      .then((raw) => {
        const result = persistSignature(JSON.parse(raw));
        console.log(
          `  ${result.duplicate ? "· already saved" : "✓ saved"}  ` +
            `${result.network.padEnd(12)} ${result.signer}  ` +
            `[${result.saved}/${result.total}]  -> ${result.file}`,
        );
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
      })
      .catch((e) => {
        console.log(`  ✗ rejected signature: ${e.message}`);
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  // Resolve inside ROOT and reject anything that escapes it.
  const resolved = path.resolve(ROOT, "." + urlPath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let target = resolved;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, "sign.html");
    target = fs.existsSync(index) ? index : path.join(target, "index.html");
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }

  const body = fs.readFileSync(target);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
    // The page needs no framing, and should not leak paths to third parties.
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use. Either stop the other server or run:\n` +
        `  PORT=8548 npm run sign-page\n`,
    );
  } else {
    console.error(`\nserver error: ${e.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Generate pages for anything that still needs signing and remove pages
  // that are complete or orphaned, so the links printed below are exactly
  // the work outstanding -- nothing stale, nothing missing.
  const sync = syncPages();
  const pages = sync.pages;
  const bar = "=".repeat(72);
  console.log(`\n${bar}`);
  console.log("Safe batch signing page");
  console.log(bar);
  console.log(`serving   ${ROOT}`);
  console.log(`bound to  http://${HOST}:${PORT}  (loopback only -- not exposed to your LAN)`);

  if (sync.generated.length) {
    console.log(`\nprepared  ${sync.generated.join(", ")}`);
  }
  for (const r of sync.removed) {
    console.log(`removed   ${r}`);
  }
  if (sync.complete.length) {
    console.log(`complete  ${sync.complete.join(", ")}  (nothing left to sign)`);
  }

  if (pages.length === 0) {
    console.log(`\nNothing to sign -- every bundle in safe-bundles/ is already at`);
    console.log(`its signature threshold, or there are no bundles yet.`);
    console.log(`\nIf you expected work here, pull the latest bundle first:`);
    console.log(`  git pull oku master\n`);
  } else {
    console.log(`\nOpen:`);
    for (const name of pages) {
      console.log(`\n  http://${HOST}:${PORT}/${name}/sign.html`);
      const summary = bundleSummary(name);
      if (summary) console.log(`      ${summary}`);
    }
    console.log(
      `\nUse this URL, not a file:// path -- MetaMask does not inject a provider\n` +
        `into file:// pages unless "Allow access to file URLs" is enabled.`,
    );
    console.log(
      `\nSignatures are saved to disk automatically as each one is produced:\n` +
        `  safe-bundles/<bundle>/signatures-<signer>.json\n` +
        `Each is verified against the Safe's owner list before it is written, so a\n` +
        `wrong-account mistake is caught on the first device confirmation.`,
    );
    console.log(
      `\nWhen a signer is done:\n` +
        `  npx hardhat safe:sign --name ${pages[0]} --import safe-bundles/${pages[0]}/signatures-<signer>.json`,
    );

    // Surface anything already collected so a restart is never ambiguous.
    for (const name of pages) {
      const dir = path.join(ROOT, name);
      if (!fs.existsSync(dir)) continue;
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^signatures-0x[0-9a-fA-F]{40}\.json$/.test(f));
      if (!files.length) continue;
      console.log(`\nAlready saved for "${name}":`);
      for (const f of files) {
        let n = 0;
        try {
          n = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).length;
        } catch { /* unreadable -- report as 0 rather than crash the banner */ }
        console.log(`  ${f}  ${n} signature(s)`);
      }
    }
  }
  console.log(`\nCtrl+C to stop.\n`);
});

// Exit cleanly on Ctrl+C so the port is released immediately.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
