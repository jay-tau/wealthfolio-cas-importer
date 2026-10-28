import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dec, div, format } from "../src/cas/decimal.ts";
import {
  importedRefs,
  included,
  manualPriceChange,
  planSnapshots,
  readHoldings,
  replacesSnapshot,
  snapshotOf,
  splitSince,
  validCost,
} from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";

const fixture = async (name) => JSON.parse(await readFile(`tests/fixtures/${name}.json`, "utf8"));

const asset = (h) => ({
  symbol: h.isin ?? h.rtaCode,
  exchangeMic: "XBOM",
  quoteCcy: "INR",
  instrumentType: h.kind === "share" ? "EQUITY" : "MUTUALFUND",
  providerId: "FAKE",
  providerSymbol: `${h.isin}.BO`,
  name: `Asset ${h.isin}`,
});
const ref = (isin) => fundRef(isin, "XBOM");
const none = { date: null, positions: [], cash: {}, later: [] };
const noChoices = { flipped: new Set(), costs: new Map() };

function plan(holdings, overrides = {}) {
  return planSnapshots(holdings, {
    account: () => "holdings-1",
    asset,
    existing: () => none,
    remembered: () => new Map(),
    heldElsewhere: () => [],
    ...overrides,
  });
}

test("divides with rounding half away from zero", () => {
  assert.equal(format(div(dec("10"), dec("3"), 4)), "3.3333");
  assert.equal(format(div(dec("2"), dec("3"), 4)), "0.6667");
  assert.equal(format(div(dec("-2"), dec("3"), 4)), "-0.6667");
  assert.equal(format(div(dec("1.5"), dec("0.25"), 2)), "6");
  assert.equal(format(div(dec("0.125"), dec("1"), 2)), "0.13");
  assert.throws(() => div(dec("1"), dec("0"), 2));
});

test("reads a summary statement's folios", async () => {
  for (const name of ["made-up-summary-cams", "made-up-summary-kfintech"]) {
    const holdings = readHoldings(await fixture(name));
    assert.equal(holdings.date, "2025-03-31");
    assert.equal(holdings.investor, "ananya.testwala@example.com");
    assert.deepEqual(
      holdings.sources.map((s) => [s.id, s.kind, s.label, s.holdings.length]),
      [
        ["folio|91234567/12|amc:Fictiva Mutual Fund", "folio", "Fictiva Mutual Fund, folio 91234567 / 12", 2],
        ["folio|91234570/0|amc:Fictiva Mutual Fund", "folio", "Fictiva Mutual Fund, folio 91234570/0", 1],
        ["folio|1040012345|amc:Testbridge Mutual Fund", "folio", "Testbridge Mutual Fund, folio 1040012345", 3],
      ],
    );
    const [flexi] = holdings.sources[0].holdings;
    assert.deepEqual(flexi, {
      kind: "fund",
      isin: "INFZ90K01FC8",
      rta: "CAMS",
      rtaCode: "FFCDG",
      name: flexi.name,
      units: "2892.104",
      price: "74.3120",
      value: "214918.03",
      cost: "154554",
    });
    // The blank Cost Value cell.
    assert.equal(holdings.sources[2].holdings.find((h) => h.rtaCode === "TGLDG").cost, null);
    assert.deepEqual(holdings.leftOut, []);
  }
});

test("reads an NSDL statement's demat accounts and folios, and leaves bonds out", async () => {
  const holdings = readHoldings(await fixture("made-up-nsdl"));
  assert.equal(holdings.date, "2025-03-31");
  assert.equal(holdings.investor, "ABCDE1234F");
  assert.deepEqual(
    holdings.sources.map((s) => [s.id, s.kind, s.holdings.map((h) => h.kind).join(",")]),
    [
      ["demat|IN999901|90000001", "demat", "share,share,share,fund"],
      ["demat|99990001|90000002", "demat", "share,share,share,fund,fund"],
      ["folio|91234567/12|INFZ90K", "folio", "fund,fund,fund"],
      ["folio|1040012345|INFZ91T", "folio", "fund"],
    ],
  );
  assert.equal(holdings.sources[0].label, "NSDL Demat Account 1, FICTIVA SECURITIES PRIVATE LIMITED");
  assert.equal(holdings.sources[1].label, "CDSL Demat Account 2, TESTBRIDGE BROKING LIMITED");
  const displayed = JSON.stringify([holdings.sources.map((s) => s.label), holdings.leftOut]);
  for (const id of ["IN999901", "90000001", "99990001", "90000002"]) assert.ok(!displayed.includes(id));
  // Shares and demat funds print no cost; folio funds print a total cost, or `--`.
  assert.ok(holdings.sources.slice(0, 2).every((s) => s.holdings.every((h) => h.cost === null)));
  assert.equal(holdings.sources[2].holdings[0].cost, "154554");
  assert.deepEqual(holdings.sources[3].holdings.map((h) => h.cost), [null]);
  assert.deepEqual(
    holdings.leftOut.map((l) => l.reason),
    Array(4).fill("Bonds aren't imported yet."),
  );
});

