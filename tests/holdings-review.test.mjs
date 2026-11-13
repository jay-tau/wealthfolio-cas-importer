// Exercises the real Review controller and search hook with made-up host data, without a browser.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createServer } from "vite";

let server;
let HoldingsImport;
let investorKey;
let sourceKey;
let holdingKey;
let LEFT_OUT;
let active;
const originalDocument = globalThis.document;

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
        if (/src\/(pages\/holdings-import\.tsx|components\/review\/(search\.ts|parts\.tsx))$/.test(id)) {
          return code.replaceAll('from "react"', 'from "review-hooks"');
        }
      },
    }],
  });
  ({ HoldingsImport } = await server.ssrLoadModule("/src/pages/holdings-import.tsx"));
  ({ investorKey, sourceKey, holdingKey, LEFT_OUT } = await server.ssrLoadModule("/src/lib/choices.ts"));
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
function controller(props, Component = HoldingsImport) {
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
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          globalThis.reviewHooks = hooks;
          tree = Component(props);
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
const holding = (isin) => ({ kind: "share", name: `Example ${isin}`, isin, rta: null, rtaCode: null, units: "10", price: "2", value: "20", cost: null });
const source = (id, holdings) => ({ id, kind: "demat", label: id, title: `${id} demat account`, holdings });
function setup(sources, choices = true) {
  globalThis.document = { activeElement: {}, body: {}, hasFocus: () => true, getElementById: () => null };
  const holdings = { investor: "TEST", date: "2025-03-31", sources, leftOut: [] };
  const accounts = ["A", "B"].map((id) => ({ id, name: id, trackingMode: "HOLDINGS", isActive: true, isArchived: false }));
  const api = {
    portfolio: { getHoldings: async () => [] },
    snapshots: { getAll: async () => [], getByDate: async () => [] },
    storage: { get: async () => null },
    assets: { getProfile: async () => ({}) },
    activities: { getAll: async () => [] },
    settings: { get: async () => ({}) },
    market: { searchTicker: async () => [] },
  };
  const props = {
    ctx: { api }, statement: { file_type: "NSDL", investor_info: { name: "Made-up Investor" }, parse_warnings: [] },
    holdings, fileName: "made-up.pdf", accounts, allAccounts: accounts,
    accountChoices: { [investorKey("TEST")]: "A" }, unavailable: {},
    fundChoices: choices ? Object.fromEntries(sources.flatMap((s) => s.holdings).map((h) => [holdingKey(h), {
      fund: { symbol: h.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: h.name, instrumentType: "EQUITY", providerId: "YAHOO" },
    }])) : {},
    amfi: { status: "off", searches: 0 }, visit: {}, busy: "", setBusy() {}, onRemember() {}, onAnother() {},
  };
  active = controller(props);
  return { run: active, props, api };
}

for (const [position, observe] of [["sticky", true], ["static", true], [undefined, true], ["sticky", false]]) {
  test(`the footer keeps scroll padding current and clears it (${position ?? "no header"}, observer ${observe})`, async (t) => {
    const globals = ["getComputedStyle", "ResizeObserver"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    t.after(() => {
      for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
    const { run } = setup([source("X", [holding("ISINX")])]);
    await run.flush();
    const footer = nodes(run.tree).find((node) => node.type?.name === "Footer");
    assert.ok(footer);
    run.dispose();
    active = undefined;

    let headerHeight = 92.3;
    let barHeight = 70.2;
    const header = position ? { getBoundingClientRect: () => ({ height: headerHeight }) } : null;
    const bar = { getBoundingClientRect: () => ({ height: barHeight }) };
    const style = { scrollPaddingTop: "", scrollPaddingBottom: "" };
    document.documentElement = { style };
    document.querySelector = (selector) => {
      assert.equal(selector, "header");
      return header;
    };
    globalThis.getComputedStyle = (element) => {
      assert.equal(element, header);
      return { position };
    };
    let resize;
    let disconnected = false;
    const observed = [];
    if (observe) globalThis.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe(element) { observed.push(element); }
      disconnect() { disconnected = true; }
    };
    else delete globalThis.ResizeObserver;
    active = controller(footer.props, (props) => {
      const tree = footer.type(props);
      tree.props.ref.current = bar;
      return tree;
    });
    await active.flush();
    assert.deepEqual(style, { scrollPaddingTop: position === "sticky" ? "101px" : "8px", scrollPaddingBottom: "79px" });
    if (observe) {
      assert.deepEqual(observed, header ? [bar, header] : [bar]);
      headerHeight = 99.2;
      barHeight = 80.4;
      resize();
      assert.deepEqual(style, { scrollPaddingTop: position === "sticky" ? "108px" : "8px", scrollPaddingBottom: "89px" });
    }
    active.dispose();
    active = undefined;
    assert.equal(disconnected, observe);
    assert.deepEqual(style, { scrollPaddingTop: "", scrollPaddingBottom: "" });
  });
}

test("moving one source closes its vanished cost editor while the old account still has another source", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run } = setup([x, source("Y", [holding("ISINY")])]);
  await run.flush();
  let ready = find(run, "ReadyTable");
  assert.equal(ready.rows.length, 2);
  ready.handlers.onCost(ready.rows.find((row) => row.item.isin === "ISINX"));
  await run.flush();
  assert.ok(find(run, "ReadyTable").handlers.editing);
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.handlers.editing, undefined);
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("moving part of an aggregate discards its old total purchase cost", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run } = setup([x, source("Y", [holding("ISINX")])]);
  await run.flush();
  let ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].position.units, "20");
  ready.handlers.onCost(ready.rows[0]);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("100");
  await run.flush();
  find(run, "ReadyTable").handlers.onSaveCost();
  await run.flush();
  assert.equal(find(run, "ReadyTable").rows[0].cost.total, "100");
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  assert.equal(find(run, "ReadyTable").rows.find((row) => row.accountId === "A").cost, undefined);
});

