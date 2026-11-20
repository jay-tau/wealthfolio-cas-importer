// Exercises the real Review controller and search hook with made-up host data, without a browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { proposedId } from "../src/lib/new-accounts.ts";

let server;
let HoldingsImport;
let StatementForm;
let CasParser;
let CasError;
let investorKey;
let sourceKey;
let holdingKey;
let LEFT_OUT;
let active;
const originalDocument = globalThis.document;

before(async () => {
  const names = ["useState", "useRef", "useMemo", "useId", "useEffect", "useLayoutEffect", "useSyncExternalStore", "useCallback"];
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
        if (/src\/(pages\/(holdings-import|detailed-import|import-page)\.tsx|components\/(statement-form\.tsx|amfi-banner\.tsx|review\/(search\.ts|parts\.tsx|focus\.ts|footer\.tsx))|lib\/focus\.ts)$/.test(id)) {
          return code.replaceAll('from "react"', 'from "review-hooks"');
        }
      },
    }],
  });
  ({ HoldingsImport } = await server.ssrLoadModule("/src/pages/holdings-import.tsx"));
  ({ StatementForm } = await server.ssrLoadModule("/src/components/statement-form.tsx"));
  ({ CasParser, CasError } = await server.ssrLoadModule("/src/cas/parser.ts"));
  ({ investorKey, sourceKey, holdingKey, LEFT_OUT } = await server.ssrLoadModule("/src/lib/choices.ts"));
});

// The saved password, a password typed, or the field left empty.
for (const [saved, typed] of [["old-password", ""], [null, "not-the-password"], [null, ""]]) for (const moved of ["control", "host"]) {
  test(`password failures are announced when focus moved away, without repeating the field's description (${saved ? "saved" : typed ? "typed" : "empty"}, ${moved})`, async (t) => {
    const globals = ["window", "Worker", "HTMLElement", "HTMLInputElement"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const parse = CasParser.prototype.parse;
    t.after(() => {
      CasParser.prototype.parse = parse;
      for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
    class Element {
      isConnected = true;
      closest() { return { contains: (element) => element === field || element === button }; }
      focus() { document.activeElement = this; }
      select() {}
    }
    const field = new Element();
    field.type = "password";
    const button = new Element();
    const outside = {};
    globalThis.HTMLElement = globalThis.HTMLInputElement = Element;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.Worker = class {
      constructor() { queueMicrotask(() => this.onmessage({ data: { type: "ready" } })); }
      postMessage() {}
      terminate() {}
    };
    globalThis.document = { activeElement: button, body: {}, hasFocus: () => true, getElementById: (id) => id === "cas-password" ? field : null };
    let reject;
    CasParser.prototype.parse = () => new Promise((resolve, fail) => { reject = fail; });
    const run = active = controller({
      ctx: { api: { secrets: { get: async () => saved }, logger: { error() {} } }, assets: {
        getBlob: async () => new Blob([JSON.stringify({ files: [], wasmParts: [], wheels: [] })]),
      } },
      onClear() {}, onRead: async () => {},
    }, StatementForm);
    await run.flush();
    nodes(run.tree).find((node) => node.props?.id === "cas-file").props.onChange({ target: { files: [{ name: "made-up.pdf", arrayBuffer: async () => new ArrayBuffer(1) }] } });
    await run.flush();
    if (typed) {
      nodes(run.tree).find((node) => node.props?.id === "cas-password").props.onChange({ target: { value: typed } });
      await run.flush();
    }
    const read = () => nodes(run.tree).find((node) => textOf(node) === "Read statement" && node.props?.onClick).props.onClick();
    const status = () => nodes(run.tree).filter((node) => node.props?.role === "status").map(textOf);
    read();
    await run.flush();
    if (moved === "host") document.hasFocus = () => false;
    else document.activeElement = outside;
    reject(new CasError("password", "wrong password"));
    await run.flush();
    const words = saved
      ? "Your saved password didn't open this PDF. Type its password."
      : typed ? "That password didn't open the PDF. Check it and try again." : "This PDF has a password. Type it and try again.";
    assert.equal(document.activeElement, moved === "host" ? button : outside, "the failure keeps focus where the user moved it");
    assert.deepEqual(status(), [words], "the password error is announced once without focusing its field");
    document.hasFocus = () => true;
    document.activeElement = button;
    read();
    await run.flush();
    reject(new CasError("password", "wrong password"));
    await run.flush();
    assert.equal(document.activeElement, field);
    assert.deepEqual(status(), [""], "the focused field already reads its error through aria-describedby");
  });
}
test("the saved password is used again after it didn't open a PDF and after Use a different password, and forgetting it is said", async (t) => {
  const globals = ["window", "Worker", "HTMLElement", "HTMLInputElement"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const parse = CasParser.prototype.parse;
  t.after(() => {
    CasParser.prototype.parse = parse;
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  globalThis.HTMLElement = globalThis.HTMLInputElement = class {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.Worker = class {
    constructor() { queueMicrotask(() => this.onmessage({ data: { type: "ready" } })); }
    postMessage() {}
    terminate() {}
  };
  globalThis.document = { activeElement: {}, body: {}, hasFocus: () => true, getElementById: () => null };
  // The PDF read next opens only with `opens`; each read's password is kept.
  let opens = "cdsl-password";
  const passwords = [];
  CasParser.prototype.parse = async (_pdf, password) => {
    passwords.push(password);
    if (opens instanceof CasError) throw opens;
    if (password !== opens) throw new CasError("password", "wrong password");
    return {};
  };
  let stored = "cams-password";
  let forgetFails = true;
  let finishForget;
  const toasts = [];
  const secrets = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
    delete: async () => {
      await new Promise((resolve) => { finishForget = resolve; });
      if (forgetFails) throw new Error("Secrets unavailable");
      stored = null;
    },
  };
  const run = active = controller({
    ctx: { api: { secrets, logger: { error() {}, warn() {} }, toast: { error: (m) => toasts.push(m) } }, assets: {
      getBlob: async () => new Blob([JSON.stringify({ files: [], wasmParts: [], wheels: [] })]),
    } },
    onClear() {}, onRead: async () => {},
  }, StatementForm);
  await run.flush();
  const tree = () => nodes(run.tree);
  const button = (text) => tree().find((node) => textOf(node) === text && node.props?.onClick);
  const field = () => tree().find((node) => node.props?.id === "cas-password");
  const errors = () => tree().filter((node) => node.props?.id === "review-password-error").map(textOf);
  const status = () => tree().filter((node) => node.props?.role === "status").map(textOf);
  const press = async (text) => {
    button(text).props.onClick();
    await run.flush();
  };
  tree().find((node) => node.props?.id === "cas-file").props.onChange({ target: { files: [{ name: "made-up.pdf", arrayBuffer: async () => new ArrayBuffer(1) }] } });
  await run.flush();
  assert.ok(tree().some((node) => textOf(node) === "Using your saved password"));
  assert.equal(field(), undefined);

  // The saved password doesn't open this PDF; its own password, typed, does.
  await press("Read statement");
  assert.deepEqual(errors(), ["Your saved password didn't open this PDF. Type its password."]);
  assert.equal(field().props.value, "");
  field().props.onChange({ target: { value: "cdsl-password" } });
  await run.flush();
  await press("Read statement");
  assert.deepEqual(passwords, ["cams-password", "cdsl-password"]);
  // The next PDF opens with the saved password, which the field offers.
  opens = "cams-password";
  await press("Use your saved password");
  assert.ok(tree().some((node) => textOf(node) === "Using your saved password"));
  await press("Read statement");
  assert.equal(passwords.at(-1), "cams-password");
  // Use a different password shows the password typed before, and Use your saved password goes back.
  await press("Use a different password");
  assert.equal(field().props.value, "cdsl-password");
  await press("Use your saved password");
  await press("Read statement");
  assert.equal(passwords.at(-1), "cams-password");
  // When the saved password doesn't open the next one either, the field keeps what was typed in it.
  opens = "another-password";
  await press("Read statement");
  assert.deepEqual(errors(), ["Your saved password didn't open this PDF. Type its password."]);
  assert.equal(field().props.value, "cdsl-password");
  // Use your saved password clears the field's error with the field.
  await press("Use your saved password");
  assert.deepEqual(errors(), []);
  await press("Use a different password");
  assert.deepEqual(errors(), []);

  // Forgetting can fail: the saved password and its controls stay, and nothing is said.
  await press("Forget saved password");
  assert.equal(button("Read statement").props.disabled, true);
  // Neither password mode can start a read before the deletion's outcome can be announced.
  await press("Use your saved password");
  assert.equal(button("Read statement").props.disabled, true);
  await press("Use a different password");
  const reads = passwords.length;
  field().props.onKeyDown({ key: "Enter" });
  await run.flush();
  assert.equal(passwords.length, reads);
  finishForget();
  await run.flush();
  assert.deepEqual(toasts, ["Couldn't forget the saved password."]);
  assert.equal(button("Read statement").props.disabled, false);
  assert.ok(button("Use your saved password"));
  assert.ok(button("Forget saved password"));
  assert.deepEqual(status(), [""]);
  opens = new CasError("runtime", "reader stopped");
  await press("Read statement");
  assert.equal(button("Try again").props.disabled, false);
  forgetFails = false;
  await press("Forget saved password");
  assert.equal(button("Read statement").props.disabled, true);
  assert.equal(button("Try again").props.disabled, true);
  await press("Use your saved password");
  finishForget();
  await run.flush();
  assert.equal(stored, null);
  assert.equal(button("Use your saved password"), undefined);
  assert.equal(button("Forget saved password"), undefined);
  assert.deepEqual(status(), ["Saved password forgotten."]);
  assert.equal(button("Read statement").props.disabled, false);
  assert.equal(button("Try again").props.disabled, false);
  // What's said goes with the next read, so it isn't said again after it. (With no field to focus
  // here, the status line says the read's error instead.)
  opens = "another-password";
  await press("Read statement");
  assert.deepEqual(errors(), ["That password didn't open the PDF. Check it and try again."]);
  assert.deepEqual(status(), errors());
  // Finishing deletion in saved-password mode must still allow remembering a new typed password.
  field().props.onChange({ target: { value: "another-password" } });
  tree().find((node) => node.props?.onCheckedChange).props.onCheckedChange(true);
  await run.flush();
  await press("Read statement");
  assert.equal(stored, "another-password");
  await press("Use a different password");
  assert.equal(field().props.value, "", "a password clears from the field once it's saved");
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
function controller(props, Component = HoldingsImport, { wide = true } = {}) {
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
    useCallback: (fn, deps) => memo(() => fn, deps),
    useId() { return memo(() => "review", []); },
    useEffect: effect,
    useLayoutEffect: effect,
    // Only useWide reads a store: whether the frame is at least `sm` wide.
    useSyncExternalStore(subscribe, snapshot, fallback) { return wide && fallback(); },
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
    resize(value) { wide = value; dirty = true; },
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
  // What the add-on logs: Wealthfolio's own errors, which the screen doesn't show.
  const logged = [];
  const api = {
    logger: { error: (m) => logged.push(m), warn: (m) => logged.push(m) },
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
  return { run: active, props, api, logged };
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
    active = controller({ ...footer.props }, (props) => {
      const tree = footer.type(props);
      tree.props.ref.current = bar;
      return tree;
    });
    await active.flush();
    assert.deepEqual(style, { scrollPaddingTop: position === "sticky" ? "101px" : "8px", scrollPaddingBottom: "79px" });
    let retried = 0;
    active.update({ go: { label: "Try again", busy: true, onClick() { retried++; } } });
    await active.flush();
    const retry = () => nodes(active.tree).find((node) => node.type?.name === "WrapButton" && node.props.variant === "outline").props;
    assert.equal(retry()["aria-disabled"], true);
    assert.ok(retry().children[0], "the busy retry shows its spinner");
    assert.notEqual(retry().disabled, true, "the busy retry stays focusable");
    retry().onClick();
    assert.equal(retried, 0);
    active.update({ go: { label: "Try again", onClick() { retried++; } } });
    await active.flush();
    assert.equal(retry()["aria-disabled"], undefined);
    assert.ok(!retry().children[0], "the idle retry has no spinner");
    retry().onClick();
    assert.equal(retried, 1);
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

for (const moved of ["stayed", "another control", "host"]) {
  test(`holdings retry stays busy through a deferred read and respects focus (${moved})`, async () => {
    const { run, api } = setup([source("X", [holding("ISINX")])]);
    api.snapshots.getAll = async () => { throw new Error("made-up read failure"); };
    await run.flush();
    const origin = document.activeElement;
    const focused = [];
    document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
    for (const failed of [true, false]) {
      let finish;
      api.snapshots.getAll = () => new Promise((resolve, reject) => { finish = failed ? reject : resolve; });
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

for (const failed of [false, true]) {
  test(`an unplanned Change follows its holding after ${failed ? "retrying a failed plan" : "choosing an account"}`, async () => {
    const x = source("X", [holding("ISINX")]);
    const { run, props, api } = setup([x]);
    if (!failed) props.accountChoices = {};
    else api.snapshots.getAll = async () => { throw new Error("made-up read failure"); };
    await run.flush();
    let ready = find(run, "ReadyTable");
    const old = ready.rows[0];
    document.getElementById = () => ({ dataset: {}, focus() {}, scrollIntoView() {} });
    ready.handlers.onChange(old);
    await run.flush();
    ready = find(run, "ReadyTable");
    const picker = nodes(ready.handlers.changePanel(old)).find((node) => node.type?.name === "Picker").props;
    picker.searches.setText(picker.item.key, "typed draft");
    ready.handlers.onCost(old);
    await run.flush();
    assert.equal(find(run, "ReadyTable").handlers.nag, true);
    let focused = false;
    document.getElementById = () => ({ dataset: {}, focus() { focused = true; }, scrollIntoView() {} });
    let resolve;
    api.snapshots.getAll = () => new Promise((done) => { resolve = done; });
    if (failed) find(run, "Footer").go.onClick();
    else find(run, "SaveTo").onChange(sourceKey(x), "A");
    await run.flush();
    assert.equal(find(run, "Footer").go.label, "Go to it", "the pending plan preserves the edit");
    resolve([]);
    await run.flush();
    ready = find(run, "ReadyTable");
    const row = ready.rows[0];
    assert.notEqual(row.id, old.id);
    assert.equal(ready.handlers.changing, row.id);
    assert.equal(ready.handlers.nag, true);
    const panel = ready.handlers.changePanel(row);
    assert.equal(nodes(panel).find((node) => node.type?.name === "Picker").props.search.text, "typed draft");
    assert.equal(focused, false, "reconciliation does not move focus");
    nodes(panel).find((node) => node.props?.children === "Cancel").props.onClick();
    await run.flush();
    ready = find(run, "ReadyTable");
    assert.equal(ready.handlers.changing, undefined);
    assert.equal(ready.handlers.nag, false);
    assert.equal(find(run, "Footer").action.disabled, false);
    ready.handlers.onCost(ready.rows[0]);
    await run.flush();
    assert.equal(find(run, "ReadyTable").handlers.nag, false);
  });
}

test("an earlier plan failure does not close Change while a new destination's plan starts", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, api } = setup([x, y]);
  props.accountChoices = { [sourceKey(y)]: "A" };
  await run.flush();
  let ready = find(run, "ReadyTable");
  ready.handlers.onChange(ready.rows.find((row) => row.item.isin === "ISINX"));
  await run.flush();
  api.snapshots.getAll = async () => { throw new Error("made-up refresh failure"); };
  run.update({ visit: {} });
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.handlers.changing, "|ISINX@XBOM");
  assert.equal(find(run, "Footer").go.label, "Try again");
  let resolve;
  api.snapshots.getAll = (id) => id === "B" ? new Promise((done) => { resolve = done; }) : Promise.resolve([]);
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  assert.equal(find(run, "Footer").go?.label, "Go to it", "the next plan keeps the edit while pending");
  resolve([]);
  await run.flush();
  ready = find(run, "ReadyTable");
  const moved = ready.rows.find((row) => row.accountId === "B");
  assert.equal(ready.handlers.changing, moved.id);
  assert.ok(ready.handlers.changePanel(moved));
});

test("a merged unplanned Change follows its selected holding when the old row survives without it", async () => {
  const one = holding("ISINX");
  const two = holding("ISINY");
  const x = source("X", [one]);
  const y = source("Y", [two]);
  const { run: initial, props } = setup([x, y]);
  props.accountChoices = {};
  for (const choice of Object.values(props.fundChoices)) choice.fund.symbol = "SHARED";
  initial.dispose();
  // Render the open child panel before effects, as React does, to catch a stale merged-row crash.
  const run = active = controller(props, (p) => {
    const tree = HoldingsImport(p);
    const ready = find({ tree }, "ReadyTable");
    for (const row of ready?.rows ?? []) {
      if (row.id === ready.handlers.changing) ready.handlers.changePanel(row);
    }
    return tree;
  });
  await run.flush();
  let ready = find(run, "ReadyTable");
  const old = ready.rows[0];
  const selected = old.items.find((item) => item.key === holdingKey(two));
  ready.handlers.onChange(old, selected);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(y), "A");
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.ok(ready.rows.some((row) => row.id === old.id));
  const moved = ready.rows.find((row) => row.accountId === "A");
  assert.equal(ready.handlers.changing, moved.id);
  assert.equal(ready.handlers.changingItem, selected.key);
  const panel = ready.handlers.changePanel(moved);
  assert.equal(nodes(panel).find((node) => node.type?.name === "Picker").props.item.key, selected.key);
  nodes(panel).find((node) => node.props?.children === "Cancel").props.onClick();
  await run.flush();
  assert.equal(find(run, "ReadyTable").handlers.changing, undefined);
});

for (const hidden of [false, true]) {
  test(`an unplanned Change follows an excluded row into Not included${hidden ? ", while another account question is open" : ""}`, async () => {
    const b = source("selected", [holding("ISINB")]);
    const ignored = source("ignored", [holding("ISINB")]);
    const unassigned = source("unassigned", [holding("ISINA")]);
    const { run, props, api } = setup([b, ignored, ...(hidden ? [unassigned] : [])]);
    props.accountChoices = { [sourceKey(ignored)]: LEFT_OUT };
    api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
    api.snapshots.getByDate = async () => [{ holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR", instrument: { id: "old", name: "Example ISINB", symbol: "ISINB", quoteMode: "MARKET" } }];
    api.assets.getProfile = async () => ({ instrumentSymbol: "ISINB", instrumentExchangeMic: "XBOM" });
    const stored = new Map();
    api.storage.get = async (key) => stored.get(key) ?? null;
    api.storage.set = async (key, value) => stored.set(key, value);
    const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
    await saveImported(api.storage, ignored, "A", "2025-02-28", { "ISINB@XBOM": ["ISINB"] });
    await run.flush();
    let ready = find(run, "ReadyTable");
    document.getElementById = () => ({ dataset: {}, focus() {}, scrollIntoView() {} });
    ready.handlers.onChange(ready.rows.find((row) => row.item.isin === "ISINB"));
    await run.flush();
    ready = find(run, "ReadyTable");
    ready.handlers.onCost(ready.rows[0]);
    await run.flush();
    let focused = false;
    document.getElementById = () => ({ dataset: {}, focus() { focused = true; }, scrollIntoView() {} });
    find(run, "SaveTo").onChange(sourceKey(b), "A");
    await run.flush();
    // Left out so that units aren't counted twice, with its note, and its Change stays open there.
    const [row] = find(run, "NotIncluded").defaulted;
    assert.equal(focused, false);
    assert.match(row.notes[0], /^An earlier import of selected?|^An earlier import of ignored/);
    assert.ok(nodes(row.panel).some((node) => node.type?.name === "Picker"));
    nodes(row.panel).find((node) => node.props?.children === "Cancel").props.onClick();
    await run.flush();
    assert.notEqual(find(run, "Footer").go?.label, "Go to it");
  });
}

for (const reason of ["overlap", "misread"]) {
  test(`an unplanned Change closes when its holding is left out for ${reason}`, async () => {
    const h = holding("ISINX");
    const x = { ...source("X", [h]), kind: "folio" };
    const y = source("Y", [holding("ISINY")]);
    const misread = { ...source("misread", []), misread: [h] };
    const { run, props, api } = setup([x, y, ...(reason === "misread" ? [misread] : [])]);
    props.accountChoices = {};
    if (reason === "overlap") {
      props.allAccounts = [...props.allAccounts, { id: "T", name: "Transactions", trackingMode: "TRANSACTIONS", isArchived: false }];
      api.portfolio.getHoldings = async (id) => id === "T" ? [{ holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: "tracked", symbol: h.isin, quoteMode: "MARKET" } }] : [];
      api.assets.getProfile = async () => ({ instrumentSymbol: h.isin, instrumentExchangeMic: "XBOM" });
    }
    await run.flush();
    let ready = find(run, "ReadyTable");
    document.getElementById = () => ({ dataset: {}, focus() {}, scrollIntoView() {} });
    ready.handlers.onChange(ready.rows.find((row) => row.item.isin === h.isin));
    await run.flush();
    ready = find(run, "ReadyTable");
    ready.handlers.onCost(ready.rows[0]);
    await run.flush();
    assert.equal(find(run, "ReadyTable").handlers.nag, true);
    let focused = false;
    document.getElementById = () => ({ dataset: {}, focus() { focused = true; }, scrollIntoView() {} });
    find(run, "SaveTo").onChange(investorKey("TEST"), "A");
    await run.flush();
    ready = find(run, "ReadyTable");
    assert.equal(ready.rows.some((row) => row.item.isin === h.isin), false);
    assert.equal(ready.handlers.changing, undefined);
    assert.equal(ready.handlers.nag, false);
    assert.equal(focused, false, "closing a vanished editor does not move focus");
    ready.handlers.onCost(ready.rows[0]);
    await run.flush();
    assert.equal(find(run, "ReadyTable").handlers.nag, false);
  });
}

test("an open Change follows a resolved asset's new position key after a host refresh", async () => {
  const h = holding("ISINX");
  const { run, props, api } = setup([source("X", [h])]);
  props.fundChoices[holdingKey(h)].fund.assetId = "asset";
  let symbol = "ISINX";
  api.assets.getProfile = async () => ({ instrumentSymbol: symbol, instrumentExchangeMic: "XBOM", quoteMode: "MARKET" });
  await run.flush();
  let ready = find(run, "ReadyTable");
  const old = ready.rows[0];
  ready.handlers.onChange(old);
  await run.flush();
  symbol = "RENAMED";
  run.update({ visit: {} });
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.notEqual(ready.rows[0].id, old.id);
  assert.equal(ready.handlers.changing, ready.rows[0].id);
  assert.ok(ready.handlers.changePanel(ready.rows[0]));
});

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

/** An open question's "On your statement:" line after the holding's name: its units, then where they are. */
const onStatement = (run) => {
  const card = nodes(run.tree).find((node) => node.type?.name === "QuestionCard");
  const line = card && nodes(card.type(card.props)).find((node) => node.type === "p" && textOf(node).startsWith("On your statement:"));
  return line && textOf(line).slice(`On your statement: ${card.props.item.name} · `.length);
};
/** A misread line's warning when every account the holding's saved places go to gets one. */
const MISREAD = "a line may have been misread, so the import leaves its holding as it is, or doesn't add one";

for (const [kind, places, h, two, one] of [
  ["demat", "demat accounts", holding("ISINX"), "20 shares", "10 shares"],
  ["folio", "folios", { ...holding("INFZ90A01017"), kind: "fund" }, "20.000 units", "10.000 units"],
  ["nps", "PRANs", { ...holding(null), kind: "nps", name: "Example NPS scheme", code: "SM001001" }, "20.000 units", "10.000 units"],
]) {
  test(`a holding's question counts the ${places} its units come from`, async () => {
    const x = { ...source("X", [h]), kind };
    const y = { ...source("Y", [h]), kind };
    const { run } = setup([x, y], false);
    await run.flush();
    assert.equal(onStatement(run), `${two} · in 2 ${places}`);
    find(run, "SaveTo").onChange(sourceKey(y), LEFT_OUT);
    await run.flush();
    assert.equal(onStatement(run), `${one} · in 1 of 2 ${places}`);
    find(run, "SaveTo").onChange(sourceKey(x), LEFT_OUT);
    await run.flush();
    assert.equal(find(run, "QuestionCard"), undefined, "with nothing of it saved, it isn't asked about");
  });
}

test("a holding's question counts a place once however many lines it has there, and gives no count for one place", async () => {
  const x = source("X", [holding("ISINX"), holding("ISINX")]);
  const y = source("Y", [holding("ISINX")]);
  let { run } = setup([x, y], false);
  await run.flush();
  assert.equal(onStatement(run), "30 shares · in 2 demat accounts");
  find(run, "SaveTo").onChange(sourceKey(y), LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), "20 shares · in 1 of 2 demat accounts");
  run.dispose();
  ({ run } = setup([x], false));
  await run.flush();
  assert.equal(onStatement(run), "20 shares");
});

test("a holding's question doesn't count an account whose saved holdings are kept", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINX")]);
  const { run, props } = sameDate([x, y], [["ISINX", "10"]]);
  props.accountChoices[sourceKey(y)] = "B";
  delete props.fundChoices[holdingKey(holding("ISINX"))];
  await run.flush();
  assert.equal(onStatement(run), "20 shares · in 2 demat accounts");
  find(run, "AskCard").main.onClick();
  await run.flush();
  assert.equal(find(run, "AskAnswered").text, "A: kept the holdings already saved for 31 Mar 2025");
  assert.equal(onStatement(run), "10 shares · in 1 of 2 demat accounts");
  find(run, "SaveTo").onChange(sourceKey(y), LEFT_OUT);
  await run.flush();
  assert.equal(find(run, "QuestionCard"), undefined, "with nothing of it saved, it isn't asked about");
});

test("printed-zero and misread lines count among a holding's places but give no units, and a misread line being saved leaves neither units nor a count", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund" };
  const x = { ...source("X", [fund]), kind: "folio" };
  const zero = { ...source("Zero", []), kind: "folio", zero: [{ ...fund, units: "0", value: "0" }] };
  let { run } = setup([x, zero], false);
  await run.flush();
  assert.equal(onStatement(run), "10.000 units · in 1 of 2 folios");
  find(run, "SaveTo").onChange(sourceKey(x), LEFT_OUT);
  await run.flush();
  assert.equal(find(run, "QuestionCard"), undefined, "a printed zero alone isn't asked about");
  run.dispose();

  const misread = { ...source("Misread", []), kind: "folio", misread: [{ ...fund, units: "0", value: "35799.22" }] };
  ({ run } = setup([x, misread], false));
  await run.flush();
  // A misread line being saved makes the units unknown, and so the places they're in.
  assert.equal(onStatement(run), MISREAD);
  find(run, "SaveTo").onChange(sourceKey(misread), LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), "10.000 units · in 1 of 2 folios");
  find(run, "SaveTo").onChange(sourceKey(misread), "A");
  find(run, "SaveTo").onChange(sourceKey(x), LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), MISREAD, "its asset is still needed to leave its holding as it is");
  run.dispose();

  ({ run } = setup([{ ...misread, misread: [fund, fund] }], false));
  await run.flush();
  assert.equal(onStatement(run), MISREAD);
});

test("a holding's question counts places of different kinds as places on the statement", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund" };
  const x = source("X", [fund]);
  const y = { ...source("Y", [fund]), kind: "folio" };
  const misread = { ...source("Misread", []), kind: "folio", misread: [{ ...fund, units: "0", value: "35799.22" }] };
  let { run } = setup([x, y, misread], false);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(misread), LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), "20.000 units · in 2 of 3 places on this statement");
  find(run, "SaveTo").onChange(sourceKey(y), LEFT_OUT);
  await run.flush();
  assert.equal(onStatement(run), "10.000 units · in 1 of 3 places on this statement");
  run.dispose();
  ({ run } = setup([x, y], false));
  await run.flush();
  assert.equal(onStatement(run), "20.000 units · in 2 places on this statement");
});

const LIQUID = { isin: "INFZ90K01LQ6", name: "Fictiva Liquid Fund - Direct Plan - Growth" };
/**
 * A made-up summary statement's Fictiva Liquid Fund, as the reader leaves it: 10 units in folio
 * 7712045, and a line in folio 91234567 / 12 that may have been misread, with a value but no units.
 * Everything goes to A, and no fund is confirmed. An account in `held` has an earlier snapshot with the fund.
 */
async function liquidMisread({ held = [] } = {}) {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-summary-cams.json", "utf8"));
  const [folio] = data.folios;
  const liquid = folio.schemes.find((s) => s.isin === LIQUID.isin);
  data.folios = [
    { ...folio, folio: "7712045", schemes: [{ ...liquid, close: "10.000", valuation: { ...liquid.valuation, value: "29114.52" } }] },
    { ...folio, schemes: [{ ...liquid, close: "0" }] },
  ];
  const { readHoldings } = await server.ssrLoadModule("/src/cas/holdings.ts");
  const holdings = readHoldings(data);
  const { run, props, api } = setup(holdings.sources, false);
  Object.assign(props, { holdings, statement: data, accountChoices: { [investorKey(holdings.investor)]: "A" } });
  api.snapshots.getAll = async (id) => (held.includes(id) ? [{ snapshotDate: "2025-02-28", source: "MANUAL" }] : []);
  const read = new Set();
  api.snapshots.getByDate = async (id) => (read.add(id), held.includes(id)
    ? [{ holdingType: "security", quantity: "12.296", costBasis: null, localCurrency: "INR", instrument: { id: `asset-${LIQUID.isin}`, name: LIQUID.name, symbol: LIQUID.isin, quoteMode: "MARKET" } }]
    : []);
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const saved = [];
  api.snapshots.save = async (accountId, positions) => saved.push([accountId, positions.map((p) => [p.assetId ?? p.symbol, p.quantity])]);
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  const [units, misread] = holdings.sources;
  const saveTo = async (source, to) => {
    find(run, "SaveTo").onChange(sourceKey(source), to);
    await run.flush();
  };
  /** The question's line after the fund's plan and option, and the misread line's reason under Not included. */
  const shown = () => {
    const line = onStatement(run);
    assert.ok(line.startsWith("Direct plan · Growth · "), line);
    assert.deepEqual(find(run, "NotIncluded").lines, [{
      name: LIQUID.name, where: "Fictiva Mutual Fund account (folio 91234567 / 12)",
      reason: "It has no units but a value of ₹35,799.22, so the line may have been misread. Check it against the PDF.",
    }]);
    return line.slice("Direct plan · Growth · ".length);
  };
  return { run, props, api, saved, read, units, misread, saveTo, shown };
}
const goingTo = (account) => `a line going to ${account} may have been misread, so ${account} keeps its holding as it is, or doesn't get one`;

/**
 * The made-up CDSL statement's mutual fund folios, all going to A: `name` is made-up-cdsl, or
 * made-up-cdsl-dropped, two of whose funds casparser doesn't read. A's snapshot of 28 Feb 2026 holds
 * one of those, from an earlier import of its folio. Without `gaps`, the screen gets no account gaps.
 */
async function cdslFolios(name, { gaps = true } = {}) {
  const data = JSON.parse(await readFile(`tests/fixtures/${name}.json`, "utf8"));
  data.accounts = data.accounts.filter((a) => a.type === "Mutual Fund Folios");
  data.nps = null;
  const { readHoldings } = await server.ssrLoadModule("/src/cas/holdings.ts");
  const holdings = readHoldings(data);
  if (!gaps) holdings.gaps = [];
  const { run, props, api } = setup(holdings.sources);
  Object.assign(props, { holdings, statement: data, accountChoices: { [investorKey(holdings.investor)]: "A" } });
  const isin = "INFZ90K01LD4";
  const instrument = { id: `asset-${isin}`, symbol: isin, name: "Fictiva Long Duration Placeholder Opportunities Fund - Direct Plan - Growth", quoteMode: "MARKET" };
  api.snapshots.getAll = async (id) => (id === "A" ? [{ snapshotDate: "2026-02-28", source: "MANUAL" }] : []);
  api.snapshots.getByDate = async (id) => (id === "A" ? [{ holdingType: "security", quantity: "1215.64", costBasis: null, localCurrency: "INR", instrument }] : []);
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, holdings.sources[0], "A", "2026-02-28", { [`${isin}@XBOM`]: [isin] });
  const saved = [];
  api.snapshots.save = async (accountId, positions, cash, date) => { saved.push([accountId, positions.map((p) => [p.assetId ?? p.symbol, p.quantity]), date]); };
  api.query = { invalidateQueries() {} };
  return { run, props, holdings, saved };
}
const statementWarnings = (run) => find(run, "StatementWarnings").lines.map((line) => line.text);
const DROPPED_GAP = "Mutual fund folios: the statement's summary value was read as ₹3,67,206.37, but the holdings found add up to ₹3,19,411.56, ₹47,794.81 less. Check the PDF for missing or misread holdings, including types this add-on can't read.";

for (const answer of ["Keep 1,215.640 units", "Set it to zero on 31 Mar"]) {
  test(`an account's gap shows on Review and the missing fund's ${answer} answer still saves the same snapshot (#338)`, async () => {
    const outcomes = [];
    for (const gaps of [true, false]) {
      const { run, saved } = await cdslFolios("made-up-cdsl-dropped", { gaps });
      await run.flush();
      const parts = nodes(run.tree);
      const warning = parts.find((node) => node.type?.name === "StatementWarnings");
      assert.ok(parts.indexOf(warning) < parts.findIndex((node) => node.type?.name === "SaveTo"));
      const markup = renderToStaticMarkup(warning).replaceAll("&#x27;", "'");
      assert.equal(markup.includes("Check these against the PDF before saving"), gaps);
      assert.equal(markup.includes(DROPPED_GAP), gaps);
      const card = find(run, "AskCard");
      const asked = [card.title, card.main.label, card.other.label, card.why.text];
      const button = [card.main, card.other].find((b) => b.label === answer);
      assert.ok(button, answer);
      button.onClick();
      await settle(run);
      const footer = footerText(run);
      find(run, "Footer").action.onClick();
      await settle(run);
      outcomes.push({ asked, footer, saved });
    }
    const positions = [
      ["INFZ90K01FC8", "2104.518"], ["INFZ90K01MC4", "640.25"], ["INFZ91T01CB6", "9512.207"], ["INFZ91T01GL6", "455.12"],
    ];
    if (answer.startsWith("Keep")) positions.unshift(["asset-INFZ90K01LD4", "1215.64"]);
    assert.deepEqual(outcomes[0].saved, [["A", positions, "2026-03-31"]]);
    assert.deepEqual(outcomes[0], outcomes[1]);
  });
}

test("leaving funds or a folio out of the save neither adds an account's gap nor hides one (#338)", async () => {
  for (const [name, expected] of [["made-up-cdsl", []], ["made-up-cdsl-dropped", [DROPPED_GAP]]]) {
    const { run, props, holdings } = await cdslFolios(name);
    const [first, second] = holdings.sources;
    props.fundChoices[holdingKey(first.holdings[0])] = { leftOut: true };
    await run.flush();
    assert.deepEqual(statementWarnings(run), expected, name);
    find(run, "SaveTo").onChange(sourceKey(second), LEFT_OUT);
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(second)], LEFT_OUT);
    assert.deepEqual(statementWarnings(run), expected, name);
  }
});

