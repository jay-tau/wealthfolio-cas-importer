// Counts of one read in the singular, and other counts in the plural, in the detailed import's
// result and Review screen and the holdings Review screen, and the names the Review screens show. Renders the components with Vite's SSR loader and made-up data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { withoutClosed, withReadableNames } from "../src/cas/mapping.ts";
import { dec } from "../src/cas/decimal.ts";
import { plural } from "../src/lib/plural.ts";

let server;
let components;
before(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  components = {
    ...(await server.ssrLoadModule("/src/components/preview.tsx")),
    ...(await server.ssrLoadModule("/src/components/fund-choices.tsx")),
    ...(await server.ssrLoadModule("/src/components/holdings-preview.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/plan-parts.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/asks.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/question.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/header.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/ready.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/parts.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/not-included.tsx")),
    ...(await server.ssrLoadModule("/src/cas/holdings.ts")),
    ...(await server.ssrLoadModule("/src/pages/import-page.tsx")),
    ...(await server.ssrLoadModule("/src/pages/holdings-import.tsx")),
    ...(await server.ssrLoadModule("/src/pages/detailed-import.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/detailed-parts.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/bank-check.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/save-to-detailed.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/save-to.tsx")),
    ...(await server.ssrLoadModule("/src/components/review/funds-ready.tsx")),
    ...(await server.ssrLoadModule("/src/components/account-choices.tsx")),
  };
});
after(() => server?.close());

/** The rendered text, with one space for each tag and run of spaces. */
const text = (name, props) =>
  renderToStaticMarkup(createElement(components[name], props))
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("&#x27;", "'");

test("plural keeps a count of one singular", () => {
  assert.equal(plural(0, "folio"), "0 folios");
  assert.equal(plural(1, "folio"), "1 folio");
  assert.equal(plural(2, "folio"), "2 folios");
  assert.equal(plural(1, "activity", "activities"), "1 activity");
  assert.equal(plural(2, "activity", "activities"), "2 activities");
});

test("the transactions in a statement count each part only when it isn't zero, one in the singular", () => {
  const none = { total: 0, toImport: 0, before: 0, duplicates: 0, answers: 0, earlier: 0, skipped: 0, notImported: 0, unbalanced: 0, leftOut: [] };
  const reversal = (type) => ({ kind: "reversal", reason: "reversed", row: { row: { type } } });
  const parts = (b) => components.breakdownParts({ ...none, ...b });
  assert.deepEqual(parts({ total: 142, toImport: 128, answers: 8, earlier: 4, leftOut: [reversal("PURCHASE"), reversal("REVERSAL")] }), [
    "128 to import", "8 waiting for your answers", "4 waiting for earlier purchases", "2 left out: a reversed purchase and its reversal",
  ]);
  assert.deepEqual(parts({ before: 21, duplicates: 1, skipped: 6, notImported: 3, unbalanced: 2 }), [
    "21 imported before, skipped",
    "1 possible duplicate, waiting for your answer",
    "6 in skipped funds",
    "3 in folios not imported",
    "2 in funds whose rows don't add up, waiting for your answer",
  ]);
  assert.deepEqual(parts({ duplicates: 2, leftOut: [reversal("REDEMPTION"), reversal("PURCHASE"), { kind: "row", reason: "x", row: { row: { type: "MISC" } } }] }), [
    "2 possible duplicates, waiting for your answer",
    "3 left out: a sale and a later row that may reverse it, and 1 more listed under “Not included”",
  ]);
  // What the answers did: one part each.
  assert.deepEqual(parts({ toImport: 12, importedDuplicates: 1, skippedDuplicates: 2, otherDuplicates: 1, skippedUnbalanced: 4 }), [
    "12 to import",
    "1 possible duplicate, imported by your answer",
    "2 possible duplicates, skipped by your answer",
    "1 possible duplicate, skipped",
    "4 in funds whose rows don't add up, skipped by your answer",
  ]);
  assert.deepEqual(parts({ leftOut: [{ kind: "row", reason: "x", row: { row: { type: "MISC" } } }] }), ["1 left out, listed under “Not included”"]);
  const summary = (b) => text("TransactionsSummary", { breakdown: { ...none, ...b }, range: "Apr 2019 to Jun 2026", partId: "t" });
  assert.match(summary({ total: 1, toImport: 1 }), / 1 transaction , Apr 2019 to Jun 2026 1 to import $/);
  assert.equal(components.nothingWords({ ...none, total: 21, before: 21 }), "Nothing new: every transaction on this statement is already in Wealthfolio.");
  assert.equal(components.nothingWords({ ...none, total: 5, before: 3, earlier: 2 }), "Nothing is ready to import. See the transactions left out or waiting above.");
});

/** Made-up bank matches for checking the words and names rendered by a bank question. */
const bankPair = (type, key) => {
  const purchase = type === "PURCHASE";
  return {
    key, exact: true, strong: true, reason: "Same day · names the fund house",
    t: { transaction: { rows: [{ type }], bank: { date: "2026-01-05", amount: "5000", activityType: purchase ? "TRANSFER_OUT" : "TRANSFER_IN" } } },
    entry: { id: key, date: "2026-01-05T00:00:00Z", amount: "5000", activityType: purchase ? "WITHDRAWAL" : "DEPOSIT", comment: "FICTIVA MF" },
  };
};
const bankProps = (pairs, label = "A. Investor's funds · Savings account") => ({
  check: { id: label, bankName: label.split(" · ")[1], label, box: label.split(" · ")[0], pairs }, ticked: new Set(pairs.map((p) => p.key)), facts: new Map(),
  fundName: () => "Fictiva Fund", headingId: "bank-heading", changeId: "bank-change", pairId: (pair) => pair.key,
  onTick() {}, onLink() {}, onNone() {}, onChange() {},
});

test("bank questions describe payout-only and mixed transfers, then the answer's receipt", () => {
  const sale = bankPair("REDEMPTION", "sale");
  const dividend = bankPair("DIVIDEND_PAYOUT", "dividend");
  const payout = bankProps([sale, dividend]);
  const shown = text("BankCheck", payout);
  assert.ok(shown.includes("2 entries already in Savings account look like these payouts"));
  assert.ok(shown.includes("Sale · 5 Jan 2026 · ₹5,000, to Savings account"));
  assert.ok(shown.includes("Cash dividend · 5 Jan 2026 · ₹5,000, to Savings account"));
  assert.ok(shown.includes("Unlinked sales and cash dividends get new transfers to Savings account. If an entry above is that payout, the new transfer would count it twice."));
  assert.equal(components.checkReceipt(payout.check, 0), "Not linked: all 2 payouts get new transfers to Savings account");
  assert.equal(components.checkReceipt(payout.check, 1), "1 of 2 payouts linked to entries already in Savings account; the rest get new transfers");
  const mixed = bankProps([bankPair("PURCHASE", "purchase"), sale, dividend]);
  const both = text("BankCheck", mixed);
  assert.ok(both.includes("3 entries already in Savings account look like these purchases and payouts"));
  assert.ok(both.includes("Purchase · 5 Jan 2026 · ₹5,000, from Savings account"));
  assert.ok(both.includes("Unlinked purchases get new transfers from Savings account; unlinked sales and cash dividends get new transfers back to it. If an entry above is that payment or payout, the new transfer would count it twice."));
  assert.equal(components.checkReceipt(mixed.check, 1), "1 of 3 payments and payouts linked to entries already in Savings account; the rest get new transfers");
  assert.ok(text("BankCheck", { ...mixed, answered: 3 }).includes("All 3 payments and payouts linked to entries already in Savings account"));
});

test("bank actions and receipts name their investor even when two checks use the same bank", () => {
  for (const investor of ["A", "B"]) {
    const label = `${investor}. Investor's funds · Savings account`;
    const props = bankProps([bankPair("DIVIDEND_PAYOUT", investor)], label);
    const markup = (extra = {}) => renderToStaticMarkup(createElement(components.BankCheck, { ...props, ...extra })).replaceAll("&#x27;", "'");
    assert.ok(markup().includes(`aria-label="Link 1 selected: ${label}"`));
    assert.ok(markup().includes(`aria-label="Create new transfers instead: ${label}"`));
    // Change answer's name is its line, which names the bank once, then the box.
    const receiptName = markup({ answered: 1 }).match(/aria-label="(Change answer:[^"]+)"/)?.[1];
    assert.equal(receiptName, `Change answer: The payout is linked to an entry already in Savings account, for ${investor}. Investor's funds`);
  }
  // A bank whose name another account has too is told apart the same way in its line and Change answer's name.
  const told = bankProps([bankPair("DIVIDEND_PAYOUT", "n")], "A. Investor's funds · Savings account (ending 4821)");
  const answered = renderToStaticMarkup(createElement(components.BankCheck, { ...told, answered: 0 })).replaceAll("&#x27;", "'").replaceAll("<!-- -->", "");
  assert.ok(answered.includes(">Not linked: the payout gets a new transfer to Savings account (ending 4821)</span>"));
  assert.match(answered, /aria-label="Change answer: Not linked: the payout gets a new transfer to Savings account \(ending 4821\), for A\. Investor's funds"/);
});

