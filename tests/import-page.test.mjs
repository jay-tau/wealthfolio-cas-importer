// Exercises the import page's reading and remembering of account choices with made-up host data and
// in-memory storage, without a browser: the page's hooks run, its child components stay React elements.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import { createServer } from "vite";
import { sha256 } from "../src/lib/sha256.ts";

let server;
let ImportPage;
let choices;
let active;
const fixture = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));

before(async () => {
  const names = ["useState", "useRef", "useMemo", "useCallback", "useEffect", "useLayoutEffect"];
  server = await createServer({
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "page-hooks",
      enforce: "pre",
      resolveId(id) { if (id === "page-hooks") return "\0page-hooks"; },
      load(id) {
        if (id === "\0page-hooks") return names.map((name) => `export const ${name} = (...args) => globalThis.pageHooks.${name}(...args);`).join("\n");
      },
      transform(code, id) {
        if (/src\/(pages\/import-page\.tsx|components\/amfi-banner\.tsx|lib\/focus\.ts)$/.test(id)) return code.replaceAll('from "react"', 'from "page-hooks"');
      },
    }],
  });
  ({ ImportPage } = await server.ssrLoadModule("/src/pages/import-page.tsx"));
  choices = await server.ssrLoadModule("/src/lib/choices.ts");
});
afterEach(() => {
  active?.dispose();
  active = undefined;
  delete globalThis.pageHooks;
  delete globalThis.window;
});
after(() => server?.close());

/** The page, rendered again whenever its state changes, with its effects run. */
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
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: effect,
    useLayoutEffect: effect,
  };
  return {
    async flush() {
      for (let i = 0; i < 40; i++) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          globalThis.pageHooks = hooks;
          tree = ImportPage(props);
          const pending = effects;
          effects = [];
          pending.forEach((fn) => fn());
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(dirty, false, "the page settled");
    },
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

const account = (id, name, more = {}) => ({ id, name, currency: "INR", trackingMode: "TRANSACTIONS", isActive: true, isArchived: false, ...more });
const ACCOUNTS = [account("mf", "Mutual funds"), account("kids", "Kid's funds"), account("bank", "Savings"), account("old-bank", "Old savings", { isArchived: true })];

/** The page with `stored` choices, and the made-up statement whose first folio's fund house is printed as `amc`. */
async function page(stored, amc) {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const data = new Map(Object.entries(stored));
  const errors = [];
  const api = {
    storage: { get: async (key) => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); }, delete: async (key) => { data.delete(key); } },
    accounts: { getAll: async () => ACCOUNTS },
    market: { getProviders: async () => [] },
    toast: { error: (message) => errors.push(message) },
  };
  active = controller({ ctx: { api }, location: {} });
  const run = active;
  await run.flush();
  const statement = structuredClone(fixture);
  statement.folios[0].amc = amc;
  const read = async () => {
    await find(run, "StatementForm").onRead(structuredClone(statement), "made-up.pdf");
    await run.flush();
    return find(run, "DetailedImport");
  };
  return { run, data, errors, read, api, statement, folio: statement.folios[0] };
}

const pan = () => choices.panKey("ABCDE1234F");
/** The key versions before #280 gave a folio's choices: by the fund house's name as printed. */
const printedKey = (amc, folio) => `folio:${sha256(`cas-importer folio ${amc}|${folio}`)}`;

test("a folio's choices under its fund house's former name are used, said, and saved under its key on import, and its former keys go", async () => {
  for (const [to, bank] of [["kids", choices.NO_BANK], [choices.LEFT_OUT, "bank"]]) {
    const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
    const { run, data, errors, read, folio } = await page({ [pan()]: "mf", [old]: to, [choices.bankKey(old)]: bank }, "Bandhan Mutual Fund");
    const own = choices.folioKey(folio);
    let review = await read();
    assert.equal(review.accountChoices[own], to);
    assert.equal(review.accountChoices[choices.bankKey(own)], bank);
    assert.deepEqual(review.formerNames, { [own]: "IDFC Mutual Fund", [choices.bankKey(own)]: "IDFC Mutual Fund" });
    assert.deepEqual(review.unavailable, {});
    // Nothing is saved until the review remembers its choices.
    assert.deepEqual([data.has(own), data.has(old)], [false, true]);
    review.onRemember({ accounts: [], funds: [] });
    await run.flush();
    assert.deepEqual(Object.fromEntries(data), { [pan()]: "mf", [own]: to, [choices.bankKey(own)]: bank });
    assert.deepEqual(errors, []);
    // A later read finds them under the folio's key.
    review = await read();
    assert.equal(review.accountChoices[own], to);
    assert.deepEqual(review.formerNames, {});
    run.dispose();
  }
});

