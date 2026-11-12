import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { importedRefs, planSnapshots, readHoldings, reconcileRecord, security, snapshotOf, undecided, unlistedRefs } from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";
import {
  forgetFund, fundKey, holdingKey, indexSources, investorKey, readFund, readImported, readRecordChoices, readUnlisted, saveFund, saveImported, saveImports,
  saveUnlisted, securityKey,
} from "../src/lib/choices.ts";

const summary = { id: "folio|90123456789/45|amc:Made-up Fund", aliases: ["folio|90123456789/45|INFTEST"] };
const depository = { id: summary.aliases[0] };
const noIsin = { id: summary.id };
const refs = (value) => ({ [value]: [`ISIN-${value}`, `CAMS|${value}`] });
const entries = (value) => new Map(Object.entries(value));
/** The holdings a source's record has at the baseline date, by `fundRef`. */
const readRefs = async (...args) => (await readImported(...args)).remembered;

function storage() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

test("manual pricing metadata is refreshed rather than stored with a fund choice", async () => {
  const store = storage();
  const choice = { symbol: "FUND", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Made-up Fund" };
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

// A fund confirmed by a detailed import, others, and a holdings import's asset priced from statements.
const confirmed = { assetId: "asset-f", symbol: "0P0000FLEX", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fictiva Flexi Cap" };
const another = { ...confirmed, assetId: "asset-g", symbol: "0P0000FLX2" };
const handPriced = { symbol: "INFZ90K01FC8", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fictiva Flexi Cap Fund", statementPrices: true };
const stored = (store, key) => JSON.parse(store.data.get(key));

test("a holdings import's asset priced from statements keeps the fund a detailed import confirmed, for detailed imports", async () => {
  const store = storage();
  const key = "isin:INFZ90K01FC8";
  await saveFund(store, key, { ...confirmed, manual: false }, true);
  assert.deepEqual(stored(store, key), confirmed);
  await saveFund(store, key, { ...handPriced, manual: true });
  assert.deepEqual(stored(store, key), { ...handPriced, transactions: confirmed });
  assert.deepEqual(await readFund(store, key), handPriced);
  assert.deepEqual(await readFund(store, key, true), confirmed);
  assert.deepEqual(await readRecordChoices(store, [key], new Map()), [handPriced]);
  // Using the statement's prices again keeps it.
  await saveFund(store, key, handPriced);
  assert.deepEqual(stored(store, key), { ...handPriced, transactions: confirmed });
  // So does a fund the holdings import confirmed, which both kinds of import share until then.
  await saveFund(store, key, another);
  assert.deepEqual(stored(store, key), another);
  await saveFund(store, key, handPriced);
  assert.deepEqual(await readFund(store, key, true), another);
  // Without one, a detailed import searches for the fund again.
  await forgetFund(store, key);
  await saveFund(store, key, handPriced);
  assert.deepEqual(stored(store, key), handPriced);
  assert.equal(await readFund(store, key, true), undefined);
});

test("a detailed import's choices beside an asset priced from statements change only its own fund", async () => {
  const store = storage();
  const key = "isin:INFZ90K01FC8";
  await saveFund(store, key, handPriced);
  await saveFund(store, key, confirmed, true);
  assert.deepEqual(stored(store, key), { ...handPriced, transactions: confirmed });
  await saveFund(store, key, { ...another, manual: true }, true);
  assert.deepEqual(stored(store, key), { ...handPriced, transactions: another });
  // Leaving the fund out in a detailed import forgets only the fund kept for it.
  await forgetFund(store, key, true);
  assert.deepEqual(stored(store, key), handPriced);
  assert.deepEqual(await readFund(store, key), handPriced);
  assert.equal(await readFund(store, key, true), undefined);
  const writes = [];
  const watched = { ...store, set: async (...args) => { writes.push(args); }, delete: async (...args) => { writes.push(args); } };
  await forgetFund(watched, key, true);
  assert.deepEqual(writes, []);
  // A holdings import's choice, and leaving the holding out, are for both kinds of import.
  await saveFund(store, key, confirmed, true);
  await forgetFund(store, key);
  assert.equal(store.data.has(key), false);
  // A fund both share is forgotten for both too.
  await saveFund(store, key, confirmed, true);
  assert.deepEqual(stored(store, key), confirmed);
  await forgetFund(store, key, true);
  assert.equal(store.data.has(key), false);
});

test("a fund kept for detailed imports is read only beside an asset priced from statements, and a failed read writes nothing", async () => {
  const store = storage();
  for (const [value, holdings, detailed] of [
    [{ ...handPriced, transactions: "0P0000FLEX" }, handPriced, undefined],
    [{ ...handPriced, transactions: { ...confirmed, quoteCcy: undefined } }, handPriced, undefined],
    ...["name", "instrumentType"].flatMap((field) => [undefined, {}].map((value) =>
      [{ ...handPriced, transactions: { ...confirmed, [field]: value } }, handPriced, undefined])),
    [{ ...handPriced, transactions: { ...handPriced, symbol: "OTHER" } }, handPriced, undefined],
    [{ ...handPriced, transactions: { ...confirmed, manual: true } }, handPriced, confirmed],
    [{ ...confirmed, transactions: another }, confirmed, confirmed],
  ]) {
    store.data.set("choice", JSON.stringify(value));
    assert.deepEqual(await readFund(store, "choice"), holdings);
    assert.deepEqual(await readFund(store, "choice", true), detailed);
    // Saving the statement's prices removes ignored fields and keeps only a valid detailed fund.
    await saveFund(store, "choice", handPriced);
    assert.deepEqual(stored(store, "choice"), detailed ? { ...handPriced, transactions: detailed } : handPriced);
  }
  store.data.set("choice", JSON.stringify({ ...confirmed, transactions: another }));
  await saveFund(store, "choice", another, true);
  assert.deepEqual(stored(store, "choice"), another);

  const writes = [];
  const failed = {
    get: async () => { throw new Error("Storage unavailable"); },
    set: async (...args) => { writes.push(args); },
    delete: async (...args) => { writes.push(args); },
  };
  await assert.rejects(saveFund(failed, "choice", handPriced), /Storage unavailable/);
  await assert.rejects(saveFund(failed, "choice", confirmed, true), /Storage unavailable/);
  await assert.rejects(forgetFund(failed, "choice", true), /Storage unavailable/);
  assert.deepEqual(writes, []);
  // A holdings import's other choices don't need to read.
  await saveFund(failed, "choice", confirmed);
  await forgetFund(failed, "choice");
  assert.deepEqual(writes, [["choice", JSON.stringify(confirmed)], ["choice"]]);
});

test("each identifier an import records leads to the key its holding's choice is remembered under", () => {
  const fund = { kind: "fund", isin: "INFZ90K01FC8", rta: "CAMS", rtaCode: "FFCDG", name: "Fund", units: "1", price: "1", value: "1", cost: null };
  const withoutIsin = { ...fund, isin: null };
  const nps = { kind: "nps", isin: null, rta: null, rtaCode: null, code: "NPS-SBI-E-TIER-I", name: "NPS", units: "1", price: "1", value: "1", cost: null };
  assert.deepEqual(security(fund).map(securityKey), [holdingKey(fund), holdingKey(withoutIsin)]);
  assert.deepEqual(security(withoutIsin).map(securityKey), [holdingKey(withoutIsin)]);
  assert.equal(holdingKey(withoutIsin), fundKey({ isin: null, rta: "CAMS", rta_code: "FFCDG" }));
  assert.deepEqual(security(nps).map(securityKey), [holdingKey(nps)]);
});

test("record choices use the card's entries, including undecided or left out, and stop on a storage failure", async () => {
  const store = storage();
  const saved = { assetId: "old-asset", symbol: "OLD", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Made-up Fund" };
  const chosen = { ...saved, assetId: "new-asset", symbol: "NEW" };
  for (const key of ["confirmed", "undecided", "left-out", "absent"]) await saveFund(store, key, saved);
  store.data.set("malformed", "{");
  const current = new Map([["confirmed", chosen], ["undecided", undefined], ["left-out", undefined]]);
  const read = [];
  const recorded = { get: async (key) => { read.push(key); return store.get(key); } };
  assert.deepEqual(await readRecordChoices(recorded, [...current.keys(), "absent", "missing", "malformed"], current), [chosen, saved]);
  assert.deepEqual(read, ["absent", "missing", "malformed"]);
  const failed = { get: async () => { throw new Error("Storage unavailable"); } };
  assert.deepEqual(await readRecordChoices(failed, current.keys(), current), [chosen]);
  await assert.rejects(readRecordChoices(failed, ["absent"], current), /Storage unavailable/);
  // Loading the Holdings card still treats an unreadable saved choice as unconfirmed.
  assert.equal(await readFund(failed, "absent"), undefined);
});

test("import provenance follows the baseline snapshot date, including out-of-order imports", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-06-30", refs("june"));
  assert.deepEqual(await readRefs(store, summary, "account", null), new Map());
  assert.deepEqual(await readRefs(store, summary, "account", "2026-03-31"), new Map());
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-04-30"), entries(refs("march")));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-06-30"), entries(refs("june")));
  await saveImported(store, summary, "account", "2026-03-31", refs("revised-march"));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-03-31"), entries(refs("revised-march")));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-07-31"), entries(refs("june")));
});

test("folio aliases stay linked after the ISIN disappears, in both directions", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  await saveImported(store, noIsin, "account", "2026-04-30", refs("april"));
  assert.deepEqual(await readRefs(store, depository, "account", "2026-04-30"), entries(refs("april")));
  await saveImported(store, depository, "account", "2026-05-31", refs("may"));
  assert.deepEqual(await readRefs(store, noIsin, "account", "2026-05-31"), entries(refs("may")));
  assert.deepEqual(await readRefs(store, noIsin, "other-account", "2026-05-31"), new Map());
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
  const remembered = await readRefs(store, depository, "account", "2026-02-28");
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
  assert.deepEqual(await readRefs(store, mixed, "account", "2026-03-31"), entries(both));
  assert.deepEqual(await readRefs(store, depository, "account", "2026-03-31"), entries(onlyA));
});

