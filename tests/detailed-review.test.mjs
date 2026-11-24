// Exercises the real detailed Review controller and search hook with made-up host data, without a
// browser: where transactions go, which bank checks show under which choice, what survives a change,
// what the footer counts, and when choices are remembered.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
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
    render() {
      dirty = false;
      cursor = 0;
      globalThis.reviewHooks = hooks;
      tree = DetailedImport(props);
    },
    async flush() {
      for (let i = 0; i < 40; i++) {
        if (dirty) this.render();
        const pending = effects;
        effects = [];
        pending.forEach((fn) => fn());
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
/** Ready to import's heading, when it's shown. */
const readyHeading = (run) => {
  const heading = nodes(run.tree).find((node) => node.props?.id === "review-ready");
  return heading && textOf(heading);
};

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
  // What the add-on logs: Wealthfolio's own errors, which the screen doesn't show.
  const logged = [];
  const api = {
    logger: { error: (m) => logged.push(m), warn: (m) => logged.push(m) },
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
  return { run: active, props, api, keys, data, remembers, departures, imported, activities, profiles, logged };
}
const saveTo = (run) => find(run, "SaveToDetailed");
/** The made-up statement's folio keys, before a review is set up. */
const keys0 = () => ({ fictiva: choices.folioKey(fixture.folios[0]), testbridge: choices.folioKey(fixture.folios[1]) });
/** The rare questions' open cards, and their answered lines. */
const askCards = (run) => nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
const askAnswers = (run) => nodes(run.tree).filter((node) => node.type?.name === "AskAnswered").map((node) => node.props);
/** The Change buttons under Not included, by their accessible names, with their clicks. */
const notIncludedChanges = (run) => {
  const part = nodes(run.tree).find((node) => node.type?.name === "NotIncludedDetailed");
  return nodes(part.type(part.props)).filter((node) => node.props?.["aria-label"]?.startsWith("Change:") && node.props.onClick)
    .map((node) => ({ name: node.props["aria-label"], click: node.props.onClick }));
};

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

test("rare questions keep their cards and answers while an answer works the plan out again", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  const checked = (rows) => rows.map((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  api.activities.checkImport = async (rows) => checked(rows);
  await run.flush();
  let cards = askCards(run);
  assert.deepEqual(cards.map((c) => c.title), [
    "Fictiva Balanced Advantage Fund's transactions don't add up",
    "This purchase may already be in Mutual funds",
    "This switch in may already be in Mutual funds",
  ]);
  assert.deepEqual(cards.map((c) => [c.main.label, c.other.label]), [
    ["Skip this fund", "Import with this difference"], ["Skip this transaction", "Import it as another purchase"], ["Skip this transaction", "Import it as another switch in"],
  ]);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(find(run, "TransactionsSummary").breakdown.duplicates, 2);
  let finish;
  api.activities.checkImport = (rows) => new Promise((resolve) => { finish = () => resolve(checked(rows)); });
  cards[0].other.onClick();
  await run.flush();
  // While it's worked out again: the answered line, and the other cards as they were.
  assert.deepEqual(askAnswers(run).map((a) => [a.text, a.warn]), [["Fictiva Balanced Advantage Fund: imported with the difference", true]]);
  assert.equal(askCards(run).length, 2);
  assert.equal(find(run, "Footer").action.disabled, true);
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.equal(askCards(run).length, 1);
  finish();
  await run.flush();
  assert.equal(askAnswers(run).length, 2);
  assert.equal(find(run, "Footer").action.disabled, true, "one question is left");
  askCards(run)[0].main.onClick();
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.duplicates, b.importedDuplicates, b.skippedDuplicates, b.unbalanced], [0, 1, 1, 0]);
});

for (const differentNames of [false, true]) test(`the same unbalanced fund in two folios keeps each folio in its answered line and name (different printed names ${differentNames})`, async () => {
  const { run, data } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    const first = { ...data.folios[0], schemes: [scheme] };
    data.folios = [first, { ...structuredClone(first), folio: "222222222" }];
    if (differentNames) data.folios[1].schemes[0].scheme += " - alternate printed name";
    return data;
  } });
  await run.flush();
  const cards = askCards(run);
  assert.equal(cards.length, 2);
  // Their headings name the folio, so they and their regions differ.
  assert.deepEqual(cards.map((card) => card.title), data.folios.map((folio) => `Fictiva Liquid Fund's transactions in folio ${folio.folio} don't add up`));
  cards.forEach((card) => card.main.onClick());
  await run.flush();
  // So does the bar.
  for (const folio of data.folios) assert.ok(footer(run).some((line) => line.includes(`Fictiva Liquid Fund, folio ${folio.folio} skipped, by your answer`)), footer(run).join(" | "));
  const names = data.folios.map((folio) => `Fictiva Liquid Fund, folio ${folio.folio}: skipped`);
  assert.deepEqual(askAnswers(run).map((a) => [a.text, a.name]), names.map((name) => [name, name]));
  // Not included lists each skipped folio's fund, its folio named.
  const skippedHere = () => find(run, "NotIncludedDetailed").unbalanced.map((f) => f.name);
  assert.deepEqual(skippedHere(), data.folios.map((folio) => `Fictiva Liquid Fund, folio ${folio.folio}`));
  askAnswers(run)[0].onChange();
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  names[0] = `Fictiva Liquid Fund, folio ${data.folios[0].folio}: imported with the difference`;
  assert.deepEqual(askAnswers(run).map((a) => [a.text, a.name]), names.map((name) => [name, name]));
  // Answered differently, it says which folio's was skipped.
  assert.deepEqual(skippedHere(), [`Fictiva Liquid Fund, folio ${data.folios[1].folio}`]);
  assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced.map((f) => f.label), [`Fictiva Liquid Fund, folio ${data.folios[1].folio}`]);
});

/** The made-up Liquid Fund alone, in its own folio and in folio 7712045, of the same fund house and PAN. */
const liquidInTwoFolios = (unbalanced = false) => (data) => {
  const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
  const first = { ...data.folios[0], schemes: [liquid] };
  data.folios = [first, { ...structuredClone(first), folio: "7712045" }];
  if (unbalanced) liquid.close = String(Number(liquid.close_calculated) + 1);
  return data;
};

for (const other of ["imported", "not imported"]) test(`a fund whose rows don't add up in one of its two folios names that folio while the other is imported (${other})`, async () => {
  const { run, data } = setup({ entries: [], change: liquidInTwoFolios(true) });
  await run.flush();
  const [unbalanced, balanced] = data.folios;
  if (other === "not imported") {
    saveTo(run).onChange(choices.folioKey(balanced), choices.LEFT_OUT);
    await run.flush();
  }
  const named = other === "imported";
  const which = named ? `Fictiva Liquid Fund, folio ${unbalanced.folio}` : "Fictiva Liquid Fund";
  const cards = askCards(run);
  assert.deepEqual(cards.map((card) => card.title), [`Fictiva Liquid Fund's transactions${named ? ` in folio ${unbalanced.folio}` : ""} don't add up`]);
  assert.deepEqual([cards[0].main.name, cards[0].other.name], [`Skip this fund: ${which}`, `Import with this difference: ${which}`]);
  cards[0].main.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text), [`${which}: skipped`]);
  assert.ok(footer(run).some((line) => line.includes(`${which} skipped, by your answer`)), footer(run).join(" | "));
  const [line, ...more] = find(run, "NotIncludedDetailed").unbalanced;
  assert.deepEqual(more, []);
  assert.deepEqual([line.name, line.label], [which, which]);
  // Skipping it leaves out only that folio's rows: the other folio's, when imported, are still ready.
  assert.equal(find(run, "FundsReadyTable")?.rows.some((row) => row.name === "Fictiva Liquid Fund") ?? false, named);
});

test("Change beside a skipped fund whose rows don't add up names its fund and folio as its line does (#349)", async () => {
  const { run, props, data } = setup({ entries: [], change: liquidInTwoFolios(true) });
  const [unbalanced] = data.folios;
  // Its listing's name isn't the statement's.
  props.fundChoices[choices.fundKey(unbalanced.schemes[0])].fund.name = "Liquid Listing Fund";
  await run.flush();
  const which = `Liquid Listing Fund, folio ${unbalanced.folio}`;
  const [card] = askCards(run);
  assert.equal(card.main.name, `Skip this fund: ${which}`);
  card.main.onClick();
  await run.flush();
  assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced.map((f) => f.name), [which]);
  assert.deepEqual(notIncludedChanges(run).map((c) => c.name), [`Change: ${which}, transactions don't add up`]);
  const focused = changeUnbalanced(run);
  await run.flush();
  const [again] = askCards(run);
  assert.equal(again.title, `Liquid Listing Fund's transactions in folio ${unbalanced.folio} don't add up`);
  assert.deepEqual(focused, [again.headingId]);
});

test("a fund's question counts only the folios its units come from", async () => {
  /** Its card's "On your statement:" line, after the fund's name, plan and option. */
  const onStatement = (run) => {
    const card = nodes(run.tree).find((node) => node.type?.name === "QuestionCard");
    const line = nodes(card.type(card.props)).find((node) => node.type === "p" && textOf(node).startsWith("On your statement:"));
    return textOf(line).split(" · ").slice(3).join(" · ");
  };
  const { run, props, data } = setup({ entries: [], change: liquidInTwoFolios() });
  props.fundChoices = {};
  await run.flush();
  assert.equal(onStatement(run), "16.106 units · in 2 folios");
  saveTo(run).onChange(choices.folioKey(data.folios[1]), choices.LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), "8.053 units · in 1 of its 2 folios");
  // In one folio, it isn't counted.
  const one = setup({ entries: [], change: (d) => liquidInTwoFolios()(d) && ((d.folios = [d.folios[0]]), d) });
  one.props.fundChoices = {};
  await one.run.flush();
  assert.equal(onStatement(one.run), "8.053 units");
});

/** The rows each plan sent to Wealthfolio's check, by symbol. */
function checkedSymbols(api) {
  const checked = [];
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => { checked.push(new Set(rows.map((r) => r.symbol))); return check(rows); };
  return checked;
}

test("a fund whose rows don't add up, in a folio whose number another fund house's folio also has, is named, skipped and changed as its own", async () => {
  const { run, api, data } = setup({ entries: [], change(d) {
    // Testbridge's folio has Fictiva's number, and its Corporate Bond Fund misses its closing units.
    d.folios[1].folio = d.folios[0].folio;
    const bond = d.folios[1].schemes.find((s) => s.scheme.includes("Corporate Bond"));
    bond.close = String(Number(bond.close_calculated) + 1);
    return d;
  } });
  const checked = checkedSymbols(api);
  await run.flush();
  assert.equal(data.folios[0].folio, data.folios[1].folio);
  const bond = data.folios[1].schemes.find((s) => s.scheme.includes("Corporate Bond"));
  const cards = askCards(run);
  // Named as the rest of the screen names it, not as printed.
  assert.deepEqual(cards.map((c) => c.title), ["Testbridge Corporate Bond Fund's transactions don't add up"]);
  cards[0].main.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text), ["Testbridge Corporate Bond Fund: skipped"]);
  const part = nodes(run.tree).find((node) => node.type?.name === "NotIncludedDetailed");
  assert.deepEqual(part.props.unbalanced.map((f) => f.name), ["Testbridge Corporate Bond Fund"]);
  assert.ok(!checked.at(-1).has(bond.isin));
  // Change answer imports it with the difference.
  askAnswers(run)[0].onChange();
  await run.flush();
  assert.deepEqual(askCards(run).map((c) => c.title), ["Testbridge Corporate Bond Fund's transactions don't add up"]);
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text), ["Testbridge Corporate Bond Fund: imported with the difference"]);
  assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced, []);
  assert.ok(checked.at(-1).has(bond.isin));
  assert.equal(find(run, "TransactionsSummary").breakdown.unbalanced, 0);
  // Skipped again, its Not included line's Change opens its question again.
  askAnswers(run)[0].onChange();
  await run.flush();
  askCards(run)[0].main.onClick();
  await run.flush();
  const again = nodes(run.tree).find((node) => node.type?.name === "NotIncludedDetailed");
  const change = nodes(again.type(again.props)).find((node) => node.props?.["aria-label"]?.endsWith("transactions don't add up") && node.props.onClick);
  assert.ok(change);
  change.props.onClick();
  await run.flush();
  assert.deepEqual(askCards(run).map((c) => c.title), ["Testbridge Corporate Bond Fund's transactions don't add up"]);
  assert.deepEqual(askAnswers(run), []);
});

for (const differentNames of [false, true]) test(`two fund houses' folios with one number each keep their own answer on rows that don't add up (different printed names ${differentNames})`, async () => {
  const { run, api, data, props } = setup({ entries: [], change(d) {
    const [fictiva, testbridge] = d.folios;
    const liquid = fictiva.schemes.find((s) => s.scheme.includes("Liquid"));
    liquid.close = String(Number(liquid.close_calculated) + 1);
    // Testbridge's fund is distinct, even if it's printed with Fictiva's fund's name.
    const twin = { ...structuredClone(liquid), isin: "INFZ91T01LQ2", rta_code: "TLQDG" };
    if (differentNames) twin.scheme = twin.scheme.replace("Fictiva", "Testbridge");
    d.folios = [{ ...fictiva, schemes: [liquid] }, { ...testbridge, folio: fictiva.folio, schemes: [twin] }];
    return d;
  } });
  const checked = checkedSymbols(api);
  const [liquid, twin] = data.folios.map((f) => f.schemes[0]);
  assert.equal(liquid.scheme !== twin.scheme, differentNames);
  assert.notEqual(choices.fundKey(liquid), choices.fundKey(twin));
  // The numbers come from the questions even when the printed names differ.
  for (const scheme of [liquid, twin]) props.fundChoices[choices.fundKey(scheme)].fund.name = "Shared Listing Fund";
  await run.flush();
  let cards = askCards(run);
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((c) => c.headingId)).size, 2);
  // The screen names both funds and folios alike, so their buttons are numbered.
  assert.deepEqual(cards.map((c) => c.main.name), ["Skip this fund: Shared Listing Fund, fund 1", "Skip this fund: Shared Listing Fund, fund 2"]);
  // Skipping Fictiva's leaves Testbridge's open.
  cards[0].main.onClick();
  await run.flush();
  cards = askCards(run);
  assert.equal(cards.length, 1);
  assert.equal(askAnswers(run).length, 1);
  // Not included lists the one skipped, numbered as its question is.
  const skippedChanges = () => notIncludedChanges(run).map((c) => c.name);
  assert.deepEqual(skippedChanges(), ["Change: Shared Listing Fund, fund 1, transactions don't add up"]);
  // Importing Testbridge's with the difference imports its rows only.
  cards[0].other.onClick();
  await run.flush();
  assert.deepEqual(askCards(run), []);
  assert.ok(checked.at(-1).has(twin.isin));
  assert.ok(!checked.at(-1).has(liquid.isin));
  const b = find(run, "TransactionsSummary").breakdown;
  // Its rows, their stamp duty with them.
  assert.deepEqual([b.unbalanced, b.skippedUnbalanced], [0, liquid.transactions.filter((t) => t.type !== "STAMP_DUTY_TAX").length]);
  assert.deepEqual(skippedChanges(), ["Change: Shared Listing Fund, fund 1, transactions don't add up"]);
  // And the other way round: the one skipped is the second question, so it keeps its number 2.
  for (const answer of askAnswers(run)) answer.onChange();
  await run.flush();
  cards = askCards(run);
  cards[0].other.onClick();
  cards[1].main.onClick();
  await run.flush();
  assert.ok(checked.at(-1).has(liquid.isin));
  assert.ok(!checked.at(-1).has(twin.isin));
  assert.deepEqual(skippedChanges(), ["Change: Shared Listing Fund, fund 2, transactions don't add up"]);
});