test("reads a CDSL statement, and leaves out NPS and holdings without units", async () => {
  const holdings = readHoldings(await fixture("made-up-cdsl"));
  assert.equal(holdings.date, "2026-03-31");
  assert.equal(holdings.investor, "ABCDE1234F");
  assert.deepEqual(
    holdings.sources.map((s) => [s.id, s.holdings.length]),
    [
      ["demat|19999901|00012345", 3],
      ["folio|91234567/12|INFZ90K", 2],
      ["folio|1040012345|INFZ91T", 2],
      ["demat|IN999901|10012345", 2],
    ],
  );
  assert.deepEqual(
    holdings.leftOut.map((l) => l.reason),
    ["No units on the statement.", ...Array(3).fill("NPS holdings aren't imported yet.")],
  );
  assert.match(holdings.sources[0].label, /^CDSL Demat Account 1,/);
  assert.match(holdings.sources[3].label, /^NSDL Demat Account 2,/);
  const displayed = JSON.stringify([holdings.sources.map((s) => s.label), holdings.leftOut]);
  for (const id of ["19999901", "00012345", "IN999901", "10012345"]) assert.ok(!displayed.includes(id));
  assert.deepEqual(
    holdings.sources[2].holdings.map((h) => h.cost),
    ["100000", null],
  );
});

test("takes the cost from the average cost when the total isn't printed", () => {
  const holdings = readHoldings({
    accounts: [
      {
        name: "Mutual Fund Folios",
        type: "Mutual Fund Folios",
        dp_id: "",
        client_id: "",
        folios: 1,
        balance: "100",
        owners: [{ name: "A", PAN: "ABCDE1234F" }],
        equities: [],
        bonds: [],
        mutual_funds: [
          { name: "F", isin: "INFZ90K01FC8", balance: "2.5", nav: "40", value: "100", avg_cost: "30.5", total_cost: null, folio: "1 / 2" },
          { name: "G", isin: "INFZ90K01LQ6", balance: "2", nav: "40", value: "80", avg_cost: "0", total_cost: "0.00", folio: "1 / 2" },
        ],
      },
    ],
    statement_period: { from: "01-03-2025", to: "31/03/2025" },
    investor_info: { name: "A", email: "", address: "", mobile: "" },
    file_type: "NSDL",
    nps: null,
    parse_warnings: [],
  });
  assert.equal(holdings.date, "2025-03-31");
  assert.deepEqual(
    holdings.sources.map((s) => [s.id, s.holdings.map((h) => h.cost)]),
    [["folio|1/2|INFZ90K", ["76.25", null]]],
  );
});

test("a new account gets the statement's holdings, with the printed costs", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const [account] = plan(holdings);
  assert.equal(account.date, "2025-03-31");
  assert.equal(replacesSnapshot(account), false);
  assert.equal(account.positions.length, 6);
  assert.ok(account.positions.every((p) => p.include && p.notes.length === 0));
  const { holdings: saved, cash } = snapshotOf(account, noChoices);
  assert.deepEqual(cash, {});
  assert.deepEqual(saved[0], {
    symbol: "INFZ90K01FC8",
    exchangeMic: "XBOM",
    quoteCcy: "INR",
    instrumentType: "MUTUALFUND",
    providerId: "FAKE",
    providerSymbol: "INFZ90K01FC8.BO",
    name: "Asset INFZ90K01FC8",
    quantity: "2892.104",
    currency: "INR",
    averageCost: "53.4399869437613585127",
  });
  // Unknown cost: no average cost, which Wealthfolio stores as zero.
  const gold = saved.find((h) => h.symbol === "INFZ91T01GL6");
  assert.equal(gold.averageCost, undefined);
  assert.equal(account.positions.find((p) => p.ref === ref("INFZ91T01GL6")).cost, undefined);
});

