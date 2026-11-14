// Exercises the real detailed Review controller and search hook with made-up host data, without a
// browser: where transactions go, which bank checks show under which choice, what survives a change,
// what the footer counts, and when choices are remembered.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import { createServer } from "vite";
import { proposedId } from "../src/lib/new-accounts.ts";

let server;
let DetailedImport;
let choices;
let withoutClosed;
let withReadableNames;
let active;
const originalDocument = globalThis.document;
const fixture = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));

before(async () => {
  const names = ["useState", "useRef", "useMemo", "useId", "useEffect", "useLayoutEffect", "useSyncExternalStore"];
  server = await createServer({
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "review-hooks",
      enforce: "pre",
      resolveId(id) { if (id === "review-hooks") return "\0review-hooks"; },
      load(id) {
        if (id === "\0review-hooks") return names.map((name) =>
          `export const ${name} = (...args) => globalThis.reviewHooks.${name}(...args);`).join("\n");
      },
      transform(code, id) {
        if (/src\/(pages\/detailed-import\.tsx|components\/review\/(search\.ts|parts\.tsx|focus\.ts))$/.test(id)) {
          return code.replaceAll('from "react"', 'from "review-hooks"');
        }
      },
    }],
  });
  ({ DetailedImport } = await server.ssrLoadModule("/src/pages/detailed-import.tsx"));
  choices = await server.ssrLoadModule("/src/lib/choices.ts");
  ({ withoutClosed, withReadableNames } = await server.ssrLoadModule("/src/cas/mapping.ts"));
});
afterEach(() => {
  active?.dispose();
  active = undefined;
  globalThis.document = originalDocument;
  delete globalThis.reviewHooks;
});
after(() => server?.close());

// Only the controller and its hooks run. Child components stay React elements, exposing their
// real callbacks without reproducing DOM behavior or Wealthfolio's UI implementation.
function controller(props) {
  const slots = [];
  let cursor;
  let dirty = true;
  let effects = [];
  let tree;
  const memo = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || !deps || deps.some((d, j) => !Object.is(d, slots[i].deps[j]))) slots[i] = { value: fn(), deps };
    return slots[i].value;
  };
  const effect = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || !deps || deps.some((d, j) => !Object.is(d, slots[i].deps[j]))) {
      const old = slots[i];
      slots[i] = { deps };
      effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); });
    }
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useRef(value) { return memo(() => ({ current: value }), []); },
    useMemo: memo,
    useId() { return memo(() => "review", []); },
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore(subscribe, snapshot, fallback) { return fallback(); },
  };
  return {
    async flush() {
      for (let i = 0; i < 40; i++) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          globalThis.reviewHooks = hooks;
          tree = DetailedImport(props);
          const pending = effects;
          effects = [];
          pending.forEach((fn) => fn());
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(dirty, false, "the controller settled");
    },
    update(patch) { Object.assign(props, patch); dirty = true; },
    get tree() { return tree; },
    dispose() { slots.forEach((slot) => slot.cleanup?.()); },
  };
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const find = (run, name) => nodes(run.tree).find((node) => node.type?.name === name)?.props;
const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : node === false || node == null ? "" : String(node));
const footer = (run) => find(run, "Footer").lines.map(textOf);