test("a failed plan recovers with its accepted units difference", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  await run.flush();
  const check = api.activities.checkImport;
  api.activities.checkImport = async () => { throw new Error("made-up check failure"); };
  askCards(run)[0].other.onClick();
  await run.flush();
  const answers = askAnswers(run).map((a) => a.text);
  assert.ok(answers.some((a) => a.includes("imported with the difference")));
  assert.equal(footer(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  api.activities.checkImport = check;
  find(run, "Footer").go.onClick();
  await run.flush();
  assert.equal(askCards(run).length, 0);
  assert.deepEqual(askAnswers(run).map((a) => a.text), answers);
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("a pending plan can reopen the question just answered without announcing completion", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  const checked = (rows, evidence) => rows.map((r) =>
    r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" && r.date === "2023-05-05" ? { ...r, duplicateOfId: evidence } : r);
  api.activities.checkImport = async (rows) => checked(rows, "previous");
  await run.flush();
  assert.equal(askCards(run).length, 2);
  let finish;
  api.activities.checkImport = (rows) => new Promise((resolve) => { finish = () => resolve(checked(rows, "changed-evidence")); });
  askCards(run)[0].other.onClick();
  await run.flush();
  // The duplicate can be answered while the accepted units difference is still being checked.
  askCards(run)[0].main.onClick();
  await run.flush();
  assert.equal(askCards(run).length, 0);
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  finish();
  await run.flush();
  const [reopened] = askCards(run);
  assert.equal(askCards(run).length, 1);
  assert.equal(reopened.title, "This purchase may already be in Mutual funds");
  assert.deepEqual(focused, [reopened.headingId]);
  assert.equal(find(run, "Footer").action.disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.doesNotMatch(nodes(run.tree).find((node) => node.props?.role === "status").props.children, /All questions answered/);
});

for (const change of ["unchanged", "activity", "details", "line", "bank", "removed"]) {
  test(`a planning retry keeps duplicate answers only for unchanged evidence (${change})`, async () => {
    const pan = choices.panKey("ABCDE1234F");
    const { run, api, activities } = setup({ entries: [], remembered: { [pan]: "mf", [choices.bankKey(pan)]: "bank" }, change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    activities.push({ ...entry("previous", "BUY", "1", "2020-01-01", null), accountId: "mf", quantity: "1", assetName: "Earlier fund" });
    let failed = false;
    let refreshed = false;
    let purchaseDate;
    api.activities.checkImport = async (rows) => {
      if (failed) throw new Error("made-up check failure");
      return rows.map((r) => {
        if (refreshed && change === "bank") return r.accountId === "bank" && r.date === purchaseDate && r.activityType === "TRANSFER_OUT"
          ? { ...r, duplicateOfId: "new-bank-entry" } : r;
        if (r.symbol !== "INFZ90K01LQ6" || r.activityType !== "BUY" || (refreshed && change === "removed")) return r;
        purchaseDate ??= r.date;
        return { ...r, ...(change === "line"
          ? { duplicateOfLineNumber: refreshed ? 2 : 1 }
          : { duplicateOfId: refreshed && change === "activity" ? "another-activity" : "previous" }) };
      });
    };
    await run.flush();
    askCards(run).filter((c) => c.title.includes("may already be")).forEach((c) => c.other.onClick());
    await run.flush();
    assert.equal(askAnswers(run).length, 2);
    failed = true;
    askCards(run)[0].other.onClick();
    await run.flush();
    assert.match(footer(run)[0], /We couldn't work out/);
    if (change === "details") activities[0] = { ...activities[0], quantity: "2" };
    failed = false;
    refreshed = true;
    find(run, "Footer").go.onClick();
    await run.flush();
    assert.ok(askAnswers(run).some((a) => a.text.includes("imported with the difference")), "the statement's units evidence has not changed");
    if (change === "unchanged") {
      assert.equal(askCards(run).length, 0);
      assert.equal(askAnswers(run).length, 3);
      assert.equal(find(run, "Footer").action.disabled, false);
    } else if (change === "removed") {
      assert.equal(askCards(run).length, 0);
      failed = true;
      askAnswers(run)[0].onChange();
      await run.flush();
      assert.match(footer(run)[0], /We couldn't work out/);
      failed = false;
      refreshed = false;
      find(run, "Footer").go.onClick();
      await run.flush();
      assert.equal(askCards(run).filter((c) => c.title.includes("may already be")).length, 2, "a removed duplicate's old answer must not return");
    } else {
      assert.equal(askCards(run).length, change === "bank" ? 1 : 2, "the refreshed duplicate evidence needs a new answer");
      if (change === "bank") assert.match(askCards(run)[0].title, /bank entry .* may already be in Savings/);
      assert.equal(askAnswers(run).length, 1);
      assert.equal(find(run, "Footer").action.disabled, true);
    }
  });
}

test("excluding every folio after a failed refresh drops obsolete questions and allows Finish", async () => {
  const { run, api, keys, imported, departures } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => ({ ...r, duplicateOfId: "made-up-existing" }));
  await run.flush();
  assert.ok(askCards(run).some((c) => c.title.includes("don't add up")));
  assert.ok(askCards(run).some((c) => c.title.includes("may already be")));
  api.activities.getAll = async () => { throw new Error("made-up failed refresh"); };
  run.update({ visit: {} });
  await run.flush();
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  await run.flush();
  assert.deepEqual(askCards(run), []);
  const action = find(run, "Footer").action;
  assert.equal(action.label, "Finish");
  assert.equal(action.disabled, false);
  assert.equal(find(run, "Footer").go, undefined);
  action.onClick();
  assert.deepEqual(departures, ["Finished: nothing from made-up.pdf was imported."]);
  assert.deepEqual(imported, []);
});

test("a remembered bank account that tracks holdings asks again, and the import waits for it", async () => {
  const { run, keys } = setup({ remembered: { pan: undefined, [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "demat" } });
  await run.flush();
  const bank = choices.bankKey(keys.pan);
  assert.equal(saveTo(run).values[bank], null);
  assert.deepEqual(saveTo(run).ignored[bank], { ids: ["demat"], name: "Demat" });
  assert.deepEqual(footer(run), ["1 question left: the account choice before importing."]);
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
    createdAt: "2023-05-06T10:00:00Z",
  };
  const { run, profiles } = setup({ entries: [byHand] });
  profiles["liquid-asset"] = { instrumentSymbol: purchase.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  // Asked: both rows side by side, the one Wealthfolio has said to be entered by hand.
  const [card] = askCards(run);
  assert.equal(card.title, "This purchase may already be in Mutual funds");
  const lines = nodes(card.children).filter((n) => n.type === "p").map(textOf);
  assert.deepEqual(lines, [
    "On this statement: 5 May 2023 · Purchase · Fictiva Liquid Fund · 9.747 units · ₹24,998.75",
    `Already in Mutual funds: 5 May 2023 · Buy · ${purchase.symbol} · 9.747 units · ₹25,001.15 · entered by hand on 6 May 2023`,
    // Their amounts differ, so they aren't called equal.
    "Two transactions on one day with the same units can both be real.",
  ]);
  assert.equal(find(run, "TransactionsSummary").breakdown.duplicates, 1);
  assert.equal(find(run, "Footer").action.disabled, true);
  card.other.onClick();
  await run.flush();
  assert.equal(askAnswers(run)[0].text, "₹24,998.75 purchase of Fictiva Liquid Fund on 5 May 2023: imported as another purchase");
  assert.deepEqual(footer(run).slice(0, 2), [
    "Import 13 transactions for 4 funds into Mutual funds.",
    "1 fund's units won't match the statement after importing: Fictiva Liquid Fund.",
  ]);
  assert.match(footer(run).at(-2), /^1 possible duplicate imported by your answer\.$/);
  const row = find(run, "FundsReadyTable").rows.find((r) => r.name.includes("Liquid"));
  assert.equal(row.note, "After import: 17.800 units · Statement: 8.053. Includes another purchase you chose.");
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.duplicates, b.importedDuplicates, b.toImport], [0, 1, 12]);
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

// #280: a folio's choices under its fund house's other names.
test("a folio's choices that differ under its fund house's names ask on Save to before importing, with its box's folios open", async () => {
  const { run, props, keys, remembers, imported } = setup({ entries: [] });
  const bank = choices.bankKey(keys.fictiva);
  const under = (a, b) => ({ under: [{ name: "Bandhan Mutual Fund", choice: a }, { name: "IDFC Mutual Fund", choice: b }] });
  props.unavailable = { [keys.fictiva]: under("Other funds", "Don't import"), [bank]: under("Savings", "None") };
  await run.flush();
  assert.deepEqual([saveTo(run).values[keys.fictiva], saveTo(run).values[bank]], [null, null]);
  assert.deepEqual(saveTo(run).ignored[keys.fictiva], props.unavailable[keys.fictiva]);
  assert.equal(saveTo(run).open[keys.pan], true);
  assert.deepEqual(footer(run), ["1 question left: the account choice before importing."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  // Same as above and None are choices here, and are remembered as such.
  saveTo(run).onChange(keys.fictiva, "");
  await run.flush();
  assert.equal(saveTo(run).ignored[keys.fictiva], undefined);
  assert.deepEqual(footer(run), ["1 question left: the account choice before importing."]);
  saveTo(run).onChange(bank, "");
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.deepEqual(remembers.map((r) => r.accounts), [[[keys.fictiva, ""], [bank, ""]]]);
});

test("a folio's choice found under its fund house's former name is used and says so, with its box's folios open", async () => {
  const { run, props, keys } = setup({ entries: [], remembered: { [choices.panKey("ABCDE1234F")]: "mf", [keys0().fictiva]: "other" } });
  props.formerNames = { [keys.fictiva]: "IDFC Mutual Fund" };
  await run.flush();
  assert.equal(saveTo(run).values[keys.fictiva], "other");
  assert.deepEqual(saveTo(run).formerNames, { [keys.fictiva]: "IDFC Mutual Fund" });
  assert.equal(saveTo(run).open[keys.pan], true);
  assert.equal(find(run, "Footer").action.disabled, false);
  // Another choice is the user's own.
  saveTo(run).onChange(keys.fictiva, "mf");
  await run.flush();
  assert.deepEqual(saveTo(run).formerNames, {});
  // Its box's folios stay open until closed.
  saveTo(run).onOpen(keys.pan, false);
  await run.flush();
  assert.equal(saveTo(run).open[keys.pan], false);
});

test("a renamed folio without a PAN shows its recovered no-bank choice and requires answers to disputes", async () => {
  const own = choices.folioKey({ ...fixture.folios[0], amc: "Bandhan Mutual Fund" });
  const bank = choices.bankKey(own);
  const { run, props, remembers } = setup({ entries: [], remembered: { [own]: "other", [bank]: choices.NO_BANK }, change(data) {
    data.folios = [data.folios[0]];
    data.folios[0].amc = "Bandhan Mutual Fund";
    data.folios[0].PAN = "";
    return data;
  } });
  props.formerNames = { [own]: "IDFC Mutual Fund", [bank]: "IDFC Mutual Fund" };
  await run.flush();
  assert.equal(saveTo(run).boxes[0].key, own);
  assert.equal(saveTo(run).boxes[0].pan, false);
  assert.deepEqual([saveTo(run).values[own], saveTo(run).values[bank]], ["other", ""]);
  assert.deepEqual(saveTo(run).formerNames, props.formerNames);
  const under = { under: [{ name: "Bandhan Mutual Fund", choice: "Other funds" }, { name: "IDFC Mutual Fund", choice: "Savings" }] };
  run.update({ accountChoices: {}, formerNames: {}, unavailable: { [own]: under, [bank]: under } });
  await run.flush();
  assert.deepEqual([saveTo(run).values[own], saveTo(run).values[bank]], [null, null]);
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).onChange(own, "mf");
  saveTo(run).onChange(bank, "");
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(remembers.map((r) => r.accounts), [[[own, "mf"], [bank, ""]]]);
});

test("a failed remembered asset can be changed without a prepared plan", async () => {
  const { run, props, profiles, remembers } = setup({ entries: [] });
  const [key, choice] = Object.entries(props.fundChoices)[0];
  choice.fund.assetId = "missing-type";
  profiles["missing-type"] = { instrumentSymbol: choice.fund.symbol, instrumentExchangeMic: "XBOM" };
  await run.flush();
  // The add-on's own explanation goes under the bar's sentence.
  assert.equal(footer(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  assert.match(footer(run)[1], /type .* isn't set/);
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
  // Ready to import and the bar count the one that's ready, as the chips do.
  assert.equal(readyHeading(run), "Ready to import (1)");
  assert.deepEqual(footer(run)[0], "Import 3 transactions for 1 fund into Mutual funds.");
  assert.equal(find(run, "NotIncludedDetailed").earlier.length, 1);
  // Excluding one PAN doesn't mark the other PAN's waiting rows ready.
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  await run.flush();
  assert.match(textOf(run.tree), /2 funds0 ready2 not included/);
  assert.equal(readyHeading(run), undefined);
});

/** The made-up statement's Liquid Fund alone, in its first folio and in `second`, a copy of it. */
const liquidTwice = (second) => (data) => {
  const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
  data.folios[0].schemes = [liquid];
  data.folios[1] = { ...structuredClone(data.folios[0]), folio: "1040012345", ...second };
  return data;
};

test("the ready count, Ready to import and the bar count one fund in two folios once, whatever accounts they go to", async () => {
  const { run, keys } = setup({ entries: [], change: liquidTwice() });
  await run.flush();
  saveTo(run).onChange(keys.testbridge, "other");
  await run.flush();
  // One row for each account it goes to, and one fund in every count.
  assert.deepEqual(find(run, "FundsReadyTable").rows.map((r) => [r.groupTitle, r.name]),
    [["To Mutual funds", "Fictiva Liquid Fund"], ["To Other funds", "Fictiva Liquid Fund"]]);
  assert.match(textOf(run.tree), /1 fund1 ready/);
  assert.equal(readyHeading(run), "Ready to import (1)");
  assert.deepEqual(footer(run).slice(0, 2), ["Import 3 transactions for 1 fund into Mutual funds.", "Import 3 transactions for 1 fund into Other funds."]);
  assert.equal(textOf(find(run, "Footer").narrow.brief), "Import 6 transactions for 1 fund into 2 accounts.");
});

test("on a family statement, the ready count, Ready to import and the bar count each investor's fund, in one row of one account", async () => {
  const { run } = setup({
    entries: [],
    change: (data) => {
      data.folios[0].name = "A. Investor";
      return liquidTwice({ PAN: "OTHER1234F", name: "B. Investor" })(data);
    },
    remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.panKey("OTHER1234F")]: "mf" },
  });
  await run.flush();
  assert.deepEqual(find(run, "FundsReadyTable").rows.map((r) => r.groupTitle), ["A. Investor and B. Investor → Mutual funds"]);
  assert.match(textOf(run.tree), /2 funds2 ready/);
  assert.equal(readyHeading(run), "Ready to import (2)");
  assert.deepEqual(footer(run)[0], "Import 6 transactions for 2 funds into Mutual funds.");
});

test("a fund whose only questions are possible duplicates counts under questions, and once they're skipped it's listed under Not included", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    data.folios = [{ ...data.folios[0], schemes: data.folios[0].schemes.filter((s) => /Liquid|Balanced/.test(s.scheme)) }];
    return data;
  } });
  // The Liquid Fund's purchase, switch in and redemption.
  api.activities.checkImport = async (rows) => rows.map((r) => (r.symbol === "INFZ90K01LQ6" ? { ...r, duplicateOfId: "previous" } : r));
  await run.flush();
  assert.equal(askCards(run).length, 3);
  assert.match(textOf(run.tree), /2 funds1 ready3 questions/);
  askCards(run)[0].main.onClick();
  await run.flush();
  // Still a question, with one skipped: listed, but not counted as not included.
  assert.match(textOf(run.tree), /2 funds1 ready2 questions/);
  const notIncluded = () => markup(nodes(run.tree).find((n) => n.type?.name === "NotIncludedDetailed"));
  assert.match(notIncluded(), /Fictiva Liquid Fund<\/span>: 1 possible duplicate skipped by your answer\./);
  for (const card of askCards(run)) card.main.onClick();
  await run.flush();
  assert.match(textOf(run.tree), /2 funds1 ready1 not included/);
  assert.deepEqual(find(run, "NotIncludedDetailed").duplicates.map((d) => [d.name, d.count]), [["Fictiva Liquid Fund", 3]]);
  assert.match(notIncluded(), /Not included in this import.*Fictiva Liquid Fund<\/span>: 3 possible duplicates skipped by your answer\./);
  assert.deepEqual(footer(run).slice(0, 2), ["Import 4 transactions for 1 fund into Mutual funds.", "3 possible duplicates skipped by your answer."]);
});

const segregatedFixture = JSON.parse(await readFile("tests/fixtures/made-up-cas-segregated.json", "utf8"));
/**
 * The review of the made-up statement with a segregated portfolio, each fund confirmed and going to
 * Mutual funds, with `change` editing the statement first. `byHand` makes a purchase of the
 * segregated fund in Mutual funds, as one entered by hand: ₹0 a unit, with a comment.
 */
function segregatedSetup({ entries = [], change = (data) => data } = {}) {
  const review = setup({ entries, change: () => change(structuredClone(segregatedFixture)) });
  const symbol = Object.values(review.props.fundChoices).find((c) => c.fund.name.includes("Segregated")).fund.symbol;
  review.profiles["segregated-asset"] = { instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  const byHand = (id, quantity) => ({
    id, accountId: "mf", activityType: "BUY", subtype: null, status: "POSTED", date: "2024-02-16T00:00:00Z", quantity, unitPrice: "0",
    amount: "0", fee: null, tax: null, currency: "INR", needsReview: false, comment: "made-up copy", assetId: "segregated-asset",
    assetSymbol: symbol, sourceRecordId: null,
  });
  return { ...review, byHand };
}
/** Not included's lines for transactions left out for a reason of their own: each fund's name, and its lines. */
const leftOutLines = (run) => (find(run, "NotIncludedDetailed")?.leftOut ?? []).map((fund) => [fund.name, fund.lines.map((l) => `${l.when}: ${l.reason}`)]);
const SEGREGATED = "Fictiva Credit Risk Fund Segregated Portfolio 1";
const CREDIT = "16 Feb 2024 · Creation of units - Segregated Portfolio";
const copyOf = (units) => `a purchase of ${units} units of this fund at ₹0 a unit ("made-up copy")`;
const oneCreditByHand = (units) =>
  `Wealthfolio has ${copyOf(units)} on this day, perhaps entered by hand, so this credit of segregated units isn't imported. If that's how this credit was entered, keep the activity, or delete it and any cash that came with it and read the statement again to import this credit from the statement.`;

test("equal credits left out for the same purchases entered by hand share one numbered line that counts them, and each table note says this credit without the stand-in note (#353, #365)", async () => {
  const { run, activities, byHand } = segregatedSetup();
  activities.push(byHand("copy-large", "3067.468"), byHand("copy-small", "0.013"));
  await run.flush();
  assert.deepEqual(leftOutLines(run), [
    [SEGREGATED, [`${CREDIT} (1 of 2) and ${CREDIT} (2 of 2): Wealthfolio has ${copyOf("3,067.468")} and ${copyOf("0.013")} on this day, perhaps entered by hand, so these 2 credits of segregated units aren't imported. If that's how these credits were entered, keep the activities, or delete them and any cash that came with them and read the statement again to import these credits from the statement.`]],
  ]);
  // See every transaction names each credit by its place, and its own note says this credit.
  const credits = (await shownTable(run)).filter((row) => row[1].includes("Segregated") && row[2].startsWith("purchase"));
  assert.deepEqual(credits.map((row) => row[2]), ["purchase (1 of 2)", "purchase (2 of 2)"]);
  for (const row of credits) {
    assert.match(row.at(-1), /^Can't import Wealthfolio has a purchase of .* so this credit of segregated units isn't imported\./);
    assert.doesNotMatch(row.at(-1), /stand-in/);
  }
});

test("a credit left out after its equal one was imported keeps its statement number, alone on its line, and only the imported one keeps the stand-in note (#353, #365)", async () => {
  const first = segregatedSetup();
  await first.run.flush();
  await shownTable(first.run);
  const [large] = find(first.run, "ActivityTable").plan.filter((t) => t.transaction.rows[0].type === "SEGREGATION").map((t) => t.transaction.activity);
  first.run.dispose();
  const { run, activities, byHand } = segregatedSetup();
  activities.push({ ...stored(large, "mf", "imported-large", `addon:cas-importer:${large.sourceRecordId}`), assetId: "segregated-asset" }, byHand("copy-small", "0.013"));
  await run.flush();
  assert.deepEqual(leftOutLines(run), [[SEGREGATED, [`${CREDIT} (2 of 2): ${oneCreditByHand("0.013")}`]]]);
  const credits = (await shownTable(run)).filter((row) => row[1].includes("Segregated") && row[2].startsWith("purchase"));
  assert.deepEqual(find(run, "ActivityTable").plan.filter((t) => t.transaction.rows[0].type === "SEGREGATION").map((t) => t.status), ["existing", "invalid"]);
  const STAND_IN = /Units credited in a segregated portfolio, imported at a stand-in cost of ₹0 with no cash\./;
  assert.match(credits[0].at(-1), /^Already in Wealthfolio /);
  assert.match(credits[0].at(-1), STAND_IN);
  assert.match(credits[1].at(-1), /^Can't import Wealthfolio has a purchase of 0\.013 units /);
  assert.doesNotMatch(credits[1].at(-1), /stand-in/);
});

test("credits left out on different days by the same edited purchase get a line each, unnumbered when no row equals them (#353)", async () => {
  const { run, api, activities, byHand } = segregatedSetup({ change(data) {
    data.folios[0].schemes[1].transactions[1].date = "2024-02-17";
    return data;
  } });
  api.settings.get = async () => ({ timezone: "Asia/Kolkata" });
  // The edited CSV purchase can match the 16th in UTC or the 17th in Wealthfolio.
  activities.push({ ...byHand("edited-copy", "1.000"), date: "2024-02-16T20:30:00Z", sourceSystem: "CSV", isUserModified: true });
  await run.flush();
  const reason = oneCreditByHand("1.000");
  assert.deepEqual(leftOutLines(run), [[SEGREGATED, [`${CREDIT}: ${reason}`, `17 Feb 2024 · Creation of units - Segregated Portfolio: ${reason}`]]]);
});

/** The fixture's two credits, each in its own balanced section. */
const creditSections = (scheme) => scheme.transactions.slice(0, 2).map((row) => ({
  ...scheme, close: row.units, close_calculated: row.units, transactions: [{ ...row, balance: row.units }],
}));

test("equal credits across sections of one folio use the same statement numbering in both Review views (#353)", async () => {
  const { run, activities, byHand } = segregatedSetup({ change(data) {
    const [main, scheme] = data.folios[0].schemes;
    data.folios[0].schemes = [main, ...creditSections(scheme)];
    return data;
  } });
  activities.push(byHand("combined", "3067.481"));
  await run.flush();
  const [fund] = find(run, "NotIncludedDetailed").leftOut;
  assert.equal(fund.lines.length, 1);
  assert.equal(fund.lines[0].when, `${CREDIT} (1 of 2) and ${CREDIT} (2 of 2)`);
  const credits = (await shownTable(run)).filter((row) => row[1].includes("Segregated"));
  assert.deepEqual(credits.map((row) => row[2]), ["purchase (1 of 2)", "purchase (2 of 2)"]);
});

test("same-day credits left out for different purchases with the same description get separate lines (#353)", async () => {
  const { run, data, activities, byHand } = segregatedSetup({ change(data) {
    const [folio] = data.folios;
    const [main, scheme] = folio.schemes;
    const [first, second] = creditSections(scheme);
    folio.schemes = [main, first];
    data.folios.push({ ...folio, folio: "22222222", schemes: [second] });
    return data;
  } });
  activities.push(byHand("copy-mf", "1.000"), { ...byHand("copy-other", "1.000"), accountId: "other" });
  await run.flush();
  saveTo(run).onChange(choices.folioKey(data.folios[1]), "other");
  await run.flush();
  const line = `${CREDIT}: ${oneCreditByHand("1.000")}`;
  assert.deepEqual(leftOutLines(run), [[SEGREGATED, [line, line]]]);
});

test("a paired gift left out for a transfer entered by hand counts once on its line (#353)", async () => {
  const { run, data, props, profiles, activities } = setup({ entries: [], change(data) {
    const base = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const row = (date, type, amount, units, description, gift_folio = null) => ({
      date, type, amount, units, nav: "50", balance: null, description, dividend_rate: null, gift_folio,
    });
    const receiving = { ...structuredClone(base), open: "0", close: "10", close_calculated: "10",
      transactions: [row("2024-06-03", "GIFT_IN", "500", "10", "Gifting of units - From Folio No.33333333", "33333333")] };
    const giving = { ...structuredClone(base), open: "0", close: "0", close_calculated: "0", transactions: [
      row("2024-06-01", "PURCHASE", "500", "10", "Purchase"), row("2024-06-03", "GIFT_OUT", "-500", "-10", "Gifting of units-TO Folio No: 11111111", "11111111"),
    ] };
    data.folios = [{ ...data.folios[0], folio: "33333333", schemes: [giving] }, { ...data.folios[0], folio: "11111111", schemes: [receiving] }];
    return data;
  } });
  const symbol = Object.values(props.fundChoices)[0].fund.symbol;
  profiles.asset = { instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  activities.push({
    id: "gift-by-hand", accountId: "other", activityType: "TRANSFER_IN", subtype: null, status: "POSTED", date: "2024-06-03T00:00:00Z",
    quantity: "10", unitPrice: "40", amount: null, fee: null, tax: null, currency: "INR", needsReview: false,
    comment: null, assetId: "asset", assetSymbol: symbol, sourceRecordId: null,
  });
  await run.flush();
  saveTo(run).onChange(choices.folioKey(data.folios.find((f) => f.folio === "11111111")), "other");
  await run.flush();
  assert.deepEqual(leftOutLines(run), [["Fictiva Liquid Fund", [
    "3 Jun 2024 · Gifting of units-TO Folio No: 11111111 and 3 Jun 2024 · Gifting of units - From Folio No.33333333: Wealthfolio has a transfer in of these units at ₹40 a unit on this day, perhaps entered by hand, so this gift isn't imported. If that's how this gift was entered, keep the activity, or delete it and any cash that came with it and read the statement again to import this gift from the statement.",
  ]]]);
});

test("while the plan is worked out, or couldn't be, the import button gives no count", async () => {
  const { run, api, keys } = setup({ entries: [] });
  const check = api.activities.checkImport;
  let finish;
  api.activities.checkImport = (rows) => new Promise((resolve, reject) => { finish = (ok) => (ok ? check(rows).then(resolve) : reject(new Error("made-up check failure"))); });
  await run.flush();
  const shown = () => ({ line: footer(run)[0], label: find(run, "Footer").action.label, disabled: find(run, "Footer").action.disabled });
  // The first plan.
  assert.deepEqual(shown(), { line: "Working out what will be imported…", label: "Import", disabled: true });
  finish(true);
  await run.flush();
  assert.deepEqual(shown(), { line: "Import 13 transactions for 4 funds into Mutual funds.", label: "Import 13 transactions", disabled: false });
  // A change works it out again, and it fails.
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  assert.deepEqual(shown(), { line: "Working out what will be imported…", label: "Import", disabled: true });
  finish(false);
  await run.flush();
  assert.deepEqual(shown(), { line: "We couldn't work out what will be saved. Nothing was saved.", label: "Import", disabled: true });
  // With every folio set to Don't import, it's still Finish.
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  await run.flush();
  assert.deepEqual(shown(), { line: "Nothing from this statement will be imported.", label: "Finish", disabled: false });
});

test("a fund waiting for earlier purchases says how many units each account needs when its folios go to two", async () => {
  /** The Liquid Fund in three folios, starting with 100, 200 and 50 units. */
  const change = (data) => {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const opening = (units) => ({ ...structuredClone(liquid), open: units, close: String(Number(liquid.close) + Number(units)), close_calculated: String(Number(liquid.close) + Number(units)) });
    data.folios = [["7712045", "100"], ["91234567", "200"], ["3301", "50"]].map(([folio, units]) => ({ ...data.folios[0], folio, schemes: [opening(units)] }));
    return data;
  };
  const pan = choices.panKey("ABCDE1234F");
  const folio = (number) => choices.folioKey({ amc: fixture.folios[0].amc, folio: number });
  const toOther = { [pan]: "mf", [folio("91234567")]: "other", [folio("3301")]: "other" };
  const earlierOf = (run) => find(run, "NotIncludedDetailed").earlier;

  // Into one account: the units together, as before.
  let { run } = setup({ entries: [], change });
  await run.flush();
  assert.deepEqual(earlierOf(run).map(({ units, waiting, accounts }) => ({ units, waiting, accounts })), [{ units: "350.000 units", waiting: 9, accounts: undefined }]);
  run.dispose();

  // Into two: each account's units and folios, in the statement's order.
  ({ run } = setup({ entries: [], change, remembered: toOther }));
  await run.flush();
  assert.deepEqual(earlierOf(run).map(({ units, waiting, accounts }) => ({ units, waiting, accounts })), [{ units: "350.000 units", waiting: 9, accounts: [
    { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
    { units: "250.000", account: "Other funds", folios: ["91234567", "3301"] },
  ] }]);
  run.dispose();

  // Two accounts of one name: each named as the rest of the screen names it.
  let props;
  ({ run, props } = setup({ entries: [], change, remembered: toOther }));
  props.accounts = props.allAccounts = ACCOUNTS.map((a) => (a.id === "other" ? { ...a, name: "Mutual funds", accountNumber: "1234 7310" } : a.id === "mf" ? { ...a, accountNumber: "5678 4821" } : a));
  await run.flush();
  assert.deepEqual(earlierOf(run)[0].accounts.map((a) => a.account), ["Mutual funds (ending 4821)", "Mutual funds (ending 7310)"]);
  run.dispose();

  // Other funds already has its 250 units: only Mutual funds waits, and it's still named.
  let profiles, activities;
  ({ run, props, profiles, activities } = setup({ entries: [], change, remembered: toOther }));
  const symbol = Object.values(props.fundChoices)[0].fund.symbol;
  profiles.asset = { instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  activities.push({
    id: "other-buy", accountId: "other", activityType: "BUY", subtype: null, status: "POSTED", date: "2023-03-01T00:00:00Z",
    quantity: "250", unitPrice: "50", amount: "12500", fee: null, tax: null, currency: "INR", needsReview: false,
    comment: null, assetId: "asset", assetSymbol: symbol, sourceRecordId: null,
  });
  await run.flush();
  assert.deepEqual(earlierOf(run).map(({ units, waiting, accounts }) => ({ units, waiting, accounts })), [{ units: "100.000 units", waiting: 3, accounts: [
    { units: "100.000", account: "Mutual funds", folios: ["7712045"] },
  ] }]);
});

/** A posted activity of the Flexi Cap fund in Mutual funds before the made-up statement's 1 Apr 2023. */
const flexiCap = (id, activityType, quantity, extra = {}) => ({
  id, accountId: "mf", activityType, subtype: null, status: "POSTED", date: "2023-03-01T00:00:00Z",
  quantity, unitPrice: "50", amount: quantity && String(Number(quantity) * 50), fee: null, tax: null, currency: "INR", needsReview: false,
  comment: null, assetId: "flexi", assetSymbol: "INFZ90K01FC8", sourceRecordId: null, ...extra,
});
/** The made-up statement's review with `activities` in Wealthfolio: its Flexi Cap fund starts with 1,250 units. */
async function earlierWith(activities, { edit = () => {}, ...options } = {}) {
  const setUp = setup({ entries: [], ...options });
  edit(setUp);
  setUp.profiles.flexi = { instrumentSymbol: "INFZ90K01FC8", instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  setUp.activities.push(...activities);
  await setUp.run.flush();
  return { ...setUp, earlier: find(setUp.run, "NotIncludedDetailed").earlier };
}

test("a fund waiting for earlier purchases says what its account already has of them", async () => {
  const shape = (earlier) => earlier.map(({ units, waiting, accounts }) => ({ units, waiting, accounts }));
  const mf = (held) => [{ units: "1,250.000", account: "Mutual funds", folios: ["91234567 / 12"], ...(held && { held }) }];

  // Some of them, entered by hand: the rest to add.
  let { run, earlier } = await earlierWith([flexiCap("hand", "BUY", "500")]);
  assert.deepEqual(shape(earlier), [{ units: "1,250.000 units", waiting: 26, accounts: mf({ kind: "short", has: "500.000", add: "750.000" }) }]);
  run.dispose();

  // All of them and more, as when they were added by hand and an earlier statement also imported them.
  ({ run, earlier } = await earlierWith([flexiCap("hand", "BUY", "1250"), flexiCap("again", "BUY", "250", { date: "2022-08-01T00:00:00Z" })]));
  assert.deepEqual(shape(earlier), [{ units: "1,250.000 units", waiting: 26, accounts: mf({ kind: "over", has: "1,500.000", extra: "250.000" }) }]);
  run.dispose();

  // More sold than bought: the rest to add, with the minus sign.
  ({ run, earlier } = await earlierWith([flexiCap("sold", "SELL", "20")]));
  assert.deepEqual(shape(earlier), [{ units: "1,250.000 units", waiting: 26, accounts: mf({ kind: "short", has: "−20.000", add: "1,270.000" }) }]);
  run.dispose();

  // A split before the statement: none can be counted, by its day on the screen.
  ({ run, earlier } = await earlierWith([flexiCap("hand", "BUY", "625"), flexiCap("split", "SPLIT", null, { date: "2022-01-05T00:00:00Z", amount: "2" })]));
  assert.deepEqual(shape(earlier), [{ units: "1,250.000 units", waiting: 26, accounts: mf({ kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }] }) }]);
  run.dispose();

  // Nothing there, or only after the statement starts: the units alone, as before.
  ({ run, earlier } = await earlierWith([flexiCap("later", "BUY", "500", { date: "2023-04-01T00:00:00Z" })]));
  assert.deepEqual(shape(earlier), [{ units: "1,250.000 units", waiting: 26, accounts: undefined }]);
  run.dispose();

  // Exactly the opening units: this fund no longer waits.
  ({ run, earlier } = await earlierWith([flexiCap("all", "BUY", "1250")]));
  assert.deepEqual(earlier, []);
  run.dispose();
});

test("a fund's own zero-opening folio doesn't hide what its account already has", async () => {
  const { earlier } = await earlierWith([flexiCap("hand", "BUY", "500")], {
    change(data) {
      const flexi = structuredClone(data.folios[0].schemes.find((s) => s.scheme.includes("Flexi")));
      flexi.close = String(Number(flexi.close) - Number(flexi.open));
      flexi.close_calculated = flexi.close;
      flexi.open = "0";
      data.folios.push({ ...data.folios[0], folio: "3301", schemes: [flexi] });
      return data;
    },
  });
  assert.deepEqual(earlier[0].accounts, [{ units: "1,250.000", account: "Mutual funds", folios: ["91234567 / 12"], held: { kind: "short", has: "500.000", add: "750.000" } }]);
});

test("a fund waiting for earlier purchases in two accounts says what each has", async () => {
  // Its folio's Flexi Cap units split over two folios: 250 to Other funds, which has 100, and 1,000 to Mutual funds, which has none.
  const change = (data) => {
    const flexi = data.folios[0].schemes.find((s) => s.scheme.includes("Flexi"));
    const moved = { ...structuredClone(flexi), open: "250", transactions: [], close: "250", close_calculated: "250" };
    flexi.open = "1000";
    flexi.close = String(Number(flexi.close) - 250);
    flexi.close_calculated = flexi.close;
    data.folios.push({ ...data.folios[0], folio: "3301", schemes: [moved] });
    return data;
  };
  const { earlier } = await earlierWith([flexiCap("other", "BUY", "100", { accountId: "other" })], {
    change, remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.folioKey({ amc: fixture.folios[0].amc, folio: "3301" })]: "other" },
  });
  assert.deepEqual(earlier.map(({ units, accounts }) => ({ units, accounts })), [{ units: "1,250.000 units", accounts: [
    { units: "1,000.000", account: "Mutual funds", folios: ["91234567 / 12"] },
    { units: "250.000", account: "Other funds", folios: ["3301"], held: { kind: "short", has: "100.000", add: "150.000" } },
  ] }]);
});

for (const open of ["0", "100"]) test(`a Wealthfolio fund that two of the statement's funds go to doesn't say what either has (other opens with ${open})`, async () => {
  // Liquid is confirmed as Flexi Cap's Wealthfolio fund, even when Liquid starts with no units.
  const options = {
    change(data) {
      const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      liquid.open = open;
      liquid.close = String(Number(liquid.close) + Number(open));
      liquid.close_calculated = liquid.close;
      return data;
    },
    edit({ props }) {
      const [flexi, liquid] = ["Flexi", "Liquid"].map((name) => choices.fundKey(props.data.folios[0].schemes.find((s) => s.scheme.includes(name))));
      props.fundChoices = { ...props.fundChoices, [liquid]: props.fundChoices[flexi] };
    },
  };
  let { run, earlier } = await earlierWith([flexiCap("hand", "BUY", "500")], options);
  assert.deepEqual(earlier.map(({ units, accounts }) => ({ units, accounts })), [
    { units: "1,250.000 units", accounts: undefined },
    ...(open === "0" ? [] : [{ units: "100.000 units", accounts: undefined }]),
  ]);
  run.dispose();

  // Shared funds still name an uncountable history in their account.
  ({ earlier } = await earlierWith([flexiCap("split", "SPLIT", null, { date: "2022-01-05T00:00:00Z" })], options));
  for (const fund of earlier) assert.deepEqual(fund.accounts[0].held, { kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }] });
});

test("earlier-purchase folios stay in statement order with events-only schemes and appear once per account", async () => {
  const { run } = setup({ entries: [], remembered: {
    [choices.panKey("ABCDE1234F")]: "mf",
    [choices.folioKey({ amc: fixture.folios[0].amc, folio: "3301" })]: "other",
  }, change(data) {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const opening = (units) => ({ ...structuredClone(liquid), open: units, close: String(Number(liquid.close) + Number(units)), close_calculated: String(Number(liquid.close) + Number(units)) });
    const events = { ...opening("100"), close: "100", close_calculated: "100", transactions: [
      { date: "2023-04-02", description: "Nominee registered", type: "MISC", units: null, amount: null, nav: null, balance: "100" },
    ] };
    data.folios = [
      { ...data.folios[0], folio: "7712045", schemes: [events] },
      { ...data.folios[0], folio: "91234567", schemes: [opening("200"), opening("25")] },
      { ...data.folios[0], folio: "3301", schemes: [opening("50")] },
    ];
    return data;
  } });
  await run.flush();
  assert.deepEqual(find(run, "NotIncludedDetailed").earlier.map(({ units, waiting, accounts }) => ({ units, waiting, accounts })), [{ units: "375.000 units", waiting: 9, accounts: [
    { units: "325.000", account: "Mutual funds", folios: ["7712045", "91234567"] },
    { units: "50.000", account: "Other funds", folios: ["3301"] },
  ] }]);
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

/**
 * The made-up statement's Liquid Fund in its first folio only, with its purchase twice and, between
 * the two, one of `other` rupees on the same day, if given.
 */
const equalPurchases = (other) => (data) => {
  const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
  const purchase = scheme.transactions.find((t) => t.type === "PURCHASE");
  const between = other && { ...structuredClone(purchase), amount: other, units: "1.000" };
  scheme.transactions = [purchase, ...(between ? [between] : []), structuredClone(purchase)];
  scheme.open = "0";
  scheme.close = scheme.close_calculated = String(Number(purchase.units) * 2 + (between ? 1 : 0));
  data.folios = [{ ...data.folios[0], schemes: [scheme] }];
  return data;
};
const DAY = String.raw`\d+ \w+ \d{4}`;

test("equal possible duplicates in one folio say which they are by their place on the statement", async () => {
  const { run, api } = setup({ entries: [], change: equalPurchases("1000.00") });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  // The purchase between them, for another amount, isn't equal to them: its card has no number and
  // doesn't count.
  const cards = askCards(run);
  assert.deepEqual(cards.map((c) => c.title), ["This purchase (1 of 2)", "This purchase", "This purchase (2 of 2)"].map((t) => `${t} may already be in Mutual funds`));
  assert.deepEqual(cards.map((c) => textOf(c.children).split("Already in")[0].replace(/ · [\d,.]+ units · ₹[\d,.]+$/, "")),
    ["Purchase (1 of 2)", "Purchase", "Purchase (2 of 2)"].map((m) => textOf(cards[0].children).split("Already in")[0].match(/^On this statement: [^·]+ · /)[0] + `${m} · Fictiva Liquid Fund`));
  // A numbered card says what's counted, and in what order.
  assert.deepEqual(cards.map((c) => textOf(c.children).match(/The statement lists .*$/)?.[0].replace(new RegExp(DAY), "<day>")), [
    "The statement lists 2 purchases of ₹24,998.75 in this fund and folio on <day>; this is the first.", undefined,
    "The statement lists 2 purchases of ₹24,998.75 in this fund and folio on <day>; this is the second.",
  ]);
  assert.match(cards[0].main.name, new RegExp(`^Skip this transaction: Fictiva Liquid Fund, purchase \\(1 of 2\\) of ₹[\\d,.]+ on ${DAY}$`));
  assert.match(cards[1].main.name, new RegExp(`^Skip this transaction: Fictiva Liquid Fund, purchase of ₹1,000 on ${DAY}$`));
  assert.match(cards[2].other.name, new RegExp(`^Import it as another purchase: Fictiva Liquid Fund, purchase \\(2 of 2\\) of ₹[\\d,.]+ on ${DAY}$`));
  // Answered alike, each line says which it is, so Change answer's name needs no number.
  for (const card of cards) card.main.onClick();
  await run.flush();
  const alike = askAnswers(run);
  assert.match(alike[0].text, new RegExp(`^₹[\\d,.]+ purchase \\(1 of 2\\) of Fictiva Liquid Fund on ${DAY}: skipped$`));
  assert.equal(alike[2].text, alike[0].text.replace("(1 of 2)", "(2 of 2)"));
  assert.deepEqual(alike.map((a) => a.name), alike.map((a) => a.text));
  // Reopened, the card keeps its number; answered the other way, so does each line.
  alike[2].onChange();
  await run.flush();
  const [reopened] = askCards(run);
  assert.equal(reopened.title, "This purchase (2 of 2) may already be in Mutual funds");
  assert.match(textOf(reopened.children), /^On this statement: [^·]+ · Purchase \(2 of 2\) · /);
  reopened.other.onClick();
  await run.flush();
  const differently = askAnswers(run);
  assert.equal(differently[0].text, alike[0].text);
  assert.equal(differently[2].text, alike[2].text.replace(/: skipped$/, ": imported as another purchase"));
  assert.deepEqual(differently.map((a) => a.name), differently.map((a) => a.text));
});

test("statement places don't rescan transactions on an unrelated render", async () => {
  const { run, api, data } = setup({ entries: [], change: equalPurchases() });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const scheme = data.folios[0].schemes[0];
  const transactions = scheme.transactions;
  let reads = 0;
  Object.defineProperty(scheme, "transactions", { get() { reads++; return transactions; } });
  run.update({});
  await run.flush();
  assert.equal(reads, 0, "statement order is unchanged, so reuse its places");
  assert.match(askCards(run)[1].title, /purchase \(2 of 2\)/);
});

test("a lone amount-less gift question counts unasked rows with different units, apart from amounts shown", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    equalPurchases()(data);
    const scheme = data.folios[0].schemes[0];
    const gift = { ...scheme.transactions[0], type: "GIFT_IN", amount: null, units: "10", nav: "50", balance: null };
    scheme.transactions = [gift, { ...gift, amount: "500" }, { ...gift, units: "11" }];
    scheme.close = scheme.close_calculated = "31";
    return data;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => r.quantity === "11" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const cards = askCards(run);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "This gift received (2 of 2) may already be in Mutual funds");
  assert.match(textOf(cards[0].children), /The statement lists 2 gifts received with no amount shown in this fund and folio on .*; this is the second\.$/);
  assert.match(cards[0].main.name, /gift received \(2 of 2\) on /);
});

/** The made-up statement's Liquid Fund in its first folio only, with its purchase alone. */
const onePurchase = (data) => {
  const [liquid] = equalPurchases()(data).folios[0].schemes;
  const purchase = liquid.transactions[0];
  liquid.transactions = [purchase];
  liquid.close = liquid.close_calculated = purchase.units;
  return data;
};

test("equal statement rows aren't asked about, with or without their IDs in Wealthfolio's check", async () => {
  const statements = {
    // Two purchases of one fund in one folio on one day, of one amount.
    "one fund": equalPurchases(),
    // Two funds' purchases in one folio: their deposits in the folio's account are equal.
    "two funds"(d) {
      const [liquid] = onePurchase(d).folios[0].schemes;
      d.folios[0].schemes.push({
        ...structuredClone(liquid), scheme: "Fictiva Overnight Fund - Direct Plan - Growth", isin: "INFZ90K01ON9", rta_code: "FONDG",
      });
      return d;
    },
    // One fund's purchase in two folios that go to one account.
    "two folios"(d) {
      onePurchase(d);
      d.folios.push({ ...structuredClone(d.folios[0]), folio: "222222222" });
      return d;
    },
  };
  for (const [name, change] of Object.entries(statements)) {
    for (const ids of [true, false]) {
      const { run, api } = setup({ entries: [], change });
      if (!ids) api.activities.checkImport = async (rows) => rows.map(({ sourceRecordId: _, ...rest }) => rest);
      await run.flush();
      assert.deepEqual(askCards(run), [], `${name}, ${ids ? "with" : "without"} IDs`);
      assert.equal(find(run, "Footer").action.label, "Import 2 transactions", `${name}, ${ids ? "with" : "without"} IDs`);
    }
  }
});

test("equal possible duplicates are numbered in a folio whose number another fund house's folio also has", async () => {
  const { run, api, data } = setup({ entries: [], change(d) {
    equalPurchases()(d);
    const [fictiva] = d.folios;
    const [liquid] = fictiva.schemes;
    const purchase = structuredClone(liquid.transactions[0]);
    const testbridge = {
      ...structuredClone(liquid), scheme: "Testbridge Liquid Fund - Direct Plan - Growth", isin: "INFZ91T01LQ2", rta_code: "TLQDG",
      transactions: [purchase], close: purchase.units, close_calculated: purchase.units,
    };
    // The other fund house's folio comes first, with the same number.
    d.folios = [{ ...structuredClone(fictiva), amc: "Testbridge Mutual Fund", schemes: [testbridge] }, fictiva];
    return d;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  assert.equal(data.folios[0].folio, data.folios[1].folio);
  assert.deepEqual(askCards(run).map((c) => textOf(c.children).match(/^On this statement: [^·]+ · ([^·]+ · [^·]+) · /)[1]),
    ["Purchase · Testbridge Liquid Fund", "Purchase (1 of 2) · Fictiva Liquid Fund", "Purchase (2 of 2) · Fictiva Liquid Fund"]);
});

/**
 * The made-up Liquid Fund's purchase in Fictiva's folio, and in Testbridge's folio of the same number
 * a purchase of another fund printed with the Liquid Fund's name; `twinChosen` chooses it as
 * Testbridge Liquid Fund. With `unbalanced`, Fictiva's Balanced Advantage Fund, whose rows don't add
 * up, is in Fictiva's folio too.
 */
const twinHouses = (unbalanced = false) => (d) => {
  const [fictiva, testbridge] = d.folios;
  const balanced = fictiva.schemes.find((s) => s.scheme.includes("Balanced"));
  balanced.close = String(Number(balanced.close_calculated) + 1);
  const [liquid] = onePurchase(d).folios[0].schemes;
  const twin = { ...structuredClone(liquid), isin: "INFZ91T01LQ2", rta_code: "TLQDG" };
  d.folios = [{ ...fictiva, schemes: unbalanced ? [liquid, balanced] : [liquid] }, { ...testbridge, folio: fictiva.folio, schemes: [twin] }];
  return d;
};
/** `twinHouses`' Liquid Fund and the other fund printed with its name, the latter chosen as Testbridge Liquid Fund. */
function twinChosen({ props, data }) {
  const [liquid, twin] = data.folios.map((f) => f.schemes[0]);
  assert.equal(data.folios[0].folio, data.folios[1].folio);
  assert.equal(liquid.scheme, twin.scheme);
  props.fundChoices[choices.fundKey(twin)].fund.name = "Testbridge Liquid Fund - Direct Plan - Growth";
  return [liquid, twin];
}

test("possible duplicates in two fund houses' folios of one number and one printed fund name name their own funds", async () => {
  const context = setup({ entries: [], change: twinHouses(true) });
  const { run, api } = context;
  const symbols = twinChosen(context).map((s) => s.isin);
  const flagged = (rows) => rows.map((r) => r.activityType === "BUY" && symbols.includes(r.symbol) ? { ...r, duplicateOfId: "previous" } : r);
  api.activities.checkImport = async (rows) => flagged(rows);
  await run.flush();
  const funds = ["Fictiva Liquid Fund", "Testbridge Liquid Fund"];
  const purchase = "purchase of ₹24,998.75 on 5 May 2023";
  /** Each open possible duplicate's fund on its statement line, and its buttons' names. */
  const shown = () => askCards(run).filter((c) => c.title.startsWith("This purchase")).map((c) => [
    textOf(c.children).match(/^On this statement: [^·]+ · Purchase · ([^·]+) · /)?.[1], c.main.name, c.other.name,
  ]);
  const named = (fund) => [fund, `Skip this transaction: ${fund}, ${purchase}`, `Import it as another purchase: ${fund}, ${purchase}`];
  assert.deepEqual(shown(), funds.map(named));
  // While an answer works the plan out again, the cards from the plan before name the same funds.
  let finish;
  api.activities.checkImport = (rows) => new Promise((resolve) => { finish = () => resolve(flagged(rows)); });
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(shown(), funds.map(named));
  askCards(run).at(-1).other.onClick();
  await run.flush();
  assert.deepEqual(shown(), [named(funds[0])]);
  const testbridge = `₹24,998.75 purchase of ${funds[1]} on 5 May 2023: imported as another purchase`;
  assert.deepEqual(askAnswers(run).map((a) => a.text).slice(1), [testbridge]);
  finish();
  await run.flush();
  assert.deepEqual(shown(), [named(funds[0])]);
  askCards(run)[0].main.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text), [
    "Fictiva Balanced Advantage Fund: imported with the difference", `₹24,998.75 purchase of ${funds[0]} on 5 May 2023: skipped`, testbridge,
  ]);
  // As Ready to import names the one imported.
  assert.deepEqual(find(run, "FundsReadyTable").rows.map((r) => r.name).filter((name) => name.includes("Liquid")), [funds[1]]);
});

/** `equalPurchases()`, with the same purchase once more in a second folio, 222222222. */
const equalInTwoFolios = (d) => {
  equalPurchases()(d);
  const [scheme] = d.folios[0].schemes;
  const other = { ...scheme, transactions: [structuredClone(scheme.transactions[0])] };
  other.close = other.close_calculated = other.transactions[0].units;
  d.folios.push({ ...structuredClone(d.folios[0]), folio: "222222222", schemes: [other] });
  return d;
};

test("equal possible duplicates in one folio and another name the folio and their place in it", async () => {
  const { run, api, data } = setup({ entries: [], change: equalInTwoFolios });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const [first, second] = data.folios.map((f) => f.folio);
  const cards = askCards(run);
  assert.deepEqual(cards.map((c) => c.title), [`This purchase (1 of 2) in folio ${first}`, `This purchase (2 of 2) in folio ${first}`, `This purchase in folio ${second}`]
    .map((t) => `${t} may already be in Mutual funds`));
  assert.deepEqual(cards.map((c) => textOf(c.children).match(/^On this statement: [^·]+ · ([^·]+ · [^·]+) · /)[1]),
    [`Purchase (1 of 2) · Fictiva Liquid Fund, folio ${first}`, `Purchase (2 of 2) · Fictiva Liquid Fund, folio ${first}`, `Purchase · Fictiva Liquid Fund, folio ${second}`]);
  for (const card of cards) card.main.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text.replace(/^₹[\d,.]+ /, "").replace(new RegExp(` on ${DAY}`), "")), [
    `purchase (1 of 2) of Fictiva Liquid Fund, folio ${first}: skipped`, `purchase (2 of 2) of Fictiva Liquid Fund, folio ${first}: skipped`,
    `purchase of Fictiva Liquid Fund, folio ${second}: skipped`,
  ]);
});

/** Markup as shown, its text nodes joined. */
const markup = (node) => renderToStaticMarkup(node).replaceAll("<!-- -->", "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
/** The text of the element with this id in `html`, its tags dropped. */
function textById(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `an element with id ${id}`);
  const from = html.indexOf(">", start) + 1;
  const tag = /<(\/?)[a-z]+[^>]*?(\/?)>/g;
  tag.lastIndex = from;
  let depth = 1;
  for (let m; (m = tag.exec(html));) {
    if (m[2]) continue;
    depth += m[1] ? -1 : 1;
    if (!depth) return html.slice(from, m.index).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
/** A bank check's pairs as shown: each one's fund, movement, and its checkbox's accessible name. */
function shownPairs(node) {
  const html = markup(node);
  return [...html.matchAll(/aria-labelledby="([^"]+ [^"]+ [^"]+ [^"]+)"/g)].map(([, ids]) => {
    const [fund, movement] = ids.split(" ").map((id) => textById(html, id));
    return { fund, movement, name: ids.split(" ").map((id) => textById(html, id)).join(" ") };
  });
}
/** The bank checks under the bank choice with this key, as elements. */
const checkNodes = (run, key) => nodes(saveTo(run).checks(key)).filter((node) => node.type?.name === "BankCheck");
/** See every transaction's rows as shown: each one's cells' text. */
async function shownTable(run) {
  if (!find(run, "ActivityTable")) {
    nodes(find(run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
    await run.flush();
  }
  const html = markup(nodes(run.tree).find((node) => node.type?.name === "ActivityTable"));
  return [...html.slice(html.indexOf("<tbody")).matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(([, cell]) => cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));
}
/** Three equal withdrawals from Savings, each one the made-up Liquid Fund purchase's. */
const EQUAL_WITHDRAWALS = [1, 2, 3].map((n) => entry(`neft-${n}`, "WITHDRAWAL", "24998.75", "2023-05-05", "NEFT FICTIVA MF"));
/** The PAN's funds going to Mutual funds, with Savings for their cash. */
const withSavings = () => ({ [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" });

test("table row identity doesn't recalculate every equal row's fund name", async () => {
  const { run, props } = setup({ entries: [], change(d) {
    equalPurchases()(d);
    const [folio] = d.folios;
    const [scheme] = folio.schemes;
    d.folios = Array.from({ length: 40 }, (_, i) => ({
      ...folio, folio: String(7712000 + i), schemes: [{
        ...scheme, scheme: `Fictiva Test ${i} Fund - Direct Plan - Growth`, isin: `FICTIVA${i}`,
        transactions: [structuredClone(scheme.transactions[0])], close: scheme.transactions[0].units, close_calculated: scheme.transactions[0].units,
      }],
    }));
    return d;
  } });
  await run.flush();
  await shownTable(run);
  let namesRead = 0;
  for (const { fund } of Object.values(props.fundChoices)) {
    const name = fund.name;
    Object.defineProperty(fund, "name", { get() { namesRead++; return name; } });
  }
  const table = find(run, "ActivityTable");
  assert.equal(table.plan.length, 40);
  assert.deepEqual(table.plan.map((t) => table.which(t.transaction.rows[0])), Array(40).fill({ place: "", folio: false }));
  assert.ok(namesRead <= 40, `${namesRead} fund-name reads for 40 row labels`);
  // Changing a chosen listing's name must update the cached folio rule, even though the statement stays.
  const keys = Object.keys(props.fundChoices);
  const renamed = { ...props.fundChoices, [keys[1]]: { fund: { ...props.fundChoices[keys[1]].fund, name: props.fundChoices[keys[0]].fund.name } } };
  run.update({ fundChoices: renamed });
  await run.flush();
  const changed = find(run, "ActivityTable");
  assert.deepEqual(changed.plan.map((t) => changed.which(t.transaction.rows[0]).folio), [true, true, ...Array(38).fill(false)]);
});

test("equal purchases' bank pairs and table rows say which they are on the statement, with no question about them", async () => {
  const { run, keys, data } = setup({ entries: EQUAL_WITHDRAWALS, remembered: withSavings(), change: equalInTwoFolios });
  await run.flush();
  assert.equal(askCards(run).length, 0);
  const [first, second] = data.folios.map((f) => f.folio);
  // Each pair's fund names its folio, as the fund has an equal purchase in the other, and its
  // movement says which of the folio's equal purchases it is.
  const [check, ...more] = checkNodes(run, choices.bankKey(keys.pan));
  assert.equal(more.length, 0);
  const pairs = shownPairs(check);
  assert.deepEqual(pairs.map((p) => [p.fund, p.movement]), [
    [`Fictiva Liquid Fund, folio ${first}`, "Purchase (1 of 2) · 5 May 2023 · ₹24,998.75, from Savings"],
    [`Fictiva Liquid Fund, folio ${first}`, "Purchase (2 of 2) · 5 May 2023 · ₹24,998.75, from Savings"],
    [`Fictiva Liquid Fund, folio ${second}`, "Purchase · 5 May 2023 · ₹24,998.75, from Savings"],
  ]);
  // The equal entries read the same, so the checkboxes' names differ by fund, folio and place.
  pairs.forEach((p, i) => assert.equal(p.name, `${p.fund} ${p.movement} Savings: NEFT FICTIVA MF · 5 May 2023 · −₹24,998.75 Pair ${i + 1}: ANANYA R TESTWALA's funds · Savings`));
  // Answered, the check lets the table open; its rows say the same.
  check.props.onNone();
  await run.flush();
  assert.deepEqual((await shownTable(run)).map((row) => row.slice(0, 3)), [
    ["2023-05-05", `Fictiva Liquid Fund - Direct Plan - Growth, folio ${first}`, "purchase (1 of 2)"],
    ["2023-05-05", `Fictiva Liquid Fund - Direct Plan - Growth, folio ${first}`, "purchase (2 of 2)"],
    ["2023-05-05", `Fictiva Liquid Fund - Direct Plan - Growth, folio ${second}`, "purchase"],
  ]);
});

test("a bank pair and table row name the folio only when a fund named the same has an equal row in another folio", async () => {
  const { run, keys, data } = setup({
    entries: [...EQUAL_WITHDRAWALS, entry("neft-small", "WITHDRAWAL", "1000.00", "2023-05-05", "NEFT FICTIVA MF")],
    remembered: withSavings(),
    change(d) {
      equalPurchases("1000.00")(d);
      // The Regular plan, another fund the screen names the same, in another folio.
      const [direct] = d.folios[0].schemes;
      const regular = {
        ...structuredClone(direct), scheme: "Fictiva Liquid Fund - Regular Plan - Growth", isin: "INFZ90K01LR4", rta_code: "FLQRG",
        transactions: [structuredClone(direct.transactions[0])],
      };
      regular.close = regular.close_calculated = regular.transactions[0].units;
      d.folios.push({ ...structuredClone(d.folios[0]), folio: "222222222", schemes: [regular] });
      return d;
    },
  });
  await run.flush();
  const [first, second] = data.folios.map((f) => f.folio);
  const [check] = checkNodes(run, choices.bankKey(keys.pan));
  // The purchase of ₹1,000 has no equal row anywhere: no folio and no number.
  assert.deepEqual(shownPairs(check).map((p) => `${p.fund} · ${p.movement}`), [
    `Fictiva Liquid Fund, folio ${first} · Purchase (1 of 2) · 5 May 2023 · ₹24,998.75, from Savings`,
    "Fictiva Liquid Fund · Purchase · 5 May 2023 · ₹1,000, from Savings",
    `Fictiva Liquid Fund, folio ${first} · Purchase (2 of 2) · 5 May 2023 · ₹24,998.75, from Savings`,
    `Fictiva Liquid Fund, folio ${second} · Purchase · 5 May 2023 · ₹24,998.75, from Savings`,
  ]);
  check.props.onNone();
  await run.flush();
  assert.deepEqual((await shownTable(run)).map((row) => row.slice(1, 3)), [
    [`Fictiva Liquid Fund - Direct Plan - Growth, folio ${first}`, "purchase (1 of 2)"],
    ["Fictiva Liquid Fund - Direct Plan - Growth", "purchase"],
    [`Fictiva Liquid Fund - Direct Plan - Growth, folio ${first}`, "purchase (2 of 2)"],
    [`Fictiva Liquid Fund - Regular Plan - Growth, folio ${second}`, "purchase"],
  ]);
});

test("equal possible duplicates' bank pairs and table rows keep their statement numbers through skip and import answers", async () => {
  const { run, api, keys, data } = setup({ entries: EQUAL_WITHDRAWALS, remembered: withSavings(), change: equalInTwoFolios });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const [first, second] = data.folios.map((f) => f.folio);
  const shownChecks = () => checkNodes(run, choices.bankKey(keys.pan)).map((node) => shownPairs(node).map((p) => `${p.fund} · ${p.movement.split(" · ")[0]}`));
  // Nothing goes to the bank until a possible duplicate is imported.
  assert.deepEqual(shownChecks(), []);
  // Skip the first, import the others: the second keeps its number, and the table says which went in.
  const cards = askCards(run);
  cards[0].main.onClick();
  cards[1].other.onClick();
  cards[2].other.onClick();
  await run.flush();
  assert.deepEqual(shownChecks(), [[`Fictiva Liquid Fund, folio ${first} · Purchase (2 of 2)`, `Fictiva Liquid Fund, folio ${second} · Purchase`]]);
  checkNodes(run, choices.bankKey(keys.pan))[0].props.onNone();
  await run.flush();
  const statuses = (rows) => rows.map((row) => [row[2], row.at(-1)]);
  const anyway = "Possible duplicate Wealthfolio reports this purchase as a duplicate. Imported anyway, by your answer.";
  assert.deepEqual(statuses(await shownTable(run)), [
    ["purchase (1 of 2)", "Possible duplicate Wealthfolio reports this purchase as a duplicate."],
    ["purchase (2 of 2)", anyway],
    ["purchase", anyway],
  ]);
  // The other way round in the folio: the first is imported and the second skipped.
  askAnswers(run)[1].onChange();
  await run.flush();
  askCards(run)[0].main.onClick();
  await run.flush();
  askAnswers(run)[0].onChange();
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text.replace(/^₹[\d,.]+ /, "").replace(new RegExp(` on ${DAY}`), "")), [
    `purchase (1 of 2) of Fictiva Liquid Fund, folio ${first}: imported as another purchase`,
    `purchase (2 of 2) of Fictiva Liquid Fund, folio ${first}: skipped`,
    `purchase of Fictiva Liquid Fund, folio ${second}: imported as another purchase`,
  ]);
  assert.deepEqual(shownChecks(), [[`Fictiva Liquid Fund, folio ${first} · Purchase (1 of 2)`, `Fictiva Liquid Fund, folio ${second} · Purchase`]]);
  assert.deepEqual(statuses(await shownTable(run)).map(([activity, status]) => [activity, status === anyway]), [
    ["purchase (1 of 2)", true], ["purchase (2 of 2)", false], ["purchase", true],
  ]);
});

/**
 * Makes up Wealthfolio's writes for linking bank entries in Savings, which isn't in Spending: adding
 * a fund account's transfer fails while the returned `failing.create` is set.
 */
function linkWrites({ api, activities }) {
  const getAll = api.activities.getAll;
  api.activities.getAll = async (id) => (await getAll(id)).map((row) => ({ ...row }));
  const failing = { create: false };
  api.activities.create = async (row) => {
    if (failing.create) throw new Error("made-up transfer failure");
    const transfer = { ...row, id: `fund-transfer-${activities.length}`, date: row.activityDate, status: "POSTED", assetId: "", assetSymbol: "" };
    activities.push(transfer);
    return transfer;
  };
  api.activities.update = async (row) => void Object.assign(activities.find((a) => a.id === row.id), row);
  api.activities.linkTransfer = async () => {};
  api.spending.unassignCategory = async () => {};
  return failing;
}
/** Ticks every pair of the PAN's bank check, links them, and returns how many it ticked. */
async function linkEvery({ run, keys }) {
  const check = () => checksUnder(run, choices.bankKey(keys.pan))[0];
  for (const { key } of check().check.pairs) {
    check().onTick(key, true);
    await run.flush();
  }
  const ticked = check().ticked.size;
  check().onLink();
  await run.flush();
  return ticked;
}

/**
 * `equalInTwoFolios`' purchases, each linked with one of the equal withdrawals from Savings, with
 * `linkWrites`' writes. With `skipFirst`, Wealthfolio's check calls every purchase a possible
 * duplicate, and the first folio's first is skipped and the others imported anyway.
 */
async function equalLinks({ skipFirst = false } = {}) {
  const context = setup({ entries: structuredClone(EQUAL_WITHDRAWALS), remembered: withSavings(), change: equalInTwoFolios });
  const { run, api } = context;
  const failing = linkWrites(context);
  if (skipFirst) api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  if (skipFirst) {
    const [skip, ...anyway] = askCards(run);
    skip.main.onClick();
    anyway.forEach((card) => card.other.onClick());
    await run.flush();
  }
  assert.equal(await linkEvery(context), skipFirst ? 2 : 3);
  return { ...context, failing };
}
/** The import result as shown: its lines' text, and its buttons' accessible names. */
function shownResult(run) {
  const html = markup(nodes(run.tree).find((node) => node.type?.name === "ImportResult"));
  const text = (part) => part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    lines: [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, line]) => text(line)),
    buttons: [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, button]) => button.replace(/<[^>]+>/g, "")),
  };
}
/** The import result's line that counts the bank entries linked, if it shows one. */
function linkedLine(run) {
  const html = markup(nodes(run.tree).find((node) => node.type?.name === "ImportResult"));
  const line = html.match(/<p[^>]* id="[^"]*-result-linked"[^>]*>(.*?)<\/p>/);
  return line && line[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ ([.,])/g, "$1").trim();
}
/** The live region's words, once its delay is over. */
async function announced(run) {
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  return nodes(run.tree).find((n) => n.props?.role === "status").props.children;
}

test("equal linked purchases say which they are in the result's failed links, their Try again and the changed entries", async () => {
  const { run, data, failing } = await equalLinks();
  const [first, second] = data.folios.map((f) => f.folio);
  const purchases = [
    `purchase (1 of 2) of Fictiva Liquid Fund, folio ${first} on 5 May 2023`,
    `purchase (2 of 2) of Fictiva Liquid Fund, folio ${first} on 5 May 2023`,
    `purchase of Fictiva Liquid Fund, folio ${second} on 5 May 2023`,
  ];
  const title = (purchase) => `${purchase[0].toUpperCase()}${purchase.slice(1)}`;
  failing.create = true;
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), ["transfer", "transfer", "transfer"]);
  assert.equal(linkedLine(run), null, "none linked, so no line counts them");
  const unlinked = "The trade is in Wealthfolio, but the fund account's transfer wasn't added, so the bank entry of 5 May 2023 wasn't linked.";
  const failed = shownResult(run);
  assert.deepEqual(failed.lines.filter((line) => line.startsWith("✗ Purchase")), purchases.map((p) =>
    `✗ ${title(p)}: ${unlinked} Try again : link the bank entry of 5 May 2023 with the ${p}`));
  // Each Try again's name says which transaction's entry it links.
  const retries = failed.buttons.filter((name) => name.includes("link the bank entry"));
  assert.deepEqual(retries, purchases.map((p) => `Try again: link the bank entry of 5 May 2023 with the ${p}`));
  assert.equal(new Set(retries).size, 3);
  // So does the announcement.
  const notice = await announced(run);
  for (const p of purchases) assert.ok(notice.includes(`${title(p)}: ${unlinked} Try again to link the bank entry.`), notice);
  // Each linked once tried again, each changed entry names its transaction the same way.
  failing.create = false;
  // Each Try again counts the entries linked out of all chosen, and every one once they all are.
  const counts = [];
  for (const i of [0, 1, 2]) {
    const result = find(run, "ImportResult");
    result.onRetryLink(result.links[i]);
    await run.flush();
    counts.push(linkedLine(run));
  }
  assert.deepEqual(counts, [
    "✓ Linked 1 of 3 bank entries you chose with their transactions.",
    "✓ Linked 2 of 3 bank entries you chose with their transactions.",
    "✓ Linked all 3 bank entries you chose with their transactions.",
  ]);
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), [undefined, undefined, undefined]);
  assert.deepEqual(shownResult(run).lines.filter((line) => line.startsWith("The withdrawal")), purchases.map((p) =>
    `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT FICTIVA MF), for the ${p}: Any split it had across spending categories was deleted.`));
});

test("a bank entry chosen for a trade Wealthfolio refused before linking counts among those chosen", async () => {
  const { run, api, imported } = await equalLinks();
  // The first try refuses the first purchase, so its entry never reaches linking; the second imports the rest.
  api.activities.import = async (rows) => {
    imported.push(rows);
    const first = imported.length === 1;
    const refused = rows.find((r) => r.activityType === "BUY");
    return {
      activities: rows.map((r) => first && r === refused ? { ...r, isValid: false, errors: { symbol: ["The fund could not be created"] } } : { ...r }),
      summary: { success: !first, total: rows.length, imported: first ? 0 : rows.length, duplicates: 0, assetsCreated: 0 },
    };
  };
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 2);
  const result = find(run, "ImportResult");
  assert.deepEqual([result.links.length, result.links.filter((l) => l.stage).length, result.chosen], [2, 0, 3]);
  assert.equal(linkedLine(run), "✓ Linked 2 of 3 bank entries you chose with their transactions.");
});