test("merges onto the account's snapshot: replaces listed holdings, keeps others and cash, drops sold ones", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const existing = {
    date: "2025-01-31",
    later: [],
    cash: { INR: "1500" },
    positions: [
      // On the statement, with Wealthfolio's cost.
      { assetId: "a-gold", symbol: "INFZ91T01GL6", ref: ref("INFZ91T01GL6"), name: "Gold", units: "800", cost: "40000", currency: "INR" },
      // On the statement, cost printed: the printed cost wins.
      { assetId: "a-flexi", symbol: "INFZ90K01FC8", ref: ref("INFZ90K01FC8"), name: "Flexi", units: "2800", cost: "1", currency: "INR" },
      // Added by hand.
      { assetId: "a-gilt", symbol: "GILT", ref: ref("GILT"), name: "Gilt", units: "10", cost: null, currency: "INR" },
      // An earlier import of folio 1040012345 put it there; it's gone from the statement.
      { assetId: "a-old", symbol: "OLD", ref: ref("OLD"), name: "Old", units: "5", cost: "50", currency: "INR" },
      // An earlier import put it there, and it's still on the statement, but left out this time.
      { assetId: "a-bond", symbol: "INFZ91T01CB6", ref: ref("INFZ91T01CB6"), name: "Bond", units: "9000", cost: "90000", currency: "INR" },
    ],
  };
  const [account] = plan(holdings, {
    asset: (h) => (h.isin === "INFZ91T01CB6" ? undefined : asset(h)),
    existing: () => existing,
    remembered: (source) =>
      source.id === "folio|1040012345|amc:Testbridge Mutual Fund"
        ? new Map([
            [ref("OLD"), ["INFZOLD"]],
            [ref("INFZ91T01CB6"), ["INFZ91T01CB6", "KFINTECH|TCBRP"]],
          ])
        : new Map(),
  });
  const byRef = (r) => account.positions.find((p) => p.ref === r);
  // The statement's holdings in its order, whatever the snapshot's, then the account's others.
  assert.deepEqual(
    account.positions.map((p) => p.existing?.assetId ?? p.ref),
    [
      "a-flexi",
      ref("INFZ90K01LQ6"),
      ref("INFZ90K01BA1"),
      "a-gold",
      ref("INFZ91T01FT1"),
      "a-gilt",
      "a-old",
      "a-bond",
    ],
  );
  assert.deepEqual(byRef(ref("INFZ91T01GL6")).cost, { total: "42275.6", from: "wealthfolio" });
  assert.deepEqual(byRef(ref("INFZ90K01FC8")).cost, { total: "154554", from: "statement" });
  assert.equal(byRef(ref("GILT")).include, true);
  assert.equal(byRef(ref("OLD")).include, false);
  assert.match(byRef(ref("OLD")).notes[0], /Not on the statement any more\. An earlier import of Testbridge Mutual Fund, folio 1040012345 added it\./);
  assert.equal(byRef(ref("INFZ91T01CB6")).include, true);
  assert.deepEqual(byRef(ref("INFZ91T01CB6")).notes, []);

  const { holdings: saved, cash } = snapshotOf(account, noChoices);
  assert.deepEqual(cash, { INR: "1500" });
  const savedBy = (symbol) => saved.find((h) => h.symbol === symbol);
  assert.deepEqual(savedBy("INFZ91T01GL6"), {
    assetId: "a-gold",
    symbol: "INFZ91T01GL6",
    quantity: "845.512",
    currency: "INR",
    averageCost: "50",
  });
  assert.equal(savedBy("INFZ90K01FC8").assetId, "a-flexi");
  assert.deepEqual(savedBy("GILT"), { assetId: "a-gilt", symbol: "GILT", quantity: "10", currency: "INR" });
  assert.deepEqual(savedBy("INFZ91T01CB6"), { assetId: "a-bond", symbol: "INFZ91T01CB6", quantity: "9000", currency: "INR", averageCost: "10" });
  assert.equal(savedBy("OLD"), undefined);

  // Flipping both: keep the sold one, drop the hand-added one; a typed cost replaces Wealthfolio's, blank means unknown.
  const flipped = new Set([ref("OLD"), ref("GILT")]);
  const choices = { flipped, costs: new Map([[ref("INFZ91T01GL6"), ""]]) };
  const after = snapshotOf(account, choices).holdings;
  assert.equal(after.find((h) => h.symbol === "GILT"), undefined);
  assert.deepEqual(after.find((h) => h.symbol === "OLD"), { assetId: "a-old", symbol: "OLD", quantity: "5", currency: "INR", averageCost: "10" });
  assert.equal(after.find((h) => h.symbol === "INFZ91T01GL6").averageCost, undefined);
  const typed = snapshotOf(account, { flipped, costs: new Map([[ref("INFZ91T01GL6"), "42275.60"]]) }).holdings;
  assert.equal(typed.find((h) => h.symbol === "INFZ91T01GL6").averageCost, "50");

  assert.deepEqual(
    importedRefs(account, noChoices).map(({ source, refs }) => [source.id, refs]),
    [
      ["folio|91234567/12|amc:Fictiva Mutual Fund", { [ref("INFZ90K01FC8")]: ["INFZ90K01FC8", "CAMS|FFCDG"], [ref("INFZ90K01LQ6")]: ["INFZ90K01LQ6", "CAMS|FLQDG"] }],
      ["folio|91234570/0|amc:Fictiva Mutual Fund", { [ref("INFZ90K01BA1")]: ["INFZ90K01BA1", "CAMS|FBADR"] }],
      ["folio|1040012345|amc:Testbridge Mutual Fund", { [ref("INFZ91T01CB6")]: ["INFZ91T01CB6", "KFINTECH|TCBRP"], [ref("INFZ91T01GL6")]: ["INFZ91T01GL6", "KFINTECH|TGLDG"], [ref("INFZ91T01FT1")]: ["INFZ91T01FT1", "KFINTECH|TFT12"] }],
    ],
  );
});