test("a folio's different choices under its fund house's names are ignored until chosen again, which forgets its former keys", async () => {
  const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
  const own = printedKey("Bandhan Mutual Fund", fixture.folios[0].folio);
  const stored = { [pan()]: "mf", [own]: "mf", [old]: "kids", [choices.bankKey(own)]: "old-bank", [choices.bankKey(old)]: choices.NO_BANK };
  // The same whichever name the statement prints.
  for (const amc of ["Bandhan Mutual Fund", "IDFC Mutual Fund"]) {
    const { run, data, read } = await page(stored, amc);
    let review = await read();
    assert.equal(own in review.accountChoices, false);
    assert.equal(choices.bankKey(own) in review.accountChoices, false);
    assert.deepEqual(review.unavailable, {
      [own]: { under: [{ name: "Bandhan Mutual Fund", choice: "Mutual funds" }, { name: "IDFC Mutual Fund", choice: "Kid's funds" }] },
      [choices.bankKey(own)]: { under: [{ name: "Bandhan Mutual Fund", choice: "Old savings (archived in Wealthfolio)" }, { name: "IDFC Mutual Fund", choice: "None" }] },
    });
    assert.deepEqual(review.formerNames, {});
    review.onRemember({ accounts: [[own, "kids"], [choices.bankKey(own), ""]], funds: [] });
    await run.flush();
    assert.deepEqual(Object.fromEntries(data), { [pan()]: "mf", [own]: "kids" });
    review = await read();
    assert.deepEqual([review.accountChoices[own], review.unavailable, review.formerNames], ["kids", {}, {}]);
    run.dispose();
  }
});

test("an unanswered difference under a fund house's names stays for the next read", async () => {
  const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
  const own = printedKey("Bandhan Mutual Fund", fixture.folios[0].folio);
  const stored = { [pan()]: "mf", [choices.bankKey(own)]: "bank", [choices.bankKey(old)]: choices.NO_BANK };
  const { run, data, read } = await page(stored, "Bandhan Mutual Fund");
  const review = await read();
  // As when its folio isn't imported.
  review.onRemember({ accounts: [], funds: [] });
  await run.flush();
  assert.deepEqual(Object.fromEntries(data), stored);
});

test("a later account-creation callback cannot replay a migrated choice over the user's answer", async () => {
  const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
  for (const [keyOf, answer] of [[(key) => key, "mf"], [(key) => key, ""], [choices.bankKey, ""]]) {
    const { run, data, read, folio } = await page({ [pan()]: "mf", [keyOf(old)]: "kids" }, "Bandhan Mutual Fund");
    const review = await read();
    const own = keyOf(choices.folioKey(folio));
    review.onRemember({ accounts: [[own, answer]], funds: [] });
    await run.flush();
    // An import that creates another account finishes through this same render's callback.
    review.onRemember({ accounts: [[pan(), "created-account"]], funds: [] });
    await run.flush();
    assert.deepEqual(Object.fromEntries(data), { ...(answer && { [own]: answer }), [pan()]: "created-account" });
    run.dispose();
  }
});

test("a failed choice read cannot turn a dispute into an automatic migration", async () => {
  const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
  const own = printedKey("Bandhan Mutual Fund", fixture.folios[0].folio);
  const stored = { [pan()]: "mf", [old]: "kids", [own]: "mf" };
  for (const failed of [own, old, choices.bankKey(own), choices.bankKey(old)]) {
    const { run, data, read, api } = await page(stored, "Bandhan Mutual Fund");
    const get = api.storage.get;
    api.storage.get = async (key) => {
      if (key === failed) throw new Error("made-up storage failure");
      return get(key);
    };
    await assert.rejects(read, /remembered account choices/i);
    assert.equal(find(run, "DetailedImport"), undefined);
    assert.deepEqual(Object.fromEntries(data), stored);
    run.dispose();
  }
});

test("a failed canonical write preserves the former choice, and a reread waits for writes", async () => {
  const old = printedKey("IDFC Mutual Fund", fixture.folios[0].folio);
  for (const keyOf of [(key) => key, choices.bankKey]) {
    const stored = { [pan()]: "mf", [keyOf(old)]: "kids" };
    const { run, data, errors, read, api } = await page(stored, "Bandhan Mutual Fund");
    const review = await read();
    let reject;
    api.storage.set = () => new Promise((_, no) => { reject = no; });
    review.onRemember({ accounts: [], funds: [] });
    await run.flush();
    let reread = false;
    const pending = read().then(() => { reread = true; });
    await run.flush();
    assert.equal(reread, false);
    reject(new Error("made-up write failure"));
    await pending;
    assert.deepEqual(Object.fromEntries(data), stored);
    assert.deepEqual(errors, ["Couldn't remember the account."]);
    run.dispose();
  }
});