const account = (id, name, trackingMode = "TRANSACTIONS") => ({ id, name, currency: "INR", trackingMode, isActive: true, isArchived: false });
const ACCOUNTS = [account("mf", "Mutual funds"), account("other", "Other funds"), account("bank", "Savings"), account("demat", "Demat", "HOLDINGS")];
/** A bank entry in Savings, as a bank statement's import records one. */
const entry = (id, activityType, amount, date, comment) => ({
  id, accountId: "bank", activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`, quantity: null, unitPrice: null,
  amount, fee: null, currency: "INR", needsReview: false, comment, assetId: "", assetSymbol: "",
});
/** A mapped Liquid Fund row as Wealthfolio returns it, with or without the add-on's row ID. */
const stored = (a, accountId, id, sourceRecordId = null) => ({
  ...a, id, accountId, date: `${a.date}T00:00:00Z`, quantity: a.quantity ?? null, unitPrice: a.unitPrice ?? null,
  amount: a.amount ?? null, tax: a.tax ?? null, fee: null, subtype: a.subtype ?? null, status: "POSTED", needsReview: false,
  comment: null, assetId: a.symbol ? "liquid-asset" : "", assetSymbol: a.symbol ?? "", sourceRecordId,
});
// The made-up statement's dividend payout from the Testbridge folio, and its Liquid Fund purchase from the Fictiva folio.
const ENTRIES = [
  entry("dividend", "DEPOSIT", "7276.48", "2023-12-28", "TESTBRIDGE MF IDCW"),
  entry("purchase", "WITHDRAWAL", "25000.00", "2023-05-04", "NEFT FICTIVA MF"),
];

/**
 * The review of the made-up CAMS statement, with every fund confirmed and its PAN's funds going to
 * Mutual funds unless `remembered` says otherwise. `change` edits the statement first.
 */
function setup({ remembered, entries = ENTRIES, change = (data) => data } = {}) {
  globalThis.document = { activeElement: {}, body: {}, hasFocus: () => true, getElementById: () => null };
  const statement = change(structuredClone(fixture));
  const data = withoutClosed(withReadableNames(statement));
  const [fictiva, testbridge] = data.folios;
  const keys = {
    pan: choices.panKey("ABCDE1234F"),
    fictiva: fictiva && choices.folioKey(fictiva),
    testbridge: testbridge && choices.folioKey(testbridge),
  };
  const fundChoices = Object.fromEntries(data.folios.flatMap((f) => f.schemes).map((s) => [choices.fundKey(s), {
    fund: { symbol: (s.isin ?? s.rta_code).toUpperCase(), exchangeMic: "XBOM", quoteCcy: "INR", name: s.scheme, instrumentType: "MUTUALFUND", providerId: "YAHOO" },
  }]));
  const activities = [...entries];
  const imported = [];
  // Assets' profiles by ID: their symbol and exchange.
  const profiles = {};
  const api = {
    activities: {
      getAll: async (accountId) => activities.filter((a) => !accountId || a.accountId === accountId),
      checkImport: async (rows) => rows.map((r) => ({ ...r })),
      getTransferPair: async () => null,
      import: async (rows) => {
        imported.push(rows);
        return { activities: rows.map((r) => ({ ...r })), summary: { success: true, total: rows.length, imported: rows.length, duplicates: 0, assetsCreated: 0 } };
      },
    },
    accounts: { getAll: async () => ACCOUNTS },
    // Savings isn't in Spending, so no split can be read, or needs to be.
    spending: { getContext: async () => ({ enabled: false, accountIds: [], excludedCategoryIds: [] }), searchCashActivities: async () => ({ items: [], totalCount: 0 }) },
    assets: { getProfile: async (id) => profiles[id] ?? {} },
    settings: { get: async () => ({ timezone: "UTC" }) },
    market: { searchTicker: async () => [] },
    query: { invalidateQueries() {} },
  };
  const remembers = [];
  const departures = [];
  const props = {
    ctx: { api }, statement, data, fileName: "made-up.pdf", accounts: ACCOUNTS, allAccounts: ACCOUNTS,
    accountChoices: remembered ?? { [keys.pan]: "mf" }, unavailable: {}, fundChoices,
    amfi: { status: "off", searches: 0 }, visit: {}, busy: "", setBusy() {},
    onRemember: (r) => remembers.push(r), onAnother: (notice) => departures.push(notice),
  };
  active = controller(props);
  return { run: active, props, api, keys, data, remembers, departures, imported, activities, profiles };
}
const saveTo = (run) => find(run, "SaveToDetailed");
/** The bank checks shown under the bank choice with this key. */
const checksUnder = (run, key) => nodes(saveTo(run).checks(key)).filter((node) => node.type?.name === "BankCheck").map((node) => node.props);

for (const moved of ["stayed", "another control", "host"]) {
  test(`detailed retry stays busy through a deferred read and respects focus (${moved})`, async () => {
    const { run, api } = setup({ entries: [] });
    api.activities.getAll = async () => { throw new Error("made-up read failure"); };
    await run.flush();
    const origin = document.activeElement;
    const focused = [];
    document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
    for (const failed of [true, false]) {
      let finish;
      api.activities.getAll = () => new Promise((resolve, reject) => { finish = failed ? reject : resolve; });
      find(run, "Footer").go.onClick();
      await run.flush();
      assert.equal(find(run, "Footer").go.label, "Try again");
      assert.equal(find(run, "Footer").go.busy, true);
      assert.equal(find(run, "Footer").action.disabled, true);
      assert.deepEqual(focused, []);
      if (!failed && moved === "another control") document.activeElement = {};
      if (!failed && moved === "host") document.hasFocus = () => false;
      finish(failed ? new Error("made-up retry failure") : []);
      await run.flush();
      if (failed) {
        assert.equal(find(run, "Footer").go.label, "Try again");
        assert.equal(find(run, "Footer").go.busy, false);
        assert.deepEqual(focused, []);
        assert.equal(document.activeElement, origin);
      }
    }
    assert.deepEqual(focused, moved === "stayed" ? ["review-summary"] : []);
    assert.equal(find(run, "Footer").action.disabled, false);
    assert.equal(find(run, "Footer").go, undefined);
  });
}

test("Before importing keeps its choices and current ticks during a deferred replan", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  const checked = (rows) => rows.map((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  api.activities.checkImport = async (rows) => checked(rows);
  await run.flush();
  const before = find(run, "BeforeImporting");
  assert.equal(before.duplicates.length, 2);
  assert.equal(before.unbalanced.length, 1);
  let finish;
  api.activities.checkImport = (rows) => new Promise((resolve) => { finish = () => resolve(checked(rows)); });
  before.onUnbalanced(before.unbalanced[0].key, true);
  await run.flush();
  let pending = find(run, "BeforeImporting");
  assert.deepEqual(pending.duplicates, before.duplicates);
  assert.deepEqual(pending.unbalanced, before.unbalanced.map((u) => ({ ...u, checked: true })));
  assert.equal(find(run, "Footer").action.disabled, true);
  pending.onDuplicate(before.duplicates[0].key, true);
  await run.flush();
  pending = find(run, "BeforeImporting");
  assert.equal(pending.duplicates[0].checked, true);
  finish();
  await run.flush();
  assert.equal(find(run, "BeforeImporting").unbalanced[0].checked, true);
  assert.equal(find(run, "BeforeImporting").duplicates[0].checked, true);
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("a remembered bank account that tracks holdings asks again, and the import waits for it", async () => {
  const { run, keys } = setup({ remembered: { pan: undefined, [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "demat" } });
  await run.flush();
  const bank = choices.bankKey(keys.pan);
  assert.equal(saveTo(run).values[bank], null);
  assert.deepEqual(saveTo(run).ignored[bank], { name: "Demat" });
  assert.deepEqual(footer(run), ["1 question left before importing."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).onChange(bank, "bank");
  await run.flush();
  assert.equal(saveTo(run).values[bank], "bank");
  assert.equal(saveTo(run).ignored[bank], undefined);
  // Its check is the question now.
  assert.equal(checksUnder(run, bank).length, 1);
  assert.match(footer(run)[0], /^1 question left: the payment check before importing\.$/);
});

test("a folio's own bank account gets its check under the folio's choice, with the PAN's bank None", async () => {
  const { run, keys } = setup();
  await run.flush();
  assert.equal(checksUnder(run, choices.bankKey(keys.pan)).length, 0);
  saveTo(run).onChange(choices.bankKey(keys.testbridge), "bank");
  await run.flush();
  assert.equal(checksUnder(run, choices.bankKey(keys.pan)).length, 0);
  const [check] = checksUnder(run, choices.bankKey(keys.testbridge));
  assert.deepEqual(check.check.pairs.map((p) => [p.entry.id, p.strong]), [["dividend", true]]);
  assert.equal(check.answered, undefined);
  // An open check under a folio keeps the box's folios open.
  assert.equal(saveTo(run).open[keys.pan], true);
  // The Fictiva folio's purchase has no bank account, so its entry isn't offered.
  assert.equal(check.check.pairs.some((p) => p.entry.id === "purchase"), false);
});

test("a folio without a PAN has a box of its own, with its remembered account and bank", async () => {
  const change = (data) => {
    data.folios[1].PAN = null;
    return data;
  };
  const probe = setup({ change });
  const testbridgeKey = probe.keys.testbridge;
  probe.run.dispose();
  const { run, keys } = setup({ change, remembered: { [choices.panKey("ABCDE1234F")]: "mf", [testbridgeKey]: "other", [choices.bankKey(testbridgeKey)]: "bank" } });
  await run.flush();
  const { boxes, values } = saveTo(run);
  assert.deepEqual(boxes.map((b) => [b.key === keys.pan, b.key === keys.testbridge, b.title, b.pan]), [
    [true, false, "ANANYA R TESTWALA's funds", true],
    [false, true, "Testbridge Mutual Fund folio 1040012345 (no PAN printed)", false],
  ]);
  assert.deepEqual([values[keys.testbridge], values[choices.bankKey(keys.testbridge)]], ["other", "bank"]);
  assert.equal(saveTo(run).remembered, "all");
  const [check] = checksUnder(run, choices.bankKey(keys.testbridge));
  assert.equal(check.check.bankName, "Savings");
  // Each box's funds go under who they belong to and where.
  assert.deepEqual([...new Set(find(run, "FundsReadyTable").rows.map((r) => r.groupTitle))], ["ANANYA R TESTWALA → Mutual funds", "ANANYA R TESTWALA → Other funds"]);
});

test("changing another folio's bank keeps an answered check; a change to its own pairs asks again", async () => {
  const { run, keys } = setup({ remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" } });
  await run.flush();
  let [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id).sort(), ["dividend", "purchase"]);
  check.onLink();
  await run.flush();
  [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.equal(check.answered, 2);
  // The Testbridge folio's cash goes outside Wealthfolio now: its pair goes, and the check asks again.
  saveTo(run).onChange(choices.bankKey(keys.testbridge), choices.NO_BANK);
  await run.flush();
  [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id), ["purchase"]);
  assert.equal(check.answered, undefined);
  check.onNone();
  await run.flush();
  // A choice that leaves its pairs as they are keeps the answer.
  saveTo(run).onChange(choices.folioKey(run && find(run, "SaveToDetailed").boxes[0].folios[1]), "other");
  await run.flush();
  [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.equal(check.answered, 0);
});

test("the PAN's funds set to Don't import keep the check of a folio that's still imported", async () => {
  const { run, keys } = setup({ remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" } });
  await run.flush();
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  saveTo(run).onChange(keys.testbridge, "other");
  await run.flush();
  const [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id), ["dividend"]);
  assert.deepEqual(footer(run), ["1 question left: the payment check before importing."]);
  check.onLink();
  await run.flush();
  assert.deepEqual(footer(run), [
    "Import 6 transactions for 2 funds into Other funds.",
    "ANANYA R TESTWALA's purchases transfer from Savings, and sales and payouts back to it: 1 uses an entry already there, 5 get new transfers.",
    "See every transaction",
  ]);
});

test("the footer counts what each choice imports, and the bank movements from the planned transactions", async () => {
  const { run, keys } = setup({ entries: [] });
  await run.flush();
  // Flexi Cap starts with units Wealthfolio doesn't have, so its transactions wait.
  assert.deepEqual(footer(run), ["Import 13 transactions for 4 funds into Mutual funds.", "See every transaction"]);
  assert.equal(find(run, "Footer").action.label, "Import 13 transactions");
  assert.deepEqual(find(run, "NotIncludedDetailed").earlier.map((f) => [f.units, f.waiting]), [["1,250.000 units", 26]]);
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  assert.deepEqual(footer(run), [
    "Import 13 transactions for 4 funds into Mutual funds.",
    "ANANYA R TESTWALA's purchases transfer from Savings, and sales and payouts back to it: 9 get new transfers.",
    "See every transaction",
  ]);
  saveTo(run).onChange(keys.testbridge, choices.LEFT_OUT);
  await run.flush();
  assert.deepEqual(footer(run).slice(0, 2), [
    "Import 7 transactions for 2 funds into Mutual funds.",
    "ANANYA R TESTWALA's purchases transfer from Savings, and sales and payouts back to it: 3 get new transfers.",
  ]);
  assert.deepEqual(find(run, "NotIncludedDetailed").notImported, ["Testbridge Mutual Fund folio 1040012345 (2 funds)"]);
  assert.deepEqual(find(run, "TransactionsSummary").breakdown.notImported, 6);
});

test("a possible duplicate imported anyway counts in every number, and its fund's units say so", async () => {
  const first = setup({ entries: [] });
  await first.run.flush();
  // The Liquid Fund purchase of 5 May 2023, entered by hand without its cash.
  nodes(find(first.run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
  await first.run.flush();
  const purchase = find(first.run, "ActivityTable").plan.find((t) => t.transaction.scheme.includes("Liquid") && t.transaction.activity.activityType === "BUY").transaction.activity;
  first.run.dispose();
  const byHand = {
    id: "by-hand", accountId: "mf", activityType: "BUY", subtype: null, status: "POSTED", date: `${purchase.date}T00:00:00+00:00`,
    quantity: purchase.quantity, unitPrice: purchase.unitPrice, amount: purchase.amount, fee: null, tax: purchase.tax, currency: "INR",
    needsReview: false, comment: null, assetId: "liquid-asset", assetSymbol: purchase.symbol, sourceRecordId: null,
  };
  const { run, profiles } = setup({ entries: [byHand] });
  profiles["liquid-asset"] = { instrumentSymbol: purchase.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  const before = find(run, "BeforeImporting");
  assert.equal(before.duplicates.length, 1);
  assert.equal(before.duplicates[0].title, "Fictiva Liquid Fund · Purchase · 5 May 2023 · ₹24,998.75");
  assert.equal(find(run, "TransactionsSummary").breakdown.duplicates, 1);
  assert.deepEqual(footer(run).slice(0, 1), ["Import 12 transactions for 4 funds into Mutual funds."]);
  before.onDuplicate(before.duplicates[0].key, true);
  await run.flush();
  assert.deepEqual(footer(run).slice(0, 2), [
    "Import 13 transactions for 4 funds into Mutual funds.",
    "1 fund's units won't match the statement after importing: Fictiva Liquid Fund.",
  ]);
  const row = find(run, "FundsReadyTable").rows.find((r) => r.name.includes("Liquid"));
  assert.equal(row.note, "After import: 17.800 units · Statement: 8.053. Includes the second purchase you chose.");
  assert.equal(find(run, "TransactionsSummary").breakdown.duplicates, 0);
});

test("choices are remembered on import, not before, so Use another file discards them", async () => {
  const { run, keys, remembers, departures, imported } = setup({ entries: [] });
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  const header = find(run, "ReviewHeader");
  assert.equal(header.changes, 1);
  assert.deepEqual(remembers, []);
  header.onAnother();
  assert.deepEqual(departures, [undefined]);
  assert.deepEqual(remembers, []);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.deepEqual(remembers.map((r) => r.accounts), [[[choices.bankKey(keys.pan), "bank"]]]);
});

test("a failed remembered asset can be changed without a prepared plan", async () => {
  const { run, props, profiles, remembers } = setup({ entries: [] });
  const [key, choice] = Object.entries(props.fundChoices)[0];
  choice.fund.assetId = "missing-type";
  profiles["missing-type"] = { instrumentSymbol: choice.fund.symbol, instrumentExchangeMic: "XBOM" };
  await run.flush();
  assert.match(footer(run)[0], /type .* isn't set/);
  assert.equal(find(run, "Footer").action.disabled, true);
  const recovery = nodes(run.tree).find((node) => node.props?.["aria-label"]?.startsWith("Change:") && node.props.onClick);
  assert.ok(recovery, "the error leaves a fund's Change available");
  recovery.props.onClick();
  await run.flush();
  const question = find(run, "QuestionCard");
  assert.equal(question.item.key, key);
  const { assetId, ...replacement } = choice.fund;
  question.onAnswer({ fund: replacement });
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  assert.ok(find(run, "FundsReadyTable").rows.length > 0);
  assert.deepEqual(remembers, []);
});

test("chips count each PAN's own rows when one shared fund waits for earlier purchases", async () => {
  const { run, keys } = setup({ entries: [], change(data) {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    data.folios[0].schemes = [liquid];
    const waiting = structuredClone(liquid);
    waiting.open = "10";
    waiting.close = String(Number(liquid.close) + 10);
    waiting.close_calculated = waiting.close;
    data.folios[1].schemes = [waiting];
    data.folios[1].PAN = "OTHER1234F";
    data.folios[1].name = "B. Investor";
    return data;
  }, remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.panKey("OTHER1234F")]: "mf" } });
  await run.flush();
  assert.match(textOf(run.tree), /2 funds1 ready1 not included/);
  assert.equal(find(run, "NotIncludedDetailed").earlier.length, 1);
  // Excluding one PAN doesn't mark the other PAN's waiting rows ready.
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  await run.flush();
  assert.match(textOf(run.tree), /2 funds0 ready2 not included/);
});

test("a withheld statement-price asset keeps an AMFI result unconfirmed", async () => {
  for (const providerId of [undefined, "AMFI"]) {
    const { run, props, api } = setup({ entries: [], change(data) {
      data.folios = [data.folios[0]];
      data.folios[0].schemes = [data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"))];
      return data;
    } });
    props.fundChoices = {};
    const { statementSymbol } = await server.ssrLoadModule("/src/cas/holdings.ts");
    const scheme = props.data.folios[0].schemes[0];
    api.market.searchTicker = async () => [
      { symbol: statementSymbol(scheme), longName: scheme.scheme, currency: "INR", quoteType: "MUTUALFUND", pricingMode: "MANUAL", existingAssetId: "from-statements", providerId, exactMatch: true },
      { symbol: "123456", longName: scheme.scheme, currency: "INR", quoteType: "MUTUALFUND", providerId: "AMFI" },
    ];
    await run.flush();
    const question = find(run, "QuestionCard");
    assert.ok(question, "the result requires an answer");
    assert.deepEqual(question.search.auto.results.map((r) => r.symbol), ["123456"]);
    question.onAnswer({ fund: question.search.auto.results[0] });
    await run.flush();
    assert.equal(find(run, "Footer").action.disabled, false);
    run.dispose();
  }
});

test("equal possible duplicates have numbered checkbox names", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const purchase = scheme.transactions.find((t) => t.type === "PURCHASE");
    scheme.transactions = [purchase, structuredClone(purchase)];
    scheme.open = "0";
    scheme.close = scheme.close_calculated = String(Number(purchase.units) * 2);
    data.folios = [{ ...data.folios[0], schemes: [scheme] }];
    return data;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const duplicates = find(run, "BeforeImporting").duplicates;
  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].title, duplicates[1].title);
  assert.deepEqual(duplicates.map((d) => d.label), duplicates.map((d, i) => `${d.title}, transaction ${i + 1}`));
});

test("a zero-send plan still opens the read-only transaction table", async () => {
  const { run, api } = setup({ entries: [] });
  api.activities.checkImport = async (rows) => rows.map((r) => ({ ...r, duplicateOfId: "previous" }));
  await run.flush();
  assert.equal(find(run, "Footer").action.label, "Finish");
  const see = nodes(find(run, "Footer").lines).find((node) => node.props?.children === "See every transaction");
  assert.ok(see);
  see.props.onClick();
  await run.flush();
  assert.ok(find(run, "ActivityTable").plan.length > 0);
});

test("the first announcement counts bank and account questions; mixed questions have their own heading", async () => {
  const { run, props, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "1 question for you.");
  // Keep the purchase check, with an account question in the other folio and a fund question here.
  saveTo(run).onChange(keys.testbridge, "");
  props.unavailable[choices.bankKey(keys.testbridge)] = { name: "Missing bank" };
  const fund = props.data.folios[0].schemes.find((s) => !s.scheme.includes("Liquid"));
  delete props.fundChoices[choices.fundKey(fund)];
  saveTo(run).onChange(keys.fictiva, "mf");
  await run.flush();
  // The other imported funds still provide the bank check.
  assert.match(textOf(run.tree), /Other questions/);
});

test("an all-closed statement keeps the printed investor in its heading", async () => {
  const { run, props } = setup({ change(data) {
    data.folios.forEach((f) => { f.schemes = []; });
    return data;
  } });
  await run.flush();
  assert.equal(find(run, "ReviewHeader").lines[0], `CAMS statement · ${props.statement.investor_info.name} · made-up.pdf`);
});

test("preparation shares cached reads, ignores an older run, and imports the current choices", async () => {
  const { run, api, keys, imported } = setup({ entries: [] });
  const read = api.activities.getAll;
  let reads = 0;
  api.activities.getAll = async (...args) => { reads++; return read(...args); };
  const pending = [];
  api.activities.checkImport = (rows) => new Promise((resolve) => pending.push({ rows, resolve }));
  await run.flush();
  assert.equal(pending.length, 1);
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).onChange(keys.pan, "other");
  await run.flush();
  assert.equal(pending.length, 2);
  assert.equal(reads, 1);
  assert.equal(find(run, "Footer").action.disabled, true);
  pending[1].resolve(pending[1].rows);
  await run.flush();
  assert.match(footer(run)[0], /into Other funds\./);
  pending[0].resolve(pending[0].rows);
  await run.flush();
  assert.match(footer(run)[0], /into Other funds\./);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(imported[0].every((r) => r.accountId === "other"));
});

test("opening the page again refreshes Wealthfolio reads", async () => {
  const { run, props, api, keys } = setup({ entries: [] });
  const read = api.activities.getAll;
  let reads = 0;
  api.activities.getAll = async (...args) => { reads++; return read(...args); };
  await run.flush();
  saveTo(run).onChange(keys.pan, "other");
  await run.flush();
  assert.equal(reads, 1);
  props.visit = {};
  saveTo(run).onChange(keys.pan, "mf");
  await run.flush();
  assert.equal(reads, 2);
});

test("Import rereads linked bank entries and refreshes the plan when one changed", async () => {
  const { run, keys, activities, imported } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  await run.flush();
  checksUnder(run, choices.bankKey(keys.pan))[0].onLink();
  await run.flush();
  const index = activities.findIndex((a) => a.id === "purchase");
  activities[index] = { ...activities[index], amount: "1" };
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 0);
  const [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id), ["dividend"]);
  assert.equal(check.answered, undefined);
  assert.match(textOf(run.tree), /Nothing was imported: bank entries you chose changed/);
  check.onNone();
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(imported[0].some((r) => r.accountId === "bank" && r.activityType === "TRANSFER_OUT"));
});

test("an accepted paired gift shows the right difference note in both accounts, in either folio order", async () => {
  for (const receivingFirst of [true, false]) {
    const { run, api, data, props, profiles, activities } = setup({ entries: [], change(data) {
      const base = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      const row = (date, type, amount, units, gift_folio = null) => ({
        date, type, amount, units, nav: "50", balance: null, description: type, dividend_rate: null, gift_folio,
      });
      const receiving = { ...structuredClone(base), open: "0", close: "10", close_calculated: "10",
        transactions: [row("2024-06-03", "GIFT_IN", "500", "10", "33333333")] };
      const giving = { ...structuredClone(base), open: "0", close: "0", close_calculated: "0", transactions: [
        row("2024-06-01", "PURCHASE", "500", "10"), row("2024-06-03", "GIFT_OUT", "-500", "-10", "11111111"),
      ] };
      const receiver = { ...data.folios[0], folio: "11111111", schemes: [receiving] };
      const giver = { ...data.folios[0], folio: "33333333", schemes: [giving] };
      data.folios = receivingFirst ? [receiver, giver] : [giver, receiver];
      return data;
    } });
    const symbol = Object.values(props.fundChoices)[0].fund.symbol;
    profiles.asset = { instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
    for (const accountId of ["mf", "other"]) activities.push({
      id: `${accountId}-buy`, accountId, activityType: "BUY", subtype: null, status: "POSTED", date: "2023-04-04T00:00:00Z",
      quantity: "5", unitPrice: "50", amount: "250", fee: null, tax: null, currency: "INR", needsReview: false,
      comment: null, assetId: "asset", assetSymbol: symbol, sourceRecordId: null,
    });
    api.activities.checkImport = async (rows) => rows.map((r) => r.activityType.startsWith("TRANSFER") ? { ...r, duplicateOfId: "host-existing" } : r);
    await run.flush();
    saveTo(run).onChange(choices.folioKey(data.folios.find((f) => f.folio === "11111111")), "other");
    await run.flush();
    const before = find(run, "BeforeImporting");
    assert.equal(before.duplicates.length, 1);
    before.onDuplicate(before.duplicates[0].key, true);
    await run.flush();
    const rows = find(run, "FundsReadyTable").rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.group.forced, 1);
      assert.equal(row.unitsAfter, row.group.accountId === "other" ? "15.000" : "5.000");
      assert.ok(row.note.endsWith(`Includes the second gift ${row.group.accountId === "other" ? "received" : "given"} you chose.`), row.note);
    }
    run.dispose();
  }
});

test("AMFI's remaining-question announcement waits for the newly matched fund's bank plan", async () => {
  const { run, props, api, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  }, change(data) {
    data.folios = [data.folios[0]];
    data.folios[0].schemes = [data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"))];
    return data;
  } });
  props.fundChoices = {};
  await run.flush();
  const pending = [];
  api.activities.checkImport = (rows) => new Promise((resolve) => pending.push({ rows, resolve }));
  let finishSearch;
  api.market.searchTicker = () => new Promise((resolve) => { finishSearch = resolve; });
  props.amfi.searches++;
  props.amfi.status = "on";
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  finishSearch([{ symbol: "123456", longName: props.data.folios[0].schemes[0].scheme, currency: "INR", quoteType: "MUTUALFUND", providerId: "AMFI" }]);
  await run.flush();
  assert.equal(pending.length, 1);
  const status = () => nodes(run.tree).find((node) => node.props?.role === "status").props.children;
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.doesNotMatch(status(), /No questions remain/);
  assert.equal(find(run, "Footer").action.disabled, true);
  pending[0].resolve(pending[0].rows);
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(status(), "AMFI added: 1 fund matched. 1 question remains.");
  assert.match(footer(run)[0], /payment check/);
});

test("answering a bank check during a fund lookup doesn't announce readiness", async () => {
  const { run, props, api, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  const fund = props.data.folios[0].schemes.find((s) => !s.scheme.includes("Liquid"));
  delete props.fundChoices[choices.fundKey(fund)];
  api.market.searchTicker = () => new Promise(() => {});
  await run.flush();
  checksUnder(run, choices.bankKey(keys.pan))[0].onNone();
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  const status = nodes(run.tree).find((node) => node.props?.role === "status").props.children;
  assert.doesNotMatch(status, /All questions answered|Ready to import/);
  assert.match(status, /Looking up 1 fund/);
  assert.match(footer(run)[0], /Looking up 1 fund/);
});

test("a mixed family heading includes the investor whose folio has no PAN", async () => {
  const { run, props } = setup({ change(data) {
    data.folios[1].PAN = null;
    data.folios[1].name = "B. Investor";
    return data;
  } });
  await run.flush();
  assert.equal(find(run, "ReviewHeader").lines[0], `CAMS statement · ${props.data.folios[0].name} and B. Investor · made-up.pdf`);
});

test("an old duplicate tick cannot force a row already imported into a newly chosen account", async () => {
  const first = setup({ entries: [] });
  await first.run.flush();
  nodes(find(first.run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
  await first.run.flush();
  const liquid = find(first.run, "ActivityTable").plan.find((t) => t.transaction.scheme.includes("Liquid") && t.transaction.activity.activityType === "BUY");
  const purchase = liquid.transaction.activity;
  const entries = [stored(purchase, "mf", "by-hand"), ...liquid.rows.map((r, i) =>
    stored(r.activity, "other", `imported-${i}`, `addon:cas-importer:${r.activity.sourceRecordId}`))];
  first.run.dispose();
  const { run, profiles, keys, imported } = setup({ entries });
  profiles["liquid-asset"] = { instrumentSymbol: purchase.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  const before = find(run, "BeforeImporting");
  assert.equal(before.duplicates.length, 1);
  before.onDuplicate(before.duplicates[0].key, true);
  await run.flush();
  saveTo(run).onChange(keys.pan, "other");
  await run.flush();
  assert.equal(find(run, "BeforeImporting").duplicates.length, 0);
  nodes(find(run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
  await run.flush();
  const table = find(run, "ActivityTable");
  const existing = table.plan.find((t) => t.transaction.activity.sourceRecordId === purchase.sourceRecordId);
  assert.equal(existing.status, "existing");
  assert.equal(table.sent(existing), false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(imported[0].every((r) => r.sourceRecordId !== purchase.sourceRecordId));
});

test("an immediate AMFI result is announced after its bank plan settles", async () => {
  const { run, props, api, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  }, change(data) {
    data.folios = [data.folios[0]];
    data.folios[0].schemes = [data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"))];
    return data;
  } });
  props.fundChoices = {};
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  api.market.searchTicker = async () => [{ symbol: "123456", longName: props.data.folios[0].schemes[0].scheme, currency: "INR", quoteType: "MUTUALFUND", providerId: "AMFI" }];
  props.amfi.searches++;
  props.amfi.status = "on";
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "AMFI added: 1 fund matched. 1 question remains.");
});

test("skipping the final fund announces answered questions without claiming readiness", async () => {
  const { run, props } = setup({ entries: [], change(data) {
    data.folios = [data.folios[0]];
    data.folios[0].schemes = [data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"))];
    return data;
  } });
  props.fundChoices = {};
  await run.flush();
  find(run, "QuestionCard").onAnswer({ leftOut: true });
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(find(run, "Footer").action.label, "Finish");
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "All questions answered.");
});

test("a confirmed fund waiting only for earlier purchases can be changed", async () => {
  const { run, props, remembers } = setup({ entries: [], change(data) {
    data.folios = [data.folios[0]];
    data.folios[0].schemes = [data.folios[0].schemes.find((s) => Number(s.open) > 0)];
    return data;
  } });
  const choice = Object.values(props.fundChoices)[0].fund;
  choice.symbol = "WRONG-ASSET";
  choice.name = "Wrong Fund - Direct Plan - Growth";
  await run.flush();
  assert.equal(find(run, "FundsReadyTable"), undefined);
  assert.equal(find(run, "QuestionCard"), undefined);
  const part = nodes(run.tree).find((node) => node.type?.name === "NotIncludedDetailed");
  assert.equal(part.props.earlier.length, 1);
  const change = nodes(part.type(part.props)).find((node) => node.props?.["aria-label"]?.startsWith("Change:") && node.props.onClick);
  assert.ok(change);
  change.props.onClick();
  await run.flush();
  assert.equal(find(run, "QuestionCard").item.key, Object.keys(props.fundChoices)[0]);
  assert.deepEqual(remembers, []);
});

test("a defaulted unbalanced fund can be changed even when it has no meaningful rows", async () => {
  for (const noRows of [false, true]) {
    const { run, props } = setup({ entries: [], change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      data.folios = [{ ...data.folios[0], schemes: [scheme] }];
      if (noRows) { scheme.transactions = []; scheme.close_calculated = "0"; }
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    await run.flush();
    const part = nodes(run.tree).find((node) => node.type?.name === "NotIncludedDetailed");
    assert.deepEqual(part.props.defaulted.map((f) => f.key), Object.keys(props.fundChoices));
    const change = nodes(part.type(part.props)).find((node) => node.props?.["aria-label"]?.endsWith("rows don't add up") && node.props.onClick);
    assert.ok(change);
    change.props.onClick();
    await run.flush();
    assert.equal(find(run, "QuestionCard").item.key, Object.keys(props.fundChoices)[0]);
    run.dispose();
  }
});

test("a fund with nothing new still has Change on its line", async () => {
  const single = (data) => {
    data.folios = [data.folios[0]];
    data.folios[0].schemes = [data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"))];
    return data;
  };
  const first = setup({ entries: [], change: single });
  await first.run.flush();
  nodes(find(first.run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
  await first.run.flush();
  const plan = find(first.run, "ActivityTable").plan;
  const symbol = plan[0].transaction.activity.symbol;
  const entries = plan.flatMap((t) => t.rows.map((r) => r.activity)).map((a, i) => stored(a, "mf", `imported-${i}`, `addon:cas-importer:${a.sourceRecordId}`));
  first.run.dispose();
  const { run, profiles } = setup({ entries, change: single });
  profiles["liquid-asset"] = { instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  assert.equal(find(run, "FundsReadyTable"), undefined);
  assert.match(footer(run)[0], /Nothing new: every transaction/);
  const change = nodes(run.tree).find((node) => node.props?.["aria-label"]?.endsWith("nothing new") && node.props.onClick);
  assert.ok(change);
  change.props.onClick();
  await run.flush();
  assert.ok(find(run, "QuestionCard"));
});

test("a shared bank check anchors under its first imported folio even if only a later folio has a match", async () => {
  const { run, keys } = setup({ entries: [ENTRIES[0]] });
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.fictiva), "bank");
  saveTo(run).onChange(choices.bankKey(keys.testbridge), "bank");
  await run.flush();
  const [check] = checksUnder(run, choices.bankKey(keys.fictiva));
  assert.ok(check);
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id), ["dividend"]);
  assert.equal(checksUnder(run, choices.bankKey(keys.testbridge)).length, 0);
  check.onNone();
  await run.flush();
  // Removing that folio moves the unchanged check and preserves its answer.
  saveTo(run).onChange(keys.fictiva, choices.LEFT_OUT);
  await run.flush();
  assert.equal(checksUnder(run, choices.bankKey(keys.fictiva)).length, 0);
  assert.equal(checksUnder(run, choices.bankKey(keys.testbridge))[0].answered, 0);
});

test("PAN titles disambiguate equal investor names after whitespace collapses", async () => {
  const { run } = setup({ entries: [], change(data) {
    data.folios[0].name = "A. Investor";
    data.folios[1].name = "A.  Investor";
    data.folios[1].PAN = "PQRST5678G";
    return data;
  } });
  await run.flush();
  const boxes = saveTo(run).boxes;
  assert.ok(boxes.every((b) => b.name === "A. Investor"));
  assert.equal(new Set(boxes.map((b) => b.title.replace(/\s+/g, " "))).size, 2);
  assert.ok(boxes.every((b) => b.title.includes(b.folios[0].PAN)));
});

test("secondary Change controls for merged funds distinguish same-named accounts", async () => {
  const { run, props, data } = setup({ entries: [], change(data) {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const a = { ...structuredClone(liquid), scheme: "Fictiva Fund A", isin: "INF-FUND-A" };
    const b = { ...structuredClone(liquid), scheme: "Fictiva Fund B", isin: "INF-FUND-B" };
    const first = { ...data.folios[0], schemes: [a, b] };
    data.folios = [first, { ...structuredClone(first), folio: "222222222" }];
    return data;
  } });
  props.accounts = props.accounts.map((a) => ({ ...a, name: a.id === "other" ? "Mutual funds" : a.name }));
  props.allAccounts = props.accounts;
  Object.values(props.fundChoices).forEach(({ fund }) => { fund.symbol = "shared-fund"; fund.name = "Fictiva Shared Fund"; });
  await run.flush();
  saveTo(run).onChange(choices.folioKey(data.folios[1]), "other");
  await run.flush();
  const table = find(run, "FundsReadyTable");
  assert.equal(table.rows.length, 2);
  assert.ok(table.rows.every((r) => r.items.length === 2));
  const labels = table.rows.map((r) => table.handlers.label(r, r.items[1]));
  assert.equal(new Set(labels).size, 2);
  assert.ok(labels.every((label) => /in Mutual funds, account [12]$/.test(label)), labels.join("; "));
});

test("starting bank ticks survive changed evidence with the same pairs, before and after linking", async () => {
  for (const linked of [false, true]) {
    const { run, keys } = setup({
      entries: [entry("payment", "WITHDRAWAL", "1000", "2024-05-01", "FICTIVA MF")],
      remembered: {
        [choices.panKey("ABCDE1234F")]: "mf",
        [choices.bankKey(choices.folioKey(fixture.folios[0]))]: "bank",
      },
      change(data) {
        const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
        const scheme = (date) => ({ ...structuredClone(liquid), open: "0", close: "10", close_calculated: "10", transactions: [{
          date, type: "PURCHASE", amount: "1000", units: "10", nav: "100", balance: "10", description: "Purchase", dividend_rate: null, gift_folio: null,
        }] });
        const first = { ...data.folios[0], schemes: [scheme("2024-05-01")] };
        data.folios = [first, { ...structuredClone(first), folio: "222222222", schemes: [scheme("2024-05-05")] }];
        return data;
      },
    });
    await run.flush();
    let [check] = checksUnder(run, choices.bankKey(keys.fictiva));
    assert.equal(check.check.pairs[0].strong, true);
    assert.equal(check.ticked.size, 1);
    assert.equal(find(run, "ReviewHeader").changes, 0, "automatic defaults are not unsaved user changes");
    const signature = check.check.signature;
    if (linked) { check.onLink(); await run.flush(); }
    const second = saveTo(run).boxes[0].folios[1];
    saveTo(run).onChange(choices.bankKey(choices.folioKey(second)), "bank");
    await run.flush();
    [check] = checksUnder(run, choices.bankKey(keys.fictiva));
    assert.equal(check.check.signature, signature);
    assert.equal(check.check.pairs[0].strong, false);
    assert.equal(check.ticked.size, 1);
    assert.equal(check.answered, linked ? 1 : undefined);
    if (linked) assert.ok(footer(run).some((line) => line.includes("1 uses an entry already there, 1 gets a new transfer")), footer(run).join("; "));
    run.dispose();
  }
});

test("returning to an earlier bank pair set never revives its old answer with new ticks", async () => {
  const { run, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  await run.flush();
  const anchor = choices.bankKey(keys.pan);
  let [check] = checksUnder(run, anchor);
  const original = check.check.signature;
  const dividend = check.check.pairs.find((p) => p.entry.id === "dividend");
  check.onTick(dividend.key, false);
  await run.flush();
  checksUnder(run, anchor)[0].onLink();
  await run.flush();
  assert.equal(checksUnder(run, anchor)[0].answered, 1);
  saveTo(run).onChange(choices.bankKey(keys.testbridge), choices.NO_BANK);
  await run.flush();
  [check] = checksUnder(run, anchor);
  assert.notEqual(check.check.signature, original);
  assert.equal(check.answered, undefined);
  check.onTick(check.check.pairs[0].key, false);
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.testbridge), "");
  await run.flush();
  [check] = checksUnder(run, anchor);
  assert.equal(check.check.signature, original);
  assert.equal(check.answered, undefined);
  assert.equal(find(run, "Footer").action.disabled, true);
});

test("Import rechecks accepted bank details after a revisit, then accepts the disclosed changes", async () => {
  for (const change of ["split", "unknown", "amount"]) {
    const { run, props, keys, api, activities, imported } = setup({ entries: [ENTRIES[1]], remembered: {
      [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
    } });
    let splits = [];
    let unreadable = false;
    api.spending.getContext = async () => {
      if (unreadable) throw new Error("Spending unavailable");
      return { enabled: true, accountIds: ["bank"], excludedCategoryIds: [] };
    };
    api.spending.searchCashActivities = async () => ({ items: [{ id: "purchase", splits, assignments: [] }], totalCount: 1 });
    api.spending.unassignCategory = async () => {};
    const updates = [];
    api.activities.create = async () => ({ id: "new-fund-transfer" });
    api.activities.update = async (row) => { updates.push(row); };
    api.activities.linkTransfer = async () => {};
    await run.flush();
    const anchor = choices.bankKey(keys.pan);
    let [check] = checksUnder(run, anchor);
    assert.equal(check.check.pairs[0].strong, true);
    const signature = check.check.signature;
    check.onLink();
    await run.flush();
    if (change === "split") splits = [
      { categoryId: "groceries", taxonomyId: "spending_categories" }, { categoryId: "travel", taxonomyId: "spending_categories" },
    ];
    if (change === "unknown") unreadable = true;
    if (change === "amount") activities[0] = { ...activities[0], amount: "24998.75" };
    props.visit = {};
    saveTo(run).onChange(anchor, "bank");
    await run.flush();
    [check] = checksUnder(run, anchor);
    assert.equal(check.check.signature, signature);
    assert.equal(check.answered, 1);
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(imported.length, 0, `${change} wasn't accepted with the original bank answer`);
    assert.equal(updates.length, 0);
    const warning = textOf(run.tree);
    assert.match(warning, /Nothing was imported: bank entries you chose changed/);
    if (change === "split") assert.match(warning, /split across 2 spending categories/);
    if (change === "unknown") assert.match(warning, /Couldn't check whether this entry is split/);
    if (change === "amount") assert.match(warning, /24998.75/);
    // The warning showed the new details; a second Import can proceed without a warning loop.
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(imported.length, 1);
    assert.equal(updates.length, 1);
    run.dispose();
  }
});