test("a folio's fund that an account tracking transactions holds is left out by default", async () => {
  const holdings = readHoldings(await fixture("made-up-nsdl"));
  const heldElsewhere = (r) =>
    r === ref("INFZ90K01FC8")
      ? [{ name: "Mutual funds", tracksTransactions: true }]
      : r === ref("INEZ92A01013")
        ? [{ name: "Broker", tracksTransactions: false }]
        : [];
  const [account] = plan(holdings, { heldElsewhere });
  const flexi = account.positions.find((p) => p.ref === ref("INFZ90K01FC8"));
  assert.equal(flexi.include, false);
  assert.deepEqual(flexi.notes, ["Mutual funds already holds this fund, from its transactions. Including it here counts it twice."]);
  assert.equal(snapshotOf(account, noChoices).holdings.find((h) => h.symbol === "INFZ90K01FC8"), undefined);
  assert.ok(included(flexi, { flipped: new Set([flexi.key]), costs: new Map() }));
  // In a demat account, it's only a warning.
  const steel = account.positions.find((p) => p.ref === ref("INEZ92A01013"));
  assert.equal(steel.include, true);
  assert.deepEqual(steel.notes, ["Broker also holds it."]);
  // Not imported, so not remembered either.
  assert.ok(importedRefs(account, noChoices).every(({ refs }) => !(ref("INFZ90K01FC8") in refs)));
});

test("the same fund in two places in one account adds up, and a partly printed cost is unknown", async () => {
  const holdings = readHoldings(await fixture("made-up-nsdl"));
  // INEZ90B01015 shares are held in both demat accounts.
  const [account] = plan(holdings);
  const shared = account.positions.filter((p) => p.lines.length > 1);
  assert.deepEqual(
    shared.map((p) => [p.ref, p.lines.map((l) => l.source.id), p.units]),
    [[ref("INEZ90B01015"), ["demat|IN999901|90000001", "demat|99990001|90000002"], "520"]],
  );
  const two = planSnapshots(
    {
      date: "2025-03-31",
      investor: "x",
      leftOut: [],
      sources: [
        { id: "folio|1", kind: "folio", label: "Folio 1", holdings: [{ kind: "fund", isin: "INFZ1", rta: null, rtaCode: null, name: "F", units: "10", price: "2", value: "20", cost: "15" }] },
        { id: "folio|2", kind: "folio", label: "Folio 2", holdings: [{ kind: "fund", isin: "INFZ1", rta: null, rtaCode: null, name: "F", units: "5", price: "2", value: "10", cost: null }] },
      ],
    },
    { account: () => "h", asset, existing: () => none, remembered: () => new Map(), heldElsewhere: () => [] },
  )[0].positions[0];
  assert.equal(two.units, "15");
  assert.equal(two.value, "30");
  assert.equal(two.cost, undefined);
  assert.deepEqual(two.notes, ["The statement prints a cost for only some of its lines for this holding."]);
});

test("each source goes to its own account, or is left out", async () => {
  const holdings = readHoldings(await fixture("made-up-cdsl"));
  const plans = plan(holdings, {
    account: (s) => (s.kind === "demat" ? "brokerage" : s.id === "folio|1040012345|INFZ91T" ? undefined : "funds"),
    existing: (id) => ({ ...none, date: id === "funds" ? "2026-03-31" : null }),
  });
  assert.deepEqual(
    plans.map((p) => [p.accountId, p.sources.map((s) => s.id), p.positions.length, replacesSnapshot(p)]),
    [
      ["brokerage", ["demat|19999901|00012345", "demat|IN999901|10012345"], 5, false],
      ["funds", ["folio|91234567/12|INFZ90K"], 2, true],
    ],
  );
});

test("typed costs must be positive amounts, or blank", () => {
  for (const ok of ["", "  ", "100", "0.5", "12345.67"]) assert.ok(validCost(ok), ok);
  for (const bad of ["0", "-5", "1,000", "abc", "1e5", "0.00"]) assert.ok(!validCost(bad), bad);
});