test("linking previously separate folio histories preserves both dates", async () => {
  const store = storage();
  await saveImported(store, noIsin, "account", "2026-01-31", refs("january"));
  await saveImported(store, depository, "account", "2026-02-28", refs("february"));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-02-28"), entries(refs("february")));
  await saveImported(store, summary, "account", "2026-03-31", refs("march"));
  assert.deepEqual(await readRefs(store, depository, "account", "2026-01-31"), entries(refs("january")));
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
  assert.deepEqual(await readRefs(store, depository, "account", "2026-03-31"), entries(refs("latest")));
  await saveImported(store, depository, "account", "2026-03-31", refs("next"));
  assert.deepEqual(await readRefs(store, noIsin, "account", "2026-03-31"), entries(refs("next")));
});

test("equal-time conflicting alias entries discard whole disputed references", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", { ...refs("shared"), ...refs("first") });
  const [first, second] = [...store.data.keys()];
  const conflicting = JSON.parse(store.data.get(second));
  conflicting.dates["2026-03-31"].refs = { shared: ["ISIN-shared"], ...refs("second") };
  store.data.set(second, JSON.stringify(conflicting));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-03-31"), new Map());
  assert.equal(JSON.parse(store.data.get(first)).dates["2026-03-31"].savedAt, conflicting.dates["2026-03-31"].savedAt);
});

test("equal-time aliases agree when identity sets have a different order", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", refs("shared"));
  const second = [...store.data.keys()][1];
  const reordered = JSON.parse(store.data.get(second));
  reordered.dates["2026-03-31"].refs.shared.reverse();
  store.data.set(second, JSON.stringify(reordered));
  assert.deepEqual(await readRefs(store, summary, "account", "2026-03-31"), entries(refs("shared")));
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
  const remembered = await readRefs(store, summary, "account", "2026-03-31");
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
  assert.deepEqual(await readRefs(failing, summary, "account", "2026-06-30"), new Map());
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
    assert.deepEqual(await readRefs(store, summary, "account", "2026-12-31"), new Map());
  }
});

/** Whether versions before asset IDs read a stored entry: they check its time and that each ref lists strings. */
const olderReads = (entry) => Number.isSafeInteger(entry.savedAt) && entry.savedAt >= 0 &&
  Object.values(entry.refs).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"));
/**
 * What a version before asset IDs does on saving a record at `date`, in a store of one history: it keeps
 * each other date's latest copy as stored, but builds equal-time copies, such as linked folios', anew with
 * refs only, and saves refs only.
 */
function olderSave(store, date, saved) {
  const dates = {};
  for (const value of store.data.values()) {
    for (const [day, entry] of Object.entries(JSON.parse(value).dates)) {
      const previous = dates[day];
      if (!previous || entry.savedAt > previous.savedAt) dates[day] = entry;
      else if (entry.savedAt === previous.savedAt) dates[day] = { savedAt: entry.savedAt, refs: previous.refs };
    }
  }
  dates[date] = { savedAt: Math.max(Date.now(), ...Object.values(dates).map((entry) => entry.savedAt + 1)), refs: saved };
  for (const [key, value] of store.data) store.data.set(key, JSON.stringify({ ...JSON.parse(value), dates }));
}