test("a linked purchase keeps its statement number in the result when an equal one is skipped", async () => {
  const { run, data, imported } = await equalLinks({ skipFirst: true });
  const [first, second] = data.folios.map((f) => f.folio);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.flat().filter((r) => r.activityType === "BUY").length, 2);
  assert.deepEqual(shownResult(run).lines.filter((line) => line.startsWith("The withdrawal")), [
    `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT FICTIVA MF), for the purchase (2 of 2) of Fictiva Liquid Fund, folio ${first} on 5 May 2023: Any split it had across spending categories was deleted.`,
    `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT FICTIVA MF), for the purchase of Fictiva Liquid Fund, folio ${second} on 5 May 2023: Any split it had across spending categories was deleted.`,
  ]);
});

test("equal linked purchases say which they are when their chosen bank entries are gone before Import", async () => {
  const { run, data, activities, imported } = await equalLinks();
  const [first, second] = data.folios.map((f) => f.folio);
  // Deleted in Wealthfolio after the review.
  activities.splice(0, activities.length, ...activities.filter((a) => a.accountId !== "bank"));
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 0);
  const lines = nodes(run.tree).filter((node) => node.type === "li").map(textOf).filter((line) => line.includes(", chosen for "));
  assert.deepEqual(lines, [
    `purchase (1 of 2) of Fictiva Liquid Fund, folio ${first}`,
    `purchase (2 of 2) of Fictiva Liquid Fund, folio ${first}`,
    `purchase of Fictiva Liquid Fund, folio ${second}`,
  ].map((p) => `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT FICTIVA MF), chosen for the ${p} on 5 May 2023, ` +
    "is no longer in Wealthfolio, so the transaction now comes with a new transfer out."));
});

/** The import result's list items as shown, each with the items of a list inside it as its own. */
function resultItems(run) {
  const html = markup(nodes(run.tree).find((node) => node.type?.name === "ImportResult"));
  const items = [];
  const open = [];
  for (const m of html.matchAll(/<(\/?)(li|ul)\b[^>]*>|<[^>]*>|([^<]+)/g)) {
    if (!m[2]) {
      // Text, or another tag, which keeps the words on either side apart.
      for (const item of open) item.text += m[3] ?? " ";
    } else if (m[2] === "li" && !m[1]) {
      const item = { text: "", rows: [] };
      (open.at(-1)?.rows ?? items).push(item);
      open.push(item);
    } else if (m[2] === "li") open.pop();
  }
  const clean = (item) => ({ text: item.text.replace(/\s+/g, " ").trim(), rows: item.rows.map((row) => clean(row).text) });
  return items.map(clean).map(({ text, rows }) => {
    // The item's own words, without those of its rows.
    const own = rows.reduce((t, row) => t.replace(row, ""), text).replace(/\s+/g, " ").trim();
    return rows.length ? [own, rows] : [own];
  });
}