test("a misread line's warning on a holding's question names the accounts that line goes to, if the holding's other saved places go elsewhere", async () => {
  const { run, units, misread, saveTo, shown } = await liquidMisread();
  await run.flush();
  assert.equal(shown(), MISREAD, "both folios go to A");
  await saveTo(misread, LEFT_OUT);
  assert.equal(shown(), "10.000 units · in 1 of 2 folios", "a line that isn't saved warns of nothing");
  await saveTo(misread, "");
  assert.equal(shown(), MISREAD, "saved again, to A");
  await saveTo(misread, "B");
  assert.equal(shown(), goingTo("B"));
  await saveTo(units, "B");
  assert.equal(shown(), MISREAD, "both folios go to B");
  await saveTo(units, LEFT_OUT);
  assert.equal(shown(), MISREAD, "only the misread line is saved");
});

test("a misread line's warning names no account while its folio's account is still to choose", async () => {
  const { run, props, misread, units, saveTo, shown } = await liquidMisread();
  props.accountChoices = { [sourceKey(units)]: "A" };
  await run.flush();
  assert.ok(find(run, "SaveTo"));
  assert.equal(shown(), MISREAD);
  await saveTo(misread, "B");
  assert.equal(shown(), goingTo("B"));
});

test("a misread line's warning names every account such lines go to", async () => {
  const fund = { ...holding("INFZ90A01017"), kind: "fund" };
  const folio = (id, more) => ({ ...source(id, []), kind: "folio", ...more });
  const x = folio("X", { holdings: [fund] });
  const [m, n] = ["M", "N"].map((id) => folio(id, { misread: [{ ...fund, units: "0", value: "35799.22" }] }));
  const { run, props } = setup([x, m, n], false);
  props.accounts.push({ id: "C", name: "C", trackingMode: "HOLDINGS", isActive: true, isArchived: false });
  Object.assign(props.accountChoices, { [sourceKey(x)]: "C", [sourceKey(n)]: "B" });
  await run.flush();
  assert.equal(onStatement(run), "lines going to A and B may have been misread, so A and B keep their holdings as they are, or don't get one");
});

test("a misread line's warning leaves out an account whose holdings saved for the date are kept, and is back once they're replaced", async () => {
  const { run, api, units, misread, saveTo, shown } = await liquidMisread();
  api.snapshots.getAll = async (id) => (id === "A" ? [{ snapshotDate: "2025-03-31", source: "MANUAL" }] : []);
  await run.flush();
  // The misread line goes to A, and the fund's units to B.
  await saveTo(units, "B");
  assert.equal(shown(), goingTo("A"));
  assert.equal(find(run, "AskCard").title, "A already has holdings saved for 31 Mar 2025");
  find(run, "AskCard").main.onClick();
  await run.flush();
  assert.equal(shown(), "10.000 units · in 1 of 2 folios");
  find(run, "AskAnswered").onChange();
  await run.flush();
  find(run, "AskCard").other.onClick();
  await run.flush();
  assert.equal(find(run, "AskAnswered").text, "A: replaced the holdings saved for 31 Mar 2025 with this statement");
  assert.equal(shown(), goingTo("A"));
});