test("asset IDs are saved beside each date's refs, where older versions still read the refs", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", { ...refs("a"), ...refs("b") }, { a: "asset-a" });
  for (const value of store.data.values()) {
    const entry = JSON.parse(value).dates["2026-03-31"];
    assert.deepEqual([entry.refs, entry.ids, olderReads(entry)], [{ ...refs("a"), ...refs("b") }, { a: "asset-a" }, true]);
  }
  assert.deepEqual(await readImported(store, depository, "account", "2026-03-31"), { remembered: entries({ ...refs("a"), ...refs("b") }), ids: new Map([["a", "asset-a"]]) });
  // A record without IDs is stored as before.
  await saveImported(store, summary, "account", "2026-04-30", refs("c"));
  assert.ok(!("ids" in JSON.parse([...store.data.values()][0]).dates["2026-04-30"]));
  // An older version's save at the same date goes without them, and at another date drops linked copies' too:
  // those records go by remembered choices.
  olderSave(store, "2026-03-31", refs("a"));
  assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), { remembered: entries(refs("a")), ids: new Map() });
  await saveImported(store, summary, "account", "2026-03-31", refs("a"), { a: "asset-a" });
  olderSave(store, "2026-05-31", refs("d"));
  assert.deepEqual((await readImported(store, summary, "account", "2026-03-31")).ids, new Map());
  // A single copy's stay.
  const single = storage();
  await saveImported(single, noIsin, "account", "2026-03-31", refs("a"), { a: "asset-a" });
  olderSave(single, "2026-05-31", refs("d"));
  assert.deepEqual(await readImported(single, noIsin, "account", "2026-03-31"), { remembered: entries(refs("a")), ids: new Map([["a", "asset-a"]]) });
  // A backdated save keeps later dates' IDs.
  await saveImported(store, summary, "account", "2026-06-30", refs("e"), { e: "asset-e" });
  await saveImported(store, summary, "account", "2026-02-28", refs("f"), { f: "asset-f" });
  assert.deepEqual((await readImported(store, summary, "account", "2026-06-30")).ids, new Map([["e", "asset-e"]]));
  assert.deepEqual((await readImported(store, summary, "account", "2026-02-28")).ids, new Map([["f", "asset-f"]]));
});

test("malformed asset IDs are ignored without losing their refs", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", { ...refs("a"), ...refs("b") }, { a: "asset-a", b: "asset-b" });
  for (const [ids, kept] of [
    ["asset-a", []], [["asset-a"], []], [null, []], [{ a: 5, b: "asset-b" }, [["b", "asset-b"]]],
    [{ a: "", b: ["asset-b"] }, []], [{ a: "asset-a", missing: "asset-m", toString: "asset-t" }, [["a", "asset-a"]]],
  ]) {
    for (const key of store.data.keys()) {
      const stored = JSON.parse(store.data.get(key));
      stored.dates["2026-03-31"].ids = ids;
      store.data.set(key, JSON.stringify(stored));
    }
    assert.deepEqual(await readImported(store, summary, "account", "2026-03-31"), { remembered: entries({ ...refs("a"), ...refs("b") }), ids: new Map(kept) });
  }
});

test("equal-time copies keep the asset IDs they agree on, drop one only a copy has, and discard a ref they give different IDs", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2026-03-31", { ...refs("a"), ...refs("b"), ...refs("c") }, { a: "asset-a", b: "asset-b", c: "asset-c" });
  const second = [...store.data.keys()][1];
  const copy = JSON.parse(store.data.get(second));
  copy.dates["2026-03-31"].ids = { a: "asset-a", c: "other-asset" };
  store.data.set(second, JSON.stringify(copy));
  const read = await readImported(store, summary, "account", "2026-03-31");
  assert.deepEqual(read, { remembered: entries({ ...refs("a"), ...refs("b") }), ids: new Map([["a", "asset-a"]]) });
  // An older version's copy at the same time has none.
  delete copy.dates["2026-03-31"].ids;
  store.data.set(second, JSON.stringify(copy));
  assert.deepEqual((await readImported(store, summary, "account", "2026-03-31")).ids, new Map());
});

test("equal-time ID conflicts survive an ID-free copy in every read order", async () => {
  const source = { ...summary, aliases: [...summary.aliases, "folio|90123456789/45|amc:Earlier name"] };
  for (const ids of [
    ["asset-a", undefined, "other-asset"], ["asset-a", "other-asset", undefined],
    [undefined, "asset-a", "other-asset"], [undefined, "other-asset", "asset-a"],
    ["other-asset", "asset-a", undefined], ["other-asset", undefined, "asset-a"],
  ]) {
    const store = storage();
    await saveImported(store, source, "account", "2026-03-31", refs("a"));
    for (const [i, key] of [...store.data.keys()].entries()) {
      const copy = JSON.parse(store.data.get(key));
      copy.dates["2026-03-31"].ids = ids[i] ? { a: ids[i] } : undefined;
      store.data.set(key, JSON.stringify(copy));
    }
    assert.deepEqual(await readImported(store, source, "account", "2026-03-31"), { remembered: new Map(), ids: new Map() });
    // A newer copy replaces the disputed record, including the IDs observed at the earlier time.
    const key = [...store.data.keys()].at(-1);
    const newer = JSON.parse(store.data.get(key));
    newer.dates["2026-03-31"].savedAt++;
    newer.dates["2026-03-31"].ids = { a: "newest-asset" };
    store.data.set(key, JSON.stringify(newer));
    assert.deepEqual(await readImported(store, source, "account", "2026-03-31"), {
      remembered: entries(refs("a")), ids: new Map([["a", "newest-asset"]]),
    });
  }
});

test("linked folios saved together keep each other's asset IDs, except for a ref they give different ones", async () => {
  const store = storage();
  const first = { ...summary, kind: "folio", label: "Made-up Fund, folio 90123456789/45", holdings: [] };
  const second = { id: "folio|90123456789/45|amc:Made-up Fund (earlier name)", aliases: summary.aliases, kind: "folio", label: "Earlier name", holdings: [] };
  const separate = { id: "demat|1|1", kind: "demat", label: "Demat account 1", holdings: [] };
  await saveImports(store, "account", "2026-03-31", [
    { source: first, refs: { ...refs("a"), ...refs("b") }, ids: { a: "asset-a", b: "asset-b" } },
    { source: second, refs: { ...refs("b"), ...refs("c") }, ids: { b: "other-asset" } },
    { source: separate, refs: refs("c"), ids: { c: "asset-c" } },
  ]);
  for (const source of [first, second, depository]) {
    assert.deepEqual(await readImported(store, source, "account", "2026-03-31"), {
      remembered: entries({ ...refs("a"), ...refs("b"), ...refs("c") }), ids: new Map([["a", "asset-a"]]),
    });
  }
  assert.deepEqual(await readImported(store, separate, "account", "2026-03-31"), { remembered: entries(refs("c")), ids: new Map([["c", "asset-c"]]) });
  // Unlisted, the linked records are read and saved again with their IDs.
  await indexSources(store, "account", "investor", [first, separate]);
  const [unlisted, other] = await readUnlisted(store, "account", "investor", [], "2026-03-31");
  assert.deepEqual([unlisted.ids, other.ids], [new Map([["a", "asset-a"]]), new Map([["c", "asset-c"]])]);
  await saveUnlisted(store, "2026-04-30", [{ keys: unlisted.keys, refs: refs("a"), ids: { a: "asset-a" } }]);
  assert.deepEqual(await readImported(store, second, "account", "2026-04-30"), { remembered: entries(refs("a")), ids: new Map([["a", "asset-a"]]) });
});