test("rejects ambiguous existing asset references before they can be lost", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const existing = { ...none, positions: ["equity", "fund"].map((assetId) => ({
    assetId, ref: ref("ABC"), symbol: "ABC", name: assetId, units: "10", cost: "100", currency: "INR",
  })) };
  assert.throws(() => plan(holdings, { existing: () => existing }), /multiple assets for ABC@XBOM/);
});

test("manual prices cannot be overwritten by a carried or imported average cost", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const existing = { ...none, positions: [{
    assetId: "manual", ref: ref("MANUAL"), symbol: "MANUAL", name: "Manual asset", units: "10", cost: "100", currency: "INR", manual: true,
  }] };
  const [account] = plan(holdings, { existing: () => existing });
  assert.equal(manualPriceChange(account, noChoices).name, "Manual asset");
  assert.throws(() => snapshotOf(account, noChoices), /overwrite its manual price/);
  assert.ok(!snapshotOf(account, { ...noChoices, flipped: new Set([ref("MANUAL")]) }).holdings.some((h) => h.assetId === "manual"));
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  existing.positions[0] = { ...existing.positions[0], ref: ref(gold.isin), symbol: gold.isin };
  const [matched] = plan(holdings, { existing: () => existing });
  assert.throws(() => snapshotOf(matched, noChoices), /overwrite its manual price/);
  assert.doesNotThrow(() => snapshotOf(matched, { ...noChoices, costs: new Map([[ref(gold.isin), ""]]) }));
  assert.doesNotThrow(() => manualPriceChange(matched, { ...noChoices, costs: new Map([[ref(gold.isin), "abc"]]) }));
});

test("explicit empty sources remove their last imported holding, preserving cash", async () => {
  for (const name of ["made-up-summary-cams", "made-up-nsdl"]) {
    const data = await fixture(name);
    const first = readHoldings(data).sources[0];
    const holding = first.holdings[0];
    if (data.folios) {
      data.folios = [data.folios[0]];
      data.folios[0].schemes.forEach((s) => { s.close = "0"; });
    } else {
      data.accounts = [data.accounts[0]];
      data.accounts[0].equities = [];
      data.accounts[0].mutual_funds = [];
    }
    const holdings = readHoldings(data);
    assert.equal(holdings.sources[0].id, first.id);
    assert.equal(holdings.sources[0].holdings.length, 0);
    const [account] = plan(holdings, {
      existing: () => ({ ...none, cash: { INR: "1500" }, positions: [{
        assetId: "old", ref: ref(holding.isin), symbol: holding.isin, name: "Sold", units: "10", cost: null, currency: "INR",
      }] }),
      remembered: () => new Map([[ref(holding.isin), [holding.isin]]]),
    });
    assert.equal(account.positions[0].include, false);
    assert.deepEqual(snapshotOf(account, noChoices), { holdings: [], cash: { INR: "1500" } });
  }
});

test("a left-out holding keeps its provenance until a later statement sells it", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const [first] = plan(holdings);
  const earlier = new Map(importedRefs(first, noChoices).map(({ source, refs }) => [source.id, new Map(Object.entries(refs))]));
  const holding = holdings.sources[0].holdings[0];
  const existing = { ...none, positions: [{
    assetId: "earlier", symbol: holding.isin, ref: ref(holding.isin), name: holding.name, units: "10", cost: "100", currency: "INR",
  }] };
  const [leftOut] = plan(holdings, { existing: () => existing, asset: () => undefined, remembered: (s) => earlier.get(s.id) });
  assert.equal(snapshotOf(leftOut, noChoices).holdings[0].assetId, "earlier");
  const next = new Map(importedRefs(leftOut, noChoices).map(({ source, refs }) => [source.id, new Map(Object.entries(refs))]));
  assert.deepEqual(next.get(holdings.sources[0].id).get(ref(holding.isin)), [holding.isin, "CAMS|FFCDG"]);
  holdings.sources[0].holdings = holdings.sources[0].holdings.slice(1);
  const [sold] = plan(holdings, { existing: () => existing, remembered: (s) => next.get(s.id) });
  assert.ok(!snapshotOf(sold, noChoices).holdings.some((h) => h.assetId === "earlier"));
});

