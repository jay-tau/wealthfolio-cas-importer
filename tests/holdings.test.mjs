import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dec, div, format } from "../src/cas/decimal.ts";
import {
  assetDetails,
  checkUnits,
  importedRefs,
  included,
  keepsDetails,
  npsSymbol,
  planSnapshots,
  pricesToSave,
  readHoldings,
  registrarSymbol,
  replacesSnapshot,
  snapshotOf,
  splitSince,
  statementAsset,
  unitStatus,
  validCost,
} from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";

const fixture = async (name) => JSON.parse(await readFile(`tests/fixtures/${name}.json`, "utf8"));

const asset = (h) => ({
  symbol: h.isin ?? h.rtaCode ?? h.code,
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
      details: { name: flexi.name, isin: "INFZ90K01FC8", registrar: "CAMS", schemeCode: "FFCDG" },
    });
    // The blank Cost Value cell.
    assert.equal(holdings.sources[2].holdings.find((h) => h.rtaCode === "TGLDG").cost, null);
    assert.deepEqual(holdings.leftOut, []);
  }
});

test("reads an NSDL statement's demat accounts, with their bonds, and folios", async () => {
  const holdings = readHoldings(await fixture("made-up-nsdl"));
  assert.equal(holdings.date, "2025-03-31");
  assert.equal(holdings.investor, "ABCDE1234F");
  assert.deepEqual(
    holdings.sources.map((s) => [s.id, s.kind, s.holdings.map((h) => h.kind).join(",")]),
    [
      ["demat|IN999901|90000001", "demat", "share,share,share,fund,bond,bond"],
      ["demat|99990001|90000002", "demat", "share,share,share,fund,fund,bond,bond"],
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
  assert.deepEqual(holdings.leftOut, []);
  // NSDL demat accounts print a bond's value, face value and coupon; CDSL ones its market price.
  const bonds = holdings.sources.flatMap((s) => s.holdings.filter((h) => h.kind === "bond"));
  assert.deepEqual(bonds.map((b) => [b.isin, b.units, b.price, b.value]), [
    ["INEZ91A07012", "50", "1000", "50000.00"],
    ["INEZ91B07028", "2", "100000", "200000.00"],
    ["INEZ92A07036", "25.000", "1012.40", "25310.00"],
    ["INEZ93A08016", "5.000", "101250.00", "506250.00"],
  ]);
  assert.deepEqual(bonds[0].details, {
    name: "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31", isin: "INEZ91A07012", couponRate: "8.10",
    couponFrequency: "Once a year", maturityDate: "15-Apr-2031", faceValue: "1000.00",
  });
  assert.deepEqual(bonds[2].details, { name: "MOCKSTEEL INDUSTRIES LIMITED 9.25 NCD 01MR27", isin: "INEZ92A07036" });
  assert.ok(bonds.every((b) => b.cost === null));
});

test("a bond's cost defaults to its face value times the number of bonds", async () => {
  const holdings = readHoldings(await fixture("made-up-nsdl"));
  const [account] = plan(holdings);
  const cost = (isin) => account.positions.find((p) => p.ref === ref(isin)).cost;
  assert.deepEqual(cost("INEZ91A07012"), { total: "50000", from: "face" });
  assert.deepEqual(cost("INEZ91B07028"), { total: "200000", from: "face" });
  // No face value printed: unknown.
  assert.equal(cost("INEZ92A07036"), undefined);
  // Wealthfolio's average cost comes first, and a typed cost replaces either.
  const [held] = plan(holdings, { existing: () => ({ ...none, positions: [{
    assetId: "ncd", ref: ref("INEZ91A07012"), symbol: "INEZ91A07012", name: "NCD", units: "40", cost: "38000", currency: "INR",
  }] }) });
  const position = held.positions.find((p) => p.ref === ref("INEZ91A07012"));
  assert.deepEqual(position.cost, { total: "47500", from: "wealthfolio" });
  assert.equal(snapshotOf(held, { ...noChoices, costs: new Map([[position.key, "49000"]]) }).holdings
    .find((h) => h.assetId === "ncd").averageCost, "980");
});

test("reads a CDSL statement and its NPS schemes, and leaves out holdings without units", async () => {
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
      ["nps|XXXXXXXX9001", 3],
    ],
  );
  assert.deepEqual(holdings.leftOut.map((l) => l.reason), ["No units on the statement."]);
  // Kept for the check against transactions, but not as a holding.
  assert.deepEqual(holdings.sources.map((s) => (s.zero ?? []).map((h) => [h.kind, h.isin, h.units])), [[["share", "INEZ91B20013", "0"]], [], [], [], []]);
  const nps = holdings.sources[4];
  assert.equal(nps.kind, "nps");
  assert.equal(nps.label, "NPS, PRAN XXXXXXXX9001");
  assert.deepEqual(nps.holdings.map((h) => [h.kind, h.code, h.units, h.price, h.value, h.cost]), [
    ["nps", "NPS-FICTIVA-E-TIER-I", "1234.5678", "58.1234", "71757.28", null],
    ["nps", "NPS-FICTIVA-G-TIER-I", "2345.6789", "29.8765", "70080.68", null],
    ["nps", "NPS-FICTIVA-E-TIER-II", "456.7891", "41.2345", "18835.47", null],
  ]);
  assert.deepEqual(nps.holdings[2].details, {
    scheme: "NPS TRUST- A/C FICTIVA PENSION FUND MANAGEMENT LIMITED SCHEME E - TIER II",
    fundManager: "FICTIVA PENSION FUND MANAGEMENT LIMITED", tier: "II", assetClass: "E",
  });
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
    account: (s) => (s.kind === "demat" ? "brokerage" : s.kind === "nps" ? "pension" : s.id === "folio|1040012345|INFZ91T" ? undefined : "funds"),
    existing: (id) => ({ ...none, date: id === "funds" ? "2026-03-31" : null }),
  });
  assert.deepEqual(
    plans.map((p) => [p.accountId, p.sources.map((s) => s.id), p.positions.length, replacesSnapshot(p)]),
    [
      ["brokerage", ["demat|19999901|00012345", "demat|IN999901|10012345"], 5, false],
      ["funds", ["folio|91234567/12|INFZ90K"], 2, true],
      ["pension", ["nps|XXXXXXXX9001"], 3, false],
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

test("manual-priced holdings get the statement's price, and kept ones the price they had", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const kept = {
    assetId: "manual", ref: ref("MANUAL"), symbol: "MANUAL", name: "Manual asset", units: "10", cost: "100", currency: "USD",
    manual: true, price: { close: "12.5", currency: "USD" },
  };
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  const listed = { assetId: "gold", ref: ref(gold.isin), symbol: gold.isin, name: "Gold", units: "800", cost: "40000", currency: "INR", manual: true };
  const unpriced = { assetId: "unpriced", ref: ref("UNPRICED"), symbol: "UNPRICED", name: "Unpriced", units: "1", cost: "5", currency: "INR", manual: true };
  const [account] = plan(holdings, { existing: () => ({ ...none, positions: [kept, listed, unpriced] }) });
  // Saving no longer refuses: the prices are written after it.
  assert.ok(snapshotOf(account, noChoices).holdings.some((h) => h.assetId === "manual" && h.averageCost === "10"));
  assert.deepEqual(pricesToSave(account, noChoices), [
    { ref: ref(gold.isin), assetId: "gold", name: "Gold", price: gold.price, currency: "INR", from: "statement" },
    { ref: ref("MANUAL"), assetId: "manual", name: "Manual asset", price: "12.5", currency: "USD", from: "earlier" },
  ]);
  assert.match(account.positions.find((p) => p.ref === ref("UNPRICED")).notes[0], /no price on or before this date.*average cost as its price/);
  // Removed or left out of the statement's side: nothing to price, or the price it had.
  const removed = { flipped: new Set([ref("MANUAL"), ref(gold.isin)]), costs: new Map() };
  assert.deepEqual(pricesToSave(account, removed), []);
  const goldPriced = { ...listed, price: { close: "49", currency: "INR" } };
  const [leftOut] = plan(holdings, { existing: () => ({ ...none, positions: [goldPriced] }) });
  assert.deepEqual(pricesToSave(leftOut, { ...noChoices, flipped: new Set([ref(gold.isin)]) }).map((p) => [p.assetId, p.price, p.from]), [["gold", "49", "earlier"]]);
  // Another account's import lists it on the same date: its statement price, with or without an earlier one.
  const listedElsewhere = new Map([[ref("MANUAL"), "13"], [ref("UNPRICED"), "6"]]);
  assert.deepEqual(pricesToSave(account, noChoices, listedElsewhere).map((p) => [p.assetId, p.price, p.currency, p.from]), [
    ["gold", gold.price, "INR", "statement"], ["manual", "13", "INR", "statement"], ["unpriced", "6", "INR", "statement"],
  ]);
  // The warning stays accurate even if another account's row is later left out.
  const twoAccounts = (lists) => plan(holdings, {
    account: (s) => (s.id === holdings.sources[2].id ? lists : "keeps"),
    existing: (id) => (id === "keeps" ? { ...none, positions: [{ ...unpriced, ref: ref(gold.isin), symbol: gold.isin }] } : none),
  }).find((p) => p.accountId === "keeps");
  assert.match(twoAccounts("lists").positions.find((p) => p.ref === ref(gold.isin)).notes[0], /If no included holding supplies the statement's price/);
  assert.match(twoAccounts(undefined).positions.find((p) => p.ref === ref(gold.isin)).notes[0], /no price on or before this date/);
  // Market-priced holdings get none.
  const [market] = plan(holdings, { existing: () => ({ ...none, positions: [{ ...kept, manual: false }] }) });
  assert.deepEqual(pricesToSave(market, noChoices), []);
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
      data.accounts[0].bonds = [];
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
  // One price for the asset, from the statement, however many rows list it.
  assert.deepEqual(pricesToSave(manual, noChoices).map((p) => [p.assetId, p.price, p.from]), [["manual", "2", "statement"]]);
  assert.equal(snapshotOf(manual, noChoices).holdings.length, 1);
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

test("new manual-priced assets get the statement's price; ones priced from statements are created manual", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const [account] = plan(holdings, { asset: (h) => ({ ...asset(h), manual: true }) });
  assert.equal(account.positions[0].existing, undefined);
  const prices = pricesToSave(account, noChoices);
  assert.equal(prices.length, 6);
  assert.ok(prices.every((p) => p.assetId === undefined && p.from === "statement"));
  // Found by search: Wealthfolio keeps its pricing mode.
  assert.ok(snapshotOf(account, noChoices).holdings.every((h) => h.dataSource === undefined));
  const [fromStatements] = plan(holdings, { asset: (h) => ({ ...asset(h), manual: true, statementPrices: true }) });
  assert.ok(snapshotOf(fromStatements, noChoices).holdings.every((h) => h.dataSource === "MANUAL"));
  // Wealthfolio prices it from market data now: it stays so, and gets no statement price.
  const [market] = plan(holdings, { asset: (h) => ({ ...asset(h), manual: false, statementPrices: true }) });
  assert.ok(snapshotOf(market, noChoices).holdings.every((h) => h.dataSource === undefined));
  assert.deepEqual(pricesToSave(market, noChoices), []);
});

test("bonds and NPS schemes priced from statements keep their identity and printed details", async () => {
  const nsdl = readHoldings(await fixture("made-up-nsdl"));
  const cdsl = readHoldings(await fixture("made-up-cdsl"));
  const fromStatements = (h) => ({
    symbol: h.isin ?? h.code, quoteCcy: "INR", instrumentType: h.kind === "bond" ? "BOND" : "EQUITY", name: h.name, manual: true, statementPrices: true,
  });
  for (const holdings of [nsdl, cdsl]) {
    const bondOrNps = (h) => h.kind === "bond" || h.kind === "nps";
    const sources = holdings.sources.filter((s) => s.holdings.some(bondOrNps));
    const [account] = plan({ ...holdings, sources }, { asset: (h) => (bondOrNps(h) ? fromStatements(h) : undefined) });
    const saved = snapshotOf(account, noChoices).holdings;
    const priced = new Map(pricesToSave(account, noChoices).map((p) => [p.ref, p.price]));
    for (const h of sources.flatMap((s) => s.holdings.filter(bondOrNps))) {
      const symbol = h.isin ?? h.code;
      const row = saved.find((s) => s.symbol === symbol);
      assert.equal(row.dataSource, "MANUAL", symbol);
      assert.equal(row.exchangeMic, undefined, symbol);
      assert.equal(priced.get(fundRef(symbol)), h.price, symbol);
    }
    // What an import remembers finds them again on the next statement.
    for (const { refs } of importedRefs(account, noChoices)) {
      for (const ids of Object.values(refs)) assert.ok(ids.every((id) => /^(INE|nps\|NPS-)/.test(id)), ids.join());
    }
  }
});

test("funds and shares the search can't find can be priced from statements", async () => {
  const summary = readHoldings(await fixture("made-up-summary-cams"));
  const nsdl = readHoldings(await fixture("made-up-nsdl"));
  const cdsl = readHoldings(await fixture("made-up-cdsl"));
  const [fund] = summary.sources[0].holdings;
  const [share, dematFund, bond] = ["share", "fund", "bond"].map((kind) => nsdl.sources[0].holdings.find((h) => h.kind === kind));
  const scheme = cdsl.sources.find((s) => s.kind === "nps").holdings[0];
  const byHand = { quoteCcy: "INR", manual: true, statementPrices: true };
  assert.deepEqual(statementAsset(fund), { symbol: fund.isin, instrumentType: "MUTUALFUND", name: fund.name, ...byHand });
  assert.deepEqual(statementAsset(dematFund), { symbol: dematFund.isin, instrumentType: "MUTUALFUND", name: dematFund.name, ...byHand });
  assert.deepEqual(statementAsset(share), { symbol: share.isin, instrumentType: "EQUITY", name: share.name, ...byHand });
  assert.deepEqual(statementAsset(bond), { symbol: bond.isin, instrumentType: "BOND", name: bond.name, ...byHand });
  assert.deepEqual(statementAsset(scheme), { symbol: scheme.code, instrumentType: "EQUITY", name: scheme.name, ...byHand });
  // Without an ISIN, a summary statement's fund goes by its registrar and scheme code.
  const noIsin = { ...fund, isin: null, details: { name: fund.name, registrar: "CAMS", schemeCode: "FFCDG" } };
  assert.equal(statementAsset(noIsin).symbol, "MF-CAMS-FFCDG");
  assert.equal(registrarSymbol("KFinTech", " 120 mg/pg "), "MF-KFINTECH-120-MG-PG");
  for (const [rta, code] of [["CAMS", ""], ["CAMS", " / "], ["", "FFCDG"], [null, null]]) {
    assert.equal(registrarSymbol(rta, code), undefined);
    assert.equal(statementAsset({ ...noIsin, rta, rtaCode: code }), undefined);
  }

  // Saved as new INR assets priced by hand, then the printed price, not the average cost, on the statement's date.
  const funds = { ...summary, sources: [{ ...summary.sources[0], holdings: [fund, noIsin] }] };
  const [account] = plan(funds, { asset: statementAsset });
  const saved = snapshotOf(account, noChoices).holdings;
  assert.deepEqual(saved.map((h) => [h.symbol, h.exchangeMic, h.quoteCcy, h.instrumentType, h.dataSource, h.quantity]), [
    [fund.isin, undefined, "INR", "MUTUALFUND", "MANUAL", "2892.104"],
    ["MF-CAMS-FFCDG", undefined, "INR", "MUTUALFUND", "MANUAL", "2892.104"],
  ]);
  assert.equal(format(div(dec("154554"), dec("2892.104"), 20)), saved[0].averageCost);
  assert.notEqual(Number(saved[0].averageCost), Number(fund.price));
  assert.deepEqual(pricesToSave(account, noChoices).map((p) => [p.ref, p.price, p.from]), [
    [fundRef(fund.isin), "74.3120", "statement"], [fundRef("MF-CAMS-FFCDG"), "74.3120", "statement"],
  ]);
  // Its identifiers are remembered, so the next statement finds what this import added.
  assert.deepEqual(importedRefs(account, noChoices)[0].refs, { [fundRef(fund.isin)]: [fund.isin, "CAMS|FFCDG"], [fundRef("MF-CAMS-FFCDG")]: ["CAMS|FFCDG"] });
  // The printed name and identifiers go on the asset; a fund or share found by search keeps its own.
  assert.ok(account.positions.every(keepsDetails));
  assert.deepEqual(assetDetails(noIsin, { other: 1 }, "EQUITY"), { other: 1, casStatement: noIsin.details });
  const [market] = plan(funds);
  assert.ok(!market.positions.some(keepsDetails));
  const [shares] = plan({ ...nsdl, sources: [nsdl.sources[0]] });
  assert.deepEqual(shares.positions.filter(keepsDetails).map((p) => p.lines[0].holding.kind), ["bond", "bond"]);
  const [byStatement] = plan({ ...nsdl, sources: [nsdl.sources[0]] }, { asset: statementAsset });
  assert.ok(byStatement.positions.every(keepsDetails));

  // A later statement reuses the asset the account holds, and gives it that statement's price.
  const later = { ...funds, date: "2025-04-30", sources: [{ ...funds.sources[0], holdings: [{ ...fund, price: "80" }] }] };
  const [again] = plan(later, {
    asset: (h) => ({ ...statementAsset(h), assetId: "fund-001" }),
    existing: () => ({ ...none, date: "2025-03-31", positions: [{
      assetId: "fund-001", ref: fundRef(fund.isin), symbol: fund.isin, name: fund.name, units: "2892.104", cost: "154554", currency: "INR", manual: true,
    }] }),
  });
  assert.deepEqual(snapshotOf(again, noChoices).holdings.map((h) => [h.assetId, h.dataSource]), [["fund-001", undefined]]);
  assert.deepEqual(pricesToSave(again, noChoices).map((p) => [p.assetId, p.price]), [["fund-001", "80"]]);
});

test("npsSymbol builds one symbol per scheme from its printed name", () => {
  assert.equal(npsSymbol("NPS TRUST- A/C SBI PENSION FUNDS PRIVATE LIMITED SCHEME E - TIER I"), "NPS-SBI-E-TIER-I");
  assert.equal(npsSymbol("NPS TRUST A/C - SBI PENSION FUNDS PVT. LTD. SCHEME E - TIER 1"), "NPS-SBI-E-TIER-I");
  assert.equal(npsSymbol("NPS TRUST - A/C HDFC PENSION FUND MANAGEMENT LIMITED SCHEME C - TIER II"), "NPS-HDFC-C-TIER-II");
  assert.equal(npsSymbol("NPS TRUST- A/C ICICI PRUDENTIAL PENSION FUNDS MANAGEMENT COMPANY LIMITED SCHEME A - TIER I"), "NPS-ICICI-PRUDENTIAL-A-TIER-I");
  assert.equal(npsSymbol("NPS TRUST - A/C SBI PENSION FUNDS PRIVATE LIMITED - CENTRAL GOVT"), "NPS-SBI-CENTRAL-GOVT");
});

test("an NPS account without a printed PRAN is the investor's, and keeps its holdings", async () => {
  for (const pran of [null, "", "  "]) {
    const data = await fixture("made-up-cdsl");
    data.nps.pran = pran;
    const holdings = readHoldings(data);
    const nps = holdings.sources.filter((s) => s.kind === "nps");
    assert.deepEqual(nps.map((s) => [s.id, s.label, s.holdings.length]), [["nps|investor:ABCDE1234F", "National Pension System", 3]]);
    assert.deepEqual(holdings.leftOut.map((l) => l.reason), ["No units on the statement."]);
    // Another investor's PRAN-less account is a different source.
    data.accounts.forEach((a) => a.owners.forEach((o) => { o.PAN = "ZZZZZ9999Z"; }));
    assert.equal(readHoldings(data).sources.find((s) => s.kind === "nps").id, "nps|investor:ZZZZZ9999Z");
  }
});

test("a zero-unit bond is left out without dividing its value by zero", async () => {
  const data = await fixture("made-up-nsdl");
  const bond = data.accounts[0].bonds[0];
  bond.num_bonds = "0";
  const holdings = readHoldings(data);
  assert.ok(!holdings.sources.flatMap((s) => s.holdings).some((h) => h.isin === bond.isin));
  assert.ok(holdings.leftOut.some((l) => l.name === bond.name && l.reason === "No units on the statement."));
});

test("PRANs share scheme assets while each keeps its own source and account", async () => {
  const holdings = readHoldings(await fixture("made-up-cdsl"));
  const nps = holdings.sources.find((s) => s.kind === "nps");
  const other = { ...nps, id: "nps|XXXXXXXX9002", label: "NPS, PRAN XXXXXXXX9002" };
  const both = { ...holdings, sources: [nps, other] };
  const [combined] = plan(both);
  assert.equal(combined.positions.length, 3);
  assert.equal(combined.positions[0].units, "2469.1356");
  const separate = plan(both, { account: (s) => s.id });
  assert.equal(separate.length, 2);
  assert.deepEqual(separate[0].positions.map((p) => p.ref), separate[1].positions.map((p) => p.ref));
  assert.deepEqual(importedRefs(combined, noChoices).map((s) => s.source.id), [nps.id, other.id]);
});

test("a resolved asset ID reconciles a custom display code and supplies price IDs", () => {
  const holding = { kind: "bond", isin: "INEZ91A07012", rta: null, rtaCode: null, name: "Made-up bond", units: "2", price: "1100", value: "2200", cost: null };
  const source = { id: "demat|test", kind: "demat", label: "Demat", holdings: [holding] };
  const chosen = { symbol: holding.isin, quoteCcy: "INR", name: holding.name, instrumentType: "BOND", assetId: "opaque-id", manual: true, statementPrices: true };
  const before = { assetId: "opaque-id", ref: fundRef("My bond"), symbol: "My bond", name: "Custom name", units: "1", cost: "900", currency: "INR", manual: true, price: { close: "1050", currency: "INR" } };
  const [account] = plan({ date: "2026-03-31", investor: "test", sources: [source], leftOut: [] }, {
    asset: () => chosen,
    existing: () => ({ ...none, positions: [before] }),
  });
  assert.equal(account.positions.length, 1);
  const saved = snapshotOf(account, noChoices).holdings;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].assetId, "opaque-id");
  assert.equal(saved[0].quantity, "2");
  assert.equal(saved[0].dataSource, undefined);
  assert.deepEqual(pricesToSave(account, noChoices).map((p) => [p.assetId, p.price]), [["opaque-id", "1100"]]);
  // Resolved assets can be new to the target account without being new to Wealthfolio.
  const [empty] = plan({ date: "2026-03-31", investor: "test", sources: [source], leftOut: [] }, { asset: () => chosen });
  assert.equal(snapshotOf(empty, noChoices).holdings[0].assetId, "opaque-id");
  assert.equal(snapshotOf(empty, noChoices).holdings[0].dataSource, undefined);
  assert.equal(pricesToSave(empty, noChoices)[0].assetId, "opaque-id");
});

test("assetDetails adds printed details without overwriting Wealthfolio's or the user's", async () => {
  const nsdl = readHoldings(await fixture("made-up-nsdl"));
  const [face, onMaturity, market] = ["INEZ91A07012", "INEZ91B07028", "INEZ92A07036"].map((isin) =>
    nsdl.sources.flatMap((s) => s.holdings).find((h) => h.isin === isin));
  assert.deepEqual(assetDetails(face, undefined, "BOND"), {
    casStatement: face.details,
    bond: { isin: "INEZ91A07012", maturityDate: "2031-04-15", couponRate: 0.081, couponFrequency: "ANNUAL", faceValue: 1000 },
  });
  // "On Maturity" isn't a frequency Wealthfolio's pricer knows: printed details only.
  assert.equal(assetDetails(onMaturity, undefined, "BOND").bond.couponFrequency, undefined);
  assert.equal(assetDetails(onMaturity, undefined, "BOND").casStatement.couponFrequency, "On Maturity");
  for (const [couponFrequency, expected] of [
    ["Bi-Annual", "SEMI_ANNUAL"], ["Biannual", "SEMI_ANNUAL"], ["Semi Annually", "SEMI_ANNUAL"],
    ["Quarterly", "QUARTERLY"], ["Annual", "ANNUAL"], ["Monthly", undefined], ["Annual on maturity", undefined],
  ]) {
    const details = assetDetails({ ...face, details: { ...face.details, couponFrequency } }, undefined, "BOND");
    assert.equal(details.bond.couponFrequency, expected);
    assert.equal(details.casStatement.couponFrequency, couponFrequency);
  }
  for (const maturityDate of ["31-Feb-2031", "00-Apr-2031", "32-Apr-2031", "not printed clearly"]) {
    const details = assetDetails({ ...face, details: { ...face.details, maturityDate } }, undefined, "BOND");
    assert.equal(details.bond.maturityDate, undefined);
    assert.equal(details.casStatement.maturityDate, maturityDate);
    assert.equal(details.bond.faceValue, 1000);
  }
  // Wealthfolio's nulls are filled; its values, the user's edits and other keys stay.
  const before = { contractMultiplier: 0.01, bond: { isin: "INEZ91A07012", couponRate: 0.08, maturityDate: null, faceValue: null } };
  assert.deepEqual(assetDetails(face, before, "BOND"), {
    contractMultiplier: 0.01,
    bond: { isin: "INEZ91A07012", couponRate: 0.08, maturityDate: "2031-04-15", faceValue: 1000, couponFrequency: "ANNUAL" },
    casStatement: face.details,
  });
  // Nothing new: no write.
  assert.equal(assetDetails(face, assetDetails(face, before, "BOND"), "BOND"), undefined);
  // An asset found by search that isn't a bond keeps only the printed details.
  assert.deepEqual(assetDetails(market, { other: 1 }, "EQUITY"), { other: 1, casStatement: market.details });
  // A later statement adds to the printed details, and keeps what an earlier one printed.
  const kept = assetDetails({ ...face, details: { isin: face.isin, name: "RENAMED" } }, assetDetails(face, undefined, "BOND"), "BOND");
  assert.deepEqual(kept.casStatement, { ...face.details, name: "RENAMED" });
  const cdsl = readHoldings(await fixture("made-up-cdsl"));
  const scheme = cdsl.sources.find((s) => s.kind === "nps").holdings[0];
  assert.deepEqual(assetDetails(scheme, null, "EQUITY"), { casStatement: scheme.details });
  // A share's or fund's details are its printed name and identifiers.
  const share = nsdl.sources[0].holdings[0];
  assert.deepEqual(assetDetails(share, undefined, "EQUITY"), { casStatement: { name: share.name, isin: share.isin } });
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

test("signed existing costs and average costs survive, and keep a manual price", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const short = { assetId: "short", ref: ref("SHORT"), symbol: "SHORT", name: "Short", units: "-10", cost: "-1000", currency: "INR" };
  const existing = { ...none, positions: [short] };
  const [account] = plan(holdings, { existing: () => existing });
  assert.deepEqual(snapshotOf(account, noChoices).holdings.find((h) => h.assetId === "short"), {
    assetId: "short", symbol: "SHORT", quantity: "-10", currency: "INR", averageCost: "100",
  });
  short.manual = true;
  short.price = { close: "100", currency: "INR" };
  assert.deepEqual(pricesToSave(account, noChoices).map((p) => [p.assetId, p.price, p.from]), [["short", "100", "earlier"]]);
  const gold = holdings.sources[2].holdings.find((h) => h.cost === null);
  existing.positions[0] = { ...short, ref: ref(gold.isin), symbol: gold.isin, units: "-800", cost: "-40000" };
  const [matched] = plan(holdings, { existing: () => existing });
  const position = matched.positions.find((p) => p.ref === ref(gold.isin));
  assert.deepEqual(position.cost, { total: "42275.6", from: "wealthfolio" });
  assert.deepEqual(pricesToSave(matched, noChoices).map((p) => [p.assetId, p.price, p.from]), [["short", gold.price, "statement"]]);
  existing.positions[0].cost = "40000";
  const [negativeAverage] = plan(holdings, { existing: () => existing });
  assert.equal(snapshotOf(negativeAverage, noChoices).holdings.find((h) => h.assetId === "short").quantity, "845.512");
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

let activityId = 0;
/** A Wealthfolio activity for a fund on XBOM, as `activities.getAll` returns it. */
const activity = (accountId, activityType, date, isin, quantity, more = {}) => ({
  id: `activity-${++activityId}`, accountId, activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`,
  quantity, unitPrice: "10", amount: null, fee: null, currency: "INR", needsReview: false, assetId: `asset-${isin}`,
  assetSymbol: isin, exchangeMic: "XBOM", ...more,
});
const transactionAccounts = [{ id: "account-1", name: "Mutual funds" }, { id: "unset-1", name: "Not set" }];
/** Each activity's asset as its profile has it: by default, its display code is its symbol. */
const identitiesOf = (activities) => new Map(Array.isArray(activities) ? activities.map((a) => [a.assetId, fundRef(a.assetSymbol, a.exchangeMic)]) : []);
const check = (holdings, activities, more = {}) =>
  checkUnits(holdings, { asset, accounts: transactionAccounts, activities, identities: identitiesOf(activities), ...more });
const summarised = (checks) => checks.map((c) => [
  c.ref, c.lines.map((l) => l.source.label), format(c.statement),
  c.accounts.map((a) => [a.id, a.units === undefined ? null : format(a.units)]),
  c.held === undefined ? null : format(c.held), c.problem ?? null,
]);

test("checks each holding's units against accounts that track transactions, each asset and account once", async () => {
  const data = await fixture("made-up-summary-cams");
  const [first] = data.folios;
  // A second folio in the same account: one more Flexi Cap line, and the Liquid fund printed with zero units.
  data.folios.push({ ...first, folio: "91234568 / 34", schemes: [{ ...first.schemes[0], close: "107.896" }, { ...first.schemes[1], close: "0.000" }] });
  const holdings = readHoldings(data);
  const activities = [
    activity("account-1", "BUY", "2024-04-01", "INFZ90K01FC8", "2500"),
    activity("account-1", "BUY", "2024-06-01", "INFZ90K01FC8", "600"),
    // On the statement's date counts; the day after doesn't.
    activity("account-1", "SELL", "2025-03-31", "INFZ90K01FC8", "100"),
    activity("account-1", "BUY", "2025-04-01", "INFZ90K01FC8", "50"),
    activity("account-1", "BUY", "2024-04-01", "INFZ90K01LQ6", "12.296"),
    // A fund in two accounts, one of them NOT_SET.
    activity("account-1", "BUY", "2024-04-01", "INFZ90K01BA1", "3000"),
    activity("unset-1", "TRANSFER_IN", "2024-05-01", "INFZ90K01BA1", "443.91"),
    activity("account-1", "BUY", "2024-04-01", "INFZ91T01CB6", "9500"),
    // An account that tracks holdings, and an activity that isn't posted, don't count.
    activity("holdings-1", "BUY", "2024-04-01", "INFZ91T01CB6", "11.474"),
    activity("account-1", "BUY", "2024-04-02", "INFZ91T01CB6", "11.474", { status: "DRAFT" }),
    // Bought only after the statement's date.
    activity("account-1", "BUY", "2025-04-02", "INFZ91T01GL6", "845.512"),
    activity("account-1", "BUY", "2024-04-01", "INFZ91T01FT1", "2500"),
    activity("account-1", "SPLIT", "2025-01-01", "INFZ91T01FT1", null, { amount: "2" }),
  ];
  const checks = check(holdings, activities);
  const fictiva = "Fictiva Mutual Fund, folio 91234567 / 12";
  const second = "Fictiva Mutual Fund, folio 91234568 / 34";
  const testbridge = "Testbridge Mutual Fund, folio 1040012345";
  assert.deepEqual(summarised(checks), [
    ["asset-INFZ90K01FC8", [fictiva, second], "3000", [["account-1", "3000"]], "3000", null],
    ["asset-INFZ90K01LQ6", [fictiva, second], "12.296", [["account-1", "12.296"]], "12.296", null],
    ["asset-INFZ90K01BA1", ["Fictiva Mutual Fund, folio 91234570/0"], "3443.91", [["account-1", "3000"], ["unset-1", "443.91"]], "3443.91", null],
    ["asset-INFZ91T01CB6", [testbridge], "9511.474", [["account-1", "9500"]], "9500", null],
    [ref("INFZ91T01GL6"), [testbridge], "845.512", [], null, "No account that tracks transactions has posted activities for it on or before 2025-03-31."],
    ["asset-INFZ91T01FT1", [testbridge], "5000", [["account-1", null]], null, "A split or option expiry in Mutual funds needs Wealthfolio's portfolio engine to count its units."],
  ]);
  // Until the user confirms the accounts compared hold the same units, every row needs review.
  assert.deepEqual(checks.map((c) => unitStatus(c, true)), ["match", "match", "match", "differ", "review", "review"]);
  assert.deepEqual(checks.map((c) => unitStatus(c, false)), ["review", "review", "review", "review", "review", "review"]);
  // The printed zero stays out of the snapshot.
  const [snapshot] = plan(holdings);
  assert.deepEqual(snapshot.positions.find((p) => p.ref === ref("INFZ90K01LQ6")).lines.map((l) => [l.source.label, l.holding.units]), [[fictiva, "12.296"]]);
});

test("a depository statement's printed zero and an asset in two demat accounts are checked", async () => {
  const cdsl = readHoldings(await fixture("made-up-cdsl"));
  const sold = [
    activity("account-1", "BUY", "2025-01-10", "INEZ91B20013", "10"),
    activity("account-1", "SELL", "2026-02-10", "INEZ91B20013", "10"),
  ];
  const [zero] = check(cdsl, sold).filter((c) => c.ref === "asset-INEZ91B20013");
  assert.deepEqual(summarised([zero]), [["asset-INEZ91B20013", ["CDSL Demat Account 1, FICTIVA SECURITIES LIMITED"], "0", [["account-1", "0"]], "0", null]]);
  assert.equal(unitStatus(zero, true), "match");
  const stillHeld = check(cdsl, sold.slice(0, 1)).find((c) => c.ref === "asset-INEZ91B20013");
  assert.equal(unitStatus(stillHeld, true), "differ");
  // A printed zero is confirmed and checked, but never planned into a snapshot.
  assert.equal(plan(cdsl)[0].positions.some((p) => p.ref === ref("INEZ91B20013")), false);
  // Left out without a confirmed asset, it isn't checked.
  assert.equal(check(cdsl, sold, { asset: (h) => (h.isin === "INEZ91B20013" ? undefined : asset(h)) }).some((c) => c.ref === "asset-INEZ91B20013"), false);

  const nsdl = readHoldings(await fixture("made-up-nsdl"));
  const shares = check(nsdl, [activity("unset-1", "BUY", "2024-01-01", "INEZ90B01015", "520")]);
  const twice = shares.find((c) => c.ref === "asset-INEZ90B01015");
  assert.deepEqual(twice.lines.map((l) => [l.source.label.replace(/,.*/, ""), l.holding.units]), [["NSDL Demat Account 1", "420"], ["CDSL Demat Account 2", "100.000"]]);
  assert.equal(unitStatus(twice, true), "match");
  // Holdings nobody bought in an account that tracks transactions need review, not a zero.
  assert.ok(shares.filter((c) => c !== twice).every((c) => c.held === undefined && unitStatus(c, true) === "review"));

  const unread = check(nsdl, { error: "Error: offline" });
  assert.equal(unread.length, shares.length);
  assert.ok(unread.every((c) => c.problem === "Couldn't read Wealthfolio's activities: Error: offline" && unitStatus(c, true) === "review"));
});

test("the check finds a holding's asset by its ID, or by the symbol and exchange on its Wealthfolio profile", async () => {
  const data = await fixture("made-up-summary-cams");
  const [first] = data.folios;
  // The same fund in a second folio, printed without its ISIN and confirmed without an asset ID.
  data.folios = [{ ...first, schemes: [{ ...first.schemes[0], close: "10" }] }, { ...first, folio: "91234568 / 34", schemes: [{ ...first.schemes[0], isin: null, close: "20" }] }];
  const holdings = readHoldings(data);
  const isin = first.schemes[0].isin;
  const confirmed = (h, more = {}) => ({ ...asset(h), symbol: isin, ...more });
  // Its display code was changed, so its activities don't show its symbol.
  const renamed = [activity("account-1", "BUY", "2024-04-01", "MY-FUND", "30", { assetId: "fund-1" })];
  const both = (h) => confirmed(h, holdings.sources[0].holdings.includes(h) ? { assetId: "fund-1" } : {});
  assert.deepEqual(summarised(check(holdings, renamed, { asset: both, identities: new Map([["fund-1", ref(isin)]]) })), [
    ["fund-1", [first.amc + ", folio 91234567 / 12", first.amc + ", folio 91234568 / 34"], "30", [["account-1", "30"]], "30", null],
  ]);
  assert.equal(format(check(holdings, renamed, { asset: confirmed, identities: new Map([["fund-1", ref(isin)]]) })[0].held), "30");
  // Another asset whose display code is this fund's symbol supplies no history.
  const other = [activity("account-1", "BUY", "2024-04-01", isin, "30", { assetId: "other" })];
  const [notIt] = check(holdings, other, { asset: confirmed, identities: new Map([["other", ref("SOMETHING-ELSE")]]) });
  assert.deepEqual([notIt.ref, notIt.held, notIt.problem], [ref(isin), undefined, "No account that tracks transactions has posted activities for it on or before 2025-03-31."]);
  // Nor does it for a choice that has the asset's ID.
  assert.equal(check(holdings, other, { asset: (h) => confirmed(h, { assetId: "fund-1" }) })[0].held, undefined);
  // Two assets with its symbol and exchange, or one whose profile can't be read, need review.
  const two = [...renamed, activity("unset-1", "BUY", "2024-04-01", isin, "1", { assetId: "fund-2" })];
  const [ambiguous] = check(holdings, two, { asset: confirmed, identities: new Map([["fund-1", ref(isin)], ["fund-2", ref(isin)]]) });
  assert.deepEqual([ambiguous.held, ambiguous.problem], [undefined, "Several Wealthfolio assets have its symbol and exchange. Choose the existing asset for it under Holdings."]);
  const [unread] = check(holdings, other, { asset: confirmed, identities: new Map([["other", { error: "Error: gone" }]]) });
  assert.equal(unread.problem, "Couldn't read a Wealthfolio asset's profile: Error: gone");
  // An unreadable profile can hide another matching asset even when its display code was changed.
  const partial = [...renamed, { ...other[0], assetSymbol: "RENAMED" }];
  const identities = new Map([["fund-1", ref(isin)], ["other", { error: "Error: gone" }]]);
  const [unreadRenamed] = check(holdings, partial, { asset: confirmed, identities });
  assert.deepEqual([unreadRenamed.held, unreadRenamed.problem], [undefined, unread.problem]);
  assert.ok([ambiguous, unread, unreadRenamed].every((c) => unitStatus(c, true) === "review"));
  // An explicit ID establishes the asset without reading any profiles.
  const [byId] = check(holdings, partial, { asset: (h) => confirmed(h, { assetId: "fund-1" }), identities });
  assert.equal(unitStatus(byId, true), "match");
});

test("distinct assets with the same symbol and exchange are checked separately", async () => {
  const holdings = readHoldings(await fixture("made-up-cdsl"));
  const source = holdings.sources[0];
  const [share, other] = source.holdings;
  holdings.sources = [{ ...source, holdings: [{ ...share, units: "10" }, { ...other, kind: "bond", units: "20" }], zero: [] }];
  const checks = check(holdings, [
    activity("account-1", "BUY", "2025-01-01", "SAME", "10", { assetId: share.isin }),
    activity("unset-1", "BUY", "2025-01-01", "SAME", "19", { assetId: other.isin }),
  ], { asset: (h) => ({ ...asset(h), symbol: "SAME", assetId: h.isin }) });
  assert.deepEqual(checks.map((c) => [c.ref, format(c.statement), format(c.held), unitStatus(c, true)]), [
    [share.isin, "10", "10", "match"],
    [other.isin, "20", "19", "differ"],
  ]);
});
