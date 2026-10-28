import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { planSnapshots, readHoldings, snapshotOf } from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";
import { fundKey, holdingKey, readFund, readImported, saveFund, saveImported } from "../src/lib/choices.ts";

const summary = { id: "folio|90123456789/45|amc:Made-up Fund", aliases: ["folio|90123456789/45|INFTEST"] };
const depository = { id: summary.aliases[0] };
const noIsin = { id: summary.id };
const refs = (value) => ({ [value]: [`ISIN-${value}`, `CAMS|${value}`] });
const entries = (value) => new Map(Object.entries(value));

function storage() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
  };
}

test("manual pricing metadata is refreshed rather than stored with a fund choice", async () => {
  const store = storage();
  const choice = { symbol: "FUND", quoteCcy: "INR", name: "Made-up Fund" };
  await saveFund(store, "fund-choice", { ...choice, manual: true });
  assert.deepEqual(JSON.parse(store.data.get("fund-choice")), choice);
  store.data.set("fund-choice", JSON.stringify({ ...choice, manual: true }));
  assert.deepEqual(await readFund(store, "fund-choice"), choice);
});

test("a choice to use the statement's prices is remembered, under the bond's ISIN or the scheme's symbol", async () => {
  const store = storage();
  const choice = { symbol: "NPS-SBI-E-TIER-I", quoteCcy: "INR", instrumentType: "EQUITY", name: "NPS TRUST- A/C SBI", statementPrices: true };
  await saveFund(store, "nps-choice", { ...choice, manual: true });
  assert.deepEqual(await readFund(store, "nps-choice"), choice);
  const nps = { isin: null, rta: null, rtaCode: null, code: "NPS-SBI-E-TIER-I" };
  assert.match(holdingKey(nps), /^nps:[a-f0-9]{64}$/);
  assert.notEqual(holdingKey(nps), holdingKey({ ...nps, code: "NPS-SBI-E-TIER-II" }));
  // Not the key of a fund without an ISIN or registrar code.
  assert.notEqual(holdingKey(nps), fundKey({ isin: null, rta: undefined, rta_code: undefined }));
  assert.equal(holdingKey({ ...nps, isin: "INEZ91A07012" }), "isin:INEZ91A07012");
});

test("import provenance follows the baseline snapshot date, including out-of-order imports", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-06-30", refs("june"));
  assert.deepEqual(await readImported(store, summary, "account", null), new Map());
  assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), new Map());
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  assert.deepEqual(await readImported(store, summary, "account", "2026-04-30"), entries(refs("march")));
  assert.deepEqual(await readImported(store, summary, "account", "2026-06-30"), entries(refs("june")));
  await saveImported(store, summary, "account", "2026-03-31", refs("revised-march"));
  assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), entries(refs("revised-march")));
  assert.deepEqual(await readImported(store, summary, "account", "2026-07-31"), entries(refs("june")));
});

test("folio aliases stay linked after the ISIN disappears, in both directions", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  await saveImported(store, noIsin, "account", "2026-04-30", refs("april"));
  assert.deepEqual(await readImported(store, depository, "account", "2026-04-30"), entries(refs("april")));
  await saveImported(store, depository, "account", "2026-05-31", refs("may"));
  assert.deepEqual(await readImported(store, noIsin, "account", "2026-05-31"), entries(refs("may")));
  assert.deepEqual(await readImported(store, noIsin, "other-account", "2026-05-31"), new Map());
  for (const [key, value] of store.data) {
    assert.match(key, /^holdings-imported:[a-f0-9]{64}$/);
    assert.ok(!value.includes("90123456789/45"));
    assert.ok(!value.includes("Made-up Fund"));
    for (const alias of JSON.parse(value).aliases) assert.match(alias, /^holdings-imported:[a-f0-9]{64}$/);
  }
});

test("a mixed-issuer summary stops sharing earlier links without losing its own history", async () => {
  const store = storage();
  const data = JSON.parse(await readFile("tests/fixtures/made-up-summary-cams.json", "utf8"));
  const acquired = data.folios[2].schemes[0];
  data.folios = [{ ...data.folios[0], schemes: [data.folios[0].schemes[0]] }];
  const first = readHoldings(data).sources[0];
  const [a] = first.holdings;
  const refA = fundRef(a.isin, "XBOM");
  const onlyA = { [refA]: [a.isin] };
  await saveImported(store, first, "account", "2026-01-31", onlyA);

  data.folios[0].schemes.push(acquired);
  const mixed = readHoldings(data).sources[0];
  const b = mixed.holdings[1];
  const refB = fundRef(b.isin, "XBOM");
  const both = { ...onlyA, [refB]: [b.isin] };
  assert.deepEqual(mixed.aliases, []);
  await saveImported(store, mixed, "account", "2026-02-28", both);

  const depository = { id: first.aliases[0], kind: "folio", label: "Folio", holdings: [a] };
  const remembered = await readImported(store, depository, "account", "2026-02-28");
  assert.deepEqual(remembered, entries(onlyA));
  const [plan] = planSnapshots({
    date: "2026-03-31", investor: "made-up", sources: [depository], leftOut: [],
  }, {
    account: () => "account",
    asset: (h) => ({ symbol: h.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: h.name }),
    existing: () => ({
      date: "2026-02-28", cash: { INR: "123" }, later: [],
      positions: [a, b].map((h) => ({
        assetId: h.isin, symbol: h.isin, ref: fundRef(h.isin, "XBOM"), name: h.name,
        units: h.units, cost: h.cost, currency: "INR",
      })),
    }),
    remembered: () => remembered,
    heldElsewhere: () => [],
  });
  assert.equal(plan.positions.find((p) => p.ref === refB).include, true);
  const snapshot = snapshotOf(plan, { flipped: new Set(), costs: new Map() });
  assert.equal(snapshot.holdings.find((h) => h.assetId === b.isin).quantity, b.units);
  assert.deepEqual(snapshot.cash, { INR: "123" });

  // The issuer's stale copy must not overwrite the now-separate mixed summary on its next save.
  await saveImported(store, depository, "account", "2026-03-31", onlyA);
  assert.deepEqual(await readImported(store, mixed, "account", "2026-03-31"), entries(both));
  assert.deepEqual(await readImported(store, depository, "account", "2026-03-31"), entries(onlyA));
});

