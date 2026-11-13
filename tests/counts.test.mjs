// Counts of one read in the singular, and other counts in the plural, in the detailed import's
// result and Review screen and the holdings Review screen, and the names the Review screens show. Renders the components with Vite's SSR loader and made-up data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { withoutClosed, withReadableNames } from "../src/cas/mapping.ts";
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
    ...(await server.ssrLoadModule("/src/components/review/question.tsx")),
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
    ...(await server.ssrLoadModule("/src/components/review/funds-ready.tsx")),
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
    "1 possible duplicate, skipped unless chosen under “Before importing”",
    "6 in skipped funds",
    "3 in folios not imported",
    "2 in funds whose rows don't add up, left out unless chosen under “Before importing”",
  ]);
  assert.deepEqual(parts({ duplicates: 2, leftOut: [reversal("REDEMPTION"), reversal("PURCHASE"), { kind: "row", reason: "x", row: { row: { type: "MISC" } } }] }), [
    "2 possible duplicates, skipped unless chosen under “Before importing”",
    "3 left out: a sale and a later row that may reverse it, and 1 more listed under “Not included”",
  ]);
  assert.deepEqual(parts({ leftOut: [{ kind: "row", reason: "x", row: { row: { type: "MISC" } } }] }), ["1 left out, listed under “Not included”"]);
  const summary = (b) => text("TransactionsSummary", { breakdown: { ...none, ...b }, range: "Apr 2019 to Jun 2026", partId: "t" });
  assert.match(summary({ total: 1, toImport: 1 }), / 1 transaction , Apr 2019 to Jun 2026 1 to import $/);
  assert.equal(components.nothingWords({ ...none, total: 21, before: 21 }), "Nothing new: every transaction on this statement is already in Wealthfolio.");
  assert.equal(components.nothingWords({ ...none, total: 5, before: 3, earlier: 2 }), "Nothing is ready to import. See the transactions left out or waiting above.");
});

test("Before importing says what each choice does, naming what it imports", () => {
  const shown = (checked) => text("BeforeImporting", {
    duplicates: [{ key: "d", title: "Fictiva Midcap Fund · Purchase · 3 Jul 2026 · ₹5000", reason: "Wealthfolio already has this purchase.", label: "Fictiva Midcap Fund · Purchase", noun: "purchase", checked }],
    unbalanced: [{ key: "u", title: "Fictiva Credit Risk Fund, folio 1", gap: "The rows don't add up.", checked }],
    onDuplicate() {}, onUnbalanced() {}, disabled: false, headingId: "before",
  });
  assert.match(shown(false), /Import it anyway : Fictiva Midcap Fund · Purchase Skipped unless you tick it\. Two equal purchases on one day can both be real\./);
  assert.match(shown(false), /Import this fund anyway : Fictiva Credit Risk Fund, folio 1 Its rows are left out unless you tick it\./);
  assert.match(shown(true), /It's imported as a second purchase\./);
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
  check: { id: label, bankName: "Savings account", label, pairs }, ticked: new Set(pairs.map((p) => p.key)), facts: new Map(),
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
    const receiptName = markup({ answered: 1 }).match(/aria-label="(Change answer:[^"]+)"/)?.[1];
    assert.ok(receiptName?.includes(label), receiptName);
  }
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
    earlier, defaulted: earlier.map((fund, i) => ({ key: fund.key, name: fund.name, label: `${fund.name}, fund ${i + 1}` })),
    skipped: [], notImported: [], leftOut: [], registrar: "CAMS", open: {}, setOpen() {},
    partId: "not-included", changeId: (key) => key, onChange() {}, onReopen() {}, changePanel: () => null,
  };
  const markup = renderToStaticMarkup(createElement(components.NotIncludedDetailed, props));
  for (const n of [1, 2]) {
    assert.ok(markup.includes(`aria-label="How to fix: Fictiva Fund, fund ${n}"`));
    assert.ok(markup.includes(`aria-label="Change: Fictiva Fund, fund ${n}, earlier purchases needed"`));
    assert.ok(markup.replaceAll("&#x27;", "'").includes(`aria-label="Change: Fictiva Fund, fund ${n}, rows don't add up"`));
  }
  const shown = text("NotIncludedDetailed", props);
  assert.ok(shown.includes("Earlier purchases needed : Fictiva Fund starts with 10.000 units bought before this statement, so its 1 transaction waits. Change How to fix"));
  assert.ok(shown.includes("Left out unless you choose otherwise under “Before importing” (2) Fictiva Fund · Change Fictiva Fund · Change"));
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
    earlier: [], skipped: [], notImported: [], defaulted: [],
    leftOut: [{ key: item.key, name: item.name, label: item.name, canChange: true, lines: [{ when: "5 Jan 2026", reason: "This row isn't supported." }] }],
    registrar: "CAMS", open: {}, setOpen() {}, partId: "not-included", changeId: () => "left-change",
    onChange() {}, onReopen() {}, changePanel: () => null,
  };
  const markup = renderToStaticMarkup(createElement("div", null, ready, createElement(components.NotIncludedDetailed, leftOut)));
  const names = [...markup.matchAll(/aria-label="(Change:[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, ["Change: Fictiva Fund", "Change: Fictiva Fund, not included"]);
  assert.ok(text("NotIncludedDetailed", leftOut).includes("Fictiva Fund · Change"));
});

