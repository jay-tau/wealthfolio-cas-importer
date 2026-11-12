// The Funds card's search on its own, with React's hooks stood in for: which search ends the automatic check, and which results it confirms.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "vite";

const [bundle] = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "fund-search-test",
    transform(source, id) {
      if (id.endsWith("/src/components/fund-choices.tsx")) return `${source}\nexport { FundSearch };`;
    },
  }],
  build: {
    write: false,
    lib: { entry: "src/components/fund-choices.tsx", formats: ["iife"], name: "funds" },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "@wealthfolio/ui"],
      output: { globals: { react: "hooks", "react/jsx-runtime": "jsx", "@wealthfolio/ui": "ui" } },
    },
  },
});
const scheme = { symbol: "100123", providerId: "AMFI", currency: "INR", longName: "Fictiva Fund - Direct Plan - Growth" };

function mount(statementSymbol) {
  const effects = [], requests = [], matches = [], events = [];
  const checking = { value: false };
  let input;
  const element = (type, props) => {
    if (type === "input") input = props;
    return { type, props };
  };
  const context = {
    hooks: {
      useState: (value) => [value, () => {}],
      useRef: (current) => ({ current }),
      useEffect: (setup) => effects.push(setup),
    },
    jsx: { jsx: element, jsxs: element },
    ui: { Input: "input" },
  };
  vm.runInNewContext(bundle.output[0].code, context);
  const tree = context.funds.FundSearch({
    ctx: { api: { market: { searchTicker: () => {
      events.push("search");
      return new Promise((resolve) => requests.push(resolve));
    } } } },
    item: { key: "fictiva", isin: "INFZ90K01FC8", name: scheme.longName, noun: "fund", statementSymbol },
    label: scheme.longName, auto: true, searchRef() {}, searchAgain: 0, onChoose() {},
    onMatch: (fund) => matches.push(fund), onLeaveOut() {}, onNoAmfi() {},
    onChecking: (value) => {
      checking.value = value;
      events.push(value);
    },
  });
  const setup = () => effects.map((effect) => effect());
  const enter = () => {
    tree.props.onFocus();
    input.onKeyDown({ key: "Enter" });
  };
  return { checking, requests, matches, events, setup, enter };
}

test("registers the automatic check before requesting, so fast re-searches wait for their siblings", () => {
  const search = mount();
  search.setup();
  assert.deepEqual(search.events, [true, "search"]);
});

test("effects run again, as React's StrictMode runs them, neither search twice nor drop the answer", async () => {
  const search = mount();
  const cleanups = search.setup();
  for (const cleanup of cleanups) cleanup?.();
  search.setup();
  assert.equal(search.requests.length, 1);
  assert.equal(search.checking.value, true);
  search.requests[0]([scheme]);
  await setImmediate();
  assert.equal(search.matches.length, 1);
  assert.equal(search.checking.value, false);
});

test("an unnamed AMFI listing never confirms, even when its plan and option don't contradict the statement", async () => {
  for (const longName of ["", scheme.symbol]) {
    const search = mount();
    search.setup();
    search.requests[0]([{ ...scheme, longName, shortName: "" }]);
    await setImmediate();
    assert.equal(search.matches.length, 0, `name ${JSON.stringify(longName)}`);
    assert.equal(search.checking.value, false);
  }
});

test("an exact saved AMFI asset still confirms when priced by hand", async () => {
  const search = mount();
  search.setup();
  search.requests[0]([{ ...scheme, existingAssetId: "fictiva-amfi", exactMatch: true, quoteMode: "MANUAL" }]);
  await setImmediate();
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].assetId, "fictiva-amfi");
  assert.equal(search.matches[0].manual, true);
  assert.equal(search.checking.value, false);
});

test("an answer after the search is gone confirms nothing", async () => {
  const search = mount();
  const cleanups = search.setup();
  for (const cleanup of cleanups) cleanup?.();
  const events = [...search.events];
  search.requests[0]([scheme]);
  await setImmediate();
  assert.equal(search.matches.length, 0);
  assert.deepEqual(search.events, events, "an unmounted search cannot clear a remounted search's check");
});

test("an older automatic answer cannot finish a pending typed search's check", async () => {
  const search = mount();
  search.setup();
  search.enter();
  search.requests[0]([scheme]);
  await setImmediate();
  assert.equal(search.checking.value, true);
  assert.equal(search.matches.length, 0);
  search.requests[1]([scheme]);
  await setImmediate();
  assert.equal(search.checking.value, false);
  assert.equal(search.matches.length, 0);
});

test("the current typed search finishes checking when it supersedes an automatic one", async () => {
  const search = mount();
  search.setup();
  search.enter();
  assert.equal(search.requests.length, 2);
  search.requests[1]([scheme]);
  await setImmediate();
  assert.equal(search.checking.value, false);
  assert.equal(search.matches.length, 0);
  search.requests[0]([scheme]);
  await setImmediate();
  assert.equal(search.checking.value, false);
  assert.equal(search.matches.length, 0);
});

for (const providerId of [undefined, "AMFI"]) {
  test(`a withheld statement-price asset with ${providerId ?? "no provider"} still prevents confirmation`, async () => {
    const search = mount("INFZ90K01FC8");
    search.setup();
    search.requests[0]([
      { symbol: "INFZ90K01FC8", existingAssetId: "statement-fund", quoteMode: "MANUAL", currency: "INR", providerId, exactMatch: true },
      scheme,
    ]);
    await setImmediate();
    assert.equal(search.matches.length, 0);
    assert.equal(search.checking.value, false);
  });
}