test("equal bank pairs keep their visible labels and distinct names within and across checks", () => {
  const contexts = [];
  for (const investor of ["A", "B"]) {
    const label = `${investor}. Investor's funds · Savings account`;
    const pairs = [1, 2].map((n) => bankPair("DIVIDEND_PAYOUT", `${investor}-${n}`));
    const markup = renderToStaticMarkup(createElement(components.BankCheck, bankProps(pairs, label))).replaceAll("&#x27;", "'").replaceAll("<!-- -->", "");
    pairs.forEach((pair, i) => {
      assert.ok(markup.includes(`aria-labelledby="${pair.key}-fund ${pair.key}-movement ${pair.key}-entry ${pair.key}-context"`));
      const context = markup.match(new RegExp(`id="${pair.key}-context"[^>]*>([^<]+)</span>`))?.[1];
      assert.equal(context, `Pair ${i + 1}: ${label}`);
      contexts.push(context);
    });
  }
  assert.equal(new Set(contexts).size, 4);
});

test("earlier-purchase help and Change distinguish equal funds and their separate reasons", () => {
  const earlier = [1, 2].map((n) => ({ key: String(n), name: "Fictiva Fund", units: "10.000 units", waiting: 1 }));
  const props = {
    earlier, unbalanced: earlier.map((fund, i) => ({ id: `unbalanced|${fund.key}`, key: fund.key, name: fund.name, label: `${fund.name}, fund ${i + 1}` })),
    skipped: [], notImported: [], leftOut: [], registrar: "CAMS", open: {}, setOpen() {},
    partId: "not-included", changeId: (key) => key, onChange() {}, onReopen() {}, changePanel: () => null,
  };
  const markup = renderToStaticMarkup(createElement(components.NotIncludedDetailed, props));
  for (const n of [1, 2]) {
    assert.ok(markup.includes(`aria-label="How to fix: Fictiva Fund, fund ${n}"`));
    assert.ok(markup.includes(`aria-label="Change: Fictiva Fund, fund ${n}, earlier purchases needed"`));
    assert.ok(markup.replaceAll("&#x27;", "'").includes(`aria-label="Change: Fictiva Fund, fund ${n}, transactions don't add up"`));
  }
  const shown = text("NotIncludedDetailed", props);
  assert.ok(shown.includes("Earlier purchases needed : Fictiva Fund starts with 10.000 units bought before this statement, so its 1 transaction waits. Change How to fix"));
  assert.ok(shown.includes("Skipped because their transactions don't add up (2) , by your answer: Fictiva Fund · Change Fictiva Fund · Change"));
});