for (const to of ["B", "A"]) {
  for (const held of [false, true]) {
    test(`a misread line going to ${to === "A" ? "the same account as" : "another account than"} the fund's units, ${held ? "which has" : "without"} a holding of it, changes only the question's words`, async () => {
      const { run, saved, read, misread, saveTo, shown } = await liquidMisread({ held: held ? [to] : [] });
      await run.flush();
      if (to === "B") await saveTo(misread, "B");
      assert.equal(shown(), to === "B" ? goingTo("B") : MISREAD);
      find(run, "QuestionCard").onAnswer({ fund: { symbol: LIQUID.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: LIQUID.name, instrumentType: "MUTUALFUND", providerId: "YAHOO" } });
      await run.flush();
      assert.equal(read.has(to), held, "its account's earlier snapshot is read");
      // A saves the 10 units of the folio with none misread; where a misread line goes, a holding of the fund stays and none is added.
      const rows = find(run, "ReadyTable")?.rows.map((row) => [row.accountId, row.position.units]);
      assert.deepEqual(rows, to === "B" ? [["A", "10"]] : undefined);
      find(run, "Footer").action.onClick();
      await run.flush();
      assert.deepEqual(saved, to === "B" ? [["A", [[LIQUID.isin, "10"]]]] : []);
    });
  }
}

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

test("a replacement asked about waits for its answer, and changing it back clears the row's cost and closes its cost editor", async () => {
  const x = holding("ISINX");
  const first = source("X", [x]);
  const { run, api } = setup([first]);
  // An earlier import of X added the holding as another listing, OLD.
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => [{ holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR", instrument: { id: "old", name: "Old listing", symbol: "OLD", quoteMode: "MARKET" } }];
  api.assets.getProfile = async () => ({ instrumentSymbol: "OLD", instrumentExchangeMic: "XBOM" });
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, first, "A", "2025-02-28", { "OLD@XBOM": [x.isin] });
  await run.flush();
  let card = find(run, "AskCard");
  assert.equal(card.title, "Example ISINX is now matched to Example ISINX (ISINX · XBOM)");
  assert.equal(card.main.label, "Keep Old listing for now");
  assert.equal(card.other.name, "Replace Old listing with Example ISINX: Example ISINX in A");
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.equal(find(run, "Footer").action.disabled, true);
  card.other.onClick();
  await run.flush();
  assert.equal(find(run, "AskAnswered").text, "Example ISINX: Old listing replaced with Example ISINX in A");
  assert.equal(find(run, "Footer").action.disabled, false);
  await saveCost(run, x.isin, "100");
  let ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].cost.total, "100");
  ready.handlers.onCost(ready.rows[0]);
  await run.flush();
  find(run, "ReadyTable").handlers.onDraft("200");
  await run.flush();
  // Changing the answer leaves the row out again: its cost and open edit go.
  find(run, "AskAnswered").onChange();
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  card = find(run, "AskCard");
  card.other.onClick();
  await run.flush();
  ready = find(run, "ReadyTable");
  assert.equal(ready.rows[0].cost, undefined);
  assert.equal(ready.handlers.editing, undefined);
  // Keeping the old listing leaves the row out, saying why, with its Change.
  find(run, "AskAnswered").onChange();
  await run.flush();
  find(run, "AskCard").main.onClick();
  await run.flush();
  assert.deepEqual(find(run, "NotIncluded").defaulted.map((r) => [r.name, r.notes]), [["Example ISINX", ["A keeps Old listing (OLD · XBOM) for now, by your answer above."]]]);
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

for (const failedRead of ["activities", "profile"]) {
  test(`a failed tracked-units ${failedRead} read offers a plain planning retry with the choices kept`, async () => {
    const fund = { ...holding("INFZ90A01017"), kind: "fund", units: "20", value: "40" };
    const { run, props, api, logged } = setup([{ ...source("X", [fund]), kind: "folio" }, source("Y", [holding("ISINY")])]);
    props.allAccounts = [...props.allAccounts, { id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isArchived: false }];
    api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [{
      holdingType: "security", quantity: "20", localCurrency: "INR", instrument: { id: "tracked", symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
    }];
    let fail = false;
    api.assets.getProfile = async (id) => {
      if (fail && failedRead === "profile" && id === "other") throw new Error("made-up profile unavailable");
      return { instrumentSymbol: id === "other" ? "OTHER" : fund.isin, instrumentExchangeMic: "XBOM" };
    };
    api.activities.getAll = async () => {
      if (fail && failedRead === "activities") throw new Error("made-up history unavailable");
      return ["tracked", "other"].map((assetId) => ({ accountId: "T", assetId, activityType: "BUY", status: "POSTED", quantity: "20", date: "2025-03-01" }));
    };
    await run.flush();
    assert.equal(find(run, "NotIncluded").tracked[0].funds[0].comparison.kind, "match");
    const statement = props.statement;
    const choices = { ...props.accountChoices };
    fail = true;
    run.update({ visit: {} });
    await run.flush();
    assert.equal(find(run, "Footer").lines.map(textOf)[0], "We couldn't work out what will be saved. Nothing was saved.");
    assert.equal(find(run, "Footer").action.disabled, true);
    assert.equal(find(run, "Footer").go.label, "Try again");
    assert.match(logged.join("\n"), /made-up (history|profile) unavailable/);
    fail = false;
    find(run, "Footer").go.onClick();
    await run.flush();
    assert.equal(find(run, "NotIncluded").tracked[0].funds[0].comparison.kind, "match");
    assert.equal(props.statement, statement);
    assert.deepEqual(props.accountChoices, choices);
    assert.equal(find(run, "Footer").action.disabled, false);
  });
}

for (const [message, ended, end] of [["nope", "nope.", "no final punctuation"], ["nope.", "nope.", "a period"], ["nope?", "nope?", "a question mark"], ["nope!", "nope!", "an exclamation mark"]]) {
  test(`a held asset's failed profile read, with ${end}, is logged with one sentence end before "Try again."`, async () => {
    const { run, api, logged } = setup([source("X", [holding("ISINX")])]);
    api.portfolio.getHoldings = async (id) => id !== "B" ? [] : [{
      holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: "held", symbol: "HELD", name: "Made-up held fund", quoteMode: "MARKET" },
    }];
    api.assets.getProfile = async () => { throw new Error(message); };
    await run.flush();
    assert.equal(find(run, "Footer").lines.map(textOf)[0], "We couldn't work out what will be saved. Nothing was saved.");
    // Wealthfolio's text stays as String() gives it, with the `Error: ` prefix.
    assert.deepEqual(logged, [`Couldn't work out what will be saved: Error: Couldn't read the Wealthfolio profile of Made-up held fund: Error: ${ended} Try again.`]);
  });
}

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
  const { run, api, logged } = setup([x, y]);
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
  // Wealthfolio's own error goes to the log; the bar says what happened in the user's words.
  assert.deepEqual(footer.lines.map(textOf), ["We couldn't work out what will be saved. Nothing was saved."]);
  assert.match(logged.at(-1), /made-up read failure/);
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

/** A Change open on a statement row left out so that units aren't counted twice, under Not included, with a typed draft. */
async function leftOutEditor(mode) {
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
  const row = () => find(run, "NotIncluded").defaulted.find((r) => r.name.startsWith("Example ISINB"));
  assert.ok(row(), "left out so that units aren't counted twice");
  nodes(row().change).find((node) => node.type?.name === "LinkButton").props.onClick();
  await run.flush();
  const picker = () => {
    const panel = row()?.panel;
    return { panel, props: nodes(panel).find((node) => node.type?.name === "Picker")?.props };
  };
  const opened = picker().props;
  opened.searches.setText(opened.item.key, "typed B draft");
  await run.flush();
  return { run, a, b, picker };
}

test("reopening an answer keeps an excluded holding's Change editor visible", async () => {
  const { run, picker } = await leftOutEditor("answer");
  find(run, "AnsweredLine").onChange();
  await run.flush();
  assert.equal(find(run, "QuestionCard"), undefined);
  const kept = picker();
  assert.equal(kept.props.item.key, "isin:ISINB");
  assert.equal(kept.props.search.text, "typed B draft");
  assert.ok(JSON.stringify(kept.panel).includes("Save or cancel this edit first."));
});

test("account changes that add holding or account questions leave a Change on a left-out row open, with its draft", async () => {
  for (const mode of ["holding", "account"]) {
    const { run, a, b, picker } = await leftOutEditor(mode);
    find(run, "SaveTo").onChange(sourceKey(a), mode === "holding" ? "A" : "");
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(a)], mode === "holding" ? "A" : "");
    if (mode === "holding") assert.ok(find(run, "QuestionCard"), "the holding is asked about");
    const kept = picker();
    assert.equal(kept.props.item.key, "isin:ISINB");
    assert.equal(kept.props.search.text, "typed B draft");
    assert.ok(!JSON.stringify(kept.panel).includes("Save or cancel this edit first."));
    // Moving the edited holding to another account takes its Change with it to its ready row there.
    find(run, "SaveTo").onChange(sourceKey(b), "B");
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(b)], "B", "moving the edited holding applies");
    const ready = find(run, "ReadyTable");
    if (ready?.handlers.changing) assert.ok(ready.rows.some((row) => row.id === ready.handlers.changing && row.accountId === "B"));
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
  // The header has no hooks of its own, so it renders here as it would on the page.
  const header = () => {
    const node = nodes(run.tree).find((n) => n.type?.name === "ReviewHeader");
    return node.type(node.props);
  };
  nodes(header()).find((node) => node.props?.children === "Use another file").props.onClick();
  await run.flush();
  assert.equal(departures, 0);
  assert.ok(nodes(header()).some((node) => node.props?.children === "Keep reviewing"));
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.match(textOf(header()), /Discard your 1 change and choose another file\?/);
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
  assert.deepEqual(notIncluded.tracked.map((group) => group.accounts), ["Funds (account 2)", "Funds (account 1)"]);
  assert.deepEqual(notIncluded.tracked.map((group) => group.funds[0].comparison.accounts.map((a) => a.name)), [["Funds (account 2)"], ["Funds (account 1)"]]);
  const { NotIncluded } = await server.ssrLoadModule("/src/components/review/not-included.tsx");
  const groups = nodes(NotIncluded(notIncluded)).filter((node) => node.type?.name === "Tracked");
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  const reviewLinks = (tree) => nodes(tree).filter((node) => node.type?.name === "LinkButton" && textOf(node).startsWith("Review its transactions in "));
  const before = groups.flatMap((group) => reviewLinks(group.type(group.props)));
  assert.deepEqual(before.map(textOf), ["Review its transactions in Funds (account 2)", "Review its transactions in Funds (account 1)"]);
  before.forEach((link) => link.props.onClick());
  assert.deepEqual(routes, ["/accounts/T2", "/accounts/T1"]);
  routes.length = 0;
  find(run, "Footer").action.onClick();
  await run.flush();
  const after = reviewLinks(run.tree);
  assert.deepEqual(after.map(textOf), ["Review its transactions in Funds (account 2)"]);
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

// Accounts proposed when none fits, created when the holdings are saved.
const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : node === false ? "" : String(node ?? "");
/**
 * A review where Wealthfolio has `accounts` (none by default, as in a new profile) and remembers
 * nothing. Wealthfolio creates each account asked for, except names in `refuse`; the add-on's page
 * adds them to its accounts and keeps what's remembered, as the import page does.
 */
function withNewAccounts(sources, { accounts = [], refuse = new Set() } = {}) {
  const context = setup(sources);
  const { props, api } = context;
  Object.assign(props, { accounts, allAccounts: accounts, accountChoices: {} });
  const asked = [];
  const saved = [];
  const remembers = [];
  let next = 0;
  api.accounts = {
    create: async (payload) => {
      asked.push(payload);
      if (refuse.has(payload.name)) throw new Error(`made-up refusal of ${payload.name}`);
      return { id: `created-${++next}`, ...payload, isArchived: false, group: null };
    },
  };
  api.snapshots.save = async (accountId, holdings) => { saved.push({ accountId, holdings: holdings.length }); };
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  props.onCreated = (made) => context.run.update({ accounts: [...props.accounts, ...made], allAccounts: [...props.allAccounts, ...made] });
  props.onRemember = (r) => {
    remembers.push(r);
    context.run.update({ accountChoices: { ...props.accountChoices, ...Object.fromEntries(r.accounts) } });
  };
  return { ...context, asked, saved, remembers };
}
const footerText = (run) => find(run, "Footer").lines.map(textOf);
/** Each account's outcome in the result: its Wealthfolio account, or the proposed one, and its state. */
const outcomes = (result) => result.result.accounts.map((a) => [a.accountId ?? a.key, a.state]);
const NEW_LINE = "New · Wealthfolio account, created when you save · Rename";

test("a new profile proposes the depository's account, creates it on saving and only then remembers it", async () => {
  const { run, asked, saved, remembers } = withNewAccounts([source("X", [holding("ISINX")])]);
  await run.flush();
  const saveTo = find(run, "SaveTo");
  const investor = investorKey("TEST");
  assert.equal(saveTo.values[investor], proposedId(investor));
  assert.deepEqual(saveTo.proposed(investor), { id: proposedId(investor), name: "NSDL Demat" });
  // Its own account for the demat account, offered under Save part of it to another account.
  assert.equal(saveTo.proposed(sourceKey(saveTo.sources[0])).name, "X demat");
  assert.equal(saveTo.values[sourceKey(saveTo.sources[0])], "");
  const line = saveTo.newLine(investor, "Made-up Investor's holdings");
  assert.equal(textOf(line.type(line.props)), NEW_LINE);
  assert.deepEqual(footerText(run)[0], "Create the Wealthfolio account NSDL Demat and save 1 holding on 31 Mar 2025.See the holdings in NSDL Demat on 31 Mar 2025 after saving");
  assert.equal(find(run, "Footer").action.label, "Save holdings");
  assert.equal(find(run, "Footer").action.disabled, false);
  assert.deepEqual(remembers, []);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked, [{ name: "NSDL Demat", accountType: "SECURITIES", currency: "INR", isDefault: false, isActive: true, trackingMode: "HOLDINGS" }]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }]);
  // The review's choices first, with no new account among them; the new account once it's created.
  assert.deepEqual(remembers.map((r) => r.accounts), [[], [[investor, "created-1"]]]);
  const result = find(run, "HoldingsResult");
  assert.deepEqual(result.result.accounts.map((a) => [a.accountId, a.name, a.isNew, a.holdings, a.state]), [["created-1", "NSDL Demat", true, 1, "saved"]]);
});

