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
// header, which would garble the harness's non-ASCII text and so break its CSP hash. Still so in
// Playwright 1.64.1 (microsoft/playwright#43649).
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
  const errors = [];
  tab.on("console", (message) => {
    if (/Content.Security.Policy|Refused/i.test(message.text())) violations.push(message.text());
    if (message.type() === "error") errors.push(message.text());
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
    const hosted = (fn, arg) => tab.frames()[1].evaluate(fn, arg);
    // The fake host's accounts. The add-on sees a change on its next read.
    const accountList = () => tab.frames()[1].evaluate(() => window.host.accounts);
    const setAccountList = (accounts) => tab.frames()[1].evaluate((accounts) => { window.host.accounts = accounts; }, accounts);
    // Changes accounts by ID, adding any that isn't listed.
    const editAccounts = (changes) => tab.frames()[1].evaluate((changes) => {
      for (const [id, fields] of Object.entries(changes)) {
        const account = window.host.accounts.find((a) => a.id === id);
        if (account) Object.assign(account, fields);
        else window.host.accounts.push({ id, currency: "INR", isActive: true, isArchived: false, ...fields });
      }
    }, changes);
    const remember = frame.getByRole("checkbox", { name: "Remember the password" });
    const readButton = frame.getByRole("button", { name: "Read statement", exact: true });
    const passwordBox = frame.locator("#cas-password");
    // A control pressed with the keyboard that goes away hands the focus to what takes its place. One
    // that stays while the page is locked gets it back once the page is unlocked.
    const focused = async (locator, what) => {
      await locator.waitFor({ state: "attached" });
      const element = await locator.elementHandle();
      try {
        await tab.frames()[1].waitForFunction((element) => document.activeElement === element, element, { timeout: 5_000 });
      } catch {
        const active = await tab.frames()[1].evaluate(() =>
          document.activeElement === document.body ? "<body>" : document.activeElement?.outerHTML.slice(0, 150));
        assert.fail(`${what}: the focus is on ${active}`);
      }
    };
    // A click outside the add-on while the page is locked, such as on Wealthfolio's own menu, keeps
    // the focus there once the page is unlocked, as it would on Wealthfolio's own pages.
    const clickOutside = async () => {
      const frameBox = await tab.locator("iframe").boundingBox();
      // Beside the frame, near the top of the window: the page scrolls when the frame is taller than
      // the window, and a click above the window is lost.
      await tab.mouse.click(frameBox.x + frameBox.width + 20, 20);
      assert.equal(await tab.frames()[1].evaluate(() => document.hasFocus()), false);
    };
    const stayedOutside = async (what) => {
      assert.equal(await tab.evaluate(() => document.activeElement.tagName), "BODY", what);
      assert.equal(await tab.frames()[1].evaluate(() => document.hasFocus()), false, what);
    };
    const amfiBanner = frame.getByRole("alert").filter({ hasText: /^Add AMFI prices first/ });
    const checkAgain = amfiBanner.getByRole("button", { name: "Check again" });
    // What Check again found, which stays when the banner goes.
    const amfiOutcome = frame.locator("fieldset > [role=status]");
    const fileInput = frame.locator("#cas-file");
    // Shows the same mounted page again, as when it's opened again in Wealthfolio.
    const revisit = () => hosted(() => window.host.revisit());
    const providerChecks = () => hosted(() => window.host.providerChecks);
    // A slow secret load cannot override an editable Remember opt-out.
    await waiting();
    assert.equal(await remember.getAttribute("aria-checked"), "false");
    assert.equal(await remember.isDisabled(), true);
    assert.equal(await frame.locator("#cas-password").isDisabled(), true);
    await tab.frames()[1].evaluate(() => window.host.secrets.set("statement-password", "saved-password"));
    // The banner can go away while the form is locked. Its focus handoff waits for the file input.
    await amfiBanner.getByRole("button", { name: "Continue without AMFI" }).press("Enter");
    await amfiBanner.waitFor({ state: "detached" });
    await resume();
    await frame.locator("#cas-file:enabled").waitFor();
    await focused(fileInput, "Continue without AMFI during password loading");
    await frame.getByRole("button", { name: "Forget the saved password" }).click();
    assert.equal(await remember.getAttribute("aria-checked"), "false");
    assert.deepEqual((await host()).secrets, []);
    // A statement without a password reads with the box left empty, so a file is all Read statement
    // needs; one with a password then says it's wrong.
    const hint = await frame.locator("#cas-password").getAttribute("aria-describedby");
    assert.equal(await frame.locator(`#${hint}`).textContent(), "Leave it empty for a statement without a password.");
    assert.equal(await frame.getByRole("button", { name: "Read statement", exact: true }).isDisabled(), true);

    // AMFI is off, as in a new profile. Before a statement is read, one banner at the top of the page
    // asks to add it.
    await revisit();
    await amfiBanner.waitFor();
    assert.equal(await amfiBanner.locator("[data-slot=alert-title]").textContent(), "Add AMFI prices first");
    assert.equal(
      await amfiBanner.locator("[data-slot=alert-description] p").textContent(),
      "AMFI gives official names and daily NAVs for most Indian mutual funds. Without it, many funds only have Yahoo's abbreviated names.",
    );
    assert.deepEqual(await amfiBanner.getByRole("button").allTextContents(), ["Open Market data settings", "Check again", "Continue without AMFI"]);
    assert.equal(await frame.locator("fieldset").first().locator("xpath=*[1]").getAttribute("data-slot"), "alert", "the banner comes first");
    assert.equal(await amfiOutcome.textContent(), "");
    // Add-ons can't turn a provider on, so the banner opens Wealthfolio's page where AMFI is added.
    await amfiBanner.getByRole("button", { name: "Open Market data settings" }).click();
    await tab.frames()[1].waitForFunction(() => window.host.navigations.length > 0);
    assert.deepEqual(await hosted(() => window.host.navigations), ["/settings/market-data"]);
    // Check again says what it found, cleared while it checks so the same outcome is read out again.
    // While AMFI is off, the banner and the focus stay.
    for (let i = 0; i < 2; i++) {
      await pause("providers");
      await checkAgain.press("Enter");
      await waiting();
      assert.equal(await amfiOutcome.textContent(), "");
      await resume();
      await amfiOutcome.getByText("AMFI is still off.", { exact: true }).waitFor();
      await focused(checkAgain, "Check again, AMFI still off");
    }
    // Continue without AMFI hides the banner until the page is opened again. The focus goes to the form below it.
    await amfiBanner.getByRole("button", { name: "Continue without AMFI" }).press("Enter");
    await amfiBanner.waitFor({ state: "detached" });
    await focused(fileInput, "Continue without AMFI");
    assert.equal(await amfiOutcome.textContent(), "");
    // A handoff waiting for the form to unlock must respect focus moved outside in the meantime.
    await pause("password");
    await hosted(() => window.host.reopen());
    await waiting();
    await amfiBanner.waitFor();
    assert.equal(await fileInput.isDisabled(), true);
    await amfiBanner.getByRole("button", { name: "Continue without AMFI" }).press("Enter");
    await amfiBanner.waitFor({ state: "detached" });
    await clickOutside();
    await resume();
    await frame.locator("#cas-file:enabled").waitFor();
    await stayedOutside("Continue without AMFI, focus moved before password loaded");
    await fileInput.focus();
    await revisit();
    await amfiBanner.waitFor();
    // Without AMFI's entry, without its flag, or when the providers can't be read, Wealthfolio doesn't
    // say whether AMFI is on, and there's no banner.
    for (const mode of ["fail", "no-flag", "no-amfi"]) {
      await hosted((mode) => { window.host.providers = mode; }, mode);
      await checkAgain.press("Enter");
      await amfiBanner.waitFor({ state: "detached" });
      await focused(fileInput, `Check again, ${mode}`);
      assert.equal(await amfiOutcome.textContent(), "Couldn't check whether AMFI is on.", mode);
      await hosted(() => { window.host.providers = ""; });
      await revisit();
      await amfiBanner.waitFor();
      assert.equal(await amfiOutcome.textContent(), "", "opened again, the page says nothing about checks before");
    }
    // Once AMFI is on, there's no banner either, opened again too.
    await hosted(() => { window.host.amfi = true; });
    await checkAgain.press("Enter");
    await amfiBanner.waitFor({ state: "detached" });
    await focused(fileInput, "Check again, AMFI on");
    assert.equal(await amfiOutcome.textContent(), "AMFI is on.");
    let checks = await providerChecks();
    await revisit();
    await tab.frames()[1].waitForFunction((n) => window.host.providerChecks > n, checks);
    assert.equal(await providerChecks(), checks + 1, "opened again, the page checks again");
    assert.equal(await amfiOutcome.textContent(), "");
    assert.equal(await amfiBanner.count(), 0);
    // When the window gets the focus while AMFI isn't on, the add-on checks again by itself, and says
    // nothing when it's still off.
    await hosted(() => { window.host.amfi = false; });
    await revisit();
    await amfiBanner.waitFor();
    for (const amfiOn of [false, true]) {
      await clickOutside();
      await hosted((on) => { window.host.amfi = on; }, amfiOn);
      checks = await providerChecks();
      await frame.getByRole("heading", { name: "CAS Importer (India)" }).click();
      await tab.frames()[1].waitForFunction((n) => window.host.providerChecks > n, checks);
    }
    await amfiBanner.waitFor({ state: "detached" });
    assert.equal(await amfiOutcome.textContent(), "");
    // Once it's on, it doesn't.
    await clickOutside();
    checks = await providerChecks();
    await frame.getByRole("heading", { name: "CAS Importer (India)" }).click();
    assert.equal(await providerChecks(), checks);
    // The detailed statement's checks below run with Wealthfolio not saying whether AMFI is on, so the
    // Funds card keeps its note.
    await hosted(() => {
      window.host.amfi = false;
      window.host.providers = "fail";
    });
    checks = await providerChecks();
    await revisit();
    await tab.frames()[1].waitForFunction((n) => window.host.providerChecks > n, checks);

    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    assert.equal(await frame.locator("#cas-password").inputValue(), "");
    await readButton.press("Enter");
    await frame.locator("#cas-file:disabled").waitFor();
    assert.equal(await frame.locator("#cas-password").isDisabled(), true);
    await frame.getByText("Wrong password", { exact: true }).waitFor({ timeout: 180_000 });
    await focused(readButton, "Read statement, failed");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    // Unstyled here, so the checkbox has no width to click on.
    await remember.dispatchEvent("click");
    assert.equal(await remember.getAttribute("aria-checked"), "true");
    await pause("storage");
    // Enter in PDF password reads the statement too.
    await passwordBox.press("Enter");
    await waiting();
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await frame.getByRole("button", { name: "Reading…", exact: true }).isDisabled(), true);
    assert.equal(await frame.getByRole("heading", { name: /^Transactions, / }).count(), 0);
    await resume();
    await frame.getByRole("heading", { name: "Transactions, 1 Apr 2023 to 31 Mar 2025", exact: true }).waitFor({ timeout: 180_000 });
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);

    // A detailed statement's transactions go to accounts that track transactions, on one Review
    // screen: where they go, what needs an answer, what will be imported and what won't, and one button.
    // The funds on the made-up detailed statement that aren't closed, as it prints them.
    const detailed = {
      flexi: "Fictiva Flexi Cap Fund - Direct Plan - Growth",
      liquid: "Fictiva Liquid Fund - Direct Plan - Growth",
      balanced: "Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment",
      corporate: "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout",
      overnight: "Testbridge Overnight Fund - Direct Plan - Growth",
    };
    const investor = "ANANYA R TESTWALA";
    const fictivaFolio = "Fictiva Mutual Fund folio 91234567 / 12";
    const testbridgeFolio = "Testbridge Mutual Fund folio 1040012345";
    const transactionsHeading = frame.getByRole("heading", { name: /^Transactions, / });
    const dFooter = frame.locator("div.sticky.bottom-0");
    // The footer's summary, which takes the focus once every question is answered.
    const dSummary = dFooter.locator("[tabindex='-1']");
    const dSaid = frame.locator("p[role=status]");
    const importButton = dFooter.getByRole("button", { name: /^Import( \d+ transactions?)?$/ });
    const literal = (text) => text.replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const storage = async () => Object.fromEntries((await host()).storage);
    const saveChoices = (choices) => hosted((choices) => {
      for (const [key, id] of choices) window.host.storage.set(key, id);
    }, choices);
    const restoreChoices = (saved) => hosted((saved) => { window.host.storage = new Map(Object.entries(saved)); }, saved);
    // The window is taller than the frame, so a select's list opened near the frame's bottom stays in view.
    const sizeFrame = async (width) => {
      await tab.setViewportSize({ width: 1280, height: 1000 });
      await tab.evaluate((width) => {
        Object.assign(document.querySelector("iframe").style, { width: `${width}px`, height: "900px" });
      }, width);
    };
    // Lets React render what a click or a host change started.
    const painted = () => hosted(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Waits until each fund is looked up and what will be imported is worked out.
    const dSettled = async () => {
      await painted();
      await dFooter.getByText(/^Looking up \d+ funds?…$/).waitFor({ state: "detached" });
      await frame.getByRole("heading", { name: "Transactions in this statement", exact: true }).waitFor();
    };
    // Leaves the review for the file form, discarding what it changed.
    const leaveDetailed = async () => {
      const another = frame.getByRole("button", { name: "Use another file", exact: true });
      if (!(await another.count())) return;
      await another.click();
      const discard = frame.getByRole("button", { name: "Discard and choose another file" });
      if (await discard.count()) await discard.click();
      await transactionsHeading.waitFor({ state: "detached" });
    };
    const readStatement = async (file = "tests/fixtures/made-up-cas.pdf") => {
      await leaveDetailed();
      await frame.locator("#cas-file").setInputFiles(file);
      await frame.locator("#cas-password").fill("ABCDE1234F");
      await readButton.click();
      await transactionsHeading.waitFor({ timeout: 180_000 });
      await dSettled();
    };
    // Save to: a box per PAN, named by its investor, with Save part of it to another account for its folios.
    const fundsSelect = (who = investor) => frame.getByRole("combobox", { name: `${who}'s funds`, exact: true });
    const fundsBox = (who = investor) => frame.getByRole("group", { name: `${who}'s funds`, exact: true });
    // The bank account's select, named for its box.
    const bankSelect = (title = `${investor}'s funds`) =>
      frame.getByRole("combobox", { name: new RegExp(`^Bank account for purchases and payouts \\(optional\\)\\s*:\\s*${literal(title)}$`) });
    const folioSelect = (folio) => frame.getByRole("combobox", { name: new RegExp(`^${literal(folio)}( · \\d+ funds?)?$`) });
    const folioBankSelect = (folio) => frame.getByRole("combobox", { name: `Bank account for ${folio}`, exact: true });
    const partToggle = (title = `${investor}'s funds`) => frame.getByRole("button", { name: `Save part of it to another account: ${title}`, exact: true });
    const openPart = async (title) => {
      const toggle = partToggle(title);
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    };
    const pickOption = async (select, option) => {
      await select.click();
      await frame.getByRole("option", { name: option, exact: true }).click();
      await dSettled();
    };
    const chooseAgain = (account) => `Chosen before: ${account}, so choose again.`;
    const unavailable = chooseAgain;
    const missing = chooseAgain("an account that's no longer available");
    // Questions for you: a card per fund still to confirm, found by the name the statement prints.
    const fundQuestion = (name) => frame.locator("section section").filter({ hasText: new RegExp(`On your statement: ${literal(name)} ·`) });
    const fundQuestions = frame.locator("section section").filter({ has: frame.getByRole("heading", { name: "Which fund is this?", exact: true }) });
    const statementNameOf = async (card) =>
      (await card.locator("p").first().innerText()).replace(/^On your statement:\s*/, "").replace(/\s+·.*$/s, "");
    // Answers a fund's question with its only result, a result picked by position, or Skip.
    const useResult = async (name, how = 0) => {
      const card = fundQuestion(name);
      await card.getByText(/Searching…/).waitFor({ state: "detached" });
      if (how === "skip") {
        await card.getByRole("button", { name: /^Skip this fund: / }).click();
      } else {
        const single = card.getByRole("button", { name: /^Use this fund: / });
        if (await single.count()) {
          await single.click();
        } else {
          await card.getByRole("radio").nth(how).dispatchEvent("click");
          await card.getByRole("button", { name: /^Use this fund for / }).click();
        }
      }
      await card.waitFor({ state: "detached" });
    };
    const answerFunds = async (how = () => 0) => {
      while (await fundQuestions.count()) {
        const name = await statementNameOf(fundQuestions.first());
        await useResult(name, how(name));
      }
      await dSettled();
    };
    // Ready to import: a row per fund in an account, with Change named for it.
    const readyFund = (text) => frame.getByRole("row").filter({ has: frame.getByRole("button", { name: /^Change: / }) }).filter({ hasText: text });
    const readyFunds = frame.getByRole("row").filter({ has: frame.getByRole("button", { name: /^Change: / }) });
    // Each cell's text, its lines apart: the harness has no CSS to put them on lines of their own.
    const cellsOf = (rows) => rows.evaluateAll((all) => all.map((row) => [...row.querySelectorAll("td")].map((td) =>
      [...td.childNodes].map((node) => node.textContent.trim()).filter(Boolean).join(" "))));
    const transactionsBox = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "Transactions in this statement", exact: true }) });
    const transactionParts = () => transactionsBox.locator("p").nth(1).innerText();
    const notIncluded = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "Not included in this import", exact: true }) });
    const beforeImporting = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "Before importing", exact: true }) });
    // See every transaction: today's activity table, read-only, above the footer.
    const everyTable = frame.getByRole("table", { name: "Every transaction on this statement", exact: true });
    const seeEvery = async () => {
      const toggle = dFooter.getByRole("button", { name: "See every transaction", exact: true });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await everyTable.waitFor();
    };
    const resultUnits = () => frame.locator("table").last().locator("tbody tr");
    const imported = (count) => frame.getByText(new RegExp(`^Imported ${count ?? "(\\d+)"} of ${count ?? "\\1"} activit(y|ies)`));
    const badges = (locator) => locator.locator("[data-slot=badge]").evaluateAll((all) => all.map((b) => `${b.textContent} ${b.dataset.variant}`));
    const inUsd = "The statement's prices and amounts are in rupees, but this asset is quoted in USD. Check that it's the right listing.";
    const quotedIn = (locator) => locator.getByText(/^The statement's prices and amounts are in rupees, but /);
    await sizeFrame(1000);
    await dSettled();

    // The heading says which transactions, from which statement and file. While a statement is
    // reviewed, its file form and the page's AMFI banner make way for it.
    await frame.getByText(`CAMS statement · ${investor} · made-up-cas.pdf`, { exact: true }).waitFor();
    assert.equal(await frame.locator("#cas-file").isVisible(), false);
    assert.equal(await amfiBanner.count(), 0);
    // Closed schemes need no account or fund: no question, row or count for them.
    assert.equal(await frame.getByText(/Midcap|Gilt/).count(), 0);
    await frame.getByText("5 funds", { exact: true }).waitFor();
    const questionChip = frame.getByRole("button", { name: /^\d+ questions?$/ });
    assert.equal(await questionChip.textContent(), "6 questions");
    assert.equal(await fundQuestions.count(), 5);
    // Wealthfolio doesn't say whether AMFI is on, so the funds whose ISIN found nothing on AMFI say so once.
    await frame.getByText(/^AMFI may not be added, so 4 funds were only searched on Yahoo Finance and need you\. Add AMFI to match them for you\.$/).waitFor();
    // Nothing is remembered until the import.
    assert.deepEqual((await host()).storage, []);

    // The PAN's box offers only active, unarchived accounts that track transactions, which in
    // Wealthfolio include NOT_SET, a new account, numbered past the Mutual funds Wealthfolio has, or
    // not importing them. With accounts that fit, the new one isn't preselected.
    assert.match(await fundsSelect().textContent(), /Choose an account/);
    await dFooter.getByText("6 questions left before importing.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Go to the next question" }).click();
    await focused(fundsSelect(), "Go to the next question, the account first");
    await fundsSelect().click();
    await frame.getByRole("option", { name: "Not set (INR)" }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["Mutual funds (INR)", "Savings (INR)", "Not set (INR)", "New: Mutual funds 2", "Don't import them"]);
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    await dSettled();
    // Its bank account is optional, None at first, and says what it's for.
    assert.equal((await bankSelect().textContent()).trim(), "None: don't add bank transfers");
    const bankHint = await bankSelect().getAttribute("aria-describedby");
    assert.equal(await frame.locator(`[id="${bankHint}"]`).textContent(), "Purchases transfer from this account; sales and cash dividends transfer back to it.");
    await frame.getByText("Used again for your next statement.", { exact: true }).waitFor();

    // Each fund's question asks which fund it is; answering one moves the focus to the next one's
    // heading, and the last answer to the footer's summary.
    await dFooter.getByText("5 questions left before importing.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Go to the next question" }).click();
    await focused(fundQuestion(detailed.flexi).getByRole("heading"), "Go to the next question");
    await fundQuestion(detailed.flexi).getByText(/· Direct plan · Growth · 2,892\.104 units$/).waitFor();
    const order = [detailed.flexi, detailed.liquid, detailed.balanced, detailed.corporate, detailed.overnight];
    for (const [i, name] of order.entries()) {
      await fundQuestion(name).getByRole("button", { name: `Use this fund: Fund ${["INFZ90K01FC8", "INFZ90K01LQ6", "INFZ90K01BA1", "0P0000TBCB", "0P0000TONF"][i]}, for ${name}`, exact: true }).press("Enter");
      if (i < order.length - 1) await focused(fundQuestion(order[i + 1]).getByRole("heading"), `answering ${name}`);
    }
    await focused(dSummary, "the last answer");
    await dSaid.getByText("All questions answered. Ready to import.", { exact: true }).waitFor();
    await dSettled();
    const detailedSearches = await hosted(() => window.host.searches);
    assert.ok(!detailedSearches.some((query) => /INFZ90K01MC|INFZ91T01GL/.test(query)), detailedSearches.join(" "));
    assert.ok(detailedSearches.includes("INFZ91T01CB6") && detailedSearches.includes("Testbridge Corporate Bond"), detailedSearches.join(" "));
    assert.ok(detailedSearches.includes("Testbridge Overnight"), detailedSearches.join(" "));
    assert.ok(!detailedSearches.some((query) => query.includes(" - ")), "full scheme names are never searched");
    assert.deepEqual((await host()).storage, [], "still nothing remembered");

    // Ready to import: each fund with new transactions, its price source and Change, its new
    // transactions and its units after the import.
    await frame.getByRole("heading", { name: "Ready to import (4)", exact: true }).waitFor();
    assert.deepEqual(await cellsOf(readyFunds), [["3", "8.053"], ["4", "3,540.293"], ["4", "9,511.738"], ["2", "10.201"]]);
    assert.deepEqual(await frame.getByRole("columnheader").allTextContents(), ["Fund", "New transactions", "Units after import"]);
    const liquidFundRow = readyFund("Fund INFZ90K01LQ6");
    await liquidFundRow.getByText(`On your statement: ${detailed.liquid}`, { exact: true }).waitFor();
    await liquidFundRow.getByText(/^Prices from FAKE · chosen by you · Change$/).waitFor();
    await liquidFundRow.getByRole("button", { name: "Change: Fund INFZ90K01LQ6", exact: true }).waitFor();
    // The Flexi Cap fund starts with units Wealthfolio doesn't have, so its transactions wait, with How to fix.
    const earlier = notIncluded.locator("div.rounded-lg").filter({ hasText: /^Earlier purchases needed/ });
    assert.equal(
      (await earlier.locator("span").first().innerText()).replace(/\s+/g, " "),
      "Earlier purchases needed: Fund INFZ90K01FC8 starts with 1,250.000 units bought before this statement, so its 26 transactions wait.",
    );
    await earlier.getByRole("button", { name: "How to fix: Fund INFZ90K01FC8", exact: true }).click();
    await earlier.getByText(
      "Read an earlier CAMS statement that includes its first purchase, or add the 1,250.000 units in Wealthfolio as a buy with their cost and date. Then read this statement again: transactions already imported are skipped.",
      { exact: true },
    ).waitFor();
    // The statement's transactions, by what happens to them; the parts add up.
    assert.equal((await transactionsBox.locator("p").first().innerText()).trim(), "39 transactions, Apr 2023 to Mar 2025");
    assert.equal(await transactionParts(), "13 to import · 26 waiting for earlier purchases");
    await frame.getByText("5 funds", { exact: true }).waitFor();
    await frame.getByText("4 ready", { exact: true }).waitFor();
    await frame.getByText("1 not included", { exact: true }).waitFor();
    assert.equal(await questionChip.count(), 0);
    await dFooter.getByText("Import 13 transactions for 4 funds into Mutual funds.", { exact: true }).waitFor();
    assert.equal(await importButton.textContent(), "Import 13 transactions");
    // See every transaction opens today's table, read-only.
    await seeEvery();
    const liquidPurchase = everyTable.getByRole("row").filter({ hasText: "2023-05-05" }).filter({ hasText: detailed.liquid });
    assert.deepEqual((await liquidPurchase.locator("td").allTextContents()).map((t) => t.trim()).slice(0, 9), [
      "2023-05-05", detailed.liquid, "purchase", "9.747", "2564.8812", "1.25", "25001.1470564", "deposit 25001.1470564", "New",
    ]);
    assert.equal(await everyTable.getByRole("checkbox").count(), 0, "read-only");

    // A failed import keeps the review, and says why.
    await hosted(() => { window.host.failImport = true; });
    await importButton.click();
    await frame.getByText("The import failed: Error: Import unavailable", { exact: true }).waitFor();
    await transactionsHeading.waitFor();
    await hosted(() => { window.host.failImport = false; });
    // While it imports, the page is locked and the status says so; the result takes the focus.
    await pause("import");
    await importButton.press("Enter");
    await waiting();
    await dSaid.getByText("Importing…", { exact: true }).waitFor();
    assert.equal(await dFooter.getByRole("button", { name: "Importing…" }).isDisabled(), true);
    assert.equal(await fundsSelect().isDisabled(), true);
    await resume();
    await imported(23).waitFor();
    await focused(frame.getByRole("alert").filter({ hasText: /^Imported 23 of 23 activities/ }), "Import 13 transactions");
    // The closing units of the funds it imported into, each matching the statement.
    assert.equal(await resultUnits().count(), 4);
    assert.equal(await resultUnits().filter({ hasText: "Match" }).count(), 4);
    assert.deepEqual(
      await frame.locator("table").last().getByRole("columnheader").allTextContents(),
      ["Fund", "Units in the statement", "Units in Wealthfolio", "Status"],
    );
    // Remembered once imported: the PAN's account and the five funds, with no PAN or folio number in a key.
    const firstChoices = await storage();
    const firstKeys = Object.keys(firstChoices);
    assert.equal(firstKeys.length, 6, firstKeys.join(" "));
    assert.ok(firstKeys.every((key) => /^(pan|fund):[0-9a-f]{64}$|^isin:INFZ9/.test(key)), firstKeys.join(" "));
    assert.ok(firstKeys.every((key) => /^[A-Za-z0-9_.:-]{1,128}$/.test(key)));
    for (const folio of expected.folios) {
      assert.ok(!JSON.stringify(firstChoices).includes(folio.folio));
      assert.ok(!folio.PAN || !JSON.stringify(firstChoices).includes(folio.PAN));
    }
    const panKey = await hosted(() => [...window.host.storage.keys()].find((key) => key.startsWith("pan:")));
    assert.equal(firstChoices[panKey], "account-1");
    const allImported = await hosted(() => window.host.activities);

    // Read again, everything is in Wealthfolio: nothing is new, and Finish leaves the review.
    await readStatement();
    await frame.getByText("Chosen last time.", { exact: true }).waitFor();
    assert.match(await fundsSelect().textContent(), /^Mutual funds \(INR\)$/);
    assert.equal(await fundQuestions.count(), 0);
    await frame.getByRole("heading", { name: "Ready to import (0)", exact: true }).waitFor();
    // A line for each fund with nothing new, with Change.
    const nothingNewLines = async () => (await frame.getByText(/^Nothing new for /).allTextContents()).map((text) => text.replace(/\s*Change$/, ""));
    assert.deepEqual(await nothingNewLines(), ["Fund INFZ90K01LQ6", "Fund INFZ90K01BA1", "Fund 0P0000TBCB", "Fund 0P0000TONF"].map((name) => `Nothing new for ${name}.`));
    await frame.getByRole("button", { name: `Change: ${detailed.liquid}, nothing new`, exact: true }).waitFor();
    assert.equal(await transactionParts(), "13 imported before, skipped · 26 waiting for earlier purchases");
    await dFooter.getByText("Nothing is ready to import. See the transactions left out or waiting above.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Finish", exact: true }).click();
    await frame.getByText("Finished: nothing from made-up-cas.pdf was imported.", { exact: true }).waitFor();
    await transactionsHeading.waitFor({ state: "detached" });
    assert.deepEqual(await storage(), firstChoices);

    // Activities show an asset's display code: each fund goes by the symbol and exchange on its
    // asset's profile, which must still be the fund's, with its type. Wealthfolio's reads are kept until
    // the page is opened again or Try again.
    const renameFunds = (prefix) => hosted((prefix) => {
      for (const a of window.host.activities) if (a.assetId) a.assetSymbol = `${prefix}${a.symbol}`;
    }, prefix);
    const cantWorkOutImport = (pattern) => dFooter.getByText(new RegExp(`^Couldn't work out what will be imported: Error: ${pattern}`));
    const tryAgain = dFooter.getByRole("button", { name: "Try again", exact: true });
    await renameFunds("My ");
    await readStatement();
    assert.equal(await transactionParts(), "13 imported before, skipped · 26 waiting for earlier purchases");
    await hosted(() => {
      const a = window.host.activities.find((a) => a.assetId);
      window.host.assets[a.assetId] = { symbol: a.symbol, exchangeMic: a.exchangeMic, instrumentType: "METAL" };
    });
    await revisit();
    await cantWorkOutImport("The symbol, exchange or type of Fund INFZ90K01LQ6 changed in Wealthfolio\\. Choose Change beside the fund and confirm it again\\.").waitFor();
    assert.equal(await importButton.isDisabled(), true);
    await hosted(() => { delete window.host.assets[window.host.activities.find((a) => a.assetId).assetId].instrumentType; });
    await tryAgain.click();
    await cantWorkOutImport("The type of Fund INFZ90K01LQ6 isn't set in Wealthfolio\\. Set its type there, then choose Change beside the fund and confirm it again\\.").waitFor();
    await hosted(() => { delete window.host.assets[window.host.activities.find((a) => a.assetId).assetId]; });
    // A profile that can't be read stops the plan instead of offering the trades again.
    await hosted(() => { window.host.failGetProfileIds = [window.host.activities.find((a) => a.assetId).assetId]; });
    await tryAgain.press("Enter");
    await cantWorkOutImport("Couldn't read a Wealthfolio asset's profile: Error: Profile unavailable\\. Try again\\. If the asset was deleted, choose Change beside its fund and pick its replacement\\.").waitFor();
    // Try again stays, busy, while it works the plan out again, so it keeps the focus when that fails
    // again; once the plan is worked out, the focus goes to the bar's summary.
    await focused(tryAgain, "Try again, failed again");
    await hosted(() => { window.host.failGetProfileIds = []; });
    await tryAgain.press("Enter");
    await dSettled();
    await focused(frame.locator("[id$='-summary']"), "Try again, worked out");
    assert.equal(await transactionParts(), "13 imported before, skipped · 26 waiting for earlier purchases");
    await renameFunds("");

    // Equal purchases of the same fund in two folios have their own IDs: the other folio's are new,
    // with no possible duplicate, and the fund's row counts both folios' units.
    await hosted(() => { window.host.sharedIsin = "INFZ90K01LQ6"; });
    await readStatement();
    assert.equal(await fundQuestions.count(), 0);
    assert.deepEqual(await cellsOf(readyFund("Fund INFZ90K01LQ6")), [["3 3 imported before", "16.106"]]);
    assert.equal(await beforeImporting.count(), 0);
    await importButton.click();
    await imported(6).waitFor();
    await readStatement();
    assert.equal(await transactionParts(), "16 imported before, skipped · 26 waiting for earlier purchases");
    await hosted((rows) => {
      window.host.sharedIsin = "";
      window.host.activities = rows;
    }, allImported);

    // A purchase Wealthfolio has without the add-on's row ID, but without its cash, may be another:
    // it's skipped unless chosen under Before importing, which says what that does.
    await hosted(() => {
      const buy = window.host.activities.find((a) => a.activityType === "BUY" && a.assetSymbol === "INFZ90K01LQ6" && a.date.startsWith("2024-06-20"));
      delete buy.sourceRecordId;
      window.host.activities = window.host.activities.filter((a) => !(a.activityType === "DEPOSIT" && a.date.startsWith("2024-06-20")));
    });
    await readStatement();
    const duplicate = beforeImporting.getByRole("checkbox", { name: /^Import it anyway\s*:\s*Fund INFZ90K01LQ6 · Purchase · 20 Jun 2024 · ₹[\d,.]+$/ });
    await duplicate.waitFor({ state: "attached" });
    await beforeImporting.getByText("Wealthfolio already has this purchase, entered by hand or imported without the add-on's row ID.", { exact: true }).waitFor();
    await beforeImporting.getByText("Skipped unless you tick it. Two equal purchases on one day can both be real.", { exact: true }).waitFor();
    assert.equal(await transactionParts(), "12 imported before, skipped · 1 possible duplicate, skipped unless chosen under “Before importing” · 26 waiting for earlier purchases");
    await dFooter.getByRole("button", { name: "Finish", exact: true }).waitFor();
    await duplicate.dispatchEvent("click");
    await beforeImporting.getByText("It's imported as a second purchase.", { exact: true }).waitFor();
    await dSettled();
    // Imported, its units count too: the fund's row says so and doesn't fold away, and so does the footer.
    await readyFund("Fund INFZ90K01LQ6").getByText("After import: 11.359 units · Statement: 8.053. Includes the second purchase you chose.", { exact: true }).waitFor();
    assert.deepEqual(await cellsOf(readyFund("Fund INFZ90K01LQ6")), [["1 2 imported before", "11.359"]]);
    await dFooter.getByText("Import 1 transaction for 1 fund into Mutual funds.", { exact: true }).waitFor();
    await dFooter.getByText("1 fund's units won't match the statement after importing: Fund INFZ90K01LQ6.", { exact: true }).waitFor();
    assert.equal(await transactionParts(), "1 to import · 12 imported before, skipped · 26 waiting for earlier purchases");
    await importButton.click();
    await imported(2).waitFor();
    const forced = await hosted(() => window.host.activities.filter((a) => a.date.startsWith("2024-06-20")).map((a) => [a.activityType, a.assetSymbol]));
    assert.deepEqual(forced, [["BUY", "INFZ90K01LQ6"], ["BUY", "INFZ90K01LQ6"], ["DEPOSIT", ""]]);

    // An import Wealthfolio rejects a row of, whose closing units then can't be read: what the
    // holdings checks below start from.
    await hosted(() => { window.host.activities = []; });
    await readStatement();
    await pause("import");
    await importButton.press("Enter");
    await waiting();
    await clickOutside();
    await hosted(() => {
      window.host.rejectLine = 1;
      window.host.failHistory = true;
    });
    await resume();
    await frame.getByText("Imported 22 of 23 activities").waitFor();
    await frame.getByText("Wealthfolio rejected rows", { exact: true }).waitFor();
    await frame.getByText(/The fund could not be created/).waitFor();
    await frame.getByText(/The import finished, but the closing units couldn't be checked/).waitFor();
    await stayedOutside("Import 13 transactions");
    assert.equal(await frame.getByText(/The import failed/).count(), 0);
    const baseline = await hosted(() => ({ activities: window.host.activities, storage: [...window.host.storage] }));
    await hosted(() => {
      window.host.rejectLine = undefined;
      window.host.failHistory = false;
    });

    // With a bank account, purchases transfer from it, and sales and cash dividends back to it. Entries
    // it already has can be those transfers: one check per bank account, a question under the bank
    // choice that set it, with each pair's evidence; only strong evidence starts ticked.
    const bankEntry = (id, activityType, amount, date, comment) => ({
      id, accountId: "bank-1", activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`, quantity: null,
      unitPrice: null, amount, fee: null, currency: "INR", needsReview: false, comment, assetId: "", assetSymbol: "",
    });
    const bankEntries = [
      bankEntry("bank-neft", "WITHDRAWAL", "25000.00", "2023-05-04", "NEFT FICTIVA MF"),
      bankEntry("bank-self", "WITHDRAWAL", "100000.00", "2023-07-03", "UPI/CASH TO SELF"),
      bankEntry("bank-idcw", "DEPOSIT", "7276.48", "2023-12-28", "IDCW"),
      bankEntry("bank-late", "DEPOSIT", "6848.45", "2024-07-03", "TESTBRIDGE MF IDCW"),
      bankEntry("bank-ach", "WITHDRAWAL", "20000.00", "2023-08-14", "ACH TESTBRIDGE MF"),
      bankEntry("bank-nach", "WITHDRAWAL", "20000.00", "2023-08-15", "NACH TESTBRIDGE"),
      // Already linked with another transfer, so it can't be used.
      bankEntry("bank-linked", "TRANSFER_IN", "7276.48", "2023-12-28", "IDCW"),
    ];
    const resetBank = (spending = {}) => hosted(([rows, spending]) => {
      window.host.activities = structuredClone(rows);
      window.host.links = [];
      window.host.linked = ["bank-linked"];
      window.host.updates = [];
      Object.assign(window.host.spending, { enabled: false, accountIds: [], splits: {}, assignments: {}, unassigned: [], failUnassign: [], searches: [] }, spending);
    }, [bankEntries, spending]);
    const savingsCheck = fundsBox().locator("section").filter({ has: frame.getByRole("heading", { name: /already in Savings looks? like/ }) });
    const pairBox = (start) => savingsCheck.getByRole("checkbox", { name: new RegExp(`^${literal(start)}`) });
    const pairItem = (text) => savingsCheck.locator("li").filter({ hasText: text });
    const neftPair = "Fund INFZ90K01LQ6 Purchase · 5 May 2023 · ₹25,000, from Savings Savings: NEFT FICTIVA MF · 4 May 2023 · −₹25,000";
    const savingsLabel = `${investor}'s funds · Savings`;
    const linkSelected = savingsCheck.getByRole("button", { name: new RegExp(`^Link \\d+ selected: ${literal(savingsLabel)}$`) });
    const newTransfers = savingsCheck.getByRole("button", { name: `Create new transfers instead: ${savingsLabel}`, exact: true });
    const follows = (first, second) => first.evaluate((a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), second);
    const allAccounts = await accountList();
    await resetBank();
    await readStatement();
    await bankSelect().click();
    await frame.getByRole("option", { name: "Not set (INR)", exact: true }).waitFor();
    // The same accounts as the funds' box: those that track transactions.
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["None: don't add bank transfers", "Mutual funds (INR)", "Savings (INR)", "Not set (INR)"]);
    await frame.getByRole("option", { name: "Savings (INR)" }).click();
    await dSettled();
    await savingsCheck.getByRole("heading", { name: "5 entries already in Savings look like these purchases and payouts", exact: true }).waitFor();
    assert.ok(await follows(bankSelect(), await savingsCheck.elementHandle()), "right under the bank choice");
    await savingsCheck.getByText(
      "Linking uses the existing bank entry for this payment or payout, so it's counted once. Ticked: exact amount within a day, a unique match, and the description names the fund house or mentions mutual funds.",
      { exact: true },
    ).waitFor();
    // Every pair at once: the fund, its movement and direction, and the bank entry, ticked only on
    // strong evidence, and the reason in words.
    for (const [name, ticked, reason] of [
      [neftPair, true, "1 day apart · names the fund house"],
      ["Fund 0P0000TBCB Purchase · 3 Jul 2023 · ₹1,00,000, from Savings Savings: UPI/CASH TO SELF · 3 Jul 2023 · −₹1,00,000", false, "Same day, but it doesn't name a fund house: check it"],
      ["Fund 0P0000TBCB Cash dividend · 28 Dec 2023 · ₹7,276.48, to Savings Savings: IDCW · 28 Dec 2023 · +₹7,276.48", false, "Same day, but it doesn't name a fund house: check it"],
      ["Fund 0P0000TBCB Cash dividend · 28 Jun 2024 · ₹6,848.45, to Savings Savings: TESTBRIDGE MF IDCW · 3 Jul 2024 · +₹6,848.45", false, "5 days apart: check it"],
      ["Fund 0P0000TONF Purchase · 14 Aug 2023 · ₹20,000, from Savings Savings: ACH TESTBRIDGE MF · 14 Aug 2023 · −₹20,000", false, "2 entries match: check it"],
    ]) {
      const box = pairBox(name);
      assert.equal(await box.count(), 1, name);
      assert.equal(await box.getAttribute("aria-checked"), String(ticked), name);
      await savingsCheck.locator("li").filter({ has: frame.getByRole("checkbox", { name: new RegExp(`^${literal(name)}`) }) }).getByText(reason, { exact: true }).waitFor();
    }
    assert.equal(await savingsCheck.getByRole("checkbox").count(), 5);
    const outsideSpending = "Changing a withdrawal or deposit into a transfer deletes any split across spending categories, also one saved before Spending was turned off for its account.";
    assert.equal(await savingsCheck.getByText(outsideSpending, { exact: true }).count(), 1);
    await savingsCheck.getByText("Linking changes each withdrawal or deposit into a transfer, linked with the fund account's.", { exact: true }).waitFor();
    // What creating new transfers does, said before the choice.
    const unlinked = "Unlinked purchases get new transfers from Savings; unlinked cash dividends get new transfers back to it. If an entry above is that payment or payout, the new transfer would count it twice.";
    await savingsCheck.getByText(unlinked, { exact: true }).waitFor();
    assert.equal(await frame.locator(`[id="${await newTransfers.getAttribute("aria-describedby")}"]`).textContent(), unlinked);
    assert.equal(await linkSelected.textContent(), "Link 1 selected");
    // It's a question until it's answered.
    assert.equal(await questionChip.textContent(), "1 question");
    await dFooter.getByText("1 question left: the payment check before importing.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(savingsCheck.getByRole("heading"), "Go to the question, the payment check");
    await pairBox(neftPair).dispatchEvent("click");
    assert.equal(await linkSelected.textContent(), "Link 0 selected");
    assert.equal(await linkSelected.isDisabled(), true);
    await pairBox(neftPair).dispatchEvent("click");
    await pairBox("Fund 0P0000TBCB Purchase").dispatchEvent("click");
    assert.equal(await linkSelected.textContent(), "Link 2 selected");
    await pairBox("Fund 0P0000TBCB Purchase").dispatchEvent("click");
    // Create new transfers instead answers it: a receipt with Change answer, and the focus on the summary.
    await newTransfers.press("Enter");
    const notLinked = "Not linked: all 5 payments and payouts get new transfers with Savings";
    await fundsBox().getByText(notLinked, { exact: true }).waitFor();
    await focused(dSummary, "Create new transfers instead");
    await dSaid.getByText(`${notLinked}. All questions answered. Ready to import.`, { exact: true }).waitFor();
    await dFooter.getByText(`${investor}'s purchases transfer from Savings, and sales and payouts back to it: 9 get new transfers.`, { exact: true }).waitFor();
    // Change answer asks again, with the ticks as they were.
    await fundsBox().getByRole("button", { name: `Change answer: ${notLinked}: ${savingsLabel}`, exact: true }).click();
    await focused(savingsCheck.getByRole("heading"), "Change answer, the payment check");
    assert.equal(await pairBox(neftPair).getAttribute("aria-checked"), "true");
    await linkSelected.click();
    const oneLinked = "1 of 5 payments and payouts linked to entries already in Savings; the rest get new transfers";
    await fundsBox().getByText(oneLinked, { exact: true }).waitFor();
    await dFooter.getByText(`${investor}'s purchases transfer from Savings, and sales and payouts back to it: 1 uses an entry already there, 8 get new transfers.`, { exact: true }).waitFor();
    await seeEvery();
    const linkedCash = everyTable.getByRole("row").filter({ hasText: "2023-05-05" }).filter({ hasText: detailed.liquid }).locator("td").nth(7);
    assert.equal((await linkedCash.textContent()).trim(), "transfer in 25001.1470564from Savings, using an entry already there");
    // A trade Wealthfolio rejects or skips leaves its chosen bank entry and the fund's cash alone.
    const linkedImport = async () => {
      await readStatement();
      // Remembered once imported.
      if ((await bankSelect().textContent()).trim() !== "Savings (INR)") await pickOption(bankSelect(), "Savings (INR)");
      await linkSelected.click();
      await importButton.click();
    };
    for (const outcome of ["rejectLine", "skipLine"]) {
      await resetBank();
      await hosted((outcome) => { window.host[outcome] = 1; }, outcome);
      await linkedImport();
      await frame.getByText("Imported 29 of 30 activities").waitFor();
      await frame.getByText(/The trade wasn't imported, so the bank's entry was left as it is\./).waitFor();
      const unchanged = await hosted(() => ({
        bank: window.host.activities.find((a) => a.id === "bank-neft"),
        fundRows: window.host.activities.filter((a) => a.accountId === "account-1" && a.date.startsWith("2023-05-05")),
        links: window.host.links,
      }));
      assert.deepEqual(unchanged, { bank: bankEntries[0], fundRows: [], links: [] });
      await hosted(() => {
        window.host.rejectLine = undefined;
        window.host.skipLine = undefined;
      });
    }
    // The bank account is remembered with the rest, and preselected.
    const bankKey = `bank-${panKey}`;
    assert.match(bankKey, /^bank-pan:[0-9a-f]{64}$/);
    assert.equal((await storage())[bankKey], "bank-1");
    // Linked: the trade, then the fund account's transfer, the bank entry changed into a transfer, and the link.
    await resetBank();
    await linkedImport();
    await imported(30).waitFor();
    await frame.getByText("Linked 1 of 1 bank row you chose with its transaction.").waitFor();
    const banked = await hosted(() => ({ activities: window.host.activities, links: window.host.links }));
    const byId = Object.fromEntries(banked.activities.map((a) => [a.id, a]));
    assert.equal(banked.links.length, 1);
    const [[bankRowId, fundLegId]] = banked.links;
    assert.equal(bankRowId, "bank-neft");
    assert.deepEqual([byId["bank-neft"].activityType, byId["bank-neft"].comment, byId["bank-neft"].amount], ["TRANSFER_OUT", "NEFT FICTIVA MF", "25000.00"]);
    const fundLeg = byId[fundLegId];
    assert.deepEqual([fundLeg.accountId, fundLeg.activityType, fundLeg.amount, fundLeg.date.slice(0, 10)], ["account-1", "TRANSFER_IN", "25001.1470564", "2023-05-05"]);
    const bankCount = (accountId, type) => banked.activities.filter((a) => a.accountId === accountId && a.activityType === type).length;
    assert.deepEqual(
      [bankCount("bank-1", "TRANSFER_OUT"), bankCount("bank-1", "TRANSFER_IN"), bankCount("account-1", "TRANSFER_IN"), bankCount("account-1", "TRANSFER_OUT")],
      [4, 6, 4, 5],
    );
    assert.equal(bankCount("account-1", "DEPOSIT"), 1, "the switch's purchase keeps its deposit");
    await readStatement();
    assert.equal(await transactionParts(), "13 imported before, skipped · 26 waiting for earlier purchases");
    assert.equal(await savingsCheck.count(), 0);

    // Before a pair is linked, it says what linking changes besides its type and link: its spending
    // split and category, and corrections from a synced account. One with a split never starts ticked.
    const syncedNote = "Savings is synced. Once linked, later corrections to this entry from the sync won't change it.";
    const splitNote = "This entry is split across 2 spending categories. Changing it into a transfer deletes the split.";
    const categoryNote = "Its spending category is removed: a transfer isn't spending.";
    const twoSplits = { "bank-neft": [{ taxonomyId: "spending_categories", categoryId: "food" }, { taxonomyId: "spending_categories", categoryId: "rent" }] };
    // Spending off, in an account synced through Wealthfolio Connect: one note above the pairs, and the synced one on each pair.
    await editAccounts({ "bank-1": { provider: "SNAPTRADE", providerAccountId: "connect-1" } });
    await resetBank();
    await readStatement();
    assert.equal(await savingsCheck.getByText(outsideSpending, { exact: true }).count(), 1);
    await pairItem("NEFT FICTIVA MF").getByText(syncedNote, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^This entry is split|category is removed|^Couldn't check/).count(), 0);
    assert.deepEqual(await hosted(() => window.host.spending.searches), []);
    // In Spending, a split known before keeps it unticked, and its reason says why.
    await resetBank({ enabled: true, accountIds: ["bank-1"], splits: twoSplits });
    await readStatement();
    await pairItem("NEFT FICTIVA MF").getByText(splitNote, { exact: true }).waitFor();
    assert.equal(await pairBox(neftPair).getAttribute("aria-checked"), "false");
    await pairItem("NEFT FICTIVA MF").getByText("1 day apart · names the fund house, but linking deletes its split across spending categories: check it", { exact: true }).waitFor();
    assert.equal(await savingsCheck.getByText(outsideSpending).count(), 0);
    // A split and a category added after it's linked stop the import, which then shows the entry as it is.
    await resetBank({ enabled: true, accountIds: ["bank-1"] });
    await readStatement();
    assert.equal(await pairBox(neftPair).getAttribute("aria-checked"), "true");
    await linkSelected.click();
    await hosted(() => {
      window.host.spending.splits["bank-neft"] = [{ taxonomyId: "spending_categories", categoryId: "food" }, { taxonomyId: "spending_categories", categoryId: "rent" }];
      window.host.spending.assignments["bank-neft"] = [{ taxonomyId: "spending_categories", categoryId: "investing" }, { taxonomyId: "savings_categories", categoryId: "sip" }];
      window.host.activities.find((a) => a.id === "bank-neft").comment = "NEFT FICTIVA MF SIP";
    });
    const rowsBefore = await hosted(() => window.host.activities.length);
    await importButton.click();
    await frame.getByText("Nothing was imported: bank entries you chose changed", { exact: true }).waitFor();
    const liquidPurchaseName = `the 2023-05-05 purchase of ${detailed.liquid}`;
    await frame.getByText(
      `The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF), chosen for ${liquidPurchaseName}, changed: ${splitNote} ${categoryNote}`,
      { exact: true },
    ).waitFor();
    assert.deepEqual(await hosted(() => [window.host.activities.length, window.host.updates, window.host.links]), [rowsBefore, [], []]);
    await dSettled();
    // The check keeps its answer, with the entry as it is now, which the alert disclosed: the next
    // Import goes ahead.
    await fundsBox().getByRole("button", { name: /^Change answer: 1 of / }).waitFor();
    await importButton.click();
    await imported(30).waitFor();
    await frame.getByText("Linked 1 of 1 bank row you chose with its transaction.").waitFor();
    await frame.getByText(
      `The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF SIP), for the 2023-05-05 purchase of ${detailed.liquid}: Its split across 2 spending categories was deleted. Its spending category was removed. Later corrections to it from the sync won't change it.`,
      { exact: true },
    ).waitFor();
    const reusedRow = await hosted(() => ({
      row: window.host.activities.find((a) => a.id === "bank-neft"),
      splits: window.host.spending.splits["bank-neft"],
      assignments: window.host.spending.assignments["bank-neft"],
      unassigned: window.host.spending.unassigned,
      updates: window.host.updates.map((u) => [u.id, u.activityType, u.comment]),
    }));
    assert.deepEqual(
      [reusedRow.row.activityType, reusedRow.row.comment, reusedRow.row.isUserModified, reusedRow.splits, reusedRow.assignments, reusedRow.unassigned, reusedRow.updates],
      ["TRANSFER_OUT", "NEFT FICTIVA MF SIP", true, undefined, [{ taxonomyId: "savings_categories", categoryId: "sip" }], [["bank-neft", "expense"]], [["bank-neft", "TRANSFER_OUT", "NEFT FICTIVA MF SIP"]]],
    );
    // An entry deleted after it's linked stops the import too; without it, the check is asked again.
    await resetBank({ enabled: true, accountIds: ["bank-1"] });
    await readStatement();
    await linkSelected.click();
    await hosted(() => { window.host.activities = window.host.activities.filter((a) => a.id !== "bank-neft"); });
    await importButton.click();
    await frame.getByText(
      `The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF), chosen for ${liquidPurchaseName}, is no longer in Wealthfolio, so the transaction now comes with a new transfer out.`,
      { exact: true },
    ).waitFor();
    await savingsCheck.getByRole("heading", { name: "4 entries already in Savings look like these purchases and payouts", exact: true }).waitFor();
    await dFooter.getByText("1 question left: the payment check before importing.", { exact: true }).waitFor();
    await newTransfers.click();
    await importButton.click();
    await imported(32).waitFor();
    // A category Wealthfolio won't remove leaves the entry linked, with a warning.
    await resetBank({ enabled: true, accountIds: ["bank-1"], failUnassign: ["bank-neft"] });
    await hosted(() => { window.host.spending.assignments["bank-neft"] = [{ taxonomyId: "spending_categories", categoryId: "investing" }]; });
    await readStatement();
    await pairItem("NEFT FICTIVA MF").getByText(categoryNote, { exact: true }).waitFor();
    assert.equal(await pairBox(neftPair).getAttribute("aria-checked"), "true", "a category alone doesn't stop the tick");
    await linkSelected.click();
    await importButton.click();
    await frame.getByText("Linked 1 of 1 bank row you chose with its transaction.").waitFor();
    await frame.getByText(
      `The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF), for the 2023-05-05 purchase of ${detailed.liquid}: Later corrections to it from the sync won't change it. Couldn't remove its spending category: Error: Category unavailable. A transfer isn't spending: remove it in Wealthfolio.`,
      { exact: true },
    ).waitFor();
    await editAccounts({ "bank-1": { provider: undefined, providerAccountId: undefined } });
    // Back to None, which forgets the bank account once the review is finished.
    await resetBank();
    await hosted((rows) => { window.host.activities = rows; }, allImported);
    await readStatement();
    assert.equal((await bankSelect().textContent()).trim(), "Savings (INR)");
    assert.equal(await transactionParts(), "13 imported before, skipped · 26 waiting for earlier purchases");
    await pickOption(bankSelect(), "None: don't add bank transfers");
    await dFooter.getByRole("button", { name: "Finish", exact: true }).click();
    await tab.frames()[1].waitForFunction((key) => !window.host.storage.has(key), bankKey);
    const beforeIgnoredDetailed = await storage();
    assert.deepEqual(beforeIgnoredDetailed, firstChoices);

    // A folio's own bank account has its own check, under that folio's choice, here with the PAN's None.
    await resetBank({ enabled: true, accountIds: ["bank-1"] });
    await hosted((entry) => { window.host.activities = [entry]; }, bankEntry("bank-tb", "DEPOSIT", "7276.48", "2023-12-28", "TESTBRIDGE MF IDCW"));
    await readStatement();
    await openPart();
    const [fictivaKey, testbridgeKey] = await Promise.all([fictivaFolio, testbridgeFolio].map((folio) => folioSelect(folio).getAttribute("id")));
    assert.match(fictivaKey, /^folio:[0-9a-f]{64}$/);
    assert.equal((await folioBankSelect(fictivaFolio).textContent()).trim(), "Same as above (None)");
    await pickOption(folioBankSelect(testbridgeFolio), "Savings (INR)");
    const payoutCheck = fundsBox().locator("section").filter({ has: frame.getByRole("heading", { name: "1 entry already in Savings looks like this payout", exact: true }) });
    await payoutCheck.waitFor();
    assert.ok(await follows(folioBankSelect(testbridgeFolio), await payoutCheck.elementHandle()), "under the folio's bank choice");
    assert.ok(!(await follows(payoutCheck, await folioBankSelect(testbridgeFolio).elementHandle())));
    await payoutCheck.getByText("Unlinked cash dividends get new transfers to Savings. If an entry above is that payout, the new transfer would count it twice.", { exact: true }).waitFor();
    await payoutCheck.getByText("Same day · names the fund house", { exact: true }).waitFor();
    // Not importing the PAN's funds leaves a folio that's still imported, and its check.
    await pickOption(fundsSelect(), "Don't import them");
    await pickOption(folioSelect(testbridgeFolio), "Not set (INR)");
    assert.equal((await folioSelect(fictivaFolio).textContent()).trim(), "Same as above (Don't import)");
    await payoutCheck.waitFor();
    await notIncluded.getByText("Not imported (1)", { exact: true }).waitFor();
    assert.equal(await transactionParts(), "6 to import · 33 in folios not imported");
    await dFooter.getByText("1 question left: the payment check before importing.", { exact: true }).waitFor();
    await payoutCheck.getByRole("button", { name: `Link 1 selected: ${savingsLabel}`, exact: true }).click();
    await fundsBox().getByText("The payout is linked to an entry already in Savings", { exact: true }).waitFor();
    await dFooter.getByText("Import 6 transactions for 2 funds into Not set.", { exact: true }).waitFor();
    await dFooter.getByText(`${investor}'s purchases transfer from Savings, and sales and payouts back to it: 1 uses an entry already there, 5 get new transfers.`, { exact: true }).waitFor();
    await leaveDetailed();
    assert.deepEqual(await storage(), beforeIgnoredDetailed, "discarded");

    // A family statement: a box per PAN, named by its investor, and a group of ready funds for each.
    const otherInvestor = "BHAVYA R TESTWALA";
    await hosted(() => {
      window.host.otherInvestorFolio = "1040012345";
      window.host.activities = [];
    });
    await readStatement();
    await frame.getByText(`CAMS statement · ${investor} and ${otherInvestor} · made-up-cas.pdf`, { exact: true }).waitFor();
    assert.match(await fundsSelect(otherInvestor).textContent(), /Choose an account/);
    await frame.getByText("Chosen last time where there was one.", { exact: true }).waitFor();
    await pickOption(fundsSelect(otherInvestor), "Not set (INR)");
    assert.deepEqual(await frame.locator("th[scope=colgroup]").allTextContents(), [`${investor} → Mutual funds`, `${otherInvestor} → Not set`]);
    await dFooter.getByText("Import 7 transactions for 2 funds into Mutual funds.", { exact: true }).waitFor();
    await dFooter.getByText("Import 6 transactions for 2 funds into Not set.", { exact: true }).waitFor();
    await hosted(() => { window.host.otherInvestorFolio = ""; });
    await leaveDetailed();

    // A remembered account that tracks holdings is ignored, and its choice says why; so is a bank
    // account that does. Go to the question goes to each in turn.
    await saveChoices([[panKey, "holdings-1"], [bankKey, "holdings-1"]]);
    await readStatement();
    await fundsBox().getByText(chooseAgain("Demat, which tracks holdings. Transactions imported there wouldn't change its holdings"), { exact: true }).waitFor();
    await fundsBox().getByText(chooseAgain("Demat, which tracks holdings. Transfers imported there wouldn't change its cash"), { exact: true }).waitFor();
    assert.match(await fundsSelect().textContent(), /Choose an account/);
    assert.match(await bankSelect().textContent(), /Choose an account/);
    await dFooter.getByText("1 question left before importing.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(fundsSelect(), "Go to the question, a funds account chosen before");
    await pickOption(fundsSelect(), "Mutual funds (INR)");
    assert.equal(await frame.getByText(/^Chosen before: Demat, which tracks holdings\. Transactions/).count(), 0);
    await dFooter.getByText("1 question left before importing.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(bankSelect(), "Go to the question, a bank account chosen before");
    await pickOption(bankSelect(), "None: don't add bank transfers");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    await importButton.click();
    await imported(23).waitFor();
    assert.deepEqual(await storage(), beforeIgnoredDetailed, "the choices made in their place");

    // Remembered folio accounts that are hidden, archived or no longer listed are ignored too, inside
    // Save part of it to another account, which Go to the question opens. Their choices need making
    // again, even to go with the PAN's.
    const hiddenFunds = chooseAgain("Hidden funds, which is hidden in Wealthfolio");
    const oldFunds = chooseAgain("Old funds, which is archived in Wealthfolio");
    await saveChoices([[fictivaKey, "hidden-1"], [testbridgeKey, "gone-1"], [`bank-${fictivaKey}`, "archived-2"], [`bank-${testbridgeKey}`, "hidden-1"], [bankKey, "bank-1"]]);
    await hosted(() => { window.host.activities = []; });
    await readStatement();
    await dFooter.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(folioSelect(fictivaFolio), "Go to the question, a folio's account");
    assert.equal(await partToggle().getAttribute("aria-expanded"), "true");
    assert.equal(await fundsBox().getByText(hiddenFunds, { exact: true }).count(), 2);
    await fundsBox().getByText(missing, { exact: true }).waitFor();
    await fundsBox().getByText(oldFunds, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 4);
    for (const select of [folioSelect(fictivaFolio), folioSelect(testbridgeFolio), folioBankSelect(fictivaFolio), folioBankSelect(testbridgeFolio)]) {
      assert.match(await select.textContent(), /Choose an account/);
    }
    assert.match(await fundsSelect().textContent(), /Mutual funds/);
    assert.match(await bankSelect().textContent(), /Savings/);
    await folioSelect(fictivaFolio).click();
    await frame.getByRole("option", { name: "Same as above (Mutual funds)" }).waitFor();
    assert.equal(await frame.getByRole("option", { name: /^(Hidden|Old) (funds|demat)/ }).count(), 0);
    await frame.getByRole("option", { name: "Same as above (Mutual funds)" }).click();
    await pickOption(folioSelect(testbridgeFolio), "Not set (INR)");
    await pickOption(folioBankSelect(fictivaFolio), "None: don't add bank transfers");
    await dFooter.getByText("1 question left before importing.", { exact: true }).waitFor();
    await pickOption(folioBankSelect(testbridgeFolio), "Same as above (Savings)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await questionChip.count(), 0);
    // Each folio's transactions go to the accounts chosen now: Fictiva's with deposits and withdrawals
    // in Mutual funds, Testbridge's in Not set, with transfers from and to Savings.
    await importButton.click();
    await imported().waitFor();
    const routed = await hosted(() => window.host.activities.map((a) => [a.accountId, a.activityType, a.assetSymbol]));
    const routedCount = (accountId, type) => routed.filter(([id, t]) => id === accountId && (!type || t === type)).length;
    assert.deepEqual([...new Set(routed.map(([id]) => id))].sort(), ["account-1", "bank-1", "unset-1"]);
    for (const [id, , symbol] of routed.filter(([, , symbol]) => symbol)) {
      assert.equal(id, symbol.startsWith("INFZ90K01") ? "account-1" : "unset-1", symbol);
    }
    assert.equal(routedCount("account-1", "TRANSFER_IN") + routedCount("account-1", "TRANSFER_OUT"), 0);
    assert.ok(routedCount("account-1", "DEPOSIT") > 0 && routedCount("unset-1", "TRANSFER_IN") > 0);
    assert.deepEqual(
      [routedCount("bank-1", "TRANSFER_OUT"), routedCount("bank-1", "TRANSFER_IN"), routedCount("bank-1")],
      [routedCount("unset-1", "TRANSFER_IN"), routedCount("unset-1", "TRANSFER_OUT"), routedCount("unset-1", "TRANSFER_IN") + routedCount("unset-1", "TRANSFER_OUT")],
    );
    // Remembered as chosen: Same as above and None as the folios' own.
    const routedChoices = await storage();
    assert.deepEqual(
      [routedChoices[fictivaKey], routedChoices[testbridgeKey], routedChoices[`bank-${fictivaKey}`], routedChoices[`bank-${testbridgeKey}`], routedChoices[bankKey]],
      [undefined, "unset-1", "outside", undefined, "bank-1"],
    );
    await restoreChoices(beforeIgnoredDetailed);

    // So are the PAN's own: an archived account and a missing bank account. A folio that goes with
    // them needs a choice, unless it isn't imported; one with its own choices doesn't.
    await saveChoices([[panKey, "archived-2"], [bankKey, "gone-1"], [fictivaKey, "account-1"], [`bank-${fictivaKey}`, "outside"]]);
    await readStatement();
    await fundsBox().getByText(oldFunds, { exact: true }).waitFor();
    await fundsBox().getByText(missing, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    assert.match(await fundsSelect().textContent(), /Choose an account/);
    assert.match(await bankSelect().textContent(), /Choose an account/);
    await openPart();
    for (const select of [folioSelect(testbridgeFolio), folioBankSelect(testbridgeFolio)]) {
      assert.equal((await select.textContent()).trim(), "Same as above", "nothing is chosen for the PAN");
    }
    assert.match(await folioSelect(fictivaFolio).textContent(), /^Mutual funds/);
    assert.equal((await folioBankSelect(fictivaFolio).textContent()).trim(), "None: don't add bank transfers");
    await dFooter.getByText("1 question left before importing.", { exact: true }).waitFor();
    await pickOption(folioSelect(testbridgeFolio), "Mutual funds (INR)");
    await dFooter.getByText("1 question left before importing.", { exact: true }).waitFor();
    // A folio waiting for its bank account has no ready rows to skip its funds from; not importing it
    // leaves no question.
    await pickOption(folioSelect(testbridgeFolio), "Don't import");
    assert.equal(await questionChip.count(), 0);
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // A folio printed without a PAN has a box of its own, with the folio's remembered choices.
    await hosted(() => { window.host.noPanFolio = "1040012345"; });
    await saveChoices([[testbridgeKey, "hidden-1"], [`bank-${testbridgeKey}`, "gone-1"]]);
    await readStatement();
    const noPanTitle = `${testbridgeFolio} (no PAN printed)`;
    const noPanBox = frame.getByRole("group", { name: noPanTitle, exact: true });
    const noPanSelect = frame.getByRole("combobox", { name: noPanTitle, exact: true });
    await noPanBox.getByText(hiddenFunds, { exact: true }).waitFor();
    await noPanBox.getByText(missing, { exact: true }).waitFor();
    assert.match(await noPanSelect.textContent(), /Choose an account/);
    assert.match(await bankSelect(noPanTitle).textContent(), /Choose an account/);
    assert.equal(await partToggle(noPanTitle).count(), 0);
    await noPanSelect.click();
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).waitFor();
    assert.equal(await frame.getByRole("option", { name: /^Same as above/ }).count(), 0);
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    await dSettled();
    await pickOption(bankSelect(noPanTitle), "None: don't add bank transfers");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await questionChip.count(), 0);
    await hosted(() => { window.host.noPanFolio = ""; });
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // Each read loads the accounts again. With none left that tracks transactions, Save to offers a new
    // account, numbered past the hidden Mutual funds; it isn't preselected while a remembered choice
    // asks to choose again. The next read offers the account added meanwhile too.
    await saveChoices([[panKey, "account-1"], [testbridgeKey, "unset-1"], [bankKey, "bank-1"]]);
    await editAccounts({ "account-1": { isActive: false }, "unset-1": { isArchived: true }, "bank-1": { trackingMode: "HOLDINGS" } });
    await readStatement();
    assert.equal(await frame.getByText(/^No account (can|tracks)/).count(), 0);
    await fundsBox().getByText(chooseAgain("Mutual funds, which is hidden in Wealthfolio"), { exact: true }).waitFor();
    assert.match(await fundsSelect().textContent(), /Choose an account/);
    await fundsSelect().click();
    await frame.getByRole("option", { name: "New: Mutual funds 2", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["New: Mutual funds 2", "Don't import them"]);
    await tab.keyboard.press("Escape");
    await frame.getByRole("option").first().waitFor({ state: "detached" });
    assert.equal(await importButton.isDisabled(), true);
    await editAccounts({ "new-1": { name: "New funds", trackingMode: "TRANSACTIONS" } });
    await readStatement();
    await fundsSelect().click();
    await frame.getByRole("option", { name: "New funds (INR)", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["New funds (INR)", "New: Mutual funds 2", "Don't import them"]);
    await frame.getByRole("option", { name: "New funds (INR)", exact: true }).click();
    await dSettled();
    await setAccountList(allAccounts);
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);
    // When they can't be loaded, the read says so and shows no review, and the next read can load them.
    await hosted(() => { window.host.failAccounts = true; });
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await readButton.click();
    await frame.getByText("Couldn't load the accounts: Error: Accounts unavailable. Choose Read statement to try again.", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await transactionsHeading.count(), 0);
    await hosted(() => { window.host.failAccounts = false; });
    await readButton.click();
    await transactionsHeading.waitFor({ timeout: 180_000 });
    await dSettled();

    // Skipping a fund leaves it out of this import, and forgets its fund once imported, keeping the
    // other funds and the account. A failed deletion keeps the fund, and says it can come back.
    const changePanelDetailed = frame.locator("[data-focus-first]");
    const skipLiquid = async () => {
      await readyFund("Fund INFZ90K01LQ6").getByRole("button", { name: "Change: Fund INFZ90K01LQ6", exact: true }).click();
      await changePanelDetailed.getByRole("button", { name: `Skip this fund: ${detailed.liquid}`, exact: true }).click();
      await readyFund("Fund INFZ90K01LQ6").waitFor({ state: "detached" });
      await dSettled();
    };
    await hosted(() => { window.host.activities = []; });
    await readStatement();
    await skipLiquid();
    await dSaid.getByText(`${detailed.liquid}: skipped.`, { exact: true }).waitFor();
    await notIncluded.getByText("Skipped (1)", { exact: true }).waitFor();
    assert.equal(await transactionParts(), "10 to import · 26 waiting for earlier purchases · 3 in skipped funds");
    await hosted(() => { window.host.failDelete = true; });
    await importButton.click();
    await imported().waitFor();
    await tab.frames()[1].waitForFunction(() => window.host.toasts.length);
    assert.deepEqual(await hosted(() => window.host.toasts), ["Couldn't forget the fund chosen before. It can come back the next time you read a statement."]);
    assert.deepEqual(await storage(), beforeIgnoredDetailed);
    await hosted(() => {
      window.host.failDelete = false;
      window.host.toasts = [];
      window.host.activities = [];
    });
    await readStatement();
    await skipLiquid();
    await importButton.click();
    await imported().waitFor();
    const { "isin:INFZ90K01LQ6": liquidChoice, ...withoutLiquid } = beforeIgnoredDetailed;
    assert.ok(liquidChoice);
    assert.deepEqual(await storage(), withoutLiquid);
    // Read again, it's asked about as if it were new; a fund chosen then is saved.
    await hosted(() => { window.host.activities = []; });
    await readStatement();
    assert.equal(await fundQuestions.count(), 1);
    const liquidQuestion = fundQuestion(detailed.liquid);
    await liquidQuestion.getByRole("textbox", { name: `Search by fund code for ${detailed.liquid}`, exact: true }).fill("MULTI");
    await liquidQuestion.getByRole("button", { name: `Search for ${detailed.liquid}`, exact: true }).click();
    await liquidQuestion.getByRole("radio").nth(2).waitFor({ state: "attached" });
    await liquidQuestion.getByRole("radio").nth(2).dispatchEvent("click");
    await liquidQuestion.getByRole("button", { name: `Use this fund for ${detailed.liquid}`, exact: true }).click();
    await dSettled();
    await readyFund("Fund B").waitFor();
    await importButton.click();
    await imported().waitFor();
    assert.equal(JSON.parse((await storage())["isin:INFZ90K01LQ6"]).symbol, "B");
    await restoreChoices(beforeIgnoredDetailed);
    // A fund in two folios is one question.
    await hosted(() => {
      window.host.sharedIsin = "INFZ90K01LQ6";
      window.host.activities = [];
      window.host.storage.delete("isin:INFZ90K01LQ6");
    });
    await readStatement();
    assert.equal(await fundQuestions.count(), 1);
    await liquidQuestion.getByText(/· Direct plan · Growth · 16\.106 units · in 2 folios$/).waitFor();
    await hosted(() => { window.host.sharedIsin = ""; });
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // A fund house's merger is one fund conversion: two lines with one status, both rows or neither.
    await hosted(() => {
      window.host.activities = [];
      window.host.merger = true;
    });
    await readStatement();
    await answerFunds();
    await seeEvery();
    const leaving = everyTable.getByRole("row").filter({ hasText: "fund conversion out" });
    const arriving = everyTable.getByRole("row").filter({ hasText: "fund conversion in" });
    const cellTexts = async (row) => (await row.locator("td").allTextContents()).map((text) => text.trim());
    assert.deepEqual(await cellTexts(leaving), ["2024-08-01", "Fictiva Old Fund - Direct Plan - Growth", "fund conversion out", "99.995", "", "", "", "", "New"]);
    assert.equal(await leaving.locator("td").last().getAttribute("rowspan"), "2");
    assert.deepEqual(await cellTexts(arriving), ["2024-08-01", "Fictiva New Fund - Direct Plan - Growth", "fund conversion in", "69.996", "", "", "", ""]);
    assert.deepEqual(await cellsOf(readyFund("Fund INFZ90K01NF5")), [["1", "69.996"]]);
    assert.equal((await cellsOf(readyFund("Fund INFZ90K01OF7")))[0][0], "2");
    await importButton.click();
    await imported().waitFor();
    const conversions = await hosted(() =>
      window.host.activities.filter((a) => a.activityType === "ADJUSTMENT").map((a) => [a.subtype, a.symbol, a.quantity, a.sourceGroupId]));
    assert.deepEqual(conversions.map((c) => c.slice(0, 3)), [["CONVERSION_OUT", "INFZ90K01OF7", "99.995"], ["CONVERSION_IN", "INFZ90K01NF5", "69.996"]]);
    assert.match(conversions[0][3], /^cas-importer-merger:[0-9a-f]{64}$/);
    assert.equal(conversions[1][3], conversions[0][3]);
    for (const name of ["Fictiva Old Fund", "Fictiva New Fund"]) {
      assert.equal(await resultUnits().filter({ hasText: name }).filter({ hasText: "Match" }).count(), 1, name);
    }
    // Read again, it's in Wealthfolio, and can't be imported twice.
    await readStatement();
    await seeEvery();
    await leaving.getByText("Already in Wealthfolio", { exact: true }).waitFor();
    // Moving the conversion to an unselected account keeps its group and blocks a second import.
    await hosted(() => {
      for (const a of window.host.activities) if (a.subtype?.startsWith("CONVERSION_")) a.accountId = "elsewhere";
    });
    await readStatement();
    await seeEvery();
    await leaving.getByText(/^Wealthfolio has this conversion from an earlier import, changed since/).waitFor();
    await notIncluded.getByText(/Wealthfolio has this conversion from an earlier import, changed since/).first().waitFor();
    await dFooter.getByRole("button", { name: "Finish", exact: true }).waitFor();
    await hosted(() => { window.host.merger = false; });
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // A gift from a folio the statement doesn't include is an external transfer in. A gift between two
    // of its folios, in two accounts, is a transfer out and in: two lines with one status, which
    // Wealthfolio links. Neither has cash.
    await hosted(() => {
      window.host.activities = [];
      window.host.gifts = true;
    });
    await readStatement();
    await answerFunds();
    // In one account the units don't move, so neither side goes in.
    const sameAccount = "Both sides of this gift go to the same Wealthfolio account, so its units stay there and neither side is imported.";
    await notIncluded.getByText(new RegExp(`${literal(sameAccount)}$`)).waitFor();
    await openPart();
    await pickOption(folioSelect("Fictiva Mutual Fund folio 93456789"), "Not set (INR)");
    await seeEvery();
    // Purchases' cash can be a transfer too: go by the Activity column.
    const activityRow = (fund, activity) => everyTable.getByRole("row").filter({ hasText: fund })
      .filter({ has: frame.locator("td:nth-child(3)", { hasText: new RegExp(`^${activity}$`) }) });
    const received = activityRow("Fictiva Gifted Fund", "transfer in");
    const given = activityRow("Fictiva Shared Fund", "transfer out");
    const taken = activityRow("Fictiva Shared Fund", "transfer in");
    assert.deepEqual((await cellTexts(received)).slice(0, 8), ["2024-06-04", "Fictiva Gifted Fund - Direct Plan - Growth", "transfer in", "10.000", "25.0000", "", "", ""]);
    assert.match((await cellTexts(received))[8], /^NewImported at NAV 25\.0000, the units' value on the day of the gift/);
    assert.deepEqual((await cellTexts(given)).slice(0, 8), ["2024-06-03", "Fictiva Shared Fund - Direct Plan - Growth", "transfer out", "20.000", "25.0000", "", "", ""]);
    assert.match((await cellTexts(given))[8], /^NewA gift to folio 93456789: Wealthfolio links this transfer out with that folio's transfer in/);
    assert.equal(await given.locator("td").last().getAttribute("rowspan"), "2");
    assert.deepEqual(await cellTexts(taken), ["2024-06-03", "Fictiva Shared Fund - Direct Plan - Growth", "transfer in", "20.000", "25.0000", "", "", ""]);
    await importButton.click();
    await imported().waitFor();
    const transfers = await hosted(() =>
      window.host.activities.filter((a) => a.assetSymbol && a.activityType.startsWith("TRANSFER_"))
        .map((a) => [a.accountId, a.activityType, a.assetSymbol, a.quantity, a.unitPrice, a.amount ?? null, a.isExternal ?? null]));
    assert.deepEqual(transfers, [
      ["account-1", "TRANSFER_IN", "INFZ90K01GF3", "10.000", "25.0000", null, true],
      ["account-1", "TRANSFER_OUT", "INFZ90K01SF6", "20.000", "25.0000", null, null],
      ["unset-1", "TRANSFER_IN", "INFZ90K01SF6", "20.000", "25.0000", null, null],
    ]);
    assert.equal(await resultUnits().filter({ hasText: "Fictiva Gifted Fund" }).filter({ hasText: "Match" }).count(), 1);
    assert.equal(await resultUnits().filter({ hasText: "Fictiva Shared Fund" }).filter({ hasText: "Match" }).count(), 2);
    // Read again, both are in Wealthfolio.
    await readStatement();
    await seeEvery();
    await received.getByText("Already in Wealthfolio", { exact: true }).waitFor();
    await given.getByText("Already in Wealthfolio", { exact: true }).waitFor();
    await hosted(() => { window.host.gifts = false; });
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // A segregated portfolio's units are a purchase at a stand-in ₹0, marked as such, with no cash.
    await hosted(() => {
      window.host.activities = [];
      window.host.segregated = true;
    });
    await readStatement();
    await answerFunds();
    await seeEvery();
    const segregatedRows = everyTable.getByRole("row").filter({ hasText: "Fictiva Credit Risk Fund - Segregated Portfolio 1" });
    const credits = segregatedRows.filter({ has: frame.locator("td:nth-child(3)", { hasText: /^purchase$/ }) });
    const payouts = segregatedRows.filter({ has: frame.locator("td:nth-child(3)", { hasText: /^sale$/ }) });
    assert.equal(await credits.count(), 2);
    for (const [i, quantity] of ["3067.468", "0.013"].entries()) {
      const creditCells = await cellTexts(credits.nth(i));
      assert.deepEqual(creditCells.slice(0, 8), [
        "2024-02-16", "Fictiva Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth", "purchase", quantity, "", "", "0stand-in", "",
      ]);
      assert.match(creditCells[8], /^NewUnits credited in a segregated portfolio, imported at a stand-in cost of ₹0 with no cash\./);
    }
    // The payout is an ordinary redemption, at the segregated portfolio's NAV, with its cash.
    assert.deepEqual((await cellTexts(payouts)).slice(0, 7), ["2024-09-20", "Fictiva Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth", "sale", "1533.741", "0.6000", "", "920.2446"]);
    await importButton.click();
    await imported().waitFor();
    const segregatedSent = await hosted(() =>
      window.host.activities.filter((a) => a.assetSymbol === "INFZ90K01S17" && a.activityType === "BUY").map((a) => [a.quantity, a.unitPrice ?? null, a.amount]));
    assert.deepEqual(segregatedSent, [["3067.468", null, "0"], ["0.013", null, "0"]]);
    assert.equal(await resultUnits().filter({ hasText: "Segregated Portfolio 1" }).filter({ hasText: "Match" }).count(), 1);
    // Read again, the credits are in Wealthfolio.
    await readStatement();
    await seeEvery();
    assert.equal(await credits.getByText("Already in Wealthfolio", { exact: true }).count(), 2);
    // A later statement lists only the payout: with the units in Wealthfolio before it starts, the
    // payout is a sale, with the caveat on its gain.
    await hosted(() => {
      window.host.segregated = "later";
      const all = window.host.activities;
      const sold = all.filter((a) => a.assetSymbol === "INFZ90K01S17" && a.activityType === "SELL");
      const cash = all.filter((a) => !a.assetSymbol && sold.some((s) => s.date === a.date && s.amount === a.amount));
      window.host.activities = all.filter((a) => !sold.includes(a) && !cash.includes(a)).map((a) =>
        (a.assetSymbol === "INFZ90K01S17" ? { ...a, date: "2023-03-01T00:00:00+00:00" } : a));
    });
    await readStatement();
    await seeEvery();
    assert.equal(await credits.count(), 0);
    assert.match((await cellTexts(payouts)).at(-1), /^NewA payout from a segregated portfolio: Wealthfolio counts its gain against the cost it has for these units/);
    await hosted(() => { window.host.segregated = false; });
    await leaveDetailed();
    await restoreChoices(beforeIgnoredDetailed);

    // A fund whose rows don't add up to its closing balance is left out, even with its opening units in
    // Wealthfolio, unless it's chosen under Before importing, which says what each choice does.
    const flexiOpening = {
      id: "flexi-opening", accountId: "account-1", activityType: "BUY", subtype: null, status: "POSTED",
      date: "2023-03-01T00:00:00+00:00", quantity: "1250", unitPrice: "40", amount: "50000", fee: null, currency: "INR",
      needsReview: false, comment: null, assetId: "asset-INFZ90K01FC8", assetSymbol: "INFZ90K01FC8", exchangeMic: "XBOM",
    };
    await hosted((opening) => { window.host.activities = [opening]; }, flexiOpening);
    await readStatement("tests/fixtures/made-up-cas-mismatch.pdf");
    await frame.getByText("casparser reported warnings", { exact: true }).waitFor();
    const importFlexi = beforeImporting.getByRole("checkbox", { name: /^Import this fund anyway\s*:\s*Fictiva Flexi Cap Fund - Direct Plan - Growth, folio 91234567 \/ 12$/ });
    await importFlexi.waitFor({ state: "attached" });
    await beforeImporting.getByText(
      "The rows take the unit balance from 1250 to 2798.066, but the statement's closing balance is 2892.104, 94.038 units apart: a row was probably dropped or misread.",
      { exact: true },
    ).waitFor();
    await beforeImporting.getByText("Its rows are left out unless you tick it.", { exact: true }).waitFor();
    await notIncluded.getByText("Left out unless you choose otherwise under “Before importing” (1)", { exact: true }).waitFor();
    assert.match(await transactionParts(), /^13 to import · \d+ in funds whose rows don't add up, left out unless chosen under “Before importing”$/);
    await importFlexi.press("Space");
    // Imported, its units won't match the statement: its row says so, and so does the footer.
    await readyFund("Fund INFZ90K01FC8").getByText("After import: 2,798.066 units · Statement: 2,892.104. Imported with the difference you accepted.", { exact: true }).waitFor();
    await dFooter.getByText("1 fund's units won't match the statement after importing: Fund INFZ90K01FC8.", { exact: true }).waitFor();
    await beforeImporting.getByText("Its rows are imported: check them against the PDF, and after importing add or correct the missing rows in Wealthfolio.", { exact: true }).waitFor();
    // Before importing stays while the plan is worked out again, so the checkbox keeps the focus.
    await focused(importFlexi, "Import this fund anyway");
    await importFlexi.press("Space");
    await focused(importFlexi, "Import this fund anyway, unticked");
    await readyFund("Fund INFZ90K01FC8").waitFor({ state: "detached" });
    await dSettled();
    await importButton.click();
    await imported(23).waitFor();
    const afterGap = await hosted(() => window.host.activities);
    assert.deepEqual(afterGap.filter((a) => a.assetSymbol === "INFZ90K01FC8").map((a) => a.id), ["flexi-opening"]);
    assert.equal(afterGap.length, 24);

    // With AMFI added, a fund whose ISIN finds exactly one AMFI result, in rupees, whose plan and option
    // don't differ from the statement's, is confirmed without a click, and its row says so. Wealthfolio's
    // checkImport accepts it without an exchange, and its import creates the fund priced from AMFI.
    await hosted(() => {
      window.host.amfi = true;
      window.host.providers = "";
      window.host.activities = [];
      window.host.storage.delete("isin:INFZ90K01LQ6");
    });
    await readStatement();
    await dSaid.getByText("1 fund found automatically on AMFI. No questions for you.", { exact: true }).waitFor();
    await frame.getByText("1 fund found automatically on AMFI. Change any that look wrong.", { exact: true }).waitFor();
    const amfiRow = readyFund(/^Scheme \d{6}/);
    await amfiRow.getByText(/^Prices from AMFI · Change$/).waitFor();
    await amfiRow.getByText(`On your statement: ${detailed.liquid}`, { exact: true }).waitFor();
    await importButton.click();
    await imported().waitFor();
    const schemeCode = await hosted(() => window.host.activities.find((a) => /^\d{6}$/.test(a.assetSymbol))?.assetSymbol);
    assert.ok(schemeCode);
    assert.equal(JSON.parse((await storage())["isin:INFZ90K01LQ6"]).providerId, "AMFI");
    // Without the saved choice, its ISIN finds the asset the import created, which confirms it again.
    await hosted(() => { window.host.storage.delete("isin:INFZ90K01LQ6"); });
    await readStatement();
    await dSaid.getByText("1 fund found automatically on AMFI. No questions for you.", { exact: true }).waitFor();
    await dFooter.getByRole("button", { name: "Finish", exact: true }).click();
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ90K01LQ6") ?? "null")?.assetId);
    await hosted(() => {
      window.host.amfi = false;
      window.host.providers = "fail";
      window.host.assets = {};
    });
    await restoreChoices(beforeIgnoredDetailed);

    // Below Tailwind's `sm` width, 320 px here, the ready funds are a stacked list, and nothing is wider
    // than the frame: the check's buttons and the footer's stay in view.
    await resetBank();
    await readStatement();
    await pickOption(bankSelect(), "Savings (INR)");
    await sizeFrame(320);
    const stackedFunds = frame.getByRole("list", { name: "Funds ready to import", exact: true });
    await stackedFunds.waitFor();
    await stackedFunds.getByText(/^New transactions: \d+/).first().waitFor();
    assert.equal(await readyFunds.count(), 0);
    for (const button of [linkSelected, newTransfers, importButton]) assert.ok(await button.isVisible());
    assert.ok(await hosted(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "nothing past 320 px");
    await sizeFrame(1000);
    await leaveDetailed();

    // A detailed statement read in the holdings checks below starts from the import above that
    // Wealthfolio rejected a row of: its activities, and the account and two funds it chose.
    await resetBank();
    await setAccountList(allAccounts);
    const holdingsStart = baseline.storage.filter(([key]) => key === panKey || key === "isin:INFZ90K01BA1" || key === "isin:INFZ91T01CB6");
    assert.equal(holdingsStart.length, 3);
    await hosted((state) => {
      window.host.amfi = false;
      window.host.answers = {};
      Object.assign(window.host, { ...state, storage: new Map(state.storage) });
    }, { activities: baseline.activities, assets: {}, storage: holdingsStart, searches: [], failHistory: true, rejectLine: 1, skipLine: undefined });
    // A summary or depository statement's holdings go to accounts that track holdings, as snapshots,
    // on one Review screen: where they're saved, what needs an answer, and what will be saved.
    const unindexedAside = `holdings-imported:${createHash("sha256")
      .update("cas-importer holdings imported folio|1040012345|INFZ91T|holdings-2").digest("hex")}`;
    await hosted((key) => {
      window.host.parseWarnings = ["MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail"];
      window.host.failHistory = false;
      window.host.assetIds.INEZ91A07012 = "bond-created-001";
      // An older remembered provider result has no ID and calls this fund MUTUALFUND.
      window.host.storage.set("isin:INFZ91T01NF4", JSON.stringify({
        symbol: "INFZ91T01NF4", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fund INFZ91T01NF4",
      }));
      window.host.assets["older-fund-012"] = { symbol: "INFZ91T01NF4", exchangeMic: "XBOM", instrumentType: "EQUITY", name: "Fund INFZ91T01NF4" };
      window.host.pricingModes.INFZ91T01NF4 = "MANUAL";
      window.host.quotes["older-fund-012"] = [{
        id: "legacy-fund-quote", assetId: "older-fund-012", timestamp: "2025-03-31T12:00:00Z", createdAt: "2025-03-31T13:00:00Z",
        open: 100, high: 100, low: 100, close: 100, adjclose: 100, volume: 0, currency: "INR", dataSource: "MANUAL", notes: "Keep the older fund quote note",
      }];
      // An account tracking transactions holds the Flexi Cap fund and a short share position.
      window.host.snapshots["account-1"] = {
        "2025-03-31": {
          holdings: [
            { symbol: "INFZ90K01FC8", quantity: "10", currency: "INR" },
            { symbol: "INEZ90B01015", quantity: "-10", currency: "INR" },
            { assetId: "older-fund-012", symbol: "INFZ91T01NF4", quantity: "10", currency: "INR" },
          ],
          cash: {}, source: "CALCULATED",
        },
      };
      // Fund folios has a snapshot from before the statement: a fund added by hand, and cash.
      window.host.snapshots["holdings-2"] = {
        "2025-01-31": { holdings: [{ assetId: "asset-gilt", symbol: "GILT", quantity: "-10", averageCost: "100", currency: "INR", name: "Gilt fund" }], cash: { INR: "1500" } },
      };
      // An anonymous earlier import left this folio unindexed. Its absent asset's ref is now Gilt's.
      window.host.storage.set(key, JSON.stringify({ aliases: [key], dates: { "2025-01-31": {
        savedAt: 1, refs: { "GILT@XBOM": ["INFZ91T01CB6"] }, ids: { "GILT@XBOM": "absent-fund" },
      } } }));
    }, unindexedAside);
    // The Review screen shows ready holdings as a table from Tailwind's `sm` width, 40rem of the add-on's
    // frame, and as a list below it. The test page's frame is otherwise the default 300 by 150.
    const frameWidth = async (width) => {
      // The window is taller than the frame, so a select's list opened near the frame's bottom stays in view.
      await tab.setViewportSize({ width: 1280, height: 1000 });
      await tab.evaluate((width) => {
        Object.assign(document.querySelector("iframe").style, { width: `${width}px`, height: "900px" });
      }, width);
    };
    await frameWidth(1000);
    const reviewHeading = frame.getByRole("heading", { name: /^Holdings on / });
    const anotherFile = frame.getByRole("button", { name: "Use another file", exact: true });
    const saveHoldings = frame.getByRole("button", { name: /^(Update|Save) holdings$/ });
    const footer = frame.locator("div.sticky.bottom-0");
    const said = frame.locator("[role=status]");
    const escaped = (text) => text.replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Each holding still to answer is a card in Questions for you, found by the name the statement prints.
    const question = (name) => frame.locator("section section").filter({ hasText: new RegExp(`On your statement: ${escaped(name)} ·`) });
    const questions = frame.locator("section section");
    // A holding that will be saved is a row of Ready to save, with Change named for it.
    const ready = (text) => frame.getByRole("row").filter({ has: frame.getByRole("button", { name: /^Change: / }) }).filter({ hasText: text });
    const readyRows = frame.getByRole("row").filter({ has: frame.getByRole("button", { name: /^Change: / }) });
    // Waits until each holding is looked up and what will be saved is worked out.
    const settled = async () => {
      await frame.getByText(/^Looking up \d+ holdings?…$/).waitFor({ state: "detached" });
      await footer.getByText("Working out what will be saved…").waitFor({ state: "detached" });
    };
    let statementFile = "tests/fixtures/made-up-nsdl.pdf";
    // Leaves the review for the file form, discarding what it changed.
    const leaveReview = async () => {
      if (!(await anotherFile.count())) return;
      await anotherFile.click();
      const discard = frame.getByRole("button", { name: "Discard and choose another file" });
      if (await discard.count()) await discard.click();
      await reviewHeading.waitFor({ state: "detached" });
    };
    // Reads a statement, the last one by default; Use another file clears the chosen file.
    const readHoldings = async (file = statementFile, password = "ABCDE1234F", folded = false) => {
      statementFile = file;
      await leaveReview();
      await frame.locator("#cas-file").setInputFiles(file);
      await frame.locator("#cas-password").fill(password);
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await reviewHeading.waitFor({ timeout: 180_000 });
      await settled();
      // Every ready row, unless a check is about the folded list.
      if (!folded) await showAllRows();
    };
    const partButton = frame.getByRole("button", { name: "Save part of it to another account", exact: true });
    const openParts = async () => {
      if ((await partButton.getAttribute("aria-expanded")) !== "true") await partButton.click();
    };
    // The select of a folio, demat account or PRAN, by the start of its title.
    const sourceSelect = (title) => frame.getByLabel(new RegExp(`^${escaped(title)}`));
    const investorSelect = frame.getByLabel("ANANYA R TESTWALA's holdings", { exact: true });
    const choose = async (label, option) => {
      const select = label === "investor" ? investorSelect : sourceSelect(label);
      if (label !== "investor") await openParts();
      await select.click();
      await frame.getByRole("option", { name: option }).waitFor();
      // Only active, unarchived accounts that track holdings.
      assert.equal(await frame.getByRole("option", { name: "Mutual funds (INR)" }).count(), 0);
      assert.equal(await frame.getByRole("option", { name: /^(Archived funds|Hidden demat|Old demat) / }).count(), 0);
      await frame.getByRole("option", { name: option, exact: true }).click();
      await settled();
    };
    // Answers a question with its only result, a result picked by position, the statement's price, or Skip.
    const answer = async (name, how = 0) => {
      const card = question(name);
      await card.getByText(/Searching…/).waitFor({ state: "detached" });
      if (how === "statement") {
        await card.getByRole("button", { name: /^(None of these: use|Use) the price on the statement for / }).click();
      } else if (how === "skip") {
        await card.getByRole("button", { name: /^Skip this holding: / }).click();
      } else {
        const single = card.getByRole("button", { name: /^Use this (fund|listing|bond|NPS scheme): / });
        if (await single.count()) {
          await single.click();
        } else {
          await card.getByRole("radio").nth(how).dispatchEvent("click");
          await card.getByRole("button", { name: /^Use this (fund|listing|bond|NPS scheme) for / }).click();
        }
      }
      await card.waitFor({ state: "detached" });
    };
    // The statement's name in a question card's "On your statement" line.
    const printedName = async (card) => (await card.locator("p").first().innerText()).replace(/^On your statement:\s*/, "").replace(/\s+·.*$/s, "");
    // Answers every open question: `how` picks the answer from the statement's name.
    const answerAll = async (how = () => 0) => {
      for (let open = await questions.count(); open > 0; open--) {
        await answer(await printedName(questions.first()), how(await printedName(questions.first())));
      }
      await settled();
    };
    const sameDay = (account, date = "31 Mar 2025") =>
      frame.getByRole("checkbox", { name: `Replace the snapshot of ${date} in ${account}`, exact: true });
    // The read-only snapshot an account gets, under the footer's See … after saving.
    const snapshotTable = async (account, date = "31 Mar 2025") => {
      const toggle = frame.getByRole("button", { name: `See ${account}'s holdings on ${date} after saving`, exact: true });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const table = frame.getByRole("table", { name: `${account}'s holdings on ${date} after saving`, exact: true });
      await table.waitFor();
      return table;
    };
    const statusOf = async (table, text) => (await table.getByRole("row").filter({ hasText: text }).getByRole("cell").last().textContent()).trim();
    const setCost = async (row, amount) => {
      await row.getByRole("button", { name: /^(Add cost|Edit): / }).click();
      const box = frame.getByRole("textbox", { name: /^Total purchase cost of these / });
      await box.fill(amount);
      await box.press("Enter");
      await box.waitFor({ state: "detached" });
    };
    const priced = "Priced by hand: saving also saves the statement's price as its price on this date.";
    // With more than five ready rows for one account, only the first three, those missing a cost and
    // those just changed show until Show all.
    const showAll = frame.getByRole("button", { name: /^Show all \d+$/ });
    const showAllRows = async () => {
      if (await showAll.count()) await showAll.click();
    };
    await readHoldings("tests/fixtures/made-up-nsdl.pdf");
    // The heading says what's saved, from which statement and file.
    await frame.getByText("NSDL statement · ANANYA R TESTWALA · made-up-nsdl.pdf", { exact: true }).waitFor();
    await frame.getByText("Saves what you held on 31 Mar 2025, not your purchases and sales.", { exact: true }).waitFor();
    assert.equal(await reviewHeading.textContent(), "Holdings on 31 Mar 2025");
    // While a statement is reviewed, its file form and the page's AMFI banner make way for it.
    assert.equal(await frame.locator("#cas-file").isVisible(), false);
    assert.equal(await amfiBanner.count(), 0);
    await frame.getByText("casparser reported warnings", { exact: true }).waitFor();
    await frame.getByText("MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail", { exact: true }).waitFor();
    // 16 holdings: three confirmed before, the Index fund, Balanced Advantage and Corporate Bond funds,
    // are ready to save once an account is chosen; the others are questions.
    await frame.getByText("16 holdings", { exact: true }).waitFor();
    assert.equal(await questions.count(), 13);
    assert.equal(await frame.getByText("Not included in this save", { exact: true }).count(), 0);
    await frame.getByText(/^Questions for you · 13 of 13 left$/).waitFor();
    // An older remembered choice keeps no provider, so where its prices come from is unknown.
    await ready("TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH").getByText(/^Price source unknown · chosen before ·/).waitFor();
    // Nothing is chosen for the statement yet, so that's a question too, and saving waits for it.
    assert.match(await investorSelect.textContent(), /Choose an account/);
    await frame.getByText("Used again for your next statement.", { exact: true }).waitFor();
    await footer.getByText("14 questions left before saving.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    // With AMFI not added, the search for a fund's ISIN finds no AMFI result. Questions for you says so
    // once, above its cards, and offers Market data settings.
    const amfiQuestionsNote = frame.getByText(/^AMFI (isn't|may not be) added, so \d+ funds? (was|were) only searched on Yahoo Finance and needs? you\. Add AMFI to match (it|them) for you\.$/);
    await amfiQuestionsNote.waitFor();
    assert.equal(await amfiQuestionsNote.count(), 1);
    // Only funds have a plan and option on the statement; a bond's results have no badges, even when
    // their names give a plan and option.
    await question("Fictiva Flexi Cap Fund - Direct Plan - Growth").getByText(/ · Direct plan · Growth · 2,892\.104 units$/).waitFor();
    const bond = "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31";
    const bondCard = question(bond);
    assert.equal(await bondCard.getByRole("heading").textContent(), "Which bond is this?");
    assert.doesNotMatch(await bondCard.locator("p").first().innerText(), /plan/);
    const bondSearch = bondCard.getByRole("textbox", { name: `Search by ISIN for ${bond}`, exact: true });
    await bondSearch.fill("Fictiva Flexi Cap");
    await bondSearch.press("Enter");
    await bondCard.getByRole("radio").nth(4).waitFor({ state: "attached" });
    // Typed results get the focus without being picked, and the count is read out.
    await focused(bondCard.getByRole("radio").first(), "a typed search with results");
    await said.getByText("5 results found. Choose one to continue.", { exact: true }).waitFor();
    assert.equal(await bondCard.getByRole("radio", { checked: true }).count(), 0);
    assert.equal(await bondCard.getByRole("button", { name: `Use this bond for ${bond}`, exact: true }).isDisabled(), true);
    assert.deepEqual(await badges(bondCard), []);
    // Each card repeats the same controls, so their names say which holding they're for: each is in
    // its card, once on the page, and starts with its visible label.
    for (const [role, name] of [
      ["textbox", `Search by ISIN for ${bond}`],
      ["button", `Search for ${bond}`],
      ["radiogroup", "Results for “Fictiva Flexi Cap”"],
      ["button", `Use this bond for ${bond}`],
      ["button", `None of these: use the price on the statement for ${bond}`],
      ["button", `Skip this holding: ${bond}`],
    ]) {
      assert.equal(await bondCard.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
      assert.equal(await frame.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
    }
    // The consequence of the statement's price is tied to its button.
    const statementButton = bondCard.getByRole("button", { name: `None of these: use the price on the statement for ${bond}`, exact: true });
    assert.equal(
      await frame.locator(`#${await statementButton.getAttribute("aria-describedby")}`).textContent(),
      "With the price on the statement, its price changes only when you import a statement, not with the market.",
    );
    await bondCard.getByRole("radio").nth(1).dispatchEvent("click");
    await bondCard.getByRole("button", { name: `Use this bond for ${bond}`, disabled: false }).press("Enter");
    await bondCard.waitFor({ state: "detached" });
    // An answer takes the focus to the next question's heading.
    await focused(questions.first().getByRole("heading"), "Use this bond");
    const bondAnswer = frame.getByRole("button", { name: new RegExp(`^Change answer: ${escaped(bond)}: `) });
    await bondAnswer.waitFor();
    // Change answer opens the question again, its heading taking the focus.
    await bondAnswer.press("Enter");
    await focused(bondCard.getByRole("heading"), "Change answer");
    // A search that finds nothing keeps the focus in its box, with the message tied to it.
    await bondSearch.fill("INEZ91A07012");
    await bondSearch.press("Enter");
    const nothingFound = bondCard.getByText("Nothing found for “INEZ91A07012”. Check the code.", { exact: true });
    await nothingFound.waitFor();
    await focused(bondSearch, "a typed search with no results");
    assert.equal(await bondSearch.getAttribute("aria-invalid"), "true");
    assert.ok((await bondSearch.getAttribute("aria-describedby")).split(" ").includes(await nothingFound.getAttribute("id")));
    await said.getByText("Nothing found for “INEZ91A07012”. Check the code.", { exact: true }).waitFor();
    // Bonds the search can't find use the statement's prices; the one it finds is used as found.
    // Placeholder Pharma is skipped, and the rest use their first result.
    await answerAll((name) => (name === "PLACEHOLDER PHARMA LIMITED" ? "skip" : /\b(NCD|BD)\b/.test(name) && name !== "DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33" ? "statement" : 0));
    assert.equal(await amfiQuestionsNote.count(), 0);
    await frame.getByText("All 13 questions answered.", { exact: true }).waitFor();
    await frame.getByText(/^Skipped \(1\): PLACEHOLDER PHARMA LIMITED, by your answer\.$/).waitFor();
    // The answers fold away: each is a line under Show answers.
    await frame.getByRole("button", { name: "Show answers", exact: true }).click();
    await frame.getByText(`${bond}: priced from the statement`, { exact: true }).waitFor();
    await frame.getByText("DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33: Democorp Infra 7.60% 2033 (FAKE)", { exact: true }).waitFor();
    // Change answer, then answering with the keyboard: the last card's answer takes the focus to the
    // question still open, the statement's account.
    await frame.getByRole("button", { name: /^Change answer: FICTIVA NIFTY 50 ETF: / }).press("Enter");
    await focused(question("FICTIVA NIFTY 50 ETF").getByRole("heading"), "Change answer, keyboard");
    await footer.getByText("2 questions left before saving.", { exact: true }).waitFor();
    await question("FICTIVA NIFTY 50 ETF").getByRole("button", { name: /^Use this fund: / }).press("Enter");
    await focused(investorSelect, "the last answer, with an account still to choose");
    await footer.getByText("1 question left before saving.", { exact: true }).waitFor();
    assert.equal(await said.getByText("All questions answered. Ready to save.", { exact: true }).count(), 0);
    // Go to the question goes to the select still to choose, from wherever the focus is.
    await footer.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(investorSelect, "Go to the question");
    // With the account chosen, the last answer takes the focus to the footer's summary, and says so.
    await choose("investor", "Fund folios (INR)");
    await frame.getByRole("button", { name: /^Change answer: FICTIVA NIFTY 50 ETF: / }).press("Enter");
    await question("FICTIVA NIFTY 50 ETF").getByRole("button", { name: /^Use this fund: / }).press("Enter");
    await focused(footer.locator("[tabindex='-1']").first(), "the last answer");
    await said.getByText("All questions answered. Ready to save.", { exact: true }).waitFor();

    // Choices are remembered when the review is saved, in order, and a new read waits for them, so a
    // delayed write can't be overtaken. The snapshot this saves is undone after, but the remembered
    // choices stay, as they would have once they were made.
    await choose("investor", "Demat (INR)");
    const statementKey = await investorSelect.getAttribute("id");
    await choose("investor", "Fund folios (INR)");
    const beforeFirstSave = await hosted(() => JSON.stringify({
      snapshots: window.host.snapshots, saves: window.host.saves, assets: window.host.assets, quotes: window.host.quotes,
      pricingModes: window.host.pricingModes, storage: [...window.host.storage], assetIds: window.host.assetIds,
    }));
    await pause("set:holdings-2");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    await waiting();
    await anotherFile.click();
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    const parsedBefore = await hosted(() => window.host.parsed);
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await tab.frames()[1].waitForFunction((n) => window.host.parsed > n, parsedBefore, { timeout: 180_000 });
    assert.equal(await reviewHeading.count(), 0, "the read waits for the remembered choices");
    await resume();
    await reviewHeading.waitFor();
    await settled();
    assert.equal((await storage())[statementKey], "holdings-2");
    assert.match(await investorSelect.textContent(), /Fund folios/);
    await frame.getByText("Chosen last time.", { exact: true }).waitFor();
    // The answers are remembered too, except a skipped share, which is asked again.
    assert.equal(await questions.count(), 1);
    await question("PLACEHOLDER PHARMA LIMITED").waitFor();
    // Only the remembered choices stay.
    await hosted((before) => {
      const { storage, ...saved } = JSON.parse(before);
      const kept = [...window.host.storage].filter(([key]) => /^(isin|fund|nps|holdings-investor|holdings-source):/.test(key));
      Object.assign(window.host, saved, { storage: new Map([...storage, ...kept]) });
    }, beforeFirstSave);

    // Don't save them leaves nothing to save: the footer offers Finish, which saves nothing and
    // remembers the choice.
    const savesBeforeFinish = await hosted(() => window.host.saves.length);
    await choose("investor", "Don't save them");
    await footer.getByText("Nothing from this statement will be saved.", { exact: true }).waitFor();
    await frame.getByText(/^Not saved \(\d+\): /).waitFor();
    assert.equal(await questions.count(), 0);
    await footer.getByRole("button", { name: "Finish", exact: true }).click();
    await frame.getByText("Finished: nothing from made-up-nsdl.pdf was saved.", { exact: true }).waitFor();
    await focused(frame.locator("#cas-file"), "Finish");
    await tab.frames()[1].waitForFunction((key) => window.host.storage.get(key) === "left-out", statementKey);
    assert.equal(await hosted(() => window.host.saves.length), savesBeforeFinish);
    await readHoldings();
    assert.match(await investorSelect.textContent(), /Don't save them/);
    await choose("investor", "Fund folios (INR)");
    assert.equal(await questions.count(), 1);

    // Use another file asks first once something's changed, and Keep reviewing is the main choice.
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    // The Bond's cost comes from its face value, so it's among the rows Show all shows.
    assert.equal(await ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31").count(), 0);
    const shownBefore = await readyRows.count();
    const more = Number((await frame.getByText(/^\(\d+ more, nothing to check\)$/).textContent()).match(/\d+/)[0]);
    await showAll.click();
    await focused(frame.getByRole("heading", { name: /^Ready to save/ }), "Show all");
    assert.equal(await readyRows.count(), shownBefore + more);
    assert.equal(await frame.getByText(/more, nothing to check/).count(), 0);
    await setCost(ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31"), "45000");
    const storageBeforeDiscard = await storage();
    const secretsBeforeDiscard = (await host()).secrets;
    await anotherFile.click();
    await frame.getByText("Discard your 3 changes and choose another file?", { exact: true }).waitFor();
    await focused(frame.getByRole("button", { name: "Keep reviewing", exact: true }), "Use another file");
    await frame.getByRole("button", { name: "Keep reviewing", exact: true }).press("Enter");
    await focused(anotherFile, "Keep reviewing");
    await ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31").getByText(/^Purchase cost ₹45,000, added by you · /).waitFor();
    await anotherFile.click();
    await frame.getByRole("button", { name: "Discard and choose another file", exact: true }).click();
    await reviewHeading.waitFor({ state: "detached" });
    await focused(frame.locator("#cas-file"), "Discard and choose another file");
    // Discarding remembers nothing and clears the file, but keeps the saved password.
    assert.deepEqual(await storage(), storageBeforeDiscard);
    assert.deepEqual((await host()).secrets, secretsBeforeDiscard);
    assert.equal(await frame.locator("#cas-file").inputValue(), "");
    await readHoldings();
    assert.match(await investorSelect.textContent(), /Don't save them/);
    await choose("investor", "Fund folios (INR)");
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await showAllRows();
    await ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31").getByText(/^Purchase cost ₹50,000, from the face value · /).waitFor();

    // A remembered demat account that doesn't track holdings, NOT_SET included, is ignored, and its
    // row says why. It needs choosing again, even to go with the statement's account.
    const nsdlTitle = "FICTIVA SECURITIES PRIVATE LIMITED demat account";
    const cdslTitle = "TESTBRIDGE BROKING LIMITED demat account";
    const otherFolioTitle = "Mutual fund folio 91234567/12";
    const leftOutFolioTitle = "Mutual fund folio 1040012345";
    await openParts();
    const [nsdlKey, cdslKey, otherFolioKey, leftOutFolioKey] = await Promise.all(
      [nsdlTitle, cdslTitle, otherFolioTitle, leftOutFolioTitle].map((title) => sourceSelect(title).getAttribute("id")));
    await saveChoices([[statementKey, "holdings-2"], [leftOutFolioKey, "left-out"]]);
    const beforeIgnored = await storage();
    const notHoldings = ", which doesn't track holdings. A snapshot saved there wouldn't change its holdings, so choose again.";
    await saveChoices([[nsdlKey, "account-1"], [cdslKey, "unset-1"]]);
    const ignoredChoices = await storage();
    await readHoldings();
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await openParts();
    await frame.getByText(`Chosen before: Mutual funds${notHoldings}`, { exact: true }).waitFor();
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    assert.match(await sourceSelect(nsdlTitle).textContent(), /Choose an account/);
    assert.match(await sourceSelect(cdslTitle).textContent(), /Choose an account/);
    assert.match(await sourceSelect(otherFolioTitle).textContent(), /Same as above \(Fund folios\)/);
    // Go to the question opens Save part of it to another account and goes to the first select to choose.
    await partButton.click();
    await footer.getByText("1 question left before saving.", { exact: true }).waitFor();
    await footer.getByRole("button", { name: "Go to the question", exact: true }).click();
    await focused(sourceSelect(nsdlTitle), "Go to the question, a demat account's account");
    await choose(nsdlTitle, "Demat (INR)");
    assert.equal(await frame.getByText(/^Chosen before: Mutual funds/).count(), 0);
    assert.equal(await saveHoldings.isDisabled(), true, "the CDSL account's own account needs choosing again");
    await choose(cdslTitle, "Same as above (Fund folios)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    // Nothing is remembered before saving.
    assert.deepEqual(await storage(), ignoredChoices);

    // So is a remembered account for the whole statement, which isn't needed while each folio and
    // demat account has its own account or is left out.
    await saveChoices([[nsdlKey, "holdings-1"], [cdslKey, "holdings-1"], [statementKey, "unset-1"]]);
    await readHoldings();
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await openParts();
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    assert.match(await investorSelect.textContent(), /Choose an account/);
    assert.match(await sourceSelect(otherFolioTitle).textContent(), /Same as above/);
    assert.doesNotMatch(await sourceSelect(otherFolioTitle).textContent(), /Fund folios/);
    assert.equal(await saveHoldings.isDisabled(), true, "the folio goes with the statement, which has no account");
    await choose(otherFolioTitle, "Fund folios (INR)");
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    await choose(otherFolioTitle, "Same as above");
    assert.equal(await saveHoldings.isDisabled(), true);
    await choose("investor", "Fund folios (INR)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();

    // So are remembered accounts that are hidden, archived or no longer listed. A folio's or demat
    // account's own choice needs making again unless it's left out, and the snapshots go where chosen.
    const hiddenDemat = unavailable("Hidden demat, which is hidden in Wealthfolio");
    const oldDemat = unavailable("Old demat, which is hidden and archived in Wealthfolio");
    await hosted((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeIgnored);
    const beforeUnavailableHoldings = await hosted(() => JSON.stringify({
      snapshots: window.host.snapshots, saves: window.host.saves, assets: window.host.assets, quotes: window.host.quotes,
      pricingModes: window.host.pricingModes, storage: [...window.host.storage],
    }));
    await saveChoices([[nsdlKey, "hidden-2"], [cdslKey, "archived-3"], [otherFolioKey, "gone-1"]]);
    await readHoldings();
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await openParts();
    for (const note of [hiddenDemat, oldDemat, missing]) await frame.getByText(note, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    for (const title of [nsdlTitle, cdslTitle, otherFolioTitle]) assert.match(await sourceSelect(title).textContent(), /Choose an account/);
    assert.match(await sourceSelect(leftOutFolioTitle).textContent(), /Don't save/);
    assert.match(await investorSelect.textContent(), /Fund folios/);
    await frame.getByText("Chosen last time.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await choose(nsdlTitle, "Demat (INR)");
    await choose(cdslTitle, "Same as above (Fund folios)");
    assert.equal(await saveHoldings.isDisabled(), true, "the folio's own account needs choosing again");
    await choose(otherFolioTitle, "Don't save");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    const depository = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const isins = (type) => depository.accounts.find((a) => a.type === type).equities
      .concat(...["mutual_funds", "bonds"].map((kind) => depository.accounts.find((a) => a.type === type)[kind])).map((h) => h.isin);
    const savesBefore = JSON.parse(beforeUnavailableHoldings).saves.length;
    // Fund folios' Gilt fund can't be read, so what will be saved can't be worked out, and saving waits.
    // Opening the page again reads Wealthfolio again.
    await hosted(() => { window.host.failGetProfileIds = ["asset-gilt"]; });
    await revisit();
    await footer.getByText(/^Couldn't work out what will be saved: Error: Couldn't read the Wealthfolio profile of /).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await hosted(() => { window.host.failGetProfileIds = []; });
    await footer.getByRole("button", { name: "Try again", exact: true }).click();
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await pause("holdings");
    await revisit();
    await waiting();
    await footer.getByText("Working out what will be saved…", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await resume();
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await footer.getByText(/^Save \d+ holdings in Demat on 31 Mar 2025\.$/).waitFor();
    await footer.getByText(/^Update Fund folios to 31 Mar 2025 with \d+ holdings? from this statement\. Its other holdings and cash stay\.$/).waitFor();
    await pause("snapshot");
    await saveHoldings.press("Enter");
    await waiting();
    assert.equal(await said.textContent(), "Saving…");
    await footer.getByText(/^Saving Demat…$/).waitFor();
    await resume();
    await frame.getByText("Saved 2 snapshots").waitFor();
    await focused(frame.getByRole("alert").filter({ hasText: /^Saved 2 snapshots/ }), "Update holdings");
    const savedTo = await hosted(() => ({ saves: window.host.saves, snapshots: window.host.snapshots }));
    assert.deepEqual(savedTo.saves.slice(savesBefore).map((s) => [s.accountId, s.date]).sort(), [["holdings-1", "2025-03-31"], ["holdings-2", "2025-03-31"]]);
    for (const [accountId, own] of [["holdings-1", isins("NSDL Demat Account")], ["holdings-2", [...isins("CDSL Demat Account"), "GILT"]]]) {
      const symbols = savedTo.snapshots[accountId]["2025-03-31"].holdings.map((h) => h.symbol);
      assert.ok(symbols.length > 1 && symbols.every((symbol) => own.includes(symbol)), `${accountId}: ${symbols}`);
    }
    // Saving remembers the choices made: the NSDL account's own account, the CDSL account going with
    // the statement, and the folio left out.
    await tab.frames()[1].waitForFunction(([nsdl, cdsl, folio, statement]) => {
      const s = window.host.storage;
      return s.get(nsdl) === "holdings-1" && !s.has(cdsl) && s.get(folio) === "left-out" && s.get(statement) === "holdings-2";
    }, [nsdlKey, cdslKey, otherFolioKey, statementKey]);
    await hosted((state) => {
      const { storage, ...saved } = JSON.parse(state);
      Object.assign(window.host, saved, { storage: new Map(storage) });
    }, beforeUnavailableHoldings);
    // After saving, Use another file asks nothing.
    await readHoldings();
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    assert.deepEqual(await storage(), beforeIgnored);

    // The statement's own ignored account is needed only by the rows that go with it.
    await saveChoices([[statementKey, "hidden-2"]]);
    await readHoldings();
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await frame.getByText(hiddenDemat, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 1);
    assert.match(await investorSelect.textContent(), /Choose an account/);
    await openParts();
    for (const title of [cdslTitle, otherFolioTitle]) {
      assert.match(await sourceSelect(title).textContent(), /Same as above/);
      assert.doesNotMatch(await sourceSelect(title).textContent(), /\(/, "nothing is chosen for the statement");
    }
    assert.equal(await saveHoldings.isDisabled(), true);
    await choose(cdslTitle, "Demat (INR)");
    await choose(nsdlTitle, "Demat (INR)");
    assert.equal(await saveHoldings.isDisabled(), true, "the folio still goes with the statement");
    await choose(otherFolioTitle, "Don't save");
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await hosted((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeIgnored);

    // With no account left that tracks holdings, each select offers a new account, and still says why
    // each choice is ignored, so nothing is preselected. Each read loads the accounts again, so the
    // next one offers the account added meanwhile too.
    await saveChoices([[nsdlKey, "holdings-1"], [cdslKey, "holdings-1"]]);
    const withDemat = await storage();
    const beforeHidden = await accountList();
    await editAccounts({ "holdings-1": { isActive: false }, "holdings-2": { isActive: false } });
    await readHoldings();
    assert.equal(await frame.getByText(/^No account (can|tracks)/).count(), 0);
    await openParts();
    for (const [label, note] of [
      ["ANANYA R TESTWALA's holdings", unavailable("Fund folios, which is hidden in Wealthfolio")],
      [nsdlTitle, unavailable("Demat, which is hidden in Wealthfolio")],
      [cdslTitle, unavailable("Demat, which is hidden in Wealthfolio")],
    ]) {
      const select = label === "ANANYA R TESTWALA's holdings" ? investorSelect : sourceSelect(label);
      assert.match(await select.textContent(), /Choose an account/, label);
      // The note follows its select.
      const next = await select.evaluate((element, note) => {
        const shown = [...document.querySelectorAll("p")].find((p) => p.textContent === note && element.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
        return !!shown;
      }, note);
      assert.ok(next, `${label}: ${note}`);
    }
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    assert.equal(await saveHoldings.isDisabled(), true);
    await investorSelect.click();
    await frame.getByRole("option", { name: "New: NSDL Demat", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["New: NSDL Demat", "Don't save them"]);
    await tab.keyboard.press("Escape");
    await frame.getByRole("option").first().waitFor({ state: "detached" });
    await editAccounts({ "new-2": { name: "New demat", trackingMode: "HOLDINGS" } });
    await readHoldings();
    await openParts();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    await investorSelect.click();
    await frame.getByRole("option", { name: "New demat (INR)", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["New demat (INR)", "New: NSDL Demat", "Don't save them"]);
    await frame.getByRole("option", { name: "New demat (INR)", exact: true }).click();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    // Restored, they're offered again.
    await setAccountList(beforeHidden);
    await readHoldings();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.match(await investorSelect.textContent(), /Fund folios/);
    await answer("PLACEHOLDER PHARMA LIMITED", "skip");
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    assert.deepEqual(await storage(), withDemat);

    // The same share in two snapshot accounts has a row in each, grouped by account, and each row's
    // controls are named apart.
    await choose(cdslTitle, "Fund folios (INR)");
    await frame.getByText("To Demat", { exact: true }).waitFor();
    await frame.getByText("To Fund folios", { exact: true }).waitFor();
    const shareCosts = frame.getByRole("button", { name: /^Add cost: Fund INEZ90B01015, holding \d+$/ });
    assert.equal(await shareCosts.count(), 2);
    const [firstCost, secondCost] = await shareCosts.evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
    assert.notEqual(firstCost, secondCost);
    await choose(cdslTitle, "Demat (INR)");
    assert.equal(await frame.getByRole("button", { name: /^Add cost: Fund INEZ90B01015/ }).count(), 1);

    // A result or a chosen share quoted in another currency has a warning badge with its currency
    // and a line saying so, on its card and its row. A result in rupees, the other holdings and
    // their rows say nothing about currency.
    const democorp = ready("DEMOCORP BANK LIMITED");
    await democorp.getByRole("button", { name: /^Change: / }).click();
    const changePanel = frame.locator("[data-focus-first]");
    await changePanel.waitFor();
    const changeSearch = changePanel.getByRole("textbox", { name: /^Search by ISIN for / });
    // Change opens the holding's search in place, its box taking the focus.
    await focused(changeSearch, "Change");
    await changePanel.getByText("On your statement: DEMOCORP BANK LIMITED", { exact: true }).waitFor();
    await changeSearch.fill("Democorp Bank");
    await changeSearch.press("Enter");
    const usdOptions = changePanel.getByRole("radiogroup", { name: "Results for “Democorp Bank”" }).locator("label");
    await usdOptions.nth(1).waitFor();
    const usdTexts = (await usdOptions.allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    assert.deepEqual(usdTexts, [`Democorp Bank ADR USD FAKE · DMCB ${inUsd}`, "National Stock Exchange (NSE) Democorp Bank Ltd · FAKE · DEMOCORPBK.NS"]);
    assert.deepEqual(await usdOptions.evaluateAll((labels) => labels.map((label) =>
      [...label.querySelectorAll("[data-slot=badge]")].map((b) => `${b.textContent} ${b.dataset.variant}`))), [["USD warning-subtle"], []]);
    assert.equal(await quotedIn(frame).count(), 1);
    // Picked without a pointer: this page has no Wealthfolio CSS, so the label is an inline box broken
    // over several lines, and a pointer click's hit test misses it. With Wealthfolio's CSS it's a block
    // that a click lands on, as the desktop check confirms.
    await usdOptions.first().getByRole("radio").dispatchEvent("click");
    await changePanel.getByRole("button", { name: /^Use this listing for /, disabled: false }).click();
    await changePanel.waitFor({ state: "detached" });
    const usdRow = ready("Democorp Bank ADR");
    await usdRow.getByText(inUsd, { exact: true }).waitFor();
    assert.deepEqual(await badges(usdRow.locator("th")), ["USD warning-subtle"]);
    await usdRow.getByText(/ · chosen by you · /).waitFor();
    assert.equal(await quotedIn(frame).count(), 1);
    // Back to the share's own listing for the checks that follow: its ISIN's only result.
    await usdRow.getByRole("button", { name: /^Change: / }).click();
    await changePanel.getByRole("button", { name: /^Use this listing: Fund INEZ90C01021, for / }).click();
    await changePanel.waitFor({ state: "detached" });
    assert.equal(await quotedIn(frame).count(), 0);

    // A known MANUAL asset in an inactive account gets the statement's price, even when the target starts empty.
    await hosted(() => {
      window.host.held["archived-1"] = ["INFZ90K01LQ6"];
      window.host.pricingModes.INFZ90K01LQ6 = "MANUAL";
    });
    // Holdings show an asset's display code, which the user can change, so each is matched by the
    // symbol and exchange on its asset's profile: other accounts' holdings and pricing modes, and an
    // existing bond that the save finds for a choice without an asset ID. Restored after the save.
    const renamed = ["asset-INFZ90K01LQ6", "asset-INFZ90K01FC8", "asset-INEZ90B01015", "older-fund-012", "asset-INEZ93A08016"];
    await hosted((renamed) => {
      window.host.assets["asset-INEZ93A08016"] = { symbol: "INEZ93A08016", exchangeMic: null, instrumentType: "BOND", name: "Democorp Infra 7.60% 2033" };
      for (const id of renamed) {
        const symbol = id.replace(/^asset-/, "");
        const asset = window.host.assets[id] ?? { symbol, exchangeMic: "XBOM", instrumentType: "EQUITY", name: `Fund ${symbol}` };
        window.host.assets[id] = { ...asset, displayCode: `MY ${asset.symbol}` };
      }
    }, renamed);
    await revisit();
    await settled();
    const liquidReady = ready("Fictiva Liquid Fund - Direct Plan - Growth");
    await liquidReady.getByText(priced, { exact: true }).waitFor();
    await hosted(() => { window.host.pricingModes.INFZ90K01LQ6 = "MARKET"; });
    await revisit();
    await settled();
    await liquidReady.getByText(priced, { exact: true }).waitFor({ state: "detached" });
    await frame.getByText(/^Skipped \(1\): PLACEHOLDER PHARMA LIMITED, by your answer\.$/).waitFor();
    await frame.getByText("Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout. Their account in “Save to” is set to Don't save.", { exact: false }).waitFor();
    const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const rendered = await frame.locator("body").innerText();
    for (const number of nsdl.accounts.flatMap((a) => [a.dp_id, a.client_id]).filter(Boolean)) {
      assert.equal(rendered.includes(number), false, `A depository identifier is visible: ${number}`);
    }
    // Shares print no cost: added, or unknown. A bond's cost defaults to its face value.
    const demat = await snapshotTable("Demat");
    assert.equal(await demat.getByRole("row").count(), 12);
    const faceRow = ready("SAMPLE HOUSING FINANCE LIMITED 7.95 NCD 20JN28");
    await faceRow.getByText(/^Purchase cost ₹2,00,000, from the face value · /).waitFor();
    await faceRow.getByText(priced, { exact: true }).waitFor();
    // Below the statement's price, so the price saved after the snapshot must win over the average cost.
    // Western grouping commas are read as well as Indian ones.
    await setCost(ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31"), "45,000");
    await ready("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31").getByText(/^Purchase cost ₹45,000, added by you · /).waitFor();
    assert.equal(await ready("DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33").getByText(priced, { exact: true }).count(), 0);
    assert.equal((await ready("FICTIVA POWER AND LIGHT LIMITED").locator("td").first().textContent()).trim(), "150");
    const shortRow = ready("SAMPLEWORKS TECHNOLOGIES LIMITED");
    assert.equal((await shortRow.locator("td").first().textContent()).trim(), "520");
    await shortRow.getByText("Mutual funds also holds it.", { exact: true }).waitFor();
    // A cost is the whole input, checked: with a letter it stays open, says how to enter it, and
    // never saves part of it. Save or Cancel gives the focus back to the row's cost button, and the
    // Enter that saves doesn't open it again.
    const powerRow = ready("FICTIVA POWER AND LIGHT LIMITED");
    await powerRow.getByRole("button", { name: /^Add cost: / }).press("Enter");
    const costBox = frame.getByRole("textbox", { name: /^Total purchase cost of these 150 shares \(₹\)/ });
    await focused(costBox, "Add cost");
    await costBox.fill("₹1,85,175");
    await costBox.press("Enter");
    await costBox.waitFor({ state: "detached" });
    await focused(powerRow.getByRole("button", { name: /^Edit: purchase cost of / }), "Save, with Enter");
    await powerRow.getByText(/^Purchase cost ₹1,85,175, added by you · /).waitFor();
    await said.getByText("Purchase cost saved for Fund INEZ90A01017: ₹1,85,175.", { exact: true }).waitFor();
    const bankRow = ready("DEMOCORP BANK LIMITED");
    await bankRow.getByRole("button", { name: /^Add cost: / }).click();
    const bankBox = frame.getByRole("textbox", { name: /^Total purchase cost of these 75 shares \(₹\)/ });
    await bankBox.fill("40O00");
    await bankBox.press("Enter");
    const costHint = bankRow.getByText("Enter the total purchase cost using numbers, for example 40000.", { exact: true });
    await costHint.waitFor();
    assert.equal(await bankBox.getAttribute("aria-invalid"), "true");
    assert.equal(await bankBox.getAttribute("aria-describedby"), await costHint.getAttribute("id"));
    await focused(bankBox, "an invalid cost");
    // One edit at a time: the footer says which, Go to it goes back to it, and saving waits.
    await footer.getByText("Save or cancel your purchase-cost edit for Fund INEZ90C01021 first.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await ready("FICTIVA NIFTY 50 ETF").getByRole("button", { name: /^Add cost: / }).click();
    await focused(bankBox, "another Add cost while one is open");
    assert.equal(await bankBox.inputValue(), "40O00");
    await bankRow.getByText("Save or cancel this edit first.", { exact: true }).waitFor();
    await said.getByText("Save or cancel this edit first.", { exact: true }).waitFor();
    await ready("FICTIVA NIFTY 50 ETF").getByRole("button", { name: /^Change: / }).click();
    await focused(bankBox, "Change while a cost is open");
    await footer.getByRole("button", { name: "Go to it", exact: true }).click();
    await focused(bankBox, "Go to it");
    await bankRow.getByRole("button", { name: /^Cancel purchase cost: / }).click();
    await focused(bankRow.getByRole("button", { name: /^Add cost: / }), "Cancel");
    await bankRow.getByText(/^Purchase cost missing: gains will look too high · /).waitFor();
    // The footer names the missing costs, and Add costs goes to the first.
    await footer.getByText(/^Purchase cost missing for \d+ · /).waitFor();
    await footer.getByRole("button", { name: "Add costs", exact: true }).click();
    await focused(readyRows.getByRole("button", { name: /^Add cost: / }).first(), "Add costs");
    // The Flexi Cap fund is left out because Mutual funds holds it; the hand-added fund and the cash stay.
    await frame.getByText(/^Already tracked in Mutual funds \(1\)/).waitFor();
    const folios = await snapshotTable("Fund folios");
    assert.equal(await statusOf(folios, "Fund INFZ90K01FC8"), "Left out");
    assert.equal(await statusOf(folios, "Gilt fund"), "Kept");
    await frame.getByText("Cash carried over from the snapshot of 31 Jan 2025: INR 1500.", { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^This saves holdings history for /).count(), 0);
    await pause("snapshot");
    await saveHoldings.press("Enter");
    await waiting();
    // A market-priced asset's profile can fail after it's worked out; the other new assets stay readable.
    await hosted(() => { window.host.failGetProfileIds = ["asset-INEZ90C01021"]; });
    await clickOutside();
    await resume();
    await frame.getByText("Saved 2 snapshots").waitFor();
    await stayedOutside("Update holdings");
    // The funds already tracked elsewhere are named after saving, apart from what was saved.
    await frame.getByText(/^1 fund already tracked in Mutual funds wasn't saved here too[.;]/).waitFor();
    const snapshot = (id, date) => hosted(([id, date]) => window.host.snapshots[id][date], [id, date]);
    const first = await snapshot("holdings-1", "2025-03-31");
    for (const isin of ["INEZ90A01017", "INEZ90C01021"]) {
      assert.equal(first.holdings.find((h) => h.symbol === isin).assetId, undefined);
      const ref = `${isin}@XBOM`;
      const records = Object.entries(await storage()).filter(([key]) => key.startsWith("holdings-imported:"))
        .map(([, value]) => JSON.parse(value).dates["2025-03-31"]).filter((entry) => entry?.refs[ref]);
      assert.ok(records.length);
      for (const entry of records) {
        assert.deepEqual(entry.refs[ref], [isin]);
        assert.equal(entry.ids?.[ref], isin === "INEZ90C01021" ? undefined : `asset-${isin}`);
      }
    }
    await frame.getByText("Some import history could not be saved", { exact: true }).waitFor();
    const indexes = Object.entries(await storage()).filter(([key]) => key.startsWith("holdings-sources:"));
    assert.ok(indexes.some(([, value]) => Object.values(JSON.parse(value)).some((keys) => keys.includes(unindexedAside))));
    await hosted((key) => { window.host.storage.delete(key); }, unindexedAside);
    await hosted(() => { window.host.failGetProfileIds = []; });
    assert.deepEqual(first.cash, {});
    assert.deepEqual(
      first.holdings.map((h) => [h.symbol, h.quantity, h.averageCost ?? null]),
      [
        ["INEZ90A01017", "150", "1234.5"],
        ["INEZ90B01015", "520", null],
        ["INEZ90C01021", "75", null],
        ["INFZ90K01NE8", "1200", null],
        ["INEZ91A07012", "50", "900"],
        ["INEZ91B07028", "2", "100000"],
        ["INEZ92A01013", "200", null],
        ["INFZ91T01NF4", "1523.456", null],
        ["INFZ91T01GE1", "300", null],
        ["INEZ92A07036", "25", null],
        ["INEZ93A08016", "5", null],
      ],
    );
    // Bonds priced from statements are created priced by hand, with no exchange; the one found by search isn't.
    assert.deepEqual(
      first.holdings.filter((h) => h.instrumentType === "BOND").map((h) => [h.symbol, h.exchangeMic ?? null, h.dataSource ?? null]),
      [["INEZ91A07012", null, "MANUAL"], ["INEZ91B07028", null, "MANUAL"], ["INEZ92A07036", null, "MANUAL"], ["INEZ93A08016", null, null]],
    );
    const fromHost = await hosted(() => ({ quotes: window.host.quotes, assets: window.host.assets, modes: window.host.pricingModes }));
    const closes = (id) => (fromHost.quotes[id] ?? []).map((q) => [q.timestamp.slice(0, 10), q.close, q.dataSource]);
    // The statement's price, over the average cost the save wrote; NSDL prints value ÷ bonds, CDSL the market price.
    assert.deepEqual(closes("bond-created-001"), [["2025-03-31", 1000, "MANUAL"]]);
    assert.equal(fromHost.quotes["bond-created-001"][0].id, "bond-created-001_2025-03-31_MANUAL");
    assert.deepEqual(closes("asset-INEZ91B07028"), [["2025-03-31", 100000, "MANUAL"]]);
    assert.deepEqual(closes("asset-INEZ92A07036"), [["2025-03-31", 1012.4, "MANUAL"]]);
    assert.deepEqual(closes("asset-INEZ93A08016"), []);
    // The printed details are on the asset, and its name and pricing mode are unchanged.
    const ncd = fromHost.assets["bond-created-001"];
    assert.equal(ncd.name, "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31");
    assert.equal(ncd.notes, "");
    assert.equal(fromHost.modes.INEZ91A07012, "MANUAL");
    assert.deepEqual(ncd.metadata.bond, { isin: "INEZ91A07012", maturityDate: "2031-04-15", couponRate: 0.081, couponFrequency: "ANNUAL", faceValue: 1000 });
    assert.equal(ncd.metadata.casStatement.couponFrequency, "Once a year");
    assert.equal(fromHost.assets["asset-INEZ91B07028"].metadata.casStatement.couponFrequency, "On Maturity");
    assert.equal(fromHost.assets["asset-INEZ91B07028"].metadata.bond.couponFrequency, undefined);
    assert.deepEqual(fromHost.assets["asset-INEZ93A08016"].metadata, {
      casStatement: { name: "DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33", isin: "INEZ93A08016" }, bond: { isin: "INEZ93A08016" },
    });
    assert.equal(fromHost.modes.INEZ93A08016, "MARKET");
    // The host's local result is EQUITY: resolve the old MUTUALFUND choice before saving its quote.
    assert.equal(JSON.parse((await storage())["isin:INFZ91T01NF4"]).assetId, undefined);
    assert.equal(JSON.parse((await storage())["isin:INFZ91T01NF4"]).instrumentType, "MUTUALFUND");
    assert.equal(first.holdings.find((h) => h.symbol === "INFZ91T01NF4").assetId, "older-fund-012");
    assert.deepEqual(fromHost.quotes["older-fund-012"].map((q) => [q.close, q.notes]), [[
      Number(nsdl.accounts.flatMap((a) => a.mutual_funds).find((h) => h.isin === "INFZ91T01NF4").nav), "Keep the older fund quote note",
    ]]);
    assert.deepEqual(Object.entries(fromHost.assets).filter(([, a]) => a.symbol === "INFZ91T01NF4").map(([id]) => id), ["older-fund-012"]);
    assert.equal(fromHost.modes.INFZ91T01NF4, "MANUAL");
    assert.equal(JSON.parse((await storage())["isin:INEZ91A07012"]).statementPrices, true);
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
    await hosted((renamed) => { for (const id of renamed) window.host.assets[id].displayCode = window.host.assets[id].symbol; }, renamed);

    // A fund confirmed to another asset than the one an earlier import of its folio added keeps that
    // asset, and leaves the new one out, until one choice under Before saving replaces the old asset with it.
    const balancedName = "Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment";
    const changePanelOf = () => frame.locator("[data-focus-first]");
    // Changes a ready holding to a result its Change panel finds for `query`, or to its only result.
    const changeTo = async (row, query, result) => {
      await row.getByRole("button", { name: /^Change: / }).click();
      const panel = changePanelOf();
      await panel.waitFor();
      await panel.getByText(/Searching…/).waitFor({ state: "detached" });
      if (query) {
        const box = panel.getByRole("textbox", { name: /^Search by / });
        await box.fill(query);
        await box.press("Enter");
        // The automatic search can list the same result: pick it among the typed search's results.
        await panel.getByRole("radiogroup", { name: `Results for “${query}”` }).getByRole("radio", { name: result }).dispatchEvent("click");
        await panel.getByRole("button", { name: /^Use this (fund|listing|bond|NPS scheme) for /, disabled: false }).click();
      } else {
        const single = panel.getByRole("button", { name: /^Use this (fund|listing|bond|NPS scheme): / });
        if (await single.count()) await single.click();
        else {
          await panel.getByRole("radio").first().dispatchEvent("click");
          await panel.getByRole("button", { name: /^Use this (fund|listing|bond|NPS scheme) for /, disabled: false }).click();
        }
      }
      await panel.waitFor({ state: "detached" });
      await settled();
    };
    const beforeSaving = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "Before saving", exact: true }) });
    // A decision under Before saving, by the holding's name.
    const decision = (name) => beforeSaving.locator("div.border-t").filter({ has: frame.locator("span.font-medium", { hasText: new RegExp(`^${escaped(name)}$`) }) });
    const reread = async () => {
      await readHoldings();
      if (await question("PLACEHOLDER PHARMA LIMITED").count()) await answer("PLACEHOLDER PHARMA LIMITED", "skip");
      await settled();
    };
    const replaceAndSave = async (oldName, newName, oldSymbol, newSymbol) => {
      const [oldAsset, newAsset] = [`${oldName} (${oldSymbol} · XBOM)`, `${newName} (${newSymbol} · XBOM)`];
      const [oldEntry, newEntry] = [decision(oldName), decision(newName)];
      const replace = newEntry.getByRole("checkbox", { name: `Replace ${oldAsset} with ${newAsset} in Fund folios`, exact: true });
      await replace.waitFor({ state: "attached" });
      assert.equal(await replace.getAttribute("aria-checked"), "false");
      await newEntry.getByText(
        `An earlier import of Folio 91234567/12 added this holding as ${oldAsset}. So that it isn't counted twice, it's left out unless you replace ${oldAsset} with it. ` +
        "Replace it only if all its units came from Folio 91234567/12: imports don't record how many units each folio, demat account or PRAN added.",
        { exact: true },
      ).waitFor();
      assert.equal(await newEntry.getByText("Left out", { exact: true }).count(), 1);
      // Not included says it waits for that choice.
      await frame.getByText(new RegExp(`^Left out unless you choose otherwise under “Before saving” \\(1\\): ${escaped(newName)}\\.$`)).waitFor();
      await oldEntry.getByText(`An earlier import of Folio 91234567/12 added it for a holding that this import lists under ${newAsset}. It's kept unless you replace it with ${newAsset}.`, { exact: true }).waitFor();
      assert.equal(await oldEntry.getByText("Kept", { exact: true }).count(), 1);
      // The old row has no choice of its own.
      assert.equal(await oldEntry.getByRole("checkbox").count(), 0);
      await replace.dispatchEvent("click");
      await oldEntry.getByText("Replaced", { exact: true }).waitFor();
      assert.equal(await newEntry.getByText("New", { exact: true }).count(), 1);
      await sameDay("Demat").dispatchEvent("click");
      await sameDay("Fund folios").dispatchEvent("click");
      await saveHoldings.click();
      await frame.getByText("Saved 2 snapshots").waitFor();
      return (await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => [h.symbol, h.quantity]);
    };
    await reread();
    // Both accounts have a snapshot on this date now: replacing each needs a tick, which is a question until it's given.
    await footer.getByText("2 questions left before saving.", { exact: true }).waitFor();
    await footer.getByRole("button", { name: "Go to the next question", exact: true }).click();
    await focused(beforeSaving.getByRole("heading"), "Go to the next question, Before saving");
    await changeTo(ready(balancedName), "MULTI", /^Fund A /);
    assert.deepEqual(await replaceAndSave("Fund INFZ90K01BA1", "Fund A", "INFZ90K01BA1", "A"), [
      ["GILT", "-10"], ["INFZ90K01LQ6", "8.053"], ["A", "3540.293"],
    ]);
    // The import remembers the replacement, so going back is offered the same way.
    await reread();
    await changeTo(ready(balancedName), "INFZ90K01BA1", /^Fund INFZ90K01BA1 /);
    assert.deepEqual(await replaceAndSave("Fund A", "Fund INFZ90K01BA1", "A", "INFZ90K01BA1"), [
      ["GILT", "-10"], ["INFZ90K01LQ6", "8.053"], ["INFZ90K01BA1", "3540.293"],
    ]);

    // A fund left out because Mutual funds holds it, but that an earlier import of its folio added
    // here, keeps the account's units or removes them only by the user's choice, and removing them
    // confirms that all of them came from the folio.
    const flexiName = "Fictiva Flexi Cap Fund - Direct Plan - Growth";
    const showTracked = frame.getByRole("button", { name: /^Show (it|them)$/ });
    const saveBoth = async () => {
      if ((await showTracked.getAttribute("aria-expanded")) !== "true") await showTracked.click();
      await frame.getByRole("button", { name: /^Save in both accounts: / }).click();
      await frame.getByText(/^Counted in both accounts: /).waitFor();
      await settled();
    };
    const replaceBoth = async () => {
      await sameDay("Demat").dispatchEvent("click");
      await sameDay("Fund folios").dispatchEvent("click");
    };
    await reread();
    await saveBoth();
    await ready(flexiName).waitFor();
    await replaceBoth();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "INFZ90K01FC8").quantity, "2892.104");
    await reread();
    // Each choice names the holding and account after its visible text, for screen readers.
    const flexiEntry = decision("Fund INFZ90K01FC8");
    const keepFlexi = flexiEntry.getByRole("radio", { name: "Keep its 2892.104 units for Fund INFZ90K01FC8 in Fund folios", exact: true });
    const removeFlexi = flexiEntry.getByRole("radio", {
      name: "Remove its 2892.104 units: all of them came from Folio 91234567/12 for Fund INFZ90K01FC8 in Fund folios", exact: true,
    });
    await keepFlexi.waitFor({ state: "attached" });
    await flexiEntry.getByRole("radiogroup", { name: "Keep or remove its 2892.104 units for Fund INFZ90K01FC8 in Fund folios", exact: true }).waitFor();
    await flexiEntry.getByText(
      "An earlier import of Folio 91234567/12 recorded adding this holding. Leaving this row out keeps the 2892.104 units this account holds unless you remove them. Keeping them counts them here and in Mutual funds. " +
      "Keep them, or remove them only if all of them came from Folio 91234567/12: imports don't record how many units each folio, demat account or PRAN added.",
      { exact: true },
    ).waitFor();
    assert.equal(await flexiEntry.getByText("Needs a choice", { exact: true }).count(), 1);
    assert.deepEqual([await keepFlexi.getAttribute("aria-checked"), await removeFlexi.getAttribute("aria-checked")], ["false", "false"]);
    await replaceBoth();
    // The undecided keep or remove is an open question until it's answered.
    await footer.getByText("1 question left before saving.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await keepFlexi.dispatchEvent("click");
    await flexiEntry.getByText("Kept", { exact: true }).waitFor();
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    // Saving the statement's units in both accounts replaces the account's, so there's nothing to choose.
    await saveBoth();
    assert.equal(await statusOf(await snapshotTable("Fund folios"), "Fund INFZ90K01FC8"), "Updated");
    assert.equal(await flexiEntry.getByRole("radio").count(), 0);
    await frame.getByRole("button", { name: /^Don't save it here: / }).click();
    await frame.getByText(/^Counted in both accounts: /).waitFor({ state: "detached" });
    await removeFlexi.dispatchEvent("click");
    await flexiEntry.getByText("Removed", { exact: true }).waitFor();
    assert.equal(await removeFlexi.getAttribute("aria-checked"), "true");
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.symbol), ["GILT", "INFZ90K01LQ6", "INFZ90K01BA1"]);
    // Removed with the earlier import's record, so the next review has nothing to choose.
    await reread();
    assert.equal(await statusOf(await snapshotTable("Fund folios"), "Fund INFZ90K01FC8"), "Left out");
    assert.equal(await frame.getByRole("radio", { name: /^(Keep|Remove) its / }).count(), 0);
    await frame.getByText(/^Already tracked in Mutual funds \(1\)/).waitFor();
    assert.equal(await frame.getByText(/^(An earlier import of Folio 91234567\/12 recorded|Leaving this row out)/).count(), 0);

    // Skipping a still-listed fund keeps both its units and the earlier import's provenance.
    await ready("Fictiva Liquid Fund - Direct Plan - Growth").getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().getByRole("button", { name: /^Skip this holding: / }).click();
    await changePanelOf().waitFor({ state: "detached" });
    await focused(frame.getByRole("heading", { name: /^Ready to save/ }), "Skip this holding, in Change");
    await settled();
    assert.equal(await statusOf(await snapshotTable("Fund folios"), "Fund INFZ90K01LQ6"), "Kept");
    await replaceBoth();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "INFZ90K01LQ6").quantity, "8.053");

    // Once that fund is no longer listed, the remembered import still removes it by default, also
    // after its asset's symbol changed in Wealthfolio and its choice was forgotten: the record's
    // asset ID tells its asset. Replacing a snapshot on the same date needs confirming;
    // Wealthfolio's cost carries over, also to a holding whose display code was changed.
    await hosted(() => {
      window.host.soldIsins = ["INFZ90K01LQ6"];
      window.host.assets["asset-INEZ90A01017"].displayCode = "MY SHARE";
      window.host.assets["asset-INFZ90K01LQ6"].instrumentSymbol = "MY-LIQUID";
      window.host.storage.delete("isin:INFZ90K01LQ6");
    });
    await reread();
    await frame.getByText("15 holdings", { exact: true }).waitFor();
    const sold = decision("Fund INFZ90K01LQ6");
    await sold.getByText("Not on the statement any more. An earlier import of Folio 91234567/12 added it.").waitFor();
    assert.equal(await sold.getByText("Removed", { exact: true }).count(), 1);
    assert.equal(await frame.getByRole("checkbox", { name: "Keep Fund INFZ90K01LQ6 in Fund folios", exact: true }).isChecked(), false);
    const powerReady = ready("FICTIVA POWER AND LIGHT LIMITED");
    await powerReady.getByText(/^Purchase cost ₹1,85,175, from your earlier holdings · /).waitFor();
    assert.equal(await powerReady.count(), 1);
    assert.equal(await saveHoldings.isDisabled(), true);
    // Both accounts have a snapshot on this date; each tick names its account.
    await replaceBoth();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual(
      (await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.assetId ?? h.symbol),
      ["asset-gilt", "asset-INFZ90K01BA1"],
    );
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].averageCost, "1234.5");
    await hosted(() => {
      window.host.assets["asset-INEZ90A01017"].displayCode = "INEZ90A01017";
      delete window.host.assets["asset-INFZ90K01LQ6"].instrumentSymbol;
      window.host.storage.delete("isin:INFZ90K01LQ6");
    });
    // A resolved choice still supplies its symbol when its profile has none, even when the display
    // code matches another asset's symbol.
    const shareChoiceBefore = (await storage())["isin:INEZ90A01017"];
    await reread();
    await changeTo(ready("FICTIVA POWER AND LIGHT LIMITED"));
    await hosted(() => {
      window.host.assets["asset-INEZ90A01017"].displayCode = "INEZ90C01021";
      window.host.assets["asset-INEZ90A01017"].instrumentSymbol = null;
    });
    await revisit();
    await settled();
    await ready("FICTIVA POWER AND LIGHT LIMITED").getByText(/^Purchase cost ₹1,85,175, from your earlier holdings · /).waitFor();
    assert.equal(await ready("FICTIVA POWER AND LIGHT LIMITED").count(), 1);
    await hosted((choice) => {
      window.host.assets["asset-INEZ90A01017"].displayCode = "INEZ90A01017";
      delete window.host.assets["asset-INEZ90A01017"].instrumentSymbol;
      window.host.storage.set("isin:INEZ90A01017", choice);
    }, shareChoiceBefore);
    // An empty demat account still reconciles its sold holdings. After saving, a manual-priced
    // holding on the statement gets its printed price, and a kept one the price it had, not their
    // average costs.
    await hosted(() => {
      window.host.soldIsins.push("INEZ90A01017", "INEZ90B01015", "INEZ90C01021", "INFZ90K01NE8", "INEZ91A07012", "INEZ91B07028");
      const share = window.host.snapshots["holdings-1"]["2025-03-31"].holdings.find((h) => h.symbol === "INEZ92A01013");
      window.host.pricingModes.INEZ92A01013 = "MANUAL";
      share.averageCost = "12";
      window.host.quotes["asset-INEZ92A01013"] = [
        { id: "share-provider", assetId: "asset-INEZ92A01013", timestamp: "2025-03-31T16:00:00Z", createdAt: "2025-03-31T16:30:00Z", open: 790, high: 810, low: 780, close: 800, adjclose: 795, volume: 420, currency: "INR", dataSource: "YAHOO", notes: "Keep the share's quote note" },
      ];
      const gilt = window.host.snapshots["holdings-2"]["2025-03-31"].holdings.find((h) => h.symbol === "GILT");
      window.host.pricingModes.GILT = "MANUAL";
      gilt.averageCost = "3";
      window.host.quotes["asset-gilt"] = [
        { id: "q1", assetId: "asset-gilt", timestamp: "2025-02-28T12:00:00Z", createdAt: "", open: 105, high: 105, low: 105, close: 105, adjclose: 105, volume: 0, currency: "INR", dataSource: "MANUAL" },
        { id: "provider", assetId: "asset-gilt", timestamp: "2025-02-28T16:00:00Z", createdAt: "", open: 115, high: 115, low: 115, close: 115, adjclose: 115, volume: 0, currency: "INR", dataSource: "YAHOO" },
        { id: "q2", assetId: "asset-gilt", timestamp: "2025-04-30T12:00:00Z", createdAt: "", open: 110, high: 110, low: 110, close: 110, adjclose: 110, volume: 0, currency: "INR", dataSource: "MANUAL" },
        { id: "legacy-gilt-quote", assetId: "asset-gilt", timestamp: "2025-03-31T09:15:00Z", createdAt: "2025-03-31T09:20:00Z", open: 107, high: 109, low: 106, close: 108.25, adjclose: 107.75, volume: 321, currency: "INR", dataSource: "MANUAL", notes: "Keep the gilt's full quote" },
        { id: "gilt-provider", assetId: "asset-gilt", timestamp: "2025-03-31T16:00:00Z", createdAt: "2025-03-31T16:20:00Z", open: 111, high: 114, low: 110, close: 112, adjclose: 111.5, volume: 640, currency: "INR", dataSource: "YAHOO", notes: "Keep the provider row too" },
      ];
      window.host.snapshots["holdings-2"]["2025-03-31"].holdings.push({ assetId: "asset-earlier", symbol: "EARLIER", quantity: "1", averageCost: "2", currency: "INR" });
      window.host.pricingModes.EARLIER = "MANUAL";
      window.host.quotes["asset-earlier"] = [
        { id: "earlier-price", assetId: "asset-earlier", timestamp: "2025-02-28T12:00:00Z", createdAt: "", open: 7, high: 7, low: 7, close: 7, adjclose: 7, volume: 0, currency: "INR", dataSource: "MANUAL" },
        { id: "future-price", assetId: "asset-earlier", timestamp: "2025-04-30T12:00:00Z", createdAt: "", open: 9, high: 9, low: 9, close: 9, adjclose: 9, volume: 0, currency: "INR", dataSource: "MANUAL" },
      ];
      window.host.snapshots["holdings-2"]["2025-03-31"].holdings.push({ assetId: "asset-provider", symbol: "PROVIDER", quantity: "2", averageCost: "3", currency: "INR" });
      window.host.pricingModes.PROVIDER = "MANUAL";
      window.host.quotes["asset-provider"] = [
        { id: "provider-only", assetId: "asset-provider", timestamp: "2025-03-31T16:00:00Z", createdAt: "2025-03-31T16:30:00Z", open: 18, high: 22, low: 17, close: 20, adjclose: 19.5, volume: 123, currency: "INR", dataSource: "YAHOO", notes: "Keep the original provider quote" },
      ];
    });
    const quotesBeforeSave = await hosted(() => window.host.quotes);
    await reread();
    await frame.getByText("9 holdings", { exact: true }).waitFor();
    await openParts();
    assert.match(await sourceSelect(nsdlTitle).textContent(), /Demat/);
    for (const name of ["Fund INEZ90A01017", "Fund INFZ90K01NE8", "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31"]) {
      assert.equal(await decision(name).getByText("Removed", { exact: true }).count(), 1, name);
    }
    await ready("Fund INEZ92A01013").getByText(priced, { exact: true }).waitFor();
    assert.equal(await statusOf(await snapshotTable("Fund folios"), "Gilt fund"), "Kept");
    await replaceBoth();
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual((await snapshot("holdings-1", "2025-03-31")).holdings.map((h) => h.symbol), ["INEZ92A01013", "INFZ91T01NF4", "INFZ91T01GE1", "INEZ92A07036", "INEZ93A08016"]);
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].averageCost, "12");
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.symbol), ["GILT", "EARLIER", "PROVIDER", "INFZ90K01BA1"]);
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).cash, { INR: "1500" });
    const after = await hosted(() => ({ quotes: window.host.quotes, modes: window.host.pricingModes }));
    const on = (id, day) => after.quotes[id].filter((q) => q.timestamp.startsWith(day) && q.dataSource === "MANUAL").map((q) => q.close);
    assert.deepEqual(on("asset-INEZ92A01013", "2025-03-31"), [845.2]);
    assert.equal(after.quotes["asset-INEZ92A01013"].find((q) => q.dataSource === "MANUAL").notes, "Keep the share's quote note");
    // Both provider rows survive; the kept manual quote retains every original field and its legacy ID.
    assert.deepEqual(after.quotes["asset-INEZ92A01013"].find((q) => q.id === "share-provider"), quotesBeforeSave["asset-INEZ92A01013"][0]);
    for (const original of quotesBeforeSave["asset-gilt"]) assert.deepEqual(after.quotes["asset-gilt"].find((q) => q.id === original.id), original);
    assert.deepEqual(on("asset-gilt", "2025-03-31"), [108.25]);
    // Without an exact-day quote, carry the earlier price and retain the future quote untouched.
    assert.deepEqual(on("asset-earlier", "2025-03-31"), [7]);
    for (const original of quotesBeforeSave["asset-earlier"]) assert.deepEqual(after.quotes["asset-earlier"].find((q) => q.id === original.id), original);
    const [providerOnly] = quotesBeforeSave["asset-provider"];
    assert.deepEqual(after.quotes["asset-provider"].find((q) => q.id === providerOnly.id), providerOnly);
    assert.deepEqual(after.quotes["asset-provider"].find((q) => q.dataSource === "MANUAL"), { ...providerOnly, id: "asset-provider_2025-03-31_MANUAL", dataSource: "MANUAL" });
    assert.equal(after.modes.INEZ92A01013, "MANUAL");

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
    await reread();
    await frame.getByText("10 holdings", { exact: true }).waitFor();
    const sharesRow = ready("SAMPLEWORKS TECHNOLOGIES LIMITED");
    await sharesRow.getByText(priced, { exact: true }).waitFor();
    // A statement older than the account's latest snapshot saves history: the review and the footer say so.
    const laterNote = "This saves holdings history for 31 Mar 2025. Demat's current holdings still come from its snapshot of 30 Apr 2025.";
    await frame.getByRole("heading", { name: /^Ready to save/ }).locator("xpath=..").getByText(laterNote, { exact: true }).waitFor();
    await footer.getByText(laterNote, { exact: true }).waitFor();
    await changeTo(sharesRow);
    // With no observed holding left, the current search result still carries its MANUAL mode.
    const laterSnapshot = await snapshot("holdings-1", "2025-04-30");
    await hosted(() => { delete window.host.snapshots["holdings-1"]["2025-04-30"]; });
    await revisit();
    await settled();
    await sharesRow.getByText(priced, { exact: true }).waitFor();
    // A live mode change overrides the mode the search result supplied earlier.
    await hosted((later) => {
      window.host.snapshots["holdings-1"]["2025-04-30"] = later;
      window.host.pricingModes.INEZ90B01015 = "MARKET";
    }, laterSnapshot);
    await revisit();
    await settled();
    await sharesRow.getByText(priced, { exact: true }).waitFor({ state: "hidden" });
    await setCost(sharesRow, "1000");
    await replaceBoth();
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-04-30")).holdings[0].averageCost, "20");
    assert.equal(await hosted(() => window.host.quotes["asset-INEZ90B01015"]), undefined);
    assert.equal(JSON.parse((await storage())["isin:INEZ90B01015"]).manual, undefined);

    // Archived accounts are absent from portfolio.getHoldings, but their saved assets still use
    // their global pricing mode. The next read finds the hidden account archived, tracking transactions.
    await hosted((isins) => {
      window.host.soldIsins = isins.filter((isin) => isin !== "INEZ90A01017");
      Object.assign(window.host.accounts.find((a) => a.id === "archived-1"), { trackingMode: "TRANSACTIONS", isArchived: true });
      window.host.pricingModes.INEZ90A01017 = "MANUAL";
      window.host.snapshots["archived-1"] = {
        "2025-03-31": { holdings: [{ symbol: "INEZ90A01017", quantity: "1", averageCost: "20", currency: "INR" }], cash: {}, source: "CALCULATED" },
      };
    }, nsdl.accounts.flatMap((a) => [...a.equities, ...a.mutual_funds, ...a.bonds].map((h) => h.isin)));
    await readHoldings("tests/fixtures/made-up-nsdl.pdf");
    await sameDay("Demat").dispatchEvent("click");
    await frame.getByRole("button", { name: /^(Update|Save) holdings$/, disabled: false }).waitFor();
    await ready("FICTIVA POWER AND LIGHT LIMITED").getByText(priced, { exact: true }).waitFor();

    // An NPS account's schemes: searched by name, then priced from the statement, one asset per
    // scheme. A scheme without units is left out. A PRAN's remembered account that's archived is
    // ignored too, though it doesn't track holdings either.
    const scheme = "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME E - TIER I";
    const pranKey = (pran) => `holdings-source:${createHash("sha256").update(`cas-importer holdings source nps|${pran}`).digest("hex")}`;
    await hosted(() => {
      window.host.onlyNps = [
        { scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME E - TIER I", units: "40" },
        { scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I", units: "0" },
      ];
      window.host.assetIds["NPS-TEST-E-TIER-I"] = "pension-created-007";
      // A lone same-symbol bond must not replace the new EQUITY choice priced from statements.
      window.host.assets["unrelated-bond-013"] = {
        symbol: "NPS-TEST-E-TIER-I", exchangeMic: null, instrumentType: "BOND", name: "Different bond",
      };
    });
    await saveChoices([[pranKey("XXXXXXXX9001"), "archived-2"]]);
    await readHoldings();
    await frame.getByText("NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I, NPS account (PRAN XXXXXXXX9001): No units on the statement.", { exact: true }).waitFor();
    const npsCard = question(scheme);
    await npsCard.getByText("Nothing found for its name. Search by its name below, or use the price on the statement.", { exact: true }).waitFor();
    // A card without funds never recommends AMFI.
    assert.equal(await frame.getByText(/^AMFI (isn't|may not be) added/).count(), 0);
    await openParts();
    await frame.getByText(oldFunds, { exact: true }).waitFor();
    assert.match(await sourceSelect("NPS account (PRAN XXXXXXXX9001)").textContent(), /Choose an account/);
    // An NPS scheme's results have no plan or option badges, even when their names give them.
    const npsBox = npsCard.getByRole("textbox", { name: /^Search by name for / });
    await npsBox.fill("Fictiva Flexi Cap");
    await npsBox.press("Enter");
    await npsCard.getByRole("radio").nth(4).waitFor({ state: "attached" });
    assert.deepEqual(await badges(npsCard), []);
    await npsCard.getByRole("radio").nth(1).dispatchEvent("click");
    await npsCard.getByRole("button", { name: /^Use this NPS scheme for / }).click();
    await npsCard.waitFor({ state: "detached" });
    // Changed to the statement's price from its row.
    await ready(scheme).getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().getByRole("button", { name: /^(None of these: use|Use) the price on the statement for / }).click();
    await ready(scheme).getByText(/^Prices from the statement · chosen by you/).waitFor();
    // Its investor is the statement's name, not the PAN of the earlier statements, so nothing else is remembered.
    assert.match(await investorSelect.textContent(), /Choose an account/);
    await footer.getByText("1 question left before saving.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    // A Change open on a holding whose account isn't chosen yet stays open on its row once the account
    // is chosen, with its Cancel, and the bar doesn't keep waiting on it after Cancel.
    await ready(scheme).getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().waitFor();
    await choose("NPS account (PRAN XXXXXXXX9001)", "Fund folios (INR)");
    await ready(scheme).waitFor();
    await changePanelOf().getByRole("button", { name: /^Cancel the change to / }).click();
    await changePanelOf().waitFor({ state: "detached" });
    assert.equal(await footer.getByText(/^Save or cancel your change/).count(), 0);
    await ready(scheme).getByText(priced, { exact: true }).waitFor();
    assert.equal(await statusOf(await snapshotTable("Fund folios"), scheme), "New");
    await sameDay("Fund folios").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    const pension = (await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I");
    assert.deepEqual([pension.quantity, pension.name, pension.instrumentType, pension.dataSource, pension.exchangeMic ?? null], ["40", scheme, "EQUITY", "MANUAL", null]);
    const npsHost = await hosted(() => ({ quotes: window.host.quotes["pension-created-007"], asset: window.host.assets["pension-created-007"] }));
    assert.deepEqual(npsHost.quotes.map((q) => [q.timestamp, q.close, q.dataSource, q.currency]), [["2025-03-31T12:00:00.000Z", 25.5, "MANUAL", "INR"]]);
    assert.deepEqual(npsHost.asset.metadata, { casStatement: { scheme, fundManager: "TEST PENSION FUND LIMITED", tier: "I", assetClass: "E" } });
    assert.equal(npsHost.quotes[0].id, "pension-created-007_2025-03-31_MANUAL");
    assert.equal(await hosted(() => window.host.quotes["unrelated-bond-013"]), undefined);
    assert.equal(await hosted(() => window.host.assets["unrelated-bond-013"].instrumentType), "BOND");
    await hosted(() => { delete window.host.assets["unrelated-bond-013"]; });
    assert.ok(Object.keys(await storage()).some((key) => /^nps:[0-9a-f]{64}$/.test(key)));
    assert.equal((await storage())[pranKey("XXXXXXXX9001")], "holdings-2");

    // The same date replaces the snapshot and quote, without creating another asset or changing its quote ID.
    await readHoldings();
    await ready(scheme).getByText(/^Prices from the statement · chosen before/).waitFor();
    await sameDay("Fund folios").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.deepEqual(await hosted(() => window.host.quotes["pension-created-007"].map((q) => [q.id, q.timestamp, q.close])), npsHost.quotes.map((q) => [q.id, q.timestamp, q.close]));
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").assetId, "pension-created-007");

    // Another PRAN shares the scheme's asset; a later statement adds a dated quote and preserves the earlier snapshot.
    await hosted(() => {
      window.host.statementDate = "30-Apr-2025";
      window.host.npsPran = "XXXXXXXX9002";
      window.host.onlyNps = [{ scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME E - TIER I", units: "50" }];
    });
    await readHoldings();
    await choose("NPS account (PRAN XXXXXXXX9002)", "Demat (INR)");
    await setCost(ready(scheme), "500");
    await sameDay("Demat", "30 Apr 2025").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-04-30")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").assetId, "pension-created-007");
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").quantity, "40");
    assert.deepEqual(await hosted(() => window.host.quotes["pension-created-007"].map((q) => [q.timestamp.slice(0, 10), q.close, q.id])), [
      ["2025-03-31", 25.5, "pension-created-007_2025-03-31_MANUAL"], ["2025-04-30", 25.5, "pension-created-007_2025-04-30_MANUAL"],
    ]);
    assert.equal(await hosted(() => Object.values(window.host.assets).filter((a) => a.symbol === "NPS-TEST-E-TIER-I").length), 1);

    // With the only PRAN set to Don't save, Not included says so, and the footer offers Finish.
    await readHoldings();
    await choose("NPS account (PRAN XXXXXXXX9002)", "Don't save");
    await frame.getByText(`Not saved (1): ${scheme}. Their account in “Save to” is set to Don't save.`, { exact: true }).waitFor();
    await footer.getByText("Nothing from this statement will be saved.", { exact: true }).waitFor();
    await footer.getByRole("button", { name: "Finish", exact: true }).waitFor();
    assert.equal(await saveHoldings.count(), 0);

    // An unheld remembered fallback that the user switched to MARKET keeps its mode and profile.
    await hosted(() => {
      window.host.snapshots = {};
      window.host.held = {};
      window.host.statementDate = "31-Mar-2025";
      window.host.npsPran = "XXXXXXXX9001";
      window.host.pricingModes["NPS-TEST-E-TIER-I"] = "MARKET";
      Object.assign(window.host.assets["pension-created-007"], {
        displayCode: "MY-PENSION", name: "My pension", notes: "Keep these notes", kind: "OTHER",
        providerConfig: { preferred_provider: "CUSTOM", overrides: { CUSTOM: { symbol: "pension" } } },
        metadata: { custom: { keep: true } },
      });
    });
    // A failed lookup cannot treat an unheld MARKET asset as a new manual-priced one. Opening the page
    // again reads Wealthfolio again.
    const cantWorkOut = (pattern) => footer.getByText(new RegExp(`^Couldn't work out what will be saved: Error: ${pattern}`));
    for (const failure of ["search", "profile"]) {
      await hosted((failure) => {
        window.host.failSearchQueries = failure === "search" ? ["NPS-TEST-E-TIER-I"] : [];
        window.host.failGetProfileIds = failure === "profile" ? ["pension-created-007"] : [];
      }, failure);
      const saves = await hosted(() => window.host.saves.length);
      if (failure === "search") {
        // A read whose snapshot can't be worked out at all still shows the holding, with Change.
        await readHoldings();
        await choose("NPS account (PRAN XXXXXXXX9001)", "Demat (INR)");
        await ready(scheme).getByRole("button", { name: /^Change: / }).waitFor();
      } else {
        await revisit();
      }
      await cantWorkOut("Couldn't verify pricing for ").waitFor();
      assert.equal(await saveHoldings.isDisabled(), true);
      assert.equal(await hosted(() => window.host.saves.length), saves);
      assert.equal(await hosted(() => window.host.pricingModes["NPS-TEST-E-TIER-I"]), "MARKET");
    }
    await hosted(() => { window.host.failSearchQueries = []; window.host.failGetProfileIds = []; });
    // Try again reads Wealthfolio again too.
    await footer.getByRole("button", { name: "Try again", exact: true }).click();
    await settled();
    await ready(scheme).waitFor();
    assert.equal(await frame.getByText(priced, { exact: true }).count(), 0);
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    const unheld = await hosted(() => ({ asset: window.host.assets["pension-created-007"], mode: window.host.pricingModes["NPS-TEST-E-TIER-I"] }));
    assert.equal(unheld.mode, "MARKET");
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].dataSource, undefined);
    assert.deepEqual([unheld.asset.name, unheld.asset.displayCode, unheld.asset.notes, unheld.asset.kind, unheld.asset.providerConfig], [
      "My pension", "MY-PENSION", "Keep these notes", "OTHER", { preferred_provider: "CUSTOM", overrides: { CUSTOM: { symbol: "pension" } } },
    ]);
    assert.deepEqual(unheld.asset.metadata.custom, { keep: true });
    assert.equal(unheld.asset.metadata.casStatement.scheme, scheme);
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);

    // An observed MARKET mode remains usable when the extra lookup fails.
    await hosted(() => {
      window.host.assets["pension-created-007"].displayCode = "NPS-TEST-E-TIER-I";
      window.host.failSearchQueries = ["NPS-TEST-E-TIER-I"];
    });
    await readHoldings();
    await ready(scheme).waitFor();
    assert.equal(await frame.getByText(priced, { exact: true }).count(), 0);
    assert.equal(await footer.getByText(/^Couldn't work out/).count(), 0);
    await hosted(() => { window.host.failSearchQueries = []; });

    // A manual asset held only elsewhere still needs its ID to keep the quote's notes.
    const beforeLookupFailures = await hosted(() => window.host.snapshots);
    await hosted(() => {
      window.host.snapshots = { "holdings-2": { "2025-03-31": {
        holdings: [{ assetId: "pension-created-007", symbol: "NPS-TEST-E-TIER-I", quantity: "40", currency: "INR" }], cash: {},
      } } };
      window.host.pricingModes["NPS-TEST-E-TIER-I"] = "MANUAL";
      window.host.quotes["pension-created-007"][0].notes = "Keep the other account's quote notes";
    });
    for (const failure of ["search", "profile", "no match"]) {
      await hosted((failure) => {
        window.host.failSearchQueries = failure === "search" ? ["NPS-TEST-E-TIER-I"] : [];
        window.host.failGetProfileIds = failure === "profile" ? ["pension-created-007"] : [];
        window.host.emptySearchQueries = failure === "no match" ? ["NPS-TEST-E-TIER-I"] : [];
      }, failure);
      const saves = await hosted(() => window.host.saves.length);
      await revisit();
      // The other account's holding can't be matched without its profile, so that stops it first.
      await cantWorkOut(failure === "profile" ? "Couldn't read the Wealthfolio profile of My pension: .+ Try again\\." : "Couldn't verify pricing for ").waitFor();
      assert.equal(await saveHoldings.isDisabled(), true);
      assert.equal(await hosted(() => window.host.saves.length), saves);
      assert.equal(await hosted(() => window.host.quotes["pension-created-007"][0].notes), "Keep the other account's quote notes");
    }
    await hosted((snapshots) => {
      window.host.snapshots = snapshots;
      window.host.pricingModes["NPS-TEST-E-TIER-I"] = "MARKET";
      window.host.failSearchQueries = [];
      window.host.failGetProfileIds = [];
      window.host.emptySearchQueries = [];
    }, beforeLookupFailures);

    // A selected existing asset has an opaque ID and display code; adding details must also preserve GBp.
    const marketScheme = "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME M - TIER I";
    await hosted((scheme) => {
      window.host.onlyNps = [{ scheme, units: "10" }];
      window.host.assets["market-profile-011"] = {
        symbol: "NPS-TEST-M-TIER-I", exchangeMic: "XLON", instrumentType: "EQUITY", name: "Provider pension",
        displayCode: "MY-LONDON-PENSION", notes: "Provider notes", kind: "OTHER", quoteCcy: "GBp",
        providerConfig: { preferred_provider: "YAHOO", overrides: { YAHOO: { symbol: "PENSION.L" } } },
        metadata: { custom: { keep: 42 }, casStatement: { earlier: "kept" } },
      };
      window.host.pricingModes["NPS-TEST-M-TIER-I"] = "MANUAL";
    }, marketScheme);
    await readHoldings();
    const marketCard = question(marketScheme);
    const marketBox = marketCard.getByRole("textbox", { name: /^Search by name for / });
    await marketBox.fill("NPS-TEST-M-TIER-I");
    await marketBox.press("Enter");
    await marketCard.getByRole("button", { name: /^Use this NPS scheme: Provider pension, for / }).click();
    await marketCard.waitFor({ state: "detached" });
    // A fresh search choice's manual mode can go stale before saving, too.
    await hosted(() => {
      window.host.pricingModes["NPS-TEST-M-TIER-I"] = "MARKET";
      window.host.failGetProfileIds = ["market-profile-011"];
    });
    await revisit();
    await cantWorkOut("Couldn't verify pricing for ").waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await hosted(() => { window.host.failGetProfileIds = []; });
    await revisit();
    await settled();
    await sameDay("Demat").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    const marketProfile = await hosted(() => window.host.assets["market-profile-011"]);
    assert.deepEqual(marketProfile, {
      symbol: "NPS-TEST-M-TIER-I", exchangeMic: "XLON", instrumentType: "EQUITY", name: "Provider pension",
      displayCode: "MY-LONDON-PENSION", notes: "Provider notes", kind: "OTHER", quoteCcy: "GBp",
      providerConfig: { preferred_provider: "YAHOO", overrides: { YAHOO: { symbol: "PENSION.L" } } },
      metadata: { custom: { keep: 42 }, casStatement: { earlier: "kept", scheme: marketScheme, fundManager: "TEST PENSION FUND LIMITED", tier: "I", assetClass: "E" } },
    });
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);

    // A missing ordinary remembered ID is dropped, then its fields find the existing asset.
    await hosted(() => {
      window.host.snapshots = {};
      window.host.assets["market-profile-011"].displayCode = "NPS-TEST-M-TIER-I";
      for (const [key, value] of window.host.storage) {
        if (!key.startsWith("nps:")) continue;
        const choice = JSON.parse(value);
        if (choice?.assetId !== "market-profile-011") continue;
        window.host.storage.set(key, JSON.stringify({ ...choice, assetId: "deleted-profile-012" }));
      }
      window.host.failGetProfileIds = ["deleted-profile-012"];
    });
    await readHoldings();
    await ready("Provider pension").waitFor();
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].assetId, undefined);
    assert.equal(await hosted(() => window.host.assets["deleted-profile-012"]), undefined);
    assert.equal(await hosted(() => window.host.pricingModes["NPS-TEST-M-TIER-I"]), "MARKET");
    assert.equal(await hosted(() => window.host.quotes["market-profile-011"]), undefined);
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);
    await hosted(() => { window.host.failGetProfileIds = []; });

    // ECNQUOTE, like MUTUALFUND above, is an older provider label for a canonical EQUITY asset.
    const relabel = (type, keepId = true) => hosted(([type, keepId]) => {
      for (const [key, value] of window.host.storage) {
        if (!key.startsWith("nps:")) continue;
        const choice = JSON.parse(value);
        if (choice?.symbol !== "NPS-TEST-M-TIER-I") continue;
        window.host.storage.set(key, JSON.stringify({ ...choice, ...(keepId ? {} : { assetId: undefined }), instrumentType: type }));
      }
    }, [type, keepId]);
    await relabel("ECNQUOTE", false);
    await hosted(() => { window.host.pricingModes["NPS-TEST-M-TIER-I"] = "MANUAL"; });
    await readHoldings();
    await ready("Provider pension").getByText(priced, { exact: true }).waitFor();
    await sameDay("Demat").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].assetId, "market-profile-011");
    // A type label the add-on doesn't know still finds the one asset with that symbol and exchange.
    await relabel("SOMETHING_NEW");
    await readHoldings();
    await ready("Provider pension").getByText(priced, { exact: true }).waitFor();
    assert.equal(await footer.getByText(/Couldn't verify pricing/).count(), 0);
    // Legacy untyped assets are returned as OTHER; their exact remembered match still wins.
    await hosted(() => { delete window.host.assets["market-profile-011"].instrumentType; });
    await relabel("OTHER");
    await readHoldings();
    await ready("Provider pension").getByText(priced, { exact: true }).waitFor();
    assert.equal(await footer.getByText(/Couldn't verify pricing/).count(), 0);
    await hosted(() => { window.host.assets["market-profile-011"].instrumentType = "EQUITY"; });

    // A failed first account can already have written prices. Repair known ones; a new asset the failed
    // save left in no snapshot isn't reported again. Continue the next account and every quote/detail
    // write after an individual failure.
    await hosted(() => {
      window.host.statementDate = "31-May-2025";
      window.host.onlyNps = [
        { scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I", units: "5" },
        { scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME C - TIER I", units: "6" },
      ];
      window.host.depositoryAccounts = [{
        name: "FAILURE TEST BROKER", type: "NSDL Demat Account", dp_id: "IN900001", client_id: "90000003", folios: 0, balance: "75", owners: [], equities: [], mutual_funds: [],
        bonds: [{ isin: "INEZ91C07034", name: "FAILURE TEST BOND", num_bonds: "5", value: "75", face_value: "10", coupon_rate: null, coupon_frequency: null, maturity_date: null, market_price: "15" }],
      }];
      window.host.pricingModes["NPS-TEST-E-TIER-I"] = "MANUAL";
      window.host.snapshots = { "holdings-1": { "2025-04-30": {
        holdings: [{ assetId: "pension-created-007", symbol: "NPS-TEST-E-TIER-I", quantity: "50", averageCost: "10", currency: "INR" }], cash: {},
      } } };
      Object.assign(window.host.assetIds, { INEZ91C07034: "failed-bond-008", "NPS-TEST-G-TIER-I": "pension-g-009", "NPS-TEST-C-TIER-I": "pension-c-010" });
      window.host.failSnapshotAccounts = ["holdings-1"];
      window.host.failQuoteIds = ["pension-g-009"];
      window.host.failProfileIds = ["pension-g-009"];
    });
    await readHoldings();
    await answerAll(() => "statement");
    await choose("investor", "Fund folios (INR)");
    await choose("FAILURE TEST BROKER demat account", "Demat (INR)");
    // An earlier source override still points at Demat; the new statement's NPS goes to the second account.
    await choose("NPS account (PRAN XXXXXXXX9001)", "Fund folios (INR)");
    await setCost(ready("NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I"), "100");
    // A profile can fail after it's worked out; the readable scheme still gets its price and details.
    await hosted(() => { window.host.failGetProfileIds = ["pension-g-009"]; });
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    await frame.getByText("Some import history could not be saved", { exact: true }).waitFor();
    await frame.getByText("Wealthfolio didn't save these snapshots", { exact: true }).waitFor();
    await frame.getByText("Demat: Error: Snapshot storage unavailable after writing quotes", { exact: true }).waitFor();
    await frame.getByText(/Fund folios, NPS TRUST- A\/C TEST PENSION FUND LIMITED SCHEME G - TIER I: Wealthfolio may value it at its average cost/).waitFor();
    await frame.getByText(/Fund folios, NPS TRUST- A\/C TEST PENSION FUND LIMITED SCHEME G - TIER I: the statement's details/).waitFor();
    assert.equal(await frame.getByText(/FAILURE TEST BOND: Wealthfolio may value it/).count(), 0);
    const partial = await hosted(() => ({ quotes: window.host.quotes, assets: window.host.assets, snapshots: window.host.snapshots }));
    assert.equal(partial.snapshots["holdings-1"]["2025-05-31"], undefined);
    assert.equal(partial.snapshots["holdings-2"]["2025-05-31"].holdings.length, 2);
    assert.equal(partial.quotes["pension-created-007"].find((q) => q.timestamp.startsWith("2025-05-31")).close, 25.5);
    assert.equal(partial.quotes["pension-g-009"].find((q) => q.timestamp.startsWith("2025-05-31")).close, 20);
    assert.equal(partial.quotes["pension-c-010"].find((q) => q.timestamp.startsWith("2025-05-31")).close, 25.5);
    assert.equal(partial.assets["pension-g-009"].metadata, undefined);
    assert.equal(partial.assets["pension-c-010"].metadata.casStatement.assetClass, "E");

    // Re-importing retries each incomplete write and reuses the already-created assets.
    await hosted(() => { window.host.failSnapshotAccounts = []; window.host.failQuoteIds = []; window.host.failProfileIds = []; window.host.failGetProfileIds = []; });
    await readHoldings();
    await sameDay("Fund folios", "31 May 2025").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);
    assert.equal(await hosted(() => window.host.quotes["failed-bond-008"].find((q) => q.timestamp.startsWith("2025-05-31")).close), 15);
    assert.equal(await hosted(() => window.host.quotes["pension-g-009"].find((q) => q.timestamp.startsWith("2025-05-31")).close), 25.5);
    assert.equal(await hosted(() => window.host.assets["pension-g-009"].metadata.casStatement.assetClass), "E");
    await hosted(() => {
      window.host.soldIsins = [];
      window.host.parseWarnings = [];
      window.host.onlyNps = undefined;
      window.host.depositoryAccounts = undefined;
      window.host.statementDate = "";
    });
    await readHoldings("tests/fixtures/made-up-summary-cams.pdf");
    await frame.getByText("CAMS summary statement · ANANYA R TESTWALA · made-up-summary-cams.pdf", { exact: true }).waitFor();
    // A folio with funds from two issuers, as the parser returns two AMCs' folios with one number, still reads.
    await hosted(() => { window.host.ambiguousSummary = true; });
    await readHoldings();
    await frame.getByText("6 holdings", { exact: true }).waitFor();
    assert.equal(await saveHoldings.count(), 1);
    await hosted(() => { window.host.ambiguousSummary = false; });

    // Funds and shares that no search result fits can use the statement's prices too: a summary
    // fund whose search finds only another fund, one with no ISIN whose search finds nothing, and a
    // depository fund and share. The first save can't write one price and one asset's details.
    const corporate = "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout";
    const gilt = "Testbridge Gilt Fund - Direct Plan - Growth";
    // A row priced from statements goes by the statement's name, without its plan and option.
    const corporateRow = () => ready("Testbridge Corporate Bond Fund");
    const giltRow = () => ready("Testbridge Gilt Fund");
    // The Corporate Bond fund, as a detailed import confirmed it, which holdings imports share.
    const corporateFund = {
      symbol: "0P0000TBCB", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", providerId: "FAKE", providerSymbol: "0P0000TBCB.BO",
      name: "Fund 0P0000TBCB",
    };
    await hosted((corporateFund) => {
      window.host.snapshots = {};
      window.host.held = {};
      window.host.summaryWithoutIsin = ["INFZ91T01GL6"];
      window.host.emptySearchQueries = ["Testbridge Gilt"];
      window.host.storage.set("isin:INFZ91T01CB6", JSON.stringify(corporateFund));
      Object.assign(window.host.assetIds, { INFZ91T01CB6: "fund-priced-014", "MF-KFINTECH-TGLDG": "fund-priced-015" });
      window.host.failQuoteIds = ["fund-priced-015"];
      window.host.failProfileIds = ["fund-priced-014"];
    }, corporateFund);
    await readHoldings();
    await showAllRows();
    await choose("investor", "Fund folios (INR)");
    await showAllRows();
    await ready("Fund 0P0000TBCB").getByText(/^Prices from FAKE · chosen before/).waitFor();
    await ready("Fund 0P0000TBCB").getByText(`On your statement: ${corporate}`, { exact: true }).waitFor();
    // Its ISIN finds nothing, so its name's results are listed; none fits, so it's priced from the statement.
    await ready("Fund 0P0000TBCB").getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().getByRole("button", { name: /^Use this fund: Fund 0P0000TBCB, for / }).waitFor();
    await changePanelOf().getByRole("button", { name: /^None of these: use the price on the statement for / }).click();
    await corporateRow().getByText(/^Prices from the statement · chosen by you/).waitFor();
    const giltCard = question(gilt);
    await giltCard.getByText("The statement prints no ISIN for it, so Yahoo Finance searched its name. AMFI can't search by name.", { exact: true }).waitFor();
    await giltCard.getByText("Nothing found for its name. Search by its fund code below, or use the price on the statement.", { exact: true }).waitFor();
    await answer(gilt, "statement");
    await answerAll();
    await settled();
    await corporateRow().getByText(priced, { exact: true }).waitFor();
    await giltRow().getByText(priced, { exact: true }).waitFor();
    // The Gilt fund prints no cost: one below its price, so the price saved afterwards must win.
    await setCost(giltRow(), "40000");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    await frame.getByText("Some prices or details weren't saved", { exact: true }).waitFor();
    await frame.getByText(`Fund folios, ${gilt}: Wealthfolio may value it at its average cost on 2025-03-31. Enter its price for 2025-03-31 on its asset page.`, { exact: true }).waitFor();
    await frame.getByText(`Fund folios, ${corporate}: the statement's details (its name and identifiers, a bond's coupon, maturity and face value, or an NPS scheme's fund manager and tier) aren't on its asset. Importing the statement again retries.`, { exact: true }).waitFor();
    const statementFunds = () => hosted(() => ({
      holdings: window.host.snapshots["holdings-2"]["2025-03-31"].holdings, assets: window.host.assets, quotes: window.host.quotes,
      modes: window.host.pricingModes, storage: Object.fromEntries(window.host.storage),
    }));
    const firstFunds = await statementFunds();
    const fundRow = (symbol) => firstFunds.holdings.find((h) => h.symbol === symbol);
    assert.deepEqual(["INFZ91T01CB6", "MF-KFINTECH-TGLDG"].map((symbol) => {
      const h = fundRow(symbol);
      return [h.assetId ?? null, h.name, h.quantity, h.exchangeMic ?? null, h.quoteCcy, h.instrumentType, h.dataSource];
    }), [
      [null, corporate, "9511.474", null, "INR", "MUTUALFUND", "MANUAL"],
      [null, gilt, "845.512", null, "INR", "MUTUALFUND", "MANUAL"],
    ]);
    assert.equal((9511.474 * Number(fundRow("INFZ91T01CB6").averageCost)).toFixed(2), "99995.00");
    assert.equal((845.512 * Number(fundRow("MF-KFINTECH-TGLDG").averageCost)).toFixed(2), "40000.00");
    for (const [id, symbol, name] of [["fund-priced-014", "INFZ91T01CB6", corporate], ["fund-priced-015", "MF-KFINTECH-TGLDG", gilt]]) {
      const a = firstFunds.assets[id];
      assert.deepEqual([a.symbol, a.name, a.instrumentType, a.quoteCcy, firstFunds.modes[symbol]], [symbol, name, "EQUITY", "INR", "MANUAL"]);
    }
    const fundCloses = (funds, id) => (funds.quotes[id] ?? []).map((q) => [q.id, q.timestamp.slice(0, 10), q.close, q.dataSource]);
    // The printed price replaces the average cost the save wrote; the Gilt fund's failed write leaves its average cost.
    assert.deepEqual(fundCloses(firstFunds, "fund-priced-014"), [["fund-priced-014_2025-03-31_MANUAL", "2025-03-31", 10.7432, "MANUAL"]]);
    assert.deepEqual(fundCloses(firstFunds, "fund-priced-015").map(([, day, close]) => [day, close.toFixed(4)]), [["2025-03-31", (40000 / 845.512).toFixed(4)]]);
    // The printed name and identifiers go on the asset; funds found by search get none.
    assert.equal(firstFunds.assets["fund-priced-014"].metadata, undefined);
    assert.deepEqual(firstFunds.assets["fund-priced-015"].metadata, { casStatement: { name: gilt, registrar: "KFINTECH", schemeCode: "TGLDG" } });
    assert.equal(firstFunds.holdings.length, 6);
    for (const h of firstFunds.holdings.filter((h) => h.dataSource !== "MANUAL")) {
      const a = firstFunds.assets[h.assetId] ?? Object.values(firstFunds.assets).find((a) => a.symbol === h.symbol && a.exchangeMic === (h.exchangeMic ?? null));
      assert.equal(a.metadata?.casStatement, undefined, h.symbol);
    }
    // Remembered for the next holdings import: by ISIN, or by registrar and scheme code. The fund
    // the detailed import confirmed stays beside it for detailed imports.
    const corporatePriced = {
      symbol: "INFZ91T01CB6", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: corporate, statementPrices: true, transactions: corporateFund,
    };
    assert.deepEqual(JSON.parse(firstFunds.storage["isin:INFZ91T01CB6"]), corporatePriced);
    assert.ok(Object.entries(firstFunds.storage).some(([key, value]) =>
      /^fund:[0-9a-f]{64}$/.test(key) && JSON.parse(value).symbol === "MF-KFINTECH-TGLDG" && JSON.parse(value).statementPrices));

    // The next import finds both choices and assets again, and finishes the incomplete writes.
    await hosted(() => { window.host.failQuoteIds = []; window.host.failProfileIds = []; });
    const saveFolios = async (saved = "Saved 1 snapshot") => {
      await sameDay("Fund folios").dispatchEvent("click");
      await saveHoldings.click();
      await frame.getByText(saved, { exact: true }).waitFor();
    };
    await readHoldings();
    await showAllRows();
    await corporateRow().getByText(/^Prices from the statement · chosen before/).waitFor();
    await giltRow().getByText(/^Prices from the statement · chosen before/).waitFor();
    await giltRow().getByText(/^Purchase cost ₹40,000, from your earlier holdings · Edit$/).waitFor();
    await saveFolios();
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);
    const againFunds = await statementFunds();
    assert.deepEqual(["INFZ91T01CB6", "MF-KFINTECH-TGLDG"].map((symbol) => againFunds.holdings.find((h) => h.symbol === symbol).assetId), ["fund-priced-014", "fund-priced-015"]);
    assert.equal(Object.values(againFunds.assets).filter((a) => ["INFZ91T01CB6", "MF-KFINTECH-TGLDG"].includes(a.symbol)).length, 2);
    assert.deepEqual(fundCloses(againFunds, "fund-priced-014"), fundCloses(firstFunds, "fund-priced-014"));
    assert.deepEqual(fundCloses(againFunds, "fund-priced-015"), [["fund-priced-015_2025-03-31_MANUAL", "2025-03-31", 54.0912, "MANUAL"]]);
    assert.deepEqual(againFunds.assets["fund-priced-014"].metadata, {
      casStatement: { name: corporate, isin: "INFZ91T01CB6", registrar: "KFINTECH", schemeCode: "TCBRP" },
    });
    assert.deepEqual(["INFZ91T01CB6", "MF-KFINTECH-TGLDG"].map((symbol) => againFunds.modes[symbol]), ["MANUAL", "MANUAL"]);
    // The holding's search now finds that asset by its ISIN, and picking it is using the statement's
    // prices: the fund the detailed import confirmed stays beside it, as the detailed statement below
    // shows. Another search result still replaces both choices.
    const corporateStored = async () => JSON.parse((await storage())["isin:INFZ91T01CB6"]);
    await readHoldings();
    await showAllRows();
    await corporateRow().getByRole("button", { name: /^Change: / }).click();
    // The result is shown as that choice: the statement's name, and the statement's prices. As the only
    // result, it has its own button.
    const ownResult = changePanelOf().getByRole("button", { name: `Use this fund: ${corporate}, for ${corporate}`, exact: true });
    await ownResult.waitFor();
    assert.equal(await changePanelOf().getByRole("radio").count(), 0);
    await changePanelOf().getByText(/^the statement's prices · INFZ91T01CB6$/).waitFor();
    await ownResult.click();
    await corporateRow().getByText(/^Prices from the statement · chosen by you/).waitFor();
    await saveFolios();
    assert.deepEqual(await corporateStored(), corporatePriced);
    // The same symbol with another type or currency is still that search result, with its ID and warning.
    for (const [type, currency] of [["BOND", "INR"], ["EQUITY", "USD"]]) {
      await hosted(([type, currency]) => {
        Object.assign(window.host.assets["fund-priced-014"], { instrumentType: type, quoteCcy: currency });
      }, [type, currency]);
      await readHoldings();
      await showAllRows();
      await corporateRow().getByRole("button", { name: /^Change: / }).click();
      const result = changePanelOf().getByRole("button", { name: /^Use this fund: / });
      await result.waitFor();
      await changePanelOf().getByText(/^Priced by hand · /).waitFor();
      if (currency === "USD") {
        await changePanelOf().getByText("USD", { exact: true }).waitFor();
        await changePanelOf().getByText(inUsd, { exact: true }).waitFor();
      }
      await result.click();
      const row = ready(/^Fund INFZ91T01CB6|^Testbridge Corporate Bond Fund/);
      await row.getByText(/^Prices entered by hand · chosen by you/).waitFor();
      if (currency === "USD") {
        await row.getByText("USD", { exact: true }).waitFor();
        await row.getByText(inUsd, { exact: true }).waitFor();
      }
      await saveFolios();
      const stored = await corporateStored();
      assert.deepEqual([stored.assetId, stored.instrumentType, stored.quoteCcy, stored.statementPrices, stored.transactions], ["fund-priced-014", type, currency, undefined, undefined]);
    }
    await hosted(() => {
      Object.assign(window.host.assets["fund-priced-014"], { instrumentType: "EQUITY", quoteCcy: "INR" });
    });
    await readHoldings();
    await showAllRows();
    await changeTo(corporateRow(), "0P0000TBCB", /^Fund 0P0000TBCB /);
    await saveFolios();
    assert.deepEqual(await corporateStored(), corporateFund);
    await readHoldings();
    // Confirmed to another asset than the one the earlier import added, it's left out until that
    // asset is replaced with it, and its Change is under Before saving.
    await decision("Fund 0P0000TBCB").getByRole("button", { name: "Change: Fund 0P0000TBCB in Fund folios", exact: true }).click();
    await changePanelOf().getByRole("button", { name: /^(None of these: use|Use) the price on the statement for / }).click();
    await saveFolios();
    assert.deepEqual(await corporateStored(), corporatePriced);

    // A depository statement's share and fund: the share's ISIN finds only another fund, the fund's nothing.
    const textiles = "IMAGINARY TEXTILES LIMITED";
    // The fund is printed with a plan but no option.
    const smallCap = "PRETEND SMALL CAP FUND - DIRECT PLAN";
    await hosted(([textiles, smallCap]) => {
      window.host.statementDate = "30-Apr-2025";
      window.host.emptySearchQueries = ["INFZ92P01SC5", "PRETEND SMALL CAP"];
      Object.assign(window.host.assetIds, { INEZ94A01017: "share-priced-016", INFZ92P01SC5: "fund-priced-017" });
      window.host.depositoryAccounts = [{
        name: "PRETEND BROKING LIMITED", type: "CDSL Demat Account", dp_id: "12099900", client_id: "00000004", folios: 0, balance: "8045", owners: [],
        equities: [{ isin: "INEZ94A01017", name: textiles, num_shares: "40", price: "125.50", value: "5020.00", symbol: null, exchange: null }],
        mutual_funds: [{
          isin: "INFZ92P01SC5", name: smallCap.replace("DIRECT PLAN", "GROWTH"), amfi: null, type: null, balance: "100", nav: "30.25", value: "3025.00", avg_cost: "28", total_cost: null,
          ucc: null, folio: null, pnl: null, return: null,
        }],
        bonds: [],
      }];
    }, [textiles, smallCap]);
    await readHoldings("tests/fixtures/made-up-nsdl.pdf");
    await frame.getByText("Holdings on 30 Apr 2025", { exact: true }).waitFor();
    await frame.getByText("2 holdings", { exact: true }).waitFor();
    const resultBadgesOf = (card) => card.getByRole("radiogroup").locator("label").evaluateAll((labels) =>
      labels.map((label) => [...label.querySelectorAll("[data-slot=badge]")].map((b) => `${b.textContent} ${b.dataset.variant}`)));
    const searchIn = async (card, text) => {
      const box = card.getByRole("textbox", { name: /^Search by / });
      await box.fill(text);
      await box.press("Enter");
      await card.getByRole("radio").nth(1).waitFor({ state: "attached" });
    };
    // With an option but no plan on the statement, only the differing option warns.
    const optionOnly = question("PRETEND SMALL CAP FUND - GROWTH");
    await optionOnly.getByText(/^On your statement: PRETEND SMALL CAP FUND - GROWTH · Growth · 100\.000 units$/).waitFor();
    await searchIn(optionOnly, "Pretend Small Cap");
    assert.deepEqual(await resultBadgesOf(optionOnly), [["Direct secondary", "Growth secondary"], ["Regular secondary", "IDCW warning-subtle"]]);
    await optionOnly.getByRole("radio").nth(1).dispatchEvent("click");
    await optionOnly.getByRole("button", { name: /^Use this fund for / }).click();
    // Its name, shortened as the statement's is, is the statement's, so the row gives only one.
    const optionRow = ready("Pretend Small Cap Fund");
    assert.deepEqual(await badges(optionRow.getByRole("rowheader")), ["Regular secondary", "IDCW warning-subtle"]);
    await optionRow.getByText("Statement: Growth. Chosen: Regular · IDCW. Different option.", { exact: true }).waitFor();
    // Back to the plan-only statement for the checks that follow; nothing was remembered.
    await hosted((smallCap) => { window.host.depositoryAccounts[0].mutual_funds[0].name = smallCap; }, smallCap);
    await readHoldings();
    const textilesCard = question(textiles);
    await textilesCard.getByRole("button", { name: /^Use this listing: Fund INEZ94A01017, for / }).waitFor();
    // A share's results have no plan or option badges, even when their names give them.
    await searchIn(textilesCard, "Pretend Small Cap");
    assert.deepEqual(await badges(textilesCard), []);
    await textilesCard.getByRole("radiogroup", { name: "Results for “Pretend Small Cap”" }).getByRole("radio").nth(1).dispatchEvent("click");
    await textilesCard.getByRole("button", { name: /^Use this listing for / }).click();
    await textilesCard.waitFor({ state: "detached" });
    const textilesRow = ready(`On your statement: ${textiles}`);
    assert.deepEqual(await badges(textilesRow.getByRole("rowheader")), []);
    await textilesRow.getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().getByRole("button", { name: /^(None of these: use|Use) the price on the statement for / }).click();
    await ready(textiles).getByText(/^Prices from the statement · chosen by you/).waitFor();
    const smallCapCard = question(smallCap);
    await smallCapCard.getByText("Nothing found for the ISIN printed for it or its name. Search by its fund code below, or use the price on the statement.", { exact: true }).waitFor();
    // With no option on the statement, a result's option is no warning; another plan is.
    await smallCapCard.getByText(/^On your statement: PRETEND SMALL CAP FUND - DIRECT PLAN · Direct plan · 100\.000 units$/).waitFor();
    await searchIn(smallCapCard, "Pretend Small Cap");
    assert.deepEqual(await resultBadgesOf(smallCapCard), [["Direct secondary", "Growth secondary"], ["Regular warning-subtle", "IDCW secondary"]]);
    await smallCapCard.getByRole("radio").nth(1).dispatchEvent("click");
    await smallCapCard.getByRole("button", { name: /^Use this fund for / }).click();
    const smallCapRow = ready("Pretend Small Cap Fund");
    assert.deepEqual(await badges(smallCapRow.getByRole("rowheader")), ["Regular warning-subtle", "IDCW secondary"]);
    await smallCapRow.getByRole("button", { name: /^Change: / }).click();
    await changePanelOf().getByRole("button", { name: /^(None of these: use|Use) the price on the statement for / }).click();
    const smallCapPriced = ready("PRETEND SMALL CAP FUND");
    await smallCapPriced.getByText(/^Prices from the statement · chosen by you/).waitFor();
    assert.deepEqual(await badges(smallCapPriced.getByRole("rowheader")), ["Direct secondary"]);
    await choose("PRETEND BROKING LIMITED demat account", "Demat (INR)");
    await ready(textiles).getByText(priced, { exact: true }).waitFor();
    await smallCapPriced.getByText(priced, { exact: true }).waitFor();
    await setCost(ready(textiles), "4000");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);
    const pretend = await hosted(() => ({
      holdings: window.host.snapshots["holdings-1"]["2025-04-30"].holdings, assets: window.host.assets, quotes: window.host.quotes, modes: window.host.pricingModes,
    }));
    assert.deepEqual(pretend.holdings.map((h) => [h.symbol, h.quantity, Number(h.averageCost), h.exchangeMic ?? null, h.quoteCcy, h.instrumentType, h.dataSource]), [
      ["INEZ94A01017", "40", 100, null, "INR", "EQUITY", "MANUAL"],
      ["INFZ92P01SC5", "100", 28, null, "INR", "MUTUALFUND", "MANUAL"],
    ]);
    assert.deepEqual(fundCloses(pretend, "share-priced-016").map((q) => q.slice(1)), [["2025-04-30", 125.5, "MANUAL"]]);
    assert.deepEqual(fundCloses(pretend, "fund-priced-017").map((q) => q.slice(1)), [["2025-04-30", 30.25, "MANUAL"]]);
    assert.deepEqual(pretend.assets["share-priced-016"].metadata, { casStatement: { name: textiles, isin: "INEZ94A01017" } });
    assert.deepEqual(pretend.assets["fund-priced-017"].metadata, { casStatement: { name: smallCap, isin: "INFZ92P01SC5" } });
    assert.deepEqual([["INEZ94A01017", "share-priced-016"], ["INFZ92P01SC5", "fund-priced-017"]].map(([symbol, id]) =>
      [pretend.modes[symbol], pretend.assets[id].instrumentType, pretend.assets[id].quoteCcy]), [["MANUAL", "EQUITY", "INR"], ["MANUAL", "EQUITY", "INR"]]);

    // A CDSL statement's CDSL demat fund whose name is cut short partway through its option, in
    // "- DIRECT GROW", gets Direct and Growth beside its name without the fund house, and a result or
    // choice on another plan and option warns.
    await hosted(() => {
      window.host.depositoryAccounts = undefined;
      window.host.statementDate = "";
      window.host.amfi = false;
    });
    await readHoldings("tests/fixtures/made-up-cdsl.pdf");
    await frame.getByText("CDSL statement · ANANYA R TESTWALA · made-up-cdsl.pdf", { exact: true }).waitFor();
    await frame.getByText("16 holdings", { exact: true }).waitFor();
    // Funds printed as a real CDSL statement prints them, after the fund house, "#", its short name
    // and U+0002 or "-", show their scheme names alone, without control characters.
    await question("FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH")
      .getByText(/^On your statement: FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH · Direct plan · Growth · /).waitFor();
    await question("TESTBRIDGE GILT FUND").waitFor();
    const cdslNames = await questions.evaluateAll((cards) => cards.map((card) => card.querySelector("p").textContent));
    assert.ok(cdslNames.some((n) => n.includes("TESTBRIDGE GILT FUND")) && cdslNames.every((n) => !/[\x00-\x1f\x7f#]/.test(n)), cdslNames.join(" | "));
    const cutName = "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW";
    const cutCard = question(cutName);
    await cutCard.getByText(new RegExp(`^On your statement: ${escaped(cutName)} · Direct plan · Growth · `)).waitFor();
    await searchIn(cutCard, "Fictiva Testbridge Global");
    const cutTyped = cutCard.getByRole("radiogroup", { name: "Results for “Fictiva Testbridge Global”" });
    assert.deepEqual((await resultBadgesOf(cutCard)).slice(-2), [["Direct secondary", "Growth secondary"], ["Regular warning-subtle", "IDCW warning-subtle"]]);
    await cutTyped.getByRole("radio").nth(1).dispatchEvent("click");
    await cutCard.getByRole("button", { name: /^Use this fund for / }).click();
    const cutRow = ready(`On your statement: ${cutName}`);
    assert.deepEqual(await badges(cutRow.getByRole("rowheader")), ["Regular warning-subtle", "IDCW warning-subtle"]);
    await cutRow.getByText("Statement: Direct · Growth. Chosen: Regular · IDCW. Different plan and option.", { exact: true }).waitFor();

    // A detailed statement keeps the fund confirmed for it instead of using the asset priced from statements.
    // This copy has no password, so it reads with the box empty, and Remember the password keeps the saved one.
    await leaveReview();
    assert.equal(await remember.getAttribute("aria-checked"), "true");
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);
    const beforeDetailedCopy = await hosted(() => ({ activities: window.host.activities, rejectLine: window.host.rejectLine, storage: [...window.host.storage] }));
    await hosted(() => {
      window.host.activities = [];
      window.host.rejectLine = undefined;
    });
    const readNoPassword = async () => {
      await leaveDetailed();
      await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas-no-password.pdf");
      await frame.locator("#cas-password").fill("");
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await transactionsHeading.waitFor({ timeout: 180_000 });
      await dSettled();
    };
    await readNoPassword();
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);
    const detailedCorporate = readyFund("Fund 0P0000TBCB");
    await detailedCorporate.getByText(/^Prices from FAKE · chosen before · Change$/).waitFor();
    assert.equal(await frame.getByRole("button", { name: /the price on the statement/ }).count(), 0);
    // Its search doesn't offer the asset priced from statements, whether by ISIN or by name.
    await detailedCorporate.getByRole("button", { name: "Change: Fund 0P0000TBCB", exact: true }).click();
    const detailedChange = frame.locator("[data-focus-first]");
    await detailedChange.getByText("Nothing found for the ISIN printed for it or its name. Search by its fund code below.", { exact: true }).waitFor();
    assert.equal(await detailedChange.getByRole("radio").count(), 0);
    const corporateCode = detailedChange.getByRole("textbox", { name: `Search by fund code for ${corporate}`, exact: true });
    await corporateCode.fill("INFZ91T01CB6");
    await corporateCode.press("Enter");
    await detailedChange.getByText("Nothing found for “INFZ91T01CB6”. Check the code.", { exact: true }).waitFor();
    // Skipping the fund, or confirming one, changes only the fund kept for detailed imports, once imported.
    await detailedChange.getByRole("button", { name: `Skip this fund: ${corporate}`, exact: true }).click();
    await detailedCorporate.waitFor({ state: "detached" });
    await answerFunds();
    await importButton.click();
    await imported().waitFor();
    assert.deepEqual(await corporateStored(), { symbol: "INFZ91T01CB6", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: corporate, statementPrices: true });
    await hosted(() => { window.host.activities = []; });
    await readNoPassword();
    const corporateQuestion = fundQuestion(corporate);
    await corporateQuestion.getByRole("textbox", { name: `Search by fund code for ${corporate}`, exact: true }).fill("0P0000TBCB");
    await corporateQuestion.getByRole("button", { name: `Search for ${corporate}`, exact: true }).click();
    await corporateQuestion.getByRole("button", { name: `Use this fund: Fund 0P0000TBCB, for ${corporate}`, exact: true }).click();
    await dSettled();
    await importButton.click();
    await imported().waitFor();
    const reconfirmed = await corporateStored();
    assert.deepEqual([reconfirmed.symbol, reconfirmed.statementPrices, reconfirmed.transactions.symbol, reconfirmed.transactions.exchangeMic], [
      "INFZ91T01CB6", true, "0P0000TBCB", "XBOM",
    ]);
    await leaveDetailed();
    await hosted((state) => Object.assign(window.host, { ...state, storage: new Map(state.storage) }), beforeDetailedCopy);
    await hosted(() => {
      window.host.summaryWithoutIsin = [];
      window.host.emptySearchQueries = [];
      window.host.depositoryAccounts = undefined;
      window.host.statementDate = "";
    });

    // With no account that tracks holdings, a summary statement's funds that accounts tracking
    // transactions already hold are still compared with them, by themselves, and nothing is saved.
    // Hidden accounts that track transactions are compared too, like Not set here.
    const camsBalanced = "Fictiva Balanced Advantage Fund - Direct Plan - Income Distribution cum Capital Withdrawal Option - Reinvestment";
    const liquidName = "Fictiva Liquid Fund - Direct Plan - Growth";
    const beforeCheck = await accountList();
    await editAccounts({ "holdings-1": { isActive: false }, "holdings-2": { isActive: false }, "unset-1": { isActive: false } });
    await hosted(() => {
      // Activities show an asset's display code; the Balanced Advantage fund's was changed.
      const posted = (accountId, activityType, date, symbol, quantity, displayCode = symbol) => ({
        id: `checked-${date}-${accountId}-${symbol}`, accountId, activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`,
        quantity, unitPrice: "10", amount: null, fee: null, currency: "INR", assetId: `asset-${symbol}`, assetSymbol: displayCode, exchangeMic: "XBOM",
      });
      for (const symbol of ["INFZ90K01FC8", "INFZ90K01BA1"]) {
        window.host.assets[`asset-${symbol}`] = { symbol, exchangeMic: "XBOM", instrumentType: "EQUITY", name: `Fund ${symbol}` };
      }
      window.host.held = { "account-1": ["INFZ90K01FC8", "INFZ90K01BA1"], "unset-1": ["INFZ90K01BA1"] };
      window.host.activities = [
        posted("account-1", "BUY", "2024-04-01", "INFZ90K01FC8", "2892.104"),
        // After the statement's date: not counted. One entered in Wealthfolio's form at 02:00 on
        // 01-Apr-2025 in its timezone, Asia/Kolkata, is stored on 31-Mar-2025 in UTC.
        posted("account-1", "BUY", "2025-04-01", "INFZ90K01FC8", "5"),
        { ...posted("account-1", "BUY", "2025-04-01", "INFZ90K01FC8", "7"), id: "checked-form-entry", date: "2025-03-31T20:30:00+00:00" },
        posted("account-1", "BUY", "2024-04-01", "INFZ90K01BA1", "3000", "MY-BALANCED"),
        posted("unset-1", "BUY", "2024-04-01", "INFZ90K01BA1", "400", "MY-BALANCED"),
      ];
    });
    await readHoldings("tests/fixtures/made-up-summary-cams.pdf");
    // The account chosen last time is hidden, so it's chosen again; a new account isn't preselected.
    assert.match(await investorSelect.textContent(), /Choose an account/);
    await frame.getByText(unavailable("Fund folios, which is hidden in Wealthfolio"), { exact: true }).waitFor();
    await answerAll();
    const accountData = () => hosted(() => JSON.stringify({
      saves: window.host.saves, snapshots: window.host.snapshots, activities: window.host.activities,
      quotes: window.host.quotes, assets: window.host.assets, modes: window.host.pricingModes, links: window.host.links,
    }));
    const beforeComparing = await accountData();
    const trackedIn = (accounts) => frame.locator("div.rounded-lg").filter({ hasText: new RegExp(`^Already tracked in ${escaped(accounts)} \\(`) });
    // The Flexi Cap fund's units match; the Balanced Advantage fund's are summed over both accounts, and differ.
    await trackedIn("Mutual funds").getByText("✓ It matches this statement.", { exact: true }).waitFor();
    const balancedGroup = trackedIn("Mutual funds, Not set");
    await balancedGroup.getByText(/^Fund INFZ90K01BA1 differs: Mutual funds, Not set has 3,400\.000 units, this statement 3,443\.910\. A transaction may be missing from Mutual funds, Not set\./).waitFor();
    // Without an account to save in, Save in both accounts isn't offered.
    await balancedGroup.getByRole("button", { name: "Show it", exact: true }).click();
    await balancedGroup.getByText("Choose an account in “Save to” above first.", { exact: true }).waitFor();
    // Review its transactions opens each account in Wealthfolio.
    await balancedGroup.getByRole("button", { name: "Review its transactions in Mutual funds", exact: true }).click();
    await tab.frames()[1].waitForFunction(() => window.host.navigations.at(-1) === "/accounts/account-1");
    await balancedGroup.getByRole("button", { name: "Review its transactions in Not set", exact: true }).click();
    await tab.frames()[1].waitForFunction(() => window.host.navigations.at(-1) === "/accounts/unset-1");
    // The Liquid fund, which no such account holds, isn't compared.
    assert.equal(await frame.getByText(/^Fund INFZ90K01LQ6 differs/).count(), 0);
    assert.equal(await saveHoldings.isDisabled(), true);
    assert.equal(await accountData(), beforeComparing);
    // A comparison that can't read Wealthfolio's activities says so; opening the page again compares again.
    await hosted(() => { window.host.failHistory = true; });
    await revisit();
    await balancedGroup.getByText("Fund INFZ90K01BA1: couldn't compare. Couldn't read Wealthfolio's activities: Error: History unavailable", { exact: true }).waitFor();
    await hosted(() => { window.host.failHistory = false; });
    // The next read finds Not set archived, so it isn't compared: Wealthfolio shows add-ons none of its activities.
    await editAccounts({ "unset-1": { isArchived: true } });
    await readHoldings();
    await answerAll();
    await frame.getByText(/^Fund INFZ90K01BA1 differs: Mutual funds has 3,000\.000 units, this statement 3,443\.910\./).waitFor();
    assert.equal(await accountData(), beforeComparing);
    await setAccountList(beforeCheck);

    // A summary import creates an AMFI fund without an exchange. Searching its ISIN then finds that
    // asset, even if automatic updates have since been turned off. Every fund's ISIN finds one AMFI
    // scheme, so once AMFI is added, each is confirmed without a click.
    await hosted(() => {
      window.host.providers = "";
      window.host.storage.clear();
      window.host.assets = {};
      window.host.snapshots = {};
      window.host.held = {};
      window.host.activities = [];
      window.host.pricingModes = {};
      window.host.quotes = {};
      window.host.navigations = [];
    });
    // Opening the page again checks AMFI again: Wealthfolio now says it's off.
    await revisit();
    await readHoldings();
    await choose("investor", "Fund folios (INR)");
    // With AMFI off, Questions for you says so above its cards, and offers Market data settings. Once
    // that's opened, I've added AMFI: check looks again; AMFI on, the funds are searched again, find
    // AMFI's schemes and are confirmed without a click.
    await frame.getByText(/^AMFI isn't added, so 6 funds were only searched on Yahoo Finance and need you\. Add AMFI to match them for you\.$/).waitFor();
    assert.equal(await frame.getByText(/found automatically on AMFI/).count(), 0);
    assert.equal(await frame.getByRole("button", { name: "I've added AMFI: check" }).count(), 0);
    await frame.getByRole("button", { name: "Open Market data settings", exact: true }).click();
    assert.deepEqual(await hosted(() => window.host.navigations), ["/settings/market-data"]);
    await hosted(() => { window.host.amfi = true; });
    await frame.getByRole("button", { name: "I've added AMFI: check", exact: true }).press("Enter");
    await said.getByText("AMFI added: 6 funds matched. No questions remain.", { exact: true }).waitFor();
    await focused(footer.locator("[tabindex='-1']").first(), "AMFI added, no questions left");
    await frame.getByText("6 funds found automatically on AMFI. Change any that look wrong.", { exact: true }).waitFor();
    assert.equal(await questions.count(), 0);
    await showAllRows();
    const schemeCodes = await readyRows.evaluateAll((all) => all.map((row) => row.textContent.match(/Scheme (\d{6})/)[1]));
    assert.equal(schemeCodes.length, 6);
    assert.equal(new Set(schemeCodes).size, schemeCodes.length, "different funds have different AMFI scheme codes");
    // Skips every fund but the Liquid fund, from their rows.
    const skipOthersThanLiquid = async () => {
      await showAllRows();
      while (await readyRows.filter({ hasNotText: liquidName }).count()) {
        await readyRows.filter({ hasNotText: liquidName }).first().getByRole("button", { name: /^Change: / }).click();
        await changePanelOf().getByRole("button", { name: /^Skip this holding: / }).click();
        await changePanelOf().waitFor({ state: "detached" });
      }
      await settled();
    };
    await skipOthersThanLiquid();
    await frame.getByText("1 fund found automatically on AMFI. Change any that look wrong.", { exact: true }).waitFor();
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    const summaryAmfi = JSON.parse((await storage())["isin:INFZ90K01LQ6"]);
    const amfiSnapshot = await snapshot("holdings-2", "2025-03-31");
    assert.equal(amfiSnapshot.holdings.length, 1);
    assert.deepEqual(
      [amfiSnapshot.holdings[0].symbol, amfiSnapshot.holdings[0].exchangeMic, amfiSnapshot.holdings[0].providerId,
        amfiSnapshot.holdings[0].providerSymbol, amfiSnapshot.holdings[0].instrumentType, amfiSnapshot.holdings[0].quoteCcy],
      [summaryAmfi.symbol, undefined, "AMFI", summaryAmfi.symbol, "MUTUALFUND", "INR"],
    );
    assert.equal(await hosted((code) => window.host.assets[`asset-${code}`].providerId, summaryAmfi.symbol), "AMFI");
    await hosted((code) => { window.host.pricingModes[code] = "MANUAL"; }, summaryAmfi.symbol);
    await readHoldings();
    const summaryLiquid = () => readyRows.filter({ hasText: liquidName });
    await summaryLiquid().getByRole("button", { name: /^Change: / }).click();
    const summaryResults = changePanelOf().getByRole("radio");
    await summaryResults.nth(1).waitFor({ state: "attached" });
    assert.equal(await summaryResults.count(), 2);
    // Nothing is picked for you.
    assert.deepEqual(await summaryResults.evaluateAll((all) => all.map((r) => r.getAttribute("aria-checked"))), ["false", "false"]);
    // Wealthfolio has the fund with AMFI preferred, but priced by hand.
    const handPriced = changePanelOf().locator("label").filter({ hasText: "Priced by hand" });
    assert.equal(await handPriced.count(), 1);
    await handPriced.getByRole("radio").dispatchEvent("click");
    await changePanelOf().getByRole("button", { name: /^Use this fund for / }).click();
    await skipOthersThanLiquid();
    await sameDay("Fund folios").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    const summaryExisting = JSON.parse((await storage())["isin:INFZ90K01LQ6"]);
    assert.equal(summaryExisting.assetId, `asset-${summaryAmfi.symbol}`);
    assert.equal(summaryExisting.providerSymbol, undefined);
    await readHoldings();
    // Remembered, it's read again: a remembered choice doesn't keep the pricing mode.
    await summaryLiquid().getByText(/^Prices entered by hand · chosen before/).waitFor();
    await skipOthersThanLiquid();
    await summaryLiquid().getByText(priced, { exact: true }).waitFor();
    // Below Tailwind's `sm` width, 320 px here, the ready rows are a stacked list, and nothing is wider
    // than the frame.
    await frameWidth(320);
    const stacked = frame.getByRole("list", { name: "Holdings ready to save", exact: true });
    await stacked.waitFor();
    await stacked.getByText(/^Units: .+ · Value on 31 Mar: ₹/).waitFor();
    assert.equal(await readyRows.count(), 0);
    assert.ok(await hosted(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "nothing past 320 px");
    await frameWidth(1000);
    await summaryLiquid().waitFor();

    // A line whose units can't be read leaves the account's fund as it is, and isn't saved.
    await hosted(() => { window.host.summaryMisread = ["INFZ90K01LQ6"]; });
    await readHoldings();
    const liquidFolio = "Fictiva Mutual Fund account (folio 91234567 / 12)";
    await frame.getByText(
      `${liquidName}, ${liquidFolio}: It has no units but a value of ₹35799.22, so the line may have been misread. Check it against the PDF. The import leaves this holding as it is.`,
      { exact: true },
    ).waitFor();
    await skipOthersThanLiquid();
    assert.equal(await summaryLiquid().count(), 0);
    // The account's AMFI asset stays, under its own name.
    const heldBack = (await snapshotTable("Fund folios")).getByRole("row").filter({ hasText: liquidFolio });
    assert.equal(await heldBack.count(), 1);
    await heldBack.getByText("Kept", { exact: true }).waitFor();
    const preservedSnapshot = { holdings: [{
      assetId: `asset-${summaryAmfi.symbol}`, symbol: summaryAmfi.symbol, quantity: "100", currency: "INR", averageCost: "10",
    }], cash: { INR: "25" } };
    await hosted((snapshot) => { window.host.snapshots["holdings-2"]["2025-03-31"] = snapshot; }, preservedSnapshot);
    const liquidQuotes = [{
      id: `asset-${summaryAmfi.symbol}_2025-03-31_MANUAL`, assetId: `asset-${summaryAmfi.symbol}`,
      timestamp: "2025-03-31T12:00:00.000Z", createdAt: "2025-03-31T13:00:00.000Z", dataSource: "MANUAL",
      open: 6, high: 8, low: 5, close: 7, adjclose: 7, volume: 123, currency: "INR", notes: "Kept quote",
    }];
    await hosted(([code, quotes]) => { window.host.quotes[`asset-${code}`] = quotes; }, [summaryAmfi.symbol, liquidQuotes]);
    await revisit();
    await settled();
    await sameDay("Fund folios").dispatchEvent("click");
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    const keptSnapshot = await snapshot("holdings-2", "2025-03-31");
    assert.deepEqual(keptSnapshot.holdings, preservedSnapshot.holdings);
    assert.deepEqual(keptSnapshot.cash, preservedSnapshot.cash);
    assert.deepEqual(await hosted((code) => window.host.quotes[`asset-${code}`], summaryAmfi.symbol), liquidQuotes);
    await hosted(() => { window.host.summaryMisread = []; });

    // A new profile: Save to proposes an account when none fits, created only when the import is
    // saved, and remembered once it exists (#214). AMFI confirms every fund here.
    const beforeNewAccounts = await hosted(() => ({
      accounts: window.host.accounts, storage: [...window.host.storage], snapshots: window.host.snapshots, activities: window.host.activities,
      assets: window.host.assets, quotes: window.host.quotes, modes: window.host.pricingModes, saves: window.host.saves,
      rejectLine: window.host.rejectLine, skipLine: window.host.skipLine,
    }));
    const freshProfile = (accounts = []) => hosted((accounts) => {
      Object.assign(window.host, {
        accounts, snapshots: {}, activities: [], assets: {}, quotes: {}, pricingModes: {}, creates: [], failCreate: [], rejectLine: undefined, skipLine: undefined,
      });
      window.host.storage.clear();
    }, accounts);
    const creates = () => hosted(() => window.host.creates.map((c) => c.name));
    const rememberedIds = async () => Object.values(await storage()).filter((value) => /^created-/.test(value));
    const newLine = frame.getByText(/^New · Wealthfolio account, created when you save ·/);
    await freshProfile();
    // A depository statement's account is named after the depository.
    for (const [file, name] of [["tests/fixtures/made-up-cdsl.pdf", "CDSL Demat"], ["tests/fixtures/made-up-nsdl.pdf", "NSDL Demat"]]) {
      await readHoldings(file);
      assert.equal((await investorSelect.textContent()).trim(), `New: ${name}`, file);
      await newLine.first().waitFor();
      assert.equal(await frame.getByText(/^No account (can|tracks)/).count(), 0);
    }
    await readHoldings("tests/fixtures/made-up-summary-cams.pdf");
    assert.equal((await investorSelect.textContent()).trim(), "New: Mutual funds");
    await investorSelect.click();
    await frame.getByRole("option", { name: "Don't save them", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["New: Mutual funds", "Don't save them"]);
    await tab.keyboard.press("Escape");
    await frame.getByRole("option").first().waitFor({ state: "detached" });
    await footer.getByText(/^Create the Wealthfolio account Mutual funds and save \d+ holdings on 31 Mar 2025\./).waitFor();
    assert.equal(await saveHoldings.textContent(), "Save holdings");

    // Rename edits the name in place: 2 to 50 characters, trimmed. While it's open, saving waits.
    await frame.getByRole("button", { name: "Rename the new account Mutual funds: ANANYA R TESTWALA's holdings", exact: true }).click();
    const nameField = frame.getByRole("textbox", { name: "Name of the new account: ANANYA R TESTWALA's holdings", exact: true });
    await focused(nameField, "Rename");
    assert.equal(await nameField.inputValue(), "Mutual funds");
    await footer.getByText("Save or cancel the new account name first.", { exact: true }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    for (const [typed, error] of [["", "Enter an account name."], [" X ", "Use at least 2 characters."], ["x".repeat(51), "Use at most 50 characters."]]) {
      await nameField.fill(typed);
      await nameField.press("Enter");
      // Announced, and tied to the field.
      await said.getByText(error, { exact: true }).waitFor();
      assert.equal(await nameField.getAttribute("aria-invalid"), "true");
      assert.equal(await frame.locator(`#${await nameField.getAttribute("aria-describedby")}`).textContent(), error);
      await focused(nameField, error);
    }
    // Escape cancels, and the focus goes back to Rename.
    await nameField.press("Escape");
    await focused(frame.getByRole("button", { name: "Rename the new account Mutual funds: ANANYA R TESTWALA's holdings", exact: true }), "Cancel");
    await frame.getByRole("button", { name: "Rename the new account Mutual funds: ANANYA R TESTWALA's holdings", exact: true }).click();
    await nameField.fill("  Family funds ");
    await frame.getByRole("button", { name: "Save name: ANANYA R TESTWALA's holdings", exact: true }).click();
    await said.getByText("The new account will be called Family funds.", { exact: true }).waitFor();
    await focused(frame.getByRole("button", { name: "Rename the new account Family funds: ANANYA R TESTWALA's holdings", exact: true }), "Saved name");
    assert.equal((await investorSelect.textContent()).trim(), "New: Family funds");
    assert.equal(await saveHoldings.isDisabled(), false);

    // A folio sent to an account of its own gets one, named after it. One Wealthfolio doesn't create
    // saves nothing and isn't remembered; the others are saved. Try again creates only that one.
    const folioAccount = "Fictiva Mutual Fund folio 91234567 / 12";
    await choose(liquidFolio, `New: ${folioAccount}`);
    await footer.getByText(new RegExp(`^Create the Wealthfolio account ${escaped(folioAccount)} and save \\d+ holdings? on 31 Mar 2025\\.`)).waitFor();
    await hosted((name) => { window.host.failCreate = [name]; }, folioAccount);
    await saveHoldings.click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    await frame.getByText(`Wealthfolio didn't create the account ${folioAccount}`, { exact: true }).waitFor();
    await frame.getByText(`${folioAccount}: Error: Accounts can't be created right now. Nothing was saved for it.`, { exact: true }).waitFor();
    // In the order the statement lists what goes to them: the folio comes first.
    assert.deepEqual(await creates(), [folioAccount, "Family funds"]);
    assert.deepEqual(await hosted(() => window.host.creates[1]), {
      name: "Family funds", accountType: "SECURITIES", currency: "INR", isDefault: false, isActive: true, trackingMode: "HOLDINGS",
    });
    assert.deepEqual(await rememberedIds(), ["created-2"]);
    assert.deepEqual(Object.keys(await hosted(() => window.host.snapshots)), ["created-2"]);
    await hosted(() => { window.host.failCreate = []; });
    await frame.getByRole("button", { name: "Try again", exact: true }).click();
    await frame.getByText("Saved 2 snapshots", { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Wealthfolio didn't create/).count(), 0);
    assert.deepEqual(await creates(), [folioAccount, "Family funds", folioAccount]);
    assert.deepEqual((await rememberedIds()).sort(), ["created-2", "created-3"]);
    assert.deepEqual(Object.keys(await hosted(() => window.host.snapshots)).sort(), ["created-2", "created-3"]);
    assert.deepEqual(await hosted(() => window.host.accounts.map((a) => [a.id, a.name, a.trackingMode])), [
      ["created-2", "Family funds", "HOLDINGS"], ["created-3", folioAccount, "HOLDINGS"],
    ]);
    // The next statement preselects them.
    await readHoldings();
    assert.equal((await investorSelect.textContent()).trim(), "Family funds (INR)");
    await frame.getByText("Chosen last time.", { exact: true }).waitFor();
    await openParts();
    assert.equal((await sourceSelect(liquidFolio).textContent()).trim(), `${folioAccount} (INR)`);
    assert.equal(await newLine.count(), 0);

    // With accounts that track holdings but none remembered, nothing is preselected: choosing where to
    // save is a question, and the new account stays offered.
    await hosted(() => window.host.storage.clear());
    await readHoldings();
    assert.match(await investorSelect.textContent(), /Choose an account/);
    await frame.getByRole("button", { name: /^\d+ questions?$/ }).waitFor();
    assert.equal(await saveHoldings.isDisabled(), true);
    await investorSelect.click();
    await frame.getByRole("option", { name: "Don't save them", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["Family funds (INR)", `${folioAccount} (INR)`, "New: Mutual funds", "Don't save them"]);
    await tab.keyboard.press("Escape");
    await frame.getByRole("option").first().waitFor({ state: "detached" });
    // A name an existing account has, here an archived one, gets a number.
    await freshProfile([{ id: "old-mf", name: "mutual FUNDS", currency: "INR", isActive: true, isArchived: true, trackingMode: "HOLDINGS" }]);
    await readHoldings();
    assert.equal((await investorSelect.textContent()).trim(), "New: Mutual funds 2");
    // When the only new account isn't created, nothing is saved or remembered and the review stays.
    await hosted(() => { window.host.failCreate = ["Mutual funds 2"]; });
    await saveHoldings.click();
    await frame.getByText("Mutual funds 2: Error: Accounts can't be created right now. Nothing was saved.", { exact: true }).waitFor();
    await focused(frame.locator("div[tabindex='-1']").filter({ hasText: /^Wealthfolio didn't create the account Mutual funds 2/ }), "Not created");
    assert.deepEqual(await rememberedIds(), []);
    assert.deepEqual(await hosted(() => window.host.snapshots), {});
    await reviewHeading.waitFor();
    await hosted(() => { window.host.failCreate = []; });
    await frame.getByRole("button", { name: "Try again saving holdings", exact: true }).click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    assert.deepEqual(await rememberedIds(), ["created-2"]);
    await leaveReview();

    // A family's detailed statement: an account for each investor, the second named for them. A gift
    // from one to the other waits whole while the receiving account isn't created; Try again creates it
    // and imports both sides together, which Wealthfolio links.
    await freshProfile();
    await hosted(() => Object.assign(window.host, { gifts: true, otherInvestorFolio: "93456789", failCreate: ["Mutual funds (BHAVYA R TESTWALA)"] }));
    await readStatement();
    await answerFunds();
    assert.equal((await fundsSelect().textContent()).trim(), "New: Mutual funds");
    assert.equal((await fundsSelect(otherInvestor).textContent()).trim(), "New: Mutual funds (BHAVYA R TESTWALA)");
    // A bank account is one Wealthfolio has: none here.
    await bankSelect().click();
    await frame.getByRole("option", { name: "None: don't add bank transfers", exact: true }).waitFor();
    assert.deepEqual(await frame.getByRole("option").allTextContents(), ["None: don't add bank transfers"]);
    await tab.keyboard.press("Escape");
    await frame.getByRole("option").first().waitFor({ state: "detached" });
    await dFooter.getByText(/^Create the Wealthfolio account Mutual funds and import \d+ transactions for \d+ funds into it\.$/).waitFor();
    await dFooter.getByText(/^Create the Wealthfolio account Mutual funds \(BHAVYA R TESTWALA\) and import 1 transaction for 1 fund into it\.$/).waitFor();
    const createButton = dFooter.getByRole("button", { name: /^Create 2 accounts and import \d+ transactions$/ });
    await createButton.click();
    await frame.getByText("Wealthfolio didn't create the account Mutual funds (BHAVYA R TESTWALA)", { exact: true }).waitFor();
    await frame.getByText("Mutual funds (BHAVYA R TESTWALA): Error: Accounts can't be created right now. 1 transaction for it wasn't imported.", { exact: true }).waitFor();
    // The gift between the two investors' folios: its transfers, not the one from a folio the statement doesn't include.
    const giftSides = () => hosted(() => window.host.activities.filter((a) => a.activityType.startsWith("TRANSFER_") && a.assetSymbol && !a.isExternal)
      .map((a) => [a.accountId, a.activityType, a.sourceGroupId ? "linked" : ""]));
    // Everything else went in; neither side of the gift did.
    await imported().waitFor();
    assert.deepEqual(await giftSides(), []);
    assert.deepEqual(await creates(), ["Mutual funds", "Mutual funds (BHAVYA R TESTWALA)"]);
    assert.deepEqual(await rememberedIds(), ["created-1"]);
    await hosted(() => { window.host.failCreate = []; });
    await frame.getByRole("button", { name: "Try again", exact: true }).click();
    await frame.getByText(/^Wealthfolio didn't create/).waitFor({ state: "detached" });
    assert.deepEqual(await creates(), ["Mutual funds", "Mutual funds (BHAVYA R TESTWALA)", "Mutual funds (BHAVYA R TESTWALA)"]);
    assert.deepEqual(await giftSides(), [["created-1", "TRANSFER_OUT", "linked"], ["created-3", "TRANSFER_IN", "linked"]]);
    await imported().waitFor();
    assert.deepEqual((await rememberedIds()).sort(), ["created-1", "created-3"]);
    assert.deepEqual(await hosted(() => window.host.creates.map((c) => c.trackingMode)), ["TRANSACTIONS", "TRANSACTIONS", "TRANSACTIONS"]);
    await hosted(() => Object.assign(window.host, { gifts: false, otherInvestorFolio: "" }));
    await leaveDetailed();
    await hosted((state) => Object.assign(window.host, { ...state, storage: new Map(state.storage), creates: [], failCreate: [] }), beforeNewAccounts);
    await hosted(() => { window.host.amfi = false; });

    await leaveReview();

    await frame.getByRole("button", { name: "Forget the saved password" }).click();
    await frame.getByRole("button", { name: "Forget the saved password" }).waitFor({ state: "hidden" });
    assert.deepEqual((await host()).secrets, []);

    // A parser that stops, hits a fatal Python error, never starts or never answers says so. The
    // form stays usable, and the next read starts a new parser.
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    const workers = () => hosted(() => window.host.workers);
    const failRead = async (fault, message, control = readButton) => {
      await hosted((fault) => window.host.breakWorkers(fault), fault);
      const before = await workers();
      await control.press("Enter");
      await frame.getByText(message, { exact: true }).waitFor({ timeout: 180_000 });
      await frame.locator("#cas-file:enabled").waitFor();
      assert.equal(await readButton.isDisabled(), false, fault);
      await focused(control, `A read that failed with ${fault}`);
      return (await workers()) - before;
    };
    const readAfterFault = async () => {
      await hosted(() => window.host.breakWorkers(""));
      const before = await hosted(() => ({ workers: window.host.workers, parsed: window.host.parsed }));
      await readButton.click();
      await tab.frames()[1].waitForFunction((n) => window.host.parsed > n, before.parsed, { timeout: 180_000 });
      // The statement opens its Review screen; the next read starts from the file form again.
      await transactionsHeading.waitFor({ timeout: 180_000 });
      assert.equal(await workers(), before.workers + 1, "a new parser");
      assert.equal(await frame.getByText("Couldn't read the statement", { exact: true }).count(), 0);
      await leaveDetailed();
      await frame.locator("#cas-file:enabled").waitFor();
      await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
      await frame.locator("#cas-password").fill("ABCDE1234F");
    };
    const stopped = "The parser stopped. Try reading the statement again.";
    assert.equal(await failRead("stop", stopped), 0);
    await readAfterFault();
    assert.equal(await failRead("stop", stopped), 0);
    // The stopped parser's replacement never gets Python's files.
    assert.equal(await failRead("no-ready", "The parser didn't start in time. Try reading the statement again."), 1);
    await readAfterFault();
    assert.equal(await failRead("fatal", stopped), 0);
    await readAfterFault();
    assert.equal(await failRead("no-reply", "The parser didn't finish reading this PDF in time. Try reading it again.", passwordBox), 0);
    await readAfterFault();
  } catch (error) {
    failed = true;
    console.log(`  FAILED: ${error.stack}`);
    // A wait for one message times out when the add-on shows another, such as a parser error.
    const alerts = await tab.frameLocator("iframe").getByRole("alert").allTextContents().catch(() => []);
    console.log("  Alerts:", alerts, "Console errors:", errors.slice(-10));
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