test("overlap leaves only folio contributions out and saves selected contributions once", () => {
  const h = { kind: "fund", isin: "INFZ1", rta: null, rtaCode: null, name: "Shared", units: "100", price: "2", value: "200", cost: null };
  const holdings = { date: "2025-03-31", investor: "x", leftOut: [], sources: [
    { id: "demat|1|1", kind: "demat", label: "Demat", holdings: [h] },
    { id: "folio|1", kind: "folio", label: "Folio", holdings: [{ ...h, units: "5", value: "10", cost: "5" }] },
  ] };
  const [account] = plan(holdings, { heldElsewhere: () => [{ name: "Transactions", tracksTransactions: true }] });
  const [demat, folio] = account.positions;
  assert.equal(demat.include, true);
  assert.equal(folio.include, false);
  assert.notEqual(demat.key, folio.key);
  assert.equal(snapshotOf(account, noChoices).holdings[0].quantity, "100");
  const both = snapshotOf(account, { flipped: new Set([folio.key]), costs: new Map([[demat.key, "100"]]) }).holdings;
  assert.equal(both.length, 1);
  assert.equal(both[0].quantity, "105");
  assert.equal(both[0].averageCost, "1");
  const unknown = snapshotOf(account, { flipped: new Set([folio.key]), costs: new Map() }).holdings;
  assert.equal(unknown[0].averageCost, undefined);
  const onlyFolio = snapshotOf(account, { flipped: new Set([demat.key, folio.key]), costs: new Map() }).holdings;
  assert.equal(onlyFolio[0].quantity, "5");
  assert.equal(onlyFolio[0].averageCost, "1");
  const [manual] = plan(holdings, {
    heldElsewhere: () => [{ name: "Transactions", tracksTransactions: true }],
    existing: () => ({ ...none, positions: [{
      assetId: "manual", ref: ref(h.isin), symbol: h.isin, name: "Manual", units: "105", cost: "105", currency: "INR", manual: true,
    }] }),
  });
  assert.doesNotThrow(() => snapshotOf(manual, { flipped: new Set(), costs: new Map([[manual.positions[0].key, ""]]) }));
  assert.throws(() => snapshotOf(manual, noChoices), /overwrite its manual price/);
});

test("already separate parsed folios distinguish issuers, link formats, and survive missing ISINs and zero balances", async () => {
  const data = await fixture("made-up-summary-cams");
  data.folios[2].folio = data.folios[0].folio.replaceAll(" ", "");
  const sources = readHoldings(data).sources;
  assert.notEqual(sources[0].id, sources[2].id);
  const depository = await fixture("made-up-nsdl");
  depository.accounts.find((a) => a.type === "Mutual Fund Folios").mutual_funds.forEach((f) => { f.folio = data.folios[0].folio; f.balance = "0"; });
  const folios = readHoldings(depository).sources.filter((s) => s.kind === "folio");
  assert.deepEqual(folios.map((s) => s.id), [sources[0].aliases[0], sources[2].aliases[0]]);
  assert.ok(folios.every((s) => !s.holdings.length));
  data.folios.forEach((f) => f.schemes.forEach((s) => { s.isin = null; }));
  const fallback = readHoldings(data).sources;
  assert.notEqual(fallback[0].id, fallback[2].id);
  assert.deepEqual(fallback.map((s) => s.id), sources.map((s) => s.id));
  assert.ok(fallback.every((s) => s.aliases === undefined));
  data.folios[0].schemes = [];
  assert.equal(readHoldings(data).sources[0].id, sources[0].id);
  const same = await fixture("made-up-summary-cams");
  same.folios.push({ ...same.folios[0], folio: same.folios[0].folio.replaceAll(" ", "") });
  const joined = readHoldings(same).sources;
  assert.equal(joined.length, 3);
  assert.equal(joined[0].holdings.length, 4);
});

test("summary folios with funds from several issuers are imported without depository links", async () => {
  for (const name of ["made-up-summary-cams", "made-up-summary-kfintech"]) {
    const data = await fixture(name);
    // Native casparser merges equal folio numbers across AMCs into the first AMC's folio. Fund
    // house mergers can also leave one folio with two issuers' ISINs.
    data.folios[0].schemes.push(...data.folios[2].schemes);
    data.folios.splice(2, 1);
    const [mixed, single] = readHoldings(data).sources;
    assert.equal(mixed.holdings.length, 5);
    assert.deepEqual(mixed.aliases, []);
    assert.deepEqual(single.aliases, ["folio|91234570/0|INFZ90K"]);
  }
});

test("average-cost fallback preserves a known cost smaller than a paisa", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  gold.units = "0.001";
  const [account] = plan(holdings, { existing: () => ({ ...none, positions: [{
    assetId: "gold", ref: ref(gold.isin), symbol: gold.isin, name: "Gold", units: "1", cost: "1", currency: "INR",
  }] }) });
  assert.equal(account.positions.find((p) => p.ref === ref(gold.isin)).cost.total, "0.001");
  assert.equal(snapshotOf(account, noChoices).holdings.find((h) => h.assetId === "gold").averageCost, "1");
});