test("with accounts that track holdings but none remembered, nothing is preselected, and the new one stays offered", async () => {
  const accounts = [{ id: "A", name: "NSDL Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, asked } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  await run.flush();
  const saveTo = find(run, "SaveTo");
  const investor = investorKey("TEST");
  assert.equal(saveTo.values[investor], null);
  // The name an existing account has gets a number.
  assert.equal(saveTo.proposed(investor).name, "NSDL Demat 2");
  assert.deepEqual(footerText(run), ["1 question left: the account choice before saving."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  saveTo.onChange(investor, proposedId(investor));
  await run.flush();
  assert.match(footerText(run)[0], /^Create the Wealthfolio account NSDL Demat 2 and save 1 holding on 31 Mar 2025\./);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat 2"]);
});

test("with an account to choose and holding questions, every count says the account choice is in it", async () => {
  const accounts = [{ id: "A", name: "CDSL holdings", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, props } = withNewAccounts([source("X", [holding("ISINX"), holding("ISINY")])], { accounts });
  props.fundChoices = {};
  await settle(run);
  assert.equal(find(run, "SaveTo").values[investorKey("TEST")], null);
  assert.equal(said(run), "3 questions for you: the account choice and 2 other questions.");
  const heading = () => textOf(nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n))));
  const button = () => textOf(nodes(run.tree).find((n) => n.type?.name === "Button" && /^\d+ questions?/.test(textOf(n))));
  assert.equal(heading(), "Other questions · 2 of 2 left");
  assert.equal(button(), "3 questions: the account choice and 2 other questions");
  assert.deepEqual(footerText(run), ["3 questions left: the account choice and 2 other questions before saving."]);
  find(run, "SaveTo").onChange(investorKey("TEST"), "A");
  await run.flush();
  assert.equal(heading(), "Questions for you · 2 of 2 left");
  assert.equal(button(), "2 questions");
  assert.deepEqual(footerText(run), ["2 questions left before saving."]);
});

test("an account named for its holdings reads naturally in the bar's link and the snapshot's name", async () => {
  const accounts = [{ id: "A", name: "CDSL holdings", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  await run.flush();
  find(run, "SaveTo").onChange(investorKey("TEST"), "A");
  await run.flush();
  const link = nodes(find(run, "Footer").lines).find((n) => n.type?.name === "LinkButton");
  assert.equal(textOf(link), "See the holdings in CDSL holdings on 31 Mar 2025 after saving");
  link.props.onClick();
  await run.flush();
  const section = nodes(run.tree).find((n) => n.type === "section" && n.props.id === link.props["aria-controls"]);
  // Its visible heading names it, so two open previews say whose holdings each shows.
  const heading = nodes(section).find((n) => n.type === "h3" && n.props.id === section.props["aria-labelledby"]);
  assert.equal(textOf(heading), "Holdings in CDSL holdings on 31 Mar 2025 after saving");
  assert.equal(find(run, "SnapshotTable").account, "CDSL holdings");
});

test("a summary statement's new Mutual funds account reads naturally in the bar's link and the snapshot's name", async () => {
  // A first summary import: no account tracks holdings, so "New: Mutual funds" is proposed.
  const folio = { id: "folio|7712045", kind: "folio", label: "Folio 7712045", title: "Fictiva Mutual Fund account (folio 7712045)", holdings: [holding("ISINX")] };
  const { run, props } = withNewAccounts([folio]);
  props.statement = { ...props.statement, file_type: "CAMS", cas_type: "SUMMARY" };
  await run.flush();
  const investor = investorKey("TEST");
  assert.deepEqual(find(run, "SaveTo").proposed(investor), { id: proposedId(investor), name: "Mutual funds" });
  assert.equal(find(run, "SaveTo").values[investor], proposedId(investor));
  const link = nodes(find(run, "Footer").lines).find((n) => n.type?.name === "LinkButton");
  assert.equal(textOf(link), "See the holdings in Mutual funds on 31 Mar 2025 after saving");
  link.props.onClick();
  await run.flush();
  const section = nodes(run.tree).find((n) => n.type === "section" && n.props.id === link.props["aria-controls"]);
  // Its visible heading names it, so two open previews say whose holdings each shows.
  const heading = nodes(section).find((n) => n.type === "h3" && n.props.id === section.props["aria-labelledby"]);
  assert.equal(textOf(heading), "Holdings in Mutual funds on 31 Mar 2025 after saving");
  assert.equal(find(run, "SnapshotTable").account, "Mutual funds");
});

test("a remembered account wins over a new one", async () => {
  const accounts = [{ id: "A", name: "Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, props, asked } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  props.accountChoices = { [investorKey("TEST")]: "A" };
  await run.flush();
  assert.equal(find(run, "SaveTo").values[investorKey("TEST")], "A");
  assert.equal(find(run, "SaveTo").remembered, true);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked, []);
});

test("a summary statement whose funds are all tracked from transactions creates no account and saves no snapshot, and says why", async () => {
  // Only an account that tracks transactions, which already holds both funds.
  const funds = ["INFZ90A01017", "INFZ90B01015"].map((isin) => ({ ...holding(isin), kind: "fund" }));
  const folio = { id: "folio|7712045", kind: "folio", label: "Folio 7712045", title: "Fictiva Mutual Fund account (folio 7712045)", holdings: funds };
  const accounts = [{ id: "T", name: "Mutual funds", trackingMode: "TRANSACTIONS", isActive: true, isArchived: false }];
  const { run, props, api, asked, saved, remembers } = withNewAccounts([folio], { accounts });
  props.statement = { ...props.statement, file_type: "CAMS", cas_type: "SUMMARY" };
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : funds.map((fund) => ({
    holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: fund.isin, symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM" });
  const notices = [];
  props.onAnother = (notice) => notices.push(notice);
  await run.flush();
  const investor = investorKey("TEST");
  assert.deepEqual(find(run, "SaveTo").proposed(investor), { id: proposedId(investor), name: "Mutual funds 2" });
  assert.equal(find(run, "SaveTo").values[investor], proposedId(investor));
  assert.deepEqual(find(run, "NotIncluded").tracked.map((g) => [g.accounts, g.funds.map((f) => f.included)]), [["Mutual funds", [false, false]]]);
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.deepEqual(footerText(run), ["Nothing will be saved: every holding is already tracked in Mutual funds."]);
  const action = find(run, "Footer").action;
  assert.equal(action.label, "Finish");
  assert.equal(action.disabled, false);
  action.onClick();
  await run.flush();
  assert.deepEqual(asked, [], "no account is created");
  assert.deepEqual(saved, [], "no snapshot is saved");
  assert.deepEqual(remembers.map((r) => r.accounts), [[]], "the new account isn't remembered");
  assert.deepEqual(notices, ["Finished: nothing from made-up.pdf was saved."]);
});

test("an existing account without a snapshot gets no empty one when every holding is skipped, and the bar says why", async () => {
  const x = source("X", [holding("ISINX"), holding("ISINY")]);
  const { run, props, api } = setup([x], false);
  props.accounts[0].name = "Demat";
  const saved = [];
  api.snapshots.save = async (accountId, positions) => { saved.push([accountId, positions.length]); };
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  const notices = [];
  props.onAnother = (notice) => notices.push(notice);
  await settle(run);
  for (const isin of ["ISINX", "ISINY"]) {
    assert.equal(find(run, "QuestionCard").item.isin, isin);
    find(run, "QuestionCard").onAnswer({ leftOut: true });
    await settle(run);
  }
  assert.deepEqual(find(run, "NotIncluded").skipped.map((s) => s.name), ["Example ISINX", "Example ISINY"]);
  assert.deepEqual(footerText(run), ["Nothing will be saved: every holding was skipped."]);
  assert.equal(said(run), "Nothing will be saved: every holding was skipped.");
  const action = find(run, "Footer").action;
  assert.equal(action.label, "Finish");
  action.onClick();
  await run.flush();
  assert.deepEqual(saved, []);
  assert.deepEqual(notices, ["Finished: nothing from made-up.pdf was saved."]);
});

test("an unchanged account's manual-price notes depend on saving its snapshot", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINX")]);
  const { run, props, api } = setup([x, y]);
  props.accountChoices[sourceKey(y)] = LEFT_OUT;
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => ["ISINX", "OLD"].map((symbol) => ({
    holdingType: "security", quantity: "10", costBasis: { local: "100" }, localCurrency: "INR",
    instrument: { id: `asset-${symbol}`, symbol, name: `Example ${symbol}`, quoteMode: "MANUAL" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const writes = [];
  api.quotes = { getHistory: async () => [], update: async () => { writes.push("price"); } };
  api.snapshots.save = async () => { writes.push("snapshot"); };
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, y, "A", "2025-02-28", { "ISINX@XBOM": ["ISINX"] });
  api.storage.set = async () => { writes.push("import record"); };
  await run.flush();
  assert.equal(find(run, "Footer").action.label, "Finish");
  const condition = "If you save this account's snapshot and no included holding supplies the statement's price";
  assert.ok(find(run, "NotIncluded").defaulted[0].notes.some((note) => note.includes(condition)));
  const kept = nodes(run.tree).find((n) => n.props?.["aria-labelledby"] === "review-kept-as-is");
  assert.ok(textOf(kept).includes(condition));
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(writes, []);
});

test("a holding held back by a line that may have been misread saves nothing, and the bar says why", async () => {
  const h = holding("ISINX");
  const x = source("X", [h]);
  const misread = { ...source("M", []), misread: [h] };
  const { run, api } = setup([x, misread]);
  const saved = [];
  api.snapshots.save = async (accountId) => { saved.push(accountId); };
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.deepEqual(footerText(run), ["Nothing will be saved: every holding may have been misread."]);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(saved, []);
});

for (const units of ["", "-1"]) {
  test(`a skipped holding beside a ${units ? "negative" : "blank"}-unit line kept only in leftOut gets the generic explanation`, async () => {
    const statement = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
    const account = statement.accounts[0];
    const share = account.equities[0];
    // Equal names must not hide a row that the source's holdings, misread and zero arrays omit.
    statement.accounts = [{ ...account, equities: [share, { ...share, isin: "ISINY", num_shares: units }], mutual_funds: [], bonds: [] }];
    statement.nps = null;
    const { readHoldings } = await server.ssrLoadModule("/src/cas/holdings.ts");
    const holdings = readHoldings(statement);
    assert.equal(holdings.leftOut.length, 1);
    assert.equal(holdings.sources[0].holdings.length, 1);
    assert.equal(holdings.sources[0].zero, undefined);
    assert.equal(holdings.sources[0].misread, undefined);
    const { run, props } = setup(holdings.sources);
    props.holdings = holdings;
    props.statement = statement;
    props.accountChoices = { [investorKey(holdings.investor)]: "A" };
    props.fundChoices[holdingKey(holdings.sources[0].holdings[0])] = { leftOut: true };
    await run.flush();
    assert.deepEqual(footerText(run), ["Nothing will be saved: no holding on this statement is ready to save."]);
    assert.equal(find(run, "Footer").action.label, "Finish");
  });
}

test("a skipped holding beside a Don't-save source with only a leftOut line gets the generic explanation", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", []);
  const { run, props } = setup([x, y]);
  props.fundChoices[holdingKey(x.holdings[0])] = { leftOut: true };
  props.accountChoices[sourceKey(y)] = LEFT_OUT;
  props.holdings.leftOut = [{ source: y.label, name: "Example ISINY", reason: "No units on the statement." }];
  await run.flush();
  assert.deepEqual(footerText(run), ["Nothing will be saved: no holding on this statement is ready to save."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("funds tracked in different accounts do not say every fund is tracked in all of them", async () => {
  const funds = ["INFTESTX", "INFTESTY"].map((isin) => ({ ...holding(isin), kind: "fund" }));
  const x = { ...source("X", funds), kind: "folio" };
  const { run, props, api } = setup([x]);
  props.allAccounts = [...props.allAccounts, ...["T1", "T2"].map((id) => ({ id, name: id, trackingMode: "TRANSACTIONS", isArchived: false }))];
  api.portfolio.getHoldings = async (id) => {
    const fund = funds[["T1", "T2"].indexOf(id)];
    return fund ? [{ holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: fund.isin, symbol: fund.isin, quoteMode: "MARKET" } }] : [];
  };
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM" });
  await run.flush();
  assert.deepEqual(find(run, "NotIncluded").tracked.map((g) => [g.accounts, g.funds.map((f) => f.key)]), [["T1", [holdingKey(funds[0])]], ["T2", [holdingKey(funds[1])]]]);
  assert.deepEqual(footerText(run), ["Nothing will be saved: every holding is already tracked in at least one of T1 and T2."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("a skipped holding and a printed zero holding do not say every holding was skipped", async () => {
  const x = { ...source("X", [holding("ISINX")]), zero: [{ ...holding("ISINY"), units: "0", value: "0" }] };
  const { run, props } = setup([x]);
  props.fundChoices[holdingKey(x.holdings[0])] = { leftOut: true };
  await run.flush();
  assert.deepEqual(footerText(run), ["Nothing will be saved: no holding on this statement is ready to save."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("a kept account and a skipped holding alongside a printed zero keep the generic explanation", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = { ...source("Y", [holding("ISINY")]), zero: [{ ...holding("ISINZ"), units: "0", value: "0" }] };
  const { run, props } = sameDate([x, y]);
  props.accountChoices[sourceKey(y)] = "B";
  props.fundChoices[holdingKey(y.holdings[0])] = { leftOut: true };
  await run.flush();
  find(run, "AskCard").main.onClick();
  await settle(run);
  assert.deepEqual(footerText(run), ["Nothing will change: you kept the holdings already saved in A for 31 Mar 2025, and no other holding on this statement is ready to save."]);
  assert.equal(said(run), footerText(run)[0]);
});

test("the same fund in two folios gives each row's own reason when only one account has a misread line", async () => {
  const h = { ...holding("INFTEST"), kind: "fund" };
  const x = { ...source("X", [h]), kind: "folio" };
  const y = { ...source("Y", [{ ...h }]), kind: "folio" };
  const m = { ...source("M", []), misread: [{ ...h }] };
  const { run, props, api } = setup([x, y, m]);
  props.accountChoices[sourceKey(y)] = "B";
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Transactions", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id === "T" ? [{ holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: "asset-INFTEST", symbol: h.isin, quoteMode: "MARKET" } }] : [];
  api.assets.getProfile = async () => ({ instrumentSymbol: h.isin, instrumentExchangeMic: "XBOM" });
  await run.flush();
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.deepEqual(footerText(run), ["Nothing will be saved: every holding is already tracked in Transactions or may have been misread."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("an unchanged account's preview and later warning stay hidden while another account has an open question", async () => {
  const x = source("X", [holding("ISINX"), holding("ISINNEW")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, api } = sameDate([x, y], [["ISINX", "10"], ["ISINOLD", "5"]]);
  props.accountChoices[sourceKey(y)] = "B";
  api.snapshots.getAll = async (id) => id === "A" ? [{ snapshotDate: "2025-03-31", source: "MANUAL" }] : [{ snapshotDate: "2025-04-30", source: "MANUAL" }];
  await run.flush();
  find(run, "AskCard").other.onClick();
  await run.flush();
  nodes(find(run, "Footer").lines).filter((n) => n.type?.name === "LinkButton").find((n) => textOf(n).startsWith("See the holdings in B")).props.onClick();
  await run.flush();
  assert.equal(find(run, "SnapshotTable").account, "B");
  const ready = find(run, "ReadyTable");
  const row = ready.rows.find((r) => r.accountId === "B");
  ready.handlers.onChange(row);
  await run.flush();
  nodes(find(run, "ReadyTable").handlers.changePanel(row)).find((n) => n.type?.name === "Button" && textOf(n) === "Skip this holding").props.onClick();
  await run.flush();
  find(run, "AskAnswered").onChange();
  await run.flush();
  const footer = find(run, "Footer");
  assert.equal(footer.action.label, "Update holdings");
  assert.equal(footer.action.disabled, true);
  assert.equal(footer.narrow.warnings, 0);
  assert.ok(!textOf(footer.lines).includes("holdings in B"));
  assert.ok(!textOf(footer.lines).includes("current holdings in B"));
  assert.equal(find(run, "SnapshotTable"), undefined);
});

test("an open snapshot preview disappears when its last holding is skipped", async () => {
  const { run } = setup([source("X", [holding("ISINX")])]);
  await run.flush();
  nodes(find(run, "Footer").lines).find((n) => n.type?.name === "LinkButton").props.onClick();
  await run.flush();
  assert.ok(find(run, "SnapshotTable"));
  const ready = find(run, "ReadyTable");
  ready.handlers.onChange(ready.rows[0]);
  await run.flush();
  nodes(find(run, "ReadyTable").handlers.changePanel(ready.rows[0])).find((n) => n.type?.name === "Button" && textOf(n) === "Skip this holding").props.onClick();
  await run.flush();
  assert.equal(find(run, "Footer").action.label, "Finish");
  assert.equal(find(run, "SnapshotTable"), undefined);
});

test("a failed new account's retry disappears when its last holding is skipped", async () => {
  const { run } = withNewAccounts([source("X", [holding("ISINX")])], { refuse: new Set(["NSDL Demat"]) });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.ok(find(run, "NotCreatedAlert"));
  const ready = find(run, "ReadyTable");
  ready.handlers.onChange(ready.rows[0]);
  await run.flush();
  nodes(find(run, "ReadyTable").handlers.changePanel(ready.rows[0])).find((n) => n.type?.name === "Button" && textOf(n) === "Skip this holding").props.onClick();
  await run.flush();
  assert.equal(find(run, "Footer").action.label, "Finish");
  assert.equal(find(run, "NotCreatedAlert"), undefined);
  assert.ok(!nodes(run.tree).some((n) => n.type?.name === "WrapButton" && textOf(n) === "Try again"));
});

for (const kind of ["missing", "overlap"]) {
  test(`with nothing else to save, ${kind === "missing" ? "Set it to zero" : "Remove them"} still saves the account's snapshot, and keeping the units saves nothing`, async () => {
    // The account's only holding, which an earlier import of the folio added.
    const isin = kind === "missing" ? "INFOLD" : "INFTEST";
    const listed = kind === "missing" ? { ...holding("INFNEW"), kind: "fund" } : { ...holding("INFTEST"), kind: "fund" };
    const x = { ...source("X", [listed]), kind: "folio" };
    const { run, props, api } = setup([x]);
    // The folio's other fund is skipped; the tracked one is left out by default.
    if (kind === "missing") props.fundChoices[holdingKey(listed)] = { leftOut: true };
    else props.allAccounts = [...props.allAccounts, { id: "T", name: "Transactions", trackingMode: "TRANSACTIONS", isArchived: false }];
    const instrument = { id: `asset-${isin}`, symbol: isin, name: `Example ${isin}`, quoteMode: "MARKET" };
    api.snapshots.getAll = async (id) => id === "A" ? [{ snapshotDate: "2025-02-28", source: "MANUAL" }] : [];
    api.snapshots.getByDate = async (id) => id === "A" ? [{ holdingType: "security", quantity: "5", costBasis: null, localCurrency: "INR", instrument }] : [];
    api.portfolio.getHoldings = async (id) => id === "T" ? [{ holdingType: "security", quantity: "10", localCurrency: "INR", instrument }] : [];
    api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
    const stored = new Map();
    api.storage.get = async (key) => stored.get(key) ?? null;
    api.storage.set = async (key, value) => stored.set(key, value);
    const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
    await saveImported(api.storage, x, "A", "2025-02-28", { [`${isin}@XBOM`]: [isin] });
    const saved = [];
    api.snapshots.save = async (accountId, positions, cash, date) => { saved.push([accountId, positions.map((p) => [p.assetId, p.quantity]), date]); };
    api.query = { invalidateQueries() {} };
    await run.flush();
    const card = () => find(run, "AskCard");
    assert.deepEqual([card().main.label, card().other.label], kind === "missing" ? ["Keep 5.000 units", "Set it to zero on 31 Mar"] : ["Keep them in A", "Remove them from A"]);
    card().main.onClick();
    await settle(run);
    const why = kind === "missing" ? "every holding was skipped" : "every holding is already tracked in Transactions";
    assert.deepEqual(footerText(run), [`Nothing will be saved: ${why}.`]);
    assert.equal(said(run), `Nothing will be saved: ${why}.`);
    assert.equal(find(run, "Footer").action.label, "Finish");
    find(run, "AskAnswered").onChange();
    await run.flush();
    card().other.onClick();
    await run.flush();
    assert.match(footerText(run)[0], /^Update A to 31 Mar 2025 with 0 holdings from this statement\. Its other holdings and cash stay\./);
    assert.equal(find(run, "Footer").action.label, "Update holdings");
    find(run, "Footer").action.onClick();
    await run.flush();
    assert.deepEqual(saved, [["A", [], "2025-03-31"]]);
  });
}

test("a new account that nothing ready to save goes into isn't created while another account is saved", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, asked, saved } = withNewAccounts([x, y]);
  props.fundChoices[holdingKey(y.holdings[0])] = { leftOut: true };
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(y), proposedId(sourceKey(y)));
  await run.flush();
  assert.deepEqual(footerText(run).map((line) => line.replace(/See .*$/, "")), [
    "Create the Wealthfolio account NSDL Demat and save 1 holding on 31 Mar 2025.",
    "The new account Y demat won't be created: nothing ready to save goes into it.",
    "Purchase cost missing for 1 · Add costs",
  ]);
  assert.equal(find(run, "Footer").action.label, "Save holdings");
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat"]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }]);
  assert.deepEqual(outcomes(find(run, "HoldingsResult")), [["created-1", "saved"]]);
});

test("a source sent to its own new account gets one; one Wealthfolio doesn't create saves nothing, and Try again creates only it", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const refuse = new Set(["Y demat"]);
  const { run, asked, saved, remembers, logged } = withNewAccounts([x, y], { refuse });
  await run.flush();
  const investor = investorKey("TEST");
  find(run, "SaveTo").onChange(sourceKey(y), proposedId(sourceKey(y)));
  await run.flush();
  assert.deepEqual(footerText(run).map((line) => line.replace(/See .*$/, "")), [
    "Create the Wealthfolio account NSDL Demat and save 1 holding on 31 Mar 2025.",
    "Create the Wealthfolio account Y demat and save 1 holding on 31 Mar 2025.",
    "Purchase cost missing for 2 · Add costs",
  ]);
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat", "Y demat"]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }]);
  // Only the created account is remembered: Y's choice isn't, so the next statement asks again.
  assert.deepEqual(remembers.at(-1).accounts, [[investor, "created-1"]]);
  let result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["created-1", "saved"], [proposedId(sourceKey(y)), "not-created"]]);
  assert.match(logged.at(-1), /^Couldn't create the account Y demat: Error: made-up refusal of Y demat$/);
  refuse.clear();
  result.onRetryAccount(proposedId(sourceKey(y)));
  await run.flush();
  // Y's account only: NSDL Demat is never created twice.
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat", "Y demat", "Y demat"]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }, { accountId: "created-2", holdings: 1 }]);
  assert.deepEqual(remembers.at(-1).accounts, [[sourceKey(y), "created-2"]]);
  result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["created-1", "saved"], ["created-2", "saved"]]);
});

test("an account created but not saved into gets the snapshot on Try again, without another account", async () => {
  const { run, api, asked, saved } = withNewAccounts([source("X", [holding("ISINX")])]);
  let fail = true;
  const save = api.snapshots.save;
  api.snapshots.save = async (...args) => {
    if (fail) throw new Error("made-up snapshot failure");
    return save(...args);
  };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["created-1", "failed"]]);
  fail = false;
  result.onRetryAccount(result.result.accounts[0].key);
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat"]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }]);
  result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["created-1", "saved"]]);
});

test("retrying a failed snapshot replaces its repaired-price warning and keeps another account's warning", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, api, asked } = withNewAccounts([x, y]);
  for (const h of [x.holdings[0], y.holdings[0]]) {
    Object.assign(props.fundChoices[holdingKey(h)].fund, { assetId: h.isin, manual: true, statementPrices: true });
  }
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id, instrumentExchangeMic: "XBOM", quoteMode: "MANUAL" });
  let fail = true;
  const save = api.snapshots.save;
  api.snapshots.save = async (...args) => {
    if (fail && args[0] === "created-1") throw new Error("made-up snapshot failure");
    return save(...args);
  };
  const repaired = [];
  api.quotes = {
    getHistory: async () => [],
    update: async (id) => {
      if (fail) throw new Error("made-up price failure");
      repaired.push(id);
    },
  };
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(y), proposedId(sourceKey(y)));
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["created-1", "failed"], ["created-2", "saved"]]);
  assert.deepEqual(result.result.unfinished.map((f) => [f.accountId, f.what]), [["created-1", "price"], ["created-2", "price"]]);
  fail = false;
  result.onRetryAccount(result.result.accounts[0].key);
  await run.flush();
  result = find(run, "HoldingsResult");
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat", "Y demat"]);
  assert.deepEqual(repaired, ["ISINX"]);
  assert.deepEqual(outcomes(result), [["created-1", "saved"], ["created-2", "saved"]]);
  assert.deepEqual(result.result.unfinished.map((f) => [f.accountId, f.what, !!f.done]), [["created-2", "price", false]]);
  // The other account's price is retried on its own.
  result.onRetryUnfinished(result.result.unfinished[0]);
  await run.flush();
  result = find(run, "HoldingsResult");
  assert.deepEqual(repaired, ["ISINX", "ISINY"]);
  assert.deepEqual(result.result.unfinished.map((f) => [f.accountId, f.what, !!f.done]), [["created-2", "price", true]]);
});

test("when the only new account isn't created, nothing is saved or remembered for it and the review stays", async () => {
  const refuse = new Set(["NSDL Demat"]);
  const { run, asked, saved, remembers } = withNewAccounts([source("X", [holding("ISINX")])], { refuse });
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "HoldingsResult"), undefined);
  assert.deepEqual(saved, []);
  assert.deepEqual(remembers.map((r) => r.accounts), [[]]);
  const alert = find(run, "NotCreatedAlert");
  assert.deepEqual(alert.accounts.map((a) => a.name), ["NSDL Demat"]);
  assert.equal(alert.nothing, "saved");
  // Its Try again saves the review again.
  refuse.clear();
  const tryAgain = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Try again");
  tryAgain.props.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["NSDL Demat", "NSDL Demat"]);
  assert.deepEqual(saved, [{ accountId: "created-1", holdings: 1 }]);
  assert.deepEqual(remembers.at(-1).accounts, [[investorKey("TEST"), "created-1"]]);
});

test("Rename edits the new account's name in place, by Wealthfolio's rule, and saving waits for it", async () => {
  // An account that tracks transactions: its name can't be taken, so the two are never named alike.
  const { run, asked } = withNewAccounts([source("X", [holding("ISINX")])], {
    accounts: [{ id: "T", name: "Mutual funds", currency: "INR", trackingMode: "TRANSACTIONS", isActive: true, isArchived: false }],
  });
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  await run.flush();
  const investor = investorKey("TEST");
  const line = () => find(run, "SaveTo").newLine(investor, "Made-up Investor's holdings").props;
  line().onRename();
  await run.flush();
  assert.deepEqual(line().editing, { key: investor, draft: "NSDL Demat" });
  assert.equal(focused.at(-1), line().ids.field);
  assert.deepEqual(footerText(run), ["Save or cancel the new account name first."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Go to it");
  assert.equal(find(run, "ReviewHeader").changes, 1);
  for (const [draft, error] of [
    ["  ", "Enter an account name."], [" X ", "Use at least 2 characters."], ["x".repeat(51), "Use at most 50 characters."],
    [" mutual  FUNDS ", "Wealthfolio already has an account named mutual FUNDS. Use another name."],
  ]) {
    line().onDraft(draft);
    await run.flush();
    line().onSave();
    await run.flush();
    assert.equal(line().editing.error, error, draft);
    assert.equal(focused.at(-1), line().ids.field);
  }
  // Cancel leaves the name as it was.
  line().onCancel();
  await run.flush();
  assert.equal(line().editing, undefined);
  assert.equal(focused.at(-1), line().ids.rename);
  assert.equal(find(run, "SaveTo").proposed(investor).name, "NSDL Demat");
  line().onRename();
  await run.flush();
  line().onDraft("  My demat  ");
  await run.flush();
  line().onSave();
  await run.flush();
  assert.equal(line().editing, undefined);
  assert.equal(focused.at(-1), line().ids.rename);
  assert.equal(find(run, "SaveTo").proposed(investor).name, "My demat");
  assert.match(footerText(run)[0], /^Create the Wealthfolio account My demat and save 1 holding/);
  // Another new account can't be renamed to it either.
  const other = sourceKey(find(run, "SaveTo").sources[0]);
  const otherLine = () => find(run, "SaveTo").newLine(other, "X demat account").props;
  otherLine().onRename();
  await run.flush();
  otherLine().onDraft("my DEMAT");
  await run.flush();
  otherLine().onSave();
  await run.flush();
  assert.equal(otherLine().editing.error, "Another new account is already named my DEMAT. Use another name.");
  otherLine().onCancel();
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(asked.map((a) => a.name), ["My demat"]);
});

test("a new account can't take an existing account's label before or after creation", async () => {
  const accounts = ["4821", "7310"].map((end) => ({
    id: end, name: "Funds", accountNumber: end, currency: "INR", trackingMode: "HOLDINGS", isActive: true, isArchived: false,
  }));
  const { run, asked } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  const investor = investorKey("TEST");
  await run.flush();
  find(run, "SaveTo").onChange(investor, proposedId(investor));
  await run.flush();
  const before = [...find(run, "SaveTo").labels];
  const line = () => find(run, "SaveTo").newLine(investor, "holdings").props;
  line().onRename();
  await run.flush();
  line().onDraft("Funds (ending 4821)");
  await run.flush();
  line().onSave();
  await run.flush();
  assert.match(line().editing?.error ?? "", /Use another name/);
  line().onCancel();
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(asked.length, 1);
  assert.deepEqual(find(run, "HoldingsResult").result.accounts.map((a) => a.name), [asked[0].name]);
  const { accountLabels } = await server.ssrLoadModule("/src/lib/account-labels.ts");
  assert.deepEqual([...accountLabels([...accounts, { id: "created-1", ...asked[0] }])].slice(0, 2), before);
});

test("choosing an existing account closes an open Rename of the new one", async () => {
  const accounts = [{ id: "A", name: "Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  await run.flush();
  const investor = investorKey("TEST");
  find(run, "SaveTo").onChange(investor, proposedId(investor));
  await run.flush();
  find(run, "SaveTo").newLine(investor, "holdings").props.onRename();
  await run.flush();
  assert.deepEqual(footerText(run), ["Save or cancel the new account name first."]);
  find(run, "SaveTo").onChange(investor, "A");
  await run.flush();
  assert.equal(find(run, "SaveTo").newLine(investor, "holdings").props.editing, undefined);
  assert.equal(find(run, "Footer").action.disabled, false);
});

test("an open Rename keeps its footer message and Go to it when a planning read fails", async () => {
  const accounts = [{ id: "A", name: "Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, api } = withNewAccounts([source("X", [holding("ISINX")])], { accounts });
  api.portfolio.getHoldings = async () => { throw new Error("made-up read failure"); };
  await run.flush();
  const investor = investorKey("TEST");
  find(run, "SaveTo").onChange(investor, proposedId(investor));
  await run.flush();
  assert.equal(footerText(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  const line = () => find(run, "SaveTo").newLine(investor, "Made-up Investor's holdings").props;
  line().onRename();
  await run.flush();
  assert.deepEqual(footerText(run), ["Save or cancel the new account name first."]);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Go to it");
  line().onCancel();
  await run.flush();
  assert.equal(footerText(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  assert.equal(find(run, "Footer").go.label, "Try again");
});

test("Try again after an account isn't created waits for the same answers as saving, such as replacing a snapshot", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const accounts = [{ id: "A", name: "Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, api, saved } = withNewAccounts([x, y], { accounts, refuse: new Set(["NSDL Demat", "Y demat"]) });
  // Demat already has holdings saved for the statement's date.
  api.snapshots.getAll = async (id) => (id === "A" ? [{ id: "A-2025-03-31", snapshotDate: "2025-03-31", source: "MANUAL_ENTRY" }] : []);
  await run.flush();
  const investor = investorKey("TEST");
  find(run, "SaveTo").onChange(investor, proposedId(investor));
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(y), proposedId(sourceKey(y)));
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.equal(find(run, "HoldingsResult"), undefined);
  const tryAgain = () => nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Try again");
  assert.equal(tryAgain().props.disabled, false);
  // X now goes to Demat, whose snapshot of that day it would replace: saving waits for that answer.
  find(run, "SaveTo").onChange(sourceKey(x), "A");
  await run.flush();
  assert.deepEqual(find(run, "NotCreatedAlert").accounts.map((a) => a.name), ["Y demat"]);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(tryAgain().props.disabled, true);
  tryAgain().props.onClick();
  await run.flush();
  assert.deepEqual(saved, []);
});

test("the creation retry and planning retry have different accessible names", async () => {
  const accounts = [{ id: "A", name: "Demat", trackingMode: "HOLDINGS", isActive: true, isArchived: false }];
  const { run, api, saved } = withNewAccounts([source("X", [holding("ISINX")])], { accounts, refuse: new Set(["NSDL Demat"]) });
  await run.flush();
  find(run, "SaveTo").onChange(investorKey("TEST"), proposedId(investorKey("TEST")));
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.ok(find(run, "NotCreatedAlert"));
  api.portfolio.getHoldings = async () => { throw new Error("made-up planning failure"); };
  // Revisiting refreshes planning reads while the failed proposal is still selected.
  run.update({ visit: {} });
  await run.flush();
  assert.equal(footerText(run)[0], "We couldn't work out what will be saved. Nothing was saved.");
  const retry = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Try again");
  assert.equal(retry.props.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Try again");
  assert.equal(retry.props["aria-label"], "Try again saving holdings");
  assert.deepEqual(saved, []);
});

/** A holdings account `A` that already has a snapshot saved for the statement's date, 31 Mar 2025. */
function sameDate(sources, held = [["ISINX", "10"], ["ISINOLD", "5"]]) {
  const run = setup(sources);
  const { api } = run;
  api.snapshots.getAll = async (id) => (id === "A" ? [{ snapshotDate: "2025-03-31", source: "MANUAL" }] : []);
  api.snapshots.getByDate = async (id) => (id === "A"
    ? held.map(([isin, quantity]) => ({ holdingType: "security", quantity, costBasis: null, localCurrency: "INR", instrument: { id: `asset-${isin}`, name: `Example ${isin}`, symbol: isin, quoteMode: "MARKET" } }))
    : []);
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const saved = [];
  api.snapshots.save = async (accountId, positions) => saved.push([accountId, positions.map((p) => [p.assetId ?? p.symbol, p.quantity])]);
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  return { ...run, saved };
}
const said = (run) => nodes(run.tree).find((node) => node.props?.role === "status").props.children;
const settle = async (run) => {
  await run.flush();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await run.flush();
};

test("Change on a Ready row answers no question, unless its holding was asked about in this review (#291)", async () => {
  const [a, b, c] = ["ISINA", "ISINB", "ISINC"].map(holding);
  const asset = (symbol) => ({ symbol, exchangeMic: "XBOM", quoteCcy: "INR", name: `Asset ${symbol}`, instrumentType: "EQUITY", providerId: "YAHOO" });
  const heading = (run) => {
    const node = nodes(run.tree).find((n) => n.type === "h3" && /questions/i.test(textOf(n)));
    return node && textOf(node);
  };
  const answered = (run) => nodes(run.tree).filter((n) => n.type?.name === "AnsweredLine").map((n) => [n.props.item.isin, n.props.choice.fund?.symbol]);
  const changeOnReady = async (run, h, symbol) => {
    let ready = find(run, "ReadyTable");
    const row = ready.rows.find((r) => r.items.some((i) => i.key === holdingKey(h)));
    ready.handlers.onChange(row, row.items.find((i) => i.key === holdingKey(h)));
    await run.flush();
    ready = find(run, "ReadyTable");
    nodes(ready.handlers.changePanel(ready.rows.find((r) => r.id === ready.handlers.changing)))
      .find((node) => node.type?.name === "Picker").props.onUse(asset(symbol));
    await run.flush();
    assert.ok(find(run, "ReadyTable").rows.some((r) => r.fund.symbol === symbol && r.by === "you"));
  };

  // With no questions, a holding changed in its Ready row adds no Questions for you.
  const first = setup([source("X", [a, b, c])]);
  await settle(first.run);
  assert.equal(heading(first.run), undefined);
  await changeOnReady(first.run, a, "A-NEW");
  assert.equal(heading(first.run), undefined);
  assert.deepEqual(answered(first.run), []);
  let ready = find(first.run, "ReadyTable");
  ready.handlers.onChange(ready.rows.find((r) => r.items.some((i) => i.key === holdingKey(a))));
  await first.run.flush();
  ready = find(first.run, "ReadyTable");
  nodes(ready.handlers.changePanel(ready.rows.find((r) => r.id === ready.handlers.changing)))
    .find((n) => n.props?.["aria-label"]?.startsWith("Skip this holding:")).props.onClick();
  await first.run.flush();
  assert.equal(heading(first.run), undefined);
  assert.deepEqual(answered(first.run), []);
  assert.ok(!find(first.run, "ReadyTable").rows.some((r) => r.items.some((i) => i.key === holdingKey(a))));
  const { NotIncluded } = await server.ssrLoadModule("/src/components/review/not-included.tsx");
  const skipped = nodes(NotIncluded(find(first.run, "NotIncluded")))
    .find((n) => n.props?.["aria-label"] === "Change: Example ISINA, skipped");
  assert.ok(skipped, "a row skipped through Change can be changed again under Not included");
  skipped.props.onClick();
  await first.run.flush();
  assert.equal(heading(first.run), "Questions for you · 1 of 1 left");
  find(first.run, "QuestionCard").onAnswer({ fund: asset("A-RESTORED") });
  await first.run.flush();
  assert.deepEqual(answered(first.run), [["ISINA", "A-RESTORED"]]);
  assert.ok(find(first.run, "ReadyTable").rows.some((r) => r.fund.symbol === "A-RESTORED" && r.by === "you"));
  // Leaving the source out drops the answer. Restoring it uses the remembered asset again.
  find(first.run, "SaveTo").onChange(investorKey("TEST"), LEFT_OUT);
  await first.run.flush();
  find(first.run, "SaveTo").onChange(investorKey("TEST"), "A");
  await first.run.flush();
  assert.ok(find(first.run, "ReadyTable").rows.some((r) => r.fund.symbol === "ISINA" && r.by === "before"));
  await changeOnReady(first.run, a, "A-AFTER-RESET");
  assert.equal(heading(first.run), undefined);
  assert.deepEqual(answered(first.run), []);
  first.run.dispose();

  // With questions open, it doesn't count as one of them.
  const { run, props } = setup([source("X", [a, b, c])]);
  delete props.fundChoices[holdingKey(b)];
  delete props.fundChoices[holdingKey(c)];
  await settle(run);
  assert.equal(heading(run), "Questions for you · 2 of 2 left");
  await changeOnReady(run, a, "A-NEW");
  assert.equal(heading(run), "Questions for you · 2 of 2 left");
  assert.deepEqual(answered(run), []);
  // A holding that was asked about keeps its answered line, with the new choice, when changed again in its Ready row.
  find(run, "QuestionCard").onAnswer({ fund: asset("B-ASSET") });
  await run.flush();
  assert.equal(heading(run), "Questions for you · 1 of 2 left");
  assert.deepEqual(answered(run), [["ISINB", "B-ASSET"]]);
  await changeOnReady(run, b, "B-NEW");
  await changeOnReady(run, a, "A-NEWER");
  assert.equal(heading(run), "Questions for you · 1 of 2 left");
  assert.deepEqual(answered(run), [["ISINB", "B-NEW"]]);
  find(run, "QuestionCard").onAnswer({ leftOut: true });
  await run.flush();
  assert.equal(heading(run), "Questions for you");
  assert.ok(nodes(run.tree).some((n) => n.type === "span" && n.props.children === "All 2 questions answered."));
  assert.deepEqual(answered(run).map(([isin]) => isin), ["ISINB", "ISINC"]);
});

test("excluding every source after a failed refresh drops obsolete questions and allows Finish", async () => {
  const { run, api, saved } = sameDate([source("X", [holding("ISINX")])]);
  await run.flush();
  assert.ok(find(run, "AskCard"));
  api.portfolio.getHoldings = async () => { throw new Error("made-up failed refresh"); };
  run.update({ visit: {} });
  await run.flush();
  find(run, "SaveTo").onChange(investorKey("TEST"), LEFT_OUT);
  await run.flush();
  assert.equal(find(run, "AskCard"), undefined);
  const footer = find(run, "Footer");
  assert.equal(footer.action.label, "Finish");
  assert.equal(footer.action.disabled, false);
  assert.equal(footer.go, undefined);
  const notices = [];
  run.update({ onAnother: (notice) => notices.push(notice) });
  await run.flush();
  find(run, "Footer").action.onClick();
  assert.deepEqual(notices, ["Finished: nothing from made-up.pdf was saved."]);
  assert.deepEqual(saved, []);
});

test("refreshing saved holdings reopens the same-date and holding questions", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = sameDate([x]);
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "ISINOLD@XBOM": ["ISINOLD"] });
  await run.flush();
  const cards = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
  assert.equal(cards.length, 2);
  cards[0].other.onClick();
  cards[1].other.onClick();
  await run.flush();
  assert.equal(find(run, "Footer").action.disabled, false);
  const refreshed = ["ISINX", "ISINOLD"].map((isin) => ({
    holdingType: "security", quantity: "123", costBasis: null, localCurrency: "INR",
    instrument: { id: `asset-${isin}`, name: `Example ${isin}`, symbol: isin, quoteMode: "MARKET" },
  }));
  let finish;
  api.snapshots.getByDate = () => new Promise((resolve) => { finish = () => resolve(refreshed); });
  run.update({ visit: {} });
  await run.flush();
  const oldCards = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
  assert.ok(oldCards.every((c) => c.disabled));
  oldCards.forEach((c) => c.other.onClick());
  await run.flush();
  finish();
  await run.flush();
  const reopened = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
  assert.equal(reopened.length, 2);
  assert.match(reopened[1].main.label, /Keep 123\.000 units/);
  assert.equal(find(run, "AskAnswered"), undefined);
  assert.equal(find(run, "Footer").action.disabled, true);
});

for (const changed of ["none", "units", "new holding", "units after failed retry"]) test(`retrying a failed plan keeps only unchanged snapshot and holding answers (${changed})`, async () => {
  const added = holding("ISINNEW");
  const x = source("X", [holding("ISINX"), added]);
  const { run, props, api } = sameDate([x]);
  delete props.fundChoices[holdingKey(added)];
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "ISINOLD@XBOM": ["ISINOLD"] });
  await run.flush();
  const cards = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
  assert.equal(cards.length, 2);
  cards.forEach((card) => card.other.onClick());
  await run.flush();
  const answered = () => nodes(run.tree).filter((node) => node.type?.name === "AskAnswered").map((node) => node.props.text);
  const choices = answered();
  assert.equal(choices.length, 2);
  let fail = true;
  const getProfile = api.assets.getProfile;
  api.assets.getProfile = async (id) => {
    if (fail && id === "asset-ISINNEW") throw new Error("made-up temporary profile read failure");
    return getProfile(id);
  };
  const newFund = {
    symbol: added.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: added.name, instrumentType: "EQUITY",
    providerId: "YAHOO", assetId: "asset-ISINNEW", manual: true,
  };
  find(run, "QuestionCard").onAnswer({ fund: newFund });
  await run.flush();
  assert.match(find(run, "Footer").lines.map(textOf).join(" "), /We couldn't work out what will be saved/);
  assert.deepEqual(answered(), choices);
  fail = changed === "units after failed retry";
  if (changed !== "none") {
    const getByDate = api.snapshots.getByDate;
    api.snapshots.getByDate = async (id) => {
      const positions = await getByDate(id);
      if (changed.startsWith("units")) return positions.map((p) => p.instrument.id === "asset-ISINOLD" ? { ...p, quantity: "123" } : p);
      return [...positions, { holdingType: "security", quantity: "7", costBasis: null, localCurrency: "INR",
        instrument: { id: "asset-ISINOTHER", name: "Other holding", symbol: "ISINOTHER", quoteMode: "MARKET" } }];
    };
  }
  find(run, "Footer").go.onClick();
  await run.flush();
  if (changed === "units after failed retry") {
    assert.match(find(run, "Footer").lines.map(textOf).join(" "), /We couldn't work out what will be saved/);
    fail = false;
    find(run, "AnsweredLine").onChange();
    await run.flush();
    find(run, "QuestionCard").onAnswer({ fund: newFund });
    await run.flush();
  }
  if (changed === "none") {
    assert.deepEqual(answered(), choices, "recovering unchanged evidence keeps both answers");
    assert.equal(find(run, "AskCard"), undefined);
    assert.equal(find(run, "Footer").action.disabled, false);
  } else {
    const cards = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
    assert.equal(cards.length, changed.startsWith("units") ? 2 : 1, "changed snapshot evidence needs a fresh answer");
    assert.equal(answered().length, changed.startsWith("units") ? 0 : 1, "an unchanged holding's answer stays");
    if (changed.startsWith("units")) assert.match(cards[1].main.label, /Keep 123\.000 units/);
    assert.equal(find(run, "Footer").action.disabled, true);
  }
});

test("the first announcement counts the questions about saved holdings", async () => {
  // The same-date question and the question about ISINOLD, which the statement no longer lists.
  const x = source("X", [holding("ISINX")]);
  const { run, api } = sameDate([x]);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  const stored = new Map();
  await saveImported({ get: async (key) => stored.get(key) ?? null, set: async (key, value) => stored.set(key, value) }, x, "A", "2025-02-28", { "ISINOLD@XBOM": ["ISINOLD"] });
  api.storage.get = async (key) => stored.get(key) ?? null;
  await settle(run);
  assert.equal(nodes(run.tree).filter((node) => node.type?.name === "AskCard").length, 2);
  assert.equal(said(run), "2 questions for you.");
});

test("holdings saved for the statement's date are asked about first, and keeping them saves nothing there", async () => {
  const x = { ...holding("ISINX"), units: "12" };
  // Shares and bonds are counted as such, and a fund in units.
  const bond = { ...holding("ISINBOND"), kind: "bond", units: "3" };
  const fund = { ...holding("INFFUND"), kind: "fund", name: "Example Fund" };
  const { run, props, saved } = sameDate([source("X", [x, holding("ISINNEW"), holding("ISINASK"), bond, fund])], [["ISINX", "10"], ["ISINOLD", "5"], ["ISINBOND", "2"]]);
  delete props.fundChoices[holdingKey(holding("ISINASK"))];
  await run.flush();
  const [card] = nodes(run.tree).filter((node) => node.type?.name === "AskCard").map((node) => node.props);
  assert.equal(card.title, "A already has holdings saved for 31 Mar 2025");
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("|") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.equal(textOf(card.children), "Replacing them with this statement changes:|" + [
    "Example ISINX: 10 shares now, 12 on this statement", "Example ISINNEW: added, 10 shares",
    "Example ISINBOND: 2 bonds now, 3 on this statement", "Example Fund: added, 10.000 units",
    "Example ISINASK: 10 shares on this statement, still to be matched", "1 other holding: same units",
  ].join("|"));
  assert.deepEqual([card.main.name, card.other.name], ["Keep the saved ones: holdings in A for 31 Mar 2025", "Replace them with this statement: holdings in A for 31 Mar 2025"]);
  assert.ok(find(run, "QuestionCard"), "the holding to match is asked about too");
  assert.equal(find(run, "Footer").action.disabled, true);
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  card.main.onClick();
  await settle(run);
  // Its holdings and their question go; nothing is saved, and Finish says so.
  assert.equal(find(run, "QuestionCard"), undefined);
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.equal(find(run, "AskAnswered").text, "A: kept the holdings already saved for 31 Mar 2025");
  assert.ok(nodes(run.tree).some((node) => node.type?.name === "Badge" && node.props.children?.join?.("") === "A kept as saved"));
  assert.deepEqual(find(run, "Footer").lines.map(textOf), ["Nothing will change: you kept the holdings already saved in A for 31 Mar 2025."]);
  assert.equal(find(run, "Footer").action.label, "Finish");
  assert.deepEqual(focused, ["review-summary"]);
  assert.equal(said(run), "Nothing will be saved. The holdings in A for 31 Mar 2025 are kept.");
  const notices = [];
  run.update({ onAnother: (notice) => notices.push(notice) });
  await run.flush();
  find(run, "Footer").action.onClick();
  assert.deepEqual(notices, ["Finished: nothing from made-up.pdf was saved. The holdings in A for 31 Mar 2025 are kept."]);
  assert.deepEqual(saved, []);
  // Change answer brings the question back, focused.
  find(run, "AskAnswered").onChange();
  await run.flush();
  assert.equal(focused.at(-1), card.headingId);
  assert.ok(find(run, "QuestionCard"));
});

test("keeping one account's saved holdings still saves another's, and warns when the kept one still holds what goes elsewhere", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, saved } = sameDate([x, y], [["ISINX", "10"], ["ISINY", "4"]]);
  props.accountChoices[sourceKey(y)] = "B";
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  find(run, "AskCard").main.onClick();
  await run.flush();
  // B still saves Y's holding, which A holds too.
  const ready = find(run, "ReadyTable");
  assert.deepEqual(ready.rows.map((r) => [r.accountId, r.item.isin]), [["B", "ISINY"]]);
  const warning = "A will still hold Example ISINY. Saving it in B too would count its units twice.";
  assert.ok(textOf(run.tree).includes(warning));
  const lines = find(run, "Footer").lines.map(textOf);
  assert.ok(lines.includes("A: existing holdings kept for 31 Mar 2025."), lines.join("\n"));
  assert.ok(lines.includes(warning));
  // Saving: only B, and the result repeats the warning.
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(saved.map(([accountId]) => accountId), ["B"]);
  assert.ok(textOf(run.tree).includes("A: the holdings already saved for 31 Mar 2025 were kept; nothing changed there."));
  assert.ok(textOf(run.tree).includes(warning));
});

test("keeping one account's saved holdings when every other holding is skipped saves nothing, and the bar says both", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, saved } = sameDate([x, y]);
  props.accountChoices[sourceKey(y)] = "B";
  props.fundChoices[holdingKey(y.holdings[0])] = { leftOut: true };
  await run.flush();
  find(run, "AskCard").main.onClick();
  await settle(run);
  const words = "Nothing will change: you kept the holdings already saved in A for 31 Mar 2025, and every other holding was skipped.";
  assert.deepEqual(footerText(run), [words]);
  assert.equal(said(run), words);
  assert.equal(find(run, "Footer").action.label, "Finish");
  find(run, "Footer").action.onClick();
  await run.flush();
  assert.deepEqual(saved, []);
});

test("Keep … in the kept account assigns it there itself, and with nothing left to save the focus goes to the summary", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, saved } = sameDate([x, y], [["ISINX", "10"], ["ISINY", "4"]]);
  // The main destination is B; only X goes to A, which has holdings saved for the date.
  props.accountChoices = { [investorKey("TEST")]: "B", [sourceKey(x)]: "A" };
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  find(run, "AskCard").main.onClick();
  await run.flush();
  const keep = nodes(run.tree).find((node) => node.type?.name === "WrapButton" && textOf(node) === "Keep the Y demat account in A");
  assert.ok(keep, textOf(run.tree));
  document.activeElement = document.body;
  focused.length = 0;
  keep.props.onClick();
  await settle(run);
  // Y now goes to A itself, not "Same as above", which is B.
  assert.equal(find(run, "SaveTo").values[sourceKey(y)], "A");
  assert.deepEqual(focused, ["review-summary"]);
  assert.equal(said(run), "Nothing will be saved. The holdings in A for 31 Mar 2025 are kept.");
  assert.equal(find(run, "Footer").action.label, "Finish");
  assert.deepEqual(saved, []);
});

test("Keep in the kept account focuses Finish when another account's only holding is skipped", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const z = source("Z", [holding("ISINZ")]);
  const { run, props } = sameDate([x, y, z], [["ISINX", "10"], ["ISINY", "4"]]);
  props.accountChoices = { [investorKey("TEST")]: "B", [sourceKey(x)]: "A" };
  props.fundChoices[holdingKey(z.holdings[0])] = { leftOut: true };
  await run.flush();
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  find(run, "AskCard").main.onClick();
  await run.flush();
  document.activeElement = document.body;
  focused.length = 0;
  nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Keep the Y demat account in A").props.onClick();
  await settle(run);
  assert.equal(find(run, "ReadyTable"), undefined);
  assert.deepEqual(focused, ["review-summary"]);
  assert.equal(said(run), "Nothing will change: you kept the holdings already saved in A for 31 Mar 2025, and every other holding was skipped.");
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("Keep in the kept account focuses an unanswered holding before announcing Finish", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const z = source("Z", [holding("ISINZ")]);
  const { run, props } = sameDate([x, y, z], [["ISINX", "10"], ["ISINY", "4"]]);
  props.accountChoices = { [investorKey("TEST")]: "B", [sourceKey(x)]: "A" };
  delete props.fundChoices[holdingKey(z.holdings[0])];
  await settle(run);
  document.activeElement = document.body;
  const focused = [];
  document.getElementById = (id) => ({ dataset: {}, focus() { focused.push(id); }, scrollIntoView() {} });
  find(run, "AskCard").main.onClick();
  await run.flush();
  focused.length = 0;
  nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Keep the Y demat account in A").props.onClick();
  await settle(run);
  assert.deepEqual(focused, [find(run, "QuestionCard").headingId]);
  assert.equal(said(run), "Y demat account now goes to A, whose holdings for 31 Mar 2025 are kept.");
  assert.equal(find(run, "Footer").action.disabled, true);
});

test("keeping a snapshot drops its overlap controls but preserves another source's overlap", async () => {
  const fund = { ...holding("INFTEST"), kind: "fund" };
  const x = { ...source("X", [fund]), kind: "folio" };
  const y = { ...source("Y", [{ ...fund, units: "20", value: "40" }]), kind: "folio" };
  const { run, props, api } = sameDate([x, y], [["INFTEST", "10"]]);
  props.accountChoices[sourceKey(y)] = "B";
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Transactions", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [{
    holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: "asset-INFTEST", symbol: "INFTEST", quoteMode: "MARKET" },
  }];
  await run.flush();
  find(run, "AskCard").main.onClick();
  await run.flush();
  const tracked = find(run, "NotIncluded").tracked[0].funds[0];
  assert.equal(tracked.canSave, true);
  assert.equal(tracked.units, "20.000 units", "only the source still saving is compared");
  find(run, "SaveTo").onChange(sourceKey(y), "A");
  await run.flush();
  assert.deepEqual(find(run, "NotIncluded").tracked, []);
  assert.equal(find(run, "Footer").action.label, "Finish");
});

test("two accounts of one name are told apart in open questions and answered lines, shown and in names", async () => {
  const fund = { ...holding("INFTEST"), kind: "fund" };
  const x = { ...source("X", [fund]), kind: "folio" };
  const y = { ...source("Y", [fund]), kind: "folio" };
  const { run, props, api } = setup([x, y]);
  props.accounts.forEach((a) => { a.name = "Funds"; });
  props.accountChoices[sourceKey(y)] = "B";
  props.allAccounts = [...props.allAccounts, { id: "T", name: "Transactions", trackingMode: "TRANSACTIONS", isArchived: false }];
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => [{
    holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR",
    instrument: { id: "asset-INFTEST", symbol: "INFTEST", name: "Example INFTEST", quoteMode: "MARKET" },
  }];
  api.portfolio.getHoldings = async (id) => id !== "T" ? [] : [{
    holdingType: "security", quantity: "10", localCurrency: "INR", instrument: { id: "asset-INFTEST", symbol: "INFTEST", quoteMode: "MARKET" },
  }];
  api.assets.getProfile = async () => ({ instrumentSymbol: "INFTEST", instrumentExchangeMic: "XBOM" });
  const store = new Map();
  api.storage.get = async (key) => store.get(key) ?? null;
  api.storage.set = async (key, value) => store.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "INFTEST@XBOM": ["INFTEST"] });
  await saveImported(api.storage, y, "B", "2025-02-28", { "INFTEST@XBOM": ["INFTEST"] });
  await run.flush();
  const cards = nodes(run.tree).filter((n) => n.type?.name === "AskCard").map((n) => n.props);
  assert.equal(cards.length, 2);
  // Nothing else tells them apart, so they're numbered in Wealthfolio's order, in their buttons as on them.
  assert.deepEqual(cards.map((c) => [c.main.label, c.main.name]), cards.map((c, i) => [`Keep them in Funds (account ${i + 1})`, `Keep them in Funds (account ${i + 1}): Example INFTEST in Funds (account ${i + 1})`]));
  assert.deepEqual(cards.map((c) => c.other.name), cards.map((c, i) => `Remove them from Funds (account ${i + 1}): Example INFTEST in Funds (account ${i + 1})`));
  // Answered alike, their lines name the accounts the same way, so they and Change answer's names differ.
  cards.forEach((c) => c.main.onClick());
  await run.flush();
  const answers = nodes(run.tree).filter((n) => n.type?.name === "AskAnswered").map((n) => n.props);
  const lines = [1, 2].map((n) => `Example INFTEST: 10.000 units kept in Funds (account ${n})`);
  assert.deepEqual(answers.map((a) => [a.text, a.name]), lines.map((line) => [line, line]));
});