test("rows Wealthfolio rejected or skipped name each transaction as the Review screen does, grouping its rows", async () => {
  const { run, api, data, imported } = setup({ entries: [], remembered: withSavings(), change: equalInTwoFolios });
  const [first, second] = data.folios.map((f) => f.folio);
  // The first try refuses the first folio's first purchase and the second folio's withdrawal; the
  // second, without them, skips the first folio's second purchase's transfer as a duplicate.
  api.activities.import = async (rows) => {
    imported.push(rows);
    const purchases = [];
    for (const row of rows) {
      if (row.activityType === "BUY") purchases.push([]);
      purchases.at(-1).push(row);
    }
    const answers = imported.length === 1
      ? rows.map((r) => r === purchases[0][0] ? { ...r, isValid: false, errors: { symbol: ["The fund could not be created"] } }
        : r === purchases[2][2] ? { ...r, isValid: false, errors: { general: ["Made-up bank refusal."] } } : { ...r })
      : rows.map((r) => r === purchases[0][1] ? { ...r, duplicateOfId: "earlier-transfer" } : { ...r });
    const success = imported.length > 1;
    return { activities: answers, summary: { success, total: rows.length, imported: success ? rows.length - 1 : 0, duplicates: 0, assetsCreated: 0 } };
  };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map((rows) => rows.map((r) => r.activityType)), [
    ["BUY", "TRANSFER_IN", "TRANSFER_OUT", "BUY", "TRANSFER_IN", "TRANSFER_OUT", "BUY", "TRANSFER_IN", "TRANSFER_OUT"],
    ["BUY", "TRANSFER_IN", "TRANSFER_OUT"],
  ]);
  const another = "Another row of this transaction was rejected, so none of it was imported.";
  const skippedLine = `Purchase (2 of 2) of Fictiva Liquid Fund, folio ${first} on 5 May 2023, ₹24,998.75: the transfer into Mutual funds`;
  const items = resultItems(run);
  assert.deepEqual(items.filter(([text]) => text.startsWith("Purchase")), [
    [`Purchase (1 of 2) of Fictiva Liquid Fund, folio ${first} on 5 May 2023, ₹24,998.75:`, [
      "The purchase in Mutual funds: The fund could not be created",
      `The transfer into Mutual funds and the transfer out of Savings: ${another}`,
    ]],
    [`Purchase of Fictiva Liquid Fund, folio ${second} on 5 May 2023, ₹24,998.75:`, [
      `The purchase in Mutual funds and the transfer into Mutual funds: ${another}`,
      "The transfer out of Savings: Made-up bank refusal.",
    ]],
    [skippedLine],
  ]);
  // The first two under Wealthfolio rejected rows, the last under the skipped rows.
  const shown = markup(nodes(run.tree).find((node) => node.type?.name === "ImportResult")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const at = (words) => shown.indexOf(words);
  assert.ok(at("Wealthfolio rejected rows") >= 0 && at("Wealthfolio rejected rows") < at("Purchase (1 of 2)"), shown);
  assert.ok(at("Wealthfolio skipped rows the preview didn't expect") > at("Made-up bank refusal."), shown);
  assert.ok(at("Wealthfolio skipped rows the preview didn't expect") < at(skippedLine), shown);
  assert.ok(!/2023-05-05|24998|INFZ90K01LQ6|Direct Plan/.test(shown), shown);
});

test("units that differ after an import name each fund as the Review screen does", async () => {
  const { run } = setup({ entries: [] });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  const result = find(run, "ImportResult");
  // The made-up host keeps nothing imported, so every fund checked differs.
  assert.ok(Array.isArray(result.closing) && result.closing.length > 1);
  const units = resultItems(run).map(([text]) => text).filter((text) => text.includes(": Wealthfolio has "));
  assert.equal(units.length, result.closing.length);
  assert.deepEqual(units.map((text) => text.split(":")[0]),
    result.closing.map(({ schemes: [s] }) => s.scheme.split(" - ")[0]));
  assert.ok(units.every((text) => !text.includes("Direct Plan") && !text.includes("Regular Plan")), units.join("\n"));
});

/**
 * `twinHouses`' purchases, each with its fund house's withdrawal from Savings, `linkWrites`' writes,
 * and the PAN's funds going to a new account, Mutual funds 2, which Wealthfolio creates on importing.
 */
async function twinLinks() {
  const context = setup({
    entries: [entry("neft-fictiva", "WITHDRAWAL", "24998.75", "2023-05-05", "NEFT FICTIVA MF"), entry("neft-testbridge", "WITHDRAWAL", "24998.75", "2023-05-05", "NEFT TESTBRIDGE MF")],
    remembered: { [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" },
    change: twinHouses(),
  });
  twinChosen(context);
  const { run, api, props, keys } = context;
  const failing = linkWrites(context);
  api.accounts.create = async (payload) => ({ id: "created-1", ...payload, isArchived: false, group: null });
  props.onCreated = (made) => run.update({ accounts: [...props.accounts, ...made], allAccounts: [...props.allAccounts, ...made] });
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  await run.flush();
  return { ...context, failing };
}

test("two fund houses' purchases in folios of one number and one printed fund name are named as their own in bank pairs and the import result", async () => {
  const context = await twinLinks();
  const { run, keys, failing } = context;
  const funds = ["Fictiva Liquid Fund", "Testbridge Liquid Fund"];
  // Each pair names its own fund, beside its own fund house's entry.
  const [check, ...more] = checkNodes(run, choices.bankKey(keys.pan));
  assert.equal(more.length, 0);
  assert.deepEqual(shownPairs(check).map((p) => [p.fund, p.name.match(/Savings: (NEFT \w+ MF)/)[1]]), [[funds[0], "NEFT FICTIVA MF"], [funds[1], "NEFT TESTBRIDGE MF"]]);
  assert.equal(await linkEvery(context), 2);
  failing.create = true;
  find(run, "Footer").action.onClick();
  await run.flush();
  // Imported into the account created for them, so the result has copies of the transactions.
  assert.deepEqual(find(run, "ImportResult").outcomes.map((a) => [a.accountId, a.isNew, a.state]), [["created-1", true, "imported"]]);
  const purchases = funds.map((fund) => `purchase of ${fund} on 5 May 2023`);
  const title = (purchase) => `P${purchase.slice(1)}`;
  const unlinked = "The trade is in Wealthfolio, but the fund account's transfer wasn't added, so the bank entry of 5 May 2023 wasn't linked.";
  const failed = shownResult(run);
  assert.deepEqual(failed.lines.filter((line) => line.startsWith("✗ Purchase")), purchases.map((p) =>
    `✗ ${title(p)}: ${unlinked} Try again : link the bank entry of 5 May 2023 with the ${p}`));
  assert.deepEqual(failed.buttons.filter((name) => name.startsWith("Try again")), purchases.map((p) => `Try again: link the bank entry of 5 May 2023 with the ${p}`));
  const notice = await announced(run);
  for (const p of purchases) assert.ok(notice.includes(`${title(p)}: ${unlinked} Try again to link the bank entry.`), notice);
  failing.create = false;
  for (const i of [0, 1]) {
    const result = find(run, "ImportResult");
    result.onRetryLink(result.links[i]);
    await run.flush();
  }
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), [undefined, undefined]);
  assert.deepEqual(shownResult(run).lines.filter((line) => line.startsWith("The withdrawal")), ["FICTIVA", "TESTBRIDGE"].map((house, i) =>
    `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT ${house} MF), for the ${purchases[i]}: Any split it had across spending categories was deleted.`));
});

test("two fund houses' purchases in folios of one number and one printed fund name are named as their own when their chosen bank entries are gone before Import", async () => {
  const context = await twinLinks();
  const { run, activities, imported } = context;
  assert.equal(await linkEvery(context), 2);
  // Deleted in Wealthfolio after the review.
  activities.splice(0, activities.length, ...activities.filter((a) => a.accountId !== "bank"));
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 0);
  const lines = nodes(run.tree).filter((node) => node.type === "li").map(textOf).filter((line) => line.includes(", chosen for "));
  assert.deepEqual(lines, [["FICTIVA", "Fictiva"], ["TESTBRIDGE", "Testbridge"]].map(([house, fund]) =>
    `The withdrawal of ₹24,998.75 on 5 May 2023 in Savings (NEFT ${house} MF), chosen for the purchase of ${fund} Liquid Fund on 5 May 2023, ` +
    "is no longer in Wealthfolio, so the transaction now comes with a new transfer out."));
});

test("rows Wealthfolio rejected or skipped name their own fund house's fund when two folios share a number and a printed fund name", async () => {
  const context = setup({ entries: [], remembered: withSavings(), change: twinHouses() });
  twinChosen(context);
  const { run, api, imported } = context;
  // The first try refuses Testbridge's purchase; the second, without it, skips Fictiva's transfer in
  // as a duplicate.
  api.activities.import = async (rows) => {
    imported.push(rows);
    const purchases = [];
    for (const row of rows) {
      if (row.activityType === "BUY") purchases.push([]);
      purchases.at(-1).push(row);
    }
    const first = imported.length === 1;
    const answers = rows.map((r) => first && r === purchases[1][0] ? { ...r, isValid: false, errors: { symbol: ["The fund could not be created"] } }
      : !first && r === purchases[0][1] ? { ...r, duplicateOfId: "earlier-transfer" } : { ...r });
    return { activities: answers, summary: { success: !first, total: rows.length, imported: first ? 0 : rows.length - 1, duplicates: 0, assetsCreated: 0 } };
  };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(imported.length, 2);
  assert.deepEqual(resultItems(run).filter(([text]) => text.startsWith("Purchase")), [
    ["Purchase of Testbridge Liquid Fund on 5 May 2023, ₹24,998.75:", [
      "The purchase in Mutual funds: The fund could not be created",
      "The transfer into Mutual funds and the transfer out of Savings: Another row of this transaction was rejected, so none of it was imported.",
    ]],
    ["Purchase of Fictiva Liquid Fund on 5 May 2023, ₹24,998.75: the transfer into Mutual funds"],
  ]);
});

test("equal possible duplicates in two folios name their folio, not a number", async () => {
  const { run, api, data } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const purchase = scheme.transactions.find((t) => t.type === "PURCHASE");
    scheme.transactions = [purchase];
    scheme.open = "0";
    scheme.close = scheme.close_calculated = purchase.units;
    const first = { ...data.folios[0], schemes: [scheme] };
    data.folios = [first, { ...structuredClone(first), folio: "222222222" }];
    return data;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const cards = askCards(run);
  assert.equal(cards.length, 2);
  const folios = data.folios.map((f) => f.folio);
  assert.deepEqual(cards.map((card) => card.title), folios.map((folio) => `This purchase in folio ${folio} may already be in Mutual funds`));
  cards.forEach((card, i) => assert.match(card.target, new RegExp(`^Fictiva Liquid Fund, folio ${folios[i]}, purchase of ₹[\\d,.]+ on \\d+ \\w+ \\d{4}$`)));
  cards.forEach((card) => card.main.onClick());
  await run.flush();
  // Answered alike, each line names its folio, so neither name needs a number.
  const answers = askAnswers(run);
  answers.forEach((a, i) => assert.match(a.text, new RegExp(`^₹[\\d,.]+ purchase of Fictiva Liquid Fund, folio ${folios[i]} on \\d+ \\w+ \\d{4}: skipped$`)));
  assert.deepEqual(answers.map((a) => a.name), answers.map((a) => a.text));
  // Reopened, a card names its folio in its statement line as its answered line did; answered the
  // other way, the two lines still name their folios.
  answers[1].onChange();
  await run.flush();
  const [reopened] = askCards(run);
  assert.match(textOf(reopened.children), new RegExp(`^On this statement: \\d+ \\w+ \\d{4} · Purchase · Fictiva Liquid Fund, folio ${folios[1]} · `));
  reopened.other.onClick();
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text.replace(/^₹[\d,.]+ purchase of /, "").replace(/ on \d+ \w+ \d{4}/, "")), [
    `Fictiva Liquid Fund, folio ${folios[0]}: skipped`, `Fictiva Liquid Fund, folio ${folios[1]}: imported as another purchase`,
  ]);
});

test("open possible duplicates in two folios name each folio in their statement lines", async () => {
  const { run, api, data } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const purchase = scheme.transactions.find((t) => t.type === "PURCHASE");
    scheme.transactions = [purchase];
    scheme.open = "0";
    scheme.close = scheme.close_calculated = purchase.units;
    const first = { ...data.folios[0], schemes: [scheme] };
    data.folios = [first, { ...structuredClone(first), folio: "222222222" }];
    return data;
  } });
  // Wealthfolio flags both folios' purchases: two questions, one per folio.
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  const lines = askCards(run).map((card) => textOf(card.children).split("Already in")[0]);
  assert.deepEqual(lines.map((line) => line.replace(/ · [\d,.]+ units · ₹[\d,.]+$/, "").replace(/\d+ \w+ \d{4}/, "<day>")),
    data.folios.map((f) => `On this statement: <day> · Purchase · Fictiva Liquid Fund, folio ${f.folio}`));
});

test("two transaction accounts of one name are told apart in Save to, the duplicate cards and the bar", async () => {
  const { run, props, api } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    scheme.transactions = [scheme.transactions.find((t) => t.type === "PURCHASE")];
    scheme.open = "0";
    scheme.close = scheme.close_calculated = scheme.transactions[0].units;
    data.folios = [{ ...data.folios[0], schemes: [scheme] }];
    return data;
  } });
  props.accounts = props.allAccounts = [
    ...ACCOUNTS.map((a) => (a.id === "other" ? { ...a, name: "Mutual funds", accountNumber: "1234 7310" } : a.id === "mf" ? { ...a, accountNumber: "5678 4821" } : a)),
  ];
  api.activities.checkImport = async (rows) => rows.map((r) => r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  // The select lists both with what tells them apart, and Same as above says which is chosen.
  const box = saveTo(run);
  assert.deepEqual([...box.labels.values()].filter((l) => l.text.startsWith("Mutual funds")).map((l) => [l.text, l.option]), [
    ["Mutual funds (ending 4821)", "Mutual funds (ending 4821) · INR"], ["Mutual funds (ending 7310)", "Mutual funds (ending 7310) · INR"],
  ]);
  const [card] = askCards(run);
  assert.equal(card.title, "This purchase may already be in Mutual funds (ending 4821)");
  assert.match(textOf(card.children), /Already in Mutual funds \(ending 4821\): /);
  card.other.onClick();
  await run.flush();
  assert.ok(footer(run).some((line) => line.includes("Mutual funds (ending 4821)")), footer(run).join(" | "));
});

test("a zero-send plan still opens the read-only transaction table", async () => {
  const { run, api } = setup({ entries: [] });
  api.activities.checkImport = async (rows) => rows.map((r) => ({ ...r, duplicateOfId: "previous" }));
  await run.flush();
  // Every transaction may be a duplicate: more than three go under one heading, and each waits for an answer.
  const group = nodes(run.tree).find((node) => node.type === "h4" && /^\d+ transactions may already be in Mutual funds$/.test(textOf(node)));
  assert.ok(group, "grouped under one heading");
  assert.ok(askCards(run).every((card) => card.level === 5));
  while (askCards(run).length) {
    askCards(run)[0].main.onClick();
    await run.flush();
  }
  assert.match(textOf(find(run, "Footer").lines), /\d+ possible duplicates skipped by your answer\./);
  assert.equal(find(run, "Footer").action.label, "Finish");
  const see = nodes(find(run, "Footer").lines).find((node) => node.props?.children === "See every transaction");
  assert.ok(see);
  see.props.onClick();
  await run.flush();
  assert.ok(find(run, "ActivityTable").plan.length > 0);
});

test("the first announcement counts bank and account questions; with questions under Save to, the questions section is named for its own", async () => {
  const { run, props, keys } = setup({ remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "1 question for you: the payment check.");
  // Keep the purchase check, with an account question in the other folio and a fund question here.
  saveTo(run).onChange(keys.testbridge, "");
  props.unavailable[choices.bankKey(keys.testbridge)] = { name: "Missing bank" };
  const fund = props.data.folios[0].schemes.find((s) => !s.scheme.includes("Liquid"));
  delete props.fundChoices[choices.fundKey(fund)];
  saveTo(run).onChange(keys.fictiva, "mf");
  await run.flush();
  // The other imported funds still provide the bank check. The count says what it includes; the
  // questions section counts only its own card.
  const heading = nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n)));
  assert.equal(textOf(heading), "Fund questions · 1 of 1 left");
  const button = nodes(run.tree).find((n) => n.type?.name === "Button" && /^\d+ questions?/.test(textOf(n)));
  assert.equal(textOf(button), "3 questions: the account choice, the payment check and 1 fund question");
  assert.deepEqual(footer(run), ["3 questions left: the account choice, the payment check and 1 fund question before importing."]);
});

test("with an account to choose and fund questions, every count says the account choice is in it", async () => {
  // An account that tracks transactions, none chosen yet, and two funds to match.
  const { run, props, data } = setup({ remembered: {} });
  for (const scheme of data.folios.flatMap((f) => f.schemes).filter((s) => !s.scheme.includes("Liquid")).slice(0, 2)) {
    delete props.fundChoices[choices.fundKey(scheme)];
  }
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
  assert.equal(saveTo(run).values[choices.panKey("ABCDE1234F")], null);
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "3 questions for you: the account choice and 2 fund questions.");
  const heading = nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n)));
  assert.equal(textOf(heading), "Fund questions · 2 of 2 left");
  const button = nodes(run.tree).find((n) => n.type?.name === "Button" && /^\d+ questions?/.test(textOf(n)));
  assert.equal(textOf(button), "3 questions: the account choice and 2 fund questions");
  assert.deepEqual(footer(run), ["3 questions left: the account choice and 2 fund questions before importing."]);
  // Once the account is chosen, the questions section has every open question again.
  saveTo(run).onChange(choices.panKey("ABCDE1234F"), "mf");
  await run.flush();
  assert.equal(textOf(nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n)))), "Questions for you · 2 of 2 left");
  assert.equal(textOf(nodes(run.tree).find((n) => n.type?.name === "Button" && /^\d+ questions?/.test(textOf(n)))), "2 questions");
  assert.deepEqual(footer(run), ["2 questions left before importing."]);
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
    const cards = askCards(run);
    assert.equal(cards.length, 1);
    cards[0].other.onClick();
    await run.flush();
    const rows = find(run, "FundsReadyTable").rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.group.forced, 1);
      assert.equal(row.unitsAfter, row.group.accountId === "other" ? "15.000" : "5.000");
      assert.ok(row.note.endsWith(`Includes another gift ${row.group.accountId === "other" ? "received" : "given"} you chose.`), row.note);
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
  assert.equal(status(), "AMFI added: 1 fund matched. 1 question remains: the payment check.");
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