test("funds held back with no counted rows are not called Nothing new", async () => {
  for (const reason of ["earlier", "unbalanced"]) {
    const { run } = setup({ entries: [], change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      scheme.transactions = [];
      scheme.open = reason === "earlier" ? "10" : "0";
      scheme.close = "10";
      scheme.close_calculated = scheme.open;
      data.folios = [{ ...data.folios[0], schemes: [scheme] }];
      return data;
    } });
    await run.flush();
    assert.match(textOf(run.tree), /1 fund0 ready1 not included/);
    assert.doesNotMatch(textOf(run.tree), /Nothing new for|Ready to import/);
    assert.equal(find(run, "TransactionsSummary").breakdown.total, 0);
    const left = find(run, "NotIncludedDetailed");
    assert.equal((reason === "earlier" ? left.earlier : left.defaulted).length, 1);
    assert.equal(find(run, "Footer").action.label, "Finish");
    run.dispose();
  }
});

test("two folios with their own bank accounts each get a check under their own choice", async () => {
  const entries = [ENTRIES[1], { ...ENTRIES[0], accountId: "other" }];
  const { run, keys } = setup({ entries });
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.fictiva), "bank");
  saveTo(run).onChange(choices.bankKey(keys.testbridge), "other");
  await run.flush();
  assert.equal(checksUnder(run, choices.bankKey(keys.pan)).length, 0);
  const [savings] = checksUnder(run, choices.bankKey(keys.fictiva));
  const [other] = checksUnder(run, choices.bankKey(keys.testbridge));
  assert.deepEqual([savings.check.bankName, savings.check.pairs.map((p) => p.entry.id)], ["Savings", ["purchase"]]);
  assert.deepEqual([other.check.bankName, other.check.pairs.map((p) => p.entry.id)], ["Other funds", ["dividend"]]);
  assert.match(footer(run)[0], /^2 questions left: 2 payment checks before importing\.$/);
  savings.onLink();
  await run.flush();
  // Answering one leaves the other open.
  assert.equal(checksUnder(run, choices.bankKey(keys.testbridge))[0].answered, undefined);
  assert.equal(checksUnder(run, choices.bankKey(keys.fictiva))[0].answered, 1);
});