test("an imported entry replaces set-aside history in its own or a learned linked record, but not a separate one", async () => {
  const X = "INEZ90X01017", Y = "INEZ90Y01015";
  const old = fundRef("OLD", "XBOM");
  const existing = {
    date: "2026-03-31", later: [], cash: {},
    positions: [["current-asset", "OLD"], ["held-back-asset", "OTHER"]].map(([assetId, symbol]) => ({
      assetId, symbol, ref: fundRef(symbol, "XBOM"), name: symbol, units: "10", cost: "100", currency: "INR",
    })),
  };
  for (const kind of ["own", "linked", "separate"]) {
    const store = storage();
    const first = { id: "made-up-first", kind: "demat", label: "First demat", holdings: [], misread: [shareOf(X, "10")] };
    const second = { id: "made-up-second", kind: "demat", label: "Second demat", holdings: [shareOf(Y, "10")] };
    // The later statement doesn't carry the earlier link; storage still knows it.
    await saveImported(store, { ...first, ...(kind === "linked" && { aliases: [second.id] }) }, "account", existing.date,
      { [old]: [X] }, { [old]: "absent-asset" });
    if (kind === "own") first.holdings = second.holdings;
    const sources = kind === "own" ? [first] : [first, second];
    const records = new Map(await Promise.all(sources.map(async (s) =>
      [s.id, reconcileRecord(await readImported(store, s, "account", existing.date), existing, [])])));
    const [plan] = planSnapshots({ date: "2026-04-30", investor: "made-up", sources, leftOut: [] }, {
      account: () => "account", existing: () => existing, heldElsewhere: () => [],
      asset: (h) => ({ symbol: h.isin === Y ? "OLD" : "OTHER", exchangeMic: "XBOM", quoteCcy: "INR", name: h.name,
        assetId: h.isin === Y ? "current-asset" : "held-back-asset" }),
      remembered: (s) => records.get(s.id).remembered, recorded: (s) => records.get(s.id),
    });
    assert.deepEqual(plan.positions.map((p) => [p.ref, !!p.misread]), [[old, false], [fundRef("OTHER", "XBOM"), true]]);
    await saveImports(store, "account", plan.date, importedRefs(plan, { flipped: new Set(), costs: new Map() }));
    const expected = { remembered: entries({ [old]: [Y] }), ids: new Map([[old, "current-asset"]]) };
    assert.deepEqual(await readImported(store, kind === "own" ? first : second, "account", plan.date), expected);
    assert.deepEqual(await readImported(store, first, "account", plan.date), kind === "separate"
      ? { remembered: entries({ [old]: [X] }), ids: new Map([[old, "absent-asset"]]) } : expected);
    for (const value of store.data.values()) assert.ok(!value.includes('"aside"'));
  }
});

// Demat accounts 1 and 2 go to one account, which held 150 S and 10 T. Demat account 2 has sold its S.
const refOf = (isin) => fundRef(isin, "XBOM");
const held = (...isins) => Object.fromEntries(isins.map((isin) => [refOf(isin), [isin]]));
const shareOf = (isin, units) => ({ kind: "share", isin, rta: null, rtaCode: null, name: `Share ${isin}`, units, price: "10", value: "0", cost: null });
const sharesBefore = (date) => ({
  date, cash: {}, later: [],
  positions: [["S", "150"], ["T", "10"]].map(([isin, units]) => ({
    assetId: `asset-${isin}`, symbol: isin, ref: refOf(isin), name: `Share ${isin}`, units, cost: null, currency: "INR",
  })),
});

/** Plans the import of `sources`, any `leftOut` left out, as the page reads their records, and imports S. */
async function importS(store, date, baseline, sources, leftOut) {
  const remembered = new Map(await Promise.all(sources.map(async (s) => [s.id, await readRefs(store, s, "account", baseline)])));
  const [plan] = planSnapshots({ date, investor: "x", leftOut: [], sources }, {
    account: (s) => (s === leftOut ? undefined : "account"),
    asset: (h) => ({ symbol: h.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: h.name }),
    existing: () => sharesBefore(baseline),
    remembered: (s) => remembered.get(s.id),
    heldElsewhere: () => [],
  });
  const row = plan.positions.find((p) => p.ref === refOf("S"));
  // Left out by default only for a left-out source's record.
  assert.equal(row.include, !leftOut);
  await saveImports(store, "account", date, importedRefs(plan, { flipped: new Set(leftOut ? [row.key] : []), costs: new Map() }));
}

test("a left-out source's cleared record is saved at the statement's date from the baseline's, leaving its other dates", async () => {
  const store = storage();
  const first = { id: "demat|1|1", kind: "demat", label: "Demat account 1", holdings: [shareOf("S", "100")] };
  const second = { id: "demat|2|2", kind: "demat", label: "Demat account 2", holdings: [shareOf("T", "10")] };
  await saveImported(store, first, "account", "2025-03-31", held("S"));
  await saveImported(store, second, "account", "2025-03-31", held("S", "T"));
  await saveImported(store, first, "account", "2025-06-30", held("S", "U"));
  await saveImported(store, second, "account", "2025-06-30", held("S", "U"));
  // Imported after June's, April's statement starts from March's snapshot: T stays, and June's U isn't copied.
  await importS(store, "2025-04-30", "2025-03-31", [first, second], second);
  assert.deepEqual(await readRefs(store, second, "account", "2025-04-30"), entries(held("T")));
  assert.deepEqual(await readRefs(store, first, "account", "2025-04-30"), entries(held("S")));
  // A later baseline reads it; the records at other dates stay.
  assert.deepEqual(await readRefs(store, second, "account", "2025-05-31"), entries(held("T")));
  for (const source of [first, second]) {
    assert.deepEqual(await readRefs(store, source, "account", "2025-03-31"), entries(source === first ? held("S") : held("S", "T")));
    assert.deepEqual(await readRefs(store, source, "account", "2025-06-30"), entries(held("S", "U")));
  }
});

test("a left-out folio's cleared record keeps what a linked included folio just imported", async () => {
  const store = storage();
  const included = { ...summary, kind: "folio", label: "Made-up Fund, folio 90123456789/45", holdings: [shareOf("S", "100")] };
  // The same folio under the AMC's earlier name, linked through the issuer's folio.
  const renamed = {
    id: "folio|90123456789/45|amc:Made-up Fund (earlier name)", aliases: summary.aliases,
    kind: "folio", label: "Made-up Fund (earlier name), folio 90123456789/45", holdings: [shareOf("T", "10")],
  };
  const separate = { id: "demat|1|1", kind: "demat", label: "Demat account 1", holdings: [] };
  await saveImported(store, included, "account", "2025-03-31", held("S", "T"));
  await saveImported(store, separate, "account", "2025-03-31", held("T"));
  await importS(store, "2025-04-30", "2025-03-31", [included, renamed, separate], renamed);
  for (const source of [included, renamed, depository]) {
    assert.deepEqual(await readRefs(store, source, "account", "2025-04-30"), entries(held("S", "T")));
  }
  // An unlinked source keeps its own record, without the linked folios' S, and links stay as they were.
  assert.deepEqual(await readRefs(store, separate, "account", "2025-04-30"), entries(held("T")));
  assert.equal(store.data.size, 4);
});

test("linked folios imported together keep each other's refs", async () => {
  const store = storage();
  const first = { ...summary, kind: "folio", label: "Made-up Fund, folio 90123456789/45", holdings: [shareOf("S", "100")] };
  const second = {
    id: "folio|90123456789/45|amc:Made-up Fund (earlier name)", aliases: summary.aliases,
    kind: "folio", label: "Made-up Fund (earlier name), folio 90123456789/45", holdings: [shareOf("T", "10")],
  };
  await saveImported(store, first, "account", "2025-03-31", held("S", "T"));
  await importS(store, "2025-04-30", "2025-03-31", [first, second]);
  for (const source of [first, second, depository]) {
    assert.deepEqual(await readRefs(store, source, "account", "2025-04-30"), entries(held("S", "T")));
  }
});