test("Don't save drops an unanswered typed-search draft", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run } = setup([x], false);
  await run.flush();
  let question = find(run, "QuestionCard");
  question.searches.setText(question.item.key, "typed code");
  await run.flush();
  assert.equal(find(run, "QuestionCard").search.text, "typed code");
  find(run, "SaveTo").onChange(sourceKey(x), LEFT_OUT);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(x), "A");
  await run.flush();
  question = find(run, "QuestionCard");
  assert.equal(question.search.text, "");
  assert.equal(question.search.typed, undefined);
});

test("a typed search settled by a scope change cannot put its old results back", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = setup([x], false);
  await run.flush();
  let question = find(run, "QuestionCard");
  question.searches.setText(question.item.key, "typed code");
  await run.flush();
  let resolve;
  api.market.searchTicker = () => new Promise((done) => { resolve = done; });
  question = find(run, "QuestionCard");
  question.searches.search(question.item);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(x), LEFT_OUT);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(x), "A");
  await run.flush();
  resolve([{ symbol: "EXAMPLE", longName: "Example Share", currency: "INR", quoteType: "EQUITY" }]);
  await run.flush();
  assert.equal(find(run, "QuestionCard").search.typed, undefined);
});

test("typed results leave focus where the user moved it during the search", async () => {
  const { run, api } = setup([source("X", [holding("ISINX")])], false);
  await run.flush();
  let question = find(run, "QuestionCard");
  question.searches.setText(question.item.key, "code");
  await run.flush();
  let resolve;
  api.market.searchTicker = () => new Promise((done) => { resolve = done; });
  question = find(run, "QuestionCard");
  question.searches.search(question.item);
  await run.flush();
  document.activeElement = {};
  let focused = false;
  document.getElementById = () => ({ dataset: {}, focus() { focused = true; }, scrollIntoView() {} });
  resolve([{ symbol: "EXAMPLE", longName: "Example Share", currency: "INR", quoteType: "EQUITY" }]);
  await run.flush();
  assert.equal(focused, false);
});

test("an AMFI match does not remove a question the user has started interacting with", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund - Direct Plan - Growth" };
  const { run, api } = setup([source("X", [fund])], false);
  await run.flush();
  let resolve;
  api.market.searchTicker = () => new Promise((done) => { resolve = done; });
  let question = find(run, "QuestionCard");
  question.searches.retry(question.item);
  await run.flush();
  question = find(run, "QuestionCard");
  question.searches.interact(question.item.key);
  const match = { symbol: "100123", longName: fund.name, currency: "INR", quoteType: "MUTUALFUND", providerId: "AMFI" };
  resolve([match]);
  await run.flush();
  assert.ok(find(run, "QuestionCard"));
  assert.equal(find(run, "ReadyTable"), undefined);
  run.dispose();
  const control = setup([source("X", [fund])], false);
  control.api.market.searchTicker = async () => [match];
  await control.run.flush();
  assert.equal(find(control.run, "QuestionCard"), undefined, "the same AMFI result confirms an untouched question");
  assert.equal(find(control.run, "ReadyTable").rows.length, 1);
});

test("the last asset answer does not announce ready while an account question remains", async () => {
  const { run, props } = setup([source("X", [holding("ISINX")])], false);
  props.accountChoices = {};
  await run.flush();
  const question = find(run, "QuestionCard");
  question.onAnswer({ fund: question.item.statementAsset });
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await run.flush();
  const status = nodes(run.tree).find((node) => node.props?.role === "status");
  assert.doesNotMatch(status.props.children, /All questions answered\. Ready to save\./);
  assert.equal(find(run, "Footer").action.disabled, true);
});

test("typed results receive focus when the user has stayed on the search control", async () => {
  const { run, api } = setup([source("X", [holding("ISINX")])], false);
  await run.flush();
  let question = find(run, "QuestionCard");
  question.searches.setText(question.item.key, "code");
  await run.flush();
  let resolve;
  api.market.searchTicker = () => new Promise((done) => { resolve = done; });
  question = find(run, "QuestionCard");
  question.searches.search(question.item);
  await run.flush();
  let focused = false;
  document.getElementById = () => ({ dataset: {}, focus() { focused = true; }, scrollIntoView() {} });
  resolve([{ symbol: "EXAMPLE", longName: "Example Share", currency: "INR", quoteType: "EQUITY" }]);
  await run.flush();
  assert.equal(focused, true);
});