test("two holdings accounts of one name with holdings saved for the date are told apart in their cards, lines, Save to and the bar", async () => {
  const x = source("X", [{ ...holding("INFTEST"), kind: "fund" }]);
  const y = source("Y", [{ ...holding("INFOTHER"), kind: "fund" }]);
  const { run, props, api } = sameDate([x, y], [["INFTEST", "10"]]);
  props.accounts.forEach((a, i) => Object.assign(a, { name: "Funds", currency: "INR", accountNumber: ["1234 4821", "5678 7310"][i] }));
  props.accountChoices[sourceKey(y)] = "B";
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-03-31", source: "MANUAL" }];
  api.snapshots.getByDate = async () => [{
    holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR",
    instrument: { id: "asset-INFTEST", symbol: "INFTEST", name: "Example INFTEST", quoteMode: "MARKET" },
  }];
  await run.flush();
  const cards = () => nodes(run.tree).filter((n) => n.type?.name === "AskCard").map((n) => n.props);
  // Each account is shown with the end of its account number, as Wealthfolio shows it beside them, in
  // its card's title and its buttons' names alike.
  assert.deepEqual(cards().map((c) => [c.title, c.main.name]), ["(ending 4821)", "(ending 7310)"].map((end) => [
    `Funds ${end} already has holdings saved for 31 Mar 2025`, `Keep the saved ones: holdings in Funds ${end} for 31 Mar 2025`,
  ]));
  assert.deepEqual(["A", "B"].map((id) => find(run, "SaveTo").labels.get(id).option), ["Funds (ending 4821) · INR", "Funds (ending 7310) · INR"]);
  cards()[0].main.onClick();
  await run.flush();
  cards()[0].other.onClick();
  await run.flush();
  const answers = nodes(run.tree).filter((n) => n.type?.name === "AskAnswered").map((n) => n.props);
  assert.deepEqual(answers.map((a) => [a.text, a.name]), [
    "Funds (ending 4821): kept the holdings already saved for 31 Mar 2025", "Funds (ending 7310): replaced the holdings saved for 31 Mar 2025 with this statement",
  ].map((line) => [line, line]));
  // Reopened, the card names its account as its line did.
  answers[1].onChange();
  await run.flush();
  assert.deepEqual(cards().map((c) => c.title), ["Funds (ending 7310) already has holdings saved for 31 Mar 2025"]);
  cards()[0].other.onClick();
  await run.flush();
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  const bar = find(run, "Footer").lines.map(textOf).join(" | ");
  assert.match(bar, /Funds \(ending 7310\)/);
  assert.doesNotMatch(bar, /Funds(?! \(ending)/);
});

for (const existingIds of [false, true]) {
  test(`one kept fund saved in two other accounts is counted once while both sources can be kept (existing IDs ${existingIds})`, async () => {
    const fund = { ...holding("INFTEST"), kind: "fund" };
    const x = source("X", [fund]);
    const y = source("Y", [fund]);
    const z = source("Z", [fund]);
    const { run, props, api, saved } = sameDate([x, y, z], [["INFTEST", "10"]]);
    props.accounts.push({ id: "C", name: "C", trackingMode: "HOLDINGS", isActive: true, isArchived: false });
    props.accountChoices[sourceKey(y)] = "B";
    props.accountChoices[sourceKey(z)] = "C";
    if (existingIds) {
      api.snapshots.getAll = async (id) => [{ snapshotDate: id === "A" ? "2025-03-31" : "2025-02-28", source: "MANUAL" }];
      api.snapshots.getByDate = async (id) => [{
        holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR",
        instrument: { id: `asset-${id}`, symbol: "INFTEST", name: "Example INFTEST", quoteMode: "MARKET" },
      }];
      api.assets.getProfile = async () => ({ instrumentSymbol: "INFTEST", instrumentExchangeMic: "XBOM" });
    }
    await run.flush();
    find(run, "AskCard").main.onClick();
    await run.flush();
    const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
    const warnings = find(run, "Footer").lines.map(textOf).filter((s) => s.includes("will still hold"));
    assert.deepEqual(warnings, ["A will still hold Example INFTEST. Saving it in B and C too would count its units twice."]);
    const keep = nodes(run.tree).find((n) => n.type?.name === "WrapButton" && textOf(n) === "Keep these 2 statement sections in A");
    keep.props.onClick();
    await run.flush();
    const values = find(run, "SaveTo").values;
    assert.equal(values[sourceKey(y)], "A");
    assert.equal(values[sourceKey(z)], "A");
    assert.equal(find(run, "Footer").action.label, "Finish");
    assert.deepEqual(saved, []);
  });
}

for (const keptAccount of ["A", "B"]) {
  test(`same-named kept accounts have distinct rerouting controls, selecting ${keptAccount}`, async () => {
    const fund = { ...holding("INFTEST"), kind: "fund" };
    const x = source("X", [fund]);
    const y = source("Y", [fund]);
    const z = source("Z", [fund]);
    const { run, props, api, saved } = sameDate([x, y, z], [["INFTEST", "10"]]);
    props.accounts.forEach((a) => { a.name = "Funds"; });
    props.accounts.push({ id: "C", name: "C", trackingMode: "HOLDINGS", isActive: true, isArchived: false });
    props.accountChoices[sourceKey(y)] = "B";
    props.accountChoices[sourceKey(z)] = "C";
    api.snapshots.getAll = async (id) => id === "A" || id === "B" ? [{ snapshotDate: "2025-03-31", source: "MANUAL" }] : [];
    api.snapshots.getByDate = async (id) => id === "A" || id === "B" ? [{
      holdingType: "security", quantity: "10", costBasis: null, localCurrency: "INR",
      instrument: { id: "asset-INFTEST", symbol: "INFTEST", name: "Example INFTEST", quoteMode: "MARKET" },
    }] : [];
    await run.flush();
    nodes(run.tree).filter((n) => n.type?.name === "AskCard").forEach((n) => n.props.main.onClick());
    await run.flush();
    const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
    // Each button says which account it keeps them in, so its text is its name.
    const buttons = nodes(run.tree).filter((n) => n.type?.name === "WrapButton" && textOf(n).startsWith("Keep the Z demat account in Funds"));
    assert.deepEqual(buttons.map((b) => [textOf(b), b.props["aria-label"]]), [
      ["Keep the Z demat account in Funds (account 1)", undefined], ["Keep the Z demat account in Funds (account 2)", undefined],
    ]);
    buttons[keptAccount === "A" ? 0 : 1].props.onClick();
    await run.flush();
    assert.equal(find(run, "SaveTo").values[sourceKey(z)], keptAccount);
    assert.equal(find(run, "Footer").action.label, "Finish");
    assert.deepEqual(saved, []);
  });
}

test("different recorded references have distinct question and answer IDs, and Change focuses the reopened holding", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = setup([x]);
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => ["OLD.A", "OLD_A"].map((symbol) => ({
    holdingType: "security", quantity: "5", costBasis: null, localCurrency: "INR",
    instrument: { id: `asset-${symbol}`, symbol, name: `Example ${symbol}`, quoteMode: "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const store = new Map();
  api.storage.get = async (key) => store.get(key) ?? null;
  api.storage.set = async (key, value) => store.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "OLD.A@XBOM": ["OLDISIN1"], "OLD_A@XBOM": ["OLDISIN2"] });
  await run.flush();
  const cards = nodes(run.tree).filter((n) => n.type?.name === "AskCard").map((n) => n.props);
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((c) => c.headingId)).size, 2);
  const focused = [];
  document.activeElement = document.body;
  document.getElementById = (id) => {
    const card = nodes(run.tree).find((n) => n.type?.name === "AskCard" && n.props.headingId === id)?.props;
    return { dataset: {}, focus() { focused.push(card?.title ?? "summary"); }, scrollIntoView() {} };
  };
  for (const card of cards) {
    card.main.onClick();
    await run.flush();
  }
  const answers = nodes(run.tree).filter((n) => n.type?.name === "AskAnswered").map((n) => n.props);
  assert.equal(new Set(answers.map((a) => a.buttonId)).size, 2);
  answers[0].onChange();
  await run.flush();
  assert.equal(focused.at(-1), cards[0].title);
  answers[1].onChange();
  await run.flush();
  assert.equal(focused.at(-1), cards[1].title);
});

