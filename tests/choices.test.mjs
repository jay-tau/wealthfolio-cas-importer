import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { importedRefs, planSnapshots, readHoldings, security, snapshotOf, unlistedRefs } from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";
import {
  fundKey, holdingKey, indexSources, investorKey, readFund, readImported, readRecordChoices, readUnlisted, saveFund, saveImported, saveImports,
  saveUnlisted, securityKey,
} from "../src/lib/choices.ts";

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
  const saved = { assetId: "old-asset", symbol: "OLD", quoteCcy: "INR", name: "Made-up Fund" };
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
  const remembered = new Map(await Promise.all(sources.map(async (s) => [s.id, await readImported(store, s, "account", baseline)])));
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
  assert.deepEqual(await readImported(store, second, "account", "2025-04-30"), entries(held("T")));
  assert.deepEqual(await readImported(store, first, "account", "2025-04-30"), entries(held("S")));
  // A later baseline reads it; the records at other dates stay.
  assert.deepEqual(await readImported(store, second, "account", "2025-05-31"), entries(held("T")));
  for (const source of [first, second]) {
    assert.deepEqual(await readImported(store, source, "account", "2025-03-31"), entries(source === first ? held("S") : held("S", "T")));
    assert.deepEqual(await readImported(store, source, "account", "2025-06-30"), entries(held("S", "U")));
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
    assert.deepEqual(await readImported(store, source, "account", "2025-04-30"), entries(held("S", "T")));
  }
  // An unlinked source keeps its own record, without the linked folios' S, and links stay as they were.
  assert.deepEqual(await readImported(store, separate, "account", "2025-04-30"), entries(held("T")));
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
    assert.deepEqual(await readImported(store, source, "account", "2025-04-30"), entries(held("S", "T")));
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
    assert.deepEqual(await readImported(store, mixed, "account", "2025-04-30"), entries(held("S", "T")));
    for (const source of [other, depository]) {
      assert.deepEqual(await readImported(store, source, "account", "2025-04-30"), entries(held("S")));
    }
    for (const source of [mixed, other, depository]) {
      assert.deepEqual(await readImported(store, source, "account", "2025-03-31"), entries(held("S")));
      assert.deepEqual(await readImported(store, source, "account", "2025-06-30"), entries(held("U")));
    }
  }
});

// An investor's folios 1 and 2 went to one account in March; April's statement lists only folio 1.
const folio = (n, ...holdings) => ({ id: `folio|${n}|amc:Made-up Fund`, kind: "folio", label: `Made-up Fund, folio ${n}`, holdings });
const unlistedNote = "An earlier import added it from a folio, demat account or PRAN that this statement doesn't list. " +
  "Check whether it was redeemed, sold or moved, and untick Keep if so.";
/** What the page does: reads the records, plans the import into "account" and saves it, keeping every default. */
async function importHoldings(store, investor, date, baseline, sources, choose = () => ({ flipped: new Set(), costs: new Map() })) {
  const remembered = new Map(await Promise.all(sources.map(async (s) => [s.id, await readImported(store, s, "account", baseline)])));
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
      assert.deepEqual(await readImported(store, source, "account", "2025-04-30"), entries(held("T")));
      assert.deepEqual(await readImported(store, source, "account", "2025-02-28"), entries(held("S")));
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
    assert.deepEqual(await readImported(store, one, "account", "2025-04-30"), entries(held("S")));
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
  assert.deepEqual(await readImported(store, folio(2), "account", "2025-04-30"), new Map());
  assert.deepEqual(await readImported(store, folio(2), "account", "2025-03-31"), entries(held("S", "T")));
  assert.deepEqual(await readUnlisted(store, "account", "investor", [folio(1)], "2025-04-30"), []);
});