test("an old prepare run cannot populate the refreshed visit's read cache", async () => {
  const { run, api } = setup([source("X", [holding("ISINX")])]);
  const snapshots = [];
  api.snapshots.getAll = () => new Promise((resolve) => snapshots.push(resolve));
  const reads = [];
  api.storage.get = async (key) => { reads.push(key); return null; };
  await run.flush();
  assert.equal(snapshots.length, 1);
  run.update({ visit: {} });
  await run.flush();
  assert.equal(snapshots.length, 2);
  snapshots[0]([{ snapshotDate: "2025-02-28", source: "MANUAL" }]);
  await run.flush();
  const imported = reads.find((key) => key.startsWith("holdings-imported:"));
  assert.ok(imported, "the older run reached its import-record read");
  snapshots[1]([{ snapshotDate: "2025-02-28", source: "MANUAL" }]);
  await run.flush();
  assert.equal(reads.filter((key) => key === imported).length, 2, "each visit reads its own import record");
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("plans using a cached snapshot receive separate mutable copies", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = setup([x, source("Y", [holding("ISINY")])]);
  let reads = 0;
  api.snapshots.getAll = async (accountId) => accountId === "A" ? [{ snapshotDate: "2025-02-28", source: "MANUAL" }] : [];
  api.snapshots.getByDate = async () => {
    reads++;
    return [{ holdingType: "security", quantity: "5", costBasis: null, localCurrency: "INR", instrument: { id: "old", name: "Earlier Share", symbol: "OTHER", quoteMode: "MARKET" } }];
  };
  api.assets.getProfile = async () => ({ instrumentSymbol: "OTHER", instrumentExchangeMic: "XBOM" });
  await run.flush();
  const see = nodes(find(run, "Footer").lines).find((node) => node.type?.name === "LinkButton");
  see.props.onClick();
  await run.flush();
  const first = find(run, "SnapshotTable").plan.existing;
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  const next = find(run, "SnapshotTable").plan.existing;
  assert.equal(reads, 1, "the account snapshot read was cached");
  assert.notEqual(first, next);
  assert.notEqual(first.positions[0], next.positions[0]);
  next.positions[0].ref = "changed only in the new plan";
  assert.equal(first.positions[0].ref, "OTHER@XBOM");
});

test("saving waits for a plan prepared from the current destination", async () => {
  const { run, api, props } = setup([source("X", [holding("ISINX")])]);
  const saved = [];
  let remembered = 0;
  api.snapshots.save = async (accountId) => saved.push(accountId);
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  props.onRemember = () => remembered++;
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  let resolve;
  api.snapshots.getAll = () => new Promise((done) => { resolve = done; });
  find(run, "SaveTo").onChange(investorKey("TEST"), "B");
  await run.flush();
  const action = find(run, "Footer").action;
  assert.equal(action.disabled, true);
  action.onClick();
  await run.flush();
  assert.deepEqual(saved, []);
  assert.equal(remembered, 0);
  resolve([]);
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(saved, ["B"]);
  assert.equal(remembered, 1);
});


test("the result repeats plan differences only for snapshots that were saved", async () => {
  for (const failed of [false, true]) {
    const fund = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund - Direct Plan - Growth" };
    const { run, api, props } = setup([source("X", [fund])]);
    props.fundChoices[holdingKey(fund)].fund.name = "Example Fund - Regular Plan - Growth";
    api.snapshots.save = async () => { if (failed) throw new Error("made-up failure"); };
    api.storage.set = async () => {};
    api.query = { invalidateQueries() {} };
    await run.flush();
    find(run, "Footer").action.onClick();
    await run.flush();
    const warnings = nodes(run.tree).filter((node) => node.type === "p" && node.props.className === "text-warning text-sm");
    assert.equal(warnings.length, failed ? 0 : 1);
    if (!failed) assert.ok(JSON.stringify(warnings[0].props.children).includes("Different plan."));
    run.dispose();
  }
});

test("excluding one overlap clears its cost and preserves another holding's open editor", async () => {
  const one = { ...holding("INFZ90A01017"), kind: "fund" };
  const two = { ...holding("INFZ90B01015"), kind: "fund" };
  const folio = { ...source("X", [one, two]), kind: "folio" };
  const { run, props, api } = setup([folio]);
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [one, two].map((fund) => ({
    holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: fund.isin, symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM" });
  await run.flush();
  for (const fund of [one, two]) {
    find(run, "NotIncluded").onSaveBoth(holdingKey(fund));
    await run.flush();
  }
  let ready = find(run, "ReadyTable");
  ready.handlers.onCost(ready.rows.find((row) => row.item.isin === one.isin));
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("100");
  await run.flush();
  find(run, "ReadyTable").handlers.onSaveCost();
  await run.flush();
  ready = find(run, "ReadyTable");
  const other = ready.rows.find((row) => row.item.isin === two.isin);
  ready.handlers.onCost(other);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  find(run, "NotIncluded").onDontSave(holdingKey(one));
  await run.flush();
  assert.equal(find(run, "ReadyTable").handlers.editing.rowId, other.id);
  assert.equal(find(run, "ReadyTable").handlers.editing.draft, "200");
  find(run, "ReadyTable").handlers.onCancelCost();
  await run.flush();
  find(run, "NotIncluded").onSaveBoth(holdingKey(one));
  await run.flush();
  assert.equal(find(run, "ReadyTable").rows.find((row) => row.item.isin === one.isin).cost, undefined);
});

async function saveCost(run, isin, amount) {
  const ready = find(run, "ReadyTable");
  ready.handlers.onCost(ready.rows.find((row) => row.item.isin === isin));
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft(amount);
  await run.flush();
  find(run, "ReadyTable").handlers.onSaveCost();
  await run.flush();
}

test("changing a holding into another row clears that row's old total cost without clearing unrelated costs", async () => {
  const x = holding("ISINX");
  const y = holding("ISINY");
  const z = holding("ISINZ");
  const { run, props } = setup([source("X", [x, y, z])]);
  await run.flush();
  await saveCost(run, y.isin, "100");
  await saveCost(run, z.isin, "300");
  let ready = find(run, "ReadyTable");
  ready.handlers.onChange(ready.rows.find((row) => row.item.isin === x.isin));
  await run.flush();
  ready = find(run, "ReadyTable");
  const changing = ready.rows.find((row) => row.item.isin === x.isin);
  nodes(ready.handlers.changePanel(changing)).find((node) => node.type?.name === "Picker").props.onUse(props.fundChoices[holdingKey(y)].fund);
  await run.flush();
  ready = find(run, "ReadyTable");
  const merged = ready.rows.find((row) => row.position.ref === "ISINY@XBOM");
  assert.equal(merged.position.units, "20");
  assert.equal(merged.cost, undefined);
  assert.equal(ready.rows.find((row) => row.item.isin === z.isin).cost.total, "300");
});

test("answering a holding as an existing row clears that row's old total and open cost edit", async () => {
  const x = holding("ISINX");
  const y = holding("ISINY");
  const { run, props } = setup([source("X", [x, y])]);
  delete props.fundChoices[holdingKey(x)];
  await run.flush();
  await saveCost(run, y.isin, "100");
  let ready = find(run, "ReadyTable");
  ready.handlers.onCost(ready.rows.find((row) => row.item.isin === y.isin));
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  find(run, "QuestionCard").onAnswer({ fund: props.fundChoices[holdingKey(y)].fund });
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].position.units, "20");
  assert.equal(ready.rows[0].cost, undefined);
  assert.equal(ready.handlers.editing, undefined);
  await saveCost(run, x.isin, "400");
  find(run, "AnsweredLine").onChange();
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].position.units, "10");
  assert.equal(ready.rows[0].cost, undefined, "reopening the answer changes the aggregate too");
});

