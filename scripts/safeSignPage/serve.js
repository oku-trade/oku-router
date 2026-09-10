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
const { recoverAddress, getAddress, Signature } = require("ethers");

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

function bundleSummary(name) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), "utf8"));
    const total = b.chains.length;
    const ready = b.chains.filter((c) => c.signatures.length >= b.threshold).length;
    const sigs = b.chains.reduce((a, c) => a + c.signatures.length, 0);
    return `${total} chain(s), ${sigs} signature(s) collected, ${ready}/${total} ready to execute`;
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
  const pages = findSignPages();
  const bar = "=".repeat(72);
  console.log(`\n${bar}`);
  console.log("Safe batch signing page");
  console.log(bar);
  console.log(`serving   ${ROOT}`);
  console.log(`bound to  http://${HOST}:${PORT}  (loopback only -- not exposed to your LAN)`);

  if (pages.length === 0) {
    console.log(`\nNo generated signing page found under safe-bundles/*/sign.html.`);
    console.log(`Generate one first:`);
    console.log(`  npx hardhat safe:sign-page --name <bundle>\n`);
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
