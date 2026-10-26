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
    const host = () => tab.frames()[1].evaluate(() => ({ secrets: [...window.host.secrets], storage: [...window.host.storage] }));
    const pause = (name) => tab.frames()[1].evaluate((name) => { window.host.pause = name; }, name);
    const waiting = () => tab.frames()[1].waitForFunction(() => window.host.resume);
    const resume = () => tab.frames()[1].evaluate(() => window.host.resume());
    const remember = frame.getByRole("checkbox", { name: "Remember the password" });
    // A slow secret load cannot override an editable Remember opt-out.
    await waiting();
    assert.equal(await remember.getAttribute("aria-checked"), "false");
    assert.equal(await remember.isDisabled(), true);
    assert.equal(await frame.locator("#cas-password").isDisabled(), true);
    await tab.frames()[1].evaluate(() => window.host.secrets.set("statement-password", "saved-password"));
    await resume();
    await frame.getByRole("button", { name: "Forget the saved password" }).click();
    assert.equal(await remember.getAttribute("aria-checked"), "false");
    assert.deepEqual((await host()).secrets, []);
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.locator("#cas-password").fill("WRONGPASS1");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.locator("#cas-file:disabled").waitFor();
    assert.equal(await frame.locator("#cas-password").isDisabled(), true);
    await frame.getByText("Wrong password", { exact: true }).waitFor({ timeout: 180_000 });
    await frame.locator("#cas-password").fill("ABCDE1234F");
    // Unstyled here, so the checkbox has no width to click on.
    await remember.dispatchEvent("click");
    assert.equal(await remember.getAttribute("aria-checked"), "true");
    await pause("storage");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await waiting();
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await frame.getByRole("button", { name: "Reading…", exact: true }).isDisabled(), true);
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await resume();
    await frame.getByText(/2 folios, 7 schemes, 78 rows\. Skipping 2 closed schemes, with no units and nothing to import\./).waitFor({ timeout: 180_000 });
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);

    await frame.getByLabel("PAN ABCDE1234F").click();
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    await frame.getByText("Same as PAN (Mutual funds)").first().waitFor();
    // Closed schemes get no fund section, so no search either.
    assert.equal(await frame.locator("section").count(), 5);
    assert.equal(await frame.getByText(/Midcap|Gilt/).count(), 0);
    const firstFund = frame.locator("section").first();
    const search = firstFund.getByLabel("Search for the fund");
    const useFund = firstFund.getByRole("button", { name: "Use this fund" });
    await search.fill("MULTI");
    await search.press("Enter");
    await firstFund.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.equal(await useFund.isDisabled(), true, "multiple matches require a selected result");
    await firstFund.getByRole("radio").nth(1).dispatchEvent("click");
    assert.equal(await useFund.isDisabled(), false);
    await pause("market");
    await search.fill("WAIT");
    await search.press("Enter");
    await waiting();
    assert.equal(await useFund.isDisabled(), true, "a new search cannot confirm old results");
    assert.equal(await firstFund.getByRole("radio").count(), 0);
    // Fail a newer search, then deliver the older response: neither can restore stale results.
    await tab.frames()[1].evaluate(() => { window.host.pause = ""; });
    await search.fill("FAIL");
    await search.press("Enter");
    await firstFund.getByText(/The search failed/).waitFor();
    await resume();
    assert.equal(await useFund.isDisabled(), true);
    await search.fill(expected.folios[0].schemes[0].isin);
    await search.press("Enter");
    for (const section of await frame.locator("section").all()) {
      if (await section.getByText("No ISIN printed").count()) {
        await section.getByLabel("Search for the fund").fill("OVERNIGHT");
        await section.getByLabel("Search for the fund").press("Enter");
      }
      await section.getByRole("radio").first().waitFor();
      await section.getByRole("button", { name: "Use this fund" }).click();
      await section.getByText("Confirmed").waitFor();
    }
    const searches = await tab.frames()[1].evaluate(() => window.host.searches);
    assert.ok(!searches.some((query) => /INFZ90K01MC|INFZ91T01GL/.test(query)), searches.join(" "));
    // Remembered: the PAN's account and the five funds, with no PAN or folio number in a key.
    const saved = (await host()).storage;
    const keys = saved.map(([key]) => key);
    assert.equal(keys.length, 6);
    assert.ok(keys.every((key) => /^(pan|fund):[0-9a-f]{64}$|^isin:INFZ9/.test(key)), keys.join(" "));
    assert.ok(keys.every((key) => /^[A-Za-z0-9_.:-]{1,128}$/.test(key)));
    for (const folio of expected.folios) {
      assert.ok(!JSON.stringify(saved).includes(folio.folio));
      assert.ok(!folio.PAN || !JSON.stringify(saved).includes(folio.PAN));
    }

    await frame.getByRole("button", { name: "Preview the import" }).click();
    // The Flexi Cap fund starts with units the fake host has no history for.
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await frame.getByText(/starts with 1250\.000 units bought before 01-Apr-2023/).waitFor();
    // Rechecking removes the old preview and locks every input until its answer arrives.
    await pause("check");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await waiting();
    assert.equal(await frame.getByRole("button", { name: "Import 23 activities" }).count(), 0);
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await frame.getByLabel("PAN ABCDE1234F").isDisabled(), true);
    assert.equal(await remember.isDisabled(), true);
    assert.equal(await frame.getByRole("button", { name: "Change", exact: true }).first().isDisabled(), true);
    await resume();
    await pause("import");
    await frame.getByRole("button", { name: "Import 23 activities" }).click();
    await waiting();
    assert.equal(await frame.getByRole("button", { name: "Preview the import" }).isDisabled(), true);
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await remember.isDisabled(), true);
    await resume();
    await frame.getByText("Imported 23 of 23 activities").waitFor();
    const units = frame.locator("table").last().locator("tbody tr");
    assert.equal(await units.count(), 5);
    assert.equal(await units.filter({ hasText: "Match" }).count(), 4);

    // A second import of the same statement finds everything.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    assert.equal(await frame.getByRole("button", { name: "Import 0 activities" }).isDisabled(), true);

    // Selecting a file clears the previous statement and preview, even before the next read.
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas-mismatch.pdf");
    await frame.getByText("Preview", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await frame.getByText("Confirmed", { exact: true }).count(), 5);
    await tab.frames()[1].evaluate(() => { window.host.activities = []; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await pause("import");
    await frame.getByRole("button", { name: "Import 23 activities" }).click();
    await waiting();
    await tab.frames()[1].evaluate(() => {
      window.host.rejectLine = 1;
      window.host.failHistory = true;
    });
    await resume();
    await frame.getByText("Imported 22 of 23 activities").waitFor();
    await frame.getByText("Wealthfolio rejected rows", { exact: true }).waitFor();
    await frame.getByText(/The fund could not be created/).waitFor();
    await frame.getByText(/The import finished, but the closing units couldn't be checked/).waitFor();
    assert.equal(await frame.getByText(/The import failed/).count(), 0);

    await frame.getByRole("button", { name: "Forget the saved password" }).click();
    await frame.getByRole("button", { name: "Forget the saved password" }).waitFor({ state: "hidden" });
    assert.deepEqual((await host()).secrets, []);
  } catch (error) {
    failed = true;
    console.log(`  FAILED: ${error.stack}`);
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