test("removing a statement row under Before saving clears its cost and closes its cost editor", async () => {
  const x = holding("ISINX");
  const first = source("X", [x]);
  const ignored = source("Y", [{ ...x }]);
  const { run, props, api } = setup([first, ignored]);
  props.accountChoices[sourceKey(ignored)] = LEFT_OUT;
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => [{ holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR", instrument: { id: "old", name: x.name, symbol: x.isin, quoteMode: "MARKET" } }];
  api.assets.getProfile = async () => ({ instrumentSymbol: x.isin, instrumentExchangeMic: "XBOM" });
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, ignored, "A", "2025-02-28", { "ISINX@XBOM": [x.isin] });
  await run.flush();
  let before = find(run, "BeforeSaving");
  const position = before.plan.positions.find((p) => p.lines.length);
  assert.equal(position.include, false);
  before.onFlip(position.key);
  await run.flush();
  await saveCost(run, x.isin, "100");
  let ready = find(run, "ReadyTable");
  ready.handlers.onCost(ready.rows[0]);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  find(run, "BeforeSaving").onFlip(position.key);
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.equal(find(run, "Footer").action.disabled, false);
  find(run, "BeforeSaving").onFlip(position.key);
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].cost, undefined);
  assert.equal(ready.handlers.editing, undefined);
});

test("saving a shared overlap includes every contributing holding and either warning can exclude it", async () => {
  const one = { ...holding("INFZ90A01017"), kind: "fund" };
  const two = { ...holding("INFZ90B01015"), kind: "fund" };
  const { run, props, api } = setup([{ ...source("X", [one, two]), kind: "folio" }]);
  for (const choice of Object.values(props.fundChoices)) choice.fund.symbol = "SHARED";
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [{
    holdingType: "security", quantity: "20", localCurrency: "INR", instrument: { id: "shared", symbol: "SHARED", name: "Shared Fund", quoteMode: "MARKET" },
  }];
  api.assets.getProfile = async () => ({ instrumentSymbol: "SHARED", instrumentExchangeMic: "XBOM" });
  await run.flush();
  find(run, "NotIncluded").onSaveBoth(holdingKey(one));
  await run.flush();
  const included = find(run, "NotIncluded");
  assert.equal(find(run, "ReadyTable").rows[0].position.units, "20");
  assert.deepEqual(new Set(included.counted.map((fund) => fund.key)), new Set([holdingKey(one), holdingKey(two)]));
  assert.ok(included.tracked.every((group) => group.funds.every((fund) => fund.included)));
  included.onDontSave(holdingKey(two));
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.equal(find(run, "NotIncluded").counted.length, 0);
});

test("the saved overlap summary keeps negative tracked units when calculating a difference", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund", units: "20", value: "40" };
  const { run, props, api } = setup([{ ...source("X", [fund]), kind: "folio" }, source("Y", [holding("ISINY")])]);
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [{
    holdingType: "security", quantity: "-10", localCurrency: "INR", instrument: { id: "tracked", symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
  }];
  api.assets.getProfile = async () => ({ instrumentSymbol: fund.isin, instrumentExchangeMic: "XBOM" });
  api.activities.getAll = async () => [{ accountId: "T", assetId: "tracked", activityType: "SELL", status: "POSTED", quantity: "10", date: "2025-03-01" }];
  api.snapshots.save = async () => {};
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  const comparison = find(run, "NotIncluded").tracked[0].funds[0].comparison;
  assert.equal(comparison.kind, "differ");
  assert.equal(comparison.theirs, "-10.000 units");
  find(run, "Footer").action.onClick();
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  const summary = nodes(run.tree).find((node) => node.type === "p" && textOf(node).includes("already tracked in Mutual funds"));
  assert.match(textOf(summary), /differs by 30\.000 units/);
});

test("an empty or failed button search returns focus to its field unless the user moved it", async () => {
  for (const failed of [false, true]) for (const moved of [false, true]) {
    const { run, api } = setup([source("X", [holding("ISINX")])], false);
    await run.flush();
    let question = find(run, "QuestionCard");
    question.searches.setText(question.item.key, "typed code");
    await run.flush();
    let finish;
    api.market.searchTicker = () => new Promise((resolve, reject) => {
      finish = () => failed ? reject(new Error("made-up failure")) : resolve([]);
    });
    document.activeElement = { control: "Search button" };
    question = find(run, "QuestionCard");
    question.searches.search(question.item);
    await run.flush();
    if (moved) document.activeElement = { control: "somewhere else" };
    let focused;
    document.getElementById = (id) => ({ dataset: {}, focus() { focused = id; }, scrollIntoView() {} });
    finish();
    await run.flush();
    if (moved) assert.equal(focused, undefined);
    else assert.match(focused ?? "", /-field$/, failed ? "a failed search" : "an empty search");
    run.dispose();
  }
});