test("an old duplicate answer cannot force a row already imported into a newly chosen account", async () => {
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
  const cards = askCards(run);
  assert.equal(cards.length, 1);
  cards[0].other.onClick();
  await run.flush();
  saveTo(run).onChange(keys.pan, "other");
  await run.flush();
  assert.deepEqual([askCards(run).length, askAnswers(run).length], [0, 0]);
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

for (const changed of ["account", "fund", "matched activity"]) {
  test(`possible duplicates need fresh answers after the ${changed} changes`, async () => {
    const { run, props, api, keys } = setup({ entries: [] });
    api.activities.checkImport = async (rows) => rows.map((r) => r.symbol?.startsWith("INFZ90K01LQ6") && r.activityType === "BUY"
      ? { ...r, duplicateOfId: `previous-${r.accountId}-${r.symbol}` } : r);
    await run.flush();
    for (const card of askCards(run)) card.other.onClick();
    await run.flush();
    assert.equal(askAnswers(run).length, 2);
    const before = api.activities.checkImport;
    // Opened again, Wealthfolio's check flags other activities.
    const checked = changed === "matched activity"
      ? async (rows) => (await before(rows)).map((r) => (r.duplicateOfId ? { ...r, duplicateOfId: `${r.duplicateOfId}-another` } : r))
      : before;
    let finish;
    api.activities.checkImport = (rows) => new Promise((resolve) => { finish = async () => resolve(await checked(rows)); });
    if (changed === "account") saveTo(run).onChange(keys.pan, "other");
    else if (changed === "fund") {
      const ready = find(run, "FundsReadyTable");
      const row = ready.rows.find((r) => r.fund.symbol === "INFZ90K01LQ6");
      ready.handlers.onChange(row);
      await run.flush();
      const panel = find(run, "FundsReadyTable").handlers.changePanel(row);
      nodes(panel).find((node) => node.type?.name === "Picker").props.onUse({ ...row.fund, symbol: "INFZ90K01LQ6-NEW" });
    } else {
      props.visit = {};
      saveTo(run).onChange(keys.pan, "mf");
    }
    await run.flush();
    assert.ok(askCards(run).every((c) => c.disabled), "old evidence cannot be answered while the new plan waits");
    for (const card of askCards(run)) card.other.onClick();
    await run.flush();
    finish();
    await run.flush();
    assert.equal(askAnswers(run).length, 0);
    assert.equal(askCards(run).length, 2);
    assert.equal(find(run, "Footer").action.disabled, true);
    assert.equal(find(run, "TransactionsSummary").breakdown.duplicates, 2);
  });
}

/** Opens a ready fund's Change, by its symbol, and returns its panel and row. */
async function openChange(run, symbol) {
  const row = find(run, "FundsReadyTable").rows.find((r) => r.fund.symbol === symbol);
  find(run, "FundsReadyTable").handlers.onChange(row);
  await run.flush();
  return { panel: find(run, "FundsReadyTable").handlers.changePanel(row), row };
}
/** Uses another listing for a ready fund through its Change. */
async function changeListing(run, symbol) {
  const { panel, row } = await openChange(run, symbol);
  nodes(panel).find((node) => node.type?.name === "Picker").props.onUse({ ...row.fund, symbol: `${symbol}-NEW` });
}
const corporateBond = (props) => choices.fundKey(props.data.folios[1].schemes.find((s) => s.scheme.includes("Corporate Bond")));
// Each change, what it needs before the review starts, and which answered questions it opens again.
// Fictiva Liquid Fund and Fictiva Balanced Advantage Fund are in folio 91234567, Testbridge's funds in 1040012345.
const ANSWER_CHANGES = {
  "confirming another fund": {
    start: ({ props }) => delete props.fundChoices[corporateBond(props)],
    act: ({ run }) => find(run, "QuestionCard").onAnswer({ fund: {
      symbol: "INFZ91T01CB6", exchangeMic: "XBOM", quoteCcy: "INR", name: "Corporate Bond", instrumentType: "MUTUALFUND", providerId: "YAHOO",
    } }),
    reopens: [],
  },
  "AMFI confirming another fund": {
    start: ({ props }) => delete props.fundChoices[corporateBond(props)],
    act: ({ run, props, api }) => {
      const name = props.data.folios[1].schemes.find((s) => s.scheme.includes("Corporate Bond")).scheme;
      api.market.searchTicker = async () => [{ symbol: "123456", longName: name, currency: "INR", quoteType: "MUTUALFUND", providerId: "AMFI" }];
      run.update({ amfi: { status: "on", searches: 1 } });
    },
    reopens: [],
  },
  "another listing for another fund": { act: ({ run }) => changeListing(run, "TONDG"), reopens: [] },
  "Skip this fund for another fund": {
    act: async ({ run }) => {
      const { panel } = await openChange(run, "TONDG");
      nodes(panel).find((node) => node.props?.["aria-label"]?.startsWith("Skip this fund:")).props.onClick();
    },
    reopens: [],
  },
  "opening Change alone": { act: ({ run }) => openChange(run, "TONDG"), reopens: [] },
  "another folio's account": { act: ({ run, keys }) => saveTo(run).onChange(keys.testbridge, "other"), reopens: [] },
  "another folio not imported": { act: ({ run, keys }) => saveTo(run).onChange(keys.testbridge, choices.LEFT_OUT), reopens: [] },
  "another folio's bank account": { act: ({ run, keys }) => saveTo(run).onChange(choices.bankKey(keys.testbridge), "bank"), reopens: [] },
  "opening the page again": { act: ({ run }) => run.update({ visit: {} }), reopens: [] },
  "a bank entry changed at Import": {
    remembered: () => ({ [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" }),
    entries: ENTRIES,
    act: async ({ run, keys, activities, imported }) => {
      checksUnder(run, choices.bankKey(keys.pan))[0].onLink();
      await run.flush();
      const index = activities.findIndex((a) => a.id === "dividend");
      activities[index] = { ...activities[index], amount: "1" };
      find(run, "Footer").action.onClick();
      await run.flush();
      assert.equal(imported.length, 0);
      assert.match(textOf(run.tree), /Nothing was imported: bank entries you chose changed/);
    },
    reopens: [],
  },
  "its own folio's account": { act: ({ run, keys }) => saveTo(run).onChange(keys.fictiva, "other"), reopens: ["Balanced", "purchase", "switch in"] },
  // A switch in has no bank side, so its rows stay as they were.
  "its own folio's bank account": { act: ({ run, keys }) => saveTo(run).onChange(choices.bankKey(keys.fictiva), "bank"), reopens: ["Balanced", "purchase"] },
  "the duplicates' own fund": { act: ({ run }) => changeListing(run, "INFZ90K01LQ6"), reopens: ["purchase", "switch in"] },
  "the unbalanced fund's own fund": { act: ({ run }) => changeListing(run, "INFZ90K01BA1"), reopens: ["Balanced"] },
  "Wealthfolio's activity matching one duplicate": {
    act: ({ run, api }) => {
      const checked = api.activities.checkImport;
      api.activities.checkImport = async (rows) => (await checked(rows)).map((r) => (r.duplicateOfId && r.date === "2023-05-05" ? { ...r, duplicateOfId: "another" } : r));
      run.update({ visit: {} });
    },
    reopens: ["purchase"],
  },
};
for (const [change, { start, act, reopens, remembered, entries = [] }] of Object.entries(ANSWER_CHANGES)) {
  test(`answered possible duplicates and "don't add up" questions open again only for their own evidence: ${change}`, async () => {
    const review = setup({ entries, remembered: remembered?.(), change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    const { run, api } = review;
    api.activities.checkImport = async (rows) => rows.map((r) => r.symbol?.startsWith("INFZ90K01LQ6") && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
    start?.(review);
    await run.flush();
    const card = (part) => askCards(run).find((c) => c.title.includes(part));
    card("don't add up").other.onClick();
    await run.flush();
    card("This purchase").main.onClick();
    await run.flush();
    card("This switch in").other.onClick();
    await run.flush();
    const answered = askAnswers(run).map((a) => a.text);
    assert.equal(answered.length, 3);
    assert.deepEqual(askCards(run), []);
    await act(review);
    await run.flush();
    if (change === "AMFI confirming another fund") {
      assert.equal(find(run, "QuestionCard"), undefined);
      const matched = find(run, "FundsReadyTable").rows.find((r) => r.fund.symbol === "123456");
      assert.equal(matched?.by, "auto");
      assert.equal(matched?.fund.providerId, "AMFI");
      assert.ok(matched.items.some((i) => i.key === corporateBond(review.props)));
    }
    const titles = askCards(run).map((c) => c.title);
    assert.deepEqual(reopens.map((part) => titles.filter((t) => t.includes(part)).length), reopens.map(() => 1), titles.join(" | "));
    assert.equal(titles.length, reopens.length, titles.join(" | "));
    assert.ok(askCards(run).every((c) => !c.disabled));
    const kept = answered.filter((text) => !reopens.some((part) => text.includes(part)));
    assert.deepEqual(askAnswers(run).map((a) => a.text), kept);
    const b = find(run, "TransactionsSummary").breakdown;
    assert.equal(b.importedDuplicates, kept.some((t) => t.includes("switch in")) ? 1 : 0);
    assert.equal(b.skippedDuplicates, kept.some((t) => t.includes("purchase")) ? 1 : 0);
  });
}

test("answers a plan dropped for their folio's other account don't come back with its account", async () => {
  const { run, api, keys } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  api.activities.checkImport = async (rows) => rows.map((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  askCards(run)[0].main.onClick();
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual([askAnswers(run).length, askCards(run).length], [3, 0]);
  saveTo(run).onChange(keys.pan, "other");
  await run.flush();
  assert.deepEqual([askAnswers(run).length, askCards(run).length], [0, 3]);
  saveTo(run).onChange(keys.pan, "mf");
  await run.flush();
  assert.deepEqual([askAnswers(run).length, askCards(run).length], [0, 3]);
  assert.equal(find(run, "Footer").action.disabled, true);
});

for (const state of ["pending", "failed"]) {
  test(`answers count again when their folio's account changes back before a plan shows the change (${state})`, async () => {
    const { run, api, keys, imported } = setup({ entries: [], change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    api.activities.checkImport = async (rows) => rows.map((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
    await run.flush();
    const card = (part) => askCards(run).find((c) => c.title.includes(part));
    card("don't add up").other.onClick();
    await run.flush();
    card("This purchase").main.onClick();
    await run.flush();
    card("This switch in").other.onClick();
    await run.flush();
    const answered = askAnswers(run).map((a) => a.text);
    assert.equal(answered.length, 3);
    let reject;
    const check = api.activities.checkImport;
    api.activities.checkImport = () => new Promise((resolve, fail) => { reject = fail; });
    saveTo(run).onChange(keys.fictiva, "other");
    // On other evidence, before and after effects, no answer shows or counts.
    const away = () => {
      assert.deepEqual([askCards(run).length, askAnswers(run).length], [0, 0]);
      assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced, []);
      assert.equal(find(run, "TransactionsSummary"), undefined);
      assert.equal(find(run, "Footer").action.disabled, true);
    };
    run.render();
    away();
    await run.flush();
    away();
    if (state === "failed") {
      reject(new Error("made-up plan failure"));
      await run.flush();
      away();
      assert.match(footer(run)[0], /We couldn't work out/);
    }
    api.activities.checkImport = check;
    saveTo(run).onChange(keys.fictiva, "mf");
    // Back to what they were given for, which no plan showed changed, the answers count again.
    run.render();
    assert.deepEqual(askAnswers(run).map((a) => a.text), answered);
    await run.flush();
    assert.deepEqual(askAnswers(run).map((a) => a.text), answered);
    assert.deepEqual(askCards(run), []);
    const b = find(run, "TransactionsSummary").breakdown;
    assert.deepEqual([b.duplicates, b.skippedDuplicates, b.importedDuplicates, b.unbalanced], [0, 1, 1, 0]);
    find(run, "Footer").action.onClick();
    await run.flush();
    const rows = imported.flat();
    assert.deepEqual(rows.filter((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY").map((r) => r.date.slice(0, 10)), ["2024-06-20"]);
    assert.ok(rows.some((r) => r.symbol === "INFZ90K01BA1"));
  });
}

test("confirming Testbridge Corporate Bond Fund keeps the issue's two skipped duplicates, and the bar offers to import", async () => {
  const review = setup({ entries: [] });
  const { run, props, api } = review;
  delete props.fundChoices[corporateBond(props)];
  api.activities.checkImport = async (rows) => rows.map((r) => r.symbol === "INFZ90K01LQ6" && r.activityType === "BUY" ? { ...r, duplicateOfId: "previous" } : r);
  await run.flush();
  for (const card of askCards(run)) card.main.onClick();
  await run.flush();
  ANSWER_CHANGES["confirming another fund"].act(review);
  await run.flush();
  assert.equal(footer(run)[0], "Import 11 transactions for 4 funds into Mutual funds.");
  assert.ok(footer(run).some((line) => line.includes("2 possible duplicates skipped by your answer")));
});

test("a duplicate bank entry names the bank account in its question and evidence", async () => {
  const { run, api, keys } = setup({ entries: [entry("bank-match", "WITHDRAWAL", "25001.15", "2023-05-05", null)] });
  api.activities.checkImport = async (rows) => rows.map((r) => r.accountId === "bank" && r.date === "2023-05-05"
    ? { ...r, duplicateOfId: "bank-match" } : r);
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  const card = askCards(run).find((c) => c.title === "The bank entry for this purchase may already be in Savings");
  assert.ok(card);
  const evidence = nodes(card.children).filter((n) => n.type === "p").map(textOf);
  assert.match(evidence[1], /^Already in Savings: .* · Withdrawal · ₹25,001\.15 · entered by hand$/);
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
  assert.equal(nodes(run.tree).find((node) => node.props?.role === "status").props.children, "AMFI added: 1 fund matched. 1 question remains: the payment check.");
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

/** Clicks the Change beside a fund skipped because its rows don't add up under Not included, by its folio's text. */
const changeUnbalanced = (run, match = /./) => {
  const change = notIncludedChanges(run).find(({ name }) => name.endsWith("transactions don't add up") && match.test(name));
  assert.ok(change);
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  change.click();
  return focused;
};

test("Change beside a fund skipped because its rows don't add up opens that question again, even when it has no meaningful rows", async () => {
  for (const noRows of [false, true]) {
    const { run, remembers } = setup({ entries: [], change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      data.folios = [{ ...data.folios[0], schemes: [scheme] }];
      if (noRows) { scheme.transactions = []; scheme.close_calculated = "0"; }
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    await run.flush();
    const [card] = askCards(run);
    assert.equal(card.title, "Fictiva Liquid Fund's transactions don't add up");
    assert.match(nodes(card.children).map((n) => n.props?.children).join(""), /^They add up to [\d,.]+ units; the statement says [\d,.]+\. A row may be missing or misread\.$/);
    card.main.onClick();
    await run.flush();
    assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced.map((f) => f.name), ["Fictiva Liquid Fund"]);
    const focused = changeUnbalanced(run);
    await run.flush();
    // Its own question is open again, with the focus on it; the fund stays confirmed (#282).
    const [again] = askCards(run);
    assert.deepEqual(askCards(run).map((c) => c.title), [card.title]);
    assert.deepEqual(focused, [again.headingId]);
    assert.equal(find(run, "QuestionCard"), undefined);
    assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced, []);
    assert.deepEqual(remembers, []);
    run.dispose();
  }
});

test("Change beside one of a fund's two skipped folios opens only that folio's question again", async () => {
  const { run, data } = setup({ entries: [], change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    const first = { ...data.folios[0], schemes: [scheme] };
    data.folios = [first, { ...structuredClone(first), folio: "222222222" }];
    return data;
  } });
  await run.flush();
  askCards(run).forEach((card) => card.main.onClick());
  await run.flush();
  assert.equal(askCards(run).length, 0);
  const [first, second] = data.folios.map((folio) => folio.folio);
  // The second folio's, so it isn't just the first question with the fund's key.
  const focused = changeUnbalanced(run, new RegExp(`, folio ${second}, `));
  await run.flush();
  const [again] = askCards(run);
  assert.deepEqual(askCards(run).map((c) => c.title), [`Fictiva Liquid Fund's transactions in folio ${second} don't add up`]);
  assert.deepEqual(focused, [again.headingId]);
  assert.equal(find(run, "QuestionCard"), undefined);
  // The other folio stays skipped.
  assert.deepEqual(askAnswers(run).map((a) => a.text), [`Fictiva Liquid Fund, folio ${first}: skipped`]);
  assert.deepEqual(find(run, "NotIncludedDetailed").unbalanced.map((f) => f.name), [`Fictiva Liquid Fund, folio ${first}`]);
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
  // A narrow frame's bar keeps that line and folds the rest (#238).
  assert.equal(textOf(find(run, "Footer").narrow.brief), footer(run)[0]);
  assert.deepEqual(find(run, "Footer").narrow.more.map(textOf), footer(run).slice(1));
  const change = nodes(run.tree).find((node) => node.props?.["aria-label"]?.endsWith("nothing new") && node.props.onClick);
  // Named as its line names the fund, not by the statement's name.
  assert.equal(change.props["aria-label"], "Change: Fictiva Liquid Fund, nothing new");
  change.props.onClick();
  await run.flush();
  assert.ok(find(run, "QuestionCard"));
});

test("Nothing new's Change names the fund its line names, numbered when two funds read the same (#349)", async () => {
  // Liquid and Balanced Advantage, with no transactions and the units Wealthfolio has, each confirmed
  // as a listing with one name that isn't the statement's.
  const review = async () => {
    const context = setup({ entries: [], change(data) {
      const funds = data.folios[0].schemes.filter((s) => /Liquid|Balanced/.test(s.scheme));
      for (const s of funds) Object.assign(s, { transactions: [], open: "10", close: "10", close_calculated: "10" });
      data.folios = [{ ...data.folios[0], schemes: funds }];
      return data;
    } });
    const { props, data, activities, profiles } = context;
    for (const scheme of data.folios[0].schemes) {
      props.fundChoices[choices.fundKey(scheme)].fund.name = "Shared Listing Fund";
      profiles[`asset-${scheme.isin}`] = { instrumentSymbol: scheme.isin, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
      activities.push({
        id: `held-${scheme.isin}`, accountId: "mf", activityType: "BUY", subtype: null, status: "POSTED", date: "2023-03-01T00:00:00Z", quantity: "10",
        unitPrice: "50", amount: "500", fee: null, tax: null, currency: "INR", needsReview: false, comment: null, assetId: `asset-${scheme.isin}`,
        assetSymbol: scheme.isin, sourceRecordId: null,
      });
    }
    await context.run.flush();
    return context;
  };
  const changes = (run) => nodes(run.tree).filter((node) => node.props?.["aria-label"]?.endsWith("nothing new") && node.props.onClick);
  // Each opens its own fund in a fresh review.
  for (const i of [0, 1]) {
    const { run, data } = await review();
    const buttons = changes(run);
    assert.deepEqual(textOf(run.tree).match(/Nothing new for [^.]*\./g), ["Nothing new for Shared Listing Fund.", "Nothing new for Shared Listing Fund."]);
    assert.deepEqual(buttons.map((node) => node.props["aria-label"]), [
      "Change: Shared Listing Fund, fund 1, nothing new",
      "Change: Shared Listing Fund, fund 2, nothing new",
    ]);
    buttons[i].props.onClick();
    await run.flush();
    assert.equal(find(run, "QuestionCard").item.key, choices.fundKey(data.folios[0].schemes[i]));
    run.dispose();
  }
});

test("Change on a Ready row answers no question, unless its fund was asked about in this review (#291)", async () => {
  const fund = (symbol) => ({ symbol, exchangeMic: "XBOM", quoteCcy: "INR", name: `Fund ${symbol}`, instrumentType: "MUTUALFUND", providerId: "YAHOO" });
  const heading = (run) => {
    const node = nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n)));
    return node && textOf(node);
  };
  const answered = (run) => nodes(run.tree).filter((n) => n.type?.name === "AnsweredLine").map((n) => [n.props.item.key, n.props.choice.fund?.symbol]);
  const changeOnReady = async (run, key, symbol) => {
    let ready = find(run, "FundsReadyTable");
    ready.handlers.onChange(ready.rows.find((r) => r.items.some((i) => i.key === key)));
    await run.flush();
    ready = find(run, "FundsReadyTable");
    const panel = ready.handlers.changePanel(ready.rows.find((r) => r.id === ready.handlers.changing));
    nodes(panel).find((node) => node.type?.name === "Picker").props.onUse(fund(symbol));
    await run.flush();
    assert.ok(find(run, "FundsReadyTable").rows.some((r) => r.fund.symbol === symbol && r.by === "you"));
  };
  /** The review with these funds to match, once their first searches are done. */
  const review = async (asked) => {
    const { run, props } = setup({ entries: [] });
    const keys = Object.fromEntries(["Liquid", "Corporate Bond", "Overnight"]
      .map((name) => [name, Object.keys(props.fundChoices).find((key) => props.fundChoices[key].fund.name.includes(name))]));
    for (const name of asked) delete props.fundChoices[keys[name]];
    await run.flush();
    await new Promise((resolve) => setTimeout(resolve, 70));
    await run.flush();
    return { run, keys };
  };

  // With no questions, a fund changed in its Ready row adds no Questions for you.
  const first = await review([]);
  assert.equal(heading(first.run), undefined);
  await changeOnReady(first.run, first.keys.Liquid, "LIQUID-NEW");
  assert.equal(heading(first.run), undefined);
  assert.deepEqual(answered(first.run), []);
  let ready = find(first.run, "FundsReadyTable");
  ready.handlers.onChange(ready.rows.find((r) => r.items.some((i) => i.key === first.keys.Liquid)));
  await first.run.flush();
  ready = find(first.run, "FundsReadyTable");
  nodes(ready.handlers.changePanel(ready.rows.find((r) => r.id === ready.handlers.changing)))
    .find((n) => n.props?.["aria-label"]?.startsWith("Skip this fund:")).props.onClick();
  await first.run.flush();
  assert.equal(heading(first.run), undefined);
  assert.deepEqual(answered(first.run), []);
  assert.ok(!find(first.run, "FundsReadyTable").rows.some((r) => r.items.some((i) => i.key === first.keys.Liquid)));
  const { NotIncludedDetailed } = await server.ssrLoadModule("/src/components/review/detailed-parts.tsx");
  const skipped = nodes(NotIncludedDetailed(find(first.run, "NotIncludedDetailed")))
    .find((n) => n.props?.["aria-label"]?.startsWith("Change: Fictiva Liquid") && n.props["aria-label"].endsWith(", skipped"));
  assert.ok(skipped, "a row skipped through Change can be changed again under Not included");
  skipped.props.onClick();
  await first.run.flush();
  assert.equal(heading(first.run), "Questions for you · 1 of 1 left");
  find(first.run, "QuestionCard").onAnswer({ fund: fund("LIQUID-RESTORED") });
  await first.run.flush();
  assert.deepEqual(answered(first.run), [[first.keys.Liquid, "LIQUID-RESTORED"]]);
  assert.ok(find(first.run, "FundsReadyTable").rows.some((r) => r.fund.symbol === "LIQUID-RESTORED" && r.by === "you"));
  first.run.dispose();

  // With questions open, it doesn't count as one of them.
  const { run, keys } = await review(["Corporate Bond", "Overnight"]);
  assert.equal(heading(run), "Questions for you · 2 of 2 left");
  await changeOnReady(run, keys.Liquid, "LIQUID-NEW");
  assert.equal(heading(run), "Questions for you · 2 of 2 left");
  assert.deepEqual(answered(run), []);
  // A fund that was asked about keeps its answered line, with the new choice, when changed again in its Ready row.
  find(run, "QuestionCard").onAnswer({ fund: fund("CORPORATE") });
  await run.flush();
  assert.equal(heading(run), "Questions for you · 1 of 2 left");
  assert.deepEqual(answered(run), [[keys["Corporate Bond"], "CORPORATE"]]);
  await changeOnReady(run, keys["Corporate Bond"], "CORPORATE-NEW");
  await changeOnReady(run, keys.Liquid, "LIQUID-NEWER");
  assert.equal(heading(run), "Questions for you · 1 of 2 left");
  assert.deepEqual(answered(run), [[keys["Corporate Bond"], "CORPORATE-NEW"]]);
  find(run, "QuestionCard").onAnswer({ leftOut: true });
  await run.flush();
  assert.equal(heading(run), "Questions for you");
  assert.ok(nodes(run.tree).some((n) => n.type === "span" && n.props.children === "Both questions answered."));
  assert.deepEqual(answered(run).map(([key]) => key), [keys["Corporate Bond"], keys.Overnight]);
});

test("a fund asked about, then left out with its folio and included again, is a change on its row again (#291)", async () => {
  const { run, props, profiles, keys } = setup({ entries: [] });
  const [key, choice] = Object.entries(props.fundChoices).find(([, c]) => c.fund.name.includes("Liquid"));
  // A remembered asset Wealthfolio can't use asks about the fund again.
  choice.fund.assetId = "missing-type";
  profiles["missing-type"] = { instrumentSymbol: choice.fund.symbol, instrumentExchangeMic: "XBOM" };
  await run.flush();
  nodes(run.tree).find((node) => node.props?.["aria-label"]?.startsWith("Change: Fictiva Liquid") && node.props.onClick).props.onClick();
  await run.flush();
  const { assetId, ...replacement } = choice.fund;
  find(run, "QuestionCard").onAnswer({ fund: replacement });
  await run.flush();
  const answered = () => nodes(run.tree).filter((n) => n.type?.name === "AnsweredLine").map((n) => n.props.item.key);
  assert.deepEqual(answered(), [key]);
  // Wealthfolio's asset is fixed meanwhile. Leaving the folio out drops the answer, so the remembered
  // asset is back, and Change on its row is a change there.
  profiles["missing-type"].instrumentType = "MUTUALFUND";
  saveTo(run).onChange(keys.fictiva, choices.LEFT_OUT);
  await run.flush();
  props.visit = {};
  saveTo(run).onChange(keys.fictiva, "");
  await run.flush();
  let ready = find(run, "FundsReadyTable");
  assert.equal(ready.rows.find((r) => r.items.some((i) => i.key === key)).fund.assetId, "missing-type");
  ready.handlers.onChange(ready.rows.find((r) => r.items.some((i) => i.key === key)));
  await run.flush();
  ready = find(run, "FundsReadyTable");
  nodes(ready.handlers.changePanel(ready.rows.find((r) => r.id === ready.handlers.changing)))
    .find((node) => node.type?.name === "Picker").props.onUse({ ...replacement, symbol: "LIQUID-NEW" });
  await run.flush();
  assert.ok(find(run, "FundsReadyTable").rows.some((r) => r.fund.symbol === "LIQUID-NEW"));
  assert.deepEqual(answered(), []);
  assert.equal(nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n))), undefined);
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
  assert.ok(labels.every((label) => /in Mutual funds \(account [12]\)$/.test(label)), labels.join("; "));
});

test("a payment check of two says both: in its answer, the announcement and the footer", async () => {
  for (const linked of [true, false]) {
    const { run, keys } = setup({
      entries: [entry("first", "WITHDRAWAL", "1000", "2024-05-01", "FICTIVA MF"), entry("second", "WITHDRAWAL", "2000", "2024-05-05", "FICTIVA MF")],
      remembered: { [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank" },
      change(data) {
        const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
        const scheme = (date, amount) => ({ ...structuredClone(liquid), open: "0", close: "10", close_calculated: "10", transactions: [{
          date, type: "PURCHASE", amount, units: "10", nav: String(Number(amount) / 10), balance: "10", description: "Purchase", dividend_rate: null, gift_folio: null,
        }] });
        const first = { ...data.folios[0], schemes: [scheme("2024-05-01", "1000")] };
        data.folios = [first, { ...structuredClone(first), folio: "222222222", schemes: [scheme("2024-05-05", "2000")] }];
        return data;
      },
    });
    await run.flush();
    let [check] = checksUnder(run, choices.bankKey(keys.pan));
    assert.equal(check.ticked.size, 2);
    if (linked) check.onLink();
    else check.onNone();
    await run.flush();
    [check] = checksUnder(run, choices.bankKey(keys.pan));
    assert.equal(check.answered, linked ? 2 : 0);
    const receipt = linked ? "Both payments linked to entries already in Savings" : "Not linked: both payments get new transfers from Savings";
    const answer = markup(nodes(saveTo(run).checks(choices.bankKey(keys.pan))).find((node) => node.type?.name === "BankCheck"));
    assert.ok(answer.includes(`>${receipt}<`), answer);
    assert.match(await announced(run), new RegExp(`^${receipt}\\. All questions answered\\.`));
    const movements = linked ? "both use entries already there" : "2 get new transfers";
    assert.ok(footer(run).includes(`ANANYA R TESTWALA's purchases transfer from Savings: ${movements}.`), footer(run).join("; "));
    run.dispose();
  }
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
    const { run, props, keys, api, activities, imported } = setup({ entries: [structuredClone(ENTRIES[1])], remembered: {
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
    if (change === "amount") {
      assert.ok(warning.includes("The withdrawal of ₹25,000 on 4 May 2023 in Savings (NEFT FICTIVA MF), chosen for the purchase of Fictiva Liquid Fund on 5 May 2023, " +
        "is now a withdrawal of ₹24,998.75 on 4 May 2023."), warning);
    }
    // The warning showed the new details; a second Import can proceed without a warning loop.
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(imported.length, 1);
    assert.equal(updates.length, 1);
    run.dispose();
  }
});

for (const [timeZone, date, sourceSystem, day] of [
  // Made in Wealthfolio's form at 02:00 on 4 May in India, stored on 3 May in UTC.
  ["Asia/Kolkata", "2023-05-03T20:30:00+00:00", "MANUAL", "4 May 2023"],
  // Made in Wealthfolio's form at 21:00 on 4 May in Toronto, stored on 5 May in UTC.
  ["America/Toronto", "2023-05-05T01:00:00+00:00", "MANUAL", "4 May 2023"],
  // Imported from a bank statement at UTC midnight on 6 May, 20:00 on 5 May in Toronto.
  ["America/Toronto", "2023-05-06T00:00:00+00:00", "CSV", "6 May 2023"],
]) test(`a bank entry is offered, linked and retried on its day in Wealthfolio's timezone (${timeZone}, ${sourceSystem})`, async () => {
  const withdrawal = { ...entry("neft", "WITHDRAWAL", "25000.00", "2023-05-04", "NEFT FICTIVA MF"), date, sourceSystem, isUserModified: false };
  const { run, api, keys, activities } = setup({ entries: [withdrawal], remembered: withSavings() });
  api.settings.get = async () => ({ timezone: timeZone });
  const getAll = api.activities.getAll;
  api.activities.getAll = async (id) => (await getAll(id)).map((row) => ({ ...row }));
  api.activities.create = async (row) => {
    const transfer = { ...row, id: "fund-transfer", date: row.activityDate, status: "POSTED", assetId: "", assetSymbol: "", sourceSystem: "MANUAL" };
    activities.push(transfer);
    return transfer;
  };
  // Changing an entry marks it as edited, as Wealthfolio does; linking fails the first time.
  api.activities.update = async (row) => void Object.assign(activities.find((a) => a.id === row.id), { activityType: row.activityType, isUserModified: true });
  let linkFails = true;
  api.activities.linkTransfer = async () => { if (linkFails) throw new Error("made-up link failure"); };
  api.spending.unassignCategory = async () => {};
  await run.flush();
  // One day from the purchase of 5 May: ticked.
  const [node] = checkNodes(run, choices.bankKey(keys.pan));
  const [pair] = node.props.check.pairs;
  assert.deepEqual([pair.days, pair.strong, pair.reason], [1, true, "1 day apart · names the fund house"]);
  assert.ok(shownPairs(node)[0].name.includes(`Savings: NEFT FICTIVA MF · ${day} · −₹25,000`), shownPairs(node)[0].name);
  node.props.onLink();
  await run.flush();
  // Rechecks and retries keep the reviewed timezone even if the setting changes.
  api.settings.get = async () => ({ timezone: "UTC" });
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), ["link"]);
  // A revisit invalidates current; the result and retry still have the review's day and timezone.
  run.update({ visit: {} });
  await run.flush();
  const purchase = "the purchase of Fictiva Liquid Fund on 5 May 2023";
  const failed = shownResult(run);
  assert.ok(failed.lines.some((line) => line.includes(`the bank entry of ${day} wasn't linked.`)), failed.lines.join(" | "));
  assert.ok(failed.buttons.includes(`Try again: link the bank entry of ${day} with ${purchase}`), failed.buttons.join(" | "));
  // The retry finds the entry as this import changed it: a transfer, marked as edited, on the same day.
  linkFails = false;
  const result = find(run, "ImportResult");
  result.onRetryLink(result.links[0]);
  await run.flush();
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), [undefined]);
  assert.equal(await announced(run), `The bank entry of ${day} is linked.`);
  assert.ok(shownResult(run).lines.includes(
    `The withdrawal of ₹25,000 on ${day} in Savings (NEFT FICTIVA MF), for ${purchase}: Any split it had across spending categories was deleted.`,
  ), shownResult(run).lines.join(" | "));
});

test("a bank entry moved to another day in Wealthfolio's timezone, though not in UTC, stops the import", async () => {
  // Made in Wealthfolio's form at 02:00 on 4 May in India, then moved to 23:00 on 3 May: 3 May in UTC both times.
  const withdrawal = { ...entry("neft", "WITHDRAWAL", "25000.00", "2023-05-04", "NEFT FICTIVA MF"), date: "2023-05-03T20:30:00+00:00", sourceSystem: "MANUAL" };
  const { run, api, keys, activities, imported } = setup({ entries: [withdrawal], remembered: withSavings() });
  api.settings.get = async () => ({ timezone: "Asia/Kolkata" });
  await run.flush();
  checksUnder(run, choices.bankKey(keys.pan))[0].onLink();
  await run.flush();
  activities[0] = { ...activities[0], date: "2023-05-03T17:30:00+00:00", isUserModified: true };
  let finish;
  api.settings.get = () => new Promise((resolve) => { finish = () => resolve({ timezone: "UTC" }); });
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(typeof finish, "function", "the stale alert is checked while re-planning waits");
  assert.equal(imported.length, 0);
  const warning = textOf(run.tree);
  assert.match(warning, /Nothing was imported: bank entries you chose changed/);
  assert.ok(warning.includes("The withdrawal of ₹25,000 on 4 May 2023 in Savings (NEFT FICTIVA MF), chosen for the purchase of Fictiva Liquid Fund on 5 May 2023, " +
    "is now a withdrawal of ₹25,000 on 3 May 2023."), warning);
  finish();
  await run.flush();
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
    if (reason === "unbalanced") {
      // Asked first: skipping it leaves it out.
      assert.match(textOf(run.tree), /1 fund0 ready1 question/);
      askCards(run)[0].main.onClick();
      await run.flush();
    }
    assert.match(textOf(run.tree), /1 fund0 ready1 not included/);
    assert.doesNotMatch(textOf(run.tree), /Nothing new for|Ready to import/);
    assert.equal(find(run, "TransactionsSummary").breakdown.total, 0);
    const left = find(run, "NotIncludedDetailed");
    assert.equal((reason === "earlier" ? left.earlier : left.unbalanced).length, 1);
    // No transactions to point at: what's under Not included instead.
    assert.deepEqual(footer(run).slice(0, 1), ["This statement has no transactions. See what's not included above."]);
    assert.equal(find(run, "Footer").action.label, "Finish");
    run.dispose();
  }
});

test("a fund a detailed statement has no transactions for says so, under Not included and in the bar", async () => {
  const liquid = (activities) => activities.push({
    id: "hand", accountId: "mf", activityType: "BUY", subtype: null, status: "POSTED", date: "2023-03-01T00:00:00Z", quantity: "10", unitPrice: "50",
    amount: "500", fee: null, tax: null, currency: "INR", needsReview: false, comment: null, assetId: "liquid", assetSymbol: "INFZ90K01LQ6", sourceRecordId: null,
  });
  // With no rows, and with only an event, which isn't a transaction.
  for (const events of [[], [{ date: "2023-04-02", description: "Nominee registered", type: "MISC", units: null, amount: null, nav: null, balance: "10" }]]) {
    for (const held of [false, true]) {
      const { run, activities, profiles } = setup({ entries: [], change(data) {
        const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
        Object.assign(scheme, { transactions: events, open: "10", close: "10", close_calculated: "10" });
        data.folios = [{ ...data.folios[0], schemes: [scheme] }];
        return data;
      } });
      profiles.liquid = { instrumentSymbol: "INFZ90K01LQ6", instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
      if (held) liquid(activities);
      await run.flush();
      const what = `${events.length} events, ${held ? "held" : "not held"}`;
      assert.equal(find(run, "TransactionsSummary").breakdown.total, 0, what);
      const { earlier } = find(run, "NotIncludedDetailed");
      if (held) {
        // Wealthfolio has its units: nothing new, and nothing under Not included.
        assert.deepEqual(earlier, [], what);
        assert.match(textOf(run.tree), /Nothing new for Fictiva Liquid Fund\./, what);
        assert.deepEqual(footer(run).slice(0, 1), ["Nothing new: this statement has no transactions."], what);
      } else {
        // It still needs its units, with none of its transactions waiting.
        assert.deepEqual(earlier.map(({ units, waiting, noTransactionsIn }) => ({ units, waiting, noTransactionsIn })), [{ units: "10.000 units", waiting: 0, noTransactionsIn: undefined }], what);
        assert.doesNotMatch(textOf(run.tree), /Nothing new for/, what);
        assert.deepEqual(footer(run).slice(0, 1), ["This statement has no transactions. See what's not included above."], what);
      }
      assert.equal(find(run, "Footer").action.label, "Finish", what);
      // Excluding every folio still explains that the statement has no transactions.
      saveTo(run).onChange(choices.panKey("ABCDE1234F"), choices.LEFT_OUT);
      await run.flush();
      assert.equal(find(run, "TransactionsSummary").breakdown.total, 0, what);
      assert.equal(find(run, "NotIncludedDetailed").notImported.length, 1, what);
      assert.deepEqual(footer(run).slice(0, 1), ["This statement has no transactions. See what's not included above."], what);
      assert.equal(find(run, "Footer").action.label, "Finish", what);
      run.dispose();
    }
  }
});

test("a fund with no waiting transactions names the folios or parts that have none", async () => {
  for (const sameFolio of [false, true]) {
    // Liquid's purchases in folio 91234567 / 12 go to Mutual funds, which needs none of its units;
    // folio 3301 starts with 10 units, has no transactions and goes to Other funds, which has none.
    // Or both sections share folio 3301 and go to Other funds.
    const { run } = setup({ entries: [], remembered: {
      [choices.panKey("ABCDE1234F")]: "mf",
      [choices.folioKey({ amc: fixture.folios[0].amc, folio: "3301" })]: "other",
    }, change(data) {
      const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
      const held = { ...structuredClone(liquid), open: "10", close: "10", close_calculated: "10", transactions: [] };
      data.folios = sameFolio
        ? [{ ...data.folios[0], folio: "3301", schemes: [held, liquid] }]
        : [{ ...data.folios[0], schemes: [liquid] }, { ...data.folios[0], folio: "3301", schemes: [held] }];
      return data;
    } });
    await run.flush();
    const [fund, ...others] = find(run, "NotIncludedDetailed").earlier;
    assert.deepEqual(others, []);
    assert.deepEqual([fund.units, fund.waiting, fund.noTransactionsIn, fund.accounts], ["10.000 units", 0, { folios: ["3301"], parts: sameFolio }, sameFolio ? undefined : [{ units: "10.000", account: "Other funds", folios: ["3301"] }]]);
    assert.ok(find(run, "TransactionsSummary").breakdown.toImport > 0);
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

// #351: Wealthfolio refuses a fund purchase in a credit card account, but takes a transfer to or from one.
const card = { ...account("card", "Visa card"), accountType: "CREDIT_CARD" };
/** Mutual funds, a Securities account, Savings, a Cash one, and Visa card, a credit card, all tracking transactions. */
const WITH_CARD = [{ ...account("mf", "Mutual funds"), accountType: "SECURITIES" }, { ...account("bank", "Savings"), accountType: "CASH" }, card];
/** Save to's selects by their choice's key, and its lines that ask to choose again, as shown. */
function saveToView(run) {
  const view = nodes(run.tree).find((n) => n.type?.name === "SaveToDetailed");
  const shown = nodes(view.type(view.props));
  return {
    selects: Object.fromEntries(shown.filter((n) => n.type?.name === "AccountSelect").map((n) => [n.props.id, n.props])),
    again: shown.filter((n) => n.type?.name === "ChooseAgain").map((n) => textOf(n.type(n.props))).filter(Boolean),
  };
}

test("the funds' selects leave out a credit card, which the bank selects keep (#351)", async () => {
  const { run, props, keys } = setup();
  props.accounts = props.allAccounts = WITH_CARD;
  await run.flush();
  saveTo(run).onOpen(keys.pan, true);
  await run.flush();
  const { selects, again } = saveToView(run);
  const offered = (key) => selects[key].accounts.map((a) => a.id);
  // The PAN's and a folio's funds, and the PAN's and the folio's bank accounts.
  for (const key of [keys.pan, keys.fictiva]) assert.deepEqual(offered(key), ["mf", "bank"], key);
  for (const key of [keys.pan, keys.fictiva].map(choices.bankKey)) assert.deepEqual(offered(key), ["mf", "bank", "card"], key);
  assert.deepEqual(again, []);
  assert.equal(saveTo(run).values[keys.pan], "mf");
});

test("a remembered credit card for funds asks again, saying why, while one for bank transfers is kept (#351)", async () => {
  const pan = choices.panKey("ABCDE1234F");
  const { fictiva } = keys0();
  const { run, props, keys, remembers, imported } = setup({ remembered: { [pan]: "card", [choices.bankKey(pan)]: "card", [fictiva]: "card" } });
  props.accounts = props.allAccounts = WITH_CARD;
  await run.flush();
  for (const key of [keys.pan, keys.fictiva]) {
    assert.equal(saveTo(run).values[key], null, key);
    assert.deepEqual(saveTo(run).ignored[key], { ids: ["card"], name: "Visa card", why: "is a credit card. Credit cards can't hold fund purchases" }, key);
  }
  assert.equal(saveTo(run).values[choices.bankKey(keys.pan)], "card");
  assert.equal(saveTo(run).ignored[choices.bankKey(keys.pan)], undefined);
  assert.equal(saveTo(run).remembered, "none");
  assert.deepEqual(footer(run), ["1 question left: the account choice before importing."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  const warning = "Chosen before: Visa card, which is a credit card. Credit cards can't hold fund purchases, so choose again.";
  saveTo(run).onOpen(keys.pan, true);
  await run.flush();
  assert.deepEqual(saveToView(run).again, [warning, warning]);
  // The PAN's choice leaves the folio's as it was: it's still to choose again.
  saveTo(run).onChange(keys.pan, "mf");
  await run.flush();
  assert.equal(saveTo(run).values[keys.fictiva], null);
  const { selects, again } = saveToView(run);
  assert.deepEqual(again, [warning]);
  assert.equal(selects[keys.fictiva].inherit, "Same as above (Mutual funds)");
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).onChange(keys.fictiva, "");
  await run.flush();
  assert.deepEqual(saveToView(run).again, []);
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  const bankRows = imported[0].filter((r) => r.accountId === "card");
  assert.deepEqual([...new Set(bankRows.map((r) => r.activityType))].sort(), ["TRANSFER_IN", "TRANSFER_OUT"]);
  assert.ok(bankRows.every((r) => r.symbol === ""));
  assert.deepEqual([...new Set(imported[0].filter((r) => r.accountId !== "card").map((r) => r.accountId))], ["mf"]);
  // The new choices replace the card, the folio's Same as above included.
  assert.deepEqual(new Map(remembers.at(-1).accounts), new Map([[keys.pan, "mf"], [keys.fictiva, ""]]));
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

test("Change beside a fund with rows left out names the fund its line names, numbered when two funds read the same (#349)", async () => {
  // Liquid and Balanced Advantage, each with a purchase and its reversal, which are left out, and
  // each confirmed as a listing with one name that isn't the statement's.
  const review = async () => {
    const context = setup({ entries: [], change(data) {
      const funds = data.folios[0].schemes.filter((s) => /Liquid|Balanced/.test(s.scheme));
      for (const fund of funds) {
        const row = (date, type, amount, units) => ({ ...fund.transactions[0], date, type, amount, units, description: type, balance: null });
        fund.transactions.push(row("2024-02-01", "PURCHASE", "1000.00", "0.400"), row("2024-02-03", "REVERSAL", "-1000.00", "-0.400"));
      }
      data.folios = [{ ...data.folios[0], schemes: funds }];
      return data;
    } });
    for (const scheme of context.data.folios[0].schemes) context.props.fundChoices[choices.fundKey(scheme)].fund.name = "Shared Listing Fund";
    await context.run.flush();
    return context;
  };
  const changes = (run) => notIncludedChanges(run).filter((c) => c.name.endsWith(", not included"));
  // Each opens its own fund's change in a fresh review.
  for (const i of [0, 1]) {
    const { run, data } = await review();
    const keys = data.folios[0].schemes.map((s) => choices.fundKey(s));
    const buttons = changes(run);
    assert.deepEqual(find(run, "NotIncludedDetailed").leftOut.map((f) => [f.key, f.name]), keys.map((key) => [key, "Shared Listing Fund"]));
    assert.deepEqual(buttons.map((c) => c.name), ["Change: Shared Listing Fund, fund 1, not included", "Change: Shared Listing Fund, fund 2, not included"]);
    buttons[i].click();
    await run.flush();
    const part = find(run, "NotIncludedDetailed");
    assert.deepEqual(keys.map((k) => !!part.changePanel(k)), keys.map((k) => k === keys[i]));
    run.dispose();
  }
});

/** What an import sent, as Wealthfolio returns it with the add-on's row IDs. */
const storedRows = (rows) => rows.map((r, i) => ({
  id: `stored-${i}`, accountId: r.accountId, activityType: r.activityType, subtype: r.subtype ?? null, status: "POSTED",
  date: `${r.date}T00:00:00+00:00`, quantity: r.quantity ?? null, unitPrice: r.unitPrice ?? null, amount: r.amount ?? null, fee: null,
  tax: r.tax ?? null, currency: r.currency, needsReview: false, comment: null, assetId: r.symbol ? `asset-${r.symbol}` : "",
  assetSymbol: r.symbol ?? "", exchangeMic: r.exchangeMic ?? null, sourceRecordId: `addon:cas-importer:${r.sourceRecordId}`,
}));

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
  const { run } = setup({ entries: storedRows(rows), change });
  await run.flush();
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.toImport, b.before, b.leftOut.map((l) => l.kind)], [0, 3, ["reversal", "reversal"]]);
  assert.deepEqual(footer(run).slice(0, 1), ["Nothing is ready to import. See the transactions left out or waiting above."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("a statement read again after importing a fund with its difference doesn't ask about it again, until Wealthfolio lacks one of its transactions (#348)", async () => {
  const mismatch = JSON.parse(await readFile("tests/fixtures/made-up-cas-mismatch.json", "utf8"));
  const change = () => structuredClone(mismatch);
  // The Flexi Cap fund's units from before the statement, entered by hand.
  const opening = {
    id: "flexi-opening", accountId: "mf", activityType: "BUY", subtype: null, status: "POSTED", date: "2023-03-15T00:00:00+00:00",
    quantity: "1250", unitPrice: "1", amount: "1250", fee: null, tax: null, currency: "INR", needsReview: false, comment: null,
    assetId: "asset-INFZ90K01FC8", assetSymbol: "INFZ90K01FC8", exchangeMic: "XBOM", sourceRecordId: null,
  };
  const review = async (entries) => {
    const context = setup({ entries, change });
    for (const { fund } of Object.values(context.props.fundChoices)) {
      context.profiles[`asset-${fund.symbol}`] = { instrumentSymbol: fund.symbol, instrumentExchangeMic: fund.exchangeMic, instrumentType: fund.instrumentType };
    }
    await context.run.flush();
    return context;
  };
  const counts = (run) => {
    const b = find(run, "TransactionsSummary").breakdown;
    return { toImport: b.toImport, before: b.before, unbalanced: b.unbalanced, skippedUnbalanced: b.skippedUnbalanced, duplicates: b.duplicates, leftOut: b.leftOut.map((l) => l.reason) };
  };
  const orphan = ["There's no transaction on this day to add this stamp duty to."];
  const gapCards = (run) => askCards(run).filter((c) => c.title.endsWith("don't add up"));
  const closing = /: its rows add up to 2,798\.066 units, but the statement's closing balance is 2,892\.104\. A row may be missing or misread\.$/;
  const closingLines = (run) => find(run, "StatementWarnings").lines.filter((line) => closing.test(line.text));

  // The first read asks, with the stamp duty that lost its purchase left out on its own.
  const first = await review([opening]);
  assert.deepEqual(counts(first.run), { toImport: 13, before: 0, unbalanced: 25, skippedUnbalanced: 0, duplicates: 0, leftOut: orphan });
  assert.equal(gapCards(first.run).length, 1);
  assert.deepEqual(closingLines(first.run), []);
  gapCards(first.run)[0].other.onClick();
  await first.run.flush();
  assert.deepEqual(counts(first.run), { toImport: 38, before: 0, unbalanced: 0, skippedUnbalanced: 0, duplicates: 0, leftOut: orphan });
  find(first.run, "Footer").action.onClick();
  await first.run.flush();
  const stored = storedRows(first.imported.flat());
  first.run.dispose();

  // Read again, Wealthfolio has every transaction: no question, and the difference among the warnings, once.
  const again = await review([opening, ...stored]);
  assert.deepEqual(counts(again.run), { toImport: 0, before: 38, unbalanced: 0, skippedUnbalanced: 0, duplicates: 0, leftOut: orphan });
  assert.deepEqual(askCards(again.run), []);
  assert.equal(closingLines(again.run).length, 1);
  assert.deepEqual(footer(again.run).slice(0, 1), ["Nothing is ready to import. See the transactions left out or waiting above."]);
  assert.equal(find(again.run, "Footer").action.label, "Finish");
  again.run.dispose();

  // Without one of the fund's purchases, it asks again; the transactions Wealthfolio has stay imported
  // before, and the purchase whose cash is still there isn't a possible duplicate.
  const flexiBuy = stored.find((a) => a.assetSymbol === "INFZ90K01FC8" && a.activityType === "BUY");
  const lacking = await review([opening, ...stored.filter((a) => a !== flexiBuy)]);
  assert.deepEqual(counts(lacking.run), { toImport: 0, before: 37, unbalanced: 1, skippedUnbalanced: 0, duplicates: 0, leftOut: orphan });
  assert.equal(gapCards(lacking.run).length, 1);
  assert.deepEqual(closingLines(lacking.run), []);
  gapCards(lacking.run)[0].main.onClick();
  await lacking.run.flush();
  assert.deepEqual(counts(lacking.run), { toImport: 0, before: 37, unbalanced: 0, skippedUnbalanced: 1, duplicates: 0, leftOut: orphan });
  assert.deepEqual(askCards(lacking.run), []);
  assert.equal(find(lacking.run, "Footer").action.label, "Finish");
});

test("a review that finds the transactions on refresh shows one closing warning for the accepted difference (#348)", async () => {
  const { run, activities, profiles, props, imported } = setup({ entries: [], change(data) {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const balanced = { ...structuredClone(data.folios[0]), folio: "222222222", schemes: [{ ...structuredClone(liquid), scheme: "" }] };
    liquid.scheme = "";
    liquid.close = "9.053";
    // The parser reset to 8.5 units at a printed balance before comparing the closing balance.
    liquid.transactions.at(-1).balance = "8.5";
    data.parse_warnings = ["'' [FLQDG]: closing unit balance mismatch — computed 8.5 but statement printed 9.053 (Δ=-0.553); a transaction row may be missing or mis-parsed"];
    data.folios = [{ ...data.folios[0], schemes: [liquid] }, balanced];
    return data;
  } });
  const fund = props.fundChoices["isin:INFZ90K01LQ6"].fund;
  fund.name = "Chosen Liquid Fund";
  profiles["asset-INFZ90K01LQ6"] = { instrumentSymbol: fund.symbol, instrumentExchangeMic: fund.exchangeMic, instrumentType: fund.instrumentType };
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.equal(askAnswers(run).length, 1);
  // Wealthfolio acquires the same rows while the review is open, without submitting this import.
  await shownTable(run);
  activities.push(...storedRows(find(run, "ActivityTable").plan.flatMap((t) => t.rows.map((r) => r.activity))));
  const closing = "Chosen Liquid Fund: its rows add up to 8.053 units, but the statement's closing balance is 9.053. A row may be missing or misread.";
  run.update({ visit: {} });
  await run.flush();
  assert.deepEqual(askAnswers(run).map((a) => a.text), ["Chosen Liquid Fund, folio 91234567 / 12: difference accepted"]);
  assert.deepEqual(askCards(run), []);
  assert.deepEqual(find(run, "StatementWarnings").lines.map((line) => line.text), [closing]);
  assert.match(textOf(run.tree), /Nothing new for Chosen Liquid Fund/);
  assert.equal(imported.length, 0);
});

test("Wealthfolio's purchase equal to two folios' purchases goes to the later folio when the earlier one's rows don't add up (#348)", async () => {
  const change = (data) => {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    // Its purchase and the purchase's stamp duty, in two folios; the earlier one's rows don't add up.
    liquid.transactions = liquid.transactions.slice(0, 2);
    liquid.close_calculated = liquid.transactions[0].units;
    const later = { ...structuredClone(data.folios[0]), folio: "222222222", schemes: [structuredClone(liquid)] };
    later.schemes[0].close = liquid.close_calculated;
    liquid.close = String(Number(liquid.close_calculated) + 1);
    data.folios = [{ ...data.folios[0], schemes: [liquid] }, later];
    return data;
  };
  /** Each transaction's folio and status, from Every transaction, which the bar offers once no question is open. */
  const statuses = async (run) => {
    if (!find(run, "ActivityTable")) {
      nodes(find(run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
      await run.flush();
    }
    return find(run, "ActivityTable").plan.map((t) => [t.transaction.folio, t.status, !!t.transaction.bank]);
  };
  const first = setup({ entries: [], change });
  await first.run.flush();
  askCards(first.run)[0].main.onClick();
  await first.run.flush();
  assert.deepEqual(await statuses(first.run), [["91234567 / 12", "held", false], ["222222222", "new", false]]);
  const plan = find(first.run, "ActivityTable").plan;
  // The purchase and its deposit, entered by hand.
  const { activity, cash } = plan[1].transaction;
  const entries = [stored(activity, "mf", "buy-by-hand"), stored(cash, "mf", "deposit-by-hand")];
  first.run.dispose();
  const { run, profiles } = setup({ entries, change });
  profiles["liquid-asset"] = { instrumentSymbol: activity.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  const counts = () => {
    const b = find(run, "TransactionsSummary").breakdown;
    return [b.toImport, b.before, b.unbalanced, b.skippedUnbalanced, b.duplicates];
  };
  // The later folio's purchase is imported before; the earlier one's still asks.
  assert.deepEqual(counts(), [0, 1, 1, 0, 0]);
  assert.deepEqual(askCards(run).map((c) => c.title), ["Fictiva Liquid Fund's transactions in folio 91234567 / 12 don't add up"]);
  // Accepting makes the first folio's buy first to match. The answer can still be changed.
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(counts(), [1, 1, 0, 0, 0]);
  assert.match(find(run, "FundsReadyTable").rows[0].note, /Check the closing balance warning against the PDF\./);
  assert.match(askAnswers(run)[0].text, /91234567 \/ 12: difference accepted$/);
  assert.ok(find(run, "StatementWarnings").lines.some((line) => /statement's closing balance/.test(line.text)));
  askAnswers(run)[0].onChange();
  run.render();
  assert.equal(askCards(run).length, 1);
  assert.ok(!find(run, "StatementWarnings").lines.some((line) => /statement's closing balance/.test(line.text)));
  await run.flush();
  assert.deepEqual(counts(), [0, 1, 1, 0, 0]);
  askCards(run)[0].main.onClick();
  await run.flush();
  // Skipped, the earlier folio's purchase stays out.
  assert.deepEqual(counts(), [0, 1, 0, 1, 0]);
  assert.deepEqual(await statuses(run), [["91234567 / 12", "held", false], ["222222222", "existing", false]]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("two skipped differences for one fund in one folio have distinct Change controls (#348)", async () => {
  const { run } = setup({ entries: [], change(data) {
    const folio = data.folios[0];
    const liquid = folio.schemes.find((s) => s.scheme.includes("Liquid"));
    liquid.close = "9.053";
    folio.schemes = [liquid, { ...structuredClone(liquid), close: "10.053" }];
    data.folios = [folio];
    return data;
  } });
  await run.flush();
  askCards(run)[0].main.onClick();
  await run.flush();
  askCards(run)[0].main.onClick();
  await run.flush();
  const excluded = find(run, "NotIncludedDetailed");
  assert.deepEqual(excluded.unbalanced.map((fund) => fund.label), ["Fictiva Liquid Fund, fund 1", "Fictiva Liquid Fund, fund 2"]);
  excluded.onReopenAsk(excluded.unbalanced[1].id);
  await run.flush();
  assert.match(textOf(askCards(run)[0].children), /10\.053/);
});

test("a mismatch with no mapped transactions can't use matches from another section of the same folio (#348)", async () => {
  const change = (data) => {
    const liquid = data.folios[0].schemes.find((s) => s.scheme.includes("Liquid"));
    const orphan = { ...liquid, close: "1", close_calculated: "0", transactions: [{ ...liquid.transactions[1], date: "2024-02-20" }] };
    data.folios = [{ ...data.folios[0], schemes: [liquid, orphan] }];
    return data;
  };
  const first = setup({ entries: [], change });
  await first.run.flush();
  askCards(first.run)[0].main.onClick();
  await first.run.flush();
  find(first.run, "Footer").action.onClick();
  await first.run.flush();
  const entries = storedRows(first.imported.flat());
  first.run.dispose();
  const { run, profiles } = setup({ entries, change });
  profiles["asset-INFZ90K01LQ6"] = { instrumentSymbol: "INFZ90K01LQ6", instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  const b = find(run, "TransactionsSummary").breakdown;
  assert.deepEqual([b.toImport, b.before, b.unbalanced, b.leftOut.length], [0, 3, 0, 1]);
  assert.deepEqual(askCards(run).map((c) => c.title), ["Fictiva Liquid Fund's transactions don't add up"]);
  assert.deepEqual(find(run, "StatementWarnings").lines, []);
});

test("a merger between same-named sections of one folio needs both mismatch answers (#348)", async () => {
  const { run, api } = setup({ entries: [], change(data) {
    const folio = data.folios[0];
    const old = folio.schemes.find((s) => s.scheme.includes("Liquid"));
    const next = folio.schemes.find((s) => s.scheme.includes("Balanced"));
    const row = (date, type, amount, units, nav) => ({
      ...old.transactions[0], date, type, amount, units, nav, balance: null, description: type,
    });
    Object.assign(old, { open: "0", close: "1", close_calculated: "0", transactions: [
      row("2024-06-01", "PURCHASE", "500", "10", "50"), row("2024-06-03", "SWITCH_OUT_MERGER", "-500", "-10", "50"),
    ] });
    Object.assign(next, { scheme: old.scheme, open: "0", close: "21", close_calculated: "20", transactions: [
      row("2024-06-03", "SWITCH_IN_MERGER", "500", "20", "25"),
    ] });
    folio.schemes = [old, next];
    data.folios = [folio];
    return data;
  } });
  const checked = [];
  api.activities.checkImport = async (rows) => {
    checked.push(...rows.flatMap((r) => r.activityType === "ADJUSTMENT" ? [r.subtype] : []));
    return rows;
  };
  await run.flush();
  assert.equal(askCards(run).length, 2);
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(checked, []);
  assert.equal(find(run, "TransactionsSummary").breakdown.unbalanced, 2);
  assert.equal(askCards(run).length, 1);
  askCards(run)[0].other.onClick();
  await run.flush();
  assert.deepEqual(checked, ["CONVERSION_OUT", "CONVERSION_IN"]);
  assert.equal(find(run, "TransactionsSummary").breakdown.toImport, 3);
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
  assert.equal(textOfLine(line.type(line.props)), "New · Wealthfolio account, created when you import · Rename");
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
  assert.deepEqual(result.outcomes.map((a) => [a.accountId, a.name, a.isNew, a.state]), [["created-1", "Mutual funds", true, "imported"]]);
  assert.equal(result.outcomes[0].imported, result.total);
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

test("with only a credit card, the funds' new account is preselected, and the card is offered for bank transfers (#351)", async () => {
  const { run, keys, asked, imported } = withNewAccounts({ accounts: [card] });
  await run.flush();
  assert.equal(saveTo(run).values[keys.pan], proposedId(keys.pan));
  assert.equal(saveTo(run).proposed(keys.pan).name, "Mutual funds");
  saveTo(run).onOpen(keys.pan, true);
  await run.flush();
  const { selects } = saveToView(run);
  assert.deepEqual(selects[keys.pan].accounts, []);
  assert.deepEqual(selects[keys.fictiva].accounts, []);
  assert.deepEqual(selects[choices.bankKey(keys.pan)].accounts.map((a) => a.id), ["card"]);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds"]);
  assert.deepEqual([...new Set(imported[0].map((r) => r.accountId))], ["created-1"]);
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

test("a fund waiting for earlier purchases says when its new account won't be created", async () => {
  const earlierOf = (run) => find(run, "NotIncludedDetailed").earlier.map(({ name, uncreated }) => ({ name: name.split(" - ")[0], uncreated }));
  // A new profile whose only fund, Flexi Cap, starts with units: nothing is ready, so Finish creates no account.
  let { run, asked } = withNewAccounts({ change(data) {
    data.folios = [{ ...data.folios[0], schemes: data.folios[0].schemes.filter((s) => s.scheme.includes("Flexi")) }];
    return data;
  } });
  await run.flush();
  assert.deepEqual(earlierOf(run), [{ name: "Fictiva Flexi Cap Fund", uncreated: [{ account: "Mutual funds", folios: ["91234567 / 12"] }] }]);
  assert.equal(find(run, "Footer").action.label, "Finish");
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked, []);
  run.dispose();

  // Other funds import into Mutual funds, which this import creates: nothing more to say.
  ({ run } = withNewAccounts());
  await run.flush();
  assert.deepEqual(earlierOf(run), [{ name: "Fictiva Flexi Cap Fund", uncreated: [] }]);
  assert.match(footer(run)[0], /^Create the Wealthfolio account Mutual funds and import/);
  run.dispose();

  // Testbridge's folio goes to a new account of its own, and its only fund starts with units.
  let keys;
  ({ run, keys } = withNewAccounts({ change(data) {
    const flexi = data.folios[0].schemes.find((s) => s.scheme.includes("Flexi"));
    data.folios[0].schemes = data.folios[0].schemes.filter((s) => s !== flexi);
    data.folios[1].schemes = [flexi];
    return data;
  } }));
  await run.flush();
  saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
  await run.flush();
  assert.deepEqual(earlierOf(run), [{ name: "Fictiva Flexi Cap Fund", uncreated: [{ account: "Testbridge Mutual Fund folio 1040012345", folios: ["1040012345"] }] }]);
  assert.match(footer(run)[0], /^Create the Wealthfolio account Mutual funds and import/);
  run.dispose();

  // Flexi Cap in both folios: only the account nothing goes into is named, with its folio.
  ({ run, keys } = withNewAccounts({ change(data) {
    data.folios[1].schemes = [structuredClone(data.folios[0].schemes.find((s) => s.scheme.includes("Flexi")))];
    return data;
  } }));
  await run.flush();
  saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
  await run.flush();
  const [flexi] = find(run, "NotIncludedDetailed").earlier;
  assert.deepEqual(flexi.accounts.map((a) => [a.account, a.folios]), [["Mutual funds", ["91234567 / 12"]], ["Testbridge Mutual Fund folio 1040012345", ["1040012345"]]]);
  assert.deepEqual(flexi.uncreated, [{ account: "Testbridge Mutual Fund folio 1040012345", folios: ["1040012345"] }]);
});

test("a waiting fund keeps its held units separate from an account this import won't create", async () => {
  for (const [activity, held] of [
    [flexiCap("hand", "BUY", "500"), { kind: "short", has: "500.000", add: "750.000" }],
    [flexiCap("hand", "BUY", "1500"), { kind: "over", has: "1,500.000", extra: "250.000" }],
    [flexiCap("split", "SPLIT", null, { date: "2022-01-05T00:00:00Z" }), { kind: "uncounted", by: [{ day: "5 Jan 2022", kind: "split" }] }],
  ]) {
    const { run, keys, profiles, activities } = withNewAccounts({ accounts: [account("mf", "Mutual funds")], change(data) {
      data.folios[1].schemes = [structuredClone(data.folios[0].schemes.find((s) => s.scheme.includes("Flexi")))];
      return data;
    } });
    profiles.flexi = { instrumentSymbol: "INFZ90K01FC8", instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
    activities.push(activity);
    await run.flush();
    saveTo(run).onChange(keys.pan, "mf");
    await run.flush();
    saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
    await run.flush();
    assert.deepEqual(find(run, "NotIncludedDetailed").earlier.map(({ units, accounts, uncreated }) => ({ units, accounts, uncreated })), [{
      units: "2,500.000 units",
      accounts: [
        { units: "1,250.000", account: "Mutual funds", folios: ["91234567 / 12"], held },
        { units: "1,250.000", account: "Testbridge Mutual Fund folio 1040012345", folios: ["1040012345"] },
      ],
      uncreated: [{ account: "Testbridge Mutual Fund folio 1040012345", folios: ["1040012345"] }],
    }]);
    run.dispose();
  }
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

test("a paired gift waits for each mismatch answer and stops offering a duplicate when one is reopened (#348)", async () => {
  for (const twoMismatches of [false, true]) {
    const { run, api } = setup({ entries: [], remembered: {
      [choices.panKey("ABCDE1234F")]: "mf", [choices.panKey("FGHIJ5678K")]: "other",
    }, change(data) {
      twoInvestorGift(data);
      data.folios = data.folios.slice(-2);
      data.folios[0].schemes[0].close = "1";
      if (twoMismatches) data.folios[1].schemes[0].close = "11";
      return data;
    } });
    const checkedTransfers = [];
    api.activities.checkImport = async (rows) => rows.map((row) => {
      if (!row.activityType.startsWith("TRANSFER")) return row;
      checkedTransfers.push(row.activityType);
      return { ...row, duplicateOfId: "previous" };
    });
    const counts = () => {
      const b = find(run, "TransactionsSummary").breakdown;
      return [b.toImport, b.unbalanced, b.skippedUnbalanced, b.duplicates];
    };
    await run.flush();
    assert.doesNotMatch(textOf(run.tree), /2 funds0 ready\d+ not included/);
    assert.deepEqual(counts(), [0, 3, 0, 0]);
    assert.deepEqual(checkedTransfers, []);
    askCards(run)[0].other.onClick();
    await run.flush();
    if (twoMismatches) {
      assert.deepEqual(counts(), [1, 2, 0, 0]);
      assert.deepEqual(checkedTransfers, []);
      askCards(run)[0].other.onClick();
      await run.flush();
    }
    assert.deepEqual(counts(), [1, 0, 0, 2]);
    assert.deepEqual(checkedTransfers, ["TRANSFER_OUT", "TRANSFER_IN"]);
    askAnswers(run)[0].onChange();
    run.render();
    assert.deepEqual(askCards(run).map((c) => c.main.label), ["Skip this fund"]);
    assert.equal(find(run, "Footer").action.disabled, true);
    await run.flush();
    askCards(run)[0].main.onClick();
    await run.flush();
    assert.deepEqual(counts(), [0, 0, 3, 0]);
    assert.equal(find(run, "Footer").action.label, "Finish");
    const gift = (await shownTable(run)).find((cells) => cells[2] === "transfer out");
    assert.match(gift.at(-1), /Not imported.*Import with this difference/);
    assert.match(gift.at(-1), /folio 33333333/);
    assert.doesNotMatch(gift.at(-1), /folio 44444444/);
    assert.doesNotMatch(gift.at(-1), /Wealthfolio links this transfer out/);
    run.dispose();
  }
});

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
  assert.deepEqual(result.outcomes.map((a) => [a.name, a.state, a.waiting, a.who]), [
    ["Mutual funds", "failed", 1, undefined],
    ["Mutual funds (B. Investor)", "not-created", 1, "B. Investor's"],
  ]);
  assert.equal(result.outcomes[0].imported, result.total - 1);
  assert.equal(find(run, "ReviewHeader").unfinished, true, "leaving a partial result asks before discarding answers");
  assert.equal(result.outcomes[0].retryable, false);
  assert.equal(result.outcomes[0].waitingFor, "Mutual funds (B. Investor)");
  refuse.clear();
  result.onRetryAccount(result.outcomes[1].key);
  await run.flush();
  // Only the account that wasn't created is asked for again.
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (B. Investor)", "Mutual funds (B. Investor)"]);
  assert.equal(imported.length, 2);
  assert.deepEqual(imported[1].map((r) => [r.activityType, r.accountId]), [["TRANSFER_OUT", "created-1"], ["TRANSFER_IN", "created-2"]]);
  assert.deepEqual(remembers.at(-1).accounts, [[boxes[1].key, "created-2"]]);
  result = find(run, "ImportResult");
  // The gift is counted in both investors' accounts.
  assert.deepEqual(result.outcomes.map((a) => [a.accountId, a.state, a.imported, a.waiting]), [
    ["created-1", "imported", result.total, 0],
    ["created-2", "imported", 1, 0],
  ]);
  assert.equal(result.imported, result.total);
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
  assert.equal(alert.nothing, "imported");
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

test("a new transaction account can't take the label of an existing account", async () => {
  const accounts = ["4821", "7310"].map((end) => ({
    ...account(end, "Funds"), accountNumber: end,
  }));
  const { run, keys } = withNewAccounts({ accounts });
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  await run.flush();
  const line = () => saveTo(run).newLine(keys.pan, "funds").props;
  line().onRename();
  await run.flush();
  line().onDraft("Funds (ending 4821)");
  await run.flush();
  line().onSave();
  await run.flush();
  assert.match(line().editing?.error ?? "", /Use another name/);
});

test("generated account names leave existing account labels free", async () => {
  const accounts = ["INR", "USD"].map((currency) => ({ ...account(currency, "Mutual funds", "HOLDINGS"), currency }));
  const { run } = withNewAccounts({ accounts, change(data) {
    data.folios[1].PAN = "BBBBB2222B";
    data.folios[1].name = "USD";
    return data;
  } });
  await run.flush();
  const box = saveTo(run);
  const investor = box.boxes.find((b) => b.name === "USD");
  assert.equal(box.labels.get("USD").text, "Mutual funds (USD)");
  assert.equal(box.proposed(investor.key).name, "Mutual funds (USD) 2");
});

test("a family statement without holder names names a later PAN's new account by the PAN's end, never the whole PAN", async () => {
  const refuse = new Set(["Mutual funds (PAN ending 678K)"]);
  const { run, asked } = withNewAccounts({ refuse, change(data) {
    for (const folio of data.folios) folio.name = null;
    data.folios[1].PAN = "FGHIJ5678K";
    return data;
  } });
  await run.flush();
  const { boxes, proposed } = saveTo(run);
  // The screen shows the whole PAN: nothing saves it.
  assert.deepEqual(boxes.map((b) => b.title), ["PAN ABCDE1234F's funds", "PAN FGHIJ5678K's funds"]);
  const names = [...boxes.map((b) => b.key), ...boxes.flatMap((b) => b.folios).map(choices.folioKey)].map((key) => proposed(key).name);
  assert.deepEqual(names.slice(0, 2), ["Mutual funds", "Mutual funds (PAN ending 678K)"]);
  const key = boxes[1].key;
  saveTo(run).newLine(key, boxes[1].title).props.onRename();
  await run.flush();
  assert.equal(saveTo(run).newLine(key, boxes[1].title).props.editing.draft, names[1]);
  saveTo(run).newLine(key, boxes[1].title).props.onCancel();
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (PAN ending 678K)"]);
  assert.equal(find(run, "ImportResult").outcomes.find((a) => a.key === proposedId(key)).name, names[1]);
  refuse.clear();
  find(run, "ImportResult").onRetryAccount(proposedId(key));
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (PAN ending 678K)", "Mutual funds (PAN ending 678K)"]);
  for (const name of [...names, ...asked.map((a) => a.name)]) assert.doesNotMatch(name, /[A-Z]{5}\d{4}[A-Z]/i);
});

for (const { label, investors, expected } of [
  { label: "a single unnamed PAN", investors: [["ABCDE1234F", null]], expected: ["Mutual funds"] },
  { label: "mixed names and outer PAN whitespace", investors: [["ABCDE1234F", " A.  Investor "], [" \tFGHIJ5678K\n", " \t "]], expected: ["Mutual funds", "Mutual funds (PAN ending 678K)"] },
  { label: "a printed name with whitespace", investors: [["ABCDE1234F", null], ["FGHIJ5678K", " B.  Investor\n"]], expected: ["Mutual funds", "Mutual funds (B. Investor)"] },
  { label: "equal PAN endings", investors: [["ABCDE1234F", null], ["FGHIJ5678K", null], ["KLMNO5678K", null]], expected: ["Mutual funds", "Mutual funds (PAN ending 678K)", "Mutual funds (PAN ending 678K) 2"] },
  { label: "a no-PAN folio before a PAN", investors: [[null, " A.  Investor "], ["FGHIJ5678K", null]], expected: ["Mutual funds", `Mutual funds (${fixture.investor_info.name})`] },
  { label: "an odd PAN", investors: [["ABCDE1234F", null], ["???-5678K", null]], expected: ["Mutual funds", "Mutual funds (PAN ending 678K)"] },
]) {
  test(`box account proposals handle ${label}`, async () => {
    const { run } = withNewAccounts({ change(data) {
      const folios = data.folios;
      data.folios = investors.map(([PAN, name], i) => ({ ...structuredClone(folios[i % folios.length]), folio: `771204${i}`, PAN, name }));
      return data;
    } });
    await run.flush();
    const { boxes, proposed } = saveTo(run);
    assert.deepEqual(boxes.map((b) => proposed(b.key).name), expected);
  });
}

for (const pan of ["K7", "678K", "   "]) {
  test(`a nameless later investor with a short or blank PAN ${JSON.stringify(pan)} gets a generic account name`, async () => {
    const { run, asked } = withNewAccounts({ change(data) {
      for (const folio of data.folios) folio.name = null;
      data.folios[1].PAN = pan;
      return data;
    } });
    await run.flush();
    const { boxes, proposed, newLine } = saveTo(run);
    const key = boxes[1].key;
    assert.equal(proposed(key).name, "Mutual funds (This investor)");
    newLine(key, boxes[1].title).props.onRename();
    await run.flush();
    assert.equal(saveTo(run).newLine(key, boxes[1].title).props.editing.draft, "Mutual funds (This investor)");
    saveTo(run).newLine(key, boxes[1].title).props.onCancel();
    await run.flush();
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (This investor)"]);
  });
}

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

test("an account created before an import failure preserves the units-difference answer for Try again", async () => {
  const { run, api, imported, asked } = withNewAccounts({ change(data) {
    const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
    scheme.close = String(Number(scheme.close_calculated) + 1);
    return data;
  } });
  const send = api.activities.import;
  api.activities.import = async () => { throw new Error("made-up import failure"); };
  await run.flush();
  askCards(run)[0].other.onClick();
  await run.flush();
  const answers = askAnswers(run).map((a) => a.text);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult"), undefined);
  assert.equal(askCards(run).length, 0);
  assert.deepEqual(askAnswers(run).map((a) => a.text), answers);
  assert.equal(find(run, "Footer").action.disabled, false);
  api.activities.import = send;
  nodes(run.tree).find((n) => n.props?.["aria-label"] === "Try again importing transactions").props.onClick();
  await run.flush();
  assert.equal(asked.length, 1);
  assert.equal(imported.length, 1);
  assert.ok(imported[0].some((r) => r.symbol === "INFZ90K01BA1"));
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
  const { run, api, asked, imported, logged } = withNewAccounts({ refuse, change: twoInvestorGift });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  const states = () => find(run, "ImportResult").outcomes.map((a) => [a.accountId ?? a.key, a.state, a.waiting]);
  const key = find(run, "ImportResult").outcomes[1].key;
  assert.deepEqual(states(), [["created-1", "failed", 1], [key, "not-created", 1]]);
  refuse.clear();
  const send = api.activities.import;
  api.activities.import = async () => { throw new Error("made-up held import failure"); };
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  // Created, but its gift wasn't imported: both investors' accounts say so, each with Try again.
  assert.deepEqual(states(), [["created-1", "failed", 1], ["created-2", "failed", 1]]);
  assert.equal(imported.length, 1);
  assert.match(logged.at(-1), /made-up held import failure/);
  assert.doesNotMatch(textOfLine(run.tree), /made-up held import failure/);
  api.activities.import = send;
  // The giver's Try again, this time.
  find(run, "ImportResult").onRetryAccount(find(run, "ImportResult").outcomes[0].key);
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds", "Mutual funds (B. Investor)", "Mutual funds (B. Investor)"]);
  assert.deepEqual(imported[1].map((r) => [r.activityType, r.accountId]), [["TRANSFER_OUT", "created-1"], ["TRANSFER_IN", "created-2"]]);
  assert.deepEqual(states(), [["created-1", "imported", 0], ["created-2", "imported", 0]]);
});

test("a validation-rejected held transaction stays whole while the rest and its bank link go in", async () => {
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
  const tb = find(run, "ImportResult").outcomes.find((a) => a.name === name);
  assert.equal(tb.state, "not-created");
  assert.deepEqual(changed, []);
  refuse.clear();
  const send = api.activities.import;
  let rejected;
  api.activities.import = async (rows) => {
    if (rejected) return send(rows);
    imported.push(rows);
    rejected = rows.find((r) => r.activityType !== "DIVIDEND");
    assert.ok(rejected);
    return {
      activities: rows.map((r) => r === rejected ? { ...r, isValid: false, errors: { general: ["Made-up validation failure."] } } : r),
      summary: { success: false, total: rows.length, imported: 0, skipped: 1, duplicates: 0, assetsCreated: 0 },
    };
  };
  find(run, "ImportResult").onRetryAccount(tb.key);
  await run.flush();
  assert.equal(imported.length, 3);
  assert.ok(imported[1].some((r) => r.activityType === "DIVIDEND"));
  // The rejected transaction stays out whole. The rest are sent again at once, since validation
  // saved none of the first batch; its dividend uses the bank entry only after the trade is in.
  const result = find(run, "ImportResult");
  assert.equal(result.result.summary.success, true);
  assert.ok(result.result.activities.some((a) => a.errors?.general?.[0] === "Made-up validation failure."));
  const refusedLine = rejected.lineNumber;
  assert.ok(imported[2].length < imported[1].length);
  assert.ok(!imported[2].some((r) => r.lineNumber === refusedLine));
  assert.ok(imported[2].some((r) => r.activityType === "DIVIDEND"));
  assert.deepEqual(changed, ["create", "update", "link"]);
  assert.deepEqual(result.links.map((l) => l.stage), [undefined]);
  assert.equal(result.outcomes.find((a) => a.name === name).state, "failed");
  assert.equal(result.outcomes.find((a) => a.name === name).retryable, false);
});

test("Rename's footer message and Go to it take precedence over a failed detailed planning read", async () => {
  const { run, api, keys } = withNewAccounts();
  api.activities.getAll = async () => { throw new Error("made-up planning failure"); };
  await run.flush();
  assert.equal(footer(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  saveTo(run).newLine(keys.pan, "funds").props.onRename();
  await run.flush();
  assert.deepEqual(footer(run), ["Save or cancel the new account name first."]);
  assert.equal(find(run, "Footer").go.label, "Go to it");
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo(run).newLine(keys.pan, "funds").props.onCancel();
  await run.flush();
  assert.equal(footer(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
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

test("Try again after an account isn't created waits for the same answers as importing", async () => {
  const { run, keys, asked, imported } = withNewAccounts({ accounts: [account("mf", "Mutual funds")], refuse: new Set(["Mutual funds 2"]) });
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult"), undefined);
  const tryAgain = () => nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOfLine(n) === "Try again");
  assert.equal(tryAgain().props.disabled, false);
  // The Testbridge folio now goes to Mutual funds with Mutual funds as its bank account too: a question.
  saveTo(run).onChange(keys.testbridge, "mf");
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.testbridge), "mf");
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(tryAgain().props.disabled, true);
  tryAgain().props.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["Mutual funds 2"]);
  assert.equal(imported.length, 0);
});

test("the detailed creation retry and planning retry have different accessible names", async () => {
  const { run, api, imported } = withNewAccounts({ refuse: new Set(["Mutual funds"]) });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.ok(find(run, "NotCreatedAlert"));
  api.activities.getAll = async () => { throw new Error("made-up planning failure"); };
  run.update({ visit: {} });
  await run.flush();
  assert.equal(footer(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  const retry = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOfLine(n) === "Try again");
  assert.equal(retry.props.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Try again");
  assert.equal(retry.props["aria-label"], "Try again importing transactions");
  assert.equal(imported.length, 0);
});

test("a possible duplicate redemption and cash dividend are asked about in their own words, and importing one shows its effect", async () => {
  const first = setup({ entries: [] });
  await first.run.flush();
  nodes(find(first.run, "Footer").lines).find((node) => node.props?.children === "See every transaction").props.onClick();
  await first.run.flush();
  const plan = find(first.run, "ActivityTable").plan;
  // Wealthfolio has the Liquid Fund's redemption and the Corporate Bond Fund's first cash dividend, entered by hand.
  const sale = plan.find((t) => t.transaction.scheme.includes("Liquid") && t.transaction.activity.activityType === "SELL").transaction.activity;
  const dividend = plan.find((t) => t.transaction.scheme.includes("Corporate Bond") && t.transaction.activity.activityType === "DIVIDEND").transaction.activity;
  first.run.dispose();
  const byHand = (a, id, assetId) => ({ ...stored(a, "mf", id), assetId, createdAt: "2024-01-02T10:00:00Z" });
  const { run, profiles } = setup({ entries: [byHand(sale, "sale-by-hand", "liquid-asset"), byHand(dividend, "dividend-by-hand", "bond-asset")] });
  profiles["liquid-asset"] = { instrumentSymbol: sale.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  profiles["bond-asset"] = { instrumentSymbol: dividend.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  const cards = askCards(run);
  assert.deepEqual(cards.map((c) => [c.title, c.other.label]), [
    ["This redemption may already be in Mutual funds", "Import it as another redemption"],
    ["This cash dividend may already be in Mutual funds", "Import it as another cash dividend"],
  ]);
  const evidence = (card) => nodes(card.children).filter((n) => n.type === "p").map(textOf);
  assert.match(evidence(cards[0])[0], /^On this statement: \d+ \w+ \d{4} · Redemption · Fictiva Liquid Fund · [\d,.]+ units · ₹[\d,.]+$/);
  assert.match(evidence(cards[0])[1], /^Already in Mutual funds: \d+ \w+ \d{4} · Sell · INFZ90K01LQ6 · [\d,.]+ units · ₹[\d,.]+ · entered by hand on 2 Jan 2024$/);
  assert.match(evidence(cards[1])[0], /^On this statement: \d+ \w+ \d{4} · Cash dividend · Testbridge Corporate Bond Fund · ₹[\d,.]+$/);
  assert.match(evidence(cards[1])[1], /^Already in Mutual funds: \d+ \w+ \d{4} · Dividend · .* · ₹[\d,.]+ · entered by hand on 2 Jan 2024$/);
  for (const card of cards) {
    card.other.onClick();
    await run.flush();
  }
  const rows = find(run, "FundsReadyTable").rows;
  const liquid = rows.find((r) => r.name.includes("Liquid"));
  const bond = rows.find((r) => r.name.includes("Corporate Bond"));
  // Another redemption takes units away; another cash dividend adds income, not units.
  assert.match(liquid.note, /^After import: [\d,.-]+ units · Statement: [\d,.]+\. Includes another redemption you chose\.$/);
  assert.match(bond.note, /^Includes another cash dividend you chose: ₹[\d,.]+ more income\.$/);
  assert.match(textOf(find(run, "Footer").lines), /2 possible duplicates imported by your answer\./);
  assert.equal(find(run, "TransactionsSummary").breakdown.importedDuplicates, 2);
});

test("another cash dividend's income stays visible when another purchase also changes the fund's units", async () => {
  const change = (data) => {
    const folio = data.folios[1];
    data.folios = [{ ...folio, schemes: [folio.schemes.find((s) => s.scheme.includes("Corporate Bond"))] }];
    return data;
  };
  const first = setup({ entries: [], change });
  await first.run.flush();
  nodes(find(first.run, "Footer").lines).find((n) => n.props?.children === "See every transaction").props.onClick();
  await first.run.flush();
  const plan = find(first.run, "ActivityTable").plan;
  const purchase = plan.find((t) => t.transaction.activity.activityType === "BUY").transaction.activity;
  const dividend = plan.find((t) => t.transaction.activity.activityType === "DIVIDEND").transaction.activity;
  first.run.dispose();
  const { run, profiles } = setup({ entries: [stored(purchase, "mf", "purchase"), stored(dividend, "mf", "dividend")], change });
  profiles["liquid-asset"] = { instrumentSymbol: purchase.symbol, instrumentExchangeMic: "XBOM", instrumentType: "MUTUALFUND" };
  await run.flush();
  assert.equal(askCards(run).length, 2);
  for (const card of askCards(run)) card.other.onClick();
  await run.flush();
  const row = find(run, "FundsReadyTable").rows[0];
  assert.match(row.note, /^After import: .* Includes the 2 possible duplicates you chose\./);
  assert.match(row.note, /Includes another cash dividend you chose: ₹[\d,.]+ more income\.$/);
});

/** The made-up purchase's bank entry chosen, ready to import into Mutual funds with Savings. */
async function withChosenEntry(inSpending = false) {
  const context = setup({ entries: [structuredClone(ENTRIES[1])], remembered: {
    [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
  } });
  const { run, keys, api, activities } = context;
  const steps = [];
  const getAll = api.activities.getAll;
  api.activities.getAll = async (id) => (await getAll(id)).map((row) => ({ ...row }));
  if (inSpending) {
    api.spending.getContext = async () => ({ enabled: true, accountIds: ["bank"], excludedCategoryIds: [] });
    api.spending.searchCashActivities = async () => ({ items: activities.filter((a) => a.accountId === "bank").map((a) => ({
      ...a, assignments: [{ taxonomyId: "spending_categories", categoryId: "food" }],
    })), totalCount: 1 });
  }
  api.spending.unassignCategory = async () => {};
  api.activities.create = async (row) => {
    steps.push("create");
    const transfer = { ...row, id: "new-fund-transfer", date: row.activityDate, status: "POSTED", assetId: "", assetSymbol: "" };
    activities.push(transfer);
    return transfer;
  };
  api.activities.update = async (row) => {
    steps.push("update");
    Object.assign(activities.find((a) => a.id === row.id), row);
  };
  api.activities.linkTransfer = async () => void steps.push("link");
  await run.flush();
  const [check] = checksUnder(run, choices.bankKey(keys.pan));
  check.onLink();
  await run.flush();
  return { ...context, steps };
}

test("a bank entry that wasn't linked says how far it got, and Try again goes on from there", async () => {
  const { run, api, steps, logged } = await withChosenEntry();
  let fail = true;
  api.activities.linkTransfer = async () => {
    if (fail) throw new Error("made-up link failure");
    steps.push("link");
  };
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.deepEqual(result.links.map((l) => [l.stage, l.fundId, l.converted]), [["link", "new-fund-transfer", true]]);
  assert.deepEqual(steps, ["create", "update"]);
  assert.match(logged.join("\n"), /made-up link failure/);
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  const notice = nodes(run.tree).find((n) => n.props?.role === "status").props.children;
  assert.match(notice, /The trade and the fund account's transfer are in Wealthfolio; the bank entry/);
  assert.match(notice, /Try again to link the bank entry/);
  fail = false;
  result.onRetryLink(result.links[0]);
  await run.flush();
  // Only the link: the fund account's transfer isn't added again, nor the entry changed again.
  assert.deepEqual(steps, ["create", "update", "link"]);
  result = find(run, "ImportResult");
  assert.deepEqual(result.links.map((l) => l.stage), [undefined]);
});

test("a bank link whose response failed finishes category removal without linking again", async () => {
  const { run, api, activities, steps } = await withChosenEntry(true);
  const removed = [];
  let pair;
  api.spending.unassignCategory = async (id, kind) => removed.push([id, kind]);
  api.activities.linkTransfer = async (bankId, fundId) => {
    steps.push("link");
    pair = { transferOut: activities.find((a) => a.id === bankId), transferIn: activities.find((a) => a.id === fundId) };
    throw new Error("made-up failed answer after linking");
  };
  api.activities.getTransferPair = async (id) => pair && [pair.transferOut.id, pair.transferIn.id].includes(id) ? pair : null;
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.equal(result.links[0].stage, "link");
  assert.match(result.links[0].warnings.join(), /spending category.*wasn't removed because linking failed/);
  assert.deepEqual(removed, []);
  result.onRetryLink(result.links[0]);
  await run.flush();
  result = find(run, "ImportResult");
  assert.deepEqual(steps, ["create", "update", "link"]);
  assert.deepEqual(removed, [[pair.transferOut.id, "expense"]]);
  assert.equal(result.links[0].stage, undefined);
  assert.deepEqual(result.links[0].warnings, []);
  assert.ok(result.links[0].changes.includes("Its spending category was removed."));
});

test("units that couldn't be checked after importing say so, with Check again, apart from units that differ", async () => {
  const { run, api } = setup({ entries: [] });
  await run.flush();
  const getAll = api.activities.getAll;
  let fail = true;
  // The plan has read every account's activities; the check reads each account's own.
  api.activities.getAll = async (accountId) => {
    if (accountId && fail) throw new Error("made-up read failure");
    return getAll(accountId);
  };
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.equal(result.closing, "failed");
  assert.ok(result.outcomes.every((a) => a.state === "imported"));
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  assert.match(nodes(run.tree).find((n) => n.props?.role === "status").props.children,
    /Saved, but the units couldn't be checked in Wealthfolio\. Check again\./);
  fail = false;
  result.onCheckAgain();
  await run.flush();
  result = find(run, "ImportResult");
  assert.ok(Array.isArray(result.closing) && result.closing.length > 0);
  // A fund none of whose transactions were sent, such as one waiting for earlier purchases, isn't checked.
  assert.ok(!result.closing.some((f) => f.schemes.some((s) => s.scheme.includes("Flexi"))), result.closing.map((f) => f.schemes[0].scheme).join());
});

for (const { kept, zeroed = [], words } of [
  { kept: ["Liquid"], words: "the fund" },
  { kept: ["Liquid", "Overnight"], words: "both funds" },
  { kept: ["Liquid", "Balanced", "Overnight"], words: "all 3 funds" },
  { kept: ["Liquid", "Overnight"], zeroed: ["Overnight"], words: "1 of 2 funds" },
]) {
  test(`Check again says the import result's sentence when units differ for ${words}`, async () => {
    const { run, api } = setup({ entries: [], change(data) {
      for (const folio of data.folios) {
        folio.schemes = folio.schemes.filter((s) => kept.some((name) => s.scheme.includes(name)));
        // Bought and sold in full: nothing left, as in the made-up host, which keeps nothing imported.
        for (const s of folio.schemes.filter((s) => zeroed.some((name) => s.scheme.includes(name)))) {
          const [purchase] = s.transactions;
          s.transactions = [purchase, { ...purchase, date: "2024-02-02", description: "Redemption", type: "REDEMPTION",
            units: `-${purchase.units}`, amount: `-${purchase.amount}`, balance: "0.000" }];
          s.close = s.close_calculated = "0";
          s.valuation = { ...s.valuation, cost: "0", value: "0" };
        }
      }
      data.folios = data.folios.filter((f) => f.schemes.length);
      return data;
    } });
    await run.flush();
    const getAll = api.activities.getAll;
    let fail = true;
    api.activities.getAll = async (accountId) => {
      if (accountId && fail) throw new Error("made-up read failure");
      return getAll(accountId);
    };
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(find(run, "ImportResult").closing, "failed");
    fail = false;
    find(run, "ImportResult").onCheckAgain();
    await run.flush();
    const { closing } = find(run, "ImportResult");
    assert.equal(closing.length, kept.length);
    const sentence = `Checked in Wealthfolio: units differ for ${words}.`;
    assert.equal(await announced(run), sentence);
    const shown = markup(nodes(run.tree).find((node) => node.type?.name === "ImportResult"));
    assert.ok(shown.includes(`>${sentence}<`), shown);
  });
}

test("an import Wealthfolio refuses outright keeps the review as it was, with Try again", async () => {
  const { run, api, imported, logged } = setup({ entries: [] });
  const send = api.activities.import;
  api.activities.import = async () => { throw new Error("made-up import failure"); };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "ImportResult"), undefined);
  assert.match(textOf(run.tree), /Nothing was imported: Wealthfolio couldn't import the transactions\.The review is as you left it\./);
  assert.doesNotMatch(textOf(run.tree), /made-up import failure/);
  assert.match(logged.at(-1), /made-up import failure/);
  api.activities.import = send;
  const tryAgain = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && n.props["aria-label"] === "Try again importing transactions");
  tryAgain.props.onClick();
  await run.flush();
  assert.equal(imported.length, 1);
  assert.ok(find(run, "ImportResult"));
});


test("an account whose transactions were all refused has no checked funds or ineffective retry", async () => {
  const { run, api, imported } = withNewAccounts();
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => (await check(rows)).map((r) => ({
    ...r, isValid: false, errors: { general: ["Made-up refusal."] },
  }));
  await run.flush();
  let settingsReads = 0;
  api.settings.get = async () => { settingsReads++; throw new Error("made-up settings failure"); };
  find(run, "Footer").action.onClick();
  await run.flush();
  const result = find(run, "ImportResult");
  assert.equal(imported.length, 0);
  assert.equal(result.imported, 0);
  assert.deepEqual(result.closing, []);
  assert.equal(settingsReads, 0, "no funds qualify for a units check");
  assert.equal(result.outcomes[0].state, "failed");
  assert.equal(result.outcomes[0].waiting, result.total);
  assert.equal(result.outcomes[0].retryable, false);
});


test("a bank-link retry checks fresh entries and preserves its progress when one changed", async () => {
  const { run, api, activities, steps } = await withChosenEntry();
  api.activities.linkTransfer = async () => { throw new Error("made-up link failure"); };
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.deepEqual(steps, ["create", "update"]);
  const original = result.links[0];
  activities.find((a) => a.id === "purchase").amount = "24999.99";
  result.onRetryLink(original);
  await run.flush();
  assert.match(textOf(run.tree), /The bank entry changed since the import\. Finish linking it in Wealthfolio\./);
  assert.deepEqual(steps, ["create", "update"], "the stale entry is never changed or linked");
  result = find(run, "ImportResult");
  assert.equal(result.links[0], original, "the completed transfer and conversion stay available");
  activities.find((a) => a.id === "purchase").amount = original.bankRow.amount;
  api.activities.linkTransfer = async () => void steps.push("link");
  result.onRetryLink(original);
  await run.flush();
  assert.deepEqual(steps, ["create", "update", "link"]);
  assert.equal(find(run, "ImportResult").links[0].stage, undefined);
});


test("a skipped trade never announces an unavailable bank-link retry", async () => {
  const { run, api, steps } = await withChosenEntry();
  const send = api.activities.import;
  api.activities.import = async (rows) => {
    const result = await send(rows);
    const trade = rows.find((r) => r.activityType === "BUY");
    return { ...result, activities: result.activities.map((r) => r === trade || r.lineNumber === trade.lineNumber
      ? { ...r, duplicateOfId: "already-present" } : r) };
  };
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(find(run, "ImportResult").links.map((l) => l.stage), ["trade"]);
  assert.deepEqual(steps, []);
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  const notice = nodes(run.tree).find((n) => n.props?.role === "status").props.children;
  assert.match(notice, /The trade wasn't imported/);
  assert.doesNotMatch(notice, /Try again to link the bank entry/);
});

test("an account's validation failures leave its paired rows out and let the other account save", async () => {
  const { run, api, keys } = setup({ entries: [] });
  const calls = [];
  const saved = [];
  api.activities.import = async (rows) => {
    calls.push(rows);
    const errors = rows.some((r) => r.accountId === "other");
    if (!errors) saved.push(...rows);
    return {
      activities: rows.map((r) => r.accountId === "other"
        ? { ...r, isValid: false, errors: { general: ["Made-up other-account validation failure."] } }
        : r),
      summary: { success: !errors, total: rows.length, imported: errors ? 0 : rows.length, skipped: errors ? rows.filter((r) => r.accountId === "other").length : 0, duplicates: 0, assetsCreated: 0 },
    };
  };
  await run.flush();
  saveTo(run).onChange(keys.testbridge, "other");
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(calls.length, 2, "valid transactions go on without an account retry");
  assert.deepEqual([...new Set(calls[0].map((r) => r.accountId))], ["mf", "other"]);
  assert.ok(calls[1].every((r) => r.accountId === "mf"));
  assert.deepEqual(saved, calls[1]);
  assert.equal(new Set(saved.map((r) => r.sourceRecordId)).size, saved.length, "each successful row is saved once");
  const result = find(run, "ImportResult");
  assert.ok(result.outcomes[0].imported > 0);
  assert.equal(result.outcomes[0].state, "imported");
  assert.equal(result.outcomes[0].waiting, 0);
  assert.equal(result.outcomes[1].state, "failed");
  assert.equal(result.outcomes[1].retryable, false);
  assert.ok(result.result.activities.filter((r) => r.accountId === "other").every((r) => Object.keys(r.errors).length));
});

test("a validation failure without identified rows waits for a retry without repeating the request", async () => {
  const { run, api } = setup({ entries: [] });
  let calls = 0;
  api.activities.import = async (rows) => {
    calls++;
    return { activities: rows, summary: { success: false, total: rows.length, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0 } };
  };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(calls, 1);
  assert.equal(find(run, "ImportResult"), undefined);
  assert.match(textOf(run.tree), /Nothing was imported: Wealthfolio couldn't import the transactions/);
});

test("Try again reads Wealthfolio afresh, so a fund's type fixed there lets the plan through", async () => {
  const { run, props, profiles } = setup({ entries: [] });
  const [, choice] = Object.entries(props.fundChoices)[0];
  choice.fund.assetId = "missing-type";
  profiles["missing-type"] = { instrumentSymbol: choice.fund.symbol, instrumentExchangeMic: "XBOM" };
  await run.flush();
  assert.match(footer(run)[1], /type .* isn't set/);
  // Set in Wealthfolio, as the line asks: the profile read before must be read again.
  profiles["missing-type"] = { ...profiles["missing-type"], instrumentType: "MUTUALFUND" };
  find(run, "Footer").go.onClick();
  await run.flush();
  assert.doesNotMatch(footer(run).join(" "), /We couldn't work out/);
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("an entry changed into a transfer whose answer was lost is linked on Try again without changing it again", async () => {
  const { run, api, steps } = await withChosenEntry(true);
  const update = api.activities.update;
  let lose = true;
  // Wealthfolio changes the entry, then the answer is lost.
  api.activities.update = async (row) => {
    await update(row);
    if (lose) throw new Error("made-up lost answer");
  };
  const removed = [];
  api.spending.unassignCategory = async (id, kind) => void removed.push([id, kind]);
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.deepEqual(result.links.map((l) => [l.stage, l.converted]), [["convert", false]]);
  assert.deepEqual(steps, ["create", "update"]);
  lose = false;
  result.onRetryLink(result.links[0]);
  await run.flush();
  result = find(run, "ImportResult");
  // Only the link: the entry isn't changed again, and its spending category goes as after a change.
  assert.deepEqual(steps, ["create", "update", "link"]);
  assert.deepEqual(result.links.map((l) => [l.stage, l.converted]), [[undefined, true]]);
  assert.deepEqual(removed.map(([, kind]) => kind), ["expense"]);
});

test("a recovered conversion reports its deleted split and stopped sync while using current categories", async () => {
  const { run, api, activities, steps } = await withChosenEntry(true);
  let splits = [
    { categoryId: "food", taxonomyId: "spending_categories" },
    { categoryId: "travel", taxonomyId: "spending_categories" },
  ];
  let assignments = [{ categoryId: "food", taxonomyId: "spending_categories" }];
  api.accounts.getAll = async () => ACCOUNTS.map((a) => a.id === "bank" ? { ...a, provider: "synced" } : a);
  api.spending.searchCashActivities = async () => ({ items: [{ id: "purchase", splits, assignments }], totalCount: 1 });
  const update = api.activities.update;
  api.activities.update = async (row) => {
    await update(row);
    splits = [];
    activities.find((a) => a.id === row.id).isUserModified = true;
    throw new Error("made-up lost answer after deleting the split and marking as edited");
  };
  const removed = [];
  api.spending.unassignCategory = async (id, kind) => void removed.push([id, kind]);
  // The new split and sync consequences are disclosed before importing.
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.match(textOf(run.tree), /split across 2 spending categories/);
  assert.deepEqual(steps, []);
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  assert.equal(result.links[0].stage, "convert");
  assert.deepEqual(result.links[0].changes, []);
  // Its category was removed elsewhere before retrying; the old facts must not remove it again.
  assignments = [];
  result.onRetryLink(result.links[0]);
  await run.flush();
  result = find(run, "ImportResult");
  assert.deepEqual(steps, ["create", "update", "link"]);
  assert.equal(result.links[0].stage, undefined);
  assert.deepEqual(removed, []);
  assert.deepEqual(result.links[0].changes, [
    "Its split across 2 spending categories was deleted.",
    "Later corrections to it from the sync won't change it.",
  ]);
});

// #238: in a narrow frame the bar shows one line and its button with Details; the rest folds.
test("the bar's narrow form says what's imported in one line, for one account or several, and folds the rest", async () => {
  const { run, keys } = setup({ entries: [] });
  await run.flush();
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  let { narrow } = find(run, "Footer");
  assert.equal(textOf(narrow.brief), "Import 13 transactions for 4 funds into Mutual funds.");
  assert.deepEqual(narrow.more.map(textOf), [
    "ANANYA R TESTWALA's purchases transfer from Savings, and sales and payouts back to it: 9 get new transfers.",
    "See every transaction",
  ]);
  assert.equal(narrow.warnings, 0);
  saveTo(run).onChange(keys.testbridge, "other");
  await run.flush();
  ({ narrow } = find(run, "Footer"));
  assert.equal(textOf(narrow.brief), "Import 13 transactions for 4 funds into 2 accounts.");
  assert.deepEqual(narrow.more.map(textOf), footer(run), "every line, in a wide frame's order");
  assert.deepEqual(footer(run).slice(0, 2), [
    "Import 7 transactions for 2 funds into Mutual funds.",
    "Import 6 transactions for 2 funds into Other funds.",
  ]);
  // Nothing new to import: that line, with what's folded under it.
  saveTo(run).onChange(keys.pan, choices.LEFT_OUT);
  saveTo(run).onChange(keys.testbridge, choices.LEFT_OUT);
  await run.flush();
  assert.equal(find(run, "Footer").narrow, undefined, "nothing is imported: one line, nothing folded");
});

/** An error as Wealthfolio's sandbox rejects a host call with: its message, and its code if the host gave one. */
const hostError = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });
/** A row as Wealthfolio stores an import of it, with the add-on's row ID. */
const savedCopy = (r, i) => stored(r, r.accountId, `saved-elsewhere-${i}`, `addon:cas-importer:${r.sourceRecordId}`);
/** A transaction's rows among `rows`: its trade's, and its cash's and bank transfer's, which share its row ID. */
const rowsOfTransaction = (rows, trade) => rows.filter((r) => r.sourceRecordId === trade.sourceRecordId || r.sourceRecordId.startsWith(`${trade.sourceRecordId}:`));

for (const message of ["Duplicate activity", "", "Network unavailable"]) {
  test(`an import Wealthfolio refuses as a duplicate reads it again, keeps valid answers and imports only what it lacks (message "${message}")`, async () => {
    const { run, api, activities, imported, logged } = setup({ entries: [], remembered: {
      [choices.panKey("ABCDE1234F")]: "mf", [choices.bankKey(choices.panKey("ABCDE1234F"))]: "bank",
    }, change(data) {
      const scheme = data.folios[0].schemes.find((s) => s.scheme.includes("Balanced"));
      scheme.close = String(Number(scheme.close_calculated) + 1);
      return data;
    } });
    let reads = 0;
    const getAll = api.activities.getAll;
    api.activities.getAll = async (id) => (reads++, getAll(id));
    await run.flush();
    askCards(run)[0].other.onClick();
    await run.flush();
    const answers = askAnswers(run).map((a) => a.text);
    assert.deepEqual(answers.length, 1);
    const send = api.activities.import;
    let refused;
    let whole;
    let part;
    api.activities.import = async (rows) => {
      if (refused) return send(rows);
      refused = rows;
      // Another import saved one purchase whole, and only the trade of another, before this one's rows went in.
      const [first, second] = rows.filter((r) => r.activityType === "BUY" && r.symbol && rowsOfTransaction(rows, r).length === 3);
      whole = rowsOfTransaction(rows, first);
      part = [second];
      activities.push(...[...whole, ...part].map(savedCopy));
      throw hostError(message, "DUPLICATE_ACTIVITY");
    };
    const before = reads;
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(find(run, "ImportResult"), undefined);
    assert.equal(imported.length, 0);
    assert.match(logged.join("\n"), /Wealthfolio didn't import the transactions/);
    assert.match(textOf(run.tree), /Nothing was imported: Wealthfolio already has some of these transactionsThey were saved elsewhere while the import ran, such as in another window\. The review now shows what Wealthfolio has\. Check it, then import again\./);
    assert.doesNotMatch(textOf(run.tree), /Nothing was imported: Wealthfolio couldn't import the transactions/);
    // Read again: the answer whose evidence didn't change stays, and the transaction Wealthfolio has part of is asked about.
    assert.ok(reads > before);
    assert.deepEqual(askAnswers(run).map((a) => a.text), answers);
    const cards = askCards(run);
    assert.equal(cards.length, 1);
    assert.match(cards[0].title, /may already be in Mutual funds$/);
    assert.equal(find(run, "Footer").action.disabled, true);
    cards[0].main.onClick();
    await run.flush();
    find(run, "Footer").action.onClick();
    await run.flush();
    // What Wealthfolio has isn't sent again, nor is the rest of the purchase it has part of; everything else is, whole.
    assert.equal(imported.length, 1);
    const left = new Set([...whole, ...rowsOfTransaction(refused, part[0])].map((r) => r.sourceRecordId));
    assert.deepEqual(imported[0].map((r) => r.sourceRecordId).sort(), refused.map((r) => r.sourceRecordId).filter((id) => !left.has(id)).sort());
    assert.ok(find(run, "ImportResult"));
  });
}

for (const [why, error] of [
  ["no code", hostError("DUPLICATE_ACTIVITY: Duplicate activity already exists")],
  ["another code", hostError("Duplicate activity already exists", "VALIDATION_ERROR")],
  ["an empty code", hostError("Duplicate activity already exists", "")],
]) {
  test(`an import refused with ${why} keeps the review as it was, whatever its message says`, async () => {
    const { run, api, imported } = setup({ entries: [] });
    let reads = 0;
    const getAll = api.activities.getAll;
    api.activities.getAll = async (id) => (reads++, getAll(id));
    await run.flush();
    const send = api.activities.import;
    api.activities.import = async () => { throw error; };
    const before = reads;
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.equal(find(run, "ImportResult"), undefined);
    assert.equal(reads, before, "nothing is read again");
    assert.match(textOf(run.tree), /Nothing was imported: Wealthfolio couldn't import the transactions\.The review is as you left it\./);
    assert.doesNotMatch(textOf(run.tree), /already has some of these transactions/);
    api.activities.import = send;
    nodes(run.tree).find((n) => n.props?.["aria-label"] === "Try again importing transactions").props.onClick();
    await run.flush();
    assert.equal(imported.length, 1);
  });
}

/**
 * A result whose Testbridge folio's transactions wait for its new account, which Wealthfolio didn't
 * create, its dividend with the bank entry chosen for it; Wealthfolio creates the account now.
 */
async function withHeldFolio({ dividend = ENTRIES[0], timeZone = "UTC" } = {}) {
  const name = "Testbridge Mutual Fund folio 1040012345";
  const refuse = new Set([name]);
  const context = withNewAccounts({ accounts: [account("bank", "Savings")], refuse });
  const { run, props, api, keys, activities } = context;
  api.accounts.getAll = async () => props.allAccounts;
  api.settings.get = async () => ({ timezone: timeZone });
  activities.push({ ...dividend });
  const changed = [];
  api.activities.create = async () => { changed.push("create"); return { id: "fund-transfer" }; };
  api.activities.update = async () => { changed.push("update"); };
  api.activities.linkTransfer = async () => { changed.push("link"); };
  await run.flush();
  saveTo(run).onChange(keys.pan, proposedId(keys.pan));
  saveTo(run).onChange(keys.testbridge, proposedId(keys.testbridge));
  saveTo(run).onChange(choices.bankKey(keys.pan), "bank");
  await run.flush();
  checksUnder(run, choices.bankKey(keys.pan))[0].onLink();
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  const tb = find(run, "ImportResult").outcomes.find((a) => a.name === name);
  assert.equal(tb.state, "not-created");
  refuse.clear();
  // Wealthfolio's check calls a row whose ID is in `elsewhere` a duplicate of an activity it has.
  const elsewhere = new Set();
  const checked = [];
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => {
    checked.push(rows);
    return (await check(rows)).map((r) => (elsewhere.has(r.sourceRecordId) ? { ...r, duplicateOfId: "saved-elsewhere" } : r));
  };
  const status = () => nodes(run.tree).find((n) => n.props?.role === "status").props.children;
  return { ...context, name, key: tb.key, changed, elsewhere, checked, status };
}
/** How many transactions `rows` are: a trade's cash and bank transfer share its row ID. */
const transactionsIn = (rows) => new Set(rows.map((r) => r.sourceRecordId.split(":")[0])).size;

test("an account's retry converts the freshly checked entry after a time edit within its local day", async () => {
  // 02:00 and 06:00 on 28 Dec in India fall on different UTC days.
  const dividend = { ...ENTRIES[0], date: "2023-12-27T20:30:00Z", sourceSystem: "MANUAL" };
  const { run, api, key, activities } = await withHeldFolio({ dividend, timeZone: "Asia/Kolkata" });
  assert.equal(find(run, "ImportResult").chosen, 1, "the held dividend's entry still counts");
  assert.equal(linkedLine(run), null);
  const latest = { ...dividend, date: "2023-12-28T00:30:00Z", comment: "Edited TESTBRIDGE MF IDCW", isUserModified: true };
  activities[activities.findIndex((a) => a.id === dividend.id)] = latest;
  const updates = [];
  api.activities.update = async (row) => { updates.push(row); };
  api.settings.get = async () => ({ timezone: "UTC" });
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.deepEqual(updates.map((row) => [row.id, row.activityDate, row.comment]), [[latest.id, latest.date, latest.comment]]);
  assert.equal(find(run, "ImportResult").outcomes.find((a) => a.key === key).state, "imported");
  assert.equal(linkedLine(run), "✓ Linked the bank entry you chose with its transaction.");
});

for (const message of ["Duplicate activity", "", "Network unavailable"]) {
  test(`an account's Try again refused as a duplicate checks Wealthfolio again, lists what it has and keeps the rest whole (message "${message}")`, async () => {
    const { run, api, imported, logged, name, key, changed, elsewhere, checked, status } = await withHeldFolio();
    const send = api.activities.import;
    let refused;
    let checks;
    api.activities.import = async (rows) => {
      if (refused) return send(rows);
      refused = rows;
      checks = checked.length;
      // Another import saved the dividend, whose bank entry was chosen, before this one's rows went in.
      elsewhere.add(rows.find((r) => r.activityType === "DIVIDEND").sourceRecordId);
      throw hostError(message, "DUPLICATE_ACTIVITY");
    };
    find(run, "ImportResult").onRetryAccount(key);
    await run.flush();
    // After the refusal, Wealthfolio's own check of everything refused, where it was sent, says which transactions it has.
    assert.deepEqual(checked.slice(checks), [refused]);
    assert.match(logged.join("\n"), /Wealthfolio didn't import the transactions/);
    const total = transactionsIn(refused);
    assert.ok(total > 1);
    const said = `Nothing more was imported: Wealthfolio now has 1 of these ${total} transactions, in whole or in part, saved elsewhere while the import ran. Try again imports the rest.`;
    assert.ok(textOf(run.tree).includes(said), textOf(run.tree));
    await new Promise((resolve) => setTimeout(resolve, 85));
    await run.flush();
    assert.ok(status().startsWith(said), status());
    let result = find(run, "ImportResult");
    // The dividend isn't sent again, nor its bank entry used: it's listed for the user to check.
    assert.deepEqual(result.found.map((f) => [f.transaction.transaction.activity.activityType, f.entryDay]), [["DIVIDEND", "2023-12-28"]]);
    assert.deepEqual(changed, []);
    let tb = result.outcomes.find((a) => a.name === name);
    assert.deepEqual([tb.state, tb.waiting, tb.retryable], ["failed", total, true]);
    assert.equal(find(run, "ReviewHeader").unfinished, true);
    // Try again imports the others, each whole, and only them.
    result.onRetryAccount(key);
    await run.flush();
    assert.equal(imported.length, 2);
    assert.deepEqual(imported[1], refused.filter((r) => !elsewhere.has(r.sourceRecordId)));
    assert.equal(transactionsIn(imported[1]), total - 1);
    assert.deepEqual(changed, []);
    result = find(run, "ImportResult");
    tb = result.outcomes.find((a) => a.name === name);
    assert.deepEqual([tb.state, tb.imported, tb.waiting, tb.retryable], ["failed", total - 1, 1, false]);
    assert.equal(result.found.length, 1);
    assert.ok(Array.isArray(result.closing));
    assert.ok(!result.closing.some((f) => f.schemes.some((s) => s.scheme.startsWith("Testbridge"))), "a fund with found transactions isn't checked");
    assert.doesNotMatch(textOf(run.tree), /Nothing more was imported/);
    // Only the found transaction remains: leaving still asks, without promising it can be retried here.
    assert.ok(result.outcomes.every((a) => !a.retryable));
    find(run, "ReviewHeader").onDiscard();
    await run.flush();
    const question = markup(nodes(run.tree).find((n) => n.type?.name === "ReviewHeader"));
    assert.ok(question.includes("Leaving gives up any retries available here and the answers they need. What's already saved stays in Wealthfolio."), question);
    assert.ok(question.includes("Stay") && question.includes("Leave and choose another file"), question);
  });
}

test("a transaction found after a duplicate refusal names its bank entry on its day in Wealthfolio's timezone", async () => {
  // The dividend's bank entry, made in Wealthfolio's form at 02:00 on 28 Dec in India, is stored on 27 Dec in UTC.
  const dividend = { ...ENTRIES[0], date: "2023-12-27T20:30:00+00:00", sourceSystem: "MANUAL", isUserModified: false };
  const { run, api, key, elsewhere } = await withHeldFolio({ dividend, timeZone: "Asia/Kolkata" });
  // The import's retries keep the review's timezone even if the setting changes.
  api.settings.get = async () => ({ timezone: "UTC" });
  api.activities.import = async (rows) => {
    elsewhere.add(rows.find((r) => r.activityType === "DIVIDEND").sourceRecordId);
    throw hostError("Duplicate activity", "DUPLICATE_ACTIVITY");
  };
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  const result = find(run, "ImportResult");
  assert.deepEqual(result.found.map((f) => f.entryDay), ["2023-12-28"]);
  assert.equal(result.chosen, 1, "the found dividend's entry still counts");
  assert.equal(linkedLine(run), null);
  const lines = shownResult(run).lines;
  assert.ok(lines.some((line) => line.includes("so it wasn't imported again, nor linked with the bank entry of 28 Dec 2023.")), lines.join(" | "));
});

test("an account's duplicate refusal checks only the batch left after both validation steps, and can find it all", async () => {
  const { run, api, imported, name, key, elsewhere, checked, changed, status } = await withHeldFolio();
  const check = api.activities.checkImport;
  let firstCheck = true;
  api.activities.checkImport = async (rows) => {
    const answers = await check(rows);
    if (!firstCheck) return answers;
    firstCheck = false;
    return answers.map((r) => r.activityType === "DIVIDEND" ? { ...r, isValid: false, errors: { general: ["Made-up created-account refusal."] } } : r);
  };
  let attempts = 0;
  let refused;
  let checks;
  api.activities.import = async (rows) => {
    if (++attempts === 1) {
      assert.ok(!rows.some((r) => r.activityType === "DIVIDEND"));
      return { activities: rows.map((r, i) => i ? r : { ...r, errors: { general: ["Made-up import validation refusal."] } }), summary: { success: false } };
    }
    refused = rows;
    checks = checked.length;
    rows.forEach((r) => elsewhere.add(r.sourceRecordId));
    throw hostError("Any message", "DUPLICATE_ACTIVITY");
  };
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.equal(attempts, 2);
  assert.deepEqual(checked.slice(checks), [refused], "only the actually refused batch is rechecked");
  const total = transactionsIn(refused);
  assert.ok(total > 1);
  const said = `Nothing more was imported: Wealthfolio now has these ${total} transactions, in whole or in part, saved elsewhere while the import ran.`;
  assert.ok(textOf(run.tree).includes(said));
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  assert.ok(status().startsWith(said));
  const result = find(run, "ImportResult");
  assert.equal(result.found.length, total);
  assert.deepEqual(result.sent, imported[0], "the refused batch wasn't saved");
  assert.ok(result.result.activities.some((r) => r.errors?.general?.[0] === "Made-up created-account refusal."));
  assert.ok(result.result.activities.some((r) => r.errors?.general?.[0] === "Made-up import validation refusal."));
  assert.equal(result.outcomes.find((a) => a.name === name).retryable, false);
  assert.deepEqual(changed, []);
});

test("recovery from an unchecked duplicate refusal still checks a pending transaction's bank entry before sending", async () => {
  const { run, api, imported, key, elsewhere, activities, changed } = await withHeldFolio();
  const send = api.activities.import;
  const check = api.activities.checkImport;
  let refused;
  let found;
  let sends = 0;
  api.activities.import = async (rows) => {
    sends++;
    if (refused) return send(rows);
    refused = rows;
    found = rowsOfTransaction(rows, rows.find((r) => r.activityType === "BUY"));
    elsewhere.add(found[0].sourceRecordId);
    api.activities.checkImport = async () => { throw new Error("Made-up check failure."); };
    throw hostError("Any message", "DUPLICATE_ACTIVITY");
  };
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  api.activities.checkImport = check;
  const entry = activities.find((a) => a.id === "dividend");
  const amount = entry.amount;
  entry.amount = "1.00";
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.match(textOf(run.tree), /A bank entry you chose changed since the import, so nothing more was imported/);
  assert.equal(sends, 1);
  assert.deepEqual(changed, []);
  entry.amount = amount;
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.equal(sends, 2);
  assert.deepEqual(imported[1], refused.filter((r) => !found.includes(r)));
  assert.deepEqual(changed, ["create", "update", "link"]);
  assert.equal(find(run, "ImportResult").found.length, 1);
});

for (const failure of ["throws", "invalid row", "row errors", "missing row"]) {
  test(`an account's Try again whose refusal couldn't be checked checks first next time, and sends nothing until it can (${failure})`, async () => {
    const { run, api, imported, key, elsewhere, checked } = await withHeldFolio();
    const send = api.activities.import;
    const check = api.activities.checkImport;
    let refused;
    let sends = 0;
    api.activities.import = async (rows) => {
      sends++;
      if (refused) return send(rows);
      refused = rows;
      elsewhere.add(rows.find((r) => r.activityType === "DIVIDEND").sourceRecordId);
      // Wealthfolio's check fails from now on.
      api.activities.checkImport = async (rows) => {
        if (failure === "throws") throw new Error("made-up check failure");
        if (failure === "missing row") return rows.slice(1);
        return rows.map((r) => ({ ...r, ...(failure === "invalid row" ? { isValid: false } : { errors: { general: ["Made-up check failure."] } }) }));
      };
      throw hostError("Duplicate activity", "DUPLICATE_ACTIVITY");
    };
    find(run, "ImportResult").onRetryAccount(key);
    await run.flush();
    assert.match(textOf(run.tree), /Nothing more was imported: Wealthfolio refused it as a duplicate of something saved elsewhere while the import ran, and we couldn't check which of these transactions it has\. Try again\./);
    assert.deepEqual(find(run, "ImportResult").found, []);
    assert.equal(sends, 1);
    // Still not checked: nothing is sent.
    find(run, "ImportResult").onRetryAccount(key);
    await run.flush();
    assert.match(textOf(run.tree), /We couldn't check which of these transactions Wealthfolio has now, so nothing more was imported\. Try again\./);
    assert.equal(sends, 1);
    // Checked: what Wealthfolio has stays out, and the rest goes in.
    api.activities.checkImport = check;
    const checks = checked.length;
    find(run, "ImportResult").onRetryAccount(key);
    await run.flush();
    // The refused transactions are checked first; those sent are then checked in the account created for them, as always.
    const rest = refused.filter((r) => !elsewhere.has(r.sourceRecordId));
    assert.deepEqual(checked.slice(checks), [refused, rest.filter((r) => r.accountId !== "bank")]);
    assert.equal(sends, 2);
    assert.equal(imported.length, 2);
    assert.deepEqual(imported[1], rest);
    assert.equal(transactionsIn(imported[1]), transactionsIn(refused) - 1);
    await new Promise((resolve) => setTimeout(resolve, 85));
    await run.flush();
    assert.match(nodes(run.tree).find((n) => n.props?.role === "status").props.children,
      /^Wealthfolio now has 1 of these transactions, in whole or in part, saved elsewhere, so it wasn't imported again\. /);
    assert.deepEqual(find(run, "ImportResult").found.map((f) => f.transaction.transaction.activity.activityType), ["DIVIDEND"]);
  });
}

test("an account's duplicate refusal with only a known Import anyway match doesn't deny that match exists", async () => {
  const { run, api, imported } = setup({ entries: [] });
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => (await check(rows)).map((r) =>
    r.activityType === "DIVIDEND" ? { ...r, duplicateOfId: "known-dividend" } : r);
  await run.flush();
  const [duplicate] = askCards(run);
  assert.match(duplicate.title, /dividend may already be/);
  duplicate.other.onClick();
  await run.flush();
  for (const ask of askCards(run)) ask.other.onClick();
  await run.flush();
  const send = api.activities.import;
  let attempts = 0;
  let refused;
  api.activities.import = async (rows) => {
    attempts++;
    if (attempts === 1) {
      // One unrelated transaction fails validation; the next send fails outright, leaving a result with held transactions.
      return { activities: rows.map((r, i) => i ? r : { ...r, errors: { general: ["Made-up validation failure."] } }), summary: { success: false } };
    }
    if (attempts === 2) throw new Error("made-up import failure");
    if (attempts === 3) {
      refused = rows;
      throw hostError("Duplicate activity", "DUPLICATE_ACTIVITY");
    }
    return send(rows);
  };
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "ImportResult");
  const key = result.outcomes.find((a) => a.retryable).key;
  result.onRetryAccount(key);
  await run.flush();
  assert.ok(refused.some((r) => r.forceImport && r.activityType === "DIVIDEND"));
  result = find(run, "ImportResult");
  assert.deepEqual(result.found, []);
  assert.match(textOf(run.tree), /but the check couldn't confirm any newly saved transactions\. Try again\./);
  assert.doesNotMatch(textOf(run.tree), /has none of these transactions/);
  result.onRetryAccount(key);
  await run.flush();
  assert.deepEqual(imported, [refused]);
});

test("an account's Try again refused as a duplicate with no new match keeps every transaction for Try again", async () => {
  const { run, api, imported, name, key } = await withHeldFolio();
  const send = api.activities.import;
  let refused;
  api.activities.import = async (rows) => {
    if (refused) return send(rows);
    refused = rows;
    throw hostError("Duplicate activity", "DUPLICATE_ACTIVITY");
  };
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.match(textOf(run.tree), /Nothing more was imported: Wealthfolio refused it as a duplicate of something saved elsewhere while the import ran, but the check couldn't confirm any newly saved transactions\. Try again\./);
  assert.deepEqual(find(run, "ImportResult").found, []);
  assert.equal(find(run, "ImportResult").outcomes.find((a) => a.name === name).retryable, true);
  find(run, "ImportResult").onRetryAccount(key);
  await run.flush();
  assert.deepEqual(imported[1], refused);
  assert.equal(find(run, "ImportResult").outcomes.find((a) => a.name === name).state, "imported");
});

for (const [why, error] of [
  ["no code", hostError("DUPLICATE_ACTIVITY: Duplicate activity already exists")],
  ["another code", hostError("Duplicate activity already exists", "VALIDATION_ERROR")],
]) {
  test(`an account's Try again refused with ${why} keeps today's result, whatever its message says`, async () => {
    const { run, api, imported, name, key, changed, checked } = await withHeldFolio();
    const send = api.activities.import;
    let checks;
    api.activities.import = async () => {
      checks = checked.length;
      throw error;
    };
    find(run, "ImportResult").onRetryAccount(key);
    await run.flush();
    assert.equal(checked.length, checks, "nothing is checked again");
    assert.doesNotMatch(textOf(run.tree), /Nothing more was imported/);
    const result = find(run, "ImportResult");
    assert.deepEqual(result.found ?? [], []);
    assert.deepEqual(changed, []);
    const tb = result.outcomes.find((a) => a.name === name);
    assert.deepEqual([tb.state, tb.imported, tb.retryable], ["failed", 0, true]);
    api.activities.import = send;
    result.onRetryAccount(key);
    await run.flush();
    assert.equal(imported.length, 2);
    assert.equal(find(run, "ImportResult").outcomes.find((a) => a.name === name).state, "imported");
    assert.deepEqual(changed, ["create", "update", "link"]);
  });
}

for (const message of ["Duplicate activity", ""]) {
  test(`a fund transfer Wealthfolio refuses as a duplicate leaves the bank entry for the user, with no Try again (message "${message}")`, async () => {
    const { run, api, steps, logged } = await withChosenEntry();
    api.activities.create = async () => { throw hostError(message, "DUPLICATE_ACTIVITY"); };
    find(run, "Footer").action.onClick();
    await run.flush();
    let result = find(run, "ImportResult");
    assert.deepEqual(result.links.map((l) => [l.stage, l.fundId, l.converted]), [["exists", undefined, false]]);
    // The bank entry isn't changed or linked, nor its categories touched.
    assert.deepEqual(steps, []);
    assert.deepEqual(result.links[0].warnings, []);
    assert.match(logged.join("\n"), /Wealthfolio refused the fund account's transfer as a duplicate/);
    await new Promise((resolve) => setTimeout(resolve, 85));
    await run.flush();
    const notice = () => nodes(run.tree).find((n) => n.props?.role === "status").props.children;
    assert.match(notice(), /: The trade is in Wealthfolio, but Wealthfolio refused the fund account's transfer as a duplicate: it may already have one for the bank entry of 4 May 2023, from an earlier try\. Check the fund account's transfers, then link the bank entry in Wealthfolio\./);
    assert.doesNotMatch(notice(), /Try again to link the bank entry|without its cash|wasn't added/);
    assert.equal(find(run, "ReviewHeader").unfinished, true);
  });

  test(`a bank link's Try again that finds its transfer refused as a duplicate stops there (message "${message}")`, async () => {
    const { run, api, steps } = await withChosenEntry();
    const create = api.activities.create;
    let failure = new Error("made-up create failure");
    api.activities.create = async (row) => {
      if (failure) throw failure;
      return create(row);
    };
    find(run, "Footer").action.onClick();
    await run.flush();
    let result = find(run, "ImportResult");
    assert.equal(result.links[0].stage, "transfer");
    failure = hostError(message, "DUPLICATE_ACTIVITY");
    result.onRetryLink(result.links[0]);
    await run.flush();
    result = find(run, "ImportResult");
    assert.deepEqual(result.links.map((l) => [l.stage, l.fundId, l.converted]), [["exists", undefined, false]]);
    assert.deepEqual(steps, []);
    await new Promise((resolve) => setTimeout(resolve, 85));
    await run.flush();
    assert.match(nodes(run.tree).find((n) => n.props?.role === "status").props.children, /^Still not done\. The trade is in Wealthfolio, but Wealthfolio refused the fund account's transfer as a duplicate/);
  });
}