test("mixed-issuer folios stay separate from their earlier links when saved together, in either order", async () => {
  const mixed = { ...summary, aliases: [] };
  const other = { id: "folio|90123456789/45|amc:Made-up Fund (earlier name)", aliases: summary.aliases };
  for (const reverse of [false, true]) {
    const store = storage();
    await saveImported(store, summary, "account", "2025-03-31", held("S"));
    await saveImported(store, other, "account", "2025-06-30", held("U"));
    const records = [{ source: mixed, refs: held("S", "T") }, { source: other, refs: held("S") }];
    await saveImports(store, "account", "2025-04-30", reverse ? records.reverse() : records);
    assert.deepEqual(await readRefs(store, mixed, "account", "2025-04-30"), entries(held("S", "T")));
    for (const source of [other, depository]) {
      assert.deepEqual(await readRefs(store, source, "account", "2025-04-30"), entries(held("S")));
    }
    for (const source of [mixed, other, depository]) {
      assert.deepEqual(await readRefs(store, source, "account", "2025-03-31"), entries(held("S")));
      assert.deepEqual(await readRefs(store, source, "account", "2025-06-30"), entries(held("U")));
    }
  }
});

// An investor's folios 1 and 2 went to one account in March; April's statement lists only folio 1.
const folio = (n, ...holdings) => ({ id: `folio|${n}|amc:Made-up Fund`, kind: "folio", label: `Made-up Fund, folio ${n}`, holdings });
const unlistedNote = "An earlier import added it from a folio, demat account or PRAN that this statement doesn't list. " +
  "Check whether it was redeemed, sold or moved, and untick Keep if so.";
/** What the page does: reads the records, plans the import into "account" and saves it, keeping every default. */
async function importHoldings(store, investor, date, baseline, sources, choose = () => ({ flipped: new Set(), costs: new Map() })) {
  const remembered = new Map(await Promise.all(sources.map(async (s) => [s.id, await readRefs(store, s, "account", baseline)])));
  const unlisted = await readUnlisted(store, "account", investor, sources, baseline);
  const [plan] = planSnapshots({ date, investor, leftOut: [], sources }, {
    account: () => "account",
    asset: (h) => ({ symbol: h.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: h.name }),
    existing: () => (baseline ? sharesBefore(baseline) : { date: null, positions: [], cash: {}, later: [] }),
    remembered: (s) => remembered.get(s.id),
    heldElsewhere: () => [],
    unlisted: () => unlisted,
  });
  const choices = choose(plan);
  await saveImports(store, "account", date, importedRefs(plan, choices));
  await saveUnlisted(store, date, unlistedRefs(plan, choices));
  await indexSources(store, "account", investor, plan.sources);
  return plan;
}
const notesOf = (plan, isin) => plan.positions.find((p) => p.ref === refOf(isin)).notes;

test("a folio missing from later statements keeps its note on each import, until it's listed again", async () => {
  const store = storage();
  await importHoldings(store, "investor", "2025-03-31", null, [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))]);
  const april = await importHoldings(store, "investor", "2025-04-30", "2025-03-31", [folio(1, shareOf("S", "150"))]);
  assert.deepEqual(notesOf(april, "S"), []);
  assert.deepEqual(notesOf(april, "T"), [unlistedNote]);
  // Kept, so May's import says the same.
  const may = await importHoldings(store, "investor", "2025-05-31", "2025-04-30", [folio(1, shareOf("S", "150"))]);
  assert.deepEqual(notesOf(may, "T"), [unlistedNote]);
  // Listed again, folio 2's record is its own: with T gone from it, T is removed by default.
  const june = await importHoldings(store, "investor", "2025-06-30", "2025-05-31", [folio(1, shareOf("S", "150")), folio(2)]);
  assert.deepEqual(june.unlisted, []);
  assert.deepEqual(notesOf(june, "T"), ["Not on the statement any more. An earlier import of Made-up Fund, folio 2 added it."]);
});

test("unlisted records are only those the same investor's imports indexed for the account", async () => {
  const store = storage();
  const first = folio(1, shareOf("S", "150"));
  // A record saved before the index, and one indexed for another investor or account, give no note.
  await saveImported(store, folio(3), "account", "2025-03-31", held("T"));
  await importHoldings(store, "investor", "2025-03-31", null, [first, folio(2, shareOf("T", "10"))]);
  await indexSources(store, "other-account", "investor", [folio(4)]);
  const other = await importHoldings(store, "someone else", "2025-04-30", "2025-03-31", [first]);
  assert.deepEqual([other.unlisted, notesOf(other, "T")], [[], []]);
  assert.deepEqual((await readUnlisted(store, "account", "investor", [first], "2025-04-30")).map((u) => [...u.remembered.keys()]), [[refOf("T")]]);
  // A statement that names no investor neither indexes nor finds any.
  await indexSources(store, "account", "", [folio(5)]);
  assert.deepEqual(await readUnlisted(store, "account", "", [], "2025-04-30"), []);
  assert.equal([...store.data.values()].filter((value) => value.includes(JSON.stringify(investorKey("")))).length, 0);
  // Nothing at or before the baseline, or no baseline, is nothing to note.
  assert.deepEqual(await readUnlisted(store, "account", "investor", [first], "2025-02-28"), []);
  assert.deepEqual(await readUnlisted(store, "account", "investor", [first], null), []);
  // Nor is a folio linked to a listed one through the issuer's folio number.
  const linked = { ...summary, kind: "folio", label: "Made-up Fund, folio 90123456789/45", holdings: [] };
  const renamed = { id: "folio|90123456789/45|amc:Made-up Fund (earlier name)", aliases: summary.aliases };
  await saveImported(store, renamed, "account", "2025-03-31", held("U"));
  await indexSources(store, "account", "investor", [renamed]);
  assert.deepEqual((await readUnlisted(store, "account", "investor", [first], "2025-04-30")).length, 2);
  assert.deepEqual((await readUnlisted(store, "account", "investor", [first, linked], "2025-04-30")).map((u) => [...u.remembered.keys()]), [[refOf("T")]]);
});