test("bank choices and folio disclosures distinguish PAN boxes whose investors have the same name", () => {
  const boxes = ["ABCDE1234F", "PQRST5678G"].map((pan) => ({
    key: pan, name: "A. Investor", title: `A. Investor (PAN ${pan})'s funds`, pan: true, folios: [],
  }));
  const props = {
    boxes, targets: [{ id: "mf", name: "Mutual funds", currency: "INR" }],
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
  // Before saving: an earlier import's holdings no longer on the statement, two with one name, in
  // two accounts with one name, each replacing a snapshot on the statement's date.
  const old = (ref) => ({ assetId: ref, symbol: ref, ref, name: "Old Fund", units: "5", cost: null, currency: "INR" });
  const plans = components.planSnapshots(holdings, {
    account: () => "a",
    asset: (h) => ({ symbol: h.isin, exchangeMic: "XBOM", name: h.name, quoteCcy: "INR" }),
    existing: () => ({ date: "2025-03-31", positions: [old("OLD1@XBOM"), old("OLD2@XBOM")], cash: {}, later: [] }),
    remembered: () => new Map([["OLD1@XBOM", ["INEZOLD00011"]], ["OLD2@XBOM", ["INEZOLD00029"]]]),
    heldElsewhere: () => [],
  });
  for (const [label, n] of [["Demat, account 1", 1], ["Demat, account 2", 2]]) {
    const before = text("BeforeSaving", {
      plan: plans[0], account: "Demat", label, choices: { flipped: new Set(), costs: new Map() }, confirmed: false, onFlip() {}, onKeep() {}, onConfirm() {}, disabled: false,
    });
    assert.ok(before.includes(`Replace the snapshot of 31 Mar 2025 in ${label}`), label);
    for (const holding of [3, 4]) assert.ok(before.includes(`Keep Old Fund in ${label}, holding ${holding}`), `${label} ${holding} ${n}`);
  }
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

test("Before saving offers Change only for a statement row not already shown as ready", () => {
  const position = {
    key: "NEW", ref: "NEW", name: "Example Fund", include: true, replaces: ["OLD"], notes: [],
    lines: [{ source: { label: "Example folio" }, holding: { name: "Example Fund" } }],
  };
  const plan = { date: "2025-03-31", positions: [position], existing: { date: null, cash: {} } };
  const changed = [];
  const props = {
    plan, account: "Fund folios", label: "Fund folios", choices: { flipped: new Set(), costs: new Map() },
    confirmed: false, disabled: false, onFlip() {}, onKeep() {}, onConfirm() {},
    change: (row) => { changed.push(row.key); return createElement("button", null, "Change this fund"); },
  };
  assert.ok(!text("BeforeSaving", props).includes("Change this fund"));
  assert.deepEqual(changed, []);
  assert.ok(text("BeforeSaving", { ...props, choices: { ...props.choices, flipped: new Set(["NEW"]) } }).includes("Change this fund"));
  assert.deepEqual(changed, ["NEW"]);
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

test("the import result counts activities, duplicates, funds and bank rows", () => {
  const link = (id) => ({ transaction: {}, bankRow: { id }, changes: [], warnings: [] });
  const result = (summary, links) =>
    text("ImportResult", { result: { activities: [], summary: { success: true, ...summary } }, sent: [], closing: [], links, accounts: [] });
  const one = result({ total: 1, imported: 1, duplicates: 0, assetsCreated: 1 }, [link("bank-1")]);
  assert.match(one, / Imported 1 of 1 activity Wealthfolio skipped 0 as duplicates and created 1 fund\. /);
  assert.match(one, / Linked 1 of 1 bank row you chose with its transaction\. /);
  const some = result({ total: 2, imported: 1, duplicates: 1, assetsCreated: 0 }, [link("bank-1"), link("bank-2")]);
  assert.match(some, / Imported 1 of 2 activities Wealthfolio skipped 1 as a duplicate and created 0 funds\. /);
  assert.match(some, / Linked 2 of 2 bank rows you chose with their transactions\. /);
  const two = result({ total: 4, imported: 2, duplicates: 2, assetsCreated: 2 }, []);
  assert.match(two, / Imported 2 of 4 activities Wealthfolio skipped 2 as duplicates and created 2 funds\. /);
});

test("the import result names each bank row the add-on changed, and how", () => {
  const transaction = { transaction: { activity: { date: "2023-05-05", activityType: "BUY" }, scheme: "Fictiva Liquid Fund" } };
  const bankRow = (id, activityType, comment) =>
    ({ id, accountId: "bank-1", activityType, amount: "25000.00", date: "2023-05-04T00:00:00+00:00", comment });
  const links = [
    { transaction, bankRow: bankRow("a", "WITHDRAWAL", "NEFT"), changes: ["Its split across 2 spending categories was deleted."], warnings: ["Couldn't remove its spending category: Error: refused. A transfer isn't spending: remove it in Wealthfolio."] },
    { transaction, bankRow: bankRow("b", "TRANSFER_OUT"), changes: [], warnings: [] },
    { transaction, bankRow: bankRow("c", "WITHDRAWAL"), error: "Added the fund account's transfer, but couldn't link it.", changes: [], warnings: ["Its spending category wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio."] },
  ];
  const shown = text("ImportResult", {
    result: { activities: [], summary: { success: true, total: 3, imported: 3, duplicates: 0, assetsCreated: 0 } },
    sent: [], closing: [], links, accounts: [{ id: "bank-1", name: "Savings" }],
  });
  assert.match(shown, / Linked 2 of 3 bank rows you chose with their transactions\. /);
  assert.ok(shown.includes(
    "What changed in the bank rows you chose Check these in Wealthfolio: " +
      "The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT), for the 2023-05-05 purchase of Fictiva Liquid Fund: Its split across 2 spending categories was deleted. Couldn't remove its spending category: Error: refused. A transfer isn't spending: remove it in Wealthfolio. " +
      "The withdrawal of 25000.00 on 2023-05-04 in Savings, for the 2023-05-05 purchase of Fictiva Liquid Fund: Its spending category wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio.",
  ), shown);
  assert.ok(!shown.includes("transfer out of 25000.00"), "a bank row with nothing else changed isn't listed");
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
  // With no account that tracks transactions, Save to says so.
  assert.ok(shown.includes(" No account can take these transactions yet "));
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
  // With no account that tracks holdings, Save to says so.
  assert.ok(shown.includes(" No account can hold these yet "));
  const summary = JSON.parse(await readFile("tests/fixtures/made-up-summary-cams.json", "utf8"));
  assert.ok(text("HoldingsImport", review(summary)).includes(" CAMS summary statement · "));
});

test("parser warnings show scheme names without control characters on both statement summaries", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-mismatch.json", "utf8"));
  const [warning] = data.parse_warnings;
  data.parse_warnings = [warning.replace("Fictiva Flexi Cap Fund", "Fictiva\u0002 Flexi Cap Fund\u007f")];
  for (const [component, props] of [
    ["DetailedImport", detailedReview(data)],
    ["HoldingsImport", review(data)],
  ]) {
    const rendered = renderToStaticMarkup(createElement(components[component], props));
    assert.ok(!/[\x00-\x1f\x7f]/.test(rendered), component);
    assert.ok(text(component, props).includes(warning), component);
  }
  assert.ok(data.parse_warnings[0].includes("\u0002"));
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