test("the saved result preserves a plan conflict from the second statement holding of a merged row", async () => {
  const direct = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund - Direct Plan - Growth" };
  const regular = { ...holding("INFZ90B01015"), kind: "fund", name: "Example Fund - Regular Plan - Growth" };
  const { run, props, api } = setup([source("X", [direct, regular])]);
  for (const choice of Object.values(props.fundChoices)) {
    choice.fund.symbol = "SHARED";
    choice.fund.name = direct.name;
  }
  api.snapshots.save = async () => {};
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  const row = find(run, "ReadyTable").rows[0];
  assert.equal(row.position.lines.length, 2);
  find(run, "Footer").action.onClick();
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.match(textOf(run.tree), /Statement: Regular · Growth\. Chosen: Direct · Growth\. Different plan\./);
});

test("a failed plan exposes Try again while preserving an unrelated hidden editor's draft", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, api } = setup([x, y]);
  await run.flush();
  const ready = find(run, "ReadyTable");
  const edited = ready.rows.find((row) => row.item.isin === "ISINY");
  ready.handlers.onCost(edited);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  api.snapshots.getAll = async (id) => { if (id === "B") throw new Error("made-up read failure"); return []; };
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  const footer = find(run, "Footer");
  assert.equal(footer.go.label, "Try again");
  assert.ok(JSON.stringify(footer.lines).includes("made-up read failure"));
  api.snapshots.getAll = async () => [];
  footer.go.onClick();
  await run.flush();
  const recovered = find(run, "ReadyTable");
  assert.equal(recovered.handlers.editing.rowId, edited.id);
  assert.equal(recovered.handlers.editing.draft, "200");
  recovered.handlers.onSaveCost();
  await run.flush();
  assert.equal(find(run, "ReadyTable").rows.find((row) => row.id === edited.id).cost.total, "200");
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("a merged row can change its second statement holding without changing the first", async () => {
  const one = holding("ISINX");
  const two = holding("ISINY");
  const { run, props } = setup([source("X", [one, two])]);
  for (const choice of Object.values(props.fundChoices)) {
    choice.fund.symbol = "SHARED";
    choice.fund.name = "Shared listing";
  }
  await run.flush();
  let ready = find(run, "ReadyTable");
  const merged = ready.rows[0];
  assert.deepEqual(new Set(merged.items?.map((item) => item.key)), new Set([holdingKey(one), holdingKey(two)]));
  const selected = merged.items.find((item) => item.key === holdingKey(two));
  ready.handlers.onChange(merged, selected);
  await run.flush();
  ready = find(run, "ReadyTable");
  ready.handlers.onChange(ready.rows[0], merged.items.find((item) => item.key === holdingKey(one)));
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.handlers.changingItem, selected.key, "another Change in the same row keeps the open edit");
  assert.equal(ready.handlers.nag, true);
  const panel = ready.handlers.changePanel(ready.rows[0]);
  const picker = nodes(panel).find((node) => node.type?.name === "Picker").props;
  assert.equal(picker.item.key, holdingKey(two));
  const focused = [];
  document.activeElement = document.body;
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  picker.onUse({ symbol: "SEPARATE", exchangeMic: "XBOM", quoteCcy: "INR", name: "Separate listing", instrumentType: "EQUITY", providerId: "YAHOO" });
  await run.flush();
  ready = find(run, "ReadyTable");
  const first = ready.rows.find((row) => row.position.lines.some((line) => line.holding.isin === one.isin));
  const second = ready.rows.find((row) => row.position.lines.some((line) => line.holding.isin === two.isin));
  assert.equal(first.position.ref, "SHARED@XBOM");
  assert.equal(second.position.ref, "SEPARATE@XBOM");
  assert.equal(first.position.units, "10");
  assert.equal(second.position.units, "10");
  assert.equal(focused.at(-1), ready.handlers.ids(second, selected).change);
});


test("Finish remains available when no source is saved and an unused host read fails", async () => {
  const { run, api, props } = setup([source("X", [holding("ISINX")])]);
  props.accountChoices = { [investorKey("TEST")]: LEFT_OUT };
  api.portfolio.getHoldings = async () => { throw new Error("made-up failure"); };
  await run.flush();
  const footer = find(run, "Footer");
  assert.equal(footer.lines[0].props.children, "Nothing from this statement will be saved.");
  assert.equal(footer.action.label, "Finish");
  assert.equal(footer.action.disabled, false);
  assert.equal(footer.go, undefined);
});

test("a resolved statement-price choice shows the asset's current market pricing and preferred provider", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund - Direct Plan - Growth" };
  const { run, props, api } = setup([source("X", [fund])]);
  const { statementAsset } = await server.ssrLoadModule("/src/cas/holdings.ts");
  const { pricesFrom, usePricesFrom } = await server.ssrLoadModule("/src/components/review/parts.tsx");
  props.fundChoices[holdingKey(fund)] = { fund: statementAsset(fund) };
  api.market.searchTicker = async () => [{ existingAssetId: "live-asset", symbol: fund.isin, longName: fund.name, quoteType: "MUTUALFUND", quoteMode: "MARKET", currency: "INR", providerId: "CUSTOM" }];
  let profiles = 0;
  api.assets.getProfile = async (id) => {
    assert.equal(id, "live-asset");
    profiles++;
    return { id, instrumentSymbol: fund.isin, instrumentExchangeMic: null, quoteMode: "MARKET", providerConfig: { preferred_provider: "AMFI" } };
  };
  await run.flush();
  const row = find(run, "ReadyTable").rows[0];
  assert.equal(row.position.asset.assetId, "live-asset");
  assert.equal(row.position.asset.manual, false);
  assert.equal(row.fund.assetId, "live-asset");
  assert.equal(row.fund.manual, false);
  assert.notEqual(pricesFrom(row.item, row.fund), "Prices from the statement");
  run.dispose();
  const reads = profiles;
  active = controller({ ctx: props.ctx, item: row.item, fund: row.fund }, ({ ctx, item, fund }) => usePricesFrom(ctx, item, fund));
  await active.flush();
  assert.equal(active.tree, "Prices from AMFI");
  assert.equal(profiles, reads + 1, "the source hook checks the resolved asset's current provider");
});