test("a changed fund's new replacement question gets focus without leaving a stale Change request", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", []);
  const { run, api } = setup([x, y]);
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => ["ISINX", "BETA"].map((symbol) => ({
    holdingType: "security", quantity: "5", costBasis: null, localCurrency: "INR",
    instrument: { id: `asset-${symbol}`, symbol, name: `Example ${symbol}`, quoteMode: "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const store = new Map();
  api.storage.get = async (key) => store.get(key) ?? null;
  api.storage.set = async (key, value) => store.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "ISINX@XBOM": ["ISINX"] });
  await saveImported(api.storage, y, "A", "2025-02-28", { "BETA@XBOM": ["ISINBETA"] });
  await run.flush();
  const cards = () => nodes(run.tree).filter((n) => n.type?.name === "AskCard").map((n) => n.props);
  let ready = find(run, "ReadyTable");
  const row = ready.rows.find((r) => r.item.isin === "ISINX");
  document.activeElement = document.body;
  document.getElementById = (id) => {
    const rendered = new Set(cards().map((c) => c.headingId));
    const current = find(run, "ReadyTable");
    for (const r of current?.rows ?? []) {
      rendered.add(current.handlers.ids(r).change);
      if (current.handlers.changing === r.id) rendered.add(current.handlers.changePanel(r).props.id);
    }
    rendered.add(find(run, "Footer").summaryId);
    if (document.activeElement?.id && !rendered.has(document.activeElement.id)) document.activeElement = document.body;
    if (!rendered.has(id)) return null;
    const element = { id, dataset: {}, focus() { document.activeElement = element; }, scrollIntoView() {} };
    return element;
  };
  ready.handlers.onChange(row);
  await run.flush();
  ready = find(run, "ReadyTable");
  const picker = nodes(ready.handlers.changePanel(ready.rows[0])).find((n) => n.type?.name === "Picker").props;
  document.activeElement = document.body;
  picker.onUse({ symbol: "NEW", name: "New listing", exchangeMic: "XBOM", quoteCcy: "INR", providerId: "YAHOO", instrumentType: "EQUITY" });
  await run.flush();
  const replacement = cards().find((c) => c.title.includes("now matched"));
  const beta = cards().find((c) => c.title.includes("BETA"));
  assert.equal(document.activeElement?.id, replacement.headingId);
  document.activeElement = document.body;
  replacement.other.onClick();
  await run.flush();
  assert.equal(document.activeElement?.id, beta.headingId);
});

for (const retry of [false, true]) test(`a holding the statement no longer lists keeps its answer${retry ? " through a failed save and return" : ", with nothing preselected"}`, async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = setup([x]);
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => ["ISINX", "ISINOLD"].map((isin) => ({ holdingType: "security", quantity: "5", costBasis: null, localCurrency: "INR", instrument: { id: `asset-${isin}`, name: `Example ${isin}`, symbol: isin, quoteMode: "MARKET" } }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "ISINX@XBOM": ["ISINX"], "ISINOLD@XBOM": ["ISINOLD"] });
  const saved = [];
  let fail = retry;
  api.snapshots.save = async (accountId, positions) => {
    if (fail) { fail = false; throw new Error("made-up snapshot failure"); }
    saved.push(positions.map((p) => [p.assetId ?? p.symbol, p.quantity]));
  };
  api.query = { invalidateQueries() {} };
  await run.flush();
  const card = find(run, "AskCard");
  assert.deepEqual([card.title, card.main.label, card.other.label], ["Example ISINOLD isn't on this statement", "Keep 5.000 units", "Set it to zero on 31 Mar"]);
  assert.equal(card.why.open, false);
  assert.equal(find(run, "Footer").action.disabled, true);
  assert.equal(find(run, "Footer").go.label, "Go to the question");
  card.other.onClick();
  await run.flush();
  assert.equal(find(run, "AskAnswered").text, "Example ISINOLD: set to zero in A on 31 Mar");
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
  assert.match(textOf(find(run, "Footer").lines[0]), /^Update A to 31 Mar 2025 with 1 holding from this statement\. Its other holdings and cash stay\.Example ISINOLD set to zero\./);
  find(run, "Footer").action.onClick();
  await run.flush();
  if (retry) {
    assert.deepEqual(saved, []);
    run.update({ visit: {} });
    await run.flush();
    find(run, "HoldingsResult").onRetryAccount("A");
    await run.flush();
  }
  assert.deepEqual(saved, [[["asset-ISINX", "10"]]]);
});