test("known global manual pricing blocks new-to-account assets too", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const [account] = plan(holdings, { asset: (h) => ({ ...asset(h), manual: true }) });
  assert.equal(account.positions[0].existing, undefined);
  assert.throws(() => snapshotOf(account, noChoices), /overwrite its manual price/);
  const blank = { ...noChoices, costs: new Map(account.positions.map((p) => [p.key, ""])) };
  // Printed costs cannot be cleared in the preview.
  assert.throws(() => snapshotOf(account, blank), /overwrite its manual price/);
  const unknownOnly = { ...holdings, sources: holdings.sources.map((s) => ({
    ...s, holdings: s.holdings.filter((h) => h.cost === null),
  })) };
  const [unknown] = plan(unknownOnly, { asset: (h) => ({ ...asset(h), manual: true }) });
  assert.doesNotThrow(() => snapshotOf(unknown, noChoices));
  assert.throws(() => snapshotOf(unknown, { ...noChoices, costs: new Map([[unknown.positions[0].key, "10"]]) }), /overwrite its manual price/);
});

test("a still-listed left-out summary fund survives losing its printed ISIN", async () => {
  const data = await fixture("made-up-summary-cams");
  data.folios = [data.folios[0]];
  const first = readHoldings(data);
  const [initial] = plan(first);
  const remembered = new Map(Object.entries(importedRefs(initial, noChoices)[0].refs));
  const before = first.sources[0].holdings[1];
  const existing = { ...none, positions: [{
    assetId: "liquid", symbol: before.isin, ref: ref(before.isin), name: before.name,
    units: "10", cost: "100", currency: "INR",
  }] };
  data.folios[0].schemes[1].isin = null;
  const later = readHoldings(data);
  assert.equal(later.sources[0].id, first.sources[0].id);
  const [account] = plan(later, {
    asset: (h) => h.isin ? asset(h) : undefined, existing: () => existing, remembered: () => remembered,
  });
  assert.equal(account.positions.find((p) => p.existing?.assetId === "liquid").include, true);
  assert.ok(snapshotOf(account, noChoices).holdings.some((h) => h.assetId === "liquid"));
  // A prior depository import had only an ISIN: keep it when no comparable identity exists.
  const [uncertain] = plan(later, {
    asset: (h) => h.isin ? asset(h) : undefined, existing: () => existing,
    remembered: () => new Map([[ref(before.isin), [before.isin]]]),
  });
  assert.match(uncertain.positions.find((p) => p.existing?.assetId === "liquid").notes[0], /lacks a comparable identifier/);
  assert.ok(snapshotOf(uncertain, noChoices).holdings.some((h) => h.assetId === "liquid"));
});

test("a split recorded since an older snapshot is flagged, not carried", async () => {
  const existing = { ...none, date: "2025-01-31", positions: [{
    assetId: "share", ref: ref("SHARE"), symbol: "SHARE", name: "Share", units: "10", cost: "1000", currency: "INR",
  }] };
  const split = (date, overrides = {}) => ({ assetId: "share", activityType: "SPLIT", status: "POSTED", date, ...overrides });
  for (const date of ["2025-02-15T00:00:00Z", "2025-01-31T12:00:00Z", "2025-04-01T04:00:00Z", "invalid"]) {
    assert.deepEqual([...splitSince(existing, "2025-03-31", [split(date)])], ["share"], date);
  }
  assert.deepEqual([...splitSince(existing, "2025-03-31", [split("2025-02-15", { activityType: "BUY", activityTypeOverride: "SPLIT" })])], ["share"]);
  assert.deepEqual([...splitSince(existing, "2025-03-31", [
    split("2025-01-30"), split("2025-04-02"),
    split("2025-02-15", { assetId: "other" }),
    split("2025-02-15", { status: "DRAFT" }),
    split("2025-02-15", { activityType: "BUY" }),
  ])], []);
  // A snapshot on the statement's date is replaced, not carried.
  assert.deepEqual([...splitSince({ ...existing, date: "2025-03-31" }, "2025-03-31", [split("invalid")])], []);
  assert.deepEqual([...splitSince(none, "2025-03-31", [split("2025-02-15")])], []);

  // Not on the statement: kept, with a note. On it: Wealthfolio's cost isn't reused.
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  const splitPositions = [
    { ...existing.positions[0], split: true },
    { assetId: "gold", ref: ref(gold.isin), symbol: gold.isin, name: "Gold", units: "800", cost: "40000", currency: "INR", split: true },
  ];
  const [account] = plan(holdings, { existing: () => ({ ...existing, positions: splitPositions }) });
  const share = account.positions.find((p) => p.ref === ref("SHARE"));
  assert.equal(share.include, true);
  assert.match(share.notes[0], /split was recorded.*correct its units in Wealthfolio/);
  const goldRow = account.positions.find((p) => p.ref === ref(gold.isin));
  assert.equal(goldRow.cost, undefined);
  assert.match(goldRow.notes[0], /split was recorded.*Enter the total cost, or leave it unknown/);
});