async function beforeSavingEditor(mode) {
  const a = source("A", [holding("ISINA")]);
  const b = source("B", [holding("ISINB")]);
  const ignored = source("ignored", [holding("ISINB")]);
  const { run, props, api } = setup([a, b, ignored]);
  const answer = props.fundChoices[holdingKey(a.holdings[0])];
  if (mode !== "account") delete props.fundChoices[holdingKey(a.holdings[0])];
  props.accountChoices[sourceKey(ignored)] = LEFT_OUT;
  if (mode === "holding") props.accountChoices[sourceKey(a)] = LEFT_OUT;
  if (mode === "account") props.accountChoices = { [sourceKey(a)]: "A", [sourceKey(b)]: "A", [sourceKey(ignored)]: LEFT_OUT };
  api.snapshots.getAll = async (id) => id === "A" ? [{ snapshotDate: "2025-02-28", source: "MANUAL" }] : [];
  api.snapshots.getByDate = async () => [{ holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR", instrument: { id: "old", name: "Example ISINB", symbol: "ISINB", quoteMode: "MARKET" } }];
  api.assets.getProfile = async () => ({ instrumentSymbol: "ISINB", instrumentExchangeMic: "XBOM" });
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, ignored, "A", "2025-02-28", { "ISINB@XBOM": ["ISINB"] });
  await run.flush();
  if (mode === "answer") {
    find(run, "QuestionCard").onAnswer(answer);
    await run.flush();
  }
  const before = find(run, "BeforeSaving");
  const position = before.plan.positions.find((p) => p.lines.some((line) => line.holding.isin === "ISINB"));
  assert.equal(position.include, false);
  nodes(before.change(position)).find((node) => node.type?.name === "LinkButton").props.onClick();
  await run.flush();
  const picker = () => {
    const current = find(run, "BeforeSaving");
    const p = current.plan.positions.find((p) => p.lines.some((line) => line.holding.isin === "ISINB"));
    const panel = current.change(p);
    return { panel, props: nodes(panel).find((node) => node.type?.name === "Picker").props };
  };
  const opened = picker().props;
  opened.searches.setText(opened.item.key, "typed B draft");
  await run.flush();
  return { run, a, b, picker };
}

test("reopening an answer keeps an excluded holding's Before saving Change editor visible", async () => {
  const { run, picker } = await beforeSavingEditor("answer");
  find(run, "AnsweredLine").onChange();
  await run.flush();
  assert.equal(find(run, "QuestionCard"), undefined);
  const kept = picker();
  assert.equal(kept.props.item.key, "isin:ISINB");
  assert.equal(kept.props.search.text, "typed B draft");
  assert.ok(JSON.stringify(kept.panel).includes("Save or cancel this edit first."));
});

test("account changes cannot hide an applicable Before saving editor behind new holding or account questions", async () => {
  for (const mode of ["holding", "account"]) {
    const { run, a, b, picker } = await beforeSavingEditor(mode);
    const before = find(run, "SaveTo").values[sourceKey(a)];
    find(run, "SaveTo").onChange(sourceKey(a), mode === "holding" ? "A" : "");
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(a)], before);
    assert.equal(find(run, "QuestionCard"), undefined);
    const kept = picker();
    assert.equal(kept.props.item.key, "isin:ISINB");
    assert.equal(kept.props.search.text, "typed B draft");
    assert.ok(JSON.stringify(kept.panel).includes("Save or cancel this edit first."));
    find(run, "SaveTo").onChange(sourceKey(b), "B");
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(b)], "B", "moving the edited holding still applies");
    assert.equal(find(run, "ReadyTable").handlers.changing, undefined);
    run.dispose();
  }
});

test("Use another file asks to discard a radio choice that has not been used yet", async () => {
  const { run, props, api } = setup([source("X", [holding("ISINX")])], false);
  let departures = 0;
  props.onAnother = () => departures++;
  api.market.searchTicker = async () => [
    { symbol: "EXAMPLE", longName: "Example Share", exchangeMic: "XNSE", currency: "INR", quoteType: "EQUITY", providerId: "YAHOO" },
    { symbol: "EXAMPLE", longName: "Example Share", exchangeMic: "XBOM", currency: "INR", quoteType: "EQUITY", providerId: "YAHOO" },
  ];
  await run.flush();
  const question = find(run, "QuestionCard");
  assert.equal(question.search.auto.results.length, 2);
  question.searches.pick(question.item.key, "auto:0");
  await run.flush();
  assert.equal(find(run, "QuestionCard").search.picked, "auto:0");
  nodes(run.tree).find((node) => node.props?.children === "Use another file").props.onClick();
  await run.flush();
  assert.equal(departures, 0);
  assert.ok(nodes(run.tree).some((node) => node.props?.children === "Keep reviewing"));
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.match(textOf(run.tree), /Discard your 1 change and choose another file\?/);
});

