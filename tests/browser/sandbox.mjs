// Checks the parser where it really runs: in a sandbox="allow-scripts" srcdoc iframe with
// Wealthfolio's add-on CSP, starting its classic Worker from a blob URL. Then parses again
// without the CSP.
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
const srcdoc = (head) => `<!doctype html>${head}<script>${script}</script>`;

const runtime = JSON.parse(await readFile("assets/runtime/files.json", "utf8"));
const paths = ["files.json", ...runtime.files, ...runtime.wasmParts, ...runtime.wheels].map(
  (name) => `assets/runtime/${name}`,
);
// The meta charset matters: Playwright's WebKit reads a routed page as windows-1252 despite the
// header, which would garble the harness's non-ASCII text and so break its CSP hash.
const page = (doc) => `<!doctype html><meta charset="utf-8"><iframe sandbox="allow-scripts"></iframe><script>
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
frame.srcdoc = ${JSON.stringify(doc).replace(/<\//g, "<\\/")};
</script>`;
const pages = {
  "": page(srcdoc(`<meta http-equiv="Content-Security-Policy" content="${csp(hash)}">`)),
  "no-csp": page(srcdoc("")),
};

const expected = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
const engines = { chromium, firefox, webkit };
let failed = false;
for (const name of process.argv.length > 2 ? process.argv.slice(2) : ["chromium", "firefox"]) {
  const browser = await engines[name].launch();
  const tab = await browser.newPage();
  tab.setDefaultTimeout(30_000);
  const violations = [];
  tab.on("console", (message) => {
    if (/Content.Security.Policy|Refused/i.test(message.text())) violations.push(message.text());
  });
  await tab.route("http://sandbox.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (Object.hasOwn(pages, path)) return route.fulfill({ contentType: "text/html; charset=utf-8", body: pages[path] });
    return route.fulfill({ body: await readFile(path) });
  });
  await tab.goto("http://sandbox.test/");
  await tab.waitForFunction(() => window.result, null, { timeout: 180_000 });
  const { data, ...result } = await tab.evaluate(() => window.result);
  console.log(`${name} ${browser.version()}`, result);
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

    await frame.getByLabel("PAN ABCDE1234F", { exact: true }).click();
    // Only accounts that track transactions, which in Wealthfolio include NOT_SET.
    await frame.getByRole("option", { name: "Not set (INR)" }).waitFor();
    assert.equal(await frame.getByRole("option", { name: "Demat (INR)" }).count(), 0);
    assert.equal(await frame.getByRole("option", { name: "Fund folios (INR)" }).count(), 0);
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    await frame.getByText("Same as PAN (Mutual funds)").first().waitFor();
    // Closed schemes get no fund section, so no search either.
    assert.equal(await frame.locator("section").count(), 5);
    assert.equal(await frame.getByText(/Midcap|Gilt/).count(), 0);
    // The Overnight fund has no ISIN, so its name is searched without the plan and option when it's first shown.
    const noIsin = frame.locator("section").filter({ hasText: "No ISIN printed" });
    await noIsin.getByText(`No ISIN on the statement; showing results for "Testbridge Overnight Fund". These results can be other funds. Pick one with the statement's fund name, plan and option, or leave this fund out.`).waitFor();
    assert.equal(await noIsin.getByLabel("Search for the fund").inputValue(), "Testbridge Overnight Fund");
    assert.equal(await noIsin.getByRole("radio").count(), 1);
    assert.equal(await noIsin.getByRole("button", { name: "Use this fund" }).isDisabled(), true, "a name match needs picking");
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
    // The Corporate Bond fund's ISIN finds nothing, so its name is searched without the plan and option.
    const byName = frame.locator("section").filter({ hasText: "ISIN INFZ91T01CB6" });
    await byName.getByText('Nothing found for the ISIN; showing results for "Testbridge Corporate Bond Fund".').waitFor();
    assert.equal(await byName.getByLabel("Search for the fund").inputValue(), "Testbridge Corporate Bond Fund");
    await byName.getByRole("radio").first().waitFor({ state: "attached" });
    assert.equal(await byName.getByRole("button", { name: "Use this fund" }).isDisabled(), true, "a name match needs picking");
    // A late name fallback cannot replace a newer typed search or restore its message.
    const nameSearch = byName.getByLabel("Search for the fund");
    await pause("Testbridge Corporate Bond Fund");
    await nameSearch.fill("INFZ91T01CB6");
    await nameSearch.press("Enter");
    await waiting();
    await tab.frames()[1].evaluate(() => { window.host.pause = ""; });
    await nameSearch.fill("NEWER");
    await nameSearch.press("Enter");
    await byName.getByText("Fund NEWER").waitFor();
    await resume();
    await nameSearch.press("Tab");
    assert.equal(await byName.getByText("Fund NEWER").count(), 1, "the newer result survives the old fallback");
    assert.equal(await byName.getByText(/Nothing found for the ISIN/).count(), 0, "the message belongs to the newer search");
    assert.equal(await byName.getByRole("button", { name: "Use this fund" }).isDisabled(), false);
    await nameSearch.fill("INFZ91T01CB6");
    await nameSearch.press("Enter");
    await byName.getByText('Nothing found for the ISIN; showing results for "Testbridge Corporate Bond Fund".').waitFor();
    await byName.getByRole("radio").first().dispatchEvent("click");
    await noIsin.getByRole("radio").first().dispatchEvent("click");
    for (const section of await frame.locator("section").all()) {
      await section.getByRole("radio").first().waitFor();
      await section.getByRole("button", { name: "Use this fund" }).click();
      await section.getByText("Confirmed").waitFor();
    }
    const searches = await tab.frames()[1].evaluate(() => window.host.searches);
    assert.ok(!searches.some((query) => /INFZ90K01MC|INFZ91T01GL/.test(query)), searches.join(" "));
    assert.ok(searches.includes("INFZ91T01CB6") && searches.includes("Testbridge Corporate Bond Fund"), searches.join(" "));
    assert.ok(searches.includes("Testbridge Overnight Fund"), searches.join(" "));
    assert.ok(!searches.some((query) => query.includes(" - ")), "full scheme names are never searched");
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
    assert.equal(await frame.getByLabel("PAN ABCDE1234F", { exact: true }).isDisabled(), true);
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

    // With a bank account chosen, the deposits and withdrawals imported before are the transactions' cash.
    const bankChoice = frame.getByLabel("Bank account for PAN ABCDE1234F");
    const beforeBank = await host();
    await bankChoice.click();
    assert.equal(await frame.getByRole("option", { name: "Demat (INR)" }).count(), 0);
    await frame.getByRole("option", { name: "Savings (INR)" }).click();
    await frame.getByText("Same as PAN (Savings)").first().waitFor();
    const [[bankKey, bankId]] = (await host()).storage.filter(([key]) => !beforeBank.storage.some(([other]) => other === key));
    assert.match(bankKey, /^bank-pan:[0-9a-f]{64}$/);
    assert.equal(bankId, "bank-1");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await frame.getByText("Wealthfolio already has this transfer in, as a deposit.").first().waitFor();

    // Otherwise purchases, redemptions and payouts come with transfers from and to the bank account,
    // and a withdrawal it already has can stand in for one; a transfer already linked can't.
    await tab.frames()[1].evaluate(() => {
      const bankRow = (id, activityType, amount, date, comment) => ({
        id, accountId: "bank-1", activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`, quantity: null,
        unitPrice: null, amount, fee: null, currency: "INR", needsReview: false, comment, assetId: "", assetSymbol: "",
      });
      window.host.activities = [
        bankRow("bank-neft", "WITHDRAWAL", "25000.00", "2023-05-04", "NEFT FICTIVA MF"),
        bankRow("bank-linked", "TRANSFER_IN", "7276.48", "2023-12-28", "IDCW"),
      ];
      window.host.linked = ["bank-linked"];
    });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await frame.getByText(
      "Savings has a withdrawal of 25000.00 on 2023-05-04 (NEFT FICTIVA MF). If you use it, the add-on changes it into a transfer out and links it with this transfer in.",
    ).waitFor();
    const reuseBankRow = frame.getByRole("checkbox", { name: "Use it instead of a new transfer out" });
    assert.equal(await reuseBankRow.count(), 1);
    const bankRows = await tab.frames()[1].evaluate(() => window.host.activities);
    // A trade rejected or skipped after preview must leave its chosen bank row and fund cash alone.
    for (const outcome of ["rejectLine", "skipLine"]) {
      await tab.frames()[1].evaluate(([rows, outcome]) => {
        window.host.activities = rows;
        window.host[outcome] = 1;
      }, [bankRows, outcome]);
      await frame.getByRole("button", { name: "Preview the import" }).click();
      await reuseBankRow.waitFor({ state: "attached" });
      await reuseBankRow.dispatchEvent("click");
      await frame.getByRole("button", { name: "Import 30 activities" }).click();
      await frame.getByText("Imported 29 of 30 activities").waitFor();
      await frame.getByText(/The trade wasn't imported, so the bank's row was left as it is\./).waitFor();
      const unchanged = await tab.frames()[1].evaluate(() => ({
        bank: window.host.activities.find((a) => a.id === "bank-neft"),
        fundRows: window.host.activities.filter((a) => a.accountId === "account-1" && a.date.startsWith("2023-05-05")),
        links: window.host.links,
      }));
      assert.deepEqual(unchanged, { bank: bankRows[0], fundRows: [], links: [] });
      await tab.frames()[1].evaluate(() => {
        window.host.rejectLine = undefined;
        window.host.skipLine = undefined;
      });
    }
    await tab.frames()[1].evaluate((rows) => { window.host.activities = rows; }, bankRows);
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await reuseBankRow.waitFor({ state: "attached" });
    await frame.getByRole("button", { name: "Import 32 activities" }).waitFor();
    await reuseBankRow.dispatchEvent("click");
    await frame.getByRole("button", { name: "Import 30 activities" }).click();
    await frame.getByText("Imported 30 of 30 activities").waitFor();
    await frame.getByText("Linked 1 of 1 bank rows you chose with their transactions.").waitFor();
    const banked = await tab.frames()[1].evaluate(() => ({ activities: window.host.activities, links: window.host.links }));
    const byId = Object.fromEntries(banked.activities.map((a) => [a.id, a]));
    assert.equal(banked.links.length, 1);
    const [[bankRowId, fundLegId]] = banked.links;
    assert.equal(bankRowId, "bank-neft");
    assert.deepEqual(
      [byId["bank-neft"].activityType, byId["bank-neft"].comment, byId["bank-neft"].amount],
      ["TRANSFER_OUT", "NEFT FICTIVA MF", "25000.00"],
    );
    const fundLeg = byId[fundLegId];
    assert.deepEqual(
      [fundLeg.accountId, fundLeg.activityType, fundLeg.amount, fundLeg.date.slice(0, 10)],
      ["account-1", "TRANSFER_IN", "25001.1470564", "2023-05-05"],
    );
    const count = (accountId, type) => banked.activities.filter((a) => a.accountId === accountId && a.activityType === type).length;
    assert.deepEqual(
      [count("bank-1", "TRANSFER_OUT"), count("bank-1", "TRANSFER_IN"), count("account-1", "TRANSFER_IN"), count("account-1", "TRANSFER_OUT")],
      [4, 6, 4, 5],
    );
    assert.equal(count("account-1", "DEPOSIT"), 1, "the switch's purchase keeps its deposit");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    // Back to outside Wealthfolio, which forgets the choice.
    await bankChoice.click();
    await frame.getByRole("option", { name: "Outside Wealthfolio" }).click();
    await frame.getByText("Same as PAN (Outside Wealthfolio)").first().waitFor();
    await tab.frames()[1].waitForFunction((key) => !window.host.storage.has(key), bankKey);
    assert.deepEqual(await host(), beforeBank);

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

    // Reads the selected statement again; storage reads wait until the previous one has gone.
    const readAgain = async () => {
      await pause("storage");
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await waiting();
      assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
      await resume();
      await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    };
    const storage = async () => Object.fromEntries((await host()).storage);
    const confirmed = () => frame.getByText("Confirmed", { exact: true }).count();
    const undecided = async (section) => {
      await section.getByLabel("Search for the fund").waitFor();
      assert.equal(await section.getByText("Confirmed", { exact: true }).count(), 0);
      assert.equal(await section.getByText("Left out", { exact: true }).count(), 0);
    };
    const leaveOut = async (section) => {
      await section.getByRole("button", { name: "Change", exact: true }).click();
      await section.getByRole("button", { name: "Leave this fund out" }).click();
      await section.getByText("Left out", { exact: true }).waitFor();
    };

    // A remembered PAN or folio account that tracks holdings is ignored, and its row says why. The
    // folio's own account needs choosing again, even to go with its PAN.
    const panAccount = frame.getByLabel("PAN ABCDE1234F", { exact: true });
    const fictiva = frame.getByLabel("Fictiva Mutual Fund, folio 91234567 / 12", { exact: true });
    const accountKeys = [await panAccount.getAttribute("id"), await fictiva.getAttribute("id")];
    const beforeHoldings = await storage();
    await tab.frames()[1].evaluate(([pan, folio]) => {
      window.host.storage.set(pan, "holdings-1");
      window.host.storage.set(folio, "holdings-2");
    }, accountKeys);
    await readAgain();
    const reason = ", which tracks holdings. Transactions imported there wouldn't change its holdings, so choose again.";
    await frame.getByText(`Chosen before: Demat${reason}`, { exact: true }).waitFor();
    await frame.getByText(`Chosen before: Fund folios${reason}`, { exact: true }).waitFor();
    const previewButton = frame.getByRole("button", { name: "Preview the import" });
    assert.equal(await previewButton.isDisabled(), true);
    assert.match(await panAccount.textContent(), /Choose an account/);
    await panAccount.click();
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    assert.equal(await frame.getByText(/^Chosen before: Demat/).count(), 0);
    assert.equal(await previewButton.isDisabled(), true, "the folio's own account needs choosing again");
    assert.match(await fictiva.textContent(), /Choose an account/);
    await fictiva.click();
    await frame.getByRole("option", { name: "Same as PAN (Mutual funds)" }).click();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await previewButton.isDisabled(), false);
    await tab.frames()[1].waitForFunction(([pan, folio]) =>
      window.host.storage.get(pan) === "account-1" && !window.host.storage.has(folio), accountKeys);
    assert.deepEqual(await storage(), beforeHoldings);

    // Folio bank choices override a stale PAN default, and unused defaults cannot report a conflict.
    const beforeBankValidation = await storage();
    const bankFolios = expected.folios.map((f) => frame.getByLabel(`Bank account for ${f.amc}, folio ${f.folio}`, { exact: true }));
    await tab.frames()[1].evaluate((key) => { window.host.storage.set(key, "holdings-1"); }, bankKey);
    await readAgain();
    assert.equal(await previewButton.isDisabled(), true);
    await bankFolios[0].click();
    await frame.getByRole("option", { name: "Outside Wealthfolio", exact: true }).click();
    assert.equal(await previewButton.isDisabled(), true, "the other folio still inherits the stale default");
    await bankFolios[1].click();
    await frame.getByRole("option", { name: "Savings (INR)" }).click();
    assert.equal(await previewButton.isDisabled(), false);
    await bankChoice.click();
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    assert.equal(await previewButton.isDisabled(), false);
    assert.equal(await frame.getByText(/This is also the account for the funds/).count(), 0);

    // A folio whose funds are all left out cannot block the other folio's valid import.
    await bankFolios[0].click();
    await frame.getByRole("option", { name: "Same as PAN (Mutual funds)" }).click();
    assert.equal(await previewButton.isDisabled(), true);
    for (const isin of ["INFZ90K01FC8", "INFZ90K01LQ6", "INFZ90K01BA1"]) {
      await leaveOut(frame.locator("section").filter({ hasText: `ISIN ${isin}` }));
    }
    assert.equal(await previewButton.isDisabled(), false);
    await tab.frames()[1].evaluate((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeBankValidation);
    await readAgain();
    assert.deepEqual(await storage(), beforeBankValidation);

    // Change alone keeps the saved fund, so reading again confirms it again.
    const flexi = frame.locator("section").filter({ hasText: "ISIN INFZ90K01FC8" });
    const remembered = await storage();
    await flexi.getByRole("button", { name: "Change", exact: true }).click();
    await flexi.getByRole("button", { name: "Leave this fund out" }).waitFor();
    await readAgain();
    await flexi.getByText("Fund INFZ90K01FC8").waitFor();
    assert.equal(await confirmed(), 5);
    assert.deepEqual(await storage(), remembered);

    // Leaving it out forgets only its saved fund: reading again searches for it as if it were new,
    // and keeps the other funds and the account.
    await leaveOut(flexi);
    const { "isin:INFZ90K01FC8": flexiFund, ...forgotten } = remembered;
    assert.ok(flexiFund);
    assert.deepEqual(await storage(), forgotten);
    await readAgain();
    await undecided(flexi);
    assert.equal(await confirmed(), 4);
    await frame.getByText("Same as PAN (Mutual funds)").first().waitFor();
    assert.deepEqual(await storage(), forgotten);

    // Choosing a fund after leaving it out doesn't bring the old one back; confirming another saves it.
    await flexi.getByRole("button", { name: "Leave this fund out" }).click();
    await flexi.getByRole("button", { name: "Choose a fund" }).click();
    await flexi.getByRole("radio").first().waitFor({ state: "attached" });
    assert.deepEqual(await storage(), forgotten);
    await flexi.getByLabel("Search for the fund").fill("MULTI");
    await flexi.getByLabel("Search for the fund").press("Enter");
    await flexi.getByRole("radio").nth(1).waitFor({ state: "attached" });
    await flexi.getByRole("radio").nth(1).dispatchEvent("click");
    await flexi.getByRole("button", { name: "Use this fund" }).click();
    await flexi.getByText("Confirmed", { exact: true }).waitFor();
    const chosen = await storage();
    assert.equal(JSON.parse(chosen["isin:INFZ90K01FC8"]).symbol, "B");
    // The same for the fund with no ISIN, saved under its registrar and scheme code.
    const [noIsinKey] = Object.keys(chosen).filter((key) => key.startsWith("fund:"));
    await leaveOut(noIsin);
    const { [noIsinKey]: noIsinFund, ...noIsinForgotten } = chosen;
    assert.ok(noIsinFund);
    assert.deepEqual(await storage(), noIsinForgotten);
    await readAgain();
    await flexi.getByText("Fund B").waitFor();
    await undecided(noIsin);
    await noIsin.getByText(/^No ISIN on the statement; showing results for/).waitFor();
    assert.equal(await confirmed(), 4);
    assert.deepEqual(await storage(), noIsinForgotten);

    // A deletion that fails keeps the fund saved and says it can come back; it stays left out for this read.
    assert.deepEqual(await tab.frames()[1].evaluate(() => window.host.toasts), []);
    await tab.frames()[1].evaluate(() => { window.host.failDelete = true; });
    const balanced = frame.locator("section").filter({ hasText: "ISIN INFZ90K01BA1" });
    await leaveOut(balanced);
    await tab.frames()[1].waitForFunction(() => window.host.toasts.length);
    assert.deepEqual(await tab.frames()[1].evaluate(() => window.host.toasts), [
      "Couldn't forget the fund chosen before. It can come back the next time you read a statement.",
    ]);
    assert.equal(await balanced.getByText("Left out", { exact: true }).count(), 1);
    assert.deepEqual(await storage(), noIsinForgotten);
    await tab.frames()[1].evaluate(() => {
      window.host.failDelete = false;
      window.host.toasts = [];
    });

    // A fund in two folios has one section and one saved fund, so leaving it out forgets it for both.
    await tab.frames()[1].evaluate(() => { window.host.sharedIsin = "INFZ90K01LQ6"; });
    await readAgain();
    await frame.getByText(/3 folios, 8 schemes, 83 rows\./).waitFor();
    assert.equal(await frame.locator("section").count(), 5);
    const liquid = frame.locator("section").filter({ hasText: "ISIN INFZ90K01LQ6 · in 2 folios" });
    await liquid.getByText("Confirmed", { exact: true }).waitFor();
    // The failed deletion left the Balanced Advantage fund saved, so it's back.
    await balanced.getByText("Confirmed", { exact: true }).waitFor();
    await leaveOut(liquid);
    const { "isin:INFZ90K01LQ6": liquidFund, ...unshared } = noIsinForgotten;
    assert.ok(liquidFund);
    assert.deepEqual(await storage(), unshared);
    await readAgain();
    await undecided(liquid);
    assert.equal(await confirmed(), 3);
    await frame.getByText("Same as PAN (Mutual funds)").first().waitFor();
    assert.deepEqual(await storage(), unshared);
    assert.deepEqual(await tab.frames()[1].evaluate(() => window.host.toasts), []);
    await tab.frames()[1].evaluate(() => { window.host.sharedIsin = ""; });

    // A slow deletion must finish before a later confirmation is saved.
    await pause("delete");
    await leaveOut(flexi);
    await waiting();
    await flexi.getByRole("button", { name: "Choose a fund" }).click();
    await flexi.getByRole("button", { name: "Use this fund" }).click();
    await flexi.getByText("Confirmed", { exact: true }).waitFor();
    await resume();
    await tab.frames()[1].waitForFunction(() =>
      JSON.parse(window.host.storage.get("isin:INFZ90K01FC8") ?? "null")?.symbol === "INFZ90K01FC8",
    );

    // A slow save must finish before leaving it out deletes it, and before a reread restores choices.
    await flexi.getByRole("button", { name: "Change", exact: true }).click();
    await pause("set");
    await flexi.getByRole("button", { name: "Use this fund" }).click();
    await waiting();
    await leaveOut(flexi);
    const parsed = await tab.frames()[1].evaluate(() => window.host.parsed);
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await tab.frames()[1].waitForFunction((previous) => window.host.parsed > previous, parsed, { timeout: 180_000 });
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await resume();
    await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    await undecided(flexi);
    const { "isin:INFZ90K01FC8": previousFund, ...afterSlowWrites } = unshared;
    assert.ok(previousFund);
    assert.deepEqual(await storage(), afterSlowWrites);

    // An NSDL statement's holdings go to accounts that track holdings, as snapshots.
    const hosted = (fn, arg) => tab.frames()[1].evaluate(fn, arg);
    await hosted(() => {
      window.host.parseWarnings = ["MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail"];
      window.host.failHistory = false;
      // An account tracking transactions holds the Flexi Cap fund and a short share position.
      window.host.snapshots["account-1"] = {
        "2025-03-31": {
          holdings: [
            { symbol: "INFZ90K01FC8", quantity: "10", currency: "INR" },
            { symbol: "INEZ90B01015", quantity: "-10", currency: "INR" },
          ],
          cash: {}, source: "CALCULATED",
        },
      };
      // Fund folios has a snapshot from before the statement: a fund added by hand, and cash.
      window.host.snapshots["holdings-2"] = {
        "2025-01-31": { holdings: [{ assetId: "asset-gilt", symbol: "GILT", quantity: "-10", averageCost: "100", currency: "INR", name: "Gilt fund" }], cash: { INR: "1500" } },
      };
    });
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 13 holdings.").waitFor({ timeout: 180_000 });
    await frame.getByText("casparser reported warnings", { exact: true }).waitFor();
    await frame.getByText("MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail", { exact: true }).waitFor();
    assert.equal(await frame.getByText("Bonds aren't imported yet.", { exact: false }).count(), 4);
    const choose = async (label, option) => {
      await frame.getByLabel(label).click();
      // Only accounts that track holdings.
      assert.equal(await frame.getByRole("option", { name: "Mutual funds (INR)" }).count(), 0);
      assert.equal(await frame.getByRole("option", { name: "Archived funds (INR)" }).count(), 0);
      await frame.getByRole("option", { name: option }).click();
    };
    // A delayed account A write cannot overwrite the later B choice, and a reread waits for both.
    const statementKey = await frame.getByLabel("All of this statement").getAttribute("id");
    await pause("set:holdings-1");
    await choose("All of this statement", "Demat (INR)");
    await waiting();
    await choose("All of this statement", "Fund folios (INR)");
    const parsedAccounts = await hosted(() => window.host.parsed);
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await tab.frames()[1].waitForFunction((previous) => window.host.parsed > previous, parsedAccounts, { timeout: 180_000 });
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await resume();
    await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal((await storage())[statementKey], "holdings-2");
    assert.match(await frame.getByLabel("All of this statement").textContent(), /Fund folios/);
    await choose(/^NSDL Demat Account 1,/, "Demat (INR)");
    await choose(/^CDSL Demat Account 2,/, "Demat (INR)");
    await choose(/^Folio 1040012345/, "Leave out");
    const preview = frame.getByRole("button", { name: "Preview the snapshots" });
    assert.equal(await frame.locator("section").count(), 12);
    for (const section of await frame.locator("section").all()) {
      if (await section.getByText("PLACEHOLDER PHARMA LIMITED").count()) {
        await section.getByRole("button", { name: "Leave this share out" }).click();
        continue;
      }
      const use = section.getByRole("button", { name: /^Use this (fund|share)$/ });
      await section.getByText("Confirmed", { exact: true }).or(section.getByRole("radio").first()).first().waitFor();
      if (await section.getByText("Confirmed", { exact: true }).count()) continue;
      if (await use.isDisabled()) await section.getByRole("radio").first().click();
      await use.click();
      await section.getByText("Confirmed", { exact: true }).waitFor();
    }
    // A known MANUAL asset in an inactive account is unsafe even when the target starts empty.
    await hosted(() => {
      window.host.held["archived-1"] = ["INFZ90K01LQ6"];
      window.host.pricingModes.INFZ90K01LQ6 = "MANUAL";
    });
    await preview.click();
    const demat = frame.locator("section").filter({ hasText: "Demat: snapshot of 2025-03-31" });
    const folios = frame.locator("section").filter({ hasText: "Fund folios: snapshot of 2025-03-31" });
    await demat.waitFor();
    await folios.getByText("Fund INFZ90K01LQ6 uses a manual price", { exact: true }).waitFor();
    assert.equal(await frame.getByRole("button", { name: "Save 2 snapshots" }).isDisabled(), true);
    await hosted(() => { window.host.pricingModes.INFZ90K01LQ6 = "MARKET"; });
    await preview.click();
    await folios.getByText("Fund INFZ90K01LQ6 uses a manual price", { exact: true }).waitFor({ state: "hidden" });
    await frame.getByText("PLACEHOLDER PHARMA LIMITED, CDSL Demat Account 2, TESTBRIDGE BROKING LIMITED: You left this share out.").waitFor();
    await frame.getByText(/^Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout, Folio 1040012345: Its folio or demat account is left out\.$/).waitFor();
    assert.equal(await frame.getByText("Bonds aren't imported yet.", { exact: false }).count(), 4);
    const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const rendered = await frame.locator("body").innerText();
    for (const number of nsdl.accounts.flatMap((a) => [a.dp_id, a.client_id]).filter(Boolean)) {
      assert.equal(rendered.includes(number), false, `A depository identifier is visible: ${number}`);
    }
    // Shares print no cost: typed, or blank for unknown.
    assert.equal(await demat.getByRole("row").count(), 8);
    await demat.getByText("150", { exact: true }).waitFor();
    await demat.getByText("520", { exact: true }).waitFor();
    const shortRow = demat.getByRole("row").filter({ hasText: "Fund INEZ90B01015" });
    await shortRow.getByText("Mutual funds also holds it.", { exact: true }).waitFor();
    assert.equal(await shortRow.getByRole("checkbox", { name: "Import", exact: true }).isChecked(), true);
    await demat.getByLabel("Total cost of Fund INEZ90A01017").fill("185175");
    await demat.getByLabel("Total cost of Fund INEZ90C01021").fill("abc");
    await demat.getByText("Type an amount like 12345.67, or leave it blank.").waitFor();
    const save = frame.getByRole("button", { name: "Save 2 snapshots" });
    assert.equal(await save.isDisabled(), true);
    const invalidRow = demat.getByRole("row").filter({ hasText: "Fund INEZ90C01021" });
    const invalidImport = invalidRow.getByRole("checkbox", { name: "Import", exact: true });
    await invalidImport.dispatchEvent("click");
    assert.equal(await save.isDisabled(), false);
    assert.equal(await invalidRow.getByText("Type an amount like 12345.67, or leave it blank.").count(), 0);
    await invalidImport.dispatchEvent("click");
    assert.equal(await save.isDisabled(), true);
    assert.equal(await demat.getByLabel("Total cost of Fund INEZ90C01021").inputValue(), "abc");
    await invalidRow.getByText("Type an amount like 12345.67, or leave it blank.").waitFor();
    await demat.getByLabel("Total cost of Fund INEZ90C01021").fill("");
    assert.equal(await save.isDisabled(), false);
    // The Flexi Cap fund is left out because Mutual funds holds it; the hand-added fund and the cash stay.
    const flexiRow = folios.getByRole("row").filter({ hasText: "Fund INFZ90K01FC8" });
    await flexiRow.getByText("Mutual funds already holds this fund, from its transactions. Including it here counts it twice.").waitFor();
    assert.equal(await flexiRow.getByText("Left out", { exact: true }).count(), 1);
    assert.equal(await folios.getByRole("row").filter({ hasText: "Gilt fund" }).getByText("Kept", { exact: true }).count(), 1);
    await folios.getByText("Cash carried over from the snapshot of 2025-01-31: INR 1500.").waitFor();
    await folios.getByText("Starts from the account's snapshot of 2025-01-31", { exact: false }).waitFor();
    assert.equal(await frame.getByText("Wealthfolio has later snapshots of this account", { exact: true }).count(), 0);
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    const snapshot = (id, date) => hosted(([id, date]) => window.host.snapshots[id][date], [id, date]);
    const first = await snapshot("holdings-1", "2025-03-31");
    assert.deepEqual(first.cash, {});
    assert.deepEqual(
      first.holdings.map((h) => [h.symbol, h.quantity, h.averageCost ?? null]),
      [
        ["INEZ90A01017", "150", "1234.5"],
        ["INEZ90B01015", "520", null],
        ["INEZ90C01021", "75", null],
        ["INFZ90K01NE8", "1200", null],
        ["INEZ92A01013", "200", null],
        ["INFZ91T01NF4", "1523.456", null],
        ["INFZ91T01GE1", "300", null],
      ],
    );
    const funds = await snapshot("holdings-2", "2025-03-31");
    assert.deepEqual(funds.cash, { INR: "1500" });
    assert.deepEqual(
      funds.holdings.map((h) => [h.assetId ?? h.symbol, h.quantity]),
      [
        ["asset-gilt", "-10"],
        ["INFZ90K01LQ6", "8.053"],
        ["INFZ90K01BA1", "3540.293"],
      ],
    );
    assert.equal(funds.holdings.find((h) => h.symbol === "GILT").averageCost, "100");

    // Leaving a still-listed fund out keeps both its units and the earlier import's provenance.
    await leaveOut(frame.locator("section").filter({ hasText: "ISIN INFZ90K01LQ6" }));
    await preview.click();
    await folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" }).getByText("Kept", { exact: true }).waitFor();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "INFZ90K01LQ6").quantity, "8.053");

    // Once that fund is no longer listed, the remembered import still removes it by default.
    // Replacing a snapshot on the same date needs confirming; Wealthfolio's cost carries over.
    await hosted(() => { window.host.soldIsins = ["INFZ90K01LQ6"]; });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 12 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await preview.click();
    await demat.waitFor();
    const sold = folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" });
    await sold.getByText("Not on the statement any more. An earlier import of Folio 91234567/12 added it.").waitFor();
    assert.equal(await sold.getByText("Removed", { exact: true }).count(), 1);
    assert.equal(await demat.getByLabel("Total cost of Fund INEZ90A01017").inputValue(), "185175");
    await demat.getByText("From the account's average cost in Wealthfolio").waitFor();
    assert.equal(await save.isDisabled(), true);
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual(
      (await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.assetId ?? h.symbol),
      ["asset-gilt", "asset-INFZ90K01BA1"],
    );
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].averageCost, "1234.5");
    // An empty demat account still reconciles its sold holdings. Manual assets with known cost
    // block Save: an editable statement cost can be cleared; a kept holding must be removed.
    await hosted(() => {
      window.host.soldIsins.push("INEZ90A01017", "INEZ90B01015", "INEZ90C01021", "INFZ90K01NE8");
      const share = window.host.snapshots["holdings-1"]["2025-03-31"].holdings.find((h) => h.symbol === "INEZ92A01013");
      window.host.pricingModes.INEZ92A01013 = "MANUAL";
      share.averageCost = "12";
      const gilt = window.host.snapshots["holdings-2"]["2025-03-31"].holdings.find((h) => h.symbol === "GILT");
      window.host.pricingModes.GILT = "MANUAL";
      gilt.averageCost = "3";
    });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 7 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await frame.getByLabel(/^NSDL Demat Account 1,/).getByText("Demat (INR)").waitFor();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).getByText("Removed", { exact: true }).waitFor();
    await demat.getByRole("row").filter({ hasText: "Fund INFZ90K01NE8" }).getByText("Removed", { exact: true }).waitFor();
    await demat.getByText("Fund INEZ92A01013 uses a manual price", { exact: true }).waitFor();
    await folios.getByText("Fund GILT uses a manual price", { exact: true }).waitFor();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), true);
    await demat.getByLabel("Total cost of Fund INEZ92A01013").fill("");
    assert.equal(await save.isDisabled(), true);
    await folios.getByRole("row").filter({ hasText: "Fund GILT" }).getByRole("checkbox", { name: "Keep", exact: true }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), false);
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual((await snapshot("holdings-1", "2025-03-31")).holdings.map((h) => h.symbol), ["INEZ92A01013", "INFZ91T01NF4", "INFZ91T01GE1"]);
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].averageCost, undefined);
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.symbol), ["INFZ90K01BA1"]);
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).cash, { INR: "1500" });
    assert.equal(await hosted(() => window.host.pricingModes.INEZ92A01013), "MANUAL");

    // The target's current, later snapshot can expose a MANUAL asset absent from the baseline.
    await hosted(() => {
      const other = window.host.snapshots["account-1"]["2025-03-31"];
      other.holdings = other.holdings.filter((h) => h.symbol !== "INEZ90B01015");
      window.host.soldIsins = window.host.soldIsins.filter((isin) => isin !== "INEZ90B01015");
      window.host.pricingModes.INEZ90B01015 = "MANUAL";
      window.host.snapshots["holdings-1"]["2025-04-30"] = {
        holdings: [{ symbol: "INEZ90B01015", quantity: "100", currency: "INR", averageCost: "20" }], cash: {},
      };
    });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 9 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await preview.click();
    await demat.getByLabel("Total cost of Fund INEZ90B01015").fill("1000");
    await demat.getByText("Fund INEZ90B01015 uses a manual price", { exact: true }).waitFor();
    const manualShare = frame.locator("section").filter({ hasText: "ISIN INEZ90B01015" });
    await manualShare.getByRole("button", { name: "Change", exact: true }).click();
    await manualShare.getByRole("button", { name: "Use this share" }).click();
    await manualShare.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(JSON.parse((await storage())["isin:INEZ90B01015"]).manual, undefined);
    // With no observed holding left, the current search result still carries its MANUAL mode.
    const laterSnapshot = await snapshot("holdings-1", "2025-04-30");
    await hosted(() => { delete window.host.snapshots["holdings-1"]["2025-04-30"]; });
    await preview.click();
    await demat.getByLabel("Total cost of Fund INEZ90B01015").fill("1000");
    await demat.getByText("Fund INEZ90B01015 uses a manual price", { exact: true }).waitFor();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), true);
    // A live mode change overrides the mode the search result supplied earlier.
    await hosted((later) => {
      window.host.snapshots["holdings-1"]["2025-04-30"] = later;
      window.host.pricingModes.INEZ90B01015 = "MARKET";
    }, laterSnapshot);
    await preview.click();
    await demat.getByLabel("Total cost of Fund INEZ90B01015").fill("1000");
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), false);
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-04-30")).holdings[0].averageCost, "20");

    // Archived accounts are absent from portfolio.getHoldings, but their saved assets still use
    // their global pricing mode. Reload the account inventory after archiving the hidden account.
    await hosted((isins) => {
      window.host.soldIsins = isins.filter((isin) => isin !== "INEZ90A01017");
      window.host.archiveOtherAccount = true;
      window.host.pricingModes.INEZ90A01017 = "MANUAL";
      window.host.snapshots["archived-1"] = {
        "2025-03-31": { holdings: [{ symbol: "INEZ90A01017", quantity: "1", averageCost: "20", currency: "INR" }], cash: {}, source: "CALCULATED" },
      };
      window.host.reopen();
    }, nsdl.accounts.flatMap((a) => [...a.equities, ...a.mutual_funds].map((h) => h.isin)));
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Confirmed", { exact: true }).waitFor({ timeout: 180_000 });
    await preview.click();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31" }).dispatchEvent("click");
    const saveOne = frame.getByRole("button", { name: "Save 1 snapshot", exact: true });
    assert.equal(await saveOne.isDisabled(), false);
    await demat.getByLabel("Total cost of Fund INEZ90A01017").fill("1500");
    await demat.getByText("Fund INEZ90A01017 uses a manual price", { exact: true }).waitFor();
    assert.equal(await saveOne.isDisabled(), true);

    // Exclusions are visible even when the statement has nothing that could reach a preview.
    await hosted(() => { window.host.onlyNps = true; });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Test NPS Scheme, National Pension System: NPS holdings aren't imported yet.", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await preview.isDisabled(), true);
    assert.equal(await frame.getByText("Preview", { exact: true }).count(), 0);
    await hosted(() => {
      window.host.soldIsins = [];
      window.host.parseWarnings = [];
      window.host.onlyNps = false;
    });
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-summary-cams.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Check each folio's funds and AMC against the PDF. The parser can merge equal folio numbers across AMCs without a warning.", { exact: true }).waitFor({ timeout: 180_000 });
    // A folio with funds from two issuers, as the parser returns two AMCs' folios with one number, still reads.
    await hosted(() => { window.host.ambiguousSummary = true; });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("CAMS summary statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 folios, 6 holdings.", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await frame.getByRole("button", { name: "Preview the snapshots" }).count(), 1);
    await hosted(() => { window.host.ambiguousSummary = false; });

    await frame.getByRole("button", { name: "Forget the saved password" }).click();
    await frame.getByRole("button", { name: "Forget the saved password" }).waitFor({ state: "hidden" });
    assert.deepEqual((await host()).secrets, []);
  } catch (error) {
    failed = true;
    console.log(`  FAILED: ${error.stack}`);
  }
  // Pyodide refuses a classic Worker when its importScripts("data:...") probe works, which the CSP
  // would otherwise be all that prevents.
  try {
    await tab.goto("http://sandbox.test/no-csp");
    await tab.waitForFunction(() => window.result, null, { timeout: 180_000 });
    const { data, error } = await tab.evaluate(() => window.result);
    assert.equal(error, undefined);
    assert.deepEqual(data, expected);
  } catch (error) {
    failed = true;
    console.log(`  FAILED without the CSP: ${error.stack}`);
  }
  // Playwright passes on no CSP messages from a Chromium Worker; the run without the CSP covers it.
  if (violations.length) {
    failed = true;
    console.log("  FAILED: CSP messages:", violations);
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