test("a fund waiting for earlier purchases in two accounts says how many units each needs and from which folios", () => {
  const props = (accounts, units) => ({
    earlier: [{ key: "1", name: "Fictiva Liquid Fund", units, waiting: 12, accounts }],
    unbalanced: [], skipped: [], notImported: [], leftOut: [], registrar: "CAMS", open: { "how:1": true }, setOpen() {},
    partId: "not-included", changeId: (key) => key, onChange() {}, onReopen() {}, changePanel: () => null,
  });
  const two = text("NotIncludedDetailed", props([
    { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
    { units: "200.000", account: "Funds (ending 4821)", folios: ["91234567", "3301"] },
  ], "300.000 units"));
  assert.ok(two.includes(
    "Earlier purchases needed : Fictiva Liquid Fund starts with 300.000 units bought before this statement, so its 12 transactions wait. " +
    "Units needed: 100.000 in Mutual funds, from folio 7712045; 200.000 in Funds (ending 4821), from folios 91234567 and 3301. Change How to fix " +
    "Read an earlier CAMS statement that includes its first purchase, or add the units in Wealthfolio as buys with their cost and date: " +
    "100.000 units in Mutual funds, from folio 7712045; 200.000 units in Funds (ending 4821), from folios 91234567 and 3301. " +
    "Then read this statement again: transactions already imported are skipped.",
  ), two);
  // Only one of its accounts waits: that one is still named.
  const one = text("NotIncludedDetailed", props([{ units: "200.000", account: "Family funds", folios: ["91234567"] }], "200.000 units"));
  assert.ok(one.includes("so its 12 transactions wait. Units needed: 200.000 in Family funds, from folio 91234567. Change How to fix"), one);
  assert.ok(one.includes("or add the units in Wealthfolio as a buy with their cost and date: 200.000 units in Family funds, from folio 91234567. Then"), one);
  // In one account, the line and How to fix say the units as before.
  const plain = text("NotIncludedDetailed", props(undefined, "300.000 units"));
  assert.ok(plain.includes("so its 12 transactions wait. Change How to fix Read an earlier CAMS statement that includes its first purchase, " +
    "or add the 300.000 units in Wealthfolio as a buy with their cost and date. Then read this statement again"), plain);
});

test("a fund waiting for earlier purchases in a new account this import won't create says to create one first", () => {
  const props = (fund) => ({
    earlier: [{ key: "1", name: "Fictiva Liquid Fund", units: "100.000 units", waiting: 3, ...fund }],
    unbalanced: [], skipped: [], notImported: [], leftOut: [], registrar: "CAMS", open: { "how:1": true }, setOpen() {},
    partId: "not-included", changeId: (key) => key, onChange() {}, onReopen() {}, changePanel: () => null,
  });
  // In one account.
  const one = text("NotIncludedDetailed", props({ uncreated: [{ account: "Mutual funds", folios: ["7712045"] }] }));
  assert.ok(one.includes(
    "Earlier purchases needed : Fictiva Liquid Fund starts with 100.000 units bought before this statement, so its 3 transactions wait. " +
    "The new account Mutual funds won't be created: nothing ready to import goes into it. Change How to fix " +
    "Read an earlier CAMS statement that includes its first purchase, then this one again. Or, as Mutual funds doesn't exist yet, " +
    "create an account that tracks transactions in Wealthfolio, add the 100.000 units there as a buy with their cost and date, " +
    "then read this statement again and choose that account in “Save to”. Transactions already imported are skipped.",
  ), one);
  // In two accounts, one of them new and not created.
  const accounts = [
    { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
    { units: "200.000", account: "Family funds", folios: ["91234567", "3301"] },
  ];
  const two = text("NotIncludedDetailed", props({ units: "300.000 units", accounts, uncreated: [{ account: "Family funds", folios: ["91234567", "3301"] }] }));
  assert.ok(two.includes(
    "Units needed: 100.000 in Mutual funds, from folio 7712045; 200.000 in Family funds, from folios 91234567 and 3301. " +
    "The new account Family funds won't be created: nothing ready to import goes into it. Change How to fix " +
    "Read an earlier CAMS statement that includes its first purchase, then this one again. Or, as Family funds doesn't exist yet, " +
    "first create an account that tracks transactions in Wealthfolio for its units, then add the units in Wealthfolio as buys with their cost and date: " +
    "100.000 units in Mutual funds, from folio 7712045; 200.000 units in Family funds, from folios 91234567 and 3301. " +
    "Then read this statement again and choose it in “Save to” for folios 91234567 and 3301. Transactions already imported are skipped.",
  ), two);
  // Both new and not created.
  const both = text("NotIncludedDetailed", props({ units: "300.000 units", accounts, uncreated: accounts.map(({ account, folios }) => ({ account, folios })) }));
  assert.ok(both.includes("The new accounts Mutual funds and Family funds won't be created: nothing ready to import goes into them. Change How to fix"), both);
  assert.ok(both.includes(
    "Or, as Mutual funds and Family funds don't exist yet, first create accounts that track transactions in Wealthfolio for their units, " +
    "then add the units in Wealthfolio as buys with their cost and date: " +
    "100.000 units in Mutual funds, from folio 7712045; 200.000 units in Family funds, from folios 91234567 and 3301. " +
    "Then read this statement again and choose them in “Save to” for their folios. Transactions already imported are skipped.",
  ), both);
  // A new account this import creates: as before.
  const created = text("NotIncludedDetailed", props({ uncreated: [] }));
  assert.ok(created.includes("so its 3 transactions wait. Change How to fix Read an earlier CAMS statement that includes its first purchase, " +
    "or add the 100.000 units in Wealthfolio as a buy with their cost and date. Then read this statement again: transactions already imported are skipped."), created);
});

test("a fund waiting for earlier purchases says what each account already has of them, and what to do", () => {
  const props = (accounts) => ({
    earlier: [{ key: "1", name: "Fictiva Liquid Fund", units: "100.000 units", waiting: 12, accounts }],
    unbalanced: [], skipped: [], notImported: [], leftOut: [], registrar: "CAMS", from: "1 Apr 2023", open: { "how:1": true }, setOpen() {},
    partId: "not-included", changeId: (key) => key, onChange() {}, onReopen() {}, changePanel: () => null,
  });
  const mf = (held, folios = ["7712045"]) => ({ units: "100.000", account: "Mutual funds", folios, held });
  const shown = (held, folios) => text("NotIncludedDetailed", props([mf(held, folios)]));
  const line = "Earlier purchases needed : Fictiva Liquid Fund starts with 100.000 units bought before this statement, so its 12 transactions wait. Units needed: 100.000 in Mutual funds, from folio 7712045";
  const then = "Then read this statement again: transactions already imported are skipped.";

  // Some of them: how many it has and how many to add.
  let shows = shown({ kind: "short", has: "50.000", add: "50.000" });
  assert.ok(shows.includes(`${line} (50.000 in this account before 1 Apr 2023, so 50.000 to add). Change How to fix ` +
    "Read an earlier CAMS statement that includes its first purchase, or add the units in Wealthfolio as a buy with their cost and date: " +
    `50.000 units in Mutual funds, from folio 7712045 (50.000 in this account before 1 Apr 2023). ${then}`), shows);
  // More sold than bought.
  shows = shown({ kind: "short", has: "−20.000", add: "120.000" });
  assert.ok(shows.includes(`${line} (−20.000 in this account before 1 Apr 2023, so 120.000 to add). Change How to fix `), shows);
  assert.ok(shows.includes(": 120.000 units in Mutual funds, from folio 7712045 (−20.000 in this account before 1 Apr 2023). Then"), shows);
  // More than its folios start with: how many too many, and to check them rather than add any.
  shows = shown({ kind: "over", has: "150.000", extra: "50.000" });
  assert.ok(shows.includes(`${line} (150.000 in this account before 1 Apr 2023, so 50.000 too many). Change How to fix ` +
    "In Mutual funds, this fund's transactions before 1 Apr 2023 come to 150.000 units, 50.000 more than the 100.000 that folio 7712045 starts with: " +
    `check them in Wealthfolio, and correct or delete the ones that don't belong. ${then}`), shows);
  assert.ok(!shows.includes("Read an earlier"), shows);
  // None can be counted: the split, and what to check, rather than units to add.
  shows = shown({ kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }] });
  assert.ok(shows.includes(`${line} (a split on 5 Jan 2022 in this account keeps the fund's units from being counted). Change How to fix ` +
    "In Mutual funds, the add-on can't count this fund's units across a split on 5 Jan 2022, so it can't check that they come to the 100.000 that folio 7712045 starts with. " +
    `Check it in Wealthfolio: if it's wrong, delete it; if not, add this statement's transactions for this fund from folio 7712045 in Wealthfolio by hand: the add-on will still leave them out. ${then}`), shows);
  assert.ok(!shows.includes("Read an earlier"), shows);
  shows = shown({ kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }, { day: "3 Mar 2022", kind: "split" }, { day: "1 Jun 2022", kind: "option expiry" }] }, ["7712045", "3301"]);
  assert.ok(shows.includes("from folios 7712045 and 3301 (splits on 5 Jan 2022 and 3 Mar 2022 and an option expiry on 1 Jun 2022 in this account keep the fund's units from being counted)."), shows);
  assert.ok(shows.includes("so it can't check that they come to the 100.000 that folios 7712045 and 3301 start with. Check them in Wealthfolio: if they're wrong, delete them;"), shows);

  // Option expiries on their own, singular and plural.
  for (const days of [["1 Jun 2022"], ["1 Jun 2022", "1 Aug 2022"]]) {
    shows = shown({ kind: "uncounted", by: days.map((day) => ({ day, kind: "option expiry" })) });
    assert.ok(shows.includes(days.length === 1 ? "an option expiry on 1 Jun 2022 in this account keeps" : "option expiries on 1 Jun 2022 and 1 Aug 2022 in this account keep"), shows);
    assert.ok(shows.includes("the add-on will still leave them out"), shows);
    assert.ok(!shows.includes("Read an earlier"), shows);
  }

  // Each account in its own way, those to add together.
  shows = text("NotIncludedDetailed", props([
    { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
    { units: "200.000", account: "Family funds", folios: ["91234567"], held: { kind: "short", has: "150.000", add: "50.000" } },
    { units: "250.000", account: "Funds (ending 4821)", folios: ["3301", "3302"], held: { kind: "over", has: "300.000", extra: "50.000" } },
  ]));
  assert.ok(shows.includes("Units needed: 100.000 in Mutual funds, from folio 7712045; 200.000 in Family funds, from folio 91234567 (150.000 in this account before 1 Apr 2023, so 50.000 to add); " +
    "250.000 in Funds (ending 4821), from folios 3301 and 3302 (300.000 in this account before 1 Apr 2023, so 50.000 too many). Change How to fix " +
    "Read an earlier CAMS statement that includes its first purchase, or add the units in Wealthfolio as buys with their cost and date: " +
    "100.000 units in Mutual funds, from folio 7712045; 50.000 units in Family funds, from folio 91234567 (150.000 in this account before 1 Apr 2023). " +
    "In Funds (ending 4821), this fund's transactions before 1 Apr 2023 come to 300.000 units, 50.000 more than the 250.000 that folios 3301 and 3302 start with:"), shows);

  // Check existing history before either reread path; only accounts needing units get buys.
  for (const [held, check] of [
    [{ kind: "short", has: "200.000", add: "50.000" }, ""],
    [{ kind: "over", has: "300.000", extra: "50.000" },
      "In Family funds, this fund's transactions before 1 Apr 2023 come to 300.000 units, 50.000 more than the 250.000 that folio 3301 starts with: " +
      "check them in Wealthfolio, and correct or delete the ones that don't belong. "],
    [{ kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }] },
      "In Family funds, the add-on can't count this fund's units across a split on 5 Jan 2022, so it can't check that they come to the 250.000 that folio 3301 starts with. " +
      "Check it in Wealthfolio: if it's wrong, delete it; if not, add this statement's transactions for this fund from folio 3301 in Wealthfolio by hand: the add-on will still leave them out. "],
  ]) {
    const mixed = props([
      { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
      { units: "250.000", account: "Family funds", folios: ["3301"], held },
    ]);
    Object.assign(mixed.earlier[0], { units: "350.000 units", uncreated: [{ account: "Mutual funds", folios: ["7712045"] }] });
    shows = text("NotIncludedDetailed", mixed);
    assert.ok(shows.includes("The new account Mutual funds won't be created: nothing ready to import goes into it. Change How to fix " + check +
      "Read an earlier CAMS statement that includes its first purchase, then this one again. Or, as Mutual funds doesn't exist yet, " +
      "first create an account that tracks transactions in Wealthfolio for its units, then add the units in Wealthfolio as " +
      (held.kind === "short" ? "buys" : "a buy") + " with their cost and date: 100.000 units in Mutual funds, from folio 7712045" +
      (held.kind === "short" ? "; 50.000 units in Family funds, from folio 3301 (200.000 in this account before 1 Apr 2023)" : "") +
      ". Then read this statement again and choose it in “Save to” for folio 7712045. Transactions already imported are skipped."), shows);
  }
});