test("the index keeps the sources a later import doesn't list, and other investors', all hashed", async () => {
  const store = storage();
  const [one, two, three] = [folio(1), folio(2), folio(3)];
  for (const [source, isin] of [[one, "S"], [two, "T"], [three, "U"]]) await saveImported(store, source, "account", "2025-03-31", held(isin));
  await indexSources(store, "account", "ananya@example.com", [one, two]);
  await indexSources(store, "account", "ABCDE1234F", [three]);
  await indexSources(store, "account", "ananya@example.com", [one]);
  const unlisted = async (investor, listed) => (await readUnlisted(store, "account", investor, listed, "2025-03-31")).map((u) => [...u.remembered.keys()]);
  assert.deepEqual(await unlisted("ananya@example.com", [one]), [[refOf("T")]]);
  assert.deepEqual(await unlisted("ananya@example.com", []), [[refOf("S")], [refOf("T")]]);
  assert.deepEqual(await unlisted("ABCDE1234F", []), [[refOf("U")]]);
  const stored = JSON.stringify([...store.data]);
  for (const plain of ["ananya", "ABCDE1234F", "folio|", "Made-up Fund"]) assert.ok(!stored.includes(plain), plain);
  const [index] = [...store.data].filter(([key]) => key.startsWith("holdings-sources:"));
  assert.match(index[0], /^holdings-sources:[a-f0-9]{64}$/);
  for (const [investor, keys] of Object.entries(JSON.parse(index[1]))) {
    assert.match(investor, /^holdings-investor:[a-f0-9]{64}$/);
    for (const key of keys) assert.match(key, /^holdings-imported:[a-f0-9]{64}$/);
  }
  // Nothing new isn't written again; a failed read never overwrites the index, and invalid entries are dropped.
  const before = index[1];
  const failing = { get: async (key) => { if (key === index[0]) throw new Error("storage unavailable"); return store.get(key); }, set: store.set };
  await assert.rejects(indexSources(failing, "account", "ananya@example.com", [three]), /storage unavailable/);
  assert.equal(store.data.get(index[0]), before);
  // A failed read stops the preview rather than dropping the records.
  await assert.rejects(readUnlisted(failing, "account", "ananya@example.com", [], "2025-03-31"), /storage unavailable/);
  const [ananya, pan] = Object.keys(JSON.parse(before));
  store.data.set(index[0], JSON.stringify({ [ananya]: JSON.parse(before)[ananya], [pan]: ["folio|3|amc:Made-up Fund", 3], "holdings-investor:x": [] }));
  assert.deepEqual(await unlisted("ABCDE1234F", []), []);
  assert.deepEqual(await unlisted("ananya@example.com", []), [[refOf("S")], [refOf("T")]]);
  store.data.set(index[0], "{");
  assert.deepEqual(await unlisted("ananya@example.com", []), []);
  await indexSources(store, "account", "ananya@example.com", [one]);
  assert.deepEqual(await unlisted("ananya@example.com", []), [[refOf("S")]]);
});

test("partial alias writes exclude listed groups and count linked unlisted records once, in either index order", async () => {
  const renamed = { ...summary, id: "folio|90123456789/45|amc:Made-up Fund (earlier name)" };
  for (const reverse of [false, true]) {
    const store = storage();
    await saveImported(store, { id: renamed.id }, "account", "2025-01-31", held("T"));
    await saveImported(store, summary, "account", "2025-02-28", held("S"));
    await indexSources(store, "account", "investor", reverse ? [renamed, summary] : [summary, renamed]);
    let writes = 0;
    const failing = { get: store.get, set: async (key, value) => {
      if (++writes === 2) throw new Error("storage failed");
      await store.set(key, value);
    } };
    await assert.rejects(saveImported(failing, renamed, "account", "2025-03-31", held("S", "T")), /storage failed/);
    for (const listed of [summary, depository, noIsin]) {
      assert.deepEqual(await readUnlisted(store, "account", "investor", [listed], "2025-03-31"), []);
    }
    const unlisted = await readUnlisted(store, "account", "investor", [], "2025-03-31");
    assert.equal(unlisted.length, 1);
    assert.deepEqual(unlisted[0].remembered, entries(held("S", "T")));
    await saveUnlisted(store, "2025-04-30", [{ keys: unlisted[0].keys, refs: held("T") }]);
    for (const source of [summary, renamed, depository]) {
      assert.deepEqual(await readRefs(store, source, "account", "2025-04-30"), entries(held("T")));
      assert.deepEqual(await readRefs(store, source, "account", "2025-02-28"), entries(held("S")));
    }
    assert.deepEqual((await readUnlisted(store, "account", "investor", [], "2025-04-30")).map((u) => u.remembered), [entries(held("T"))]);
  }
});

test("unlisted histories respect severed links, and a failed read throws without overwriting them", async () => {
  const store = storage();
  await saveImported(store, summary, "account", "2025-03-31", held("S"));
  const mixed = { ...summary, aliases: [] };
  await saveImported(store, mixed, "account", "2025-04-30", held("T"));
  await indexSources(store, "account", "investor", [summary, depository]);
  for (const [listed, expected] of [[mixed, held("S")], [depository, held("T")]]) {
    const unlisted = await readUnlisted(store, "account", "investor", [listed], "2025-04-30");
    assert.deepEqual(unlisted.map((u) => u.remembered), [entries(expected)]);
  }
  const unlisted = await readUnlisted(store, "account", "investor", [mixed], "2025-04-30");
  const before = [...store.data];
  const failing = { get: async (key) => {
    if (key === unlisted[0].keys[0]) throw new Error("storage unavailable");
    return store.get(key);
  }, set: store.set };
  await assert.rejects(readUnlisted(failing, "account", "investor", [mixed], "2025-04-30"), /storage unavailable/);
  await assert.rejects(saveUnlisted(failing, "2025-05-31", [{ keys: unlisted[0].keys, refs: {} }]), /storage unavailable/);
  assert.deepEqual([...store.data], before);
});

test("conflicting device indexes fall back to the existing snapshot rules", async () => {
  for (const otherInvestor of ["investor", "someone else"]) {
    const store = storage();
    const [one, two] = [folio(1), folio(2)];
    await saveImported(store, one, "account", "2025-03-31", held("S"));
    await saveImported(store, two, "account", "2025-03-31", held("T"));
    // Both devices read the old index before either writes; the last write wins.
    await Promise.all([
      indexSources(store, "account", "investor", [one]),
      indexSources(store, "account", otherInvestor, [two]),
    ]);
    const plan = await importHoldings(store, "investor", "2025-04-30", "2025-03-31", [folio(3)]);
    assert.deepEqual(notesOf(plan, "S"), []);
    assert.deepEqual(notesOf(plan, "T"), otherInvestor === "investor" ? [unlistedNote] : []);
    assert.deepEqual(snapshotOf(plan, { flipped: new Set(), costs: new Map() }).holdings.map((h) => [h.assetId, h.quantity]), [
      ["asset-S", "150"], ["asset-T", "10"],
    ]);
    assert.deepEqual(await readRefs(store, one, "account", "2025-04-30"), entries(held("S")));
    // A listed source's record can still remove it: the lost entry supplies no keep safeguard.
    await saveImported(store, folio(3), "account", "2025-03-31", held("S"));
    const removed = await importHoldings(store, "investor", "2025-04-30", "2025-03-31", [folio(3)]);
    assert.equal(removed.positions.find((p) => p.ref === refOf("S")).include, false);
    assert.deepEqual(notesOf(removed, "S"), ["Not on the statement any more. An earlier import of Made-up Fund, folio 3 added it."]);
  }
});

test("an unlisted source's record forgets a holding the import replaces or removes, at the statement's date", async () => {
  const store = storage();
  await importHoldings(store, "investor", "2025-03-31", null, [folio(1, shareOf("S", "100")), folio(2, shareOf("S", "50"), shareOf("T", "10"))]);
  // April's statement lists folio 1's S, which replaces the account's units, and the user removes T.
  await importHoldings(store, "investor", "2025-04-30", "2025-03-31", [folio(1, shareOf("S", "150"))],
    (plan) => ({ flipped: new Set([plan.positions.find((p) => p.ref === refOf("T")).key]), costs: new Map() }));
  assert.deepEqual(await readRefs(store, folio(2), "account", "2025-04-30"), new Map());
  assert.deepEqual(await readRefs(store, folio(2), "account", "2025-03-31"), entries(held("S", "T")));
  assert.deepEqual(await readUnlisted(store, "account", "investor", [folio(1)], "2025-04-30"), []);
});