test("a remembered bank account of another account type that tracks transactions is kept", async () => {
  const pan = choices.panKey("ABCDE1234F");
  const { run, props, keys } = setup({ remembered: { [pan]: "mf", [choices.bankKey(pan)]: "other" } });
  props.accounts = props.allAccounts = ACCOUNTS.map((a) => (a.id === "other" ? { ...a, accountType: "SECURITIES" } : { ...a, accountType: "CASH" }));
  await run.flush();
  assert.equal(saveTo(run).values[choices.bankKey(keys.pan)], "other");
  assert.equal(saveTo(run).ignored[choices.bankKey(keys.pan)], undefined);
  assert.equal(saveTo(run).remembered, "all");
});

test("answering a fund's question moves its transactions from waiting to import", async () => {
  const { run, props } = setup({ entries: [] });
  const overnight = Object.keys(props.fundChoices).find((key) => !key.startsWith("isin:"));
  delete props.fundChoices[overnight];
  await run.flush();
  const parts = () => find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([parts().toImport, parts().answers, parts().earlier], [11, 2, 26]);
  assert.deepEqual(footer(run), ["1 question left before importing."]);
  find(run, "QuestionCard").onAnswer({ fund: { symbol: "OVERNIGHT", exchangeMic: "XBOM", quoteCcy: "INR", name: "Overnight", instrumentType: "MUTUALFUND", providerId: "YAHOO" } });
  await run.flush();
  assert.deepEqual([parts().toImport, parts().answers, parts().earlier], [13, 0, 26]);
  assert.deepEqual(footer(run).slice(0, 1), ["Import 13 transactions for 4 funds into Mutual funds."]);
});