for (const [type, symbol, five, seven] of [
  ["EQUITY", "ISINOLD", "5 shares", "7 shares"], ["BOND", "ISINOLD", "5 bonds", "7 bonds"],
  ["EQUITY", "INFY", "5 shares", "7 shares"],
  // Wealthfolio stores funds as EQUITY too: a fund's symbol counts units, as does an unknown type.
  ["EQUITY", "INFZ90K01LQ6", "5.000 units", "7.000 units"], [undefined, "ISINOLD", "5.000 units", "7.000 units"],
]) test(`a holding only the account has is counted as its ${type ?? "untyped"} asset ${symbol} is: ${five}`, async () => {
  const x = source("X", [holding("ISINX")]);
  const { run, api } = setup([x]);
  // An earlier import of X added the old holding; nothing added the one priced by hand, which is kept as it is.
  const hand = symbol === "INFZ90K01LQ6" ? "INFZ90K01FC8" : `${symbol}HAND`;
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => [["ISINX", "5"], [symbol, "5"], [hand, "7"]].map(([isin, quantity]) => ({
    holdingType: "security", quantity, costBasis: isin === hand ? { local: 700 } : null, localCurrency: "INR",
    instrument: { id: `asset-${isin}`, name: `Example ${isin}`, symbol: isin, quoteMode: isin === hand ? "MANUAL" : "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({
    instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM", instrumentType: id === "asset-ISINX" ? "EQUITY" : type,
    quoteMode: id === `asset-${hand}` ? "MANUAL" : "MARKET",
  });
  api.quotes = { getHistory: async () => [] };
  const stored = new Map();
  api.storage.get = async (key) => stored.get(key) ?? null;
  api.storage.set = async (key, value) => stored.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  await saveImported(api.storage, x, "A", "2025-02-28", { "ISINX@XBOM": ["ISINX"], [`${symbol}@XBOM`]: [symbol] });
  await run.flush();
  const card = find(run, "AskCard");
  assert.deepEqual([card.main.label, textOf(card.children)], [`Keep ${five}`, `A holds ${five} of it, from an earlier import of X demat account.`]);
  card.main.onClick();
  await run.flush();
  assert.equal(find(run, "AskAnswered").text, `Example ${symbol}: ${five} kept in A`);
  assert.ok(footerText(run)[0].includes(`Example ${symbol} kept at ${five}.`), footerText(run)[0]);
  // Kept as they are.
  assert.ok(textOf(run.tree).includes(`Example ${hand} · ${seven} in A`), textOf(run.tree));
});

test("a question about a fund whose line may have been misread gives no units, as they're unknown", async () => {
  // casparser read its NAV as 0, so its units may be wrong too.
  const misread = { ...holding("INFZ90K01LQ6"), kind: "fund", name: "Fictiva Liquid Fund - Direct Plan - Growth", units: "1000", price: "0", value: "25000" };
  const read = { ...misread, units: "40", price: "25", value: "1000" };
  const folio = (id, holdings, more) => ({ ...source(id, holdings), kind: "folio", ...more });
  for (const [sources, units] of [
    [[folio("F1", [], { misread: [misread] })], undefined],
    // Another folio's line of it is read, but the misread one's units are still unknown.
    [[folio("F1", [], { misread: [misread] }), folio("F2", [read])], undefined],
    [[folio("F2", [read])], "40.000 units"],
  ]) {
    const { run, props } = setup(sources, false);
    props.accountChoices = { [investorKey("TEST")]: "A" };
    await run.flush();
    const card = find(run, "QuestionCard");
    assert.equal(card.units, units, sources.map((s) => s.id).join());
    // Nor does it count the places its units are in.
    assert.equal(card.where, units === undefined ? MISREAD : undefined);
    run.dispose();
  }
  for (const keep of [false, true]) {
    const unread = folio("F1", [], { misread: [misread] });
    const { run, props, api } = setup([unread, folio("F2", [read])], false);
    props.accountChoices = { [investorKey("TEST")]: "B", [sourceKey(unread)]: keep ? "A" : LEFT_OUT };
    if (keep) api.snapshots.getAll = async (id) => id === "A" ? [{ snapshotDate: "2025-03-31", source: "MANUAL" }] : [];
    await run.flush();
    if (keep) {
      assert.equal(find(run, "AskCard").title, "A already has holdings saved for 31 Mar 2025");
      find(run, "AskCard").main.onClick();
      await run.flush();
    }
    assert.equal(find(run, "QuestionCard").units, "40.000 units", keep ? "misread source's account kept" : "misread source not saved");
    assert.equal(find(run, "QuestionCard").where, "in 1 of 2 folios");
    run.dispose();
  }
});

test("a snapshot Wealthfolio doesn't save in an existing account gets its own Try again, and the other account's stays saved", async () => {
  const x = source("X", [holding("ISINX")]);
  const y = source("Y", [holding("ISINY")]);
  const { run, props, api, logged } = setup([x, y]);
  props.accounts.forEach((a, i) => Object.assign(a, { name: "Funds", currency: "INR", accountNumber: ["4821", "7310"][i] }));
  const saved = [];
  let fail = true;
  api.snapshots.save = async (accountId) => {
    if (fail && accountId === "B") throw new Error("made-up snapshot failure");
    saved.push(accountId);
  };
  api.storage.set = async () => {};
  api.query = { invalidateQueries() {} };
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(y), "B");
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["A", "saved"], ["B", "failed"]]);
  assert.equal(find(run, "ReviewHeader").unfinished, true, "leaving a partial result asks before discarding answers");
  assert.deepEqual(saved, ["A"]);
  assert.equal(result.result.accounts[1].name, "Funds (ending 7310)");
  assert.match(logged.at(-1), /^Couldn't save the snapshot of Funds on 2025-03-31: Error: made-up snapshot failure$/);
  // B's Try again saves B only: A isn't saved again.
  fail = false;
  result.onRetryAccount("B");
  await run.flush();
  result = find(run, "HoldingsResult");
  assert.deepEqual(saved, ["A", "B"]);
  assert.deepEqual(outcomes(result), [["A", "saved"], ["B", "saved"]]);
});