// Folios 1 and 2 went to account A in March; later statements put folio 2 in account B.
const choosing = (keep = new Map()) => () => ({ flipped: new Set(), costs: new Map(), keep });
/** Keeps (true) or removes (false) the account's units of `isin` where saving asks. */
const keepingUnits = (isin, keep) => (plan) =>
  choosing(new Map(plan.positions.filter((p) => p.ref === refOf(isin) && p.removable).map((p) => [p.key, keep])))();
const folio2ToB = (s) => (s.id === folio(2).id ? "B" : "A");

/** Accounts that track holdings, imported into as the page does: their snapshots, by account ID. */
function holdingsAccounts() {
  const snapshots = new Map();
  const existing = (id) => snapshots.get(id) ?? { date: null, positions: [], cash: {}, later: [] };
  return {
    snapshots,
    /** The account's holdings after the last import, as [ISIN, units]. */
    held: (id) => existing(id).positions.map((p) => [p.symbol, p.units]),
    /** Reads every source's record in every account the import saves to, and plans it. */
    async plan(store, date, sources, accountOf) {
      const ids = [...new Set(sources.map(accountOf).filter(Boolean))];
      const read = new Map();
      for (const source of sources) {
        for (const id of ids) read.set(`${source.id}|${id}`, reconcileRecord(await readImported(store, source, id, existing(id).date), existing(id), []));
      }
      const unlisted = new Map();
      for (const id of ids) {
        const records = await readUnlisted(store, id, "investor", sources, existing(id).date);
        unlisted.set(id, records.map(({ keys, ...record }) => ({ keys, ...reconcileRecord(record, existing(id), []) })));
      }
      return planSnapshots({ date, investor: "investor", leftOut: [], sources }, {
        account: accountOf,
        asset: (h) => ({ symbol: h.isin, exchangeMic: "XBOM", quoteCcy: "INR", name: h.name }),
        existing,
        remembered: (s, id) => read.get(`${s.id}|${id}`).remembered,
        recorded: (s, id) => read.get(`${s.id}|${id}`),
        heldElsewhere: (ref, id) => [...snapshots].filter(([other, s]) => other !== id && s.positions.some((p) => p.ref === ref))
          .map(([name]) => ({ name, tracksTransactions: false })),
        accountName: (id) => id,
        unlisted: (id) => unlisted.get(id),
      });
    },
    /** Saves each plan's snapshot, records and index, with `choose`'s choices. */
    async save(store, plans, choose = choosing()) {
      for (const plan of plans) {
        const choices = choose(plan);
        const before = existing(plan.accountId).positions;
        const positions = snapshotOf(plan, choices).holdings.map((h) => {
          const assetId = h.assetId ?? `asset-${h.symbol}`;
          const ref = before.find((p) => p.assetId === assetId)?.ref ?? refOf(h.symbol);
          return { assetId, symbol: h.symbol, ref, name: `Share ${h.symbol}`, units: h.quantity, cost: null, currency: "INR" };
        });
        snapshots.set(plan.accountId, { date: plan.date, positions, cash: {}, later: [] });
        // The IDs of the assets the save created, from the saved snapshot.
        await saveImports(store, plan.accountId, plan.date, importedRefs(plan, choices, new Map(positions.map((p) => [p.ref, p.assetId]))));
        await saveUnlisted(store, plan.date, unlistedRefs(plan, choices));
        await indexSources(store, plan.accountId, "investor", [
          ...plan.sources, ...[...plan.unread, ...plan.reassigned].filter((u) => u.remembered.size > 0 || u.aside?.size).map((u) => u.source),
        ]);
      }
    },
  };
}

/** March's import: Made-up Fund, folio 1 (150 S) and folio 2 (10 T) both go to account A. */
async function march() {
  const store = storage();
  const accounts = holdingsAccounts();
  await accounts.save(store, await accounts.plan(store, "2025-03-31", [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))], () => "A"));
  return { store, accounts };
}
const MOVED_T = "An earlier import of Made-up Fund, folio 2 recorded adding this holding here. Made-up Fund, folio 2 now goes to B and still lists it. " +
  "Keeping this account's 10 units may count them here and in B. Keep them, or remove them only if all of them came from Made-up Fund, folio 2: " +
  "imports don't record how many units each folio, demat account or PRAN added.";
const NO_LONGER_LISTS_T = "An earlier import of Made-up Fund, folio 2 recorded adding this holding here. Made-up Fund, folio 2 now goes to B and no longer lists it. " +
  "Keep this account's 10 units, or remove them only if all of them came from Made-up Fund, folio 2: " +
  "imports don't record how many units each folio, demat account or PRAN added.";
const rowOf = (plan, isin) => plan.positions.find((p) => p.ref === refOf(isin));

test("a holding that an earlier import of a folio now going to another account added waits for a choice to keep or remove it", async () => {
  const april = [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))];
  const may = [folio(1, shareOf("S", "150")), folio(2)];
  {
    const { store, accounts } = await march();
    const [a, b] = await accounts.plan(store, "2025-04-30", april, folio2ToB);
    assert.deepEqual([a.accountId, b.accountId], ["A", "B"]);
    assert.deepEqual(a.reassigned.map((r) => [r.source.id, r.to, [...r.remembered.keys()]]), [[folio(2).id, "B", [refOf("T")]]]);
    const t = rowOf(a, "T");
    assert.deepEqual([t.lines.length, t.removable.map((s) => s.label), t.notes], [0, ["Made-up Fund, folio 2"], [MOVED_T]]);
    assert.deepEqual([undecided(t, choosing()()), undecided(t, keepingUnits("T", false)(a))], [true, false]);
    // The statement's rows stay as they are: folio 1's S in A, and folio 2's T in B.
    assert.deepEqual([rowOf(a, "S").include, rowOf(a, "S").notes], [true, []]);
    assert.deepEqual([rowOf(b, "T").include, rowOf(b, "T").notes], [true, ["A also holds it."]]);
    // Removed: A keeps only S, B gets T, and folio 2's record in A no longer lists T.
    await accounts.save(store, [a, b], keepingUnits("T", false));
    assert.deepEqual([accounts.held("A"), accounts.held("B")], [[["S", "150"]], [["T", "10"]]]);
    assert.deepEqual(await readRefs(store, folio(2), "A", "2025-04-30"), new Map());
    assert.deepEqual(await readRefs(store, folio(2), "A", "2025-03-31"), entries(held("T")));
    assert.deepEqual(await readRefs(store, folio(2), "B", "2025-04-30"), entries(held("T")));
    // In May, folio 2 no longer holds T: A has nothing to ask about it, and B removes it by default.
    const [nextA, nextB] = await accounts.plan(store, "2025-05-31", may, folio2ToB);
    assert.equal(rowOf(nextA, "T"), undefined);
    assert.deepEqual([rowOf(nextB, "T").include, rowOf(nextB, "T").notes], [false, ["Not on the statement any more. An earlier import of Made-up Fund, folio 2 added it."]]);
  }
  {
    // Kept: A keeps its units, and folio 2's record in A stays as it was.
    const { store, accounts } = await march();
    const plans = await accounts.plan(store, "2025-04-30", april, folio2ToB);
    await accounts.save(store, plans, keepingUnits("T", true));
    assert.deepEqual([accounts.held("A"), accounts.held("B")], [[["T", "10"], ["S", "150"]], [["T", "10"]]]);
    assert.deepEqual(await readRefs(store, folio(2), "A", "2025-04-30"), entries(held("T")));
    // So May asks again, and says folio 2 no longer lists it.
    const [nextA] = await accounts.plan(store, "2025-05-31", may, folio2ToB);
    const t = rowOf(nextA, "T");
    assert.deepEqual([t.removable.map((s) => s.label), t.notes], [["Made-up Fund, folio 2"], [NO_LONGER_LISTS_T]]);
  }
});