test("a statement whose only fund waits for earlier purchases has nothing ready, and says why", async () => {
  const { run } = setup({ entries: [], change: (data) => {
    data.folios = [{ ...data.folios[0], schemes: [data.folios[0].schemes[0]] }];
    return data;
  } });
  await run.flush();
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.total, b.earlier, b.toImport], [26, 26, 0]);
  assert.deepEqual(footer(run).slice(0, 1), ["Nothing is ready to import. See the transactions left out or waiting above."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("a repeated statement with a reversed purchase left out isn't called nothing new", async () => {
  // Liquid Fund alone, with a purchase and its reversal added.
  const change = (data) => {
    const liquid = structuredClone(data.folios[0].schemes[1]);
    const row = (date, type, amount, units) => ({ ...liquid.transactions[0], date, type, amount, units, description: type, balance: null });
    liquid.transactions.push(row("2024-02-01", "PURCHASE", "1000.00", "0.400"), row("2024-02-03", "REVERSAL", "-1000.00", "-0.400"));
    data.folios = [{ ...data.folios[0], schemes: [liquid] }];
    return data;
  };
  const first = setup({ entries: [], change });
  await first.run.flush();
  find(first.run, "Footer").action.onClick();
  await first.run.flush();
  const [rows] = first.imported;
  first.run.dispose();
  // What the import added, as Wealthfolio returns it with the add-on's row IDs.
  const stored = rows.map((r, i) => ({
    id: `stored-${i}`, accountId: r.accountId, activityType: r.activityType, subtype: r.subtype ?? null, status: "POSTED",
    date: `${r.date}T00:00:00+00:00`, quantity: r.quantity ?? null, unitPrice: r.unitPrice ?? null, amount: r.amount ?? null, fee: null,
    tax: r.tax ?? null, currency: r.currency, needsReview: false, comment: null, assetId: r.symbol ? `asset-${r.symbol}` : "",
    assetSymbol: r.symbol ?? "", exchangeMic: r.exchangeMic ?? null, sourceRecordId: `addon:cas-importer:${r.sourceRecordId}`,
  }));
  const { run } = setup({ entries: stored, change });
  await run.flush();
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.toImport, b.before, b.leftOut.map((l) => l.kind)], [0, 3, ["reversal", "reversal"]]);
  assert.deepEqual(footer(run).slice(0, 1), ["Nothing is ready to import. See the transactions left out or waiting above."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

// Accounts proposed when none fits, created when the transactions are imported.
/**
 * A review where Wealthfolio has only Savings, which can't take funds (it tracks holdings here), or
 * `accounts`, and remembers nothing. Wealthfolio creates each account asked for, except names in
 * `refuse`; the add-on's page adds them to its accounts and keeps what's remembered, as the import page does.
 */
function withNewAccounts({ accounts = [], refuse = new Set(), change } = {}) {
  const context = setup({ entries: [], remembered: {}, change });
  const { props, api } = context;
  Object.assign(props, { accounts, allAccounts: accounts });
  const asked = [];
  const checkedAt = [];
  let next = 0;
  api.accounts = {
    create: async (payload) => {
      asked.push(payload);
      if (refuse.has(payload.name)) throw new Error(`made-up refusal of ${payload.name}`);
      return { id: `created-${++next}`, ...payload, isArchived: false, group: null };
    },
  };
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => {
    checkedAt.push([...new Set(rows.map((r) => r.accountId))]);
    return check(rows);
  };
  props.onCreated = (made) => context.run.update({ accounts: [...props.accounts, ...made], allAccounts: [...props.allAccounts, ...made] });
  props.onRemember = (r) => {
    context.remembers.push(r);
    context.run.update({ accountChoices: { ...props.accountChoices, ...Object.fromEntries(r.accounts) } });
  };
  return { ...context, asked, checkedAt, refuse };
}
const textOfLine = (node) => (Array.isArray(node) ? node.map(textOfLine).join("") : node && typeof node === "object" ? textOfLine(node.props?.children) : node == null || node === false ? "" : String(node));

test("a new profile proposes Mutual funds, creates it on importing, checks its rows there and only then remembers it", async () => {
  const { run, keys, asked, checkedAt, imported, remembers } = withNewAccounts();
  await run.flush();
  const box = saveTo(run);
  assert.equal(box.values[keys.pan], proposedId(keys.pan));
  assert.deepEqual(box.proposed(keys.pan), { id: proposedId(keys.pan), name: "Mutual funds" });
  assert.equal(box.values[choices.folioKey(find(run, "SaveToDetailed").boxes[0].folios[0])], "");
  const line = box.newLine(keys.pan, "ANANYA R TESTWALA's funds");
  assert.equal(textOfLine(line.type(line.props)), "New · Wealthfolio account, created when you save · Rename");
  assert.match(footer(run)[0], /^Create the Wealthfolio account Mutual funds and import \d+ transactions for \d+ funds into it\.$/);
  const action = find(run, "Footer").action;
  assert.match(action.label, /^Create account and import \d+ transactions$/);
  // Wealthfolio can't check rows for an account that doesn't exist yet.
  assert.deepEqual(checkedAt, []);
  action.onClick();
  await run.flush();
  assert.deepEqual(asked, [{ name: "Mutual funds", accountType: "SECURITIES", currency: "INR", isDefault: false, isActive: true, trackingMode: "TRANSACTIONS" }]);
  assert.deepEqual(checkedAt, [["created-1"]]);
  assert.equal(imported.length, 1);
  assert.deepEqual([...new Set(imported[0].map((r) => r.accountId))], ["created-1"]);
  assert.deepEqual(remembers.map((r) => r.accounts), [[], [[keys.pan, "created-1"]]]);
  const result = find(run, "ImportResult");
  assert.deepEqual(result.notCreated, []);
  assert.equal(result.retry, undefined);
  assert.equal(result.accounts.find((a) => a.id === "created-1").name, "Mutual funds");
});

test("with an account for transactions but none remembered, nothing is preselected and the new one stays offered", async () => {
  const { run, keys, asked } = withNewAccounts({ accounts: [account("mf", "Mutual funds")] });
  await run.flush();
  assert.equal(saveTo(run).values[keys.pan], null);
  assert.equal(saveTo(run).proposed(keys.pan).name, "Mutual funds 2");
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).onChange(keys.pan, "mf");
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked, []);
});

test("a folio sent to its own new account gets one, named after it", async () => {
  const { run, keys, asked, imported } = withNewAccounts();
  await run.flush();
  saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
  await run.flush();
  assert.equal(saveTo(run).proposed(keys.testbridge).name, "Testbridge Mutual Fund folio 1040012345");
  const lines = footer(run).filter((l) => l.startsWith("Create"));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Create the Wealthfolio account Testbridge Mutual Fund folio 1040012345 and import \d+ transactions? for \d+ funds? into it\.$/);
  assert.match(find(run, "Footer").action.label, /^Create 2 accounts and import \d+ transactions$/);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Testbridge Mutual Fund folio 1040012345"]);
  assert.deepEqual(new Set(imported[0].map((r) => r.accountId)), new Set(["created-1", "created-2"]));
});

/** Two investors, each with a PAN; the second's folio receives a gift from a folio of the first's. */
function twoInvestorGift(data) {
  const base = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
  const row = (date, type, amount, units, gift_folio = null) => ({
    date, type, amount, units, nav: "50", balance: null, description: type, dividend_rate: null, gift_folio,
  });
  const giving = { ...structuredClone(base), open: "0", close: "0", close_calculated: "0", transactions: [
    row("2024-06-01", "PURCHASE", "500", "10"), row("2024-06-03", "GIFT_OUT", "-500", "-10", "44444444"),
  ] };
  const receiving = { ...structuredClone(base), open: "0", close: "10", close_calculated: "10",
    transactions: [row("2024-06-03", "GIFT_IN", "500", "10", "33333333")] };
  data.folios = [
    ...data.folios,
    { ...data.folios[0], folio: "33333333", schemes: [giving] },
    { ...data.folios[0], folio: "44444444", PAN: "FGHIJ5678K", name: "B. Investor", schemes: [receiving] },
  ];
  return data;
}

test("a gift to an account Wealthfolio didn't create waits whole, and Try again imports both sides together", async () => {
  const refuse = new Set(["Mutual funds (B. Investor)"]);
  const { run, asked, imported, remembers } = withNewAccounts({ refuse, change: twoInvestorGift });
  await run.flush();
  const boxes = saveTo(run).boxes;
  assert.deepEqual(boxes.map((b) => saveTo(run).proposed(b.key).name), ["Mutual funds", "Mutual funds (B. Investor)"]);
  assert.match(find(run, "Footer").action.label, /^Create 2 accounts and import \d+ transactions$/);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (B. Investor)"]);
  assert.equal(imported.length, 1);
  // Neither side of the gift went in; the first investor's other transactions did.
  assert.ok(!imported[0].some((r) => r.activityType.startsWith("TRANSFER")), JSON.stringify(imported[0].map((r) => r.activityType)));
  assert.ok(imported[0].length > 0);
  assert.deepEqual([...new Set(imported[0].map((r) => r.accountId))], ["created-1"]);
  assert.deepEqual(remembers.at(-1).accounts, [[boxes[0].key, "created-1"]]);
  let result = find(run, "ImportResult");
  assert.deepEqual(result.notCreated.map((n) => n.name), ["Mutual funds (B. Investor)"]);
  assert.equal(result.waiting(result.notCreated[0]), "1 transaction for it wasn't imported.");
  assert.ok(result.retry);
  refuse.clear();
  result.retry();
  await run.flush();
  // Only the account that wasn't created is asked for again.
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (B. Investor)", "Mutual funds (B. Investor)"]);
  assert.equal(imported.length, 2);
  assert.deepEqual(imported[1].map((r) => [r.activityType, r.accountId]), [["TRANSFER_OUT", "created-1"], ["TRANSFER_IN", "created-2"]]);
  assert.deepEqual(remembers.at(-1).accounts, [[boxes[1].key, "created-2"]]);
  result = find(run, "ImportResult");
  assert.deepEqual(result.notCreated, []);
  assert.equal(result.retry, undefined);
  assert.equal(result.result.summary.total, imported[0].length + 2);
  assert.equal(result.sent.length, imported[0].length + 2);
});

test("a transaction Wealthfolio refuses in a new account stays out with its message, and the rest go in", async () => {
  const { run, api, imported } = withNewAccounts();
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => (await check(rows)).map((r) =>
    r.activityType === "DIVIDEND" ? { ...r, isValid: false, errors: { symbol: ["Made-up refusal."] } } : r);
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(!imported[0].some((r) => r.activityType === "DIVIDEND"));
  const result = find(run, "ImportResult").result;
  const refused = result.activities.filter((a) => a.errors?.symbol);
  assert.ok(refused.length > 0);
  assert.ok(refused.every((a) => a.activityType === "DIVIDEND" && a.errors.symbol[0] === "Made-up refusal."));
  const rejected = result.activities.filter((a) => Object.keys(a.errors ?? {}).length);
  assert.ok(rejected.filter((a) => !a.errors.symbol).every((a) =>
    a.errors.general[0] === "Another row of this transaction was rejected, so none of it was imported."));
  assert.equal(result.summary.total, imported[0].length + rejected.length);
  assert.equal(result.summary.skipped, rejected.length);
});

test("when no new account is created, nothing is imported or remembered for it and the review stays", async () => {
  const refuse = new Set(["Mutual funds"]);
  const { run, keys, asked, imported, remembers } = withNewAccounts({ refuse });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult"), undefined);
  assert.equal(imported.length, 0);
  assert.deepEqual(remembers.map((r) => r.accounts), [[]]);
  const alert = find(run, "NotCreatedAlert");
  assert.deepEqual(alert.accounts.map((a) => a.name), ["Mutual funds"]);
  assert.equal(alert.what(alert.accounts[0]), "Nothing was imported.");
  refuse.clear();
  const tryAgain = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOfLine(n) === "Try again");
  tryAgain.props.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds"]);
  assert.equal(imported.length, 1);
  assert.deepEqual(remembers.at(-1).accounts, [[keys.pan, "created-1"]]);
});