test("Cancel keeps a reordered ready row visible so focus can return to its Change button", async () => {
  const x = source("X", [{ ...holding("ISINX"), cost: "100" }]);
  const y = source("Y", Array.from({ length: 6 }, (_, i) => ({ ...holding(`ISINY${i}`), cost: "100" })));
  const { run, props } = setup([x, y]);
  props.accountChoices[sourceKey(x)] = LEFT_OUT;
  const { ReadyTable } = await server.ssrLoadModule("/src/components/review/ready.tsx");
  const visible = (ready) => nodes(ReadyTable(ready)).filter((node) => node.type?.name === "RowHead").map((node) => node.props.row);
  await run.flush();
  let ready = find(run, "ReadyTable");
  const edited = ready.rows[2];
  ready.handlers.onChange(edited);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(x), "A");
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.rows.findIndex((row) => row.id === edited.id), 3);
  assert.ok(visible(ready).some((row) => row.id === edited.id), "the open edit stays visible after the reorder");
  const focusId = ready.handlers.ids(ready.rows[3]).change;
  let focused;
  document.getElementById = (id) => {
    const current = find(run, "ReadyTable");
    if (!current || !visible(current).some((row) => current.handlers.ids(row).change === id)) return null;
    return { dataset: {}, focus() { focused = id; }, scrollIntoView() {} };
  };
  nodes(ready.handlers.changePanel(ready.rows[3])).find((node) => node.props?.children === "Cancel").props.onClick();
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.ok(visible(ready).some((row) => row.id === edited.id), "Cancel leaves its return-focus button visible");
  assert.equal(ready.rows.find((row) => row.id === edited.id).touched, true);
  assert.equal(focused, focusId);
});

test("an editor closed by a source move does not leave its nag on the next editor", async () => {
  for (const kind of ["cost", "change"]) {
    const x = source("X", [holding("ISINX")]);
    const { run } = setup([x, source("Y", [holding("ISINY")])]);
    await run.flush();
    let ready = find(run, "ReadyTable");
    ready.handlers.onCost(ready.rows.find((row) => row.item.isin === "ISINX"));
    await run.flush();
    ready = find(run, "ReadyTable");
    ready.handlers.onCost(ready.rows.find((row) => row.item.isin === "ISINY"));
    await run.flush();
    assert.equal(find(run, "ReadyTable").handlers.nag, true);
    find(run, "SaveTo").onChange(sourceKey(x), "B");
    await run.flush();
    ready = find(run, "ReadyTable");
    assert.equal(ready.handlers.editing, undefined);
    const row = ready.rows.find((row) => row.item.isin === "ISINY");
    if (kind === "cost") ready.handlers.onCost(row);
    else ready.handlers.onChange(row);
    await run.flush();
    ready = find(run, "ReadyTable");
    assert.equal(kind === "cost" ? ready.handlers.editing.rowId : ready.handlers.changing, row.id);
    assert.equal(ready.handlers.nag, false, "the new editor has no blocked action to explain");
    run.dispose();
  }
});

test("each account in a multi-account overlap has its own transaction link before and after saving", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund", units: "20", value: "40" };
  const { run, props, api } = setup([{ ...source("X", [fund]), kind: "folio" }, source("Y", [holding("ISINY")])]);
  const accounts = [{ id: "T1", name: "First funds" }, { id: "T2", name: "Second funds" }];
  props.allAccounts = [...props.allAccounts, ...accounts.map((a) => ({ ...a, trackingMode: "TRANSACTIONS", isArchived: false }))];
  api.portfolio.getHoldings = async (id) => !accounts.some((a) => a.id === id) ? [] : [{
    holdingType: "security", quantity: id === "T1" ? "4" : "5", localCurrency: "INR", instrument: { id: "tracked", symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
  }];
  api.assets.getProfile = async () => ({ instrumentSymbol: fund.isin, instrumentExchangeMic: "XBOM" });
  api.activities.getAll = async () => accounts.map((a) => ({ accountId: a.id, assetId: "tracked", activityType: "BUY", status: "POSTED", quantity: a.id === "T1" ? "4" : "5", date: "2025-03-01" }));
  const routes = [];
  api.navigation = { navigate: async (route) => routes.push(route) };
  api.snapshots.save = async () => {};
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  const notIncluded = find(run, "NotIncluded");
  const comparison = notIncluded.tracked[0].funds[0].comparison;
  assert.equal(comparison.kind, "differ");
  assert.deepEqual(comparison.accounts.map(({ id, name }) => ({ id, name })), accounts);
  const { NotIncluded } = await server.ssrLoadModule("/src/components/review/not-included.tsx");
  const tracked = nodes(NotIncluded(notIncluded)).find((node) => node.type?.name === "Tracked");
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  const reviewLinks = (tree) => nodes(tree).filter((node) => node.type?.name === "LinkButton" && textOf(node).startsWith("Review its transactions in "));
  const before = reviewLinks(tracked.type(tracked.props));
  assert.deepEqual(before.map(textOf), accounts.map((a) => `Review its transactions in ${a.name}`));
  before.forEach((link) => link.props.onClick());
  assert.deepEqual(routes, ["/accounts/T1", "/accounts/T2"]);
  routes.length = 0;
  find(run, "Footer").action.onClick();
  await run.flush();
  const after = reviewLinks(run.tree);
  assert.deepEqual(after.map(textOf), accounts.map((a) => `Review its transactions in ${a.name}`));
  after.forEach((link) => link.props.onClick());
  assert.deepEqual(routes, ["/accounts/T1", "/accounts/T2"]);
});

