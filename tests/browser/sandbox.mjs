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
      await tab.mouse.click(frameBox.x + frameBox.width + 20, frameBox.y + 20);
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
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await resume();
    await frame.getByText(/2 folios, 7 schemes, 78 rows\. Skipping 2 closed schemes, with no units and nothing to import\./).waitFor({ timeout: 180_000 });
    await focused(passwordBox, "PDF password");
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
    // A fund's or other holding's section while it needs a choice, and its row once it's confirmed or
    // left out. The row doesn't show the ISIN, so a holding is found by its name as the statement
    // prints it, which ends the names of all its controls.
    const holding = (name) => {
      const escaped = name.replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return frame.locator("section, li").filter({ has: frame.getByRole("button", { name: new RegExp(` for ${escaped}(, [a-zA-Z ]+ \\d+)?$`) }) });
    };
    // The funds on the made-up detailed statement that aren't closed.
    const detailed = {
      flexi: "Fictiva Flexi Cap Fund - Direct Plan - Growth",
      liquid: "Fictiva Liquid Fund - Direct Plan - Growth",
      balanced: "Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment",
      corporate: "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout",
      overnight: "Testbridge Overnight Fund - Direct Plan - Growth",
    };
    // The Overnight fund has no ISIN, so its name is searched without "Fund", the plan and option when it's first shown.
    const noIsin = holding(detailed.overnight);
    await frame.locator("section").filter({ hasText: "No ISIN printed" }).locator("h3").getByText(detailed.overnight).waitFor();
    await noIsin.getByText(`No ISIN on the statement; showing results for "Testbridge Overnight". These results can be other funds. Pick one with the statement's fund name, plan and option, or leave this fund out.`).waitFor();
    assert.equal(await noIsin.getByRole("textbox", { name: /^Search for / }).inputValue(), "Testbridge Overnight");
    assert.equal(await noIsin.getByRole("radio").count(), 1);
    assert.equal(await noIsin.getByRole("button", { name: "Use this fund" }).isDisabled(), true, "a name match needs picking");
    // Each section has a live region for its search's progress, count and notes. The searches every
    // section starts by itself stay quiet until the focus has been in the section's search.
    const outcome = (section) => section.locator("[aria-live]");
    assert.equal(await outcome(noIsin).getAttribute("aria-live"), "off");
    assert.equal(await outcome(noIsin).getAttribute("aria-atomic"), "true");
    assert.match(await outcome(noIsin).textContent(), /^1 result\.No ISIN on the statement; showing results for "Testbridge Overnight"\./);
    // Each section repeats the same controls, so their names say which fund, share, bond or NPS scheme
    // they're for: each name is in its section, and only once on the page.
    const namedFor = async (section, controls) => {
      // A row has no heading: its controls are named for the statement's name as it's given.
      const item = await section.locator("h3").count() ? await section.locator("h3").textContent() : undefined;
      for (const [role, name] of controls(item)) {
        await section.getByRole(role, { name, exact: true }).waitFor({ state: "attached" });
        assert.equal(await section.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
        assert.equal(await frame.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
      }
    };
    for (const section of await frame.locator("section").all()) {
      await namedFor(section, (fund) => [
        ["textbox", `Search for ${fund}`],
        ["button", `Search for ${fund}`],
        ["button", `Use this fund for ${fund}`],
        ["button", `Leave this fund out for ${fund}`],
      ]);
    }
    await namedFor(noIsin, (fund) => [["radiogroup", `Search results for ${fund}`]]);
    assert.equal(await noIsin.locator("h3").textContent(), detailed.overnight);
    assert.equal(await frame.locator("section").first().locator("h3").textContent(), detailed.flexi);
    const firstFund = holding(detailed.flexi);
    // With AMFI not added in Settings → Market data, the search for a fund's ISIN or for the name of one
    // printed without it finds no AMFI result. While any fund's does, its card recommends AMFI once,
    // directly below the card's intro and in no fund's section. Other search terms say nothing about AMFI.
    const fundsIntro = "Check that each fund found matches the statement's name, plan and option, then choose Use this fund. This is only needed the first time: the add-on remembers each fund you confirm.";
    const amfiNote = "We recommend AMFI for daily fund prices. Before confirming, add it in Settings → Market data if it isn't on. In each fund's search box, enter its ISIN or AMFI scheme code and press Search.";
    const amfiNoteShown = async (intro = fundsIntro) => {
      await frame.getByText(amfiNote, { exact: true }).waitFor();
      assert.equal(await frame.getByText(amfiNote, { exact: true }).count(), 1);
      assert.equal(await frame.locator("section").getByText(amfiNote, { exact: true }).count(), 0);
      assert.equal(await frame.getByText(intro, { exact: true }).locator("xpath=following-sibling::*[1]").textContent(), amfiNote);
      assert.equal(await frame.getByText(/No AMFI result/).count(), 0);
    };
    const noAmfiNote = async () => {
      // Search-result DOM can appear before the effect reports its condition to the card.
      await tab.frames()[1].evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await frame.getByText(amfiNote, { exact: true }).waitFor({ state: "detached" });
    };
    await amfiNoteShown();
    const search = firstFund.getByRole("textbox", { name: /^Search for / });
    const useFund = firstFund.getByRole("button", { name: "Use this fund" });
    // A fund's plan and option are badges beside its name, its search results and its confirmed choice.
    // Each name gets badges only for its own fields. Beside a result or choice, a field warns only
    // when both names give it and it differs.
    const badges = (locator) => locator.locator("[data-slot=badge]").evaluateAll((all) => all.map((b) => `${b.textContent} ${b.dataset.variant}`));
    const nameBadges = (section) => badges(section.locator("h3").locator("xpath=.."));
    const resultBadges = (section) => section.getByRole("radiogroup").locator("label").evaluateAll((labels) =>
      labels.map((label) => [...label.querySelectorAll("[data-slot=badge]")].map((b) => `${b.textContent} ${b.dataset.variant}`)));
    const choiceBadges = (section) => badges(section.getByText("Confirmed", { exact: true }).locator("xpath=.."));
    // The codes behind each result, under its Details.
    const resultCodes = (section) => section.getByRole("radiogroup").locator("details p").allTextContents();
    // A holding confirmed to use the statement's prices says so, and its Details has its symbol.
    const statementPriced = async (section, symbol, type) => {
      await section.getByText("Confirmed", { exact: true }).waitFor();
      await section.getByText("Statement prices", { exact: true }).waitFor();
      assert.equal(await section.locator("details p").textContent(), `Symbol ${symbol} · Type ${type} · Currency INR`);
    };
    assert.deepEqual(await nameBadges(firstFund), ["Direct secondary", "Growth secondary"]);
    assert.deepEqual(await nameBadges(holding(detailed.corporate)), ["Regular secondary", "IDCW secondary"]);
    assert.deepEqual(await nameBadges(frame.locator("section").filter({ hasText: "IDCW Reinvestment" })), ["Direct secondary", "IDCW secondary"]);
    await search.fill("Fictiva Flexi Cap");
    await search.press("Enter");
    await firstFund.getByRole("radio").nth(4).waitFor({ state: "attached" });
    assert.equal(await outcome(firstFund).getAttribute("aria-live"), "polite");
    assert.equal(await outcome(firstFund).textContent(), "5 results.");
    assert.deepEqual(await resultBadges(firstFund), [
      ["Direct secondary", "Growth secondary"],
      ["Regular warning-subtle", "IDCW warning-subtle"],
      ["Direct secondary"],
      [],
      ["Growth secondary"],
    ]);
    await firstFund.getByRole("radio").nth(1).dispatchEvent("click");
    await firstFund.getByRole("button", { name: "Use this fund", disabled: false }).press("Enter");
    await firstFund.getByText("Confirmed", { exact: true }).waitFor();
    await focused(firstFund.getByRole("button", { name: /^Change the / }), "Use this fund");
    assert.deepEqual(await choiceBadges(firstFund), ["Confirmed success-subtle", "Regular warning-subtle", "IDCW warning-subtle"]);
    // A confirmed fund is a row of its own, without the statement's name when the chosen one is the
    // same fund's, whatever the plan and option.
    assert.equal(await firstFund.evaluate((row) => row.tagName), "LI");
    assert.equal(await firstFund.locator("h3").count(), 0);
    assert.equal(await firstFund.getByText(/^On the statement: /).count(), 0);
    await firstFund.getByRole("button", { name: /^Change the / }).press("Enter");
    await focused(search, "Change");
    assert.equal(await outcome(firstFund).getAttribute("aria-live"), "polite", "a section opened again announces its own search");
    for (const [index, expected] of [[2, ["Direct secondary"]], [3, []], [4, ["Growth secondary"]]]) {
      await search.fill("Fictiva Flexi Cap");
      await search.press("Enter");
      await firstFund.getByRole("radio").nth(4).waitFor({ state: "attached" });
      await firstFund.getByRole("radio").nth(index).dispatchEvent("click");
      await useFund.click();
      await firstFund.getByText("Confirmed", { exact: true }).waitFor();
      assert.deepEqual(await choiceBadges(firstFund), ["Confirmed success-subtle", ...expected]);
      await firstFund.getByRole("button", { name: /^Change the / }).click();
    }
    // Under its name, each result says where its prices come from; its codes are behind Details.
    // Yahoo names some funds only by their ticker: such a result says it's unnamed, keeps its ticker
    // to tell it apart, and takes no name, plan or option from the statement.
    const firstName = await firstFund.locator("h3").textContent();
    await search.fill("Fictiva Flexi Cap Yahoo");
    await search.press("Enter");
    await firstFund.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await firstFund.getByRole("radiogroup").locator("label").allTextContents(), [
      "Fictiva Flexi Cap Dir Gr Direct Growth Yahoo Finance",
      "Unnamed Yahoo listing (0P0000FFC2.BO) Plan and option unknown Yahoo Finance",
    ]);
    assert.deepEqual(await resultBadges(firstFund), [["Direct secondary", "Growth secondary"], ["Plan and option unknown warning-subtle"]]);
    assert.deepEqual(await resultCodes(firstFund), [
      "Symbol 0P0000FFC1 · Exchange XBOM · Type MUTUALFUND · Currency INR",
      "Symbol 0P0000FFC2 · Exchange XBOM · Type MUTUALFUND · Currency INR",
    ]);
    // Each Details is named for its result, for screen readers, and opens and closes from the
    // keyboard without picking the result.
    const resultDetails = firstFund.getByRole("radiogroup").locator("details");
    assert.deepEqual(await resultDetails.locator("summary").evaluateAll((all) => all.map((s) => [s.textContent, s.getAttribute("aria-label")])), [
      ["Details", `Details of Fictiva Flexi Cap Dir Gr, Yahoo Finance, for ${firstName}`],
      ["Details", `Details of Unnamed Yahoo listing (0P0000FFC2.BO), Yahoo Finance, for ${firstName}`],
    ]);
    const unnamedSummary = resultDetails.nth(1).locator("summary");
    await unnamedSummary.focus();
    await unnamedSummary.press("Enter");
    assert.equal(await resultDetails.nth(1).evaluate((d) => d.open), true);
    await unnamedSummary.press(" ");
    assert.equal(await resultDetails.nth(1).evaluate((d) => d.open), false);
    assert.deepEqual(await firstFund.getByRole("radio").evaluateAll((all) => all.map((r) => r.getAttribute("aria-checked"))), ["false", "false"]);
    // Confirmed, it's shown the same way.
    await firstFund.getByRole("radio").nth(1).dispatchEvent("click");
    await useFund.click();
    await firstFund.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(firstFund), ["Confirmed success-subtle", "Plan and option unknown warning-subtle"]);
    assert.match(await firstFund.getByText("Confirmed", { exact: true }).locator("xpath=..").textContent(), /^ConfirmedUnnamed Yahoo listing \(0P0000FFC2\.BO\) Plan and option unknownChange/);
    await firstFund.getByText("Yahoo Finance", { exact: true }).waitFor();
    assert.equal(await firstFund.locator("details summary").getAttribute("aria-label"), `Details of the fund confirmed for ${firstName}`);
    assert.equal(await firstFund.locator("details p").textContent(), "Symbol 0P0000FFC2 · Exchange XBOM · Type MUTUALFUND · Currency INR");
    await firstFund.getByRole("button", { name: /^Change the / }).click();
    // Same displayed names, including unnamed listings, stay distinct for screen readers.
    for (const [query, name, badges] of [
      ["Fictiva Flexi Cap exchanges", "Fictiva Flexi Cap Dir Gr", "Direct Growth"],
      ["Fictiva Flexi Cap unnamed", "Unnamed Yahoo listing (FICTIVA)", "Plan and option unknown"],
    ]) {
      await search.fill(query);
      await search.press("Enter");
      await firstFund.getByRole("radio").nth(1).waitFor({ state: "attached" });
      assert.deepEqual(await resultCodes(firstFund), [
        "Symbol FICTIVA · Exchange XBOM · Type MUTUALFUND · Currency INR",
        "Symbol FICTIVA · Exchange XNSE · Type MUTUALFUND · Currency INR",
      ]);
      for (const number of [1, 2]) {
        assert.equal(await firstFund.getByRole("radio", { name: `${name} ${badges} Yahoo Finance, listing ${number}`, exact: true }).count(), 1);
        assert.equal(await resultDetails.nth(number - 1).locator("summary").getAttribute("aria-label"), `Details of ${name}, listing ${number}, Yahoo Finance, for ${firstName}`);
      }
      await firstFund.getByRole("radio").nth(1).dispatchEvent("click");
      await useFund.click();
      await firstFund.getByText("Confirmed", { exact: true }).waitFor();
      assert.equal(await firstFund.locator("details p").textContent(), "Symbol FICTIVA · Exchange XNSE · Type MUTUALFUND · Currency INR");
      await firstFund.getByRole("button", { name: /^Change the / }).click();
    }
    await search.fill("MULTI");
    await search.press("Enter");
    await firstFund.getByRole("radio").nth(1).waitFor({ state: "attached" });
    // The other funds' searches still find no AMFI result.
    await amfiNoteShown();
    assert.equal(await useFund.isDisabled(), true, "multiple matches require a selected result");
    await firstFund.getByRole("radio").nth(1).dispatchEvent("click");
    assert.equal(await useFund.isDisabled(), false);
    await pause("market");
    await search.fill("WAIT");
    await search.press("Enter");
    await waiting();
    assert.equal(await outcome(firstFund).textContent(), "Searching…");
    assert.equal(await useFund.isDisabled(), true, "a new search cannot confirm old results");
    assert.equal(await firstFund.getByRole("radio").count(), 0);
    // Fail a newer search, then deliver the older response: neither can restore stale results.
    await tab.frames()[1].evaluate(() => { window.host.pause = ""; });
    await search.fill("FAIL");
    await search.press("Enter");
    await firstFund.getByText(/The search failed/).waitFor();
    assert.equal(await outcome(firstFund).textContent(), "The search failed: Error: Search unavailable");
    await resume();
    assert.equal(await useFund.isDisabled(), true);
    await search.fill("INFZ91T01CB6");
    await search.press("Enter");
    await outcome(firstFund).getByText("Nothing found. Try the fund's name.", { exact: true }).waitFor();
    assert.equal(await outcome(firstFund).textContent(), "Nothing found. Try the fund's name.");
    await search.fill(expected.folios[0].schemes[0].isin);
    await search.press("Enter");
    // The Corporate Bond fund's ISIN finds nothing, so its name is searched without "Fund", the plan and option.
    const byName = holding(detailed.corporate);
    await byName.getByText('Nothing found for the ISIN; showing results for "Testbridge Corporate Bond".').waitFor();
    assert.equal(await byName.getByRole("textbox", { name: /^Search for / }).inputValue(), "Testbridge Corporate Bond");
    await byName.getByRole("radio").first().waitFor({ state: "attached" });
    assert.equal(await byName.getByRole("button", { name: "Use this fund" }).isDisabled(), true, "a name match needs picking");
    // A late name fallback cannot replace a newer typed search or restore its message.
    const nameSearch = byName.getByRole("textbox", { name: /^Search for / });
    await pause("Testbridge Corporate Bond");
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
    await byName.getByText('Nothing found for the ISIN; showing results for "Testbridge Corporate Bond".').waitFor();
    assert.equal(await outcome(byName).getAttribute("aria-live"), "polite");
    assert.match(await outcome(byName).textContent(), /^1 result\.Nothing found for the ISIN; showing results for "Testbridge Corporate Bond"\./);
    await byName.getByRole("radio").first().dispatchEvent("click");
    await noIsin.getByRole("radio").first().dispatchEvent("click");
    // Each fund confirmed leaves the sections for the list of rows after them, in the statement's order.
    for (let open = 5; open > 0; open--) {
      const section = frame.locator("section").first();
      await section.getByRole("radio").first().waitFor();
      await section.getByRole("button", { name: "Use this fund" }).click();
      await frame.locator("section").nth(open - 1).waitFor({ state: "detached" });
    }
    const rows = frame.getByRole("listitem").filter({ has: frame.getByRole("button", { name: /^(Change the|Choose an?) / }) });
    assert.equal(await rows.count(), 5);
    for (const [i, name] of [detailed.flexi, detailed.liquid, detailed.balanced, detailed.corporate, detailed.overnight].entries()) {
      await namedFor(rows.nth(i), () => [["button", `Change the fund for ${name}`]]);
      assert.equal(await rows.nth(i).getByText("Confirmed", { exact: true }).count(), 1);
      // The fake host's names aren't the statement's, so each row gives the statement's too.
      assert.equal(await rows.nth(i).getByText(`On the statement: ${name}`, { exact: true }).count(), 1);
    }
    assert.equal(await frame.getByText(/^\d+ funds? matched from AMFI/).count(), 0, "AMFI isn't added");
    // Once no open fund search lacks an AMFI result, the note goes.
    await noAmfiNote();
    const searches = await tab.frames()[1].evaluate(() => window.host.searches);
    assert.ok(!searches.some((query) => /INFZ90K01MC|INFZ91T01GL/.test(query)), searches.join(" "));
    assert.ok(searches.includes("INFZ91T01CB6") && searches.includes("Testbridge Corporate Bond"), searches.join(" "));
    assert.ok(searches.includes("Testbridge Overnight"), searches.join(" "));
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

    await frame.getByRole("button", { name: "Preview the import" }).press("Enter");
    // The Flexi Cap fund starts with units the fake host has no history for.
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await focused(frame.getByRole("button", { name: "Preview the import" }), "Preview the import");
    // A status line beside the button reads out the work that locks the page, and the counts once the preview is ready.
    const pageStatus = frame.getByRole("button", { name: /^Preview the / }).locator("xpath=..").getByRole("status");
    assert.equal(await pageStatus.textContent(), "The preview is ready: 13 new transactions, 0 already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import.");
    await frame.getByText(/starts with 1250\.000 units bought before 01-Apr-2023/).waitFor();
    // Rechecking removes the old preview and locks every input until its answer arrives.
    await pause("check");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await waiting();
    assert.equal(await pageStatus.textContent(), "Preparing the preview…");
    assert.equal(await frame.getByRole("button", { name: "Import 23 activities" }).count(), 0);
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await frame.getByLabel("PAN ABCDE1234F", { exact: true }).isDisabled(), true);
    assert.equal(await remember.isDisabled(), true);
    assert.equal(await frame.getByRole("button", { name: /^Change the / }).first().isDisabled(), true);
    await resume();
    // A failed import keeps the preview, and its alert says why: the status line doesn't say it's ready again.
    await tab.frames()[1].evaluate(() => { window.host.failImport = true; });
    await frame.getByRole("button", { name: "Import 23 activities", disabled: false }).press("Enter");
    await frame.getByText("The import failed: Error: Import unavailable", { exact: true }).waitFor();
    await focused(frame.getByRole("button", { name: "Import 23 activities" }), "Import 23 activities, failed");
    assert.equal(await pageStatus.textContent(), "");
    await tab.frames()[1].evaluate(() => { window.host.failImport = false; });
    await pause("import");
    await frame.getByRole("button", { name: "Import 23 activities", disabled: false }).press("Enter");
    await waiting();
    assert.equal(await pageStatus.textContent(), "Importing…");
    assert.equal(await frame.getByRole("button", { name: "Preview the import" }).isDisabled(), true);
    assert.equal(await frame.locator("#cas-file").isDisabled(), true);
    assert.equal(await remember.isDisabled(), true);
    await resume();
    await frame.getByText("Imported 23 of 23 activities").waitFor();
    await focused(frame.getByRole("alert").filter({ hasText: /^Imported 23 of 23 activities/ }), "Import 23 activities");
    assert.equal(await pageStatus.textContent(), "");
    const units = frame.locator("table").last().locator("tbody tr");
    assert.equal(await units.count(), 5);
    assert.equal(await units.filter({ hasText: "Match" }).count(), 4);
    assert.deepEqual(
      await frame.locator("table").last().getByRole("columnheader").allTextContents(),
      ["Fund", "Units in the statement", "Units in Wealthfolio", "Status"],
    );

    // A second import of the same statement finds everything.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    // Each transaction's "Import anyway" says which one it is for, and each name is on the page once.
    const importAnyway = frame.getByRole("checkbox", { name: /^Import anyway for the / });
    assert.equal(await importAnyway.count(), 13);
    for (const name of await importAnyway.evaluateAll((all) => all.map((box) => box.closest("label").textContent))) {
      assert.equal(await frame.getByRole("checkbox", { name, exact: true }).count(), 1, name);
    }
    await frame.getByRole("checkbox", {
      name: "Import anyway for the 2023-05-05 purchase of Fictiva Liquid Fund - Direct Plan - Growth, 25001.1470564, folio 91234567 / 12, transaction 1",
      exact: true,
    }).waitFor({ state: "attached" });
    // Equal purchases of the same fund in two folios have their own IDs: the other folio's are new
    // and go in without "Import anyway". Then each has one, with a distinct name.
    const beforeTwins = await tab.frames()[1].evaluate(() => window.host.activities.length);
    await tab.frames()[1].evaluate(() => { window.host.sharedIsin = "INFZ90K01LQ6"; });
    await readButton.press("Enter");
    await frame.getByText(/3 folios, 8 schemes, 83 rows\./).waitFor({ timeout: 180_000 });
    await focused(readButton, "Read statement");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^\d+ new transactions?, 13 already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import\./).waitFor({ timeout: 30_000 });
    const twins = frame.getByRole("checkbox", { name: /^Import anyway for the 2023-05-05 purchase of Fictiva Liquid Fund - Direct Plan - Growth, 25001\.1470564,/ });
    assert.equal(await twins.count(), 1);
    await frame.getByRole("button", { name: /^Import \d+ activit(y|ies)$/ }).click();
    await frame.getByText(/^Imported (\d+) of \1 activit(y|ies)/).waitFor();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, \d+ already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import\./).waitFor({ timeout: 30_000 });
    await twins.nth(1).waitFor({ state: "attached" });
    assert.equal(await twins.count(), 2);
    for (const name of await twins.evaluateAll((all) => all.map((box) => box.closest("label").textContent))) {
      assert.equal(await frame.getByRole("checkbox", { name, exact: true }).count(), 1, name);
    }
    await tab.frames()[1].evaluate((length) => {
      window.host.sharedIsin = "";
      window.host.activities.length = length;
    }, beforeTwins);
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText(/2 folios, 7 schemes, 78 rows\./).waitFor({ timeout: 180_000 });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    assert.equal(await frame.getByRole("button", { name: "Import 0 activities" }).isDisabled(), true);
    // Statements are in rupees. A result or a confirmed fund quoted in another currency has a warning
    // badge with its currency and a line saying so, and so has each of its fund's transactions in the
    // preview. A result in rupees, the other funds and their transactions say nothing about currency.
    const inUsd = "The statement's prices and amounts are in rupees, but this asset is quoted in USD. Check that it's the right listing.";
    const usdRowNote = "The statement's prices and amounts are in rupees, but DMCB is quoted in USD. Check that it's the right listing.";
    const quotedIn = (locator) => locator.getByText(/^The statement's prices and amounts are in rupees, but /);
    const usdResults = ["Democorp Bank ADR USD FAKE " + inUsd, "Democorp Bank Ltd FAKE"];
    const usdCodes = ["Symbol DMCB · Exchange XNYS · Type EQUITY · Currency USD", "Symbol DEMOCORPBK · Exchange XNSE · Type EQUITY · Currency INR"];
    const usdFund = holding(detailed.liquid);
    const usdSearch = usdFund.getByRole("textbox", { name: /^Search for / });
    await usdFund.getByRole("button", { name: /^Change the / }).click();
    await usdSearch.fill("Democorp Bank");
    await usdSearch.press("Enter");
    await usdFund.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await usdFund.locator("label").allTextContents(), usdResults);
    assert.deepEqual(await resultCodes(usdFund), usdCodes);
    assert.deepEqual(await resultBadges(usdFund), [["USD warning-subtle"], []]);
    assert.equal(await quotedIn(frame).count(), 1);
    // A warning, not a block.
    await usdFund.getByRole("radio").first().dispatchEvent("click");
    await usdFund.getByRole("button", { name: "Use this fund", disabled: false }).click();
    await usdFund.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(usdFund), ["Confirmed success-subtle", "USD warning-subtle"]);
    assert.equal(await usdFund.getByText(usdCodes[0], { exact: true }).count(), 1);
    assert.equal(await usdFund.getByText("FAKE", { exact: true }).count(), 1);
    assert.equal(await usdFund.getByText(inUsd, { exact: true }).count(), 1);
    assert.equal(await quotedIn(frame).count(), 1);
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^\d+ new transactions?, \d+ already in Wealthfolio/).waitFor({ timeout: 30_000 });
    const previewRows = frame.locator("table").last().locator("tbody tr");
    const usdRows = previewRows.filter({ hasText: "Fictiva Liquid Fund - Direct Plan - Growth" });
    assert.ok(await usdRows.count() > 0);
    assert.equal(await usdRows.filter({ has: frame.getByText(usdRowNote, { exact: true }) }).count(), await usdRows.count());
    assert.equal(await quotedIn(previewRows).count(), await usdRows.count());
    // Back to the fund's own listing for the checks that follow: its ISIN's only result, preselected.
    await usdFund.getByRole("button", { name: /^Change the / }).click();
    await usdFund.getByRole("button", { name: "Use this fund", disabled: false }).click();
    await usdFund.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(await quotedIn(frame).count(), 0);
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    assert.equal(await quotedIn(frame).count(), 0);
    // So it does when activities show display codes other than the funds' symbols: each fund goes by
    // the symbol and exchange on its asset's profile.
    const renameFunds = (prefix) => tab.frames()[1].evaluate((prefix) => {
      for (const a of window.host.activities) if (a.assetId) a.assetSymbol = `${prefix}${a.symbol}`;
    }, prefix);
    await renameFunds("My ");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, 13 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    // A symbol-only match must have the import's type too, or new rows could reach another asset.
    await tab.frames()[1].evaluate(() => {
      const a = window.host.activities.find((a) => a.assetId);
      window.host.assets[a.assetId] = { symbol: a.symbol, exchangeMic: a.exchangeMic, instrumentType: "METAL" };
    });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The symbol, exchange or type of .+ changed in Wealthfolio/).waitFor();
    await tab.frames()[1].evaluate(() => { delete window.host.assets[window.host.activities.find((a) => a.assetId).assetId].instrumentType; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The type of .+ isn't set in Wealthfolio/).waitFor();
    await tab.frames()[1].evaluate(() => { delete window.host.assets[window.host.activities.find((a) => a.assetId).assetId]; });
    await renameFunds("");

    // A profile failure stops a symbol-only match instead of offering the trade again.
    await tab.frames()[1].evaluate(() => { window.host.failGetProfileIds = [window.host.activities.find((a) => a.assetId).assetId]; });
    await frame.getByRole("button", { name: "Preview the import" }).press("Enter");
    await frame.getByText(/Couldn't read a Wealthfolio asset's profile/).waitFor();
    await focused(frame.getByRole("button", { name: "Preview the import" }), "Preview the import, failed");
    assert.equal(await frame.getByRole("button", { name: "Import 0 activities" }).count(), 0);
    await tab.frames()[1].evaluate((symbol) => { window.host.failGetProfileIds = []; window.host.assets["chosen-fund"] = { symbol, exchangeMic: "XBOM" }; }, expected.folios[0].schemes[0].isin);
    // Search lists an untyped asset as OTHER, but symbol-based imports cannot target it.
    await firstFund.getByRole("button", { name: /^Change the / }).click();
    await firstFund.getByRole("textbox", { name: /^Search for / }).fill(expected.folios[0].schemes[0].isin);
    await firstFund.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await firstFund.getByRole("radio").first().dispatchEvent("click");
    await firstFund.getByRole("button", { name: "Use this fund" }).click();
    await firstFund.getByText("Confirmed").waitFor();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The type of .+ isn't set in Wealthfolio\. Set its type there/).waitFor();
    assert.equal(await frame.getByText(/^\d+ new transactions?, \d+ already in Wealthfolio/).count(), 0);
    // Set its type and confirm it again, then change its identity and remove it entirely.
    await tab.frames()[1].evaluate(() => { window.host.assets["chosen-fund"].instrumentType = "EQUITY"; });
    await firstFund.getByRole("button", { name: /^Change the / }).click();
    await firstFund.getByRole("textbox", { name: /^Search for / }).fill(expected.folios[0].schemes[0].isin);
    await firstFund.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await firstFund.getByRole("radio").first().dispatchEvent("click");
    await firstFund.getByRole("button", { name: "Use this fund" }).click();
    await firstFund.getByText("Confirmed").waitFor();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^\d+ new transactions, \d+ already in Wealthfolio/).waitFor({ timeout: 30_000 });
    assert.equal(await frame.getByText(/changed in Wealthfolio/).count(), 0);
    await tab.frames()[1].evaluate(() => { window.host.assets["chosen-fund"].symbol = "B2"; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The symbol, exchange or type of .+ changed in Wealthfolio/).waitFor();
    // A fresh confirmation of the same ID for another scheme cannot hide the stale one.
    await byName.getByRole("button", { name: /^Change the / }).click();
    await byName.getByRole("textbox", { name: /^Search for / }).fill("B2");
    await byName.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await byName.getByRole("radio").first().dispatchEvent("click");
    await byName.getByRole("button", { name: "Use this fund" }).click();
    await byName.getByText("Confirmed").waitFor();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The symbol, exchange or type of .+ changed in Wealthfolio/).waitFor();
    await byName.getByRole("button", { name: /^Change the / }).click();
    await byName.getByRole("textbox", { name: /^Search for / }).fill("Testbridge Corporate Bond");
    await byName.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await byName.getByRole("radio").first().dispatchEvent("click");
    await byName.getByRole("button", { name: "Use this fund" }).click();
    await byName.getByText("Confirmed").waitFor();
    await tab.frames()[1].evaluate((symbol) => { Object.assign(window.host.assets["chosen-fund"], { symbol, instrumentType: "METAL" }); }, expected.folios[0].schemes[0].isin);
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/The symbol, exchange or type of .+ changed in Wealthfolio/).waitFor();
    await tab.frames()[1].evaluate(() => { delete window.host.assets["chosen-fund"]; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/If the asset was deleted, choose its replacement under Funds/).waitFor();
    // Reconfirm the original symbol-only choice for the remaining checks.
    await firstFund.getByRole("button", { name: /^Change the / }).click();
    await firstFund.getByRole("textbox", { name: /^Search for / }).fill(expected.folios[0].schemes[0].isin);
    await firstFund.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await firstFund.getByRole("radio").first().dispatchEvent("click");
    await firstFund.getByRole("button", { name: "Use this fund" }).click();
    await firstFund.getByText("Confirmed").waitFor();

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
    const reuseBankRow = frame.getByRole("checkbox", {
      name: "Use it instead of a new transfer out for the 2023-05-05 purchase of Fictiva Liquid Fund - Direct Plan - Growth, 25001.1470564, folio 91234567 / 12, transaction 1",
      exact: true,
    });
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
    await frame.getByText("Linked 1 of 1 bank row you chose with its transaction.").waitFor();
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

    // A fund whose rows don't add up to its closing balance is left out, even with its opening units in
    // Wealthfolio, unless the user imports it anyway.
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    await frame.getByText("casparser reported warnings", { exact: true }).waitFor();
    assert.equal(await frame.getByText("Confirmed", { exact: true }).count(), 5);
    const flexiOpening = {
      id: "flexi-opening", accountId: "account-1", activityType: "BUY", subtype: null, status: "POSTED",
      date: "2023-03-01T00:00:00+00:00", quantity: "1250", unitPrice: "40", amount: "50000", fee: null, currency: "INR",
      needsReview: false, comment: null, assetId: "asset-INFZ90K01FC8", assetSymbol: "INFZ90K01FC8", exchangeMic: "XBOM",
    };
    await tab.frames()[1].evaluate((opening) => { window.host.activities = [opening]; }, flexiOpening);
    const gap = /^Fictiva Flexi Cap Fund - Direct Plan - Growth, folio 91234567 \/ 12: The rows take the unit balance from 1250 to 2798\.066, but the statement's closing balance is 2892\.104, 94\.038 units apart/;
    const leftOutAlert = frame.getByRole("alert").filter({ hasText: /^Left out/ });
    const anywayAlert = frame.getByRole("alert").filter({ hasText: /^Imported anyway/ });
    const importFlexi = frame.getByRole("checkbox", {
      name: "Import this fund anyway for Fictiva Flexi Cap Fund - Direct Plan - Growth, folio 91234567 / 12",
      exact: true,
    });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await leftOutAlert.getByText(gap).waitFor();
    assert.equal(await importFlexi.getAttribute("aria-checked"), "false");
    // Each tick previews again, and the new preview's checkbox takes the focus back.
    await importFlexi.press("Space");
    await frame.getByText(/^38 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await anywayAlert.getByText(gap).waitFor();
    await focused(anywayAlert.getByRole("checkbox"), "Import this fund anyway");
    assert.equal(await leftOutAlert.getByText(gap).count(), 0);
    await frame.getByRole("button", { name: "Import 73 activities" }).waitFor();
    await importFlexi.press("Space");
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await leftOutAlert.getByText(gap).waitFor();
    await focused(leftOutAlert.getByRole("checkbox"), "Import this fund anyway, unticked");
    assert.equal(await anywayAlert.count(), 0);
    // A tick whose preview fails shows no checkbox, so its error takes the focus, and a later preview
    // leaves the checkbox's focus alone.
    await tab.frames()[1].evaluate(() => { window.host.failGetProfileIds = ["asset-INFZ90K01FC8"]; });
    await importFlexi.press("Space");
    await frame.getByText(/^Couldn't prepare the preview/).waitFor();
    await focused(frame.getByRole("alert").filter({ hasText: /^Something went wrong/ }), "Import this fund anyway, failed");
    await tab.frames()[1].evaluate(() => { window.host.failGetProfileIds = []; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^38 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    assert.equal(await importFlexi.evaluate((box) => box === document.activeElement), false);
    await pause("check");
    await importFlexi.press("Space");
    await waiting();
    await clickOutside();
    await resume();
    await frame.getByText(/^13 new transactions, 0 already in Wealthfolio/).waitFor({ timeout: 30_000 });
    await stayedOutside("Import this fund anyway");
    await frame.getByRole("button", { name: "Import 23 activities" }).click();
    await frame.getByText("Imported 23 of 23 activities").waitFor();
    const afterGap = await tab.frames()[1].evaluate(() => window.host.activities);
    assert.deepEqual(afterGap.filter((a) => a.assetSymbol === "INFZ90K01FC8").map((a) => a.id), ["flexi-opening"]);
    assert.equal(afterGap.length, 24);
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await frame.getByText("Confirmed", { exact: true }).count(), 5);
    await tab.frames()[1].evaluate(() => { window.host.activities = []; });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await pause("import");
    await frame.getByRole("button", { name: "Import 23 activities" }).press("Enter");
    await waiting();
    await clickOutside();
    await tab.frames()[1].evaluate(() => {
      window.host.rejectLine = 1;
      window.host.failHistory = true;
    });
    await resume();
    await frame.getByText("Imported 22 of 23 activities").waitFor();
    await frame.getByText("Wealthfolio rejected rows", { exact: true }).waitFor();
    await frame.getByText(/The fund could not be created/).waitFor();
    await frame.getByText(/The import finished, but the closing units couldn't be checked/).waitFor();
    await stayedOutside("Import 23 activities");
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
      await section.getByRole("textbox", { name: /^Search for / }).waitFor();
      assert.equal(await section.getByText("Confirmed", { exact: true }).count(), 0);
      assert.equal(await section.getByText("Left out", { exact: true }).count(), 0);
    };
    const leaveOut = async (section) => {
      await section.getByRole("button", { name: /^Change the / }).click();
      await section.getByRole("button", { name: "Leave this fund out" }).click();
      await section.getByText("Left out", { exact: true }).waitFor();
    };
    // Confirms the first result for each fund with these ISINs, whose sections go once they're confirmed.
    const confirmFirst = async (isins) => {
      for (const isin of isins) {
        const section = frame.locator("section").filter({ hasText: `ISIN ${isin}` });
        await section.getByRole("radio").first().waitFor({ state: "attached" });
        await section.getByRole("radio").first().dispatchEvent("click");
        await section.getByRole("button", { name: "Use this fund" }).click();
        await section.waitFor({ state: "detached" });
      }
    };
    // Confirms the first result for every holding that still needs a choice, each in a section of its own until then.
    const useFirstResults = async () => {
      for (let open = await frame.locator("section").count(); open > 0; open--) {
        const section = frame.locator("section").first();
        await section.getByRole("radio").first().waitFor({ state: "attached" });
        await section.getByRole("radio").first().click();
        await section.getByRole("button", { name: /^Use this / }).click();
        await frame.locator("section").nth(open - 1).waitFor({ state: "detached" });
      }
    };
    // Leaves out every fund that still needs a choice, each in a section of its own until then.
    const leaveOutOthers = async () => {
      for (let open = await frame.locator("section").count(); open > 0; open--) {
        await frame.locator("section").first().getByRole("button", { name: "Leave this fund out" }).click();
        await frame.locator("section").nth(open - 1).waitFor({ state: "detached" });
      }
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
    for (const name of [detailed.flexi, detailed.liquid, detailed.balanced]) await leaveOut(holding(name));
    assert.equal(await previewButton.isDisabled(), false);
    await tab.frames()[1].evaluate((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeBankValidation);
    await readAgain();
    assert.deepEqual(await storage(), beforeBankValidation);

    // Remembered accounts that are hidden, archived or no longer listed are ignored too, and their rows
    // say why. A folio's own choice needs making again, even to go with its PAN.
    const testbridge = frame.getByLabel("Testbridge Mutual Fund, folio 1040012345", { exact: true });
    const [testbridgeKey, ...folioBankKeys] = await Promise.all([testbridge, ...bankFolios].map((select) => select.getAttribute("id")));
    const rowOf = (select) => frame.locator("div.justify-between").filter({ has: select });
    const unavailable = (account) => `Chosen before: ${account}, so choose again.`;
    const missing = unavailable("an account that's no longer available");
    const pick = async (select, option) => {
      await select.click();
      await frame.getByRole("option", { name: option, exact: true }).click();
    };
    const saveChoices = (choices) => tab.frames()[1].evaluate((choices) => {
      for (const [key, id] of choices) window.host.storage.set(key, id);
    }, choices);
    const restoreChoices = async (saved) => {
      await tab.frames()[1].evaluate((saved) => { window.host.storage = new Map(Object.entries(saved)); }, saved);
      await readAgain();
      assert.deepEqual(await storage(), saved);
    };
    const beforeUnavailable = await storage();
    const hiddenFunds = unavailable("Hidden funds, which is hidden in Wealthfolio");
    const oldFunds = unavailable("Old funds, which is archived in Wealthfolio");
    await saveChoices([[accountKeys[1], "hidden-1"], [testbridgeKey, "gone-1"], [folioBankKeys[0], "archived-2"], [folioBankKeys[1], "hidden-1"], [bankKey, "bank-1"]]);
    await readAgain();
    await rowOf(fictiva).getByText(hiddenFunds, { exact: true }).waitFor();
    await rowOf(testbridge).getByText(missing, { exact: true }).waitFor();
    await rowOf(bankFolios[0]).getByText(oldFunds, { exact: true }).waitFor();
    await rowOf(bankFolios[1]).getByText(hiddenFunds, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 4);
    for (const select of [fictiva, testbridge, ...bankFolios]) assert.match(await select.textContent(), /Choose an account/);
    assert.match(await panAccount.textContent(), /Mutual funds/);
    assert.match(await bankChoice.textContent(), /Savings/);
    assert.equal(await previewButton.isDisabled(), true);
    await fictiva.click();
    await frame.getByRole("option", { name: "Same as PAN (Mutual funds)" }).waitFor();
    assert.equal(await frame.getByRole("option", { name: /^(Hidden|Old) (funds|demat) / }).count(), 0);
    await frame.getByRole("option", { name: "Same as PAN (Mutual funds)" }).click();
    await pick(testbridge, "Not set (INR)");
    assert.equal(await previewButton.isDisabled(), true, "the folios' bank accounts need choosing again");
    await pick(bankFolios[0], "Outside Wealthfolio");
    assert.equal(await previewButton.isDisabled(), true, "so does the other folio's, even to go with the PAN");
    await pick(bankFolios[1], "Same as PAN (Savings)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await previewButton.isDisabled(), false);
    // Each folio's rows go to the accounts chosen now: Fictiva's with deposits and withdrawals in
    // Mutual funds, Testbridge's in Not set, with transfers from and to Savings.
    const beforeImport = await tab.frames()[1].evaluate(() =>
      ({ activities: window.host.activities, failHistory: window.host.failHistory, rejectLine: window.host.rejectLine }));
    await tab.frames()[1].evaluate(() => {
      window.host.activities = [];
      window.host.failHistory = false;
      window.host.rejectLine = undefined;
    });
    await previewButton.click();
    await frame.getByRole("button", { name: /^Import \d+ activities$/ }).click();
    await frame.getByText(/^Imported (\d+) of \1 activities/).waitFor();
    const routed = await tab.frames()[1].evaluate(() => window.host.activities.map((a) => [a.accountId, a.activityType, a.assetSymbol]));
    const rowCount = (accountId, type) => routed.filter(([id, t]) => id === accountId && (!type || t === type)).length;
    assert.deepEqual([...new Set(routed.map(([id]) => id))].sort(), ["account-1", "bank-1", "unset-1"]);
    for (const [id, , symbol] of routed.filter(([, , symbol]) => symbol)) {
      assert.equal(id, symbol.startsWith("INFZ90K01") ? "account-1" : "unset-1", symbol);
    }
    assert.equal(rowCount("account-1", "TRANSFER_IN") + rowCount("account-1", "TRANSFER_OUT"), 0);
    assert.ok(rowCount("account-1", "DEPOSIT") > 0 && rowCount("unset-1", "TRANSFER_IN") > 0);
    assert.deepEqual(
      [rowCount("bank-1", "TRANSFER_OUT"), rowCount("bank-1", "TRANSFER_IN"), rowCount("bank-1")],
      [rowCount("unset-1", "TRANSFER_IN"), rowCount("unset-1", "TRANSFER_OUT"), rowCount("unset-1", "TRANSFER_IN") + rowCount("unset-1", "TRANSFER_OUT")],
    );
    await tab.frames()[1].evaluate((state) => Object.assign(window.host, state), beforeImport);
    await restoreChoices(beforeUnavailable);

    // So are the PAN's own: an archived account and a missing bank account. A folio that goes with
    // them needs a choice, unless its funds are left out; folios with their own choices don't.
    await saveChoices([[accountKeys[0], "archived-2"], [bankKey, "gone-1"], [accountKeys[1], "account-1"], [folioBankKeys[0], "outside"]]);
    await readAgain();
    await rowOf(panAccount).getByText(oldFunds, { exact: true }).waitFor();
    await rowOf(bankChoice).getByText(missing, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    assert.match(await panAccount.textContent(), /Choose an account/);
    assert.match(await bankChoice.textContent(), /Choose an account/);
    for (const select of [testbridge, bankFolios[1]]) {
      assert.match(await select.textContent(), /Same as PAN/);
      assert.doesNotMatch(await select.textContent(), /\(/, "nothing is chosen for the PAN");
    }
    assert.match(await fictiva.textContent(), /Mutual funds/);
    assert.match(await bankFolios[0].textContent(), /Outside Wealthfolio/);
    assert.equal(await previewButton.isDisabled(), true);
    await pick(testbridge, "Mutual funds (INR)");
    assert.equal(await previewButton.isDisabled(), true, "the folio's bank account still goes with the PAN");
    await leaveOut(byName);
    await leaveOut(noIsin);
    assert.equal(await previewButton.isDisabled(), false);
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    await restoreChoices(beforeUnavailable);

    // A folio printed without a PAN has none to go with.
    await tab.frames()[1].evaluate(() => { window.host.noPanFolio = "1040012345"; });
    await saveChoices([[testbridgeKey, "hidden-1"], [folioBankKeys[1], "gone-1"]]);
    await readAgain();
    const noPan = frame.getByLabel("Testbridge Mutual Fund, folio 1040012345 (no PAN printed)", { exact: true });
    await rowOf(noPan).getByText(hiddenFunds, { exact: true }).waitFor();
    await rowOf(bankFolios[1]).getByText(missing, { exact: true }).waitFor();
    assert.match(await noPan.textContent(), /Choose an account/);
    assert.match(await bankFolios[1].textContent(), /Choose an account/);
    assert.equal(await previewButton.isDisabled(), true);
    await noPan.click();
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).waitFor();
    assert.equal(await frame.getByRole("option", { name: /^Same as PAN/ }).count(), 0);
    await frame.getByRole("option", { name: "Mutual funds (INR)" }).click();
    assert.equal(await previewButton.isDisabled(), true);
    await pick(bankFolios[1], "Outside Wealthfolio");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await previewButton.isDisabled(), false);
    await tab.frames()[1].evaluate(() => { window.host.noPanFolio = ""; });
    await restoreChoices(beforeUnavailable);

    // Each read loads the accounts again, as Wealthfolio keeps the add-on's page loaded while they
    // change. With none left that tracks transactions, the card says to add one and read again, and
    // the next read offers it.
    const beforeAccounts = await accountList();
    await saveChoices([[accountKeys[0], "account-1"], [testbridgeKey, "unset-1"], [bankKey, "bank-1"]]);
    await editAccounts({ "account-1": { isActive: false }, "unset-1": { isArchived: true }, "bank-1": { trackingMode: "HOLDINGS" } });
    await readAgain();
    const noTransactionAccount = "No account tracks transactions. Add one in Wealthfolio, set to track transactions, then choose Read statement again.";
    await frame.getByText(noTransactionAccount, { exact: true }).waitFor();
    await rowOf(panAccount).getByText(unavailable("Mutual funds, which is hidden in Wealthfolio"), { exact: true }).waitFor();
    await rowOf(testbridge).getByText(unavailable("Not set, which is archived in Wealthfolio"), { exact: true }).waitFor();
    await rowOf(bankChoice).getByText(unavailable("Savings, which tracks holdings. Transfers imported there wouldn't change its cash"), { exact: true }).waitFor();
    assert.equal(await previewButton.isDisabled(), true);
    await editAccounts({ "new-1": { name: "New funds", trackingMode: "TRANSACTIONS" } });
    await readAgain();
    assert.equal(await frame.getByText(noTransactionAccount, { exact: true }).count(), 0);
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    await panAccount.click();
    await frame.getByRole("option", { name: "New funds (INR)", exact: true }).waitFor();
    assert.equal(await frame.getByRole("option").count(), 1);
    await frame.getByRole("option", { name: "New funds (INR)", exact: true }).click();
    await pick(testbridge, "Same as PAN (New funds)");
    await pick(bankChoice, "Outside Wealthfolio");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await previewButton.isDisabled(), false);
    await tab.frames()[1].waitForFunction((key) => !window.host.storage.has(key), bankKey);
    // Restored, they're offered again and the choices made before count.
    await setAccountList(beforeAccounts);
    await saveChoices([[accountKeys[0], "account-1"], [testbridgeKey, "unset-1"], [bankKey, "bank-1"]]);
    await readAgain();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.match(await panAccount.textContent(), /Mutual funds/);
    assert.match(await testbridge.textContent(), /Not set/);
    assert.match(await bankChoice.textContent(), /Savings/);
    await restoreChoices(beforeUnavailable);
    // When they can't be loaded, the read shows no choices, and the next read can load them.
    await tab.frames()[1].evaluate(() => { window.host.failAccounts = true; });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Couldn't load the accounts: Error: Accounts unavailable. Choose Read statement to try again.", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await frame.getByText("Accounts", { exact: true }).count(), 0);
    await tab.frames()[1].evaluate(() => { window.host.failAccounts = false; });
    await readAgain();
    assert.equal(await frame.getByText(/^Couldn't load the accounts/).count(), 0);

    // Change alone keeps the saved fund, so reading again confirms it again.
    const flexi = holding(detailed.flexi);
    const remembered = await storage();
    await flexi.getByRole("button", { name: /^Change the / }).click();
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
    await flexi.getByRole("button", { name: "Leave this fund out" }).press("Enter");
    await namedFor(flexi, () => [["button", `Choose a fund for ${detailed.flexi}`]]);
    await focused(flexi.getByRole("button", { name: "Choose a fund" }), "Leave this fund out");
    await flexi.getByRole("button", { name: "Choose a fund" }).press("Enter");
    await focused(flexi.getByRole("textbox", { name: /^Search for / }), "Choose a fund");
    await flexi.getByRole("radio").first().waitFor({ state: "attached" });
    assert.deepEqual(await storage(), forgotten);
    await flexi.getByRole("textbox", { name: /^Search for / }).fill("MULTI");
    await flexi.getByRole("textbox", { name: /^Search for / }).press("Enter");
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
    const balanced = holding(detailed.balanced);
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
    const liquid = holding(detailed.liquid);
    await liquid.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(await liquid.count(), 1);
    // Its row says where the statement lists it, as its section does.
    await liquid.getByText(`On the statement: ${detailed.liquid} · in 2 folios`, { exact: true }).waitFor();
    assert.equal(await rows.count(), 4);
    assert.equal(await frame.locator("section").count(), 1);
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
    await flexi.getByRole("button", { name: /^Change the / }).click();
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

    // A fund house's merger is one fund conversion: two lines with one status, both rows or neither.
    const beforeMerger = await tab.frames()[1].evaluate(() =>
      ({ activities: window.host.activities, failHistory: window.host.failHistory, rejectLine: window.host.rejectLine }));
    const storageBeforeMerger = await storage();
    await tab.frames()[1].evaluate(() => {
      window.host.activities = [];
      window.host.failHistory = false;
      window.host.rejectLine = undefined;
      window.host.merger = true;
    });
    await readAgain();
    await confirmFirst(["INFZ90K01FC8", "INFZ90K01OF7", "INFZ90K01NF5"]);
    await leaveOutOthers();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    const leaving = frame.getByRole("row").filter({ hasText: "fund conversion out" });
    const arriving = frame.getByRole("row").filter({ hasText: "fund conversion in" });
    await leaving.waitFor({ timeout: 30_000 });
    assert.deepEqual(await leaving.locator("td").allTextContents(), [
      "2024-08-01", "Fictiva Old Fund - Direct Plan - Growth", "fund conversion out", "99.995", "", "", "", "", "New",
    ]);
    assert.equal(await leaving.locator("td").last().getAttribute("rowspan"), "2");
    assert.deepEqual(await arriving.locator("td").allTextContents(), [
      "2024-08-01", "Fictiva New Fund - Direct Plan - Growth", "fund conversion in", "69.996", "", "", "", "",
    ]);
    await frame.getByRole("button", { name: /^Import \d+ activities$/ }).click();
    await frame.getByText(/^Imported \d+ of \d+ activities$/).waitFor();
    const conversions = await tab.frames()[1].evaluate(() =>
      window.host.activities.filter((a) => a.activityType === "ADJUSTMENT").map((a) => [a.subtype, a.symbol, a.quantity, a.sourceGroupId]),
    );
    assert.deepEqual(conversions.map((c) => c.slice(0, 3)), [["CONVERSION_OUT", "INFZ90K01OF7", "99.995"], ["CONVERSION_IN", "INFZ90K01NF5", "69.996"]]);
    assert.match(conversions[0][3], /^cas-importer-merger:[0-9a-f]{64}$/);
    assert.equal(conversions[1][3], conversions[0][3]);
    const mergerUnits = frame.locator("table").last().locator("tbody tr");
    for (const name of ["Fictiva Old Fund", "Fictiva New Fund"]) {
      assert.equal(await mergerUnits.filter({ hasText: name }).filter({ hasText: "Match" }).count(), 1, name);
    }
    // Read again, it's in Wealthfolio, and can't be imported twice.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await leaving.getByText("Already in Wealthfolio", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await leaving.getByText("Import anyway").count(), 0);
    // Moving the conversion to an unselected account keeps its group and blocks a second import.
    await tab.frames()[1].evaluate(() => {
      for (const a of window.host.activities) if (a.subtype?.startsWith("CONVERSION_")) a.accountId = "elsewhere";
    });
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await leaving.getByText(/^Wealthfolio has this conversion from an earlier import, changed since/).waitFor({ timeout: 30_000 });
    assert.equal(await leaving.getByText("Import anyway").count(), 0);
    assert.ok(await frame.getByRole("button", { name: "Import 0 activities", exact: true }).isDisabled());
    await tab.frames()[1].evaluate((before) => Object.assign(window.host, before, { merger: false }), beforeMerger);
    await restoreChoices(storageBeforeMerger);
    await undecided(flexi);

    // A gift from a folio the statement doesn't include is an external transfer in. A gift between two
    // of its folios, in two accounts, is a transfer out and in: two lines with one status, which
    // Wealthfolio links. Neither has cash.
    const beforeGifts = await tab.frames()[1].evaluate(() =>
      ({ activities: window.host.activities, failHistory: window.host.failHistory, rejectLine: window.host.rejectLine }));
    const storageBeforeGifts = await storage();
    await tab.frames()[1].evaluate(() => {
      window.host.activities = [];
      window.host.failHistory = false;
      window.host.rejectLine = undefined;
      window.host.gifts = true;
    });
    await readAgain();
    await confirmFirst(["INFZ90K01GF3", "INFZ90K01SF6"]);
    await leaveOutOthers();
    // In one account the units don't move, so neither side goes in.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    const sameAccount = "Both sides of this gift go to the same Wealthfolio account, so its units stay there and neither side is imported.";
    await frame.getByText(new RegExp(`folio 92345678, 2024-06-03 Gifting of units-TO Folio No: 93456789: ${sameAccount}`)).waitFor({ timeout: 30_000 });
    assert.equal(await frame.getByText(new RegExp(`folio 93456789, 2024-06-03 Gifting of units - From Folio No.92345678: ${sameAccount}`)).count(), 1);
    await pick(frame.getByLabel("Fictiva Mutual Fund, folio 93456789", { exact: true }), "Not set (INR)");
    await frame.getByRole("button", { name: "Preview the import" }).click();
    // Purchases' cash can be a transfer too: go by the Activity column.
    const activityRow = (fund, activity) => frame.getByRole("row").filter({ hasText: fund })
      .filter({ has: frame.locator("td:nth-child(3)", { hasText: new RegExp(`^${activity}$`) }) });
    const received = activityRow("Fictiva Gifted Fund", "transfer in");
    const given = activityRow("Fictiva Shared Fund", "transfer out");
    const taken = activityRow("Fictiva Shared Fund", "transfer in");
    await given.waitFor({ timeout: 30_000 });
    const cells = async (row) => (await row.locator("td").allTextContents()).map((text) => text.trim());
    assert.deepEqual((await cells(received)).slice(0, 8), ["2024-06-04", "Fictiva Gifted Fund - Direct Plan - Growth", "transfer in", "10.000", "25.0000", "", "", ""]);
    assert.match((await cells(received))[8], /^NewImported at NAV 25\.0000, the units' value on the day of the gift/);
    assert.deepEqual((await cells(given)).slice(0, 8), ["2024-06-03", "Fictiva Shared Fund - Direct Plan - Growth", "transfer out", "20.000", "25.0000", "", "", ""]);
    assert.match((await cells(given))[8], /^NewA gift to folio 93456789: Wealthfolio links this transfer out with that folio's transfer in/);
    assert.equal(await given.locator("td").last().getAttribute("rowspan"), "2");
    assert.deepEqual(await cells(taken), ["2024-06-03", "Fictiva Shared Fund - Direct Plan - Growth", "transfer in", "20.000", "25.0000", "", "", ""]);
    await frame.getByRole("button", { name: /^Import \d+ activities$/ }).click();
    await frame.getByText(/^Imported \d+ of \d+ activities$/).waitFor();
    const transfers = await tab.frames()[1].evaluate(() =>
      window.host.activities.filter((a) => a.assetSymbol && a.activityType.startsWith("TRANSFER_"))
        .map((a) => [a.accountId, a.activityType, a.assetSymbol, a.quantity, a.unitPrice, a.amount ?? null, a.isExternal ?? null]),
    );
    assert.deepEqual(transfers, [
      ["account-1", "TRANSFER_IN", "INFZ90K01GF3", "10.000", "25.0000", null, true],
      ["account-1", "TRANSFER_OUT", "INFZ90K01SF6", "20.000", "25.0000", null, null],
      ["unset-1", "TRANSFER_IN", "INFZ90K01SF6", "20.000", "25.0000", null, null],
    ]);
    const giftUnits = frame.locator("table").last().locator("tbody tr");
    assert.equal(await giftUnits.filter({ hasText: "Fictiva Gifted Fund" }).filter({ hasText: "Match" }).count(), 1);
    assert.equal(await giftUnits.filter({ hasText: "Fictiva Shared Fund" }).filter({ hasText: "Match" }).count(), 2);
    // Read again, both are in Wealthfolio.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await received.getByText("Already in Wealthfolio", { exact: true }).waitFor({ timeout: 30_000 });
    await given.getByText("Already in Wealthfolio", { exact: true }).waitFor();
    await tab.frames()[1].evaluate((before) => Object.assign(window.host, before, { gifts: false }), beforeGifts);
    await restoreChoices(storageBeforeGifts);
    await undecided(flexi);

    // A segregated portfolio's units are a purchase at a stand-in ₹0, marked as such, with no cash.
    const beforeSegregated = await tab.frames()[1].evaluate(() =>
      ({ activities: window.host.activities, failHistory: window.host.failHistory, rejectLine: window.host.rejectLine }));
    const storageBeforeSegregated = await storage();
    await tab.frames()[1].evaluate(() => {
      window.host.activities = [];
      window.host.failHistory = false;
      window.host.rejectLine = undefined;
      window.host.segregated = true;
    });
    await readAgain();
    await confirmFirst(["INFZ90K01CR3", "INFZ90K01S17"]);
    await leaveOutOthers();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    const segregatedRows = frame.getByRole("row").filter({ hasText: "Fictiva Credit Risk Fund - Segregated Portfolio 1" });
    await segregatedRows.first().waitFor({ timeout: 30_000 });
    const credits = segregatedRows.filter({ has: frame.locator("td:nth-child(3)", { hasText: /^purchase$/ }) });
    const payouts = segregatedRows.filter({ has: frame.locator("td:nth-child(3)", { hasText: /^sale$/ }) });
    assert.equal(await credits.count(), 2);
    for (const [i, quantity] of ["3067.468", "0.013"].entries()) {
      const creditCells = (await credits.nth(i).locator("td").allTextContents()).map((text) => text.trim());
      assert.deepEqual(creditCells.slice(0, 8), [
        "2024-02-16", "Fictiva Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth", "purchase", quantity, "", "", "0stand-in", "",
      ]);
      assert.match(creditCells[8], /^NewUnits credited in a segregated portfolio, imported at a stand-in cost of ₹0 with no cash\./);
    }
    // The payout is an ordinary redemption, at the segregated portfolio's NAV, with its cash.
    const payout = (await payouts.locator("td").allTextContents()).map((text) => text.trim());
    assert.deepEqual(payout.slice(0, 7), ["2024-09-20", "Fictiva Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth", "sale", "1533.741", "0.6000", "", "920.2446"]);
    await frame.getByRole("button", { name: /^Import \d+ activities$/ }).click();
    await frame.getByText(/^Imported \d+ of \d+ activities$/).waitFor();
    const segregatedSent = await tab.frames()[1].evaluate(() =>
      window.host.activities.filter((a) => a.assetSymbol === "INFZ90K01S17" && a.activityType === "BUY")
        .map((a) => [a.quantity, a.unitPrice ?? null, a.amount]),
    );
    assert.deepEqual(segregatedSent, [["3067.468", null, "0"], ["0.013", null, "0"]]);
    const segregatedUnits = frame.locator("table").last().locator("tbody tr");
    assert.equal(await segregatedUnits.filter({ hasText: "Segregated Portfolio 1" }).filter({ hasText: "Match" }).count(), 1);
    // Read again, the credits are in Wealthfolio.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await credits.first().getByText("Already in Wealthfolio", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await credits.getByText("Already in Wealthfolio", { exact: true }).count(), 2);
    // A later statement lists only the payout: with the units in Wealthfolio before it starts, the
    // payout is a sale, with the caveat on its gain.
    await tab.frames()[1].evaluate(() => {
      window.host.segregated = "later";
      const all = window.host.activities;
      const sold = all.filter((a) => a.assetSymbol === "INFZ90K01S17" && a.activityType === "SELL");
      const cash = all.filter((a) => !a.assetSymbol && sold.some((s) => s.date === a.date && s.amount === a.amount));
      window.host.activities = all.filter((a) => !sold.includes(a) && !cash.includes(a)).map((a) =>
        (a.assetSymbol === "INFZ90K01S17" ? { ...a, date: "2023-03-01T00:00:00+00:00" } : a));
    });
    await readAgain();
    await leaveOutOthers();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await payouts.getByText("New", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await credits.count(), 0);
    assert.match((await payouts.locator("td").last().textContent()).trim(), /^NewA payout from a segregated portfolio: Wealthfolio counts its gain against the cost it has for these units/);
    await tab.frames()[1].evaluate((before) => Object.assign(window.host, before, { segregated: false }), beforeSegregated);
    await restoreChoices(storageBeforeSegregated);
    await undecided(flexi);

    // With AMFI off, the banner asks to add it, and the Funds card says nothing more about AMFI,
    // though no fund's search finds AMFI's scheme. Once it's added, a fund whose ISIN finds exactly one
    // AMFI result, in rupees, with no plan or option that differs from the statement's, is confirmed
    // without a click and saved as Use this fund saves it. Funds confirmed before keep their choice,
    // unsearched. Funds that still need a choice come first, each in its section; the confirmed ones
    // follow, a row each, and the card says once how many were matched.
    const beforeAmfi = await tab.frames()[1].evaluate(() => ({
      activities: window.host.activities, assets: window.host.assets, storage: [...window.host.storage], searches: window.host.searches,
      failHistory: window.host.failHistory, rejectLine: window.host.rejectLine, skipLine: window.host.skipLine,
    }));
    const rememberedBefore = await storage();
    await tab.frames()[1].evaluate(() => {
      window.host.providers = "";
      window.host.activities = [];
      window.host.failHistory = false;
      window.host.rejectLine = undefined;
      window.host.skipLine = undefined;
      window.host.searches = [];
      // Wealthfolio has the Flexi Cap fund, priced from Yahoo.
      window.host.assets["yahoo-flexi"] = { symbol: "INFZ90K01FC8", exchangeMic: "XBOM", instrumentType: "EQUITY", name: "Yahoo Flexi Cap" };
    });
    await revisit();
    await amfiBanner.waitFor();
    await readAgain();
    const savedFund = (key) => tab.frames()[1].evaluate((key) => JSON.parse(window.host.storage.get(key) ?? "null"), key);
    const liquidRow = holding(detailed.liquid);
    const liquidResults = liquidRow.getByRole("radio");
    // Whether Liquid's AMFI result, AMFI's scheme or the asset an import created from it, is preselected.
    const amfiPicked = async () => (await liquidRow.locator("label").filter({ hasText: /AMFI$/ }).getByRole("radio").getAttribute("aria-checked")) === "true";
    // AMFI's scheme's name, as a confirmed row shows it.
    const amfiLabel = /^Scheme \d{6}$/;
    const matched = frame.getByText(/^\d+ funds? matched from AMFI by (its|their) ISIN\./);
    const matchedOne = "1 fund matched from AMFI by its ISIN. Change it if it looks wrong.";
    for (const section of [liquidRow, flexi, noIsin]) await section.getByRole("radio").first().waitFor({ state: "attached" });
    await noAmfiNote();
    assert.equal(await liquidResults.count(), 1);
    assert.equal(await matched.count(), 0);
    await flexi.getByRole("textbox", { name: /^Search for / }).fill("MULTI");
    // Once AMFI is added, Check again finds it on and the banner goes. In the same page, with the
    // statement still read and every choice kept, the funds that have no choice yet are searched again
    // as when first shown, and now find AMFI's scheme too. Liquid's ISIN finds Yahoo's result and then
    // AMFI's, its only AMFI result, so it's confirmed without a click. Flexi Cap isn't: its search box
    // has had the focus, and Wealthfolio has it priced from Yahoo. Funds confirmed before aren't searched.
    const statementSummary = await frame.getByText(/ detailed statement for /).elementHandle();
    const confirmedBefore = await confirmed();
    await tab.frames()[1].evaluate(() => {
      window.host.amfi = true;
      window.host.searches = [];
    });
    await checkAgain.press("Enter");
    await amfiBanner.waitFor({ state: "detached" });
    await focused(fileInput, "Check again, AMFI added");
    assert.equal(await amfiOutcome.textContent(), "AMFI is on.");
    await matched.waitFor();
    assert.equal(await matched.textContent(), matchedOne);
    assert.equal(await matched.getAttribute("aria-live"), "polite");
    await focused(fileInput, "a fund matched after Check again");
    assert.equal(await statementSummary.evaluate((p) => p.isConnected), true, "the same page");
    assert.equal(await confirmed(), confirmedBefore + 1);
    assert.equal(await flexi.getByRole("textbox", { name: /^Search for / }).inputValue(), "INFZ90K01FC8");
    await noIsin.getByRole("radio").first().waitFor({ state: "attached" });
    assert.deepEqual((await hosted(() => window.host.searches)).sort(), ["INFZ90K01FC8", "INFZ90K01LQ6", "Testbridge Overnight"]);
    // The fund printed without an ISIN finds no AMFI result, which AMFI's search never gives for a
    // name, and with AMFI on, the card doesn't recommend it either.
    await noAmfiNote();
    await liquidRow.getByText(amfiLabel).waitFor();
    await liquidRow.getByText("AMFI", { exact: true }).waitFor();
    assert.match(await liquidRow.locator("details p").textContent(), /^Symbol \d{6} · Type MUTUALFUND · Currency INR$/);
    assert.equal(await liquidRow.evaluate((row) => row.tagName), "LI");
    assert.deepEqual(await choiceBadges(liquidRow), ["Confirmed success-subtle"]);
    // AMFI's name isn't the statement's here, so the row gives that too.
    assert.equal(await liquidRow.getByText(`On the statement: ${detailed.liquid}`, { exact: true }).count(), 1);
    const amfiFund = await savedFund("isin:INFZ90K01LQ6");
    assert.deepEqual(
      [amfiFund.providerId, amfiFund.exchangeMic, amfiFund.providerSymbol, amfiFund.instrumentType, amfiFund.quoteCcy],
      ["AMFI", undefined, amfiFund.symbol, "MUTUALFUND", "INR"],
    );
    // Flexi Cap and Overnight still need a choice, so their sections come first. The rows follow in
    // the statement's order.
    assert.deepEqual(await frame.locator("section h3").allTextContents(), [detailed.flexi, detailed.overnight]);
    assert.deepEqual(
      await rows.evaluateAll((all) => all.map((row) => row.querySelector("button").textContent)),
      [detailed.liquid, detailed.balanced, detailed.corporate].map((name) => `Change the fund for ${name}`),
    );
    assert.ok(await rows.first().evaluate((row) =>
      [...document.querySelectorAll("section")].every((section) => section.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)));
    // Change opens the fund's search again. It doesn't confirm the fund by itself, though AMFI's
    // result is still the only AMFI result for the ISIN: it's preselected, the focus stays in the search, and
    // the fund no longer counts as matched.
    await liquidRow.getByRole("button", { name: /^Change the / }).press("Enter");
    const liquidSearch = liquidRow.getByRole("textbox", { name: /^Search for / });
    await focused(liquidSearch, "Change on a fund matched from AMFI");
    await liquidResults.nth(1).waitFor({ state: "attached" });
    assert.ok(await amfiPicked(), "AMFI's result is preselected");
    await focused(liquidSearch, "Change, once its search is done");
    assert.equal(await liquidRow.getByText("Confirmed", { exact: true }).count(), 0);
    await matched.waitFor({ state: "detached" });
    assert.deepEqual(await savedFund("isin:INFZ90K01LQ6"), amfiFund, "Change alone keeps the saved fund");
    // Another result can be confirmed instead, then AMFI's again, by hand.
    await liquidResults.first().dispatchEvent("click");
    await liquidRow.getByRole("button", { name: "Use this fund", disabled: false }).press("Enter");
    await focused(liquidRow.getByRole("button", { name: /^Change the / }), "Use this fund after Change");
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ90K01LQ6")).providerId === "FAKE");
    await liquidRow.getByRole("button", { name: /^Change the / }).click();
    await liquidResults.nth(1).waitFor({ state: "attached" });
    await liquidRow.getByRole("button", { name: "Use this fund", disabled: false }).click();
    await liquidRow.getByText(amfiLabel).waitFor();
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ90K01LQ6")).providerId === "AMFI");
    assert.deepEqual(await savedFund("isin:INFZ90K01LQ6"), amfiFund);
    assert.equal(await matched.count(), 0, "a fund confirmed by hand isn't counted");
    // Picking AMFI's result for a fund Wealthfolio has priced from another source would add a second
    // asset, so it isn't confirmed or preselected, and the card says how to switch the asset to AMFI instead.
    await undecided(flexi);
    await flexi.getByText(/^Wealthfolio already has this fund, priced from another source, and picking AMFI's result adds a second asset for it\./).waitFor();
    assert.equal(await flexi.getByRole("button", { name: "Use this fund" }).isDisabled(), true);
    await flexi.getByRole("radio").first().dispatchEvent("click");
    await flexi.getByRole("button", { name: "Use this fund" }).click();
    await flexi.getByText("Yahoo Flexi Cap").waitFor();
    // When Wealthfolio doesn't say whether AMFI is on, the card's note is back: AMFI doesn't search
    // names, so the note stays while the fund printed without an ISIN is the only one open, and goes
    // once it's left out. Choosing a fund for it again searches again.
    await undecided(noIsin);
    await noAmfiNote();
    await hosted(() => { window.host.providers = "fail"; });
    await revisit();
    await amfiNoteShown();
    // A mounted search stops qualifying while it runs, and for a different query's results.
    const overnightSearch = noIsin.getByRole("textbox", { name: /^Search for / });
    await pause("market");
    await overnightSearch.fill("MULTI");
    await overnightSearch.press("Enter");
    await waiting();
    await noAmfiNote();
    await resume();
    await noIsin.getByRole("radio").nth(1).waitFor({ state: "attached" });
    await noAmfiNote();
    await overnightSearch.fill("Testbridge Overnight");
    await overnightSearch.press("Enter");
    await amfiNoteShown();
    await noIsin.getByRole("button", { name: "Leave this fund out" }).click();
    await noIsin.getByText("Left out", { exact: true }).waitFor();
    await noAmfiNote();
    await noIsin.getByRole("button", { name: "Choose a fund" }).click();
    await amfiNoteShown();
    await noIsin.getByRole("radio").first().dispatchEvent("click");
    await noIsin.getByRole("button", { name: "Use this fund" }).click();
    await noAmfiNote();
    assert.equal(await confirmed(), 5);
    const amfiSearches = await tab.frames()[1].evaluate(() => window.host.searches);
    assert.ok(!amfiSearches.some((query) => /INFZ90K01BA1|INFZ91T01CB6/.test(query)), amfiSearches.join(" "));
    for (const key of ["isin:INFZ90K01BA1", "isin:INFZ91T01CB6"]) assert.equal((await storage())[key], rememberedBefore[key], key);
    // Wealthfolio's checkImport accepts a new fund chosen from AMFI without an exchange, and its
    // import creates the fund priced from AMFI.
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^\d+ new transactions, 0 already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import\./).waitFor({ timeout: 30_000 });
    await frame.getByRole("button", { name: /^Import \d+ activities$/ }).click();
    await frame.getByText(/^Imported (\d+) of \1 activities/).waitFor();
    assert.ok(await tab.frames()[1].evaluate((code) => window.host.activities.some((a) => a.assetSymbol === code), amfiFund.symbol));
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, \d+ already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import\./).waitFor({ timeout: 30_000 });
    // Searching the ISIN again resolves AMFI's scheme code to the asset the import created, which the
    // search finds by an identifier, so a read without the saved choice confirms it without a click.
    const forget = (...keys) => tab.frames()[1].evaluate((keys) => { for (const key of keys) window.host.storage.delete(key); }, keys);
    await forget("isin:INFZ90K01LQ6");
    await readAgain();
    await liquidRow.getByText("Confirmed", { exact: true }).waitFor();
    await liquidRow.getByText("AMFI", { exact: true }).waitFor();
    assert.match(await liquidRow.locator("details p").textContent(), / · Type EQUITY · Currency INR$/);
    await frame.getByText(matchedOne, { exact: true }).waitFor();
    const existingAmfi = await savedFund("isin:INFZ90K01LQ6");
    assert.ok(existingAmfi.assetId);
    assert.equal(existingAmfi.providerSymbol, undefined);
    // Its search lists it first, beside Yahoo's listing.
    await liquidRow.getByRole("button", { name: /^Change the / }).click();
    await liquidResults.nth(1).waitFor({ state: "attached" });
    await noAmfiNote();
    assert.equal(await liquidResults.count(), 2);
    assert.match(await liquidRow.locator("label").first().textContent(), /AMFI$/);
    assert.match((await resultCodes(liquidRow))[0], / · Type EQUITY · Currency INR$/);
    assert.equal(await liquidResults.first().getAttribute("aria-checked"), "true");
    await liquidRow.getByRole("button", { name: "Use this fund" }).click();
    await liquidRow.getByText("Confirmed", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Preview the import" }).click();
    await frame.getByText(/^0 new transactions, \d+ already in Wealthfolio, 0 possible duplicates and 0 Wealthfolio can't import\./).waitFor({ timeout: 30_000 });

    // Reads the statement while the search for this query waits.
    const readPaused = async (query) => {
      await pause(query);
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await tab.frames()[1].waitForFunction(() => window.host.resume, null, { timeout: 180_000 });
      await frame.getByText("Accounts", { exact: true }).waitFor({ timeout: 180_000 });
    };
    // An answer that arrives once the fund is left out doesn't confirm it, nor does it confirm the
    // search that Choose a fund starts again.
    await forget("isin:INFZ90K01LQ6");
    await readPaused("INFZ90K01LQ6");
    await liquidRow.getByRole("button", { name: "Leave this fund out" }).click();
    await liquidRow.getByText("Left out", { exact: true }).waitFor();
    await liquidRow.getByRole("button", { name: "Choose a fund" }).click();
    await resume();
    await liquidResults.nth(1).waitFor({ state: "attached" });
    await tab.frames()[1].evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await amfiPicked());
    assert.equal(await liquidRow.getByText("Confirmed", { exact: true }).count(), 0);
    assert.equal(await savedFund("isin:INFZ90K01LQ6"), null);
    assert.equal(await matched.count(), 0);
    // An answer that arrives while the focus is in the fund's section doesn't take the section away.
    await readPaused("INFZ90K01LQ6");
    await liquidSearch.focus();
    await resume();
    await liquidResults.nth(1).waitFor({ state: "attached" });
    await tab.frames()[1].evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await amfiPicked());
    assert.equal(await liquidRow.getByText("Confirmed", { exact: true }).count(), 0);
    await focused(liquidSearch, "a fund's answer while the focus is in its section");
    assert.equal(await matched.count(), 0);
    // One that arrives while the focus is on another fund confirms it, and the focus stays where it is
    // as the fund moves to the rows.
    await readPaused("INFZ90K01LQ6");
    const corporateChange = holding(detailed.corporate).getByRole("button", { name: /^Change the / });
    await corporateChange.focus();
    await resume();
    await liquidRow.getByText("Confirmed", { exact: true }).waitFor();
    await focused(corporateChange, "a fund matched while the focus is on another");
    await frame.getByText(matchedOne, { exact: true }).waitFor();
    // The card says how many once every search that can confirm a fund is done, so it's read out once.
    await forget("isin:INFZ90K01LQ6", "isin:INFZ90K01BA1");
    await readPaused("INFZ90K01BA1");
    await liquidRow.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(await matched.count(), 0);
    await resume();
    await holding(detailed.balanced).getByText("Confirmed", { exact: true }).waitFor();
    await frame.getByText("2 funds matched from AMFI by their ISIN. Change any that look wrong.", { exact: true }).waitFor();
    assert.equal(await matched.count(), 1);
    // Leaving one out takes it out of the count.
    await leaveOut(holding(detailed.balanced));
    await frame.getByText(matchedOne, { exact: true }).waitFor();

    // Not confirmed: AMFI's scheme quoted in dollars or with no currency, AMFI's name on another plan,
    // and two AMFI schemes for one ISIN. Each is listed, and preselected when it's the only AMFI result.
    await forget("isin:INFZ90K01FC8", "isin:INFZ90K01LQ6", "isin:INFZ90K01BA1", "isin:INFZ91T01CB6");
    await tab.frames()[1].evaluate(() => {
      const { listing, scheme } = window.host.make;
      window.host.answers = {
        INFZ90K01FC8: [listing("INFZ90K01FC8"), { ...scheme("INFZ90K01FC8"), currency: "USD" }],
        INFZ90K01LQ6: [{ ...scheme("INFZ90K01LQ6"), currency: undefined }],
        INFZ90K01BA1: [listing("INFZ90K01BA1"), { ...scheme("INFZ90K01BA1"), longName: "Fictiva Balanced Advantage Fund - Regular Plan - IDCW Reinvestment" }],
        INFZ91T01CB6: [scheme("INFZ91T01CB6"), { ...scheme("INFZ91T01CB6"), symbol: "199999", canonicalSymbol: "199999", providerSymbol: "199999" }],
      };
    });
    await readAgain();
    for (const [name, preselect] of [[detailed.flexi, 1], [detailed.liquid, 0], [detailed.balanced, 1], [detailed.corporate, undefined]]) {
      const section = holding(name);
      await section.getByRole("radio").nth(preselect ?? 1).waitFor({ state: "attached" });
      await undecided(section);
      const checked = await section.getByRole("radio").evaluateAll((all) => all.map((radio) => radio.getAttribute("aria-checked") === "true"));
      assert.deepEqual(checked.flatMap((on, i) => (on ? [i] : [])), preselect === undefined ? [] : [preselect], name);
    }
    assert.deepEqual(await resultBadges(holding(detailed.balanced)), [[], ["Regular warning-subtle", "IDCW secondary"]]);
    assert.equal(await matched.count(), 0);

    // With AMFI off, a saved asset priced from AMFI that the search finds by an identifier, here AMFI
    // mapped to the ISIN, is still confirmed: Wealthfolio searches its assets either way. Not one it
    // finds because its name has the ISIN, Yahoo's listing alone, or AMFI's scheme in the results of
    // the name searched when the ISIN finds nothing.
    await tab.frames()[1].evaluate(() => {
      window.host.amfi = false;
      window.host.answers = { "Testbridge Corporate Bond": [window.host.make.scheme("INFZ91T01CB6")] };
      delete window.host.assets["yahoo-flexi"];
      window.host.assets["amfi-flexi"] = {
        symbol: "100123", exchangeMic: null, instrumentType: "EQUITY", name: "Fictiva Flexi Cap Fund - Direct Plan - Growth", providerId: "AMFI", aliases: ["INFZ90K01FC8"],
      };
      window.host.assets["amfi-balanced"] = {
        symbol: "100456", exchangeMic: null, instrumentType: "EQUITY", name: "Scheme 100456, ISIN INFZ90K01BA1", providerId: "AMFI",
      };
    });
    await readAgain();
    await flexi.getByText("Confirmed", { exact: true }).waitFor();
    await frame.getByText(matchedOne, { exact: true }).waitFor();
    assert.equal(await flexi.getByText(/^On the statement: /).count(), 0, "the asset has the statement's name");
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ90K01FC8") ?? "null")?.assetId === "amfi-flexi");
    for (const name of [detailed.liquid, detailed.balanced, detailed.corporate]) {
      await holding(name).getByRole("radio").first().waitFor({ state: "attached" });
      await undecided(holding(name));
    }
    await holding(detailed.corporate).getByText(/^Nothing found for the ISIN; showing results for "Testbridge Corporate Bond"\./).waitFor();
    // Nor is a search typed in, even for the ISIN once AMFI is added.
    await tab.frames()[1].evaluate(() => { window.host.amfi = true; });
    await liquidSearch.fill("INFZ90K01LQ6");
    await liquidSearch.press("Enter");
    await liquidRow.locator("label").filter({ hasText: /AMFI$/ }).waitFor();
    assert.ok(await amfiPicked());
    await undecided(liquidRow);
    assert.equal(await confirmed(), 2);
    await tab.frames()[1].evaluate((state) => {
      window.host.amfi = false;
      window.host.answers = {};
      Object.assign(window.host, { ...state, storage: new Map(state.storage) });
    }, beforeAmfi);

    // An NSDL statement's holdings go to accounts that track holdings, as snapshots.
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
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 17 holdings.").waitFor({ timeout: 180_000 });
    await frame.getByText("casparser reported warnings", { exact: true }).waitFor();
    await frame.getByText("MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail", { exact: true }).waitFor();
    assert.equal(await frame.getByText("Left out", { exact: true }).count(), 0);
    // An older remembered choice keeps no provider, so where its prices come from is unknown.
    await holding("TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH").getByText("Unknown source", { exact: true }).waitFor();
    const choose = async (label, option) => {
      await frame.getByLabel(label).click();
      await frame.getByRole("option", { name: option }).waitFor();
      // Only active, unarchived accounts that track holdings.
      assert.equal(await frame.getByRole("option", { name: "Mutual funds (INR)" }).count(), 0);
      assert.equal(await frame.getByRole("option", { name: /^(Archived funds|Hidden demat|Old demat) / }).count(), 0);
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
    // 16 holdings: three confirmed before, the Index fund, Balanced Advantage and Corporate Bond funds, in rows.
    assert.equal(await frame.locator("section").count(), 13);
    assert.deepEqual(
      await rows.evaluateAll((all) => all.map((row) => row.querySelector("button").textContent)),
      ["TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH", detailed.balanced, detailed.corporate].map((name) => `Change the fund for ${name}`),
    );
    // The Holdings card recommends AMFI the same way while a fund's search finds no AMFI result.
    const holdingsIntro = /^Confirm the Wealthfolio asset for each holding\./;
    await amfiNoteShown(holdingsIntro);
    // Only funds have plan and option badges, beside their names and results. A bond's results have
    // none, even when their names give a plan and option.
    const headings = await frame.locator("section h3").evaluateAll((all) => all.map((h) =>
      [h.textContent, [...h.parentElement.querySelectorAll("[data-slot=badge]")].map((b) => `${b.textContent} ${b.dataset.variant}`)]));
    assert.deepEqual(headings.filter(([, b]) => b.length), [
      ["Fictiva Flexi Cap Fund - Direct Plan - Growth", ["Direct secondary", "Growth secondary"]],
      ["Fictiva Liquid Fund - Direct Plan - Growth", ["Direct secondary", "Growth secondary"]],
    ]);
    const bondSection = holding("FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31");
    const bondSearch = bondSection.getByRole("textbox", { name: /^Search for / });
    await bondSearch.fill("Fictiva Flexi Cap");
    await bondSearch.press("Enter");
    await bondSection.getByRole("radio").nth(4).waitFor({ state: "attached" });
    await namedFor(bondSection, (bond) => [
      ["textbox", `Search for ${bond}`],
      ["radiogroup", `Search results for ${bond}`],
      ["button", `Use this bond for ${bond}`],
      ["button", `Use the statement's prices for ${bond}`],
      ["button", `Leave this bond out for ${bond}`],
    ]);
    assert.deepEqual(await badges(bondSection), []);
    await bondSection.getByRole("radio").nth(1).dispatchEvent("click");
    await bondSection.getByRole("button", { name: "Use this bond" }).click();
    await bondSection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(bondSection), ["Confirmed success-subtle"]);
    await namedFor(bondSection, () => [["button", "Change the bond for FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31"]]);
    await bondSection.getByRole("button", { name: /^Change the / }).click();
    await bondSearch.fill("INEZ91A07012");
    await bondSearch.press("Enter");
    await bondSection.getByText(/^Nothing found for the ISIN or for ".*"\. Try another name or a ticker, or use the statement's prices\.$/).waitFor();
    assert.equal(await outcome(bondSection).getAttribute("aria-live"), "polite");
    assert.match(await outcome(bondSection).textContent(), /^Nothing found for the ISIN or for ".*"\. Try another name or a ticker, or use the statement's prices\.$/);
    // Each holding chosen for leaves the sections for the rows.
    for (let open = await frame.locator("section").count(); open > 0; open--) {
      const section = frame.locator("section").first();
      const item = holding(await section.locator("h3").textContent());
      if (await section.getByText("PLACEHOLDER PHARMA LIMITED").count()) {
        await section.getByRole("button", { name: "Leave this share out" }).click();
        await item.getByText("Left out", { exact: true }).waitFor();
        continue;
      }
      const use = section.getByRole("button", { name: /^Use this (fund|share|bond) for / });
      const nothing = section.getByText(/^Nothing found for the ISIN or for ".*"\. Try another name or a ticker, or use the statement's prices\.$/);
      await section.getByRole("radio").first().or(nothing).first().waitFor();
      // Bonds the search can't find use the statement's prices; the one it finds is used as found.
      if (await nothing.count()) {
        await section.getByRole("button", { name: "Use the statement's prices" }).press("Enter");
        await focused(item.getByRole("button", { name: /^Change the / }), "Use the statement's prices on the Holdings card");
      } else {
        if (await use.isDisabled()) await section.getByRole("radio").first().click();
        await use.click();
      }
      await item.getByText("Confirmed", { exact: true }).waitFor();
    }
    await noAmfiNote();
    // Leaving out the only qualifying Holdings fund removes the note too; restore its choice after.
    // With the keyboard, each control's replacement in the holding's section takes the focus.
    const holdingsFund = holding("FICTIVA NIFTY 50 ETF");
    await holdingsFund.getByRole("button", { name: /^Change the / }).press("Enter");
    await focused(holdingsFund.getByRole("textbox", { name: /^Search for / }), "Change on the Holdings card");
    await amfiNoteShown(holdingsIntro);
    await holdingsFund.getByRole("button", { name: "Leave this fund out" }).press("Enter");
    await holdingsFund.getByText("Left out", { exact: true }).waitFor();
    await focused(holdingsFund.getByRole("button", { name: "Choose a fund" }), "Leave this fund out on the Holdings card");
    await noAmfiNote();
    await holdingsFund.getByRole("button", { name: "Choose a fund" }).press("Enter");
    await focused(holdingsFund.getByRole("textbox", { name: /^Search for / }), "Choose a fund on the Holdings card");
    await amfiNoteShown(holdingsIntro);
    await holdingsFund.getByRole("button", { name: "Use this fund", disabled: false }).press("Enter");
    await holdingsFund.getByText("Confirmed", { exact: true }).waitFor();
    await focused(holdingsFund.getByRole("button", { name: /^Change the / }), "Use this fund on the Holdings card");
    await noAmfiNote();
    await statementPriced(bondSection, "INEZ91A07012", "BOND");
    await holding("DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33").getByText("Democorp Infra 7.60% 2033").waitFor();

    // A remembered demat account that doesn't track holdings, NOT_SET included, is ignored, and its
    // row says why. It needs choosing again, even to go with the statement's account.
    const placeholder = frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" });
    const statementAccount = frame.getByLabel("All of this statement");
    const nsdlDemat = frame.getByLabel(/^NSDL Demat Account 1,/);
    const cdslDemat = frame.getByLabel(/^CDSL Demat Account 2,/);
    const otherFolio = frame.getByLabel(/^Folio 91234567\/12/);
    const sourceKeys = await Promise.all([nsdlDemat, cdslDemat, otherFolio].map((select) => select.getAttribute("id")));
    const beforeIgnored = await storage();
    await hosted(([nsdl, cdsl]) => {
      window.host.storage.set(nsdl, "account-1");
      window.host.storage.set(cdsl, "unset-1");
    }, sourceKeys);
    await readAgain();
    const notHoldings = ", which doesn't track holdings. A snapshot saved there wouldn't change its holdings, so choose again.";
    await frame.getByText(`Chosen before: Mutual funds${notHoldings}`, { exact: true }).waitFor();
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    assert.equal(await preview.isDisabled(), true);
    assert.match(await nsdlDemat.textContent(), /Choose an account/);
    assert.match(await cdslDemat.textContent(), /Choose an account/);
    assert.match(await otherFolio.textContent(), /Same as the statement \(Fund folios\)/);
    await choose(/^NSDL Demat Account 1,/, "Demat (INR)");
    assert.equal(await frame.getByText(/^Chosen before: Mutual funds/).count(), 0);
    assert.equal(await preview.isDisabled(), true, "the CDSL account's own account needs choosing again");
    await choose(/^CDSL Demat Account 2,/, "Same as the statement (Fund folios)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await preview.isDisabled(), false);
    await tab.frames()[1].waitForFunction((key) => !window.host.storage.has(key), sourceKeys[1]);
    await choose(/^CDSL Demat Account 2,/, "Demat (INR)");

    // So is a remembered account for the whole statement, which isn't needed while each folio and
    // demat account has its own account or is left out.
    await tab.frames()[1].waitForFunction(([nsdl, cdsl]) =>
      window.host.storage.get(nsdl) === "holdings-1" && window.host.storage.get(cdsl) === "holdings-1", sourceKeys);
    await hosted((key) => { window.host.storage.set(key, "unset-1"); }, statementKey);
    await readAgain();
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    assert.match(await statementAccount.textContent(), /Choose an account/);
    assert.match(await otherFolio.textContent(), /Same as the statement/);
    assert.doesNotMatch(await otherFolio.textContent(), /Fund folios/);
    assert.equal(await preview.isDisabled(), true, "the folio goes with the statement, which has no account");
    await choose(/^Folio 91234567\/12/, "Fund folios (INR)");
    assert.equal(await preview.isDisabled(), false);
    await frame.getByText(`Chosen before: Not set${notHoldings}`, { exact: true }).waitFor();
    await choose(/^Folio 91234567\/12/, "Same as the statement");
    assert.equal(await preview.isDisabled(), true);
    await choose("All of this statement", "Fund folios (INR)");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await preview.isDisabled(), false);
    await tab.frames()[1].waitForFunction(([statement, folio]) =>
      window.host.storage.get(statement) === "holdings-2" && !window.host.storage.has(folio), [statementKey, sourceKeys[2]]);
    assert.deepEqual(await storage(), beforeIgnored);

    // So are remembered accounts that are hidden, archived or no longer listed. A folio's or demat
    // account's own choice needs making again unless it's left out, and the snapshots go where chosen.
    const leftOutFolio = frame.getByLabel(/^Folio 1040012345/);
    const hiddenDemat = unavailable("Hidden demat, which is hidden in Wealthfolio");
    const oldDemat = unavailable("Old demat, which is hidden and archived in Wealthfolio");
    const beforeUnavailableHoldings = await hosted(() => JSON.stringify({
      snapshots: window.host.snapshots, saves: window.host.saves, assets: window.host.assets, quotes: window.host.quotes,
      pricingModes: window.host.pricingModes, storage: [...window.host.storage],
    }));
    await saveChoices([[sourceKeys[0], "hidden-2"], [sourceKeys[1], "archived-3"], [sourceKeys[2], "gone-1"]]);
    await readAgain();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    await rowOf(nsdlDemat).getByText(hiddenDemat, { exact: true }).waitFor();
    await rowOf(cdslDemat).getByText(oldDemat, { exact: true }).waitFor();
    await rowOf(otherFolio).getByText(missing, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    for (const select of [nsdlDemat, cdslDemat, otherFolio]) assert.match(await select.textContent(), /Choose an account/);
    assert.match(await leftOutFolio.textContent(), /Leave out/);
    assert.match(await statementAccount.textContent(), /Fund folios/);
    assert.equal(await preview.isDisabled(), true);
    await choose(/^NSDL Demat Account 1,/, "Demat (INR)");
    await choose(/^CDSL Demat Account 2,/, "Same as the statement (Fund folios)");
    assert.equal(await preview.isDisabled(), true, "the folio's own account needs choosing again");
    await choose(/^Folio 91234567\/12/, "Leave out");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.equal(await preview.isDisabled(), false);
    const depository = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const isins = (type) => depository.accounts.find((a) => a.type === type).equities
      .concat(...["mutual_funds", "bonds"].map((kind) => depository.accounts.find((a) => a.type === type)[kind])).map((h) => h.isin);
    const savesBefore = JSON.parse(beforeUnavailableHoldings).saves.length;
    const snapshotStatus = preview.locator("xpath=..").getByRole("status");
    assert.equal(await snapshotStatus.textContent(), "");
    // Fund folios' Gilt fund can't be read, so the preview fails.
    await hosted(() => { window.host.failGetProfileIds = ["asset-gilt"]; });
    await preview.press("Enter");
    await frame.getByText(/^Couldn't prepare the preview: Error: Couldn't read the Wealthfolio profile of /).waitFor();
    await focused(preview, "Preview the snapshots, failed");
    await hosted(() => { window.host.failGetProfileIds = []; });
    await pause("holdings");
    await preview.press("Enter");
    await waiting();
    await snapshotStatus.getByText("Preparing the preview…", { exact: true }).waitFor();
    assert.equal(await snapshotStatus.textContent(), "Preparing the preview…");
    await resume();
    await snapshotStatus.getByText("The preview is ready: 2 snapshots.", { exact: true }).waitFor();
    await focused(preview, "Preview the snapshots");
    await pause("snapshot");
    await frame.getByRole("button", { name: "Save 2 snapshots", disabled: false }).press("Enter");
    await waiting();
    assert.equal(await snapshotStatus.textContent(), "Saving…");
    await resume();
    await frame.getByText("Saved 2 snapshots").waitFor();
    await focused(frame.getByRole("alert").filter({ hasText: /^Saved 2 snapshots/ }), "Save 2 snapshots");
    const savedTo = await hosted(() => ({ saves: window.host.saves, snapshots: window.host.snapshots }));
    assert.deepEqual(savedTo.saves.slice(savesBefore).map((s) => [s.accountId, s.date]).sort(), [["holdings-1", "2025-03-31"], ["holdings-2", "2025-03-31"]]);
    for (const [accountId, own] of [["holdings-1", isins("NSDL Demat Account")], ["holdings-2", [...isins("CDSL Demat Account"), "GILT"]]]) {
      const symbols = savedTo.snapshots[accountId]["2025-03-31"].holdings.map((h) => h.symbol);
      assert.ok(symbols.length > 1 && symbols.every((symbol) => own.includes(symbol)), `${accountId}: ${symbols}`);
    }
    await hosted((state) => {
      const { storage, ...saved } = JSON.parse(state);
      Object.assign(window.host, saved, { storage: new Map(storage) });
    }, beforeUnavailableHoldings);
    await readAgain();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    assert.deepEqual(await storage(), beforeIgnored);

    // The statement's own ignored account is needed only by the rows that go with it.
    await saveChoices([[statementKey, "hidden-2"]]);
    await hosted((key) => { window.host.storage.delete(key); }, sourceKeys[1]);
    await readAgain();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    await rowOf(statementAccount).getByText(hiddenDemat, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 1);
    assert.match(await statementAccount.textContent(), /Choose an account/);
    for (const select of [cdslDemat, otherFolio]) {
      assert.match(await select.textContent(), /Same as the statement/);
      assert.doesNotMatch(await select.textContent(), /\(/, "nothing is chosen for the statement");
    }
    assert.equal(await preview.isDisabled(), true);
    await choose(/^CDSL Demat Account 2,/, "Demat (INR)");
    assert.equal(await preview.isDisabled(), true, "the folio still goes with the statement");
    await choose(/^Folio 91234567\/12/, "Leave out");
    assert.equal(await preview.isDisabled(), false);
    await hosted((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeIgnored);
    await readAgain();
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    assert.deepEqual(await storage(), beforeIgnored);

    // With no account left that tracks holdings, the card says to add one and read again, and still
    // says why each choice is ignored. Each read loads the accounts again, so the next one offers it.
    const readNsdl = async (text) => {
      await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
      await frame.locator("#cas-password").fill("ABCDE1234F");
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await frame.getByText(text, { exact: true }).waitFor({ timeout: 180_000 });
    };
    const beforeHidden = await accountList();
    await editAccounts({ "holdings-1": { isActive: false }, "holdings-2": { isActive: false } });
    await readNsdl("No account tracks holdings. To save snapshots, add one in Wealthfolio, set to track holdings, then choose Read statement again. The check against transactions below works without one.");
    assert.equal(await statementAccount.count(), 0);
    const card = await frame.locator("body").innerText();
    for (const [label, note] of [
      ["All of this statement", unavailable("Fund folios, which is hidden in Wealthfolio")],
      ["NSDL Demat Account 1, FICTIVA SECURITIES PRIVATE LIMITED", unavailable("Demat, which is hidden in Wealthfolio")],
      ["CDSL Demat Account 2, TESTBRIDGE BROKING LIMITED", unavailable("Demat, which is hidden in Wealthfolio")],
    ]) {
      assert.ok(card.includes(`${label}\n${note}`) || card.includes(`${label}\n\n${note}`), `${label}: ${card}`);
    }
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    assert.equal(await preview.isDisabled(), true);
    await editAccounts({ "new-2": { name: "New demat", trackingMode: "HOLDINGS" } });
    await readNsdl("Accounts");
    assert.equal(await frame.getByText(/^No account tracks holdings/).count(), 0);
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 3);
    await statementAccount.click();
    await frame.getByRole("option", { name: "New demat (INR)", exact: true }).waitFor();
    assert.equal(await frame.getByRole("option").count(), 1);
    await frame.getByRole("option", { name: "New demat (INR)", exact: true }).click();
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 2);
    await tab.frames()[1].waitForFunction((key) => window.host.storage.get(key) === "new-2", statementKey);
    // Restored, they're offered again.
    await setAccountList(beforeHidden);
    await hosted((saved) => { window.host.storage = new Map(Object.entries(saved)); }, beforeIgnored);
    await readNsdl("Accounts");
    assert.equal(await frame.getByText(/^Chosen before:/).count(), 0);
    assert.match(await statementAccount.textContent(), /Fund folios/);
    await placeholder.getByRole("button", { name: "Leave this share out" }).click();
    assert.equal(await preview.isDisabled(), false);
    assert.deepEqual(await storage(), beforeIgnored);

    // The same share in two snapshot accounts names the account on its checkbox and cost box.
    await choose(/^CDSL Demat Account 2,/, "Fund folios (INR)");
    await preview.click();
    for (const account of ["Demat", "Fund folios"]) {
      const box = frame.getByRole("checkbox", { name: `Import Fund INEZ90B01015 in ${account}`, exact: true });
      await box.waitFor({ state: "attached" });
      assert.equal(await box.count(), 1);
      assert.equal(await frame.getByRole("textbox", { name: `Total cost of Fund INEZ90B01015 in ${account}`, exact: true }).count(), 1);
    }
    await choose(/^CDSL Demat Account 2,/, "Demat (INR)");

    // On the Holdings card too, a result or a confirmed share quoted in another currency has a warning
    // badge with its currency and a line saying so, and so has its row in the snapshot preview. A result
    // in rupees, the other holdings and their rows say nothing about currency.
    const democorpShare = holding("DEMOCORP BANK LIMITED");
    const democorpSearch = democorpShare.getByRole("textbox", { name: /^Search for / });
    await democorpShare.getByRole("button", { name: /^Change the / }).click();
    await democorpSearch.fill("Democorp Bank");
    await democorpSearch.press("Enter");
    await democorpShare.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await democorpShare.locator("label").allTextContents(), usdResults);
    assert.deepEqual(await resultCodes(democorpShare), usdCodes);
    assert.deepEqual(await resultBadges(democorpShare), [["USD warning-subtle"], []]);
    assert.equal(await quotedIn(frame).count(), 1);
    await democorpShare.getByRole("radio").first().dispatchEvent("click");
    await democorpShare.getByRole("button", { name: "Use this share", disabled: false }).click();
    await democorpShare.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(democorpShare), ["Confirmed success-subtle", "USD warning-subtle"]);
    assert.equal(await democorpShare.getByText(usdCodes[0], { exact: true }).count(), 1);
    assert.equal(await democorpShare.getByText(inUsd, { exact: true }).count(), 1);
    assert.equal(await quotedIn(frame).count(), 1);
    await preview.click();
    const usdSnapshot = frame.locator("section").filter({ hasText: "Demat: snapshot of 2025-03-31" });
    await usdSnapshot.getByRole("row").filter({ hasText: "Democorp Bank ADR" }).getByText(usdRowNote, { exact: true }).waitFor();
    assert.equal(await quotedIn(frame.locator("table")).count(), 1);
    // Back to the share's own listing for the checks that follow: its ISIN's only result, preselected.
    await democorpShare.getByRole("button", { name: /^Change the / }).click();
    await democorpShare.getByRole("button", { name: "Use this share", disabled: false }).click();
    await democorpShare.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(await quotedIn(frame).count(), 0);

    // A known MANUAL asset in an inactive account gets the statement's price, even when the target starts empty.
    const priced = "Priced by hand: saving also saves the statement's price as its price on this date.";
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
    await preview.click();
    const demat = frame.locator("section").filter({ hasText: "Demat: snapshot of 2025-03-31" });
    const folios = frame.locator("section").filter({ hasText: "Fund folios: snapshot of 2025-03-31" });
    await demat.waitFor();
    await folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" }).getByText(priced, { exact: true }).waitFor();
    await hosted(() => { window.host.pricingModes.INFZ90K01LQ6 = "MARKET"; });
    await preview.click();
    await folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" }).getByText(priced, { exact: true }).waitFor({ state: "hidden" });
    await frame.getByText("PLACEHOLDER PHARMA LIMITED, CDSL Demat Account 2, TESTBRIDGE BROKING LIMITED: You left this share out.").waitFor();
    await frame.getByText(/^Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout, Folio 1040012345: Its folio, demat account or PRAN is left out\.$/).waitFor();
    const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const rendered = await frame.locator("body").innerText();
    for (const number of nsdl.accounts.flatMap((a) => [a.dp_id, a.client_id]).filter(Boolean)) {
      assert.equal(rendered.includes(number), false, `A depository identifier is visible: ${number}`);
    }
    // Shares print no cost: typed, or blank for unknown. A bond's cost defaults to its face value.
    assert.equal(await demat.getByRole("row").count(), 12);
    const faceRow = demat.getByRole("row").filter({ hasText: "SAMPLE HOUSING FINANCE LIMITED 7.95 NCD 20JN28" });
    await faceRow.getByText("From the face value", { exact: true }).waitFor();
    assert.equal(await demat.getByLabel("Total cost of SAMPLE HOUSING FINANCE LIMITED 7.95 NCD 20JN28").inputValue(), "200000");
    await faceRow.getByText(priced, { exact: true }).waitFor();
    // Below the statement's price, so the price saved after the snapshot must win over the average cost.
    await demat.getByLabel("Total cost of FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31").fill("45000");
    assert.equal(await demat.getByRole("row").filter({ hasText: "INEZ93A08016" }).getByText(priced, { exact: true }).count(), 0);
    await demat.getByText("150", { exact: true }).waitFor();
    await demat.getByText("520", { exact: true }).waitFor();
    const shortRow = demat.getByRole("row").filter({ hasText: "Fund INEZ90B01015" });
    await shortRow.getByText("Mutual funds also holds it.", { exact: true }).waitFor();
    // Each holding's checkbox names it.
    assert.equal(await frame.getByRole("checkbox", { name: "Import Fund INEZ90B01015 in Demat", exact: true }).isChecked(), true);
    await demat.getByLabel("Total cost of Fund INEZ90A01017").fill("185175");
    await demat.getByLabel("Total cost of Fund INEZ90C01021").fill("abc");
    await demat.getByText("Type an amount like 12345.67, or leave it blank.").waitFor();
    const save = frame.getByRole("button", { name: "Save 2 snapshots" });
    assert.equal(await save.isDisabled(), true);
    const invalidRow = demat.getByRole("row").filter({ hasText: "Fund INEZ90C01021" });
    const invalidImport = frame.getByRole("checkbox", { name: "Import Fund INEZ90C01021 in Demat", exact: true });
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
    await pause("snapshot");
    await save.press("Enter");
    await waiting();
    // A market-priced asset's profile can fail after preview; the other new assets stay readable.
    await hosted(() => { window.host.failGetProfileIds = ["asset-INEZ90C01021"]; });
    await clickOutside();
    await resume();
    await frame.getByText("Saved 2 snapshots").waitFor();
    await stayedOutside("Save 2 snapshots");
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
    // asset, and leaves the new one out, until one choice replaces the old asset with it.
    const confirmBalanced = async (query, result) => {
      await balanced.getByRole("button", { name: /^Change the / }).click();
      await balanced.getByRole("textbox", { name: /^Search for / }).fill(query);
      await balanced.getByRole("textbox", { name: /^Search for / }).press("Enter");
      await balanced.getByRole("radio", { name: result }).dispatchEvent("click");
      await balanced.getByRole("button", { name: "Use this fund" }).click();
      await balanced.getByText("Confirmed", { exact: true }).waitFor();
    };
    const replaceAndSave = async (oldName, newName, oldSymbol, newSymbol) => {
      await preview.click();
      const [oldAsset, newAsset] = [`${oldName} (${oldSymbol} · XBOM)`, `${newName} (${newSymbol} · XBOM)`];
      // The other row's note names each asset, so each row goes by the name in its first cell.
      const row = (name) => folios.getByRole("row").filter({ has: frame.locator("td:first-child > div > span:first-child", { hasText: new RegExp(`^${name}$`) }) });
      const [oldRow, newRow] = [row(oldName), row(newName)];
      const replace = newRow.getByRole("checkbox", { name: `Replace ${oldAsset} with ${newAsset} in Fund folios`, exact: true });
      await replace.waitFor({ state: "attached" });
      assert.equal(await replace.getAttribute("aria-checked"), "false");
      await newRow.getByText(
        `An earlier import of Folio 91234567/12 added this holding as ${oldAsset}. So that it isn't counted twice, it's left out unless you replace ${oldAsset} with it. ` +
        "Replace it only if all its units came from Folio 91234567/12: imports don't record how many units each folio, demat account or PRAN added.",
        { exact: true },
      ).waitFor();
      assert.equal(await newRow.getByText("Left out", { exact: true }).count(), 1);
      await oldRow.getByText(`An earlier import of Folio 91234567/12 added it for a holding that this import lists under ${newAsset}. It's kept unless you replace it with ${newAsset}.`, { exact: true }).waitFor();
      assert.equal(await oldRow.getByText("Kept", { exact: true }).count(), 1);
      // The old row has no choice of its own.
      assert.equal(await oldRow.getByRole("checkbox").count(), 0);
      await replace.dispatchEvent("click");
      await oldRow.getByText("Replaced", { exact: true }).waitFor();
      assert.equal(await newRow.getByText("New", { exact: true }).count(), 1);
      await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
      await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
      await save.click();
      await frame.getByText("Saved 2 snapshots").waitFor();
      return (await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => [h.symbol, h.quantity]);
    };
    await confirmBalanced("MULTI", /^Fund A /);
    assert.deepEqual(await replaceAndSave("Fund INFZ90K01BA1", "Fund A", "INFZ90K01BA1", "A"), [
      ["GILT", "-10"], ["INFZ90K01LQ6", "8.053"], ["A", "3540.293"],
    ]);
    // The import remembers the replacement, so going back is offered the same way.
    await confirmBalanced("INFZ90K01BA1", /^Fund INFZ90K01BA1 /);
    assert.deepEqual(await replaceAndSave("Fund A", "Fund INFZ90K01BA1", "A", "INFZ90K01BA1"), [
      ["GILT", "-10"], ["INFZ90K01LQ6", "8.053"], ["INFZ90K01BA1", "3540.293"],
    ]);

    // A fund left out because Mutual funds holds it, but that an earlier import of its folio added
    // here, keeps the account's units or removes them only by the user's choice, and removing them
    // confirms that all of them came from the folio.
    const replaceBoth = async () => {
      await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
      await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    };
    const importFlexiHolding = flexiRow.getByRole("checkbox", { name: "Import Fund INFZ90K01FC8 in Fund folios", exact: true });
    await preview.click();
    await importFlexiHolding.dispatchEvent("click");
    await replaceBoth();
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "INFZ90K01FC8").quantity, "2892.104");
    await preview.click();
    // Each choice names the holding and account after its visible text, for screen readers.
    const keepFlexi = flexiRow.getByRole("radio", { name: "Keep its 2892.104 units for Fund INFZ90K01FC8 in Fund folios", exact: true });
    const removeFlexi = flexiRow.getByRole("radio", {
      name: "Remove its 2892.104 units: all of them came from Folio 91234567/12 for Fund INFZ90K01FC8 in Fund folios", exact: true,
    });
    await keepFlexi.waitFor({ state: "attached" });
    await flexiRow.getByRole("radiogroup", { name: "Keep or remove its 2892.104 units for Fund INFZ90K01FC8 in Fund folios", exact: true }).waitFor();
    await flexiRow.getByText(
      "An earlier import of Folio 91234567/12 recorded adding this holding. Leaving this row out keeps the 2892.104 units this account holds unless you remove them. Keeping them counts them here and in Mutual funds. " +
      "Keep them, or remove them only if all of them came from Folio 91234567/12: imports don't record how many units each folio, demat account or PRAN added.",
      { exact: true },
    ).waitFor();
    assert.equal(await flexiRow.getByText("Needs a choice", { exact: true }).count(), 1);
    assert.deepEqual([await keepFlexi.getAttribute("aria-checked"), await removeFlexi.getAttribute("aria-checked")], ["false", "false"]);
    await replaceBoth();
    assert.equal(await save.isDisabled(), true);
    await keepFlexi.dispatchEvent("click");
    await flexiRow.getByText("Kept", { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), false);
    // Importing the statement's units replaces the account's, so there's nothing to choose.
    await importFlexiHolding.dispatchEvent("click");
    await flexiRow.getByText("Updated", { exact: true }).waitFor();
    assert.equal(await flexiRow.getByRole("radio").count(), 0);
    await importFlexiHolding.dispatchEvent("click");
    await removeFlexi.dispatchEvent("click");
    await flexiRow.getByText("Removed", { exact: true }).waitFor();
    assert.equal(await removeFlexi.getAttribute("aria-checked"), "true");
    assert.equal(await save.isDisabled(), false);
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.deepEqual((await snapshot("holdings-2", "2025-03-31")).holdings.map((h) => h.symbol), ["GILT", "INFZ90K01LQ6", "INFZ90K01BA1"]);
    // Removed with the earlier import's record, so the next preview has nothing to choose.
    await preview.click();
    await flexiRow.getByText("Left out", { exact: true }).waitFor();
    assert.equal(await flexiRow.getByRole("radio").count(), 0);
    await flexiRow.getByText("Mutual funds already holds this fund, from its transactions. Including it here counts it twice.", { exact: true }).waitFor();
    assert.equal(await flexiRow.getByText(/^(An earlier import|Leaving this row out)/).count(), 0);

    // Leaving a still-listed fund out keeps both its units and the earlier import's provenance.
    await leaveOut(holding(detailed.liquid));
    await preview.click();
    await folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" }).getByText("Kept", { exact: true }).waitFor();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "INFZ90K01LQ6").quantity, "8.053");

    // Once that fund is no longer listed, the remembered import still removes it by default, also
    // after its asset's symbol changed in Wealthfolio and its choice was forgotten: the record's
    // asset ID tells its asset. Replacing a snapshot on the same date needs confirming;
    // Wealthfolio's cost carries over, also to a holding whose display
    // code was changed.
    await hosted(() => {
      window.host.soldIsins = ["INFZ90K01LQ6"];
      window.host.assets["asset-INEZ90A01017"].displayCode = "MY SHARE";
      window.host.assets["asset-INFZ90K01LQ6"].instrumentSymbol = "MY-LIQUID";
      window.host.storage.delete("isin:INFZ90K01LQ6");
    });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 16 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await preview.click();
    await demat.waitFor();
    const sold = folios.getByRole("row").filter({ hasText: "Fund INFZ90K01LQ6" });
    await sold.getByText("Not on the statement any more. An earlier import of Folio 91234567/12 added it.").waitFor();
    assert.equal(await sold.getByText("Removed", { exact: true }).count(), 1);
    assert.equal(await frame.getByRole("checkbox", { name: "Keep Fund INFZ90K01LQ6 in Fund folios", exact: true }).isChecked(), false);
    assert.equal(await demat.getByLabel("Total cost of Fund INEZ90A01017").inputValue(), "185175");
    await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).getByText("From the account's average cost in Wealthfolio").waitFor();
    assert.equal(await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).count(), 1);
    assert.equal(await save.isDisabled(), true);
    // Both accounts have a snapshot on this date; each checkbox names its account.
    await frame.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await frame.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await save.click();
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
    // code matches another asset's symbol. Restore the remembered choice before the next read.
    const shareChoiceBefore = (await storage())["isin:INEZ90A01017"];
    const shareChoice = holding("FICTIVA POWER AND LIGHT LIMITED");
    await shareChoice.getByRole("button", { name: /^Change the / }).click();
    await shareChoice.getByRole("button", { name: /^Use this share for / }).click();
    await hosted(() => {
      window.host.assets["asset-INEZ90A01017"].displayCode = "INEZ90C01021";
      window.host.assets["asset-INEZ90A01017"].instrumentSymbol = null;
    });
    await preview.click();
    assert.equal(await demat.getByLabel("Total cost of Fund INEZ90A01017").inputValue(), "185175");
    assert.equal(await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).count(), 1);
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
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 9 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await frame.getByLabel(/^NSDL Demat Account 1,/).getByText("Demat (INR)").waitFor();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).getByText("Removed", { exact: true }).waitFor();
    await demat.getByRole("row").filter({ hasText: "Fund INFZ90K01NE8" }).getByText("Removed", { exact: true }).waitFor();
    await demat.getByRole("row").filter({ hasText: "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31" }).getByText("Removed", { exact: true }).waitFor();
    await demat.getByRole("row").filter({ hasText: "Fund INEZ92A01013" }).getByText(priced, { exact: true }).waitFor();
    assert.equal(await folios.getByRole("row").filter({ hasText: "Gilt fund" }).getByText("Kept", { exact: true }).count(), 1);
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), false);
    await save.click();
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
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 demat accounts, 2 folios, 11 holdings.").waitFor({ timeout: 180_000 });
    await frame.locator("section").filter({ hasText: "PLACEHOLDER PHARMA LIMITED" }).getByRole("button", { name: "Leave this share out" }).click();
    await preview.click();
    const sharesRow = demat.getByRole("row").filter({ hasText: "Fund INEZ90B01015" });
    await sharesRow.getByText(priced, { exact: true }).waitFor();
    const manualShare = holding("SAMPLEWORKS TECHNOLOGIES LIMITED");
    await manualShare.getByRole("button", { name: /^Change the / }).click();
    await manualShare.getByRole("button", { name: "Use this share" }).click();
    await manualShare.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(JSON.parse((await storage())["isin:INEZ90B01015"]).manual, undefined);
    // With no observed holding left, the current search result still carries its MANUAL mode.
    const laterSnapshot = await snapshot("holdings-1", "2025-04-30");
    await hosted(() => { delete window.host.snapshots["holdings-1"]["2025-04-30"]; });
    await preview.click();
    await sharesRow.getByText(priced, { exact: true }).waitFor();
    // A live mode change overrides the mode the search result supplied earlier.
    await hosted((later) => {
      window.host.snapshots["holdings-1"]["2025-04-30"] = later;
      window.host.pricingModes.INEZ90B01015 = "MARKET";
    }, laterSnapshot);
    await preview.click();
    await sharesRow.getByText(priced, { exact: true }).waitFor({ state: "hidden" });
    await demat.getByLabel("Total cost of Fund INEZ90B01015").fill("1000");
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    assert.equal(await save.isDisabled(), false);
    await save.click();
    await frame.getByText("Saved 2 snapshots").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-04-30")).holdings[0].averageCost, "20");
    assert.equal(await hosted(() => window.host.quotes["asset-INEZ90B01015"]), undefined);

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
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Confirmed", { exact: true }).waitFor({ timeout: 180_000 });
    await preview.click();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    const saveOne = frame.getByRole("button", { name: "Save 1 snapshot", exact: true });
    assert.equal(await saveOne.isDisabled(), false);
    await demat.getByRole("row").filter({ hasText: "Fund INEZ90A01017" }).getByText(priced, { exact: true }).waitFor();

    // An NPS account's schemes: searched by name first, then priced from the statement, one asset
    // per scheme. A scheme without units is left out.
    const scheme = "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME E - TIER I";
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
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I, NPS, PRAN XXXXXXXX9001: No units on the statement.", { exact: true }).waitFor({ timeout: 180_000 });
    const npsSection = holding(scheme);
    await npsSection.getByText(/^No ISIN on the statement, and nothing found for ".*"\. Try another name or a ticker, or use the statement's prices\.$/).waitFor();
    // A card without funds never recommends AMFI.
    await noAmfiNote();
    // An NPS scheme's results have no plan or option badges, even when their names give them.
    await npsSection.getByRole("textbox", { name: /^Search for / }).fill("Fictiva Flexi Cap");
    await npsSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await npsSection.getByRole("radio").nth(4).waitFor({ state: "attached" });
    assert.deepEqual(await badges(npsSection), []);
    await npsSection.getByRole("radio").nth(1).dispatchEvent("click");
    await npsSection.getByRole("button", { name: "Use this NPS scheme" }).click();
    await npsSection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(npsSection), ["Confirmed success-subtle"]);
    await npsSection.getByRole("button", { name: /^Change the / }).click();
    await npsSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await statementPriced(npsSection, "NPS-TEST-E-TIER-I", "EQUITY");
    assert.deepEqual(await badges(npsSection), ["Confirmed success-subtle"]);
    // A PRAN's remembered account that's archived is ignored too, though it doesn't track holdings either.
    const pran = frame.getByLabel(/^NPS, PRAN XXXXXXXX9001/);
    await saveChoices([[await pran.getAttribute("id"), "archived-2"]]);
    await readAgain();
    await rowOf(pran).getByText(oldFunds, { exact: true }).waitFor();
    assert.match(await pran.textContent(), /Choose an account/);
    assert.equal(await preview.isDisabled(), true);
    // Its investor is the statement's name, not the PAN of the earlier statements, so nothing else is remembered.
    await choose(/^NPS, PRAN XXXXXXXX9001/, "Fund folios (INR)");
    await preview.click();
    const npsRow = folios.getByRole("row").filter({ hasText: scheme });
    await npsRow.getByText(priced, { exact: true }).waitFor();
    await npsRow.getByText("New", { exact: true }).waitFor();
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await saveOne.click();
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

    const readHoldingsAgain = async () => {
      const previous = await hosted(() => window.host.parsed);
      await frame.getByRole("button", { name: "Read statement", exact: true }).click();
      await tab.frames()[1].waitForFunction((n) => window.host.parsed > n, previous, { timeout: 180_000 });
      await frame.getByText("Accounts", { exact: true }).waitFor();
    };
    // The same date replaces the snapshot and quote, without creating another asset or changing its quote ID.
    await readHoldingsAgain();
    await npsSection.getByText("Confirmed", { exact: true }).waitFor();
    await preview.click();
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await saveOne.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.deepEqual(await hosted(() => window.host.quotes["pension-created-007"].map((q) => [q.id, q.timestamp, q.close])), npsHost.quotes.map((q) => [q.id, q.timestamp, q.close]));
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").assetId, "pension-created-007");

    // Another PRAN shares the scheme's asset; a later statement adds a dated quote and preserves the earlier snapshot.
    await hosted(() => {
      window.host.statementDate = "30-Apr-2025";
      window.host.npsPran = "XXXXXXXX9002";
      window.host.onlyNps = [{ scheme: "NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME E - TIER I", units: "50" }];
    });
    await readHoldingsAgain();
    await choose(/^NPS, PRAN XXXXXXXX9002/, "Demat (INR)");
    await preview.click();
    const laterPension = frame.locator("section").filter({ hasText: "Demat: snapshot of 2025-04-30" });
    await laterPension.getByLabel(`Total cost of ${scheme}`).fill("500");
    await laterPension.getByRole("checkbox", { name: "Replace the snapshot of 2025-04-30 in Demat", exact: true }).dispatchEvent("click");
    await saveOne.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-04-30")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").assetId, "pension-created-007");
    assert.equal((await snapshot("holdings-2", "2025-03-31")).holdings.find((h) => h.symbol === "NPS-TEST-E-TIER-I").quantity, "40");
    assert.deepEqual(await hosted(() => window.host.quotes["pension-created-007"].map((q) => [q.timestamp.slice(0, 10), q.close, q.id])), [
      ["2025-03-31", 25.5, "pension-created-007_2025-03-31_MANUAL"], ["2025-04-30", 25.5, "pension-created-007_2025-04-30_MANUAL"],
    ]);
    assert.equal(await hosted(() => Object.values(window.host.assets).filter((a) => a.symbol === "NPS-TEST-E-TIER-I").length), 1);

    // Exclusions are visible even when the statement has nothing that could reach a preview.
    await frame.getByLabel(/^NPS, PRAN XXXXXXXX9002/).click();
    await frame.getByRole("option", { name: "Leave out" }).click();
    await frame.getByText(`${scheme}, NPS, PRAN XXXXXXXX9002: Its folio, demat account or PRAN is left out.`, { exact: true }).waitFor();
    assert.equal(await preview.isDisabled(), true);
    assert.equal(await frame.getByText("Preview", { exact: true }).count(), 0);

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
    await readHoldingsAgain();
    await choose(/^NPS, PRAN XXXXXXXX9001/, "Demat (INR)");
    // A failed lookup cannot treat an unheld MARKET asset as a new manual-priced one.
    for (const failure of ["search", "profile"]) {
      await hosted((failure) => {
        window.host.failSearchQueries = failure === "search" ? ["NPS-TEST-E-TIER-I"] : [];
        window.host.failGetProfileIds = failure === "profile" ? ["pension-created-007"] : [];
      }, failure);
      const saves = await hosted(() => window.host.saves.length);
      await preview.click();
      await frame.getByText(/Couldn't verify pricing for/).waitFor();
      assert.equal(await frame.getByText("Preview", { exact: true }).count(), 0);
      assert.equal(await hosted(() => window.host.saves.length), saves);
      assert.equal(await hosted(() => window.host.pricingModes["NPS-TEST-E-TIER-I"]), "MARKET");
    }
    await hosted(() => { window.host.failSearchQueries = []; window.host.failGetProfileIds = []; });
    await preview.click();
    await demat.getByRole("row").filter({ hasText: scheme }).waitFor();
    assert.equal(await demat.getByText(priced, { exact: true }).count(), 0);
    await saveOne.click();
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
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "My pension" }).waitFor();
    assert.equal(await demat.getByText(priced, { exact: true }).count(), 0);
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
      await preview.click();
      // The other account's holding can't be matched without its profile, so that stops the preview first.
      await frame.getByText(failure === "profile" ? /Couldn't read the Wealthfolio profile of My pension: .+ Try the preview again\./ : /Couldn't verify pricing for/).waitFor();
      assert.equal(await frame.getByText("Preview", { exact: true }).count(), 0);
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
    await readHoldingsAgain();
    const marketSection = frame.locator("section").filter({ hasText: marketScheme });
    await marketSection.getByRole("textbox", { name: /^Search for / }).fill("NPS-TEST-M-TIER-I");
    await marketSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await marketSection.getByRole("button", { name: /^Use this NPS scheme for / }).click();
    // A fresh search choice's manual mode can go stale before preview, too.
    await hosted(() => {
      window.host.pricingModes["NPS-TEST-M-TIER-I"] = "MARKET";
      window.host.failGetProfileIds = ["market-profile-011"];
    });
    await preview.click();
    await frame.getByText(/Couldn't verify pricing for/).waitFor();
    assert.equal(await frame.getByText("Preview", { exact: true }).count(), 0);
    await hosted(() => { window.host.failGetProfileIds = []; });
    await preview.click();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await saveOne.click();
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
    await readHoldingsAgain();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Provider pension" }).waitFor();
    await saveOne.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].assetId, undefined);
    assert.equal(await hosted(() => window.host.assets["deleted-profile-012"]), undefined);
    assert.equal(await hosted(() => window.host.pricingModes["NPS-TEST-M-TIER-I"]), "MARKET");
    assert.equal(await hosted(() => window.host.quotes["market-profile-011"]), undefined);
    assert.equal(await frame.getByText("Some prices or details weren't saved", { exact: true }).count(), 0);
    await hosted(() => { window.host.failGetProfileIds = []; });

    // ECNQUOTE, like MUTUALFUND above, is an older provider label for a canonical EQUITY asset.
    await hosted(() => {
      for (const [key, value] of window.host.storage) {
        if (!key.startsWith("nps:")) continue;
        const choice = JSON.parse(value);
        if (choice?.symbol !== "NPS-TEST-M-TIER-I") continue;
        window.host.storage.set(key, JSON.stringify({ ...choice, assetId: undefined, instrumentType: "ECNQUOTE" }));
      }
      window.host.pricingModes["NPS-TEST-M-TIER-I"] = "MANUAL";
    });
    await readHoldingsAgain();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Provider pension" }).getByText(priced, { exact: true }).waitFor();
    await demat.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Demat", exact: true }).dispatchEvent("click");
    await saveOne.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
    assert.equal((await snapshot("holdings-1", "2025-03-31")).holdings[0].assetId, "market-profile-011");
    // A type label the add-on doesn't know still finds the one asset with that symbol and exchange.
    await hosted(() => {
      for (const [key, value] of window.host.storage) {
        if (!key.startsWith("nps:")) continue;
        const choice = JSON.parse(value);
        if (choice?.symbol === "NPS-TEST-M-TIER-I") window.host.storage.set(key, JSON.stringify({ ...choice, instrumentType: "SOMETHING_NEW" }));
      }
    });
    await readHoldingsAgain();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Provider pension" }).getByText(priced, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/Couldn't verify pricing/).count(), 0);

    // Legacy untyped assets are returned as OTHER; their exact remembered match still wins.
    await hosted(() => {
      delete window.host.assets["market-profile-011"].instrumentType;
      for (const [key, value] of window.host.storage) {
        if (!key.startsWith("nps:")) continue;
        const choice = JSON.parse(value);
        if (choice?.symbol === "NPS-TEST-M-TIER-I") window.host.storage.set(key, JSON.stringify({ ...choice, instrumentType: "OTHER" }));
      }
    });
    await readHoldingsAgain();
    await preview.click();
    await demat.getByRole("row").filter({ hasText: "Provider pension" }).getByText(priced, { exact: true }).waitFor();
    assert.equal(await frame.getByText(/Couldn't verify pricing/).count(), 0);
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
    await readHoldingsAgain();
    for (let open = await frame.locator("section").count(); open > 0; open--) {
      await frame.locator("section").first().getByRole("button", { name: /^Use the statement's prices for / }).click();
      await frame.locator("section").nth(open - 1).waitFor({ state: "detached" });
    }
    await choose("All of this statement", "Fund folios (INR)");
    await choose(/^NSDL Demat Account 1, FAILURE TEST BROKER/, "Demat (INR)");
    // An earlier source override still points at Demat; the new statement's NPS goes to the second account.
    await choose(/^NPS, PRAN XXXXXXXX9001/, "Fund folios (INR)");
    await preview.click();
    const continuedNps = frame.locator("section").filter({ hasText: "Fund folios: snapshot of 2025-05-31" });
    await continuedNps.getByLabel("Total cost of NPS TRUST- A/C TEST PENSION FUND LIMITED SCHEME G - TIER I").fill("100");
    // A profile can fail after preview; the readable scheme still gets its price and details.
    await hosted(() => { window.host.failGetProfileIds = ["pension-g-009"]; });
    await frame.getByRole("button", { name: "Save 2 snapshots", exact: true }).click();
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
    await readHoldingsAgain();
    await preview.click();
    await continuedNps.getByRole("checkbox", { name: "Replace the snapshot of 2025-05-31 in Fund folios", exact: true }).dispatchEvent("click");
    await frame.getByRole("button", { name: "Save 2 snapshots", exact: true }).click();
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
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-summary-cams.pdf");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("Check each folio's funds and AMC against the PDF. The parser can merge equal folio numbers across AMCs without a warning.", { exact: true }).waitFor({ timeout: 180_000 });
    // A folio with funds from two issuers, as the parser returns two AMCs' folios with one number, still reads.
    await hosted(() => { window.host.ambiguousSummary = true; });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("CAMS summary statement for ANANYA R TESTWALA, as on 31-Mar-2025: 2 folios, 6 holdings.", { exact: true }).waitFor({ timeout: 180_000 });
    assert.equal(await frame.getByRole("button", { name: "Preview the snapshots" }).count(), 1);
    await hosted(() => { window.host.ambiguousSummary = false; });

    // Funds and shares that no search result fits can use the statement's prices too: a summary
    // fund whose search finds only another fund, one with no ISIN whose search finds nothing, and a
    // depository fund and share. The first save can't write one price and one asset's details.
    const corporate = "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout";
    const gilt = "Testbridge Gilt Fund - Direct Plan - Growth";
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
    await readHoldingsAgain();
    const corporateSection = holding(corporate);
    await corporateSection.getByText("Symbol 0P0000TBCB · Exchange XBOM · Type MUTUALFUND · Currency INR", { exact: true }).waitFor({ state: "attached" });
    await corporateSection.getByText("FAKE", { exact: true }).waitFor();
    await corporateSection.getByRole("button", { name: /^Change the / }).click();
    await corporateSection.getByText(`Nothing found for the ISIN; showing results for "Testbridge Corporate Bond". These results can be other funds. Pick one with the statement's fund name, plan and option, use the statement's prices, or leave this fund out.`, { exact: true }).waitFor();
    await corporateSection.getByRole("radio").first().waitFor({ state: "attached" });
    await corporateSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await statementPriced(corporateSection, "INFZ91T01CB6", "MUTUALFUND");
    const giltSection = holding(gilt);
    await giltSection.getByText("No ISIN printed", { exact: true }).waitFor();
    await giltSection.getByText(`No ISIN on the statement, and nothing found for "Testbridge Gilt". Try another name or a ticker, or use the statement's prices.`, { exact: true }).waitFor();
    await giltSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await statementPriced(giltSection, "MF-KFINTECH-TGLDG", "MUTUALFUND");
    await useFirstResults();
    await choose("All of this statement", "Fund folios (INR)");
    await preview.click();
    await folios.getByRole("row").filter({ hasText: corporate }).getByText(priced, { exact: true }).waitFor();
    await folios.getByRole("row").filter({ hasText: gilt }).getByText(priced, { exact: true }).waitFor();
    // The Gilt fund prints no cost: one below its price, so the price saved afterwards must win.
    await folios.getByLabel(`Total cost of ${gilt}`).fill("40000");
    await saveOne.click();
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
    assert.deepEqual(JSON.parse(firstFunds.storage["isin:INFZ91T01CB6"]), {
      symbol: "INFZ91T01CB6", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: corporate, statementPrices: true, transactions: corporateFund,
    });
    assert.ok(Object.entries(firstFunds.storage).some(([key, value]) =>
      /^fund:[0-9a-f]{64}$/.test(key) && JSON.parse(value).symbol === "MF-KFINTECH-TGLDG" && JSON.parse(value).statementPrices));

    // The next import finds both choices and assets again, and finishes the incomplete writes.
    await hosted(() => { window.host.failQuoteIds = []; window.host.failProfileIds = []; });
    await readHoldingsAgain();
    await statementPriced(corporateSection, "INFZ91T01CB6", "MUTUALFUND");
    await statementPriced(giltSection, "MF-KFINTECH-TGLDG", "MUTUALFUND");
    await preview.click();
    await folios.getByRole("row").filter({ hasText: gilt }).getByText("From the account's average cost in Wealthfolio").waitFor();
    await folios.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await saveOne.click();
    await frame.getByText("Saved 1 snapshot").waitFor();
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
    const corporatePriced = {
      symbol: "INFZ91T01CB6", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: corporate, statementPrices: true, transactions: corporateFund,
    };
    await corporateSection.getByRole("button", { name: /^Change the / }).click();
    await corporateSection.getByRole("radio", { checked: true }).waitFor({ state: "attached" });
    assert.equal(await corporateSection.getByRole("radio").count(), 1);
    // The result is shown as that choice: the statement's name, and the statement's prices.
    const ownResult = await corporateSection.getByRole("radiogroup").locator("label").textContent();
    assert.ok(ownResult.startsWith(corporate) && ownResult.endsWith(" Statement prices"), ownResult);
    assert.deepEqual(await resultCodes(corporateSection), ["Symbol INFZ91T01CB6 · Type MUTUALFUND · Currency INR"]);
    await corporateSection.getByRole("button", { name: "Use this fund" }).click();
    await statementPriced(corporateSection, "INFZ91T01CB6", "MUTUALFUND");
    await readHoldingsAgain();
    await statementPriced(corporateSection, "INFZ91T01CB6", "MUTUALFUND");
    assert.deepEqual(await corporateStored(), corporatePriced);
    // The same symbol with another type or currency is still that search result, with its ID and warning.
    for (const [type, currency] of [["BOND", "INR"], ["EQUITY", "USD"]]) {
      await hosted(([type, currency]) => {
        Object.assign(window.host.assets["fund-priced-014"], { instrumentType: type, quoteCcy: currency });
      }, [type, currency]);
      await corporateSection.getByRole("button", { name: /^Change the / }).click();
      const description = `Symbol INFZ91T01CB6 · Type ${type} · Currency ${currency}`;
      await corporateSection.getByText(description, { exact: true }).waitFor({ state: "attached" });
      await corporateSection.getByText("Priced by hand", { exact: true }).waitFor();
      if (currency === "USD") {
        await corporateSection.getByText("USD", { exact: true }).waitFor();
        await corporateSection.getByText(inUsd, { exact: true }).waitFor();
      }
      await corporateSection.getByRole("button", { name: "Use this fund" }).click();
      await corporateSection.getByText("Confirmed", { exact: true }).waitFor();
      await corporateSection.getByText(description, { exact: true }).waitFor({ state: "attached" });
      await corporateSection.getByText("Priced by hand", { exact: true }).waitFor();
      if (currency === "USD") {
        await corporateSection.getByText("USD", { exact: true }).waitFor();
        await corporateSection.getByText(inUsd, { exact: true }).waitFor();
      }
      await tab.frames()[1].waitForFunction(([type, currency]) => {
        const fund = JSON.parse(window.host.storage.get("isin:INFZ91T01CB6"));
        return fund.assetId === "fund-priced-014" && fund.instrumentType === type && fund.quoteCcy === currency;
      }, [type, currency]);
      const stored = await corporateStored();
      assert.deepEqual([stored.statementPrices, stored.transactions], [undefined, undefined]);
    }
    await hosted(() => {
      Object.assign(window.host.assets["fund-priced-014"], { instrumentType: "EQUITY", quoteCcy: "INR" });
    });
    await corporateSection.getByRole("button", { name: /^Change the / }).click();
    await corporateSection.getByRole("textbox", { name: /^Search for / }).fill("0P0000TBCB");
    await corporateSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await corporateSection.getByText("Symbol 0P0000TBCB · Exchange XBOM · Type MUTUALFUND · Currency INR", { exact: true }).waitFor({ state: "attached" });
    await corporateSection.getByRole("radio", { checked: true }).waitFor({ state: "attached" });
    await corporateSection.getByRole("button", { name: "Use this fund" }).click();
    await corporateSection.getByText("Confirmed", { exact: true }).waitFor();
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ91T01CB6")).symbol === "0P0000TBCB");
    assert.deepEqual(await corporateStored(), corporateFund);
    await corporateSection.getByRole("button", { name: /^Change the / }).click();
    await corporateSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ91T01CB6")).statementPrices);
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
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-nsdl.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("NSDL statement for ANANYA R TESTWALA, as on 30-Apr-2025: 1 demat account, 0 folios, 2 holdings.").waitFor({ timeout: 180_000 });
    // With an option but no plan on the statement, only the differing option warns.
    const optionOnlySection = holding("PRETEND SMALL CAP FUND - GROWTH");
    assert.deepEqual(await nameBadges(optionOnlySection), ["Growth secondary"]);
    await optionOnlySection.getByRole("textbox", { name: /^Search for / }).fill("Pretend Small Cap");
    await optionOnlySection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await optionOnlySection.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await resultBadges(optionOnlySection), [["Direct secondary", "Growth secondary"], ["Regular secondary", "IDCW warning-subtle"]]);
    await optionOnlySection.getByRole("radio").nth(1).dispatchEvent("click");
    await optionOnlySection.getByRole("button", { name: "Use this fund" }).click();
    await optionOnlySection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(optionOnlySection), ["Confirmed success-subtle", "Regular secondary", "IDCW warning-subtle"]);
    // Forget this temporary choice, then restore the plan-only statement for the snapshot checks.
    await optionOnlySection.getByRole("button", { name: /^Change the / }).click();
    await optionOnlySection.getByRole("button", { name: "Leave this fund out" }).click();
    await optionOnlySection.getByText("Left out", { exact: true }).waitFor();
    await hosted((smallCap) => { window.host.depositoryAccounts[0].mutual_funds[0].name = smallCap; }, smallCap);
    await readAgain();
    const textilesSection = holding(textiles);
    await textilesSection.getByText("Fund INEZ94A01017").waitFor();
    assert.equal(await textilesSection.getByRole("button", { name: "Use this share" }).isDisabled(), false);
    // A share's results have no plan or option badges, even when their names give them.
    await textilesSection.getByRole("textbox", { name: /^Search for / }).fill("Pretend Small Cap");
    await textilesSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await textilesSection.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await badges(textilesSection), []);
    await textilesSection.getByRole("radio").nth(1).dispatchEvent("click");
    await textilesSection.getByRole("button", { name: "Use this share" }).click();
    await textilesSection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(textilesSection), ["Confirmed success-subtle"]);
    await textilesSection.getByRole("button", { name: /^Change the / }).click();
    await textilesSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await statementPriced(textilesSection, "INEZ94A01017", "EQUITY");
    const smallCapSection = holding(smallCap);
    await smallCapSection.getByText(`Nothing found for the ISIN or for "PRETEND SMALL CAP". Try another name or a ticker, or use the statement's prices.`, { exact: true }).waitFor();
    // With no option on the statement, a result's option is no warning; another plan is.
    assert.deepEqual(await nameBadges(smallCapSection), ["Direct secondary"]);
    await smallCapSection.getByRole("textbox", { name: /^Search for / }).fill("Pretend Small Cap");
    await smallCapSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await smallCapSection.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await resultBadges(smallCapSection), [["Direct secondary", "Growth secondary"], ["Regular warning-subtle", "IDCW secondary"]]);
    await smallCapSection.getByRole("radio").nth(1).dispatchEvent("click");
    await smallCapSection.getByRole("button", { name: "Use this fund" }).click();
    await smallCapSection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(smallCapSection), ["Confirmed success-subtle", "Regular warning-subtle", "IDCW secondary"]);
    await smallCapSection.getByRole("button", { name: /^Change the / }).click();
    await smallCapSection.getByRole("button", { name: "Use the statement's prices" }).click();
    await statementPriced(smallCapSection, "INFZ92P01SC5", "MUTUALFUND");
    assert.deepEqual(await choiceBadges(smallCapSection), ["Confirmed success-subtle", "Direct secondary"]);
    await choose(/^CDSL Demat Account 1, PRETEND BROKING LIMITED/, "Demat (INR)");
    await preview.click();
    const pretendDemat = frame.locator("section").filter({ hasText: "Demat: snapshot of 2025-04-30" });
    await pretendDemat.getByRole("row").filter({ hasText: textiles }).getByText(priced, { exact: true }).waitFor();
    await pretendDemat.getByRole("row").filter({ hasText: smallCap }).getByText(priced, { exact: true }).waitFor();
    await pretendDemat.getByLabel(`Total cost of ${textiles}`).fill("4000");
    await saveOne.click();
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
    // "- DIRECT GROW", gets Direct and Growth badges beside its name without the fund house, and a
    // result or choice on another plan and option warns.
    const pretendStatement = await hosted(() => {
      const kept = { accounts: window.host.depositoryAccounts, date: window.host.statementDate };
      window.host.depositoryAccounts = undefined;
      window.host.statementDate = "";
      return kept;
    });
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cdsl.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText("CDSL statement for ANANYA R TESTWALA, as on 31-Mar-2026: 2 demat accounts, 2 folios, 1 NPS account, 15 holdings.").waitFor({ timeout: 180_000 });
    // Funds printed as a real CDSL statement prints them, after the fund house, "#", its short name
    // and U+0002 or "-", show their scheme names alone, without control characters.
    const cdslBalanced = frame.locator("section").filter({ hasText: "ISIN INFZ90K01BG8" });
    assert.equal(await cdslBalanced.locator("h3").textContent(), "FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH");
    assert.deepEqual(await nameBadges(cdslBalanced), ["Direct secondary", "Growth secondary"]);
    assert.equal(await frame.locator("section").filter({ hasText: "ISIN INFZ91T01GR3" }).locator("h3").textContent(), "TESTBRIDGE GILT FUND");
    const cdslHeadings = await frame.locator("section h3").allTextContents();
    assert.ok(cdslHeadings.includes("TESTBRIDGE GILT FUND") && cdslHeadings.every((h) => !/[\x00-\x1f\x7f#]/.test(h)), cdslHeadings.join(" | "));
    const cutSection = holding("FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW");
    assert.equal(
      await cutSection.locator("h3").textContent(),
      "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW",
    );
    assert.deepEqual(await nameBadges(cutSection), ["Direct secondary", "Growth secondary"]);
    await cutSection.getByRole("textbox", { name: /^Search for / }).fill("Fictiva Testbridge Global");
    await cutSection.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await cutSection.getByRole("radio").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await resultBadges(cutSection), [["Direct secondary", "Growth secondary"], ["Regular warning-subtle", "IDCW warning-subtle"]]);
    await cutSection.getByRole("radio").nth(1).dispatchEvent("click");
    await cutSection.getByRole("button", { name: "Use this fund" }).click();
    await cutSection.getByText("Confirmed", { exact: true }).waitFor();
    assert.deepEqual(await choiceBadges(cutSection), ["Confirmed success-subtle", "Regular warning-subtle", "IDCW warning-subtle"]);
    await hosted((kept) => {
      window.host.depositoryAccounts = kept.accounts;
      window.host.statementDate = kept.date;
    }, pretendStatement);

    // A detailed statement keeps the fund confirmed for it instead of using the asset priced from statements.
    // This copy has no password, so it reads with the box empty, and Remember the password keeps the saved one.
    assert.equal(await remember.getAttribute("aria-checked"), "true");
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-cas-no-password.pdf");
    await frame.locator("#cas-password").fill("");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText(/2 folios, 7 schemes, 78 rows\./).waitFor({ timeout: 180_000 });
    assert.deepEqual((await host()).secrets, [["statement-password", "ABCDE1234F"]]);
    const detailedCorporate = holding(detailed.corporate);
    await detailedCorporate.getByText("Confirmed", { exact: true }).waitFor();
    await detailedCorporate.getByText("Symbol 0P0000TBCB · Exchange XBOM · Type MUTUALFUND · Currency INR", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await frame.getByRole("button", { name: "Use the statement's prices" }).count(), 0);
    await holding(detailed.flexi).getByText("Confirmed", { exact: true }).waitFor();
    // Its search doesn't offer the asset priced from statements, whether by ISIN or by name.
    const withheld = "The asset that holdings imports price from statements for this fund isn't listed: detailed imports don't use the statement's prices.";
    await detailedCorporate.getByRole("button", { name: /^Change the / }).click();
    await detailedCorporate.getByText(withheld, { exact: true }).waitFor();
    await detailedCorporate.getByText(`Nothing found for the ISIN or for "Testbridge Corporate Bond". Try another name or a ticker.`, { exact: true }).waitFor();
    assert.equal(await detailedCorporate.getByRole("radio").count(), 0);
    assert.equal(await detailedCorporate.getByRole("textbox", { name: /^Search for / }).inputValue(), "Testbridge Corporate Bond");
    await detailedCorporate.getByRole("textbox", { name: /^Search for / }).fill("INFZ91T01CB6");
    await detailedCorporate.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await detailedCorporate.getByText(`Nothing found for the ISIN or for "Testbridge Corporate Bond". Try another name or a ticker.`, { exact: true }).waitFor();
    await detailedCorporate.getByText(withheld, { exact: true }).waitFor();
    // Leaving the fund out, or confirming one, changes only the fund kept for detailed imports.
    await detailedCorporate.getByRole("button", { name: "Leave this fund out" }).click();
    await detailedCorporate.getByText("Left out", { exact: true }).waitFor();
    await tab.frames()[1].waitForFunction(() => !JSON.parse(window.host.storage.get("isin:INFZ91T01CB6")).transactions);
    assert.deepEqual(await corporateStored(), { symbol: "INFZ91T01CB6", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: corporate, statementPrices: true });
    await detailedCorporate.getByRole("button", { name: /^Choose a fund / }).click();
    await detailedCorporate.getByText(withheld, { exact: true }).waitFor();
    await detailedCorporate.getByRole("textbox", { name: /^Search for / }).fill("0P0000TBCB");
    await detailedCorporate.getByRole("textbox", { name: /^Search for / }).press("Enter");
    await detailedCorporate.getByRole("radio", { checked: true }).waitFor({ state: "attached" });
    assert.equal(await detailedCorporate.getByText(withheld, { exact: true }).count(), 0);
    await detailedCorporate.getByRole("button", { name: "Use this fund" }).click();
    await detailedCorporate.getByText("Confirmed", { exact: true }).waitFor();
    await tab.frames()[1].waitForFunction(() => JSON.parse(window.host.storage.get("isin:INFZ91T01CB6")).transactions);
    const reconfirmed = await corporateStored();
    assert.deepEqual([reconfirmed.symbol, reconfirmed.statementPrices, reconfirmed.transactions.symbol, reconfirmed.transactions.exchangeMic], [
      "INFZ91T01CB6", true, "0P0000TBCB", "XBOM",
    ]);
    await hosted(() => {
      window.host.summaryWithoutIsin = [];
      window.host.emptySearchQueries = [];
      window.host.depositoryAccounts = undefined;
      window.host.statementDate = "";
    });

    // With no account that tracks holdings, a summary statement is still checked against the
    // accounts that track transactions, and the check saves nothing.
    const flexiName = "Fictiva Flexi Cap Fund - Direct Plan - Growth";
    const balancedName = "Fictiva Balanced Advantage Fund - Direct Plan - Income Distribution cum Capital Withdrawal Option - Reinvestment";
    const liquidName = "Fictiva Liquid Fund - Direct Plan - Growth";
    const beforeCheck = await accountList();
    // Hidden accounts that track transactions are still compared, like Not set here.
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
    await frame.locator("#cas-file").setInputFiles("tests/fixtures/made-up-summary-cams.pdf");
    await frame.locator("#cas-password").fill("ABCDE1234F");
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText(/^No account tracks holdings\. To save snapshots,/).waitFor({ timeout: 180_000 });
    // Confirmed before, so it's a row, without the statement name's badges (tests/fund-name.test.mjs reads them).
    await holding(balancedName).getByText("Confirmed", { exact: true }).waitFor();
    await useFirstResults();
    assert.equal(await preview.isDisabled(), true);
    await frame.getByText("No account tracks holdings, so there's nowhere to save a snapshot.", { exact: true }).waitFor();
    const accountData = () => hosted(() => JSON.stringify({
      saves: window.host.saves, snapshots: window.host.snapshots, storage: [...window.host.storage], activities: window.host.activities,
      quotes: window.host.quotes, assets: window.host.assets, modes: window.host.pricingModes, links: window.host.links,
    }));
    const before = await accountData();
    const checkButton = frame.getByRole("button", { name: "Check units", exact: true });
    const checkStatus = checkButton.locator("xpath=..").getByRole("status");
    assert.equal(await checkStatus.textContent(), "");
    await pause("history");
    await checkButton.press("Enter");
    await waiting();
    await checkStatus.getByText("Checking the units…", { exact: true }).waitFor();
    assert.equal(await checkStatus.textContent(), "Checking the units…");
    await clickOutside();
    await resume();
    const checkRow = (name) => frame.getByRole("row").filter({ hasText: name });
    await checkRow(flexiName).getByText("Needs review", { exact: true }).waitFor();
    assert.equal(await checkStatus.textContent(), "Compared the units of 2 of 6 holdings.");
    await stayedOutside("Check units");
    await frame.getByText("Wealthfolio doesn't show add-ons the activities of archived accounts, so Archived funds, Old funds aren't compared.", { exact: true }).waitFor();
    assert.deepEqual(await checkRow(flexiName).getByRole("cell").allTextContents().then((cells) => cells.slice(1, 4).map((c) => c.trim())), ["Mutual funds", "2892.104", "2892.104"]);
    // Each holding's Same holdings names it.
    await frame.getByRole("checkbox", { name: `Same holdings for ${flexiName}`, exact: true }).dispatchEvent("click");
    await checkRow(flexiName).getByText("Match", { exact: true }).waitFor();
    // A fund in two accounts is summed once, and a gap shows once its accounts are confirmed.
    assert.deepEqual(await checkRow(balancedName).getByRole("cell").allTextContents().then((cells) => cells.slice(2, 4).map((c) => c.trim())), ["3443.91", "3400"]);
    await checkRow(balancedName).getByText("Mutual funds · 3000").waitFor();
    await checkRow(balancedName).getByText("Not set · 400").waitFor();
    await frame.getByRole("checkbox", { name: `Same holdings for ${balancedName}`, exact: true }).dispatchEvent("click");
    await checkRow(balancedName).getByText("Differ", { exact: true }).waitFor();
    await checkRow(liquidName).getByText("No account that tracks transactions has posted activities for it on or before 2025-03-31.", { exact: true }).waitFor();
    assert.equal(await checkRow(liquidName).getByRole("checkbox").count(), 0);
    assert.equal(await accountData(), before);
    // A check that can't read Wealthfolio's activities compares none, and says so.
    await tab.frames()[1].evaluate(() => { window.host.failHistory = true; });
    await checkButton.press("Enter");
    await checkStatus.getByText("Compared the units of 0 of 6 holdings.", { exact: true }).waitFor();
    await focused(checkButton, "Check units");
    await checkRow(flexiName).getByText("Couldn't read Wealthfolio's activities: Error: History unavailable", { exact: true }).waitFor();
    await tab.frames()[1].evaluate(() => { window.host.failHistory = false; });
    // A check that fails gives the focus back too.
    await hosted(() => { window.host.failSettings = true; });
    await checkButton.press("Enter");
    await frame.getByText("Couldn't check the units: Error: Settings unavailable", { exact: true }).waitFor();
    await focused(checkButton, "Check units, failed");
    await hosted(() => { window.host.failSettings = false; });
    // The next read finds Not set archived, so it isn't compared.
    await editAccounts({ "unset-1": { isArchived: true } });
    await frame.getByRole("button", { name: "Read statement", exact: true }).click();
    await frame.getByText(/^No account tracks holdings\. To save snapshots,/).waitFor({ timeout: 180_000 });
    await frame.getByRole("button", { name: "Check units", exact: true }).click();
    await frame.getByText("Wealthfolio doesn't show add-ons the activities of archived accounts, so Not set, Archived funds, Old funds aren't compared.", { exact: true }).waitFor();
    assert.deepEqual(await checkRow(balancedName).getByRole("cell").allTextContents().then((cells) => cells.slice(1, 4).map((c) => c.trim())), ["Mutual funds", "3443.91", "3000"]);
    assert.equal(await accountData(), before);
    // The check shows only while an account it compares exists: an unarchived one that tracks
    // transactions, Not set and hidden ones included. Each read finds the accounts again.
    const only = async (...ids) => {
      await setAccountList(beforeCheck.filter((a) => ids.includes(a.id)));
      await readHoldingsAgain();
    };
    const noHoldingsAccount = "No account tracks holdings. To save snapshots, add one in Wealthfolio, set to track holdings, then choose Read statement again.";
    const checkShown = async (shown, what) => {
      assert.equal(await frame.getByText("Check against transactions", { exact: true }).count(), shown ? 1 : 0, what);
      assert.equal(await frame.getByRole("button", { name: "Check units", exact: true }).count(), shown ? 1 : 0, what);
    };
    await only("holdings-1", "holdings-2");
    await checkShown(false, "only accounts that track holdings");
    await only("archived-2", "unset-1");
    await editAccounts({ "unset-1": { isArchived: true } });
    await readHoldingsAgain();
    await checkShown(false, "only archived accounts that track transactions");
    // Nor does the Accounts card point to it.
    await frame.getByText(noHoldingsAccount, { exact: true }).waitFor();
    await editAccounts({ "new-3": { name: "New transactions", trackingMode: "TRANSACTIONS" } });
    await readHoldingsAgain();
    await checkShown(true, "a new account that tracks transactions");
    await frame.getByText(`${noHoldingsAccount} The check against transactions below works without one.`, { exact: true }).waitFor();
    await only("unset-1");
    await checkShown(true, "a Not set account");
    await only("hidden-1");
    await checkShown(true, "a hidden account that tracks transactions");
    await setAccountList(beforeCheck);

    // A summary import creates an AMFI fund without an exchange. Searching its ISIN then finds
    // that asset, even if automatic updates have since been turned off. Every fund's ISIN finds one
    // AMFI scheme, so each is confirmed without a click, on the Holdings card too.
    await hosted(() => {
      window.host.providers = "";
      window.host.storage.clear();
      window.host.assets = {};
      window.host.snapshots = {};
      window.host.held = {};
      window.host.activities = [];
      window.host.pricingModes = {};
      window.host.quotes = {};
    });
    await revisit();
    await amfiBanner.waitFor();
    await readHoldingsAgain();
    await choose("All of this statement", "Fund folios (INR)");
    // With AMFI off, the banner says so, and the Holdings card doesn't. Once Check again finds AMFI
    // on, the card's funds are searched again, find AMFI's schemes and are confirmed without a click.
    for (const section of await frame.locator("section").all()) await section.getByRole("radio").first().waitFor({ state: "attached" });
    await noAmfiNote();
    assert.equal(await frame.locator("section").getByText("AMFI", { exact: true }).count(), 0);
    assert.equal(await frame.getByText(/ matched from AMFI /).count(), 0);
    await hosted(() => { window.host.amfi = true; });
    await checkAgain.click();
    await amfiBanner.waitFor({ state: "detached" });
    const summaryLiquid = holding(liquidName);
    const summaryOthers = [flexiName, balancedName, corporate, gilt, "Testbridge Fixed Term Plan - Series 12 - Direct Plan - Growth"];
    await frame.getByText("6 funds matched from AMFI by their ISIN. Change any that look wrong.", { exact: true }).waitFor();
    assert.equal(await frame.locator("section").count(), 0);
    const schemeCodes = await rows.evaluateAll((all) => all.map((row) => row.textContent.match(/Scheme (\d{6})/)[1]));
    assert.equal(schemeCodes.length, 6);
    assert.equal(new Set(schemeCodes).size, schemeCodes.length, "different funds have different AMFI scheme codes");
    const leaveOutOthersThanLiquid = async () => {
      for (const name of summaryOthers) await leaveOut(holding(name));
    };
    await leaveOutOthersThanLiquid();
    await frame.getByText("1 fund matched from AMFI by its ISIN. Change it if it looks wrong.", { exact: true }).waitFor();
    const summaryAmfi = JSON.parse((await storage())["isin:INFZ90K01LQ6"]);
    await preview.click();
    await frame.getByRole("button", { name: "Save 1 snapshot", exact: true }).click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    const amfiSnapshot = await snapshot("holdings-2", "2025-03-31");
    assert.equal(amfiSnapshot.holdings.length, 1);
    assert.deepEqual(
      [amfiSnapshot.holdings[0].symbol, amfiSnapshot.holdings[0].exchangeMic, amfiSnapshot.holdings[0].providerId,
        amfiSnapshot.holdings[0].providerSymbol, amfiSnapshot.holdings[0].instrumentType, amfiSnapshot.holdings[0].quoteCcy],
      [summaryAmfi.symbol, undefined, "AMFI", summaryAmfi.symbol, "MUTUALFUND", "INR"],
    );
    assert.equal(await hosted((code) => window.host.assets[`asset-${code}`].providerId, summaryAmfi.symbol), "AMFI");
    await hosted((code) => { window.host.pricingModes[code] = "MANUAL"; }, summaryAmfi.symbol);
    await readHoldingsAgain();
    await summaryLiquid.getByRole("button", { name: /^Change the / }).click();
    const summaryResults = summaryLiquid.getByRole("radio");
    await summaryResults.nth(1).waitFor({ state: "attached" });
    assert.equal(await summaryResults.count(), 2);
    assert.equal(await summaryResults.first().getAttribute("aria-checked"), "true");
    // Wealthfolio has the fund with AMFI preferred, but priced by hand.
    assert.match(await summaryLiquid.locator("label").first().textContent(), /Priced by hand$/);
    assert.equal(await summaryLiquid.getByText(/priced from AMFI/).count(), 0);
    await summaryLiquid.getByRole("button", { name: /^Use this fund for / }).click();
    const summaryExisting = JSON.parse((await storage())["isin:INFZ90K01LQ6"]);
    assert.equal(summaryExisting.assetId, `asset-${summaryAmfi.symbol}`);
    assert.equal(summaryExisting.providerSymbol, undefined);
    await readHoldingsAgain();
    // Remembered, it's read again: a remembered choice doesn't keep the pricing mode.
    await summaryLiquid.getByText("Priced by hand", { exact: true }).waitFor();
    assert.equal(await summaryLiquid.getByText("AMFI", { exact: true }).count(), 0);
    await leaveOutOthersThanLiquid();
    await preview.click();
    await frame.getByText("Priced by hand: saving also saves the statement's price as its price on this date.", { exact: true }).waitFor();

    // A line whose units can't be read leaves the account's fund as it is, and its units can't be checked.
    await hosted(() => { window.host.summaryMisread = ["INFZ90K01LQ6"]; });
    await readHoldingsAgain();
    const liquidFolio = "Fictiva Mutual Fund, folio 91234567 / 12";
    await frame.getByRole("alert").filter({ hasText: /^Left out/ }).getByText(
      `${liquidName}, ${liquidFolio}: It has no units but a value of ₹35799.22, so the line may have been misread. Check it against the PDF. The import leaves this holding as it is.`,
      { exact: true },
    ).waitFor();
    // Its row says so, as its section does.
    await summaryLiquid.getByText(/(^|· )[Aa] line may have been misread, so the import leaves its holding as it is$/).waitFor();
    await leaveOutOthersThanLiquid();
    await preview.click();
    // The account's AMFI asset, under its own name.
    const heldBackNote = `Its line in ${liquidFolio} may have been misread, so this import leaves it as it is: its units, cost and price stay. Check it against the PDF.`;
    const heldBack = frame.getByRole("table").filter({ hasText: "Total cost" }).getByRole("row").filter({ hasText: heldBackNote });
    await heldBack.getByText(heldBackNote, { exact: true }).waitFor();
    assert.equal(await heldBack.count(), 1);
    await heldBack.getByText(liquidFolio, { exact: true }).waitFor();
    await heldBack.getByText("Kept", { exact: true }).waitFor();
    assert.equal(await heldBack.getByRole("checkbox").count(), 0);
    await frame.getByRole("button", { name: "Check units", exact: true }).click();
    const unknownUnits = frame.getByRole("table").filter({ hasText: "Units in the statement" }).getByRole("row").filter({ hasText: liquidName });
    await unknownUnits.getByText("Needs review", { exact: true }).waitFor();
    assert.deepEqual(await unknownUnits.getByRole("cell").allTextContents().then((cells) => cells.slice(2, 4).map((c) => c.trim())), ["Unknown", ""]);
    await unknownUnits.getByText(`${liquidFolio} (may be misread)`, { exact: true }).waitFor();
    await unknownUnits.getByText(
      `Its line in ${liquidFolio} may have been misread, so its units on the statement are unknown. Check it against the PDF. No account that tracks transactions has posted activities for it on or before 2025-03-31.`,
      { exact: true },
    ).waitFor();
    assert.equal(await unknownUnits.getByRole("checkbox").count(), 0);
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
    await preview.click();
    await frame.getByRole("checkbox", { name: "Replace the snapshot of 2025-03-31 in Fund folios", exact: true }).dispatchEvent("click");
    await frame.getByRole("button", { name: "Save 1 snapshot", exact: true }).click();
    await frame.getByText("Saved 1 snapshot", { exact: true }).waitFor();
    const keptSnapshot = await snapshot("holdings-2", "2025-03-31");
    assert.deepEqual(keptSnapshot.holdings, preservedSnapshot.holdings);
    assert.deepEqual(keptSnapshot.cash, preservedSnapshot.cash);
    assert.deepEqual(await hosted((code) => window.host.quotes[`asset-${code}`], summaryAmfi.symbol), liquidQuotes);
    await hosted(() => { window.host.summaryMisread = []; });
    await hosted(() => { window.host.amfi = false; });

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
      await frame.locator("#cas-file:enabled").waitFor();
      assert.equal(await workers(), before.workers + 1, "a new parser");
      assert.equal(await frame.getByText("Couldn't read the statement", { exact: true }).count(), 0);
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