test("signed existing costs and average costs survive, including manual-price protection", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const short = { assetId: "short", ref: ref("SHORT"), symbol: "SHORT", name: "Short", units: "-10", cost: "-1000", currency: "INR" };
  const existing = { ...none, positions: [short] };
  const [account] = plan(holdings, { existing: () => existing });
  assert.deepEqual(snapshotOf(account, noChoices).holdings.find((h) => h.assetId === "short"), {
    assetId: "short", symbol: "SHORT", quantity: "-10", currency: "INR", averageCost: "100",
  });
  short.manual = true;
  assert.throws(() => snapshotOf(account, noChoices), /overwrite its manual price/);
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  existing.positions[0] = { ...short, ref: ref(gold.isin), symbol: gold.isin, units: "-800", cost: "-40000" };
  const [matched] = plan(holdings, { existing: () => existing });
  const position = matched.positions.find((p) => p.ref === ref(gold.isin));
  assert.deepEqual(position.cost, { total: "42275.6", from: "wealthfolio" });
  assert.throws(() => snapshotOf(matched, noChoices), /overwrite its manual price/);
  assert.doesNotThrow(() => snapshotOf(matched, { ...noChoices, costs: new Map([[position.key, ""]]) }));
  existing.positions[0].cost = "40000";
  const [negativeAverage] = plan(holdings, { existing: () => existing });
  assert.throws(() => snapshotOf(negativeAverage, noChoices), /overwrite its manual price/);
});

test("one source remembers every printed security confirmed to the same asset", () => {
  const a = { kind: "fund", isin: "ISIN_A", rta: "CAMS", rtaCode: "A", name: "A", units: "10", price: "10", value: "100", cost: "100" };
  const b = { ...a, isin: "ISIN_B", rtaCode: "B", name: "B" };
  const holdings = { date: "2025-03-31", investor: "test", leftOut: [], sources: [
    { id: "folio|test", kind: "folio", label: "Folio", holdings: [a, b] },
  ] };
  const [first] = plan(holdings, { asset: (h) => ({ ...asset(h), symbol: "SHARED" }) });
  assert.equal(snapshotOf(first, noChoices).holdings[0].quantity, "20");
  const refs = importedRefs(first, noChoices)[0].refs;
  assert.deepEqual(refs[ref("SHARED")], ["ISIN_A", "CAMS|A", "ISIN_B", "CAMS|B"]);
  holdings.sources[0].holdings = [a];
  const [later] = plan(holdings, {
    asset: () => undefined,
    remembered: () => new Map(Object.entries(refs)),
    existing: () => ({ ...none, positions: [{
      assetId: "shared", ref: ref("SHARED"), symbol: "SHARED", name: "Shared", units: "20", cost: "200", currency: "INR",
    }] }),
  });
  assert.equal(snapshotOf(later, noChoices).holdings[0].quantity, "20");
  assert.equal(later.positions[0].include, true);
});

test("foreign costs stay in their currency when kept and do not become an INR fallback", () => {
  const holding = { kind: "fund", isin: "FUND", rta: null, rtaCode: null, name: "Fund", units: "20", price: "10", value: "200", cost: null };
  const holdings = { date: "2025-03-31", investor: "test", leftOut: [], sources: [
    { id: "folio|test", kind: "folio", label: "Folio", holdings: [holding] },
  ] };
  const existing = { ...none, date: holdings.date, cash: { USD: "30" }, positions: [{
    assetId: "fund", ref: ref("FUND"), symbol: "FUND", name: "Fund", units: "10", cost: "100", currency: "USD",
  }] };
  const [account] = plan(holdings, { existing: () => existing });
  const position = account.positions[0];
  assert.equal(position.cost, undefined);
  assert.match(position.notes[0], /existing cost is in USD.*total cost in INR/);
  assert.deepEqual(snapshotOf(account, noChoices), {
    holdings: [{ assetId: "fund", symbol: "FUND", quantity: "20", currency: "INR" }], cash: { USD: "30" },
  });
  assert.deepEqual(snapshotOf(account, { ...noChoices, flipped: new Set([position.key]) }).holdings, [
    { assetId: "fund", symbol: "FUND", quantity: "10", currency: "USD", averageCost: "10" },
  ]);
  const typed = snapshotOf(account, { ...noChoices, costs: new Map([[position.key, "400"]]) }).holdings[0];
  assert.equal(typed.currency, "INR");
  assert.equal(typed.averageCost, "20");
  const [printed] = plan({ ...holdings, sources: [{ ...holdings.sources[0], holdings: [{ ...holding, cost: "600" }] }] }, { existing: () => existing });
  assert.equal(snapshotOf(printed, noChoices).holdings[0].averageCost, "30");
});