test("import history that couldn't be saved, and a fund's details, are each saved again on their own", async () => {
  const bond = { ...holding("INEZ91A07012"), kind: "bond", name: "Example Bond", details: { name: "Example Bond", coupon: "7.5" } };
  const { run, props, api, logged } = setup([source("X", [bond])]);
  props.accounts.forEach((a, i) => Object.assign(a, { name: "Funds", currency: "INR", accountNumber: ["4821", "7310"][i] }));
  props.fundChoices[holdingKey(bond)].fund.assetId = "bond-asset";
  api.assets.getProfile = async (id) => ({ id, instrumentSymbol: bond.isin, instrumentExchangeMic: "XBOM", instrumentType: "BOND", metadata: null });
  let failStorage = true;
  let failProfile = true;
  const stored = new Map();
  const updated = [];
  api.snapshots.save = async () => {};
  api.storage.set = async (key, value) => {
    if (failStorage) throw new Error("made-up storage failure");
    stored.set(key, value);
  };
  api.assets.updateProfile = async (profile) => {
    if (failProfile) throw new Error("made-up profile failure");
    updated.push(profile.id);
  };
  api.query = { invalidateQueries() {} };
  await run.flush();
  find(run, "Footer").action.onClick();
  await run.flush();
  let result = find(run, "HoldingsResult");
  assert.deepEqual(outcomes(result), [["A", "saved"]]);
  assert.deepEqual(result.result.history.map((h) => [h.accountId, !!h.done]), [["A", false]]);
  assert.ok(logged.some((line) => line.startsWith("Couldn't save the import history of Funds: ")), logged.join(" | "));
  assert.deepEqual(result.result.unfinished.map((u) => [u.what, u.name, !!u.done]), [["details", bond.name, false]]);
  await new Promise((resolve) => setTimeout(resolve, 85));
  await run.flush();
  const notice = nodes(run.tree).find((n) => n.props?.role === "status").props.children;
  assert.match(notice, /The statement's details for Example Bond weren't saved\. Retry saving the details\./);
  assert.match(notice, /Holdings saved, but the import history couldn't be saved\./);
  result.onRetryHistory();
  await run.flush();
  assert.ok(logged.some((line) => line.startsWith("Couldn't save the import history of Funds again: ")), logged.join(" | "));
  // The details' retry doesn't save the history, and the history's doesn't save the details.
  failProfile = false;
  result.onRetryUnfinished(result.result.unfinished[0]);
  await run.flush();
  result = find(run, "HoldingsResult");
  assert.deepEqual(updated, ["bond-asset"]);
  assert.deepEqual(result.result.unfinished.map((u) => [u.what, !!u.done]), [["details", true]]);
  assert.equal(stored.size, 0);
  failStorage = false;
  result.onRetryHistory();
  await run.flush();
  result = find(run, "HoldingsResult");
  assert.ok(stored.size > 0);
  assert.deepEqual(result.result.history.map((h) => [h.accountId, !!h.done]), [["A", true]]);
  assert.deepEqual(updated, ["bond-asset"]);
});

test("a search Wealthfolio rejects says so at the top until a search answers again, and an empty one doesn't", async () => {
  const { run, api } = setup([source("X", [holding("ISINX")]), source("Y", [holding("ISINY")])], false);
  let answer = () => Promise.reject(new Error("made-up provider failure"));
  api.market.searchTicker = () => answer();
  await run.flush();
  assert.equal(find(run, "SearchDown").down, true);
  const question = find(run, "QuestionCard");
  assert.equal(question.search.auto.status, "failed");
  // Nothing found is an answer: searching works.
  answer = () => Promise.resolve([]);
  question.searches.retry(question.item);
  await run.flush();
  assert.equal(find(run, "SearchDown").down, false);
});

// #238: in a narrow frame the bar shows one line and its button with Details; the rest folds.
test("the bar's narrow form says what one account gets in one line and folds the rest, warnings counted", async () => {
  const { run, api } = setup([source("X", [holding("ISINX")])]);
  // A holds a snapshot after the statement's date: the later-snapshot warning.
  api.snapshots.getAll = async (id) => id === "A" ? [{ snapshotDate: "2025-06-30", source: "MANUAL" }] : [];
  run.update({ visit: {} });
  await run.flush();
  const { lines, narrow } = find(run, "Footer");
  assert.deepEqual(lines.map(textOf), [
    "Save 1 holding in A on 31 Mar 2025." +
      "This saves holdings history for 31 Mar 2025. The current holdings in A still come from its snapshot of 30 Jun 2025." +
      "See the holdings in A on 31 Mar 2025 after saving",
    "Purchase cost missing for 1 · Add costs",
  ]);
  assert.equal(textOf(narrow.brief), "Save 1 holding in A on 31 Mar 2025.");
  assert.deepEqual(narrow.more.map(textOf), [
    "This saves holdings history for 31 Mar 2025. The current holdings in A still come from its snapshot of 30 Jun 2025.",
    "See the holdings in A on 31 Mar 2025 after saving",
    "Purchase cost missing for 1 · Add costs",
  ]);
  assert.equal(narrow.warnings, 2, "the later snapshot and the missing cost");
});

test("the bar's narrow form says what several accounts get in one line, each account's lines folded", async () => {
  const x = source("X", [holding("ISINX")]);
  const { run } = setup([x, source("Y", [holding("ISINY"), holding("ISINZ")])]);
  await run.flush();
  find(run, "SaveTo").onChange(sourceKey(x), "B");
  await run.flush();
  const { lines, narrow } = find(run, "Footer");
  assert.equal(textOf(narrow.brief), "Save 3 holdings in 2 accounts on 31 Mar 2025.");
  assert.deepEqual(narrow.more.map(textOf), lines.map(textOf), "every line, in a wide frame's order");
  assert.deepEqual(lines.map(textOf).slice(0, 2).map((line) => line.replace(/\..*/, ".")), [
    "Save 1 holding in B on 31 Mar 2025.",
    "Save 2 holdings in A on 31 Mar 2025.",
  ]);
  assert.equal(narrow.warnings, 1, "the missing costs");
});

test("in a narrow frame the bar shows its brief and Details beside its button, and the folded lines once opened", async () => {
  const { run } = setup([source("X", [holding("ISINX")])]);
  await run.flush();
  const footer = nodes(run.tree).find((node) => node.type?.name === "Footer");
  run.dispose();
  active = undefined;
  document.documentElement = { style: {} };
  document.querySelector = () => null;
  const { summaryId } = footer.props;
  const render = async (props, wide) => {
    active?.dispose();
    active = controller(props, footer.type, { wide });
    await active.flush();
  };
  const byId = (id) => nodes(active.tree).find((node) => node.props?.id === id);
  const toggle = () => nodes(active.tree).find((node) => node.type?.name === "LinkButton" && node.props["aria-controls"] === `${summaryId}-details`);
  // The buttons' row: the main button, then Details at its end.
  const row = () => nodes(active.tree).find((node) => node.props?.className === "flex flex-wrap items-center gap-2").props.children.filter(Boolean);
  await render({ ...footer.props }, false);
  assert.equal(textOf(byId(summaryId)), "Save 1 holding in A on 31 Mar 2025.");
  assert.deepEqual(row().map((node) => node.type?.name), ["WrapButton", "LinkButton"]);
  assert.equal(textOf(toggle().props.children), "Details · 1 warning");
  assert.equal(toggle().props["aria-expanded"], false);
  assert.equal(byId(`${summaryId}-details`).props.hidden, true);
  assert.deepEqual(byId(`${summaryId}-details`).props.children.map(textOf), [
    "See the holdings in A on 31 Mar 2025 after saving",
    "Purchase cost missing for 1 · Add costs",
  ]);
  toggle().props.onClick();
  await active.flush();
  assert.equal(textOf(toggle().props.children), "Hide details");
  assert.equal(toggle().props["aria-expanded"], true);
  assert.equal(byId(`${summaryId}-details`).props.hidden, false);
  assert.equal(textOf(byId(summaryId)), "Save 1 holding in A on 31 Mar 2025.", "the brief stays above them");
  // Without warnings, Details says nothing more.
  await render({ ...footer.props, narrow: { ...footer.props.narrow, warnings: 0 } }, false);
  assert.equal(textOf(toggle().props.children), "Details");
  // A wide frame shows every line, with nothing folded.
  await render({ ...footer.props }, true);
  assert.deepEqual(byId(summaryId).props.children.map(textOf), footer.props.lines.map(textOf));
  assert.equal(toggle(), undefined);
  assert.equal(byId(`${summaryId}-details`), undefined);
  // Nothing to fold: the lines as they are, without Details.
  await render({ ...footer.props, narrow: { ...footer.props.narrow, more: [] } }, false);
  assert.deepEqual(byId(summaryId).props.children.map(textOf), footer.props.lines.map(textOf));
  assert.equal(toggle(), undefined);
});

test("switching the bar's width keeps focus when a footer control moves, without taking it from elsewhere", async () => {
  const { run } = setup([source("X", [holding("ISINX")])]);
  await run.flush();
  const footer = nodes(run.tree).find((node) => node.type?.name === "Footer");
  run.dispose();
  active = undefined;
  document.documentElement = { style: {} };
  document.querySelector = () => null;
  const summary = { focus() { document.activeElement = this; } };
  document.getElementById = (id) => id === footer.props.summaryId ? summary : null;
  active = controller({ ...footer.props }, footer.type, { wide: false });
  await active.flush();
  const focus = () => {
    const element = { isConnected: true };
    document.activeElement = element;
    active.tree.props.onFocusCapture?.({ target: element });
    return element;
  };
  const detach = (element) => { element.isConnected = false; document.activeElement = document.body; };
  const resize = async (wide) => { active.resize(wide); await active.flush(); };
  // Details goes away on widening; a wide summary's link moves into the folded details on narrowing.
  for (const wide of [true, false]) {
    detach(focus());
    await resize(wide);
    assert.equal(document.activeElement, summary, `${wide ? "wide" : "narrow"}: the visible summary gets focus`);
  }
  const main = focus();
  await resize(true);
  assert.equal(document.activeElement, main, "a button that stays keeps its focus");
  detach(focus());
  const outside = document.activeElement = {};
  await resize(false);
  assert.equal(document.activeElement, outside, "a focus moved elsewhere in the page stays there");
  detach(focus());
  document.hasFocus = () => false;
  await resize(true);
  assert.equal(document.activeElement, document.body, "the add-on does not take focus back from Wealthfolio");
  document.hasFocus = () => true;
  const blurred = focus();
  active.tree.props.onBlurCapture?.();
  detach(blurred);
  await resize(false);
  assert.equal(document.activeElement, document.body, "a control that lost focus before resizing is not restored");
  // An unrelated removal must not leave a handoff waiting for a later width change.
  detach(focus());
  active.update({});
  await active.flush();
  await resize(true);
  assert.equal(document.activeElement, document.body, "an earlier removal does not move focus later");
});

test("opened in a short frame, the bar's details fit below the sticky header and scroll, focusable while they do", async (t) => {
  const globals = ["window", "getComputedStyle", "ResizeObserver"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { run } = setup([source("X", [holding("ISINX")])]);
  await run.flush();
  const footer = nodes(run.tree).find((node) => node.type?.name === "Footer");
  run.dispose();
  active = undefined;
  const { summaryId } = footer.props;
  // A 72 px sticky header; the bar's brief and buttons take 115 px, its details 150 px unless capped.
  const header = { getBoundingClientRect: () => ({ height: 72 }) };
  document.documentElement = { style: {} };
  document.querySelector = () => header;
  globalThis.getComputedStyle = () => ({ position: "sticky" });
  let resized;
  globalThis.window = { innerHeight: 300, addEventListener: (_, fn) => { resized = fn; }, removeEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const shown = () => Math.min(150, parseFloat(details.style.maxHeight) || 150);
  const details = {
    hidden: true, style: {}, scrollHeight: 150,
    get clientHeight() { return shown(); },
    getBoundingClientRect: () => ({ height: details.hidden ? 0 : shown() }),
  };
  const bar = { getBoundingClientRect: () => ({ height: 115 + details.getBoundingClientRect().height }) };
  active = controller({ ...footer.props }, (props) => {
    const tree = footer.type(props);
    tree.props.ref.current = bar;
    const panel = nodes(tree).find((node) => node.props?.id === `${summaryId}-details`);
    panel.props.ref.current = details;
    details.hidden = panel.props.hidden;
    return tree;
  }, { wide: false });
  await active.flush();
  const panel = () => nodes(active.tree).find((node) => node.props?.id === `${summaryId}-details`).props;
  assert.equal(panel().tabIndex, undefined, "folded: nothing to scroll");
  nodes(active.tree).find((node) => node.props?.["aria-controls"] === `${summaryId}-details`).props.onClick();
  await active.flush();
  // 300 - 72 - 115 - 8 = 105 px left, under 40% of the frame (120 px): the details scroll there.
  assert.equal(details.style.maxHeight, "105px");
  assert.deepEqual([panel().tabIndex, panel().role, panel()["aria-label"]], [0, "region", "Details"]);
  // A taller frame: 40% of it, and the 150 px fit.
  window.innerHeight = 1000;
  resized();
  await active.flush();
  assert.equal(details.style.maxHeight, "400px");
  assert.equal(panel().tabIndex, undefined, "nothing to scroll");
  // A frame too short for both: two lines still show, scrolling.
  window.innerHeight = 200;
  resized();
  await active.flush();
  assert.equal(details.style.maxHeight, "40px");
  assert.equal(panel().tabIndex, 0);
});

test("Kept as they are lists the account's holdings that aren't on the statement, misread or asked about, with their units, account and note", async () => {
  const fund = (isin) => ({ ...holding(isin), kind: "fund" });
  // X goes to A, listing two funds and a line that may have been misread; Y isn't saved.
  const x = { ...source("X", [fund("INFLISTED"), fund("INFNEW")]), misread: [fund("INFHELD")] };
  const y = source("Y", [fund("INFOTHER")]);
  const { run, props, api } = setup([x, y]);
  props.accountChoices[sourceKey(y)] = LEFT_OUT;
  props.fundChoices[holdingKey(x.misread[0])] = {
    fund: { symbol: "INFHELD", exchangeMic: "XBOM", quoteCcy: "INR", name: "Example INFHELD", instrumentType: "MUTUALFUND", providerId: "YAHOO" },
  };
  // Listed and asked-about holdings have notes too, so neither exclusion can rely on a missing note.
  const manual = new Set(["INFLISTED", "INFMISS", "OLD"]);
  const held = { INFKEPT: "1250.5", INFLISTED: "2", INFMISS: "10", INFNONE: "7", INFHELD: "3", OLD: "4" };
  api.snapshots.getAll = async () => [{ snapshotDate: "2025-02-28", source: "MANUAL" }];
  api.snapshots.getByDate = async () => Object.entries(held).map(([symbol, quantity]) => ({
    holdingType: "security", quantity, localCurrency: "INR", costBasis: manual.has(symbol) ? { local: "400" } : null,
    instrument: { id: `asset-${symbol}`, symbol, name: `Example ${symbol}`, quoteMode: manual.has(symbol) ? "MANUAL" : "MARKET" },
  }));
  api.assets.getProfile = async (id) => ({ instrumentSymbol: id.replace(/^asset-/, ""), instrumentExchangeMic: "XBOM" });
  api.quotes = { getHistory: async () => [] };
  const store = new Map();
  api.storage.get = async (key) => store.get(key) ?? null;
  api.storage.set = async (key, value) => store.set(key, value);
  const { saveImported } = await server.ssrLoadModule("/src/lib/choices.ts");
  // X added INFKEPT and INFMISS, which it no longer lists, and OLD for the fund it now lists as INFNEW; Y added INFKEPT too.
  await saveImported(api.storage, x, "A", "2025-02-28", { "INFKEPT@XBOM": ["INFKEPT"], "INFMISS@XBOM": ["INFMISS"], "OLD@XBOM": ["INFNEW"] });
  await saveImported(api.storage, y, "A", "2025-02-28", { "INFKEPT@XBOM": ["INFKEPT"] });
  await run.flush();
  const kept = () => {
    const section = nodes(run.tree).find((n) => n.props?.["aria-labelledby"] === "review-kept-as-is");
    return section && nodes(section).filter((n) => n.type === "li").map((li) => li.props.children.flat().map(textOf));
  };
  const keptINFKEPT = [
    "Example INFKEPT · 1,250.500 units in A",
    "An earlier import of X demat account added it, and X demat account no longer lists it. " +
    "An earlier import of Y demat account, which this import leaves out, added it too, so it's kept. " +
    "Correct its units in Wealthfolio after saving: they may include some that came from X demat account, and none are left if Y demat account no longer holds any.",
  ];
  const keptOLD = [
    "Example OLD · 4.000 units in A",
    "It's priced by hand and has no price on or before this date. If you save this account's snapshot and no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date if you keep it.",
  ];
  // INFMISS is asked about, INFNONE has no note, INFHELD's line may have been misread, and OLD is
  // kept until the user replaces it with INFNEW.
  assert.deepEqual(kept(), [keptINFKEPT, keptOLD]);
  const cards = () => nodes(run.tree).filter((n) => n.type?.name === "AskCard").map((n) => n.props);
  assert.deepEqual(cards().map((c) => c.title), ["Example INFMISS isn't on this statement", "Example INFNEW is now matched to Example INFNEW (INFNEW · XBOM)"]);
  // Set to zero, INFMISS is removed; replaced with INFNEW, OLD is too.
  for (const card of cards()) {
    card.other.onClick();
    await run.flush();
  }
  assert.deepEqual(kept(), [keptINFKEPT]);
  // Keeping OLD after all lists it again.
  nodes(run.tree).filter((n) => n.type?.name === "AskAnswered").map((n) => n.props).at(-1).onChange();
  await run.flush();
  cards()[0].main.onClick();
  await run.flush();
  assert.deepEqual(kept(), [keptINFKEPT, keptOLD]);
});

// #292: the note was said only when Save to's lists numbered an account.
for (const holds of [true, false]) {
  test(`Save to explains a numbered account that holds a statement's fund though it lists only others (${holds ? "held" : "not held"})`, async () => {
    const { SaveTo } = await server.ssrLoadModule("/src/components/review/save-to.tsx");
    const fund = { ...holding("INFZ90A01017"), kind: "fund", units: "20", value: "40" };
    const { run, props, api } = setup([{ ...source("X", [fund]), kind: "folio" }]);
    // Two accounts named Mutual funds that only their place tells apart, both tracking transactions;
    // Save to lists only A and B, which track holdings.
    const accounts = [{ id: "T1", name: "Mutual funds" }, { id: "T2", name: "Mutual funds" }];
    props.allAccounts = [...props.allAccounts, ...accounts.map((a) => ({ ...a, currency: "INR", trackingMode: "TRANSACTIONS", isActive: true, isArchived: false }))];
    api.portfolio.getHoldings = async (id) => !holds || id !== "T1" ? [] : [{
      holdingType: "security", quantity: "4", localCurrency: "INR", instrument: { id: "tracked", symbol: fund.isin, name: fund.name, quoteMode: "MARKET" },
    }];
    api.assets.getProfile = async () => ({ instrumentSymbol: fund.isin, instrumentExchangeMic: "XBOM" });
    await run.flush();
    const saveTo = find(run, "SaveTo");
    const note = nodes(SaveTo(saveTo)).find((node) => node.type?.name === "NumberedNote");
    const shown = note.type(note.props);
    if (!holds) {
      assert.equal(shown, null, "no line names a numbered account");
      return;
    }
    assert.equal(find(run, "NotIncluded").tracked[0].accounts, "Mutual funds (account 1)");
    assert.equal(textOf(shown).replace(/\s+/g, " "), "A number after a name, as in Mutual funds (account 1), is the account's place among the accounts of that name in " +
      "Wealthfolio under Settings → Accounts, counting hidden and archived ones. Giving them different names in Wealthfolio tells them apart.");
    assert.equal(nodes(SaveTo(saveTo)).some((node) => node.props?.describedBy), false, "the selects list no numbered account");
  });
}

// #292: an NPS scheme is searched by name, so a search that finds nothing asked to check a code it hasn't got.
test("an NPS scheme's typed search that finds nothing is announced as asking to check the name", async () => {
  const scheme = { kind: "nps", name: "SBI Pension Fund Scheme E - Tier I", isin: null, rta: null, rtaCode: null, code: "NPS-SBI-E-I", units: "10", price: "2", value: "20", cost: null };
  const { run } = setup([{ id: "nps|1", kind: "nps", label: "NPS", title: "NPS account", holdings: [scheme] }], false);
  await run.flush();
  let question = find(run, "QuestionCard");
  assert.equal(question.item.noun, "NPS scheme");
  question.searches.setText(question.item.key, "SBI Scheme E");
  await run.flush();
  question = find(run, "QuestionCard");
  question.searches.search(question.item);
  await settle(run);
  assert.equal(said(run), "Nothing found for “SBI Scheme E”. Check the name.");
});

// #292: what "I've added AMFI: check" found came back after a review, as if it were news about it.
test("what an AMFI check found is cleared when a statement is read and when its review is left, even when the answer comes after", async (t) => {
  const { ImportPage } = await server.ssrLoadModule("/src/pages/import-page.tsx");
  const { readFile } = await import("node:fs/promises");
  const nsdl = JSON.parse(await readFile("tests/fixtures/made-up-nsdl.json", "utf8"));
  const cams = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (window) Object.defineProperty(globalThis, "window", window);
    else delete globalThis.window;
  });
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { activeElement: {}, body: {}, hasFocus: () => true, getElementById: () => null };
  // Each check waits for its answer, given in the test's order.
  const answers = [];
  const answer = (enabled) => answers.shift()(enabled === undefined ? [] : [{ id: "AMFI", name: "AMFI", enabled }]);
  const api = {
    market: { getProviders: () => new Promise((resolve) => answers.push(resolve)) },
    accounts: { getAll: async () => [] },
    storage: { get: async () => null },
    navigation: { navigate: async () => {} },
    toast: { error() {} },
  };
  const run = active = controller({ ctx: { api }, location: {} }, ImportPage);
  /** AMFI as the form shows it, or the review. */
  const amfi = () => (find(run, "AmfiBanner") ?? find(run, "HoldingsImport") ?? find(run, "DetailedImport")).amfi;
  const step = () => find(run, "HoldingsImport") ? "holdings" : find(run, "DetailedImport") ? "detailed" : "form";
  const read = async (statement) => {
    await find(run, "StatementForm").onRead(statement, "made-up.pdf");
    await run.flush();
  };
  const leave = async () => {
    (find(run, "HoldingsImport") ?? find(run, "DetailedImport")).onAnother("Finished: nothing was saved.");
    // After the form's focus check, which runs on a timer.
    await settle(run);
  };
  const check = async () => {
    amfi().check();
    await run.flush();
    assert.equal(amfi().checking, true);
  };
  await run.flush();
  answer(false);
  await run.flush();
  assert.deepEqual([step(), amfi().status, amfi().shown], ["form", "off", true]);
  amfi().openSettings();
  await run.flush();

  // A check on the form, answered there, is said there and not on the Review screen.
  await check();
  answer(false);
  await run.flush();
  assert.equal(amfi().outcome, "AMFI isn't added yet.");
  await read(nsdl);
  assert.deepEqual([step(), amfi().status, amfi().outcome, amfi().checking], ["holdings", "off", "", false]);

  // A check during the holdings review is said there, and not on the form it returns to.
  await check();
  answer(false);
  await run.flush();
  assert.equal(amfi().outcome, "AMFI isn't added yet.");
  await leave();
  assert.deepEqual([step(), amfi().outcome, amfi().checking], ["form", "", false]);
  assert.ok(nodes(run.tree).some((node) => textOf(node) === "Finished: nothing was saved."));

  // A check on the form answered after a statement is read says nothing on the Review screen, but its status counts.
  await check();
  await read(cams);
  assert.deepEqual([step(), amfi().checking], ["detailed", false]);
  answer(undefined);
  await run.flush();
  assert.deepEqual([step(), amfi().status, amfi().outcome, amfi().checking], ["detailed", "unknown", "", false]);

  // A check during the detailed review answered after the return says nothing on the form, but AMFI
  // found on still searches again for the funds without a choice.
  await check();
  await leave();
  assert.deepEqual([step(), amfi().checking, amfi().searches], ["form", false, 0]);
  answer(true);
  await run.flush();
  assert.deepEqual([step(), amfi().status, amfi().outcome, amfi().checking, amfi().searches], ["form", "on", "", false, 1]);
  assert.equal(answers.length, 0);
});