test("linking previously separate folio histories preserves both dates", async () => {
  const store = storage();
  await saveImported(store, noIsin, "account", "2026-01-31", refs("january"));
  await saveImported(store, depository, "account", "2026-02-28", refs("february"));
  assert.deepEqual(await readImported(store, summary, "account", "2026-02-28"), entries(refs("february")));
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  assert.deepEqual(await readImported(store, depository, "account", "2026-01-31"), entries(refs("january")));
});

test("partly written alias copies resolve to the most recently saved entry", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("original"));
  let writes = 0;
  const failing = {
    get: store.get,
    async set(key, value) {
      if (++writes === 2) throw new Error("storage failed");
      await store.set(key, value);
    },
  };
  await assert.rejects(saveImported(failing, summary, "account", "2026-03-31", refs("latest")), /storage failed/);
  assert.deepEqual(await readImported(store, depository, "account", "2026-03-31"), entries(refs("latest")));
  await saveImported(store, depository, "account", "2026-03-31", refs("next"));
  assert.deepEqual(await readImported(store, noIsin, "account", "2026-03-31"), entries(refs("next")));
});

test("equal-time conflicting alias entries discard whole disputed references", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", { ...refs("shared"), ...refs("first") });
  const [first, second] = [...store.data.keys()];
  const conflicting = JSON.parse(store.data.get(second));
  conflicting.dates["2026-03-31"].refs = { shared: ["ISIN-shared"], ...refs("second") };
  store.data.set(second, JSON.stringify(conflicting));
  assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), new Map());
  assert.equal(JSON.parse(store.data.get(first)).dates["2026-03-31"].savedAt, conflicting.dates["2026-03-31"].savedAt);
});

test("equal-time aliases agree when identity sets have a different order", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("shared"));
  const second = [...store.data.keys()][1];
  const reordered = JSON.parse(store.data.get(second));
  reordered.dates["2026-03-31"].refs.shared.reverse();
  store.data.set(second, JSON.stringify(reordered));
  assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), entries(refs("shared")));
});

test("conflicting identities cannot remove a still-listed fund left out of the import", async () => {
  const store = storage();
  const ref = fundRef("COMBINED", "XBOM");
  await saveImported(store, summary, "account", "2026-03-31", {
    [ref]: ["ISIN-A", "CAMS|A", "ISIN-B", "CAMS|B"],
  });
  const second = [...store.data.keys()][1];
  const conflicting = JSON.parse(store.data.get(second));
  conflicting.dates["2026-03-31"].refs[ref] = ["ISIN-A", "CAMS|A"];
  store.data.set(second, JSON.stringify(conflicting));
  const remembered = await readImported(store, summary, "account", "2026-03-31");
  const source = {
    ...summary, kind: "folio", label: "Made-up Fund folio",
    holdings: [{
      kind: "fund", isin: "ISIN-B", rta: "CAMS", rtaCode: "B", name: "Fund B",
      units: "10", price: "5", value: "50", cost: null,
    }],
  };
  const [plan] = planSnapshots({
    date: "2026-04-30", investor: "made-up", sources: [source], leftOut: [],
  }, {
    account: () => "account",
    asset: () => undefined,
    existing: () => ({
      date: "2026-03-31", cash: { INR: "123" }, later: [],
      positions: [{
        assetId: "combined", symbol: "COMBINED", ref, name: "Combined funds",
        units: "20", cost: "100", currency: "INR",
      }],
    }),
    remembered: () => remembered,
    heldElsewhere: () => [],
  });
  assert.equal(plan.positions[0].include, true);
  const snapshot = snapshotOf(plan, { flipped: new Set(), costs: new Map() });
  assert.equal(snapshot.holdings[0].assetId, "combined");
  assert.equal(snapshot.holdings[0].quantity, "20");
  assert.deepEqual(snapshot.cash, { INR: "123" });
});

test("a failed history read never overwrites stored imports", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-06-30", refs("june"));
  const before = [...store.data];
  const unavailable = [...store.data.keys()][1];
  const failing = {
    async get(key) {
      if (key === unavailable) throw new Error("storage unavailable");
      return store.get(key);
    },
    set: store.set,
  };
  assert.deepEqual(await readImported(failing, summary, "account", "2026-06-30"), new Map());
  await assert.rejects(saveImported(failing, summary, "account", "2026-03-31", refs("march")), /storage unavailable/);
  assert.deepEqual([...store.data], before);
});

test("invalid or obsolete provenance storage is ignored", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("valid"));
  for (const invalid of ["{", "null", "[]", JSON.stringify(refs("old-flat-format")), JSON.stringify({
    aliases: ["unhashed source", null, 12],
    dates: {
      "2026-03-31": { savedAt: 1, refs: { wrong: "not-an-array" } },
      "2026-02-31": { savedAt: 2, refs: refs("invalid-date") },
      "2026-04-30": { savedAt: -1, refs: refs("invalid-time") },
      "2026-05-31": { savedAt: 3, refs: { wrong: [null] } },
    },
  })]) {
    for (const key of store.data.keys()) store.data.set(key, invalid);
    assert.deepEqual(await readImported(store, summary, "account", "2026-12-31"), new Map());
  }
});
