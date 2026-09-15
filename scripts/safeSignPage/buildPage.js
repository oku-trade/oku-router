/**
 * buildPage.js
 *
 * Shared page-generation logic for the Safe batch signer.
 *
 * Both `npm run sign-page` (scripts/safeSignPage/serve.js) and the
 * `safe:sign-page` hardhat task build the self-contained signing page, and
 * they must produce byte-identical output. Keeping the logic here rather than
 * duplicating it means the "strip signature bytes before distributing"
 * guarantee cannot drift between the two entry points.
 *
 * Plain CommonJS with no dependencies so the server can use it without
 * loading hardhat.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Read every per-signer sidecar for a bundle. */
function readSidecars(root, name) {
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^signatures-0x[0-9a-fA-F]{40}\.json$/.test(f)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(arr)) out.push(...arr);
    } catch {
      // Unreadable sidecar: ignore rather than crash the server banner.
    }
  }
  return out;
}

/**
 * Map safeTxHash -> Set of lowercase owner addresses that have signed it,
 * drawn from sidecars plus any legacy in-bundle signatures.
 */
function signerIndex(bundle, sidecars) {
  const owners = new Set(bundle.owners.map((o) => String(o).toLowerCase()));
  const idx = new Map();
  const add = (hash, signer) => {
    const k = String(hash).toLowerCase();
    const s = String(signer).toLowerCase();
    if (!owners.has(s)) return;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(s);
  };
  for (const e of sidecars || []) {
    if (e && e.safeTxHash && e.signer) add(e.safeTxHash, e.signer);
  }
  for (const c of bundle.chains) {
    for (const s of c.signatures || []) add(c.safeTxHash, s.signer);
  }
  return idx;
}

/** Progress summary for a bundle: how many chains are at threshold. */
function bundleStatus(bundle, sidecars) {
  const idx = signerIndex(bundle, sidecars);
  let sigs = 0;
  let ready = 0;
  for (const c of bundle.chains) {
    const n = (idx.get(String(c.safeTxHash).toLowerCase()) || new Set()).size;
    sigs += n;
    if (n >= bundle.threshold) ready++;
  }
  return { total: bundle.chains.length, ready, sigs, complete: ready === bundle.chains.length };
}

/**
 * Produce the self-contained page HTML.
 *
 * Signature BYTES are stripped from the embedded bundle; only `signedBy`
 * (addresses) survives, so a generated page can be handed to a co-signer
 * without carrying any authorization material. The page uses `signedBy` to
 * grey out rows the connected account has already signed.
 */
function buildSignPage(templateHtml, bundle, sidecars) {
  const idx = signerIndex(bundle, sidecars);
  const shared = Object.assign({}, bundle, {
    chains: bundle.chains.map((c) =>
      Object.assign({}, c, {
        signatures: [],
        signedBy: [...(idx.get(String(c.safeTxHash).toLowerCase()) || new Set())],
      }),
    ),
  });

  // Embedded via a JSON-typed script tag rather than a JS literal so no
  // bundle content can be interpreted as code. "</" is escaped so a nested
  // string cannot terminate the tag early.
  const json = JSON.stringify(shared).replace(/<\//g, "<\\/");
  const inject =
    `<script id="__bundle_json" type="application/json">${json}</script>\n` +
    `<script>window.__BUNDLE__ = JSON.parse(` +
    `document.getElementById("__bundle_json").textContent);</script>\n`;

  if (!templateHtml.includes("<script>")) {
    throw new Error("signing page template has no <script> block to anchor injection");
  }
  return templateHtml.replace("<script>", `${inject}<script>`);
}

module.exports = { readSidecars, signerIndex, bundleStatus, buildSignPage };