test("a statement row a staying folio shares with a moved one takes the staying folio's units, and the moved one's record forgets it", async () => {
  const store = storage();
  const accounts = holdingsAccounts();
  await accounts.save(store, await accounts.plan(store, "2025-03-31", [folio(1, shareOf("S", "100")), folio(2, shareOf("S", "50"))], () => "A"));
  assert.deepEqual(accounts.held("A"), [["S", "150"]]);
  const [a, b] = await accounts.plan(store, "2025-04-30", [folio(1, shareOf("S", "100")), folio(2, shareOf("S", "50"))], folio2ToB);
  assert.deepEqual([rowOf(a, "S").units, rowOf(a, "S").include, rowOf(a, "S").notes], ["100", true, []]);
  assert.deepEqual([rowOf(b, "S").units, rowOf(b, "S").include, rowOf(b, "S").notes], ["50", true, ["A also holds it."]]);
  await accounts.save(store, [a, b]);
  assert.deepEqual([accounts.held("A"), accounts.held("B")], [[["S", "100"]], [["S", "50"]]]);
  assert.deepEqual(await readRefs(store, folio(2), "A", "2025-04-30"), new Map());
  assert.deepEqual(await readRefs(store, folio(1), "A", "2025-04-30"), entries(held("S")));
  // Left out instead, A keeps its 150, and folio 2's record there stays.
  const fresh = storage();
  const again = holdingsAccounts();
  await again.save(fresh, await again.plan(fresh, "2025-03-31", [folio(1, shareOf("S", "100")), folio(2, shareOf("S", "50"))], () => "A"));
  const plans = await again.plan(fresh, "2025-04-30", [folio(1, shareOf("S", "100")), folio(2, shareOf("S", "50"))], folio2ToB);
  await again.save(fresh, plans, (plan) => ({ flipped: new Set(plan.accountId === "A" ? [rowOf(plan, "S").key] : []), costs: new Map() }));
  assert.deepEqual(again.held("A"), [["S", "150"]]);
  assert.deepEqual(await readRefs(fresh, folio(2), "A", "2025-04-30"), entries(held("S")));
});

test("a moved folio's record follows its renamed asset by the asset ID it recorded", async () => {
  const { store, accounts } = await march();
  // T's asset gets another symbol in Wealthfolio; another asset takes T's.
  const a = accounts.snapshots.get("A");
  a.positions = [...a.positions.map((p) => (p.assetId === "asset-T" ? { ...p, symbol: "T2", ref: refOf("T2") } : p)),
    { assetId: "other-T", symbol: "T", ref: refOf("T"), name: "Another T", units: "3", cost: null, currency: "INR" }];
  const [planA, planB] = await accounts.plan(store, "2025-04-30", [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))], folio2ToB);
  assert.deepEqual(planA.reassigned.map((r) => [...r.remembered.keys()]), [[refOf("T2")]]);
  const renamed = rowOf(planA, "T2");
  assert.deepEqual([renamed.existing.assetId, renamed.removable.map((s) => s.label), renamed.notes], ["asset-T", ["Made-up Fund, folio 2"], [MOVED_T]]);
  // The asset that now has T's symbol is no import's.
  assert.deepEqual([rowOf(planA, "T").removable, rowOf(planA, "T").include, rowOf(planA, "T").notes], [undefined, true, []]);
  await accounts.save(store, [planA, planB], keepingUnits("T2", false));
  assert.deepEqual(accounts.held("A"), [["T", "3"], ["S", "150"]]);
  assert.deepEqual(await readRefs(store, folio(2), "A", "2025-04-30"), new Map());
  // Kept, the record goes on naming the asset by its ID.
  const kept = await march();
  const snapshot = kept.accounts.snapshots.get("A");
  snapshot.positions = snapshot.positions.map((p) => (p.assetId === "asset-T" ? { ...p, symbol: "T2", ref: refOf("T2") } : p));
  await kept.accounts.save(kept.store, await kept.accounts.plan(kept.store, "2025-04-30", [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))], folio2ToB),
    keepingUnits("T2", true));
  assert.deepEqual(await readImported(kept.store, folio(2), "A", "2025-04-30"), { remembered: entries(held("T")), ids: new Map([[refOf("T"), "asset-T"]]) });
});

test("a folio moved back takes its units in its old account from the statement, and the other account asks about them", async () => {
  for (const keep of [false, true]) {
    const { store, accounts } = await march();
    await accounts.save(store, await accounts.plan(store, "2025-04-30", [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10"))], folio2ToB), keepingUnits("T", keep));
    // June: folio 2 goes back to A, and folio 3 to B.
    const june = [folio(1, shareOf("S", "150")), folio(2, shareOf("T", "10")), folio(3, shareOf("U", "5"))];
    const [a, b] = await accounts.plan(store, "2025-06-30", june, (s) => (s.id === folio(3).id ? "B" : "A"));
    const t = rowOf(a, "T");
    // Folio 2 is A's again: its line replaces A's units, or is new there.
    assert.deepEqual([t.lines.length, t.include, t.removable, t.existing?.units, t.notes], [1, true, undefined, keep ? "10" : undefined, ["B also holds it."]]);
    assert.deepEqual(a.reassigned.map((r) => r.source.id), [folio(3).id]);
    const inB = rowOf(b, "T");
    assert.deepEqual([inB.removable.map((s) => s.label), inB.notes], [["Made-up Fund, folio 2"], [
      "An earlier import of Made-up Fund, folio 2 recorded adding this holding here. Made-up Fund, folio 2 now goes to A and still lists it. " +
      "Keeping this account's 10 units may count them here and in A. Keep them, or remove them only if all of them came from Made-up Fund, folio 2: " +
      "imports don't record how many units each folio, demat account or PRAN added.",
    ]]);
    await accounts.save(store, [a, b], keepingUnits("T", false));
    assert.deepEqual([accounts.held("A"), accounts.held("B")], [[["S", "150"], ["T", "10"]], [["U", "5"]]]);
    assert.deepEqual(await readRefs(store, folio(2), "A", "2025-06-30"), entries(held("T")));
    assert.deepEqual(await readRefs(store, folio(2), "B", "2025-06-30"), new Map());
  }
});