test("one fund's Ready and Not included Change controls have distinct names", () => {
  const item = { key: "fund", name: "Fictiva Fund", noun: "fund" };
  const ready = createElement(components.FundsReadyTable, {
    ctx: {}, rows: [{ id: "mf|fund", item, items: [item], name: item.name, label: item.name, by: "before",
      fund: { symbol: "123456", name: item.name, quoteCcy: "INR", providerId: "AMFI" },
      group: { sent: 1, before: 0 }, groupTitle: "To Mutual funds", unitsAfter: "10.000", touched: false }],
    wide: true, showAll: false, onShowAll() {}, showAllId: "all",
    handlers: { ids: () => ({ change: "ready-change" }), label: () => item.name, nag: false, onChange() {}, changePanel: () => null },
  });
  const leftOut = {
    earlier: [], skipped: [], notImported: [], unbalanced: [],
    leftOut: [{ key: item.key, name: item.name, label: item.name, canChange: true, lines: [{ when: "5 Jan 2026", reason: "This row isn't supported." }] }],
    registrar: "CAMS", open: {}, setOpen() {}, partId: "not-included", changeId: () => "left-change",
    onChange() {}, onReopen() {}, changePanel: () => null,
  };
  const markup = renderToStaticMarkup(createElement("div", null, ready, createElement(components.NotIncludedDetailed, leftOut)));
  const names = [...markup.matchAll(/aria-label="(Change:[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, ["Change: Fictiva Fund", "Change: Fictiva Fund, not included"]);
  assert.ok(text("NotIncludedDetailed", leftOut).includes("Fictiva Fund · Change"));
});

test("Rename distinguishes equal new account names by the investor or source they belong to", () => {
  const labels = ["A. Investor's funds", "B. Investor's funds"];
  const markup = renderToStaticMarkup(createElement("div", null, ...labels.map((label, i) =>
    createElement(components.NewAccountLine, {
      key: i, proposed: { id: `new-account:${i}`, name: "Family funds" }, label,
      ids: { rename: `rename-${i}`, field: `field-${i}` }, onRename() {}, onDraft() {}, onSave() {}, onCancel() {},
    })))).replaceAll("&#x27;", "'");
  const names = [...markup.matchAll(/aria-label="(Rename[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, labels.map((label) => `Rename the new account Family funds: ${label}`));
  assert.equal((markup.match(/>Rename<\/button>/g) ?? []).length, 2);
});

test("bank choices and folio disclosures distinguish PAN boxes whose investors have the same name", () => {
  const boxes = ["ABCDE1234F", "PQRST5678G"].map((pan) => ({
    key: pan, name: "A. Investor", title: `A. Investor (PAN ${pan})'s funds`, pan: true, folios: [],
  }));
  const props = {
    boxes, targets: [{ id: "mf", name: "Mutual funds", currency: "INR" }], labels: new Map([["mf", { text: "Mutual funds", option: "Mutual funds (INR)" }]]),
    proposed: (key) => ({ id: `new-account:${key}`, name: "Mutual funds 2" }), newLine: () => null,
    values: Object.fromEntries(boxes.flatMap((box) => [[box.key, "mf"], [`bank-${box.key}`, ""]])),
    ignored: {}, conflicts: new Set(), remembered: "none", open: {}, onOpen() {}, onChange() {}, checks: () => null, partId: "save-to",
  };
  const shown = text("SaveToDetailed", props);
  const markup = renderToStaticMarkup(createElement(components.SaveToDetailed, props)).replaceAll("&#x27;", "'");
  for (const box of boxes) {
    assert.ok(shown.includes(`Bank account for purchases and payouts (optional) : ${box.title}`));
    assert.ok(markup.includes(`aria-label="Save part of it to another account: ${box.title}"`));
  }
});

test("Save to says where an account's number comes from when nothing else tells two of one name apart, read with each select", async () => {
  const { accountLabels } = await server.ssrLoadModule("/src/lib/account-labels.ts");
  const targets = ["a", "b"].map((id) => ({ id, name: "Funds", currency: "INR", trackingMode: "HOLDINGS" }));
  const props = (accounts) => ({
    investorName: "A. Investor", investorKey: "pan", sources: [], targets: accounts, labels: accountLabels(accounts), proposed: () => undefined, newLine: () => null,
    values: { pan: "b" }, ignored: {}, remembered: true, open: false, onOpen() {}, onChange() {}, partId: "save-to",
  });
  const note = "A number after a name, as in Funds (account 1), is the account's place among the accounts of that name in Wealthfolio under Settings → Accounts, counting hidden and archived ones. Giving them different names in Wealthfolio tells them apart.";
  const shown = text("SaveTo", props(targets));
  assert.ok(shown.includes(note), shown);
  assert.ok(shown.includes("Funds (account 2)"), shown);
  assert.match(renderToStaticMarkup(createElement(components.SaveTo, props(targets))), /aria-describedby="save-to-numbered"/);
  // Told apart by their account numbers, they need no note.
  const numbered = targets.map((a, i) => ({ ...a, accountNumber: `00${i}` }));
  assert.ok(!text("SaveTo", props(numbered)).includes("A number after a name"));
  assert.ok(!renderToStaticMarkup(createElement(components.SaveTo, props(numbered))).includes("aria-describedby"));
});

/** A search state with nothing searched yet, and searches that do nothing, for rendering a question. */
const idle = { text: "" };
const searches = { get: () => idle, retry() {}, search() {}, setText() {}, pick() {}, settle() {}, interact() {} };

test("controls distinguish equal holding names", () => {
  const share = (isin) => ({ kind: "share", name: "Example Share", isin, rta: null, rtaCode: null, units: "10", price: "2", value: "20", cost: null });
  const first = share("INEZ90A01017");
  const holdings = { date: "2025-03-31", sources: [
    { id: "demat|1", kind: "demat", label: "Made-up demat", holdings: [first, { ...share("INEZ90B01015"), name: "Example  Share" }] },
  ] };
  // Each question's controls end with the holding's name, numbered.
  const items = components.holdingItems(holdings);
  items.forEach((item, i) => {
    const label = `${item.name.replace(/\s+/g, " ")}, share ${i + 1}`;
    const props = { item, label, units: "10 shares", search: idle, searches, base: `q${i}`, amfiOn: false, headingId: `h${i}`, onAnswer() {} };
    const markup = renderToStaticMarkup(createElement(components.QuestionCard, props)).replace(/\s+/g, " ");
    assert.ok(text("QuestionCard", props).includes(`Search by ISIN for ${label}`), label);
    for (const name of [`Search for ${label}`, `Use the price on the statement for ${label}`, `Skip this holding: ${label}`]) {
      assert.ok(markup.includes(`aria-label="${name}"`) || text("QuestionCard", props).includes(name), name);
    }
  });
  // Ready rows: each Change, Add cost and Edit names its row, numbered when names repeat.
  const fund = { symbol: "INEZ90A01017", exchangeMic: "XBOM", quoteCcy: "INR", name: "Example Share", providerId: "YAHOO" };
  const row = (i, cost) => ({
    id: `a|${i}`, accountId: "a", accountName: "Demat", item: items[0], items: [items[0]], fund, by: "auto", name: "Example Share", label: `Example Share, holding ${i}`,
    units: "10 shares", cost, notes: [], touched: false, position: { key: String(i), ref: String(i), lines: [], value: "20", notes: [], include: true, order: i },
  });
  const handlers = {
    ids: (r) => ({ change: `c${r.id}`, cost: `k${r.id}`, field: `f${r.id}` }), label: (r, item) => `${item.name} in ${r.accountName}`, nag: false, changePanel: () => null,
    onChange() {}, onCost() {}, onDraft() {}, onSaveCost() {}, onCancelCost() {},
  };
  const ready = renderToStaticMarkup(createElement(components.ReadyTable, {
    ctx: {}, rows: [row(1), row(2, { total: "100", from: "typed" })], date: "2025-03-31", wide: true, showAll: false, onShowAll() {}, showAllId: "all", handlers,
  })).replace(/\s+/g, " ");
  for (const name of ["Change: Example Share, holding 1", "Change: Example Share, holding 2", "Add cost: Example Share, holding 1", "Edit: purchase cost of Example Share, holding 2"]) {
    assert.ok(ready.includes(`aria-label="${name}"`), name);
  }
  // A question's answers each name what they act on, after their visible labels, the safe one first;
  // Why am I asked? names its question.
  const ask = (n) => renderToStaticMarkup(createElement(components.AskCard, {
    headingId: `h${n}`, title: "Old Fund isn't on this statement", target: `Old Fund in Demat, holding ${n}`, children: "Demat holds 5.000 units of it.",
    main: { label: "Keep 5.000 units", name: `Keep 5.000 units: Old Fund in Demat, holding ${n}`, onClick() {} },
    other: { label: "Set it to zero on 31 Mar", name: `Set it to zero on 31 Mar: Old Fund in Demat, holding ${n}`, onClick() {} },
    why: { text: "Why.", open: false, onOpenChange() {} },
  })).replace(/\s+/g, " ").replaceAll("&#x27;", "'");
  for (const n of [1, 2]) {
    for (const name of [`Keep 5.000 units: Old Fund in Demat, holding ${n}`, `Set it to zero on 31 Mar: Old Fund in Demat, holding ${n}`, `Why am I asked? Old Fund isn't on this statement: Old Fund in Demat, holding ${n}`]) {
      assert.ok(ask(n).includes(`aria-label="${name}"`), name);
    }
    // Answered, Change answer's name is its line, which names the question once, with what tells
    // equal lines apart.
    const answered = renderToStaticMarkup(createElement(components.AskAnswered, {
      text: "Old Fund: 5.000 units kept in Demat", name: `Old Fund: 5.000 units kept in Demat, account ${n}`, buttonId: `answer-${n}`, onChange() {},
    }));
    assert.ok(answered.includes(`aria-label="Change answer: Old Fund: 5.000 units kept in Demat, account ${n}"`));
    assert.ok(answered.includes(">Old Fund: 5.000 units kept in Demat</span>"));
  }
  const single = renderToStaticMarkup(createElement(components.AskAnswered, { text: "Old Fund: 5.000 units kept in Demat", buttonId: "answer", onChange() {} }));
  assert.ok(single.includes(`aria-label="Change answer: Old Fund: 5.000 units kept in Demat"`));
  assert.match(ask(1), /<h4 id="h1" tabindex="-1"[^>]*>Old Fund isn't on this statement<\/h4>/);
  // Nothing is chosen yet, so neither answer looks chosen: both are outline buttons, the safe one first.
  assert.deepEqual([...ask(1).matchAll(/<button[^>]*data-variant="([^"]+)"[^>]*aria-label="([^":]+):/g)].map((m) => [m[2], m[1]]),
    [["Keep 5.000 units", "outline"], ["Set it to zero on 31 Mar", "outline"], ["Why am I asked? Old Fund isn't on this statement", "link"]]);
  // A caution is said under the buttons and tied to the other answer, which it's about.
  const cautioned = renderToStaticMarkup(createElement(components.AskCard, {
    headingId: "h3", title: "Folio 1 now goes to Funds", target: "Old Fund in Demat", children: "Demat holds 5.000 units of Old Fund that this folio added.",
    main: { label: "Keep them in Demat", name: "Keep them in Demat: Old Fund in Demat", onClick() {} },
    other: { label: "Remove them from Demat", name: "Remove them from Demat: Old Fund in Demat", onClick() {} },
    caution: "Remove them only if all of them came from this folio.",
  })).replaceAll("&#x27;", "'");
  const caution = cautioned.match(/<p id="([^"]+)"[^>]*>Remove them only if all of them came from this folio\.<\/p>/);
  assert.ok(caution);
  assert.match(cautioned, new RegExp(`aria-label="Remove them from Demat: Old Fund in Demat" aria-describedby="${caution[1]}"`));
  assert.doesNotMatch(cautioned, new RegExp(`aria-label="Keep them in Demat: Old Fund in Demat" aria-describedby=`));
});

test("ready rows in different accounts still fold until Show all, keeping rows that need attention", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `row-${i}`, accountId: i < 4 ? "a" : "b", accountName: i < 4 ? "Demat" : "Fund folios",
    name: `Holding ${i + 1}`, label: `Holding ${i + 1}`, item: { noun: "share", name: `Holding ${i + 1}` }, items: [{ noun: "share", name: `Holding ${i + 1}` }],
    fund: { symbol: `EXAMPLE${i}`, name: `Holding ${i + 1}`, quoteCcy: "INR", providerId: "YAHOO" },
    by: "before", units: "10 shares", cost: i === 4 ? undefined : { total: "100", from: "typed" },
    notes: [], touched: i === 5, position: { value: "200", lines: [] },
  }));
  const handlers = {
    ids: (r, item = r.item) => ({ change: `c-${r.id}-${item.key ?? "first"}`, cost: `k-${r.id}`, field: `f-${r.id}` }),
    label: (r, item) => `${item.name} in ${r.accountName}`, nag: false, changePanel: () => null,
    onChange() {}, onCost() {}, onDraft() {}, onSaveCost() {}, onCancelCost() {},
  };
  const props = { ctx: {}, rows, date: "2025-03-31", showAll: false, onShowAll() {}, showAllId: "all", handlers };
  const shown = (extra) => renderToStaticMarkup(createElement(components.ReadyTable, { ...props, ...extra }));
  const names = (markup) => [...markup.matchAll(/aria-label="Change: Holding (\d+)"/g)].map((match) => Number(match[1]));
  for (const wide of [true, false]) {
    const folded = shown({ wide });
    assert.deepEqual(names(folded), [1, 2, 3, 5, 6]);
    assert.ok(folded.includes("To Demat") && folded.includes("To Fund folios"));
    assert.match(text("ReadyTable", { ...props, wide }), /Show all 8 \(3 more, nothing to check\)/);
    const all = shown({ wide, showAll: true });
    assert.deepEqual(names(all), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(!all.includes("Show all"));
  }
  const direct = "Example Fund - Direct Plan - Growth";
  const regular = "Example Fund - Regular Plan - Growth";
  const merged = {
    ...rows[0], name: "Example Fund", label: "Example Fund", units: "20.000 units",
    item: { key: "direct", noun: "fund", name: direct },
    items: [{ key: "direct", noun: "fund", name: direct }, { key: "regular", noun: "fund", name: regular }],
    fund: { ...rows[0].fund, name: direct },
    position: { value: "400", lines: [direct, regular].map((name) => ({ holding: { kind: "fund", name } })) },
  };
  assert.ok(text("ReadyTable", { ...props, rows: [merged], wide: true }).includes(
    "Statement: Regular · Growth. Chosen: Direct · Growth. Different plan.",
  ));
  for (const wide of [true, false]) {
    const markup = shown({ rows: [merged], wide });
    assert.ok(text("ReadyTable", { ...props, rows: [merged], wide }).includes(`On your statement: ${regular}`));
    assert.ok(markup.includes(`aria-label="Change: ${regular} in Demat"`));
    assert.ok(markup.includes('id="c-row-0-regular"'));
  }
  const noPlan = { key: "unknown", noun: "fund", name: "Example Fund" };
  const unnamed = {
    ...merged, item: noPlan, items: [noPlan],
    fund: { ...merged.fund, symbol: "0P0000UNNAMED.BO", name: "0P0000UNNAMED.BO", providerId: "YAHOO" },
    position: { value: "400", lines: [{ holding: { kind: "fund", name: noPlan.name } }] },
  };
  assert.ok(text("ReadyTable", { ...props, rows: [unnamed], wide: true }).includes("Chosen listing's plan and option are unknown."));
});

test("rows left out so that units aren't counted twice say why, each with its Change", () => {
  const shown = text("NotIncluded", {
    tracked: [], counted: [], skipped: [], unsaved: [], lines: [], open: {}, setOpen() {}, onSaveBoth() {}, onDontSave() {}, onReview() {}, partId: "n",
    defaulted: [
      { key: "a", name: "Example Fund", notes: ["Demat keeps Example Fund (OLD) for now, by your answer above."], change: createElement("button", null, "Change") },
      { key: "b", name: "Other Fund", notes: [], change: createElement("button", null, "Change"), panel: createElement("div", null, "Change panel") },
    ],
  });
  assert.ok(shown.includes("Left out, so units aren't counted twice (2) Example Fund Change Demat keeps Example Fund (OLD) for now, by your answer above. Other Fund Change Change panel"));
});

test("the read-only snapshot keeps an existing cost's currency while statement costs stay in rupees", () => {
  const prior = (ref, cost) => ({ assetId: ref, symbol: ref, ref, name: ref, units: "10", cost, currency: "USD" });
  const kept = { key: "kept", ref: "kept", name: "Kept dollar fund", include: true, lines: [], notes: [], existing: prior("kept", "100") };
  const statement = (key, include, cost) => ({
    key, ref: key, name: key, include, notes: [], units: "20", value: "300", cost: { total: "200", from: "statement" },
    lines: [{ source: { label: "Example folio" }, holding: { name: key } }], existing: prior(key, cost),
  });
  const shown = text("SnapshotTable", {
    plan: { date: "2025-03-31", positions: [kept, statement("excluded", false, "75"), statement("included", true, "50")], existing: { date: "2025-02-28", cash: {} } },
    choices: { flipped: new Set(), costs: new Map() }, account: "Example account",
  });
  assert.ok(shown.includes("USD 100"), shown);
  assert.ok(shown.includes("USD 75"), shown);
  assert.ok(shown.includes("₹200"), shown);
  assert.ok(!shown.includes("₹100") && !shown.includes("₹75"), shown);
});

test("the read-only snapshot's name reads naturally for an account named for its holdings", () => {
  const markup = renderToStaticMarkup(createElement(components.SnapshotTable, {
    plan: { date: "2026-03-31", positions: [], existing: { date: "2026-02-28", cash: {} } },
    choices: { flipped: new Set(), costs: new Map() }, account: "CDSL holdings",
  }));
  assert.ok(markup.includes('aria-label="Holdings in CDSL holdings on 31 Mar 2026 after saving"'), markup);
  assert.ok(!markup.includes("holdings&#x27;s"), markup);
});

test("an account's holdings that weren't saved are named without a possessive", () => {
  const { accountWords } = components;
  const outcome = { key: "a", name: "CDSL holdings", date: "2026-03-31", holdings: 3, state: "failed" };
  assert.equal(accountWords(outcome), "3 holdings in CDSL holdings on 31 Mar weren't saved.");
  assert.equal(accountWords({ ...outcome, holdings: 1 }), "1 holding in CDSL holdings on 31 Mar wasn't saved.");
});

test("tracked fund actions distinguish equal names and comparison links name each account separately", () => {
  for (const names of [["First funds", "Second funds"], ["Funds, account 1", "Funds, account 2"]]) {
    const accounts = names.map((name, i) => ({ id: `a${i}`, name }));
    const group = names.join(", ");
    const funds = [1, 2].map((n) => ({
      key: `fund${n}`, name: "Example Fund", label: `Example Fund, fund ${n}`, units: "20.000 units", canSave: true, included: false,
      comparison: n === 1 ? { kind: "differ", theirs: "9.000 units", ours: "20.000", accountName: group, accounts } : { kind: "match" },
    }));
    const props = {
      tracked: [{ accounts: group, funds }], counted: [], skipped: [], unsaved: [], defaulted: [], lines: [],
      open: { [`show:${group}`]: true }, setOpen() {}, onSaveBoth() {}, onDontSave() {}, onReview() {}, partId: "not-included",
    };
    const markup = renderToStaticMarkup(createElement(components.NotIncluded, props));
    for (const n of [1, 2]) assert.ok(markup.includes(`aria-label="Save in both accounts: Example Fund, fund ${n}"`));
    const shown = text("NotIncluded", props);
    for (const name of names) {
      assert.ok(shown.includes(`Review its transactions in ${name}`), shown);
    }
    assert.ok(!shown.includes(`Review its transactions in ${group}`), shown);
    const counted = renderToStaticMarkup(createElement(components.NotIncluded, {
      ...props, tracked: [], counted: funds.map(({ key, name, label }) => ({ key, name, label })),
    })).replaceAll("&#x27;", "'");
    for (const n of [1, 2]) assert.ok(counted.includes(`aria-label="Don't save it here: Example Fund, fund ${n}"`));
  }
});

test("separately compared funds keep their accounts' global labels in headings and links", () => {
  const groups = [2, 1].map((n) => {
    const name = `Funds, account ${n}`;
    return {
      accounts: name,
      funds: [{
        key: `fund${n}`, name: `Example Fund ${n}`, label: `Example Fund ${n}`, units: "20.000 units", canSave: true, included: false,
        comparison: { kind: "differ", theirs: "10.000 units", ours: "20.000", accountName: name, accounts: [{ id: `a${n}`, name }] },
      }],
    };
  });
  const shown = text("NotIncluded", {
    tracked: groups, counted: [], skipped: [], unsaved: [], defaulted: [], lines: [], open: {},
    setOpen() {}, onSaveBoth() {}, onDontSave() {}, onReview() {}, partId: "not-included",
  });
  for (const n of [1, 2]) {
    assert.ok(shown.includes(`Already tracked in Funds, account ${n} (1)`), shown);
    assert.ok(shown.includes(`Review its transactions in Funds, account ${n}`), shown);
  }
});

/** The detailed import's result, with made-up outcomes. */
const importResult = (props) => text("ImportResult", {
  imported: (props.outcomes ?? []).reduce((n, a) => n + a.imported, 0),
  result: { activities: [], summary: { success: true, total: 0, imported: 0, duplicates: 0, assetsCreated: 0 } },
  sent: [], total: 1, outcomes: [], closing: undefined, links: [], fundName: (t) => t.transaction.scheme, accountName: () => "the bank account", base: "r",
  onRetryAccount() {}, onRetryLink() {}, onCheckAgain() {}, onOpenAccount() {}, ...props,
});
const outcome = (fields) => ({ key: "k", name: "Mutual funds", isNew: false, imported: 0, waiting: 0, state: "imported", ...fields });

test("the import result counts transactions, each account's, the funds added and the bank entries linked", () => {
  const link = (id) => ({ transaction: {}, bankRow: { id }, facts: {}, changes: [], warnings: [] });
  const one = importResult({
    result: { activities: [], summary: { success: true, total: 1, imported: 1, duplicates: 0, assetsCreated: 1 } },
    outcomes: [outcome({ imported: 1 })], links: [link("bank-1")],
  });
  assert.match(one, /^ 1 transaction imported ✓ 1 transaction imported into Mutual funds Wealthfolio added 1 fund\. /);
  assert.match(one, / ✓ Linked 1 of 1 bank entry you chose with its transaction\. /);
  const two = importResult({
    result: { activities: [], summary: { success: true, total: 2, imported: 2, duplicates: 0, assetsCreated: 2 } },
    total: 2, outcomes: [outcome({ imported: 2, isNew: true })], links: [link("bank-1"), link("bank-2")],
  });
  assert.match(two, /^ 2 transactions imported ✓ 2 transactions imported into Mutual funds \(new\) Wealthfolio added 2 funds\. /);
  assert.match(two, / ✓ Linked 2 of 2 bank entries you chose with their transactions\. /);
});

test("the import result says per account what wasn't imported, each with Try again", () => {
  const partial = importResult({
    total: 47,
    outcomes: [
      outcome({ key: "a", imported: 6 }),
      outcome({ key: "b", name: "Mutual funds (B. Investor)", isNew: true, who: "B. Investor's", waiting: 41, state: "not-created" }),
    ],
  });
  assert.equal(partial.trim(), "6 of 47 transactions imported ✓ 6 transactions imported into Mutual funds " +
    "✗ Mutual funds (B. Investor) couldn't be created, so B. Investor's 41 transactions weren't imported. Try again : Mutual funds (B. Investor)");
  const failed = importResult({ total: 1, outcomes: [outcome({ waiting: 1, state: "failed" })] });
  assert.equal(failed.trim(), "No transactions were imported ✗ 1 transaction for Mutual funds wasn't imported. Try again : Mutual funds");
  const some = importResult({ total: 5, outcomes: [outcome({ imported: 3, waiting: 2, state: "failed" })] });
  assert.match(some, /^ 3 of 5 transactions imported ✗ 2 of 5 transactions for Mutual funds weren't imported\. Try again /);
  const rejected = importResult({ total: 1, outcomes: [outcome({})] });
  assert.match(rejected, / ✗ None of the transactions for Mutual funds were imported; the rows below say why\. $/);
});

test("rejected rows explain that their whole transactions stayed out", () => {
  const shown = importResult({ result: { activities: [{ lineNumber: 1, date: "2025-03-31", activityType: "BUY", errors: { general: ["Made-up refusal."] } }], summary: {} } });
  assert.match(shown, /Wealthfolio rejected rows These transactions weren't imported\. The rows below say why:/);
  assert.doesNotMatch(shown, /may lack their purchase, sale or cash/);
});

test("the import result's units check: couldn't run, every fund matching, or units that differ", () => {
  assert.match(importResult({ closing: "failed" }), / Saved, but the units couldn't be checked in Wealthfolio\. Check again : the units in Wealthfolio $/);
  const fund = (scheme, statement, held) => ({
    accountId: "account-1", asset: { symbol: scheme }, schemes: [{ scheme }], statement: dec(statement), held: held === undefined ? undefined : dec(held),
  });
  const accountName = (id) => (id === "account-1" ? "Mutual funds" : "?");
  assert.match(importResult({ closing: [fund("A", "10", "10")], accountName }), / ✓ Checked in Wealthfolio: units match the statement for the fund\. $/);
  assert.match(importResult({ closing: [fund("A", "10", "10"), fund("B", "5", "5")], accountName }), / for all 2 funds\. $/);
  assert.match(importResult({ closing: [fund("A", "10", "9")], accountName }), /Checked in Wealthfolio: units differ for 1 of 1 fund\./);
  const differ = importResult({ closing: [fund("A", "10", "10"), fund("B", "1234.5", "1224.5"), fund("C", "3", undefined)], accountName });
  assert.ok(differ.includes(" Checked in Wealthfolio: units differ for 2 of 3 funds. " +
    "B: Wealthfolio has 1,224.500 units, the statement says 1,234.500. Open Mutual funds " +
    "C: its units need a look in Wealthfolio, after a split or an option's expiry. Open Mutual funds "), differ);
});

test("the import result names each bank entry the add-on changed, and says how far a failed one got", () => {
  const transaction = { transaction: { activity: { date: "2023-05-05", activityType: "BUY" }, scheme: "Fictiva Liquid Fund - Direct Plan - Growth" } };
  // The fund goes by its name on the Review screen, and the bank entry's amount and day as its review card gives them.
  const fundName = (t) => (t === transaction ? "Fictiva Liquid Fund" : "?");
  const bankRow = (id, activityType, comment) =>
    ({ id, accountId: "bank-1", activityType, amount: "25000.00", date: "2023-05-04T00:00:00+00:00", comment });
  const links = [
    { transaction, bankRow: bankRow("a", "WITHDRAWAL", "NEFT"), facts: {}, changes: ["Its split across 2 spending categories was deleted."], warnings: ["Couldn't remove its spending category: Error: refused. A transfer isn't spending: remove it in Wealthfolio."] },
    { transaction, bankRow: bankRow("b", "TRANSFER_OUT"), facts: {}, changes: [], warnings: [] },
    { transaction, bankRow: bankRow("c", "WITHDRAWAL"), facts: {}, error: "Added the fund account's transfer, but couldn't link it.", stage: "link", changes: [], warnings: ["Its spending category wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio."] },
  ];
  const shown = importResult({ total: 3, outcomes: [outcome({ imported: 3 })], links, fundName, accountName: (id) => (id === "bank-1" ? "Savings" : "?") });
  assert.match(shown, / ✓ Linked 2 of 3 bank entries you chose with their transactions\. /);
  assert.ok(shown.includes(
    " ✗ Purchase of Fictiva Liquid Fund on 5 May 2023: The trade and the fund account's transfer are in Wealthfolio; the bank entry of 4 May 2023 wasn't linked. Try again : link the bank entry of 4 May 2023 ",
  ), shown);
  assert.ok(shown.includes(
    "What changed in the bank entries you chose Check these in Wealthfolio: " +
      "The withdrawal of ₹25,000 on 4 May 2023 in Savings (NEFT), for the purchase of Fictiva Liquid Fund on 5 May 2023: Its split across 2 spending categories was deleted. Couldn't remove its spending category: Error: refused. A transfer isn't spending: remove it in Wealthfolio. " +
      "The withdrawal of ₹25,000 on 4 May 2023 in Savings, for the purchase of Fictiva Liquid Fund on 5 May 2023: Its spending category wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio.",
  ), shown);
  assert.ok(!shown.includes("transfer out of ₹25,000"), "a bank entry with nothing else changed isn't listed");
  assert.ok(!/25000|2023-05-0|Direct Plan/.test(shown), shown);
  // Each step that can fail says what happened before it; a trade that didn't go in has no Try again.
  const failedAt = (stage) => importResult({ links: [{ ...links[2], stage }], fundName });
  assert.ok(failedAt("trade").includes(": The trade wasn't imported, so the bank entry of 4 May 2023 was left as it is. "));
  assert.ok(!failedAt("trade").includes("Try again"));
  assert.ok(failedAt("transfer").includes(": The trade is in Wealthfolio, but the fund account's transfer wasn't added, so the bank entry of 4 May 2023 wasn't linked. Try again"));
  assert.ok(failedAt("convert").includes(": The trade and the fund account's transfer are in Wealthfolio; the bank entry of 4 May 2023 wasn't changed into a transfer or linked. Try again"));
});

/** The detailed Review screen as first shown, before any search answers. */
const detailedReview = (statement, extra = {}) => ({
  ctx: { api: {} }, statement, data: withoutClosed(withReadableNames(statement)), fileName: "made-up.pdf", accounts: [], allAccounts: [],
  accountChoices: {}, unavailable: {}, fundChoices: {},
  amfi: { status: "unknown", searches: 0, checking: false, outcome: "", check() {}, openSettings() {} },
  visit: {}, busy: "", setBusy() {}, onRemember() {}, onAnother() {}, ...extra,
});

test("the detailed Review screen's heading names the period, statement, investor and file, and counts its funds", async () => {
  const cams = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const shown = text("DetailedImport", detailedReview(cams));
  assert.ok(shown.includes(" Transactions, 1 Apr 2023 to 31 Mar 2025 "), shown.slice(0, 200));
  assert.ok(shown.includes(" CAMS statement · ANANYA R TESTWALA · made-up.pdf "));
  // Closed schemes are left out: 7 schemes, 2 of them closed.
  assert.ok(shown.includes(" 5 funds "));
  // With no account that tracks transactions, Save to proposes a new one, created on import.
  assert.ok(!shown.includes("No account"), shown);
  assert.ok(shown.includes(" ANANYA R TESTWALA's funds New: Mutual funds "), shown);
  assert.ok(shown.includes(" New · Wealthfolio account, created when you save · Rename "), shown);
  const accounts = [{ id: "mf", name: "Mutual funds", currency: "INR", trackingMode: "TRANSACTIONS", isActive: true, isArchived: false }];
  const one = text("DetailedImport", detailedReview(cams, { accounts, allAccounts: accounts }));
  assert.ok(one.includes(" ANANYA R TESTWALA's funds "));
  assert.ok(one.includes(" Bank account for purchases and payouts (optional) : ANANYA R TESTWALA's funds "));
  assert.ok(one.includes(" Purchases transfer from this account; sales and cash dividends transfer back to it. "));
  assert.ok(one.includes(" Used again for your next statement. "));
});

/** The Review screen as first shown, before any search answers. */
const review = (statement, extra = {}) => ({
  ctx: { api: {} }, statement, holdings: components.readHoldings(statement), fileName: "made-up.pdf", accounts: [], allAccounts: [],
  accountChoices: {}, unavailable: {}, fundChoices: {},
  amfi: { status: "unknown", searches: 0, checking: false, outcome: "", check() {}, openSettings() {} },
  visit: {}, busy: "", setBusy() {}, onRemember() {}, onAnother() {}, ...extra,
});

test("the Review screen's heading names the statement, its investor and file, and counts its holdings", async () => {
  const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
  const shown = text("HoldingsImport", review(nsdl));
  assert.ok(shown.includes(" Holdings on 31 Mar 2025 "), shown.slice(0, 200));
  assert.ok(shown.includes(" NSDL statement · ANANYA R TESTWALA · made-up.pdf "));
  assert.ok(shown.includes(" Saves what you held on 31 Mar 2025, not your purchases and sales. "));
  const count = components.holdingItems(components.readHoldings(nsdl)).length;
  assert.ok(shown.includes(` ${count} holdings `), String(count));
  // With no account that tracks holdings, Save to proposes a new one, created on saving.
  assert.ok(!shown.includes("No account"), shown);
  assert.ok(shown.includes(" ANANYA R TESTWALA's holdings New: NSDL Demat "), shown);
  assert.ok(shown.includes(" New · Wealthfolio account, created when you save · Rename "), shown);
  const summary = JSON.parse(await readFile("tests/fixtures/made-up-summary-cams.json", "utf8"));
  assert.ok(text("HoldingsImport", review(summary)).includes(" CAMS summary statement · "));
});

test("casparser's warnings are said in plain words on both Review screens, naming funds without control characters", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-mismatch.json", "utf8"));
  // casparser quotes a name as Python's repr does, so the control characters a CDSL statement prints
  // in some names come as escapes.
  const [warning] = data.parse_warnings;
  data.folios[0].schemes[0].scheme = "Fictiva\u0002 Flexi Cap Fund - Direct Plan - Growth\u007f";
  data.parse_warnings = [warning.replace("'Fictiva Flexi Cap Fund - Direct Plan - Growth'", String.raw`'Fictiva\x02 Flexi Cap Fund - Direct Plan - Growth\x7f'`)];
  assert.notEqual(data.parse_warnings[0], warning);
  const line = " Fictiva Flexi Cap Fund: after the SIP purchase on 10 Oct 2023, its rows add up to 1,831.591 units, but the statement prints 1,925.629. A row may be missing or misread. ";
  for (const [component, props, before] of [
    ["DetailedImport", detailedReview(data), "importing"],
    ["HoldingsImport", review(data), "saving"],
  ]) {
    const rendered = renderToStaticMarkup(createElement(components[component], props));
    assert.ok(!/[\x00-\x1f\x7f]/.test(rendered), component);
    const shown = text(component, props);
    assert.ok(shown.includes(` Check these against the PDF before ${before} ${line.trim()} `), shown);
    assert.ok(!shown.includes("casparser") && !shown.includes("TransactionType"), component);
  }
});

test("the detailed Review screen leaves a closing balance warning to the question about its fund", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-mismatch.json", "utf8"));
  const [gap] = data.parse_warnings;
  // Flexi Cap's rows add up to less than its closing balance, so its question asks about the difference.
  const closing = "'Fictiva Flexi Cap Fund - Direct Plan - Growth' [FFCDG]: closing unit balance mismatch — computed 2798.066 but statement printed 2892.104 (Δ=-94.038); a transaction row may be missing or mis-parsed";
  data.parse_warnings = [closing];
  assert.ok(!text("DetailedImport", detailedReview(data)).includes("Check these against the PDF"));
  data.parse_warnings = [gap, closing];
  const shown = text("DetailedImport", detailedReview(data));
  assert.ok(shown.includes(" Fictiva Flexi Cap Fund: after the SIP purchase on 10 Oct 2023, "), shown);
  assert.ok(!shown.includes("closing balance is"), shown);
  // The holdings Review screen asks no such question, so it keeps it.
  assert.ok(text("HoldingsImport", review(data)).includes(" Fictiva Flexi Cap Fund: its rows add up to 2,798.066 units, but the statement's closing balance is 2,892.104. "));
});

test("the holdings Review screen names a depository statement's fund by its holding, and keeps a warning it doesn't recognise to copy", async () => {
  const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
  nsdl.parse_warnings = ["MF holdings INFZ90K01BA1: no closing nav/value pair; inferred from max tail", "Something new\u0002 in a later casparser"];
  const props = review(nsdl);
  const shown = text("HoldingsImport", props);
  assert.ok(
    shown.includes(
      " Check these against the PDF before saving Fictiva Balanced Advantage Fund: its NAV and value couldn't be read from its line, so the largest amount on that line was taken as its value. Check its NAV, value and cost against the PDF. ",
    ),
    shown,
  );
  const rendered = renderToStaticMarkup(createElement(components.HoldingsImport, props));
  assert.ok(rendered.includes("casparser found something it couldn&#x27;t read cleanly. To report it, copy its message: <code class=\"select-all\">Something new in a later casparser</code>"), rendered);
});

test("the Review screen names CDSL demat funds without their fund house, short name or control characters", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cdsl.json", "utf8"));
  const items = components.holdingItems(components.readHoldings(data));
  const named = Object.fromEntries(items.map((i) => [i.isin, i.name]));
  const isins = ["INFZ90K01BG8", "INFZ90K01GS2", "INFZ91T01GR3"];
  assert.deepEqual(isins.map((isin) => named[isin]), [
    "FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH",
    "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW",
    "TESTBRIDGE GILT FUND",
  ]);
  for (const item of items) assert.equal(item.statementAsset?.name, item.name);
  for (const item of items.filter((i) => isins.includes(i.isin))) {
    const props = { item, label: item.name, units: "1 unit", search: idle, searches, base: "q", amfiOn: false, headingId: "h", onAnswer() {} };
    assert.ok(!/[\x00-\x1f\x7f]/.test(renderToStaticMarkup(createElement(components.QuestionCard, props))));
    const card = text("QuestionCard", props);
    assert.ok(card.includes(` ${item.name} `), item.isin);
    for (const printed of ["ASSET MGMT", "LTD#", "MF-", "FICTIVAMF"]) assert.ok(!card.includes(printed), printed);
  }
  const shown = text("HoldingsImport", review(data));
  assert.ok(!/[\x00-\x1f\x7f]/.test(renderToStaticMarkup(createElement(components.HoldingsImport, review(data)))));
  for (const printed of ["ASSET MGMT", "LTD#", "FICTIVAMF"]) assert.ok(!shown.includes(printed), printed);

  // A statement-price choice remembered with the name as printed, as version 3.0.0 saved it, goes by
  // the readable name. Another remembered choice goes by its listing's name, without the plan and option.
  const [fund] = items.filter((i) => i.isin === "INFZ90K01BG8");
  const printed = data.accounts[0].mutual_funds.find((f) => f.isin === fund.isin).name;
  const priced = { ...fund.statementAsset, name: printed };
  const listed = { symbol: "0P0000FBAD", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fictiva Balanced Advantage Fund - Direct Plan - Growth" };
  assert.equal(components.shownName(fund, priced), "FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH");
  assert.equal(components.shownName(fund, listed), "Fictiva Balanced Advantage Fund");
  assert.equal(components.pricesFrom(fund, priced), "Prices from the statement");
  assert.equal(components.pricesFrom(fund, listed), "Price source unknown");
});

test("a detailed statement's funds are named without control characters", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const [scheme] = data.folios[0].schemes;
  const name = scheme.scheme;
  scheme.scheme = `\u0002${name.replace(" - ", "\u0002 - ")}\u0002`;
  const items = components.fundItems(withoutClosed(withReadableNames(data)));
  assert.equal(items[0].name, name);
});

test("a result says in words whether its plan and option match the statement's", () => {
  const { matchWords, planConflict } = components;
  const listing = (name, providerId = "AMFI") => ({ symbol: "100123", quoteCcy: "INR", name, providerId });
  const direct = { plan: "Direct", option: "Growth" };
  assert.deepEqual(matchWords(listing("Fictiva Midcap Fund - Direct Plan - Growth"), direct), { warn: false, text: "Plan and option match your statement" });
  assert.deepEqual(matchWords(listing("Fictiva Midcap Fund - Regular Plan - Growth"), direct), { warn: true, text: "Different plan: your statement says Direct" });
  assert.deepEqual(matchWords(listing("Fictiva Midcap Fund - Regular Plan - IDCW"), direct), {
    warn: true, text: "Different plan: your statement says Direct. Different option: your statement says Growth",
  });
  assert.deepEqual(matchWords(listing("Fictiva Midcap Fund - Direct Plan"), direct), { warn: false, text: "Plan matches your statement; its name gives no option" });
  assert.deepEqual(matchWords(listing("Fictiva Midcap Fund"), direct), { warn: false, text: "Its name gives no plan or option" });
  // A listing its provider didn't name: its plan and option are unknown.
  assert.deepEqual(matchWords({ ...listing("0P0000FMC1.BO", "YAHOO"), symbol: "0P0000FMC1.BO" }, direct), { warn: true, text: "Plan and option unknown" });
  // Nothing to say for a statement name without them.
  assert.equal(matchWords(listing("Fictiva Midcap Fund - Direct Plan - Growth"), {}), undefined);
  // A deliberate choice of another plan keeps its warning on the row.
  assert.equal(planConflict(listing("Fictiva Gilt Fund - Direct Plan - IDCW"), { plan: "Regular", option: "IDCW" }),
    "Statement: Regular · IDCW. Chosen: Direct · IDCW. Different plan.");
  assert.equal(planConflict(listing("Fictiva Gilt Fund - Regular Plan - IDCW"), { plan: "Regular", option: "IDCW" }), undefined);
  assert.equal(planConflict({ ...listing("FICTIVA.BO", "YAHOO"), symbol: "FICTIVA.BO" }, direct), "Chosen listing's plan and option are unknown.");
  assert.equal(planConflict({ ...listing("FICTIVA.BO", "YAHOO"), symbol: "FICTIVA.BO" }, {}), "Chosen listing's plan and option are unknown.");
  assert.equal(planConflict({ ...listing("Fictiva Gilt Fund - Direct Plan - IDCW"), statementPrices: true }, { plan: "Regular", option: "IDCW" }), undefined);
});

test("an existing asset's market pricing takes precedence over its remembered statement-price choice", () => {
  const item = { noun: "fund" };
  const statement = { symbol: "100123", quoteCcy: "INR", name: "Example Fund", statementPrices: true };
  assert.equal(components.pricesFrom(item, statement), "Prices from the statement");
  assert.equal(components.pricesFrom(item, statement, true), "Prices from the statement");
  assert.equal(components.pricesFrom(item, statement, false), "Price source unknown");
  assert.equal(components.pricesFrom(item, { ...statement, manual: false }), "Price source unknown");
  assert.equal(components.pricesFrom(item, { ...statement, providerId: "AMFI" }, false), "Prices from AMFI");
  const listed = { ...statement, statementPrices: undefined, providerId: "YAHOO", exchangeMic: "XNSE" };
  assert.equal(components.pricesFrom({ noun: "share" }, listed, false), "Prices from NSE on Yahoo Finance");
  assert.equal(components.pricesFrom(item, listed, true), "Prices entered by hand");
});


test("held and refused account results explain the next step without an ineffective retry", () => {
  const waiting = importResult({ total: 5, outcomes: [outcome({
    imported: 4, waiting: 1, state: "failed", retryable: false, waitingFor: "Other funds",
  })] });
  assert.match(waiting, /1 of 5 transactions for Mutual funds weren't imported\. Try again for Other funds\./);
  assert.doesNotMatch(waiting, /Try again : Mutual funds/);
  const refused = importResult({ total: 1, outcomes: [outcome({ waiting: 1, state: "failed", retryable: false })] });
  assert.match(refused, /1 transaction for Mutual funds wasn't imported\. The rows below say why\./);
  assert.doesNotMatch(refused, /Try again : Mutual funds/);
});


test("leaving an unfinished result asks even when no review answers changed", () => {
  const calls = [];
  const props = { ids: {}, title: "Import", lines: [], changes: 0, unfinished: true, discard: false,
    onDiscard: () => calls.push("ask"), onAnother: () => calls.push("leave") };
  const header = components.ReviewHeader(props);
  header.props.children[0].props.children[1].props.onClick();
  assert.deepEqual(calls, ["ask"]);
  assert.match(text("ReviewHeader", { ...props, discard: true }), /Leave this unfinished import and choose another file\?/);
  components.ReviewHeader({ ...props, unfinished: false }).props.children[0].props.children[1].props.onClick();
  assert.deepEqual(calls, ["ask", "leave"]);
});