test("equal shortened overlap names keep distinct labels when one is saved in both accounts", async () => {
  const direct = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund - Direct Plan - Growth" };
  const regular = { ...holding("INFZ90B01015"), kind: "fund", name: "Example Fund - Regular Plan - Growth" };
  const { run, props, api } = setup([{ ...source("X", [direct, regular]), kind: "folio" }]);
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [direct, regular].map((fund) => ({
    holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: fund.isin, symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM" });
  await run.flush();
  const funds = find(run, "NotIncluded").tracked[0].funds;
  assert.deepEqual(funds.map((fund) => fund.name), ["Example Fund", "Example Fund"]);
  assert.deepEqual(funds.map((fund) => fund.label), ["Example Fund, fund 1", "Example Fund, fund 2"]);
  find(run, "NotIncluded").onSaveBoth(holdingKey(direct));
  await run.flush();
  const included = find(run, "NotIncluded");
  assert.equal(included.counted[0].label, "Example Fund, fund 1");
  assert.equal(included.tracked[0].funds.find((fund) => fund.key === holdingKey(regular)).label, "Example Fund, fund 2");
});

test("same-named tracked accounts keep global names across separate fund comparisons and the saved result", async () => {
  const one = { ...holding("INFZ90A01017"), kind: "fund", name: "First Fund - Direct Plan - Growth", units: "20", value: "40" };
  const two = { ...holding("INFZ90B01015"), kind: "fund", name: "Second Fund - Direct Plan - Growth", units: "20", value: "40" };
  const { run, props, api } = setup([{ ...source("X", [one, two]), kind: "folio" }, source("Y", [holding("ISINY")])]);
  const accounts = [{ id: "T1", name: "Funds" }, { id: "T2", name: "Funds" }];
  props.allAccounts = [...props.allAccounts, ...accounts.map((a) => ({ ...a, trackingMode: "TRANSACTIONS", isArchived: false }))];
  api.portfolio.getHoldings = async (id) => !accounts.some((a) => a.id === id) ? [] : [{
    holdingType: "security", quantity: id === "T1" ? "4" : "5", localCurrency: "INR",
    instrument: { id: id === "T2" ? one.isin : two.isin, symbol: id === "T2" ? one.isin : two.isin, name: id === "T2" ? one.name : two.name, quoteMode: "MARKET" },
  }];
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM" });
  api.activities.getAll = async () => accounts.map((a) => ({ accountId: a.id, assetId: a.id === "T2" ? one.isin : two.isin, activityType: "BUY", status: "POSTED", quantity: a.id === "T1" ? "4" : "5", date: "2025-03-01" }));
  const routes = [];
  api.navigation = { navigate: async (route) => routes.push(route) };
  api.snapshots.save = async () => {};
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  const notIncluded = find(run, "NotIncluded");
  assert.deepEqual(notIncluded.tracked.map((group) => group.accounts), ["Funds, account 2", "Funds, account 1"]);
  assert.deepEqual(notIncluded.tracked.map((group) => group.funds[0].comparison.accounts.map((a) => a.name)), [["Funds, account 2"], ["Funds, account 1"]]);
  const { NotIncluded } = await server.ssrLoadModule("/src/components/review/not-included.tsx");
  const groups = nodes(NotIncluded(notIncluded)).filter((node) => node.type?.name === "Tracked");
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  const reviewLinks = (tree) => nodes(tree).filter((node) => node.type?.name === "LinkButton" && textOf(node).startsWith("Review its transactions in "));
  const before = groups.flatMap((group) => reviewLinks(group.type(group.props)));
  assert.deepEqual(before.map(textOf), ["Review its transactions in Funds, account 2", "Review its transactions in Funds, account 1"]);
  before.forEach((link) => link.props.onClick());
  assert.deepEqual(routes, ["/accounts/T2", "/accounts/T1"]);
  routes.length = 0;
  find(run, "Footer").action.onClick();
  await run.flush();
  const after = reviewLinks(run.tree);
  assert.deepEqual(after.map(textOf), ["Review its transactions in Funds, account 2"]);
  after[0].props.onClick();
  assert.deepEqual(routes, ["/accounts/T2"]);
});

test("a queued editor reminder does not take focus back from the host when a delayed plan restores its field", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, api } = setup([x, y]);
  const answer = props.fundChoices[holdingKey(x.holdings[0])];
  delete props.fundChoices[holdingKey(x.holdings[0])];
  await run.flush();
  find(run, "QuestionCard").onAnswer(answer);
  await run.flush();
  nodes(run.tree).find((node) => node.type?.name === "Disclosure" && node.props.label === "Show answers").props.onOpenChange(true);
  await run.flush();
  let ready = find(run, "ReadyTable");
  const edited = ready.rows.find((row) => row.item.isin === "ISINY");
  ready.handlers.onCost(edited);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  let resolve;
  api.snapshots.getAll = (id) => id === "B" ? new Promise((done) => { resolve = done; }) : Promise.resolve([]);
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  document.activeElement = { control: "Change answer" };
  find(run, "AnsweredLine").onChange();
  await run.flush();
  assert.equal(find(run, "QuestionCard"), undefined, "the open edit blocks reopening the answer");
  let focused = false;
  document.hasFocus = () => false;
  document.getElementById = (id) => {
    const current = find(run, "ReadyTable");
    const row = current?.rows.find((row) => row.id === edited.id);
    if (!row || current.handlers.ids(row).field !== id) return null;
    return { dataset: {}, focus() { focused = true; }, scrollIntoView() {} };
  };
  resolve([]);
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.handlers.editing.rowId, edited.id);
  assert.equal(ready.handlers.editing.draft, "200");
  assert.equal(focused, false, "the user has moved focus outside the add-on");
});

test("the saved result reports an unnamed fund listing even when its statement has no plan or option", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund", name: "Example Fund" };
  const { run, props, api } = setup([source("X", [fund])]);
  props.fundChoices[holdingKey(fund)] = { fund: {
    symbol: "UNNAMED", exchangeMic: "XBOM", quoteCcy: "INR", name: "UNNAMED.BO", providerSymbol: "UNNAMED.BO", providerId: "YAHOO", manual: false, instrumentType: "MUTUALFUND",
  } };
  api.snapshots.save = async () => {};
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.match(textOf(run.tree), /Chosen listing's plan and option are unknown\./);
});