test("Rename of a new account waits the import and changes the name it's created with", async () => {
  const { run, keys, asked } = withNewAccounts();
  document.getElementById = () => ({ dataset: {}, focus() {}, scrollIntoView() {} });
  await run.flush();
  const line = () => saveTo(run).newLine(keys.pan, "funds").props;
  line().onRename();
  await run.flush();
  assert.deepEqual(footer(run), ["Save or cancel the new account name first."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Go to it");
  line().onDraft("Family funds");
  await run.flush();
  line().onSave();
  await run.flush();
  assert.match(footer(run)[0], /^Create the Wealthfolio account Family funds and import/);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Family funds"]);
});

test("a created account stops being offered as new after an import exception, and the main button reuses it", async () => {
  const { run, api, keys, asked, imported } = withNewAccounts();
  const send = api.activities.import;
  api.activities.import = async () => { throw new Error("made-up import failure"); };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult"), undefined);
  assert.equal(saveTo(run).values[keys.pan], "created-1");
  assert.equal(saveTo(run).proposed(keys.pan), undefined);
  const view = nodes(run.tree).find((n) => n.type?.name === "SaveToDetailed");
  const select = nodes(view.type(view.props)).find((n) => n.type?.name === "AccountSelect" && n.props.id === keys.pan);
  assert.equal(select.props.proposed, undefined);
  assert.equal(find(run, "Footer").action.disabled, false);
  api.activities.import = send;
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds"]);
  assert.equal(imported.length, 1);
  assert.ok(imported[0].every((r) => r.accountId === "created-1"));
});

test("a refused gift leg reports both withheld rows and counts the whole group", async () => {
  const { run, api, imported } = withNewAccounts({ change: twoInvestorGift });
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => (await check(rows)).map((r) =>
    r.activityType === "TRANSFER_IN" ? { ...r, isValid: false, errors: { symbol: ["Made-up recipient refusal."] } } : r);
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(!imported[0].some((r) => r.activityType.startsWith("TRANSFER")));
  const result = find(run, "ImportResult").result;
  const refused = result.activities.filter((r) => Object.keys(r.errors ?? {}).length);
  assert.deepEqual(refused.map((r) => r.activityType), ["TRANSFER_OUT", "TRANSFER_IN"]);
  assert.deepEqual(refused[0].errors.general, ["Another row of this transaction was rejected, so none of it was imported."]);
  assert.deepEqual(refused[1].errors.symbol, ["Made-up recipient refusal."]);
  assert.equal(result.summary.total, imported[0].length + 2);
  assert.equal(result.summary.skipped, 2);
});

for (const errors of [undefined, {}]) {
  test(`a newly created account's invalid row has a reason with ${errors ? "empty" : "absent"} host errors`, async () => {
    const { run, api, imported } = withNewAccounts();
    const check = api.activities.checkImport;
    api.activities.checkImport = async (rows) => (await check(rows)).map((r) =>
      r.activityType === "DIVIDEND" ? { ...r, isValid: false, errors } : r);
    await run.flush();
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.ok(!imported[0].some((r) => r.activityType === "DIVIDEND"));
    const refused = find(run, "ImportResult").result.activities.filter((r) => r.isValid === false);
    assert.ok(refused.length > 0);
    assert.ok(refused.some((r) => r.activityType === "DIVIDEND"));
    assert.ok(refused.every((r) => r.errors.general[0] === (r.activityType === "DIVIDEND"
      ? "Wealthfolio can't import this row."
      : "Another row of this transaction was rejected, so none of it was imported.")));
  });
}

test("a retry's created account is reported as created even if the held gift's import then fails", async () => {
  const refuse = new Set(["Mutual funds (B. Investor)"]);
  const { run, api, asked, imported } = withNewAccounts({ refuse, change: twoInvestorGift });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult").notCreated.length, 1);
  refuse.clear();
  const send = api.activities.import;
  api.activities.import = async () => { throw new Error("made-up held import failure"); };
  find(run, "ImportResult").retry();
  await run.flush();
  assert.deepEqual(find(run, "ImportResult").notCreated, []);
  assert.ok(find(run, "ImportResult").retry);
  assert.equal(imported.length, 1);
  assert.match(textOfLine(run.tree), /made-up held import failure/);
  api.activities.import = send;
  find(run, "ImportResult").retry();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (B. Investor)", "Mutual funds (B. Investor)"]);
  assert.deepEqual(imported[1].map((r) => [r.activityType, r.accountId]), [["TRANSFER_OUT", "created-1"], ["TRANSFER_IN", "created-2"]]);
  assert.equal(find(run, "ImportResult").retry, undefined);
});

test("a failed held-batch retry leaves its bank entry alone after an earlier batch succeeded", async () => {
  const name = "Testbridge Mutual Fund folio 1040012345";
  const refuse = new Set([name]);
  const { run, props, api, keys, activities, imported } = withNewAccounts({ accounts: [account("bank", "Savings")], refuse });
  api.accounts.getAll = async () => props.allAccounts;
  activities.push({ ...ENTRIES[0] });
  const changed = [];
  api.activities.create = async () => { changed.push("create"); return { id: "fund-transfer" }; };
  api.activities.update = async () => { changed.push("update"); };
  api.activities.linkTransfer = async () => { changed.push("link"); };
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  const [check] = checksUnder(run, choices.bankKey(keys.pan));
  assert.deepEqual(check.check.pairs.map((p) => p.entry.id), ["dividend"]);
  check.onLink();
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(imported[0].length > 0);
  assert.deepEqual(find(run, "ImportResult").notCreated.map((a) => a.name), [name]);
  assert.deepEqual(changed, []);
  refuse.clear();
  const send = api.activities.import;
  api.activities.import = async (rows) => {
    const result = await send(rows);
    const rejected = rows.find((r) => r.activityType !== "DIVIDEND");
    assert.ok(rejected);
    return {
      ...result,
      activities: rows.map((r) => r === rejected ? { ...r, isValid: false, errors: { general: ["Made-up validation failure."] } } : r),
      summary: { ...result.summary, success: false, imported: 0, skipped: 1 },
    };
  };
  find(run, "ImportResult").retry();
  await run.flush();
  assert.equal(imported.length, 2);
  assert.ok(imported[1].some((r) => r.activityType === "DIVIDEND"));
  assert.deepEqual(changed, []);
  const result = find(run, "ImportResult");
  assert.equal(result.result.summary.success, true);
  assert.deepEqual(result.links.map((l) => l.error), ["The trade wasn't imported, so the bank's entry was left as it is."]);
});

test("Rename's footer message and Go to it take precedence over a failed detailed planning read", async () => {
  const { run, api, keys } = withNewAccounts();
  api.activities.getAll = async () => { throw new Error("made-up planning failure"); };
  await run.flush();
  assert.match(footer(run)[0], /made-up planning failure/);
  saveTo(run).newLine(keys.pan, "funds").props.onRename();
  await run.flush();
  assert.deepEqual(footer(run), ["Save or cancel the new account name first."]);
  assert.equal(find(run, "Footer").go.label, "Go to it");
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).newLine(keys.pan, "funds").props.onCancel();
  await run.flush();
  assert.match(footer(run)[0], /made-up planning failure/);
  assert.equal(find(run, "Footer").go.label, "Try again");
});

test("a failed new account holds back a purchase and both new bank-transfer legs until the retry", async () => {
  const refuse = new Set(["Mutual funds"]);
  const { run, keys, asked, imported } = withNewAccounts({ accounts: [account("bank", "Savings")], refuse });
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 0);
  refuse.clear();
  nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOfLine(n) === "Try again").props.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds"]);
  assert.equal(imported.length, 1);
  const buy = imported[0].find((r) => r.activityType === "BUY");
  const cash = imported[0].filter((r) => r.sourceRecordId === `${buy.sourceRecordId}:cash` || r.sourceRecordId === `${buy.sourceRecordId}:bank`);
  assert.equal(cash.length, 2);
  assert.deepEqual(cash.map((r) => r.accountId), ["created-1", "bank"]);
});

test("a fresh detailed no-PAN folio has its own preselected proposal and leaving everything out creates nothing", async () => {
  const { run, asked } = withNewAccounts({ change(data) { data.folios[1].PAN = null; return data; } });
  await run.flush();
  const boxes = saveTo(run).boxes;
  assert.equal(boxes.length, 2);
  assert.equal(boxes[1].pan, false);
  assert.equal(saveTo(run).values[boxes[1].key], proposedId(boxes[1].key));
  for (const box of boxes) saveTo(run).onChange(box.key, choices.LEFT_OUT);
  await run.flush();
  assert.deepEqual(footer(run), ["Nothing from this statement will be imported."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked, []);
});
