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

const ROOT = path.resolve(__dirname, "..", "..", "safe-bundles");
const PORT = Number(process.env.PORT || 8547);
const HOST = "127.0.0.1";

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

const server = http.createServer((req, res) => {
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
      `\nAfter signing, download signatures.json and import it:\n` +
        `  npx hardhat safe:sign --name ${pages[0]} --import <signatures.json>`,
    );
  }
  console.log(`\nCtrl+C to stop.\n`);
});

// Exit cleanly on Ctrl+C so the port is released immediately.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
