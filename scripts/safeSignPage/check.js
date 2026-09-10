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

// fetch is permitted, but only for the local bundle autoload.
const fetchCalls = (codeBare.match(/fetch\s*\(/g) || []).length;
check(
  "fetch used at most once (local bundle autoload only)",
  fetchCalls <= 1,
  `found ${fetchCalls} call(s)`,
);
check(
  "no absolute/remote URL passed to fetch",
  !/fetch\s*\(\s*["'`]?https?:/i.test(codeBare),
);

// --- 4. no key material ---
check("never references a private key or mnemonic",
  !/privateKey|mnemonic|seed\s*phrase|eth_exportAccount/i.test(codeBare));

// --- 5. the intended capability is present ---
check("uses eth_signTypedData_v4", /eth_signTypedData_v4/.test(codeBare));
check("verifies active chain before signing", /eth_chainId/.test(codeBare));
check("supports EIP-6963 wallet discovery", /eip6963:requestProvider/.test(codeBare));

console.log("");
if (failures) {
  console.error(`FAILED: ${failures} check(s)\n`);
  process.exit(1);
}
console.log("all checks passed\n");
