// Counts of one read in the singular, and other counts in the plural, in the detailed import's
// preview and result, the detailed statement line and the holdings Review screen, and the names the
// Review screen shows. Renders the components with Vite's SSR loader and made-up data.
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

test("the preview counts transactions and activities", () => {
  const transaction = (status) => ({
    status,
    rows: [],
    transaction: {
      folio: "12345",
      scheme: "Made-up Flexi Cap Fund",
      activity: { date: "2024-01-01", activityType: "BUY", quantity: "10", unitPrice: "10", amount: "100" },
      rows: [],
    },
  });
  const preview = (statuses, rowCount) =>
    text("Preview", {
      mapping: { warnings: [] },
      plan: statuses.map(transaction),
      importAnyway: new Set(),
      onImportAnyway() {},
      onImportUnbalanced() {},
      onImport() {},
      importing: false,
      rowCount,
      matches: new Map(),
      reuse: new Set(),
      onReuse() {},
      accounts: [],
    });
  const one = preview(["new", "duplicate"], 1);
  assert.match(one, / 1 new transaction, 0 already in Wealthfolio, 1 possible duplicate and 0 Wealthfolio can't import\. /);
  assert.match(one, / Import 1 activity $/);
  const two = preview(["new", "new", "duplicate", "duplicate"], 2);
  assert.match(two, / 2 new transactions, 0 already in Wealthfolio, 2 possible duplicates and 0 Wealthfolio can't import\. /);
  assert.match(two, / Import 2 activities $/);
  for (const row of [3, 4]) {
    assert.ok(two.includes(`Import anyway for the 2024-01-01 purchase of Made-up Flexi Cap Fund, 100, folio 12345, transaction ${row}`));
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

test("the detailed statement line counts folios, schemes, rows and closed schemes", () => {
  const row = { date: "01-Jan-2024", description: "Purchase", amount: "100", units: "10", nav: "10", balance: "10", type: "PURCHASE", dividend_rate: null, gift_folio: null };
  // A closed scheme has no units and no rows.
  const scheme = (rows) => ({ scheme: "Made-up Fund", open: rows ? "10" : "0", close: rows ? "10" : "0", transactions: Array(rows).fill(row) });
  const line = (...folios) =>
    text("StatementSummary", {
      data: {
        file_type: "CAMS",
        investor_info: { name: "A MADE-UP INVESTOR" },
        statement_period: { from: "01-Apr-2023", to: "31-Mar-2024" },
        folios: folios.map((schemes) => ({ schemes })),
        parse_warnings: [],
      },
    }).trim();
  const start = "CAMS detailed statement for A MADE-UP INVESTOR, 01-Apr-2023 to 31-Mar-2024:";
  const skipping = "with no units and nothing to import.";
  assert.equal(line([scheme(1)]), `${start} 1 folio, 1 scheme, 1 row.`);
  assert.equal(line([scheme(2), scheme(0)]), `${start} 1 folio, 2 schemes, 2 rows. Skipping 1 closed scheme, ${skipping}`);
  assert.equal(line([scheme(1)], [scheme(0), scheme(0)]), `${start} 2 folios, 3 schemes, 1 row. Skipping 2 closed schemes, ${skipping}`);
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
    ["StatementSummary", { data }],
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

test("the Funds card names a detailed statement's schemes without control characters", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const [scheme] = data.folios[0].schemes;
  const name = scheme.scheme;
  scheme.scheme = `\u0002${name.replace(" - ", "\u0002 - ")}\u0002`;
  const items = components.fundItems(withoutClosed(withReadableNames(data)));
  assert.equal(items[0].name, name);
  const props = { ctx: {}, items, choices: {}, amfi: { status: "unknown", searches: 0 } };
  assert.ok(!/[\x00-\x1f\x7f]/.test(renderToStaticMarkup(createElement(components.FundChoicesCard, props))));
  assert.ok(text("FundChoicesCard", props).includes(` ${name} `));
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
