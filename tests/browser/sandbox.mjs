// Checks the parser where it really runs: in a sandbox="allow-scripts" srcdoc iframe with
// Wealthfolio's add-on CSP, starting its classic Worker from a blob URL.
// Usage: pnpm runtime && node tests/browser/sandbox.mjs [chromium] [firefox] [webkit]
// Needs Playwright's browsers (`pnpm exec playwright-core install chromium firefox`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright-core";
import { build } from "vite";

// From wealthfolio/wealthfolio apps/frontend/addon-sandbox.html (v3.11.0), with the hash of
// Wealthfolio's bootstrap script replaced by the hash of this harness.
const csp = (hash) =>
  `default-src 'none'; script-src 'sha256-${hash}' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob:; ` +
  "img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const [bundle] = await build({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: false,
    lib: { entry: "tests/browser/harness.ts", formats: ["iife"], name: "harness" },
  },
});
const script = bundle.output[0].code.replace(/<\/script/gi, "<\\/script");
const hash = createHash("sha256").update(script).digest("base64");
const srcdoc =
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp(hash)}">` +
  `<script>${script}</script>`;

const runtime = JSON.parse(await readFile("assets/runtime/files.json", "utf8"));
const paths = ["files.json", ...runtime.files, ...runtime.wasmParts, ...runtime.wheels].map(
  (name) => `assets/runtime/${name}`,
);
// The meta charset matters: Playwright's WebKit reads a routed page as windows-1252 despite the
// header, which would garble the harness's non-ASCII text and so break its CSP hash.
const page = `<!doctype html><meta charset="utf-8"><iframe sandbox="allow-scripts"></iframe><script>
const paths = ${JSON.stringify(paths)};
const frame = document.querySelector("iframe");
addEventListener("message", async ({ data }) => {
  if (data.ready) {
    const files = {};
    for (const path of paths) files[path] = await (await fetch("/" + path)).blob();
    const pdf = await (await fetch("/tests/fixtures/made-up-cas.pdf")).blob();
    frame.contentWindow.postMessage({ files, pdf, password: "ABCDE1234F" }, "*");
  } else if (data.result) {
    window.result = data.result;
  }
});
frame.srcdoc = ${JSON.stringify(srcdoc).replace(/<\//g, "<\\/")};
</script>`;

const expected = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
const engines = { chromium, firefox, webkit };
let failed = false;
for (const name of process.argv.length > 2 ? process.argv.slice(2) : ["chromium", "firefox"]) {
  const browser = await engines[name].launch();
  const tab = await browser.newPage();
  const violations = [];
  tab.on("console", (message) => {
    if (/Content.Security.Policy|Refused/i.test(message.text())) violations.push(message.text());
  });
  await tab.route("http://sandbox.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page });
    return route.fulfill({ body: await readFile(path) });
  });
  await tab.goto("http://sandbox.test/");
  await tab.waitForFunction(() => window.result, null, { timeout: 180_000 });
  const { data, ...result } = await tab.evaluate(() => window.result);
  console.log(`${name} ${browser.version()}`, result);
  // Pyodide probes for a classic Worker with importScripts("data:..."), which the CSP refuses.
  const unexpected = violations.filter((text) => !text.includes("data:text/javascript"));
  if (unexpected.length) console.log("  CSP:", unexpected);
  try {
    assert.equal(result.wrongPassword, "password");
    assert.deepEqual(data, expected);
    const frame = tab.frameLocator("iframe");
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.locator("#cas-password").fill("WRONGPASS1");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.locator("#cas-file:disabled").waitFor();
    assert.equal(await frame.locator("#cas-password").isDisabled(), true);
    await frame.getByText("Wrong password", { exact: true }).waitFor({ timeout: 180_000 });
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    const summary = frame.getByText(/2 folios, 5 funds, 77 rows\./);
    await summary.waitFor({ timeout: 180_000 });
    assert.equal(await frame.locator("tbody tr").count(), 77);
    await frame.locator("#cas-file").setInputFiles({
      name: "another-statement.pdf",
      mimeType: "application/pdf",
      buffer: await readFile("tests/fixtures/made-up-cas.pdf"),
    });
    await summary.waitFor({ state: "hidden" });
  } catch (error) {
    failed = true;
    console.log(`  FAILED: ${error.message.split("\n")[0]}`);
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
