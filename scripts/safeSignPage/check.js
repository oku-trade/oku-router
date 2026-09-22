/**
 * check.js
 *
 * Static self-check for the batch signing page. Run with:
 *   npm run check:sign-page
 *
 * The page is hand-written HTML+JS with no build step, so nothing else would
 * catch a syntax error or an accidental capability regression. This asserts
 * the properties the page's security story actually rests on:
 *
 *   1. the inline script parses (node --check on the extracted block)
 *   2. it never sends a transaction (no eth_sendTransaction / personal_sign)
 *   3. its only outbound network primitive is the same-origin bundle read
 *      (no XMLHttpRequest, WebSocket, sendBeacon, dynamic import, eval)
 *   4. it never touches key material
 *   5. the wallet method it uses to produce authorizations is exactly
 *      eth_signTypedData_v4
 *
 * Exits non-zero on any failure so it can gate CI.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PAGE = path.resolve(__dirname, "index.html");
const html = fs.readFileSync(PAGE, "utf8");

/**
 * Strip comments before asserting capabilities.
 *
 * The page documents its own threat model in prose ("no eth_sendTransaction
 * anywhere", "no XMLHttpRequest", ...), so scanning the raw file makes every
 * check fail on its own documentation. Only executable text should be
 * inspected.
 *
 * The `//` heuristic deliberately ignores a `//` preceded by `:` so that
 * URLs inside string literals (https://, file://) are not mistaken for
 * comments.
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")     // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, "")    // JS block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // JS line comments, sparing URLs
}

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? "\u2713" : "\u2717";
  console.log(`  ${mark} ${label}${!ok && detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
}

// --- 1. syntax ---
const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
if (blocks.length === 0) {
  console.error("no plain <script> block found in the page");
  process.exit(1);
}
const code = blocks[blocks.length - 1]
  .replace(/^<script>/, "")
  .replace(/<\/script>$/, "");
// Executable-only views: capability assertions must not trip over the
// page's own documentation of what it refuses to do.
const codeBare = stripComments(code);
const htmlBare = stripComments(html);

const tmp = path.join(os.tmpdir(), `safe-sign-page-${process.pid}.js`);
fs.writeFileSync(tmp, code, "utf8");
let syntaxOk = true;
let syntaxErr = "";
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (e) {
  syntaxOk = false;
  syntaxErr = String((e.stderr && e.stderr.toString()) || e.message).split("\n")[0];
} finally {
  fs.unlinkSync(tmp);
}

console.log(`\nsigning page self-check: ${path.relative(process.cwd(), PAGE)}`);
console.log(`  (${code.split("\n").length} lines of inline script)\n`);

check("inline script parses", syntaxOk, syntaxErr);

// --- 2. cannot broadcast ---
check("no eth_sendTransaction", !/eth_sendTransaction/.test(codeBare));
check("no eth_sign / personal_sign (unbounded signing)",
  !/["']eth_sign["']|personal_sign/.test(codeBare));

// --- 3. no exfiltration primitives beyond the same-origin bundle read ---
check("no XMLHttpRequest", !/XMLHttpRequest/.test(codeBare));
check("no WebSocket", !/WebSocket/.test(codeBare));
check("no navigator.sendBeacon", !/sendBeacon/.test(codeBare));
check("no eval / new Function", !/\beval\s*\(|new\s+Function\s*\(/.test(codeBare));
check("no dynamic import()", !/\bimport\s*\(/.test(codeBare));
check("no remote <script src>", !/<script[^>]+src=/.test(htmlBare));

// fetch is permitted for exactly two same-origin uses: reading the local
// bundle, and POSTing a signature to the local autosave endpoint. Anything
// beyond that is a capability regression.
const fetchCalls = (codeBare.match(/fetch\s*\(/g) || []).length;
check(
  "fetch used at most twice (bundle autoload + signature autosave)",
  fetchCalls <= 2,
  `found ${fetchCalls} call(s)`,
);
check(
  "no absolute/remote URL passed to fetch",
  !/fetch\s*\(\s*["'`]?\s*(https?:|\/\/)/i.test(codeBare),
);
// Every fetch target must be a relative path or the known local endpoint.
const fetchTargets = (codeBare.match(/fetch\s*\(\s*([^,)]+)/g) || []).map((m) =>
  m.replace(/^fetch\s*\(\s*/, "").trim(),
);
check(
  "all fetch targets are relative paths",
  fetchTargets.every(
    (t) => /^["'`][./]/.test(t) || /^candidates\[/.test(t) || /^["'`]\/api\//.test(t),
  ),
  fetchTargets.join(" | "),
);
check(
  "autosave posts only to the local /api/signature endpoint",
  !/fetch\s*\(\s*["'`](?!\/api\/signature)["'`]*\s*,\s*\{\s*[^}]*method:\s*["'`]POST/i.test(
    codeBare,
  ),
);

// --- persistence: the property that was missing and lost a real signature ---
check("mirrors signatures to localStorage", /localStorage\.setItem/.test(codeBare));
check("restores signatures from localStorage", /localStorage\.getItem/.test(codeBare));
check("warns when a signature is not on disk",
  /MEMORY ONLY|NOT saved to disk/.test(codeBare));

// --- connection guards ---
// `provider` is null until connect() runs, but the per-row sign buttons are
// reachable before that. Without these guards, clicking one surfaced as
// "Cannot read properties of null (reading 'request')".
check("signOne guards on a connected wallet",
  /async function signOne[\s\S]{0,120}await ensureConnected\(\)/.test(codeBare));
check("ensureConnected throws something actionable",
  /function ensureConnected[\s\S]*?no wallet connected/.test(codeBare));
check("row sign buttons are disabled until connected",
  /account \?\s*""\s*:\s*['"] disabled/.test(codeBare));
check("null-provider TypeError is not shown raw to the signer",
  /reading 'request'[\s\S]{0,200}no wallet connected/.test(codeBare));

// --- 4. no key material ---
check("never references a private key or mnemonic",
  !/privateKey|mnemonic|seed\s*phrase|eth_exportAccount/i.test(codeBare));

// --- 5. the intended capability is present ---
check("uses eth_signTypedData_v4", /eth_signTypedData_v4/.test(codeBare));
check("verifies active chain before signing", /eth_chainId/.test(codeBare));
check("supports EIP-6963 wallet discovery", /eip6963:requestProvider/.test(codeBare));

// --- 6. value-transferring bundles are disclosed, not buried in a label ---
// A sweep authorizes moving every asset on a chain. Describing that to a
// signer as one truncated call label is how someone approves something they
// did not read, so the panel is a required property of the page.
check("renders a fund-movement panel for sweep bundles",
  /function renderSweepPanel/.test(codeBare));
check("fund-movement panel is gated on intent === \"sweep\"",
  /bundle\.intent\s*!==\s*["']sweep["']/.test(codeBare));
check("panel is invoked when a bundle is adopted",
  /function adoptBundle[\s\S]*?renderSweepPanel\(\)/.test(codeBare));
check("sweep recipient is displayed to the signer",
  /sweepRecipient/.test(codeBare) && /id="sweepRecipient"/.test(htmlBare));
check("sweep asset manifest is itemized",
  /sweepAssets/.test(codeBare) && /sweep\.assets/.test(codeBare));
check("warns explicitly that the transaction moves funds",
  /This transaction moves funds/i.test(htmlBare));
// sweepAll takes a token list and no amounts: it moves whatever balance exists
// at execution time. The manifest is therefore an estimate that will be wrong
// by the time anyone signs, and a signer who reads those figures as a cap has
// misunderstood what they are approving. Saying so is not optional.
check("states that the listed amounts are not part of the transaction",
  /id="sweepAmountsNote"/.test(htmlBare) &&
  /not part of the transaction/i.test(htmlBare) &&
  /entire balance/i.test(htmlBare));
check("flags a bundle that sweeps to more than one recipient",
  /recipients\.length\s*>\s*1/.test(codeBare));
// A cross-chain USD total, up top, is the whole point of this change: a
// signer approving 31 sweeps in one sitting should not have to add up 31
// per-chain figures themselves to know the scale of what they are signing.
check("shows a cross-chain USD total at the top of the sweep panel",
  /id="sweepGrandTotal"/.test(htmlBare) && /sweepGrandTotal/.test(codeBare));
check("shows a per-chain USD subtotal in the itemized report",
  /chainTotal/.test(codeBare) && /class="chainTotal"/.test(codeBare));
// HTML-escape everything interpolated from the bundle. The manifest carries
// attacker-influencable strings (token symbols come from arbitrary ERC20
// contracts), so an unescaped symbol would be an injection vector.
check("escapes bundle-supplied strings before rendering",
  /function esc\(/.test(codeBare) && /esc\(a\.symbol\)/.test(codeBare));

// --- 7. bundle autoload must not be hardcoded to one bundle name ---
// It previously always fetched `accept-all.json`, which silently loads the
// wrong bundle once more than one exists.
check("autoload is not hardcoded to a single bundle name",
  !/accept-all\.json/.test(codeBare));

console.log("");
if (failures) {
  console.error(`FAILED: ${failures} check(s)\n`);
  process.exit(1);
}
console.log("all checks passed\n");
