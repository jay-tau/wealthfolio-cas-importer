import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dec, div, format, mul } from "../src/cas/decimal.ts";
import {
  assetDetails,
  assetName,
  assetNames,
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
  undecided,
  unitStatus,
  validCost,
} from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";
import { fundName } from "../src/lib/fund-name.ts";

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
/** A summary statement's scheme with other units, and the value they're worth at its NAV. */
const worth = (scheme, close) =>
  ({ ...scheme, close, valuation: { ...scheme.valuation, value: format(div(mul(dec(close), dec(scheme.valuation.nav)), dec("1"), 2)) } });
const none = { date: null, positions: [], cash: {}, later: [] };
const noChoices = { flipped: new Set(), costs: new Map() };

/** Runs `run` on a device far east of UTC, then on one far west. */
const inLocalTimeZones = (run) => {
  const saved = process.env.TZ;
  try {
    for (const local of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      process.env.TZ = local;
      run();
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
};

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
      data.folios[0].schemes = data.folios[0].schemes.map((s) => worth(s, "0"));
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

// A fund in a folio, confirmed to Yahoo's result on the first import and to AMFI's on the next.
const FOLIO = "Fictiva Mutual Fund, folio 91234567 / 12";
const flexi = (units, more = {}) => ({
  kind: "fund", isin: "INFZ90K01FC8", rta: "CAMS", rtaCode: "FFCDG", name: "Fictiva Flexi Cap Fund - Direct Plan - Growth",
  units, price: "70", value: format(mul(dec(units), dec("70"))), cost: null, ...more,
});
const folioOf = (number, ...holdings) => ({ id: `folio|${number}|amc:Fictiva Mutual Fund`, kind: "folio", label: `Fictiva Mutual Fund, folio ${number}`, holdings });
const statementOf = (date, ...sources) => ({ date, investor: "x", leftOut: [], sources });
const yahoo = { symbol: "0P0000FFCD.BO", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fictiva Flexi Cap" };
const amfi = { symbol: "119551", quoteCcy: "INR", instrumentType: "MUTUALFUND", providerId: "AMFI", name: "Fictiva Flexi Cap" };
const YAHOO = "Fictiva Flexi Cap (0P0000FFCD.BO · XBOM)";
const AMFI = "Fictiva Flexi Cap (119551)";
/** What each source's import recorded: source ID → `fundRef` → identifiers. */
const recordsOf = (account, choices = noChoices) =>
  new Map(importedRefs(account, choices).map(({ source, refs }) => [source.id, new Map(Object.entries(refs))]));
const heldBefore = (asset, units, more = {}) => ({
  date: "2025-03-31", later: [], cash: {},
  positions: [{ assetId: "yahoo-asset", symbol: asset.symbol, ref: fundRef(asset.symbol, asset.exchangeMic), name: asset.name, units, cost: "5000", currency: "INR", ...more }],
});
/** Mutual funds tracks transactions and holds AMFI's asset. */
const tracking = (r) => (r === fundRef("119551") ? [{ name: "Mutual funds", tracksTransactions: true }] : []);
const savedOf = (account, choices = noChoices) => snapshotOf(account, choices).holdings.map((h) => [h.assetId ?? h.symbol, h.quantity]);
const replacing = (key) => ({ flipped: new Set([key]), costs: new Map() });
/** The user's choice to keep (true) or remove (false) the account's units of a row. */
const keeping = (key, keep, flipped = []) => ({ flipped: new Set(flipped), costs: new Map(), keep: new Map([[key, keep]]) });

test("a fund confirmed to another asset keeps the one an earlier import of its folio added, until the user replaces it", () => {
  const [first] = plan(statementOf("2025-03-31", folioOf("91234567 / 12", flexi("100"))), { asset: () => yahoo });
  const records = recordsOf(first);
  const [next] = plan(statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110"))), {
    asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id),
  });
  const [listed, old] = next.positions;
  assert.equal(listed.ref, fundRef("119551"));
  assert.equal(old.existing.assetId, "yahoo-asset");
  // Left out by default: the account keeps the old asset's 100 units and doesn't add the statement's 110.
  assert.equal(listed.include, false);
  assert.deepEqual(listed.replaces, [old.key]);
  assert.deepEqual(listed.notes, [
    `An earlier import of ${FOLIO} added this holding as ${YAHOO}. So that it isn't counted twice, it's left out unless you replace ${YAHOO} with it. ` +
    `Replace it only if all its units came from ${FOLIO}: imports don't record how many units each folio, demat account or PRAN added.`,
  ]);
  assert.equal(old.include, true);
  assert.equal(old.replacedBy, listed.key);
  assert.deepEqual(old.notes, [`An earlier import of ${FOLIO} added it for a holding that this import lists under ${AMFI}. It's kept unless you replace it with ${AMFI}.`]);
  assert.deepEqual(savedOf(next), [["yahoo-asset", "100"]]);
  assert.deepEqual([...recordsOf(next).values()].map((refs) => [...refs.keys()]), [[old.ref]]);
  // One choice replaces it: the old asset goes, and the statement's units come in under the new one.
  const replace = replacing(listed.key);
  assert.equal(included(listed, replace), true);
  assert.equal(included(old, replace), false);
  assert.deepEqual(savedOf(next, replace), [["119551", "110"]]);
  const replaced = recordsOf(next, replace);
  assert.deepEqual([...replaced.values()].map((refs) => [...refs]), [[[fundRef("119551"), ["INFZ90K01FC8", "CAMS|FFCDG"]]]]);
  // The old row goes with the statement row's choice, not its own.
  assert.deepEqual(savedOf(next, replacing(old.key)), [["yahoo-asset", "100"]]);
  // Once replaced, the next import has nothing to replace.
  const [after] = plan(statementOf("2025-05-31", folioOf("91234567 / 12", flexi("120"))), {
    asset: () => amfi,
    existing: () => ({ ...heldBefore(amfi, "110"), date: "2025-04-30" }),
    remembered: (s) => replaced.get(s.id),
  });
  assert.deepEqual(after.positions.map((p) => [p.include, p.replaces, p.replacedBy, p.notes]), [[true, undefined, undefined, []]]);
});

test("replacement names distinguish the same symbol on different exchanges", () => {
  const share = { ...flexi("110"), kind: "share", isin: "INEZ90A01017" };
  const source = { id: "demat|1|2", kind: "demat", label: "Demat account 1", holdings: [share] };
  const before = { ...yahoo, symbol: "EXAMPLE", name: "Example Share" };
  const after = { ...before, exchangeMic: "XNSE" };
  const [next] = plan(statementOf("2025-04-30", source), {
    asset: () => after, existing: () => heldBefore(before, "100"),
    remembered: () => new Map([[fundRef(before.symbol, before.exchangeMic), [share.isin]]]),
  });
  const [listed, old] = next.positions;
  assert.deepEqual(listed.replaces, [old.key]);
  assert.equal(assetName(old), "Example Share (EXAMPLE · XBOM)");
  assert.equal(assetName(listed), "Example Share (EXAMPLE · XNSE)");
  assert.equal(assetNames([old, listed]), "Example Share (EXAMPLE · XBOM) and Example Share (EXAMPLE · XNSE)");
  assert.match(old.notes[0], /Example Share \(EXAMPLE · XNSE\)/);
  assert.match(listed.notes[0], /Example Share \(EXAMPLE · XBOM\)/);
  assert.deepEqual(savedOf(next), [["yahoo-asset", "100"]]);
  assert.deepEqual(savedOf(next, replacing(listed.key)), [["EXAMPLE", "110"]]);
});

test("a summary fund that now prints its ISIN can replace the asset priced from statements an earlier import added", () => {
  const overnight = { kind: "fund", isin: null, rta: "KFINTECH", rtaCode: "TONDG", name: "Testbridge Overnight Fund", units: "12.5", price: "1300", value: "16250", cost: null };
  const folio = (holding) => ({ id: "folio|1040012345|amc:Testbridge Mutual Fund", kind: "folio", label: "Testbridge Mutual Fund, folio 1040012345", holdings: [holding] });
  const [first] = plan(statementOf("2025-03-31", folio(overnight)), { asset: statementAsset });
  const records = recordsOf(first);
  const symbol = "MF-KFINTECH-TONDG";
  assert.deepEqual([...records.values()].map((refs) => [...refs]), [[[fundRef(symbol), ["KFINTECH|TONDG"]]]]);
  const existing = { ...none, date: "2025-03-31", positions: [{
    assetId: "statement-priced", symbol, ref: fundRef(symbol), name: overnight.name, units: "12.5", cost: "16000", currency: "INR",
    manual: true, price: { close: "1300", currency: "INR" },
  }] };
  // The ISIN finds the fund again, and the user confirms the search's result.
  const [next] = plan(statementOf("2025-04-30", folio({ ...overnight, isin: "INFZ91T01ON3", units: "13" })), {
    existing: () => existing, remembered: (s) => records.get(s.id),
  });
  const [listed, old] = next.positions;
  assert.equal(listed.ref, ref("INFZ91T01ON3"));
  assert.deepEqual([listed.include, listed.replaces, old.include, old.replacedBy], [false, [old.key], true, listed.key]);
  assert.match(listed.notes[0], /^An earlier import of Testbridge Mutual Fund, folio 1040012345 added this holding as Testbridge Overnight Fund \(MF-KFINTECH-TONDG\)\./);
  assert.deepEqual(savedOf(next), [["statement-priced", "12.5"]]);
  assert.deepEqual(savedOf(next, replacing(listed.key)), [["INFZ91T01ON3", "13"]]);
  // Kept, it gets the price it had; replaced, the new asset isn't priced by hand, so nothing is saved.
  assert.deepEqual(pricesToSave(next, noChoices).map((p) => [p.assetId, p.price, p.from]), [["statement-priced", "1300", "earlier"]]);
  assert.deepEqual(pricesToSave(next, replacing(listed.key)), []);
});

test("an asset several folios added is replaced whole; one that may hold other units is only kept", () => {
  const [first] = plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => yahoo });
  const records = recordsOf(first);
  const both = "Fictiva Mutual Fund, folio 1 and Fictiva Mutual Fund, folio 2";
  // A folio new to the account has no record: its units come in with the others'.
  const later = statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", flexi("44")), folioOf("3", flexi("10")));
  const [shared] = plan(later, { asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id) ?? new Map() });
  const [listed, old] = shared.positions;
  assert.deepEqual(listed.replaces, [old.key]);
  assert.match(listed.notes[0], new RegExp(`^An earlier import of ${both} added this holding as .*Replace it only if all its units came from ${both}:`));
  assert.equal(old.notes[0], `An earlier import of ${both} added it for holdings that this import lists under ${AMFI}. It's kept unless you replace it with ${AMFI}.`);
  assert.deepEqual(savedOf(shared), [["yahoo-asset", "100"]]);
  assert.deepEqual(savedOf(shared, replacing(listed.key)), [["119551", "120"]]);

  // Another fund that an earlier import of folio 1 added to the same asset is still listed, but left
  // out: how many of the asset's units it holds is unknown, so nothing is replaced.
  const other = flexi("5", { isin: "INFZ90K01FC9", rtaCode: "FFCRG", name: "Fictiva Flexi Cap Fund - Regular Plan - Growth" });
  const [twoFunds] = plan(statementOf("2025-03-31", folioOf("1", flexi("60"), other)), { asset: () => yahoo });
  const twoRecords = recordsOf(twoFunds);
  const mixedNote = `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}. ` +
    `The add-on can't tell how many of its units that holding accounts for, so it's kept and ${AMFI} is left out by default. ` +
    "If you keep both, correct this holding's units in Wealthfolio so that they aren't counted twice.";
  const [mixed] = plan(statementOf("2025-04-30", folioOf("1", flexi("66"), other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => heldBefore(yahoo, "65"), remembered: (s) => twoRecords.get(s.id),
  });
  const [mixedListed, mixedOld] = mixed.positions;
  assert.deepEqual([mixedListed.include, mixedListed.replaces, mixedOld.include, mixedOld.replacedBy], [false, undefined, true, undefined]);
  assert.deepEqual(mixedListed.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added this holding as ${YAHOO}, which may also hold other units, so it's left out by default. ` +
    `If you keep both, correct the units of ${YAHOO} in Wealthfolio so that they aren't counted twice.`,
  ]);
  assert.deepEqual(mixedOld.notes, [mixedNote]);
  assert.deepEqual(savedOf(mixed), [["yahoo-asset", "65"]]);
  // Each row has its own choice: importing the statement's units keeps the old asset too, as the notes warn.
  assert.deepEqual(savedOf(mixed, replacing(mixedListed.key)), [["yahoo-asset", "65"], ["119551", "66"]]);
  assert.deepEqual(savedOf(mixed, replacing(mixedOld.key)), []);

  // So does a folio whose lines can't all be compared with what its earlier import recorded.
  const noIsin = { ...other, isin: null };
  const [uncertain] = plan(statementOf("2025-04-30", folioOf("1", flexi("66"), noIsin)), {
    asset: (h) => (h.isin ? amfi : undefined), existing: () => heldBefore(yahoo, "60"),
    remembered: () => new Map([[fundRef(yahoo.symbol, yahoo.exchangeMic), ["INFZ90K01FC8"]]]),
  });
  assert.deepEqual(uncertain.positions.map((p) => [p.include, p.replaces, p.replacedBy]), [[false, undefined, undefined], [true, undefined, undefined]]);
  assert.equal(uncertain.positions[1].notes[0], mixedNote);

  // Another recorded holding still listed only by another source makes the old asset mixed too.
  const [elsewhere] = plan(statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => heldBefore(yahoo, "65"),
    remembered: (s) => twoRecords.get(s.id) ?? new Map(),
  });
  assert.deepEqual(elsewhere.positions.map((p) => [p.include, p.replaces, p.replacedBy]), [[false, undefined, undefined], [true, undefined, undefined]]);
  assert.equal(elsewhere.positions[1].notes[0], mixedNote);
  assert.deepEqual(savedOf(elsewhere), [["yahoo-asset", "65"]]);

  // A valid line moving assets must not duplicate an old position held back by another misread line.
  const [heldBack] = plan(statementOf("2025-04-30", { ...folioOf("1", flexi("66")), misread: [other] }), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => heldBefore(yahoo, "65"),
    remembered: (s) => twoRecords.get(s.id),
  });
  const [heldNew, heldOld] = heldBack.positions;
  assert.deepEqual([heldNew.include, heldNew.replaces, heldOld.include, heldOld.replacedBy], [false, undefined, true, undefined]);
  assert.ok(heldOld.misread);
  assert.equal(heldOld.notes[1], mixedNote);
  assert.deepEqual(savedOf(heldBack), [["yahoo-asset", "65"]]);
  assert.deepEqual(savedOf(heldBack, replacing(heldOld.key)), [["yahoo-asset", "65"]]);
  assert.deepEqual([...recordsOf(heldBack).values()].map((refs) => [...refs]), [...twoRecords.values()].map((refs) => [...refs]));

  // Lines still under the old asset replace its units as any statement row's do, so the moved
  // holding leaves with its old units and comes in under the new asset: nothing is counted twice.
  const [stillListed] = plan(statementOf("2025-04-30", folioOf("1", flexi("66"), other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : yahoo), existing: () => heldBefore(yahoo, "65"),
    remembered: (s) => twoRecords.get(s.id),
  });
  assert.deepEqual(stillListed.positions.map((p) => [p.include, p.replaces, p.replacedBy, p.notes]), [
    [true, undefined, undefined, []], [true, undefined, undefined, []],
  ]);
  assert.deepEqual(savedOf(stillListed), [["119551", "66"], ["yahoo-asset", "5"]]);
});

test("an asset is only replaced by a holding an earlier import of the same folio added it for", () => {
  const records = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("100"))), { asset: () => yahoo })[0]);
  const later = statementOf("2025-04-30", folioOf("1", flexi("110")));
  // Without a record, the old asset can't be told apart from one added by hand: both stay, as before.
  const [unrecorded] = plan(later, { asset: () => amfi, existing: () => heldBefore(yahoo, "100") });
  assert.deepEqual(unrecorded.positions.map((p) => [p.include, p.replaces, p.replacedBy, p.notes]), [
    [true, undefined, undefined, []], [true, undefined, undefined, []],
  ]);
  // A listed holding left out keeps the asset, as before.
  const [leftOut] = plan(later, { asset: () => undefined, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id) });
  assert.deepEqual(leftOut.positions.map((p) => [p.include, p.replacedBy, p.notes]), [[true, undefined, []]]);
  // A holding left out because an account tracking transactions holds it isn't imported anyway, and
  // keeping the old asset counts its units in both accounts: it needs its own choice to keep or remove it.
  const [overlap] = plan(later, {
    asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id), heldElsewhere: tracking,
  });
  const [listed, old] = overlap.positions;
  assert.deepEqual([listed.include, listed.replaces, listed.removable, old.include, old.replacedBy], [false, undefined, undefined, true, undefined]);
  assert.deepEqual(old.removable.map((s) => s.label), ["Fictiva Mutual Fund, folio 1"]);
  assert.deepEqual(listed.notes, [
    "Mutual funds already holds this fund, from its transactions. Including it here counts it twice.",
    `An earlier import of Fictiva Mutual Fund, folio 1 added this holding as ${YAHOO}.`,
  ]);
  assert.deepEqual(old.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}. ` +
    "Mutual funds already holds that holding, so keeping this one counts its units in both accounts. " +
    "Keep it, or remove it only if all its units came from Fictiva Mutual Fund, folio 1: imports don't record how many units each folio, demat account or PRAN added.",
  ]);
  assert.deepEqual([undecided(old, noChoices), undecided(listed, noChoices), undecided(old, keeping(old.key, true))], [true, false, false]);
  assert.deepEqual(savedOf(overlap, keeping(old.key, true)), [["yahoo-asset", "100"]]);
  assert.deepEqual(savedOf(overlap, keeping(old.key, false)), []);
  assert.deepEqual([...recordsOf(overlap, keeping(old.key, false)).values()].map((refs) => [...refs]), [[]]);
  // Importing the statement's units doesn't decide for the old asset.
  assert.equal(undecided(old, replacing(listed.key)), true);
  assert.deepEqual(savedOf(overlap, keeping(old.key, false, [listed.key])), [["119551", "110"]]);
  // When the old asset may also hold other units, it keeps its own Keep choice, and says it may be counted twice.
  const other = flexi("5", { isin: "INFZ90K01FC9", rtaCode: "FFCRG", name: "Fictiva Flexi Cap Fund - Regular Plan - Growth" });
  const [mixed] = plan(statementOf("2025-04-30", folioOf("1", flexi("110"), other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => heldBefore(yahoo, "105"), heldElsewhere: tracking,
    remembered: () => new Map([[fundRef(yahoo.symbol, yahoo.exchangeMic), ["INFZ90K01FC8", "INFZ90K01FC9"]]]),
  });
  const mixedOld = mixed.positions[1];
  assert.deepEqual([mixedOld.include, mixedOld.removable], [true, undefined]);
  assert.deepEqual(mixedOld.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}.`,
    `Mutual funds already holds ${AMFI}, so this holding's units may be counted there too. Check them in Wealthfolio.`,
  ]);
  assert.deepEqual(savedOf(mixed, replacing(mixedOld.key)), []);
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

const OVERLAP = "Mutual funds already holds this fund, from its transactions. Including it here counts it twice.";
const flexiAsset = (units, more = {}) => heldBefore(amfi, units, { assetId: "flexi-asset", ...more });

test("a fund left out for overlap that an earlier import of its folio added needs a choice to keep or remove the account's units", () => {
  const records = recordsOf(plan(statementOf("2025-03-31", folioOf("91234567 / 12", flexi("100"))), { asset: () => amfi })[0]);
  const later = statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110")));
  const [account] = plan(later, { asset: () => amfi, existing: () => flexiAsset("100"), remembered: (s) => records.get(s.id), heldElsewhere: tracking });
  assert.equal(account.positions.length, 1);
  const [row] = account.positions;
  assert.deepEqual([row.include, row.existing.assetId, row.removable.map((s) => s.label)], [false, "flexi-asset", [FOLIO]]);
  assert.deepEqual(row.notes, [
    OVERLAP,
    `An earlier import of ${FOLIO} recorded adding this holding. Leaving this row out keeps the 100 units this account holds unless you remove them. Keeping them counts them here and in Mutual funds. ` +
    `Keep them, or remove them only if all of them came from ${FOLIO}: imports don't record how many units each folio, demat account or PRAN added.`,
  ]);
  // Saving waits for the choice.
  assert.equal(undecided(row, noChoices), true);
  assert.equal(undecided(row, keeping(row.key, true)), false);
  // Kept: the account's units stay, and so does the earlier import's record.
  assert.deepEqual(savedOf(account, keeping(row.key, true)), [["flexi-asset", "100"]]);
  assert.deepEqual([...recordsOf(account, keeping(row.key, true)).values()].map((refs) => [...refs.keys()]), [[fundRef("119551")]]);
  // Removed: so is the record, and the next import has nothing left to remove.
  const remove = keeping(row.key, false);
  assert.deepEqual(savedOf(account, remove), []);
  const removed = recordsOf(account, remove);
  assert.deepEqual([...removed.values()].map((refs) => [...refs]), [[]]);
  const [next] = plan(statementOf("2025-05-31", folioOf("91234567 / 12", flexi("120"))), {
    asset: () => amfi, existing: () => ({ ...none, date: "2025-04-30" }), remembered: (s) => removed.get(s.id), heldElsewhere: tracking,
  });
  assert.deepEqual(next.positions.map((p) => [p.include, p.removable, p.notes]), [[false, undefined, [OVERLAP]]]);
  // Importing the statement's units replaces the account's, whatever was chosen for them.
  assert.equal(undecided(row, replacing(row.key)), false);
  assert.deepEqual(savedOf(account, replacing(row.key)), [["flexi-asset", "110"]]);
  assert.deepEqual(savedOf(account, keeping(row.key, false, [row.key])), [["flexi-asset", "110"]]);
  // A removed asset priced by hand isn't in the snapshot, so it gets no price; a kept one keeps its own.
  const [manual] = plan(later, {
    asset: () => amfi, existing: () => flexiAsset("100", { manual: true, price: { close: "60", currency: "INR" } }),
    remembered: (s) => records.get(s.id), heldElsewhere: tracking,
  });
  const key = manual.positions[0].key;
  assert.deepEqual(pricesToSave(manual, keeping(key, true)).map((p) => [p.assetId, p.price, p.from]), [["flexi-asset", "60", "earlier"]]);
  assert.deepEqual(pricesToSave(manual, keeping(key, false)), []);
  assert.equal(manual.positions[0].notes[0], "Priced by hand: importing this row also saves the statement's price as its price on this date.");
  const [noPrice] = plan(statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110", { price: "0" }))), {
    asset: () => amfi, existing: () => flexiAsset("100", { manual: true }),
    remembered: (s) => records.get(s.id), heldElsewhere: tracking,
  });
  assert.equal(noPrice.positions[0].notes[0], "Priced by hand, but the statement prints no price for it. If you keep or import it, enter its price for this date on its asset page after saving.");

  // Two folios on the row that each added the fund: both are named, and removing takes all its units.
  const both = "Fictiva Mutual Fund, folio 1 and Fictiva Mutual Fund, folio 2";
  const twoRecords = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => amfi })[0]);
  const [two] = plan(statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", flexi("44"))), {
    asset: () => amfi, existing: () => flexiAsset("100"), remembered: (s) => twoRecords.get(s.id), heldElsewhere: tracking,
  });
  assert.deepEqual(two.positions.map((p) => p.removable?.map((s) => s.label)), [["Fictiva Mutual Fund, folio 1", "Fictiva Mutual Fund, folio 2"]]);
  assert.match(two.positions[0].notes[1], new RegExp(`^An earlier import of ${both} recorded adding this holding\\. Leaving this row out keeps the 100 units .* came from ${both}:`));
  assert.deepEqual(savedOf(two, keeping(two.positions[0].key, false)), []);
});

test("a fund left out for overlap keeps units that another source or no import may have added, with a note", () => {
  const note = (why) => `Leaving this row out keeps this account's 100 units of it, so Mutual funds may count them too. ${why} Check them in Wealthfolio.`;
  const other = flexi("5", { isin: "INFZ90K01FC9", rtaCode: "FFCRG", name: "Fictiva Flexi Cap Fund - Regular Plan - Growth" });
  const R = fundRef("119551");
  const check = (account, why) => {
    const [row] = account.positions;
    assert.deepEqual([row.include, row.removable, row.notes], [false, undefined, why ? [OVERLAP, note(why)] : [OVERLAP]]);
    assert.equal(undecided(row, noChoices), false);
    // No choice removes them.
    assert.deepEqual(savedOf(account, keeping(row.key, false)).filter(([id]) => id === "flexi-asset"), [["flexi-asset", "100"]]);
  };
  const flexiOnly = statementOf("2025-04-30", folioOf("1", flexi("110")));
  // No earlier import recorded adding them: added by hand, say, or by another statement's import.
  check(plan(flexiOnly, { asset: () => amfi, existing: () => flexiAsset("100"), heldElsewhere: tracking })[0],
    "No earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding.");
  // Another folio's earlier import added them too, for another fund.
  const shared = (s) => new Map([[R, s.id.includes("folio|1|") ? ["INFZ90K01FC8", "CAMS|FFCDG"] : ["INFZ90K01FC9", "CAMS|FFCRG"]]]);
  check(plan(statementOf("2025-04-30", folioOf("1", flexi("110")), folioOf("2", other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => flexiAsset("100"), remembered: shared, heldElsewhere: tracking,
  })[0], "An earlier import of Fictiva Mutual Fund, folio 1 and Fictiva Mutual Fund, folio 2 recorded adding this holding, but its units may also include others.");
  // The folio's own earlier import added them for another fund too, which it still lists under another asset.
  const ownTwo = () => new Map([[R, ["INFZ90K01FC8", "CAMS|FFCDG", "INFZ90K01FC9", "CAMS|FFCRG"]]]);
  check(plan(statementOf("2025-04-30", folioOf("1", flexi("110"), other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : yahoo), existing: () => flexiAsset("100"), remembered: ownTwo, heldElsewhere: tracking,
  })[0], "An earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding, but its units may also include others.");
  // A folio whose lines can't all be compared with what its earlier import recorded.
  check(plan(statementOf("2025-04-30", folioOf("1", flexi("110"), { ...other, isin: null })), {
    asset: (h) => (h.isin ? amfi : undefined), existing: () => flexiAsset("100"), heldElsewhere: tracking,
    remembered: () => new Map([[R, ["INFZ90K01FC8"]]]),
  })[0], "An earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding, but its units may also include others.");
  // A demat account's line for the fund replaces the account's units when it's imported: nothing to add.
  const demat = { id: "demat|1|2", kind: "demat", label: "Demat account 1", holdings: [flexi("20")] };
  const [withDemat] = plan(statementOf("2025-04-30", demat, folioOf("1", flexi("110"))), {
    asset: () => amfi, existing: () => flexiAsset("100"), heldElsewhere: tracking,
    remembered: (s) => (s.kind === "folio" ? new Map([[R, ["INFZ90K01FC8", "CAMS|FFCDG"]]]) : new Map()),
  });
  const [dematRow, folioRow] = withDemat.positions;
  assert.deepEqual([dematRow.include, folioRow.include, folioRow.removable, folioRow.notes], [true, false, undefined, [OVERLAP]]);
  assert.deepEqual(savedOf(withDemat), [["flexi-asset", "20"]]);
});

// Demat accounts 1 and 2 go to one holdings account: 1 holds 100 of S, 2 holds 50 of S and 10 of T.
const S = "INEZ90S01011";
const T = "INEZ90T01012";
const share = (isin, units) => ({
  kind: "share", isin, rta: null, rtaCode: null, name: `Share ${isin}`, units, price: "10", value: format(mul(dec(units), dec("10"))), cost: null,
});
const demat = (n, ...holdings) => ({ id: `demat|${n}|${n}`, kind: "demat", label: `Demat account ${n}`, holdings });
const sharesHeld = (...held) => ({
  date: "2025-03-31", later: [], cash: {},
  positions: held.map(([isin, units]) => ({ assetId: `asset-${isin}`, symbol: isin, ref: ref(isin), name: `Share ${isin}`, units, cost: null, currency: "INR" })),
});
const recorded = (...isins) => new Map(isins.map((isin) => [ref(isin), [isin]]));
const withoutDemat2 = (s) => (s.id === "demat|2|2" ? undefined : "holdings-1");

test("a holding that a left-out source's earlier import added keeps its units unless the user imports the statement's", () => {
  const next = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(S, "50"), share(T, "10")));
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(S, T)]]);
  const [account] = plan(next, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => records.get(s.id) ?? new Map(),
  });
  const [shared, unshared] = account.positions;
  assert.deepEqual([shared.ref, shared.units, shared.include], [ref(S), "100", false]);
  assert.deepEqual(shared.notes, [
    "An earlier import of Demat account 2, which this import leaves out, recorded adding this holding. " +
    "Importing this row replaces the 150 units this account holds with the statement's 100, which don't count any that Demat account 2 holds, so it's left out by default. " +
    "Import it only if Demat account 2 no longer holds any.",
  ]);
  // T is only Demat account 2's, so it stays as before, with no note.
  assert.deepEqual([unshared.ref, unshared.include, unshared.notes], [ref(T), true, []]);
  assert.deepEqual(savedOf(account), [[`asset-${S}`, "150"], [`asset-${T}`, "10"]]);
  // Demat account 1 still recorded adding S, whose units stay.
  assert.deepEqual([...recordsOf(account)].map(([id, refs]) => [id, [...refs.keys()]]), [["demat|1|1", [ref(S)]]]);
  // The user can still import the statement's units.
  assert.deepEqual(savedOf(account, replacing(shared.key)), [[`asset-${T}`, "10"], [`asset-${S}`, "100"]]);

  // Without Demat account 2's record of S, the statement's units replace the account's, as before.
  const plain = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)]]);
  const [unrecorded] = plan(next, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => plain.get(s.id) ?? new Map(),
  });
  assert.deepEqual(unrecorded.positions.map((p) => [p.ref, p.include, p.notes]), [[ref(S), true, []], [ref(T), true, []]]);
  assert.deepEqual(savedOf(unrecorded), [[`asset-${T}`, "10"], [`asset-${S}`, "100"]]);
  // Nor does its record in another account count.
  const [elsewhere] = plan(next, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]),
    remembered: (s, accountId) => (s.id === "demat|2|2" && accountId === "holdings-1" ? new Map() : records.get(s.id) ?? new Map()),
  });
  assert.deepEqual(elsewhere.positions.map((p) => [p.ref, p.include, p.notes]), [[ref(S), true, []], [ref(T), true, []]]);
});

test("a shared holding left out by default describes the kept manual price, not the statement's", () => {
  const before = sharesHeld([S, "150"]);
  const preview = (price, statementPrice = "10") => plan(statementOf("2025-04-30",
    demat(1, { ...share(S, "100"), price: statementPrice }), demat(2, share(S, "50")),
  ), {
    account: withoutDemat2,
    existing: () => ({ ...before, positions: before.positions.map((p) => ({ ...p, manual: true, cost: "1200", price })) }),
    remembered: () => recorded(S),
  })[0];
  const account = preview({ close: "9", currency: "INR" });
  const [row] = account.positions;
  assert.equal(row.include, false);
  assert.equal(row.notes[0], "Priced by hand: importing this row also saves the statement's price as its price on this date.");
  assert.equal(snapshotOf(account, noChoices).holdings[0].averageCost, "8");
  assert.deepEqual(pricesToSave(account, noChoices).map((p) => [p.price, p.from]), [["9", "earlier"]]);
  assert.deepEqual(pricesToSave(account, replacing(row.key)).map((p) => [p.price, p.from]), [["10", "statement"]]);
  // With no earlier quote, saving the kept cost leaves its average as the price.
  const unpriced = preview();
  assert.equal(unpriced.positions[0].notes.at(-1), "It's priced by hand and has no price on or before this date. If no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date.");
  assert.deepEqual(pricesToSave(unpriced, noChoices), []);
  assert.equal(preview(undefined, "0").positions[0].notes[0], "Priced by hand, but the statement prints no price for it. If you keep or import it, enter its price for this date on its asset page after saving.");
});

test("a holding that a left-out source's earlier import added is kept when the account's other sources no longer list it", () => {
  const U = "INEZ90U01013";
  const next = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(S, "50"), share(U, "20")));
  const existing = () => sharesHeld([S, "150"], [U, "30"]);
  const sold = (records) => plan(next, { account: withoutDemat2, existing, remembered: (s) => records.get(s.id) ?? new Map() })[0];
  const account = sold(new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(S, U)]]));
  const row = account.positions.find((p) => p.ref === ref(U));
  assert.equal(row.include, true);
  assert.deepEqual(row.notes, [
    "An earlier import of Demat account 1 added it, and Demat account 1 no longer lists it. " +
    "An earlier import of Demat account 2, which this import leaves out, added it too, so it's kept. " +
    "Remove it only if Demat account 2 no longer holds any. If you keep it, correct its units in Wealthfolio: they may include some that came from Demat account 1.",
  ]);
  assert.deepEqual(savedOf(account), [[`asset-${S}`, "150"], [`asset-${U}`, "30"]]);
  assert.deepEqual(savedOf(account, replacing(row.key)), [[`asset-${S}`, "150"]]);
  // Only Demat account 1 added it: it's removed by default, as before.
  const own = sold(new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(S)]])).positions.find((p) => p.ref === ref(U));
  assert.deepEqual([own.include, own.notes], [false, ["Not on the statement any more. An earlier import of Demat account 1 added it."]]);
});

test("an asset that a left-out source's earlier import added isn't offered for replacement or removal", () => {
  const folio2Out = (s) => (s.id.includes("folio|2|") ? undefined : "holdings-1");
  const records = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => yahoo })[0]);
  const later = statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", flexi("44")));
  const LEFT_OUT = "An earlier import of Fictiva Mutual Fund, folio 2, which this import leaves out, added it too.";
  // Confirmed to another asset: replacing the old one would take folio 2's units with it.
  const [moved] = plan(later, { account: folio2Out, asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id) });
  const [listed, old] = moved.positions;
  assert.deepEqual([listed.include, listed.replaces, old.include, old.replacedBy], [false, undefined, true, undefined]);
  assert.deepEqual(listed.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added this holding as ${YAHOO}, which may also hold other units, so it's left out by default. ` +
    `If you keep both, correct the units of ${YAHOO} in Wealthfolio so that they aren't counted twice.`,
  ]);
  assert.deepEqual(old.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}. ` +
    `The add-on can't tell how many of its units that holding accounts for, so it's kept and ${AMFI} is left out by default. ` +
    "If you keep both, correct this holding's units in Wealthfolio so that they aren't counted twice.",
    LEFT_OUT,
  ]);
  assert.deepEqual(savedOf(moved), [["yahoo-asset", "100"]]);
  // And when an account that tracks transactions holds the new asset, it isn't removable either.
  const [tracked] = plan(later, {
    account: folio2Out, asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id), heldElsewhere: tracking,
  });
  assert.deepEqual(tracked.positions.map((p) => [p.include, p.removable]), [[false, undefined], [true, undefined]]);
  assert.equal(tracked.positions[1].notes.at(-1), LEFT_OUT);

  // Left out for overlap: its units aren't removable, and importing it would take folio 2's.
  const amfiRecords = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => amfi })[0]);
  const [overlap] = plan(later, {
    account: folio2Out, asset: () => amfi, existing: () => flexiAsset("100"), remembered: (s) => amfiRecords.get(s.id), heldElsewhere: tracking,
  });
  const [row] = overlap.positions;
  assert.deepEqual([row.include, row.removable, undecided(row, noChoices)], [false, undefined, false]);
  assert.deepEqual(row.notes, [
    OVERLAP,
    "An earlier import of Fictiva Mutual Fund, folio 2, which this import leaves out, recorded adding this holding. " +
    "Importing this row replaces the 100 units this account holds with the statement's 66, which don't count any that Fictiva Mutual Fund, folio 2 holds.",
    "Leaving this row out keeps this account's 100 units of it, so Mutual funds may count them too. " +
    "An earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding, but its units may also include others. Check them in Wealthfolio.",
  ]);
  assert.deepEqual(savedOf(overlap, keeping(row.key, false)), [["flexi-asset", "100"]]);
  // Kept, so folio 2's record stays as it is.
  assert.deepEqual([...recordsOf(overlap, keeping(row.key, false)).keys()], ["folio|1|amc:Fictiva Mutual Fund"]);
  assert.deepEqual([...recordsOf(moved).keys()], ["folio|1|amc:Fictiva Mutual Fund"]);
  assert.deepEqual([...recordsOf(tracked).keys()], ["folio|1|amc:Fictiva Mutual Fund"]);
});

/** What each source's import recorded, by source ID, as `fundRef`s. */
const recordedRefs = (account, choices = noChoices) => [...recordsOf(account, choices)].map(([id, refs]) => [id, [...refs.keys()]]);

test("importing a shared row clears it from the left-out source's record, so the next import takes the statement's", () => {
  // Demat account 2 has sold its S, and still holds 10 T.
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(S, T)]]);
  const april = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(T, "10")));
  const [account] = plan(april, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => records.get(s.id) ?? new Map(),
  });
  const [shared, unshared] = account.positions;
  assert.deepEqual([shared.ref, shared.include, unshared.ref, unshared.include, unshared.notes], [ref(S), false, ref(T), true, []]);
  assert.match(shared.notes[0], /^An earlier import of Demat account 2, which this import leaves out, recorded adding this holding\. .* Import it only if Demat account 2 no longer holds any\.$/);
  // Left out, the account keeps its units, and Demat account 2 its record.
  assert.deepEqual(savedOf(account), [[`asset-${S}`, "150"], [`asset-${T}`, "10"]]);
  assert.deepEqual(recordedRefs(account), [["demat|1|1", [ref(S)]]]);
  // Imported, the account's units are the statement's: Demat account 2's record keeps only T, which it holds.
  const imported = replacing(shared.key);
  assert.deepEqual(savedOf(account, imported), [[`asset-${T}`, "10"], [`asset-${S}`, "100"]]);
  const aprilRecords = recordsOf(account, imported);
  assert.deepEqual([...aprilRecords], [["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)]]);

  // The next statement's units come in by default, with no note.
  const may = statementOf("2025-05-31", demat(1, share(S, "120")), demat(2, share(T, "10")));
  const [next] = plan(may, {
    account: withoutDemat2, existing: () => ({ ...sharesHeld([S, "100"], [T, "10"]), date: "2025-04-30" }),
    remembered: (s) => aprilRecords.get(s.id) ?? new Map(),
  });
  assert.deepEqual(next.positions.map((p) => [p.ref, p.include, p.notes]), [[ref(S), true, []], [ref(T), true, []]]);
  assert.deepEqual(savedOf(next), [[`asset-${T}`, "10"], [`asset-${S}`, "120"]]);
  // T's units stay, so Demat account 2's record does too.
  assert.deepEqual(recordedRefs(next), [["demat|1|1", [ref(S)]]]);

  // A record under the asset's earlier symbol is matched, and cleared, as the account's position is.
  const renamed = sharesHeld([S, "150"], [T, "10"]);
  renamed.positions[0] = { ...renamed.positions[0], symbol: "OLD", ref: ref("OLD") };
  const [moved] = plan(april, {
    account: withoutDemat2, existing: () => renamed, asset: (h) => ({ ...asset(h), assetId: `asset-${h.isin}` }),
    remembered: (s) => (s.id === "demat|2|2" ? recorded("OLD", T) : recorded("OLD")),
  });
  const [row] = moved.positions;
  assert.deepEqual([row.ref, row.existing.ref, row.include], [ref(S), ref("OLD"), false]);
  // Demat account 1's record after a rename is #139's.
  const second = (choices) => recordedRefs(moved, choices).filter(([id]) => id === "demat|2|2");
  assert.deepEqual(second(), []);
  assert.deepEqual(second(replacing(row.key)), [["demat|2|2", [ref(T)]]]);
});

test("removing a holding that a left-out source's earlier import added clears it from that source's record", () => {
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(S, T)]]);
  const april = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(T, "10")));
  const [account] = plan(april, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => records.get(s.id) ?? new Map(),
  });
  const [shared, unshared] = account.positions;
  // T is kept with S left out: only T goes from the record.
  assert.deepEqual(savedOf(account, replacing(unshared.key)), [[`asset-${S}`, "150"]]);
  assert.deepEqual(recordedRefs(account, replacing(unshared.key)), [["demat|1|1", [ref(S)]], ["demat|2|2", [ref(S)]]]);
  // With S imported too, nothing of Demat account 2's is left.
  const both = { flipped: new Set([shared.key, unshared.key]), costs: new Map() };
  assert.deepEqual(savedOf(account, both), [[`asset-${S}`, "100"]]);
  assert.deepEqual(recordedRefs(account, both), [["demat|1|1", [ref(S)]], ["demat|2|2", []]]);

  // A holding the included sources no longer list, kept for the left-out source until the user removes it.
  const U = "INEZ90U01013";
  const [sold] = plan(statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(S, "50"), share(U, "20"))), {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [U, "30"]),
    remembered: (s) => new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(S, U)]]).get(s.id),
  });
  const kept = sold.positions.find((p) => p.ref === ref(U));
  assert.deepEqual(recordedRefs(sold), [["demat|1|1", [ref(S), ref(U)]]]);
  assert.deepEqual(recordedRefs(sold, replacing(kept.key)), [["demat|1|1", [ref(S)]], ["demat|2|2", [ref(S)]]]);
});

test("replacing an old asset, or removing a fund left out for overlap, clears only what it replaces from a left-out source's record", () => {
  const folio2Out = (s) => (s.id.includes("folio|2|") ? undefined : "holdings-1");
  const T_REF = ref(T);
  const others = (more = []) => new Map([[T_REF, [T]], ...more]);
  const later = statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", share(T, "10")));
  // Folio 2's earlier import added another holding, so the old asset is still offered for replacement.
  const records = new Map([["folio|1|amc:Fictiva Mutual Fund", new Map([[fundRef(yahoo.symbol, yahoo.exchangeMic), ["INFZ90K01FC8"]]])]]);
  const existing = () => ({ ...heldBefore(yahoo, "60"), positions: [...heldBefore(yahoo, "60").positions, ...sharesHeld([T, "10"]).positions] });
  const replaced = (record) => plan(later, {
    account: folio2Out, asset: (h) => (h.isin === T ? asset(h) : amfi), existing, remembered: (s) => records.get(s.id) ?? record,
  })[0];
  const [listed, old] = replaced(others()).positions;
  assert.deepEqual([listed.replaces, old.replacedBy], [[old.key], listed.key]);
  assert.deepEqual(savedOf(replaced(others()), replacing(listed.key)), [[`asset-${T}`, "10"], ["119551", "66"]]);
  assert.deepEqual(recordedRefs(replaced(others()), replacing(listed.key)), [["folio|1|amc:Fictiva Mutual Fund", [fundRef("119551")]]]);
  // A stale record of the new asset, which the account doesn't hold, goes once the statement's units come in.
  const stale = replaced(others([[fundRef("119551"), ["INFZ90K01FC8"]]]));
  assert.deepEqual([stale.positions[0].replaces, stale.positions[1].replacedBy], [[stale.positions[1].key], stale.positions[0].key]);
  assert.deepEqual(recordedRefs(stale), [["folio|1|amc:Fictiva Mutual Fund", [fundRef(yahoo.symbol, yahoo.exchangeMic)]]]);
  assert.deepEqual(recordedRefs(stale, replacing(stale.positions[0].key)), [
    ["folio|1|amc:Fictiva Mutual Fund", [fundRef("119551")]], ["folio|2|amc:Fictiva Mutual Fund", [T_REF]],
  ]);

  // Left out for overlap, the account's units are removable: removing them leaves folio 2's record as it is.
  const amfiRecords = new Map([["folio|1|amc:Fictiva Mutual Fund", new Map([[fundRef("119551"), ["INFZ90K01FC8", "CAMS|FFCDG"]]])]]);
  const [overlap] = plan(statementOf("2025-04-30", folioOf("1", flexi("110")), folioOf("2", share(T, "10"))), {
    account: folio2Out, asset: (h) => (h.isin === T ? asset(h) : amfi), heldElsewhere: tracking,
    existing: () => ({ ...flexiAsset("100"), positions: [...flexiAsset("100").positions, ...sharesHeld([T, "10"]).positions] }),
    remembered: (s) => amfiRecords.get(s.id) ?? others(),
  });
  const row = overlap.positions.find((p) => p.ref === fundRef("119551"));
  assert.deepEqual(row.removable?.map((s) => s.label), ["Fictiva Mutual Fund, folio 1"]);
  assert.deepEqual(savedOf(overlap, keeping(row.key, false)), [[`asset-${T}`, "10"]]);
  assert.deepEqual(recordedRefs(overlap, keeping(row.key, false)), [["folio|1|amc:Fictiva Mutual Fund", []]]);
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

test("a CDSL statement's folio funds are searched and named without the printed scheme code", async () => {
  const data = await fixture("made-up-cdsl");
  const cdsl = readHoldings(data);
  const folios = cdsl.sources.filter((s) => s.kind === "folio");
  const funds = folios.flatMap((s) => s.holdings);
  // The searched name, and the printed name kept in the details.
  assert.deepEqual(funds.map((h) => [h.name, fundName(h.name), h.details.name]), [
    ["Fictiva Flexi Cap Fund - Direct Plan - Growth", "Fictiva Flexi Cap Fund", "FFCDG - Fictiva Flexi Cap Fund - Direct Plan - Growth"],
    ["Fictiva Midcap Fund - Direct Plan - Growth", "Fictiva Midcap Fund", "FMCDG - Fictiva Midcap Fund - Direct Plan - Growth"],
    ["Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout", "Testbridge Corporate Bond Fund", "TCBRP - Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout"],
    ["Testbridge Gilt Fund - Direct Plan - Growth", "Testbridge Gilt Fund", "TGLDG - Testbridge Gilt Fund - Direct Plan - Growth"],
  ]);
  // A new asset uses the scheme name, even with a choice remembered before this fix.
  const remembered = (h) => ({ ...statementAsset(h), name: h.details.name });
  for (const asset of [statementAsset, remembered]) {
    const [account] = plan({ ...cdsl, sources: folios }, { asset });
    assert.deepEqual(account.positions.map((p) => p.name), funds.map((h) => h.name));
    assert.deepEqual(snapshotOf(account, noChoices).holdings.map((h) => [h.symbol, h.name]), funds.map((h) => [h.isin, h.name]));
  }
  for (const h of funds) assert.equal(assetDetails(h, {}, "EQUITY").casStatement.name, h.details.name);

  // Existing coded assets are reused by identity, without sending a replacement name.
  const [again] = plan({ ...cdsl, sources: folios }, {
    asset: remembered,
    existing: () => ({ ...none, positions: funds.map((h) => ({
      assetId: h.isin, symbol: h.isin, ref: fundRef(h.isin), name: h.details.name, units: h.units, cost: h.cost, currency: "INR", manual: true,
    })) }),
  });
  assert.deepEqual(snapshotOf(again, noChoices).holdings.map((h) => [h.assetId, h.name]), funds.map((h) => [h.isin, undefined]));

  // Other statements, and CDSL demat accounts, keep their names as printed, even ones that look coded.
  const coded = (name) => `ABC12 - ${name}`;
  for (const f of data.accounts.flatMap((a) => a.mutual_funds)) f.name = coded(f.name);
  const nsdl = await fixture("made-up-nsdl");
  for (const f of nsdl.accounts.flatMap((a) => a.mutual_funds)) f.name = coded(f.name);
  const summaries = await Promise.all(["made-up-summary-cams", "made-up-summary-kfintech"].map(fixture));
  for (const s of summaries.flatMap((d) => d.folios.flatMap((f) => f.schemes))) s.scheme = coded(s.scheme);
  const kept = (statement, keep = () => true) => readHoldings(statement).sources.filter(keep).flatMap((s) => s.holdings).filter((h) => h.kind === "fund");
  const unchanged = [...kept(data, (s) => s.kind === "demat"), ...kept(nsdl), ...summaries.flatMap((d) => kept(d))];
  assert.equal(unchanged.length, 20);
  for (const h of unchanged) assert.equal(h.name, h.details.name);
  for (const h of unchanged) assert.match(h.name, /^ABC12 - /);
});

test("CDSL folio scheme codes can contain digits and leave the rest of the name intact", async () => {
  const data = await fixture("made-up-cdsl");
  const folio = data.accounts.find((a) => a.type === "Mutual Fund Folios");
  const fund = folio.mutual_funds[0];
  data.accounts = [folio];
  folio.mutual_funds = [fund];
  for (const [printed, expected] of [
    ["  AB12\t- Fictiva Multi-Asset Fund - Direct Plan - Growth", "Fictiva Multi-Asset Fund - Direct Plan - Growth"],
    ["123-Fictiva Midcap Fund", "Fictiva Midcap Fund"],
    ["Fictiva Multi-Asset Fund - Direct Plan - Growth", "Fictiva Multi-Asset Fund - Direct Plan - Growth"],
    ["AB12 - ", "AB12 - "],
    [null, fund.isin],
  ]) {
    fund.name = printed;
    const holding = readHoldings(data).sources[0].holdings[0];
    assert.equal(holding.name, expected);
    assert.equal(holding.details.name, printed ?? undefined);
  }
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
  // Each split counts on its day in Wealthfolio's timezone, whatever the device's. The snapshot is
  // dated 31-Jan-2025 and the statement 31-Mar-2025; each date lists the timezones that flag it.
  const india = "Asia/Kolkata";
  const newYork = "America/New_York";
  const everywhere = [india, newYork, "UTC"];
  inLocalTimeZones(() => {
    for (const [date, flagged] of [
      ["2025-01-30T23:59:00+05:30", []],
      ["2025-01-31T00:30:00+05:30", [india]],
      ["2025-01-31T05:29:00+05:30", [india]],
      ["2025-01-31T05:30:00+05:30", [india, "UTC"]],
      ["2025-01-31T12:00:00Z", everywhere],
      ["2025-01-30T23:00:00-05:00", [india, "UTC"]],
      ["2025-01-31T00:00:00-05:00", everywhere],
      ["2025-02-15T00:00:00Z", everywhere],
      ["2025-03-31T23:59:00+05:30", everywhere],
      ["2025-04-01T00:30:00+05:30", [newYork, "UTC"]],
      ["2025-03-31T23:59:00-04:00", [newYork]],
      ["2025-04-01T00:00:00-04:00", []],
      [new Date("2025-01-31T00:30:00+05:30"), [india]],
      [new Date("2025-03-31T23:59:00-04:00"), [newYork]],
      // A bare date stays as given, and an unreadable one is flagged.
      ["2025-01-30", []],
      ["2025-01-31", everywhere],
      ["2025-03-31", everywhere],
      ["2025-04-01", []],
      ["invalid", everywhere],
      [undefined, everywhere],
      ["", everywhere],
      [null, everywhere],
      [new Date(NaN), everywhere],
      ["2025-13-01", everywhere],
      ["2025-02-30", everywhere],
      ["2025-04-31", everywhere],
      ["2025-01-31T00:30:00", everywhere],
      ["2025-03-31T23:59:00", everywhere],
    ]) {
      for (const timeZone of everywhere) {
        const expected = flagged.includes(timeZone) ? ["share"] : [];
        assert.deepEqual([...splitSince(existing, "2025-03-31", [split(date)], timeZone)], expected, `${date} in ${timeZone}`);
      }
    }
    for (const timeZone of everywhere) {
      assert.deepEqual([...splitSince({ ...existing, date: "2025-03-01" }, "2025-03-31", [split("2025-02-30")], timeZone)], ["share"]);
    }
  });
  assert.deepEqual([...splitSince(existing, "2025-03-31", [split("2025-02-15", { activityType: "BUY", activityTypeOverride: "SPLIT" })], "UTC")], ["share"]);
  assert.deepEqual([...splitSince(existing, "2025-03-31", [
    split("2025-02-15", { assetId: "other" }),
    split("2025-02-15", { status: "DRAFT" }),
    split("2025-02-15", { activityType: "BUY" }),
  ], "UTC")], []);
  // A snapshot on the statement's date is replaced, not carried.
  assert.deepEqual([...splitSince({ ...existing, date: "2025-03-31" }, "2025-03-31", [split("invalid")], "UTC")], []);
  assert.deepEqual([...splitSince(none, "2025-03-31", [split("2025-02-15")], "UTC")], []);

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
  checkUnits(holdings, { asset, accounts: transactionAccounts, activities, identities: identitiesOf(activities), timeZone: "UTC", ...more });
const summarised = (checks) => checks.map((c) => [
  c.ref, c.lines.map((l) => l.source.label), format(c.statement),
  c.accounts.map((a) => [a.id, a.units === undefined ? null : format(a.units)]),
  c.held === undefined ? null : format(c.held), c.problem ?? null,
]);

test("checks each holding's units against accounts that track transactions, each asset and account once", async () => {
  const data = await fixture("made-up-summary-cams");
  const [first] = data.folios;
  // A second folio in the same account: one more Flexi Cap line, and the Liquid fund printed with zero units.
  data.folios.push({ ...first, folio: "91234568 / 34", schemes: [worth(first.schemes[0], "107.896"), worth(first.schemes[1], "0.000")] });
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

test("a fund conversion's units count for the fund they move into, not the one they leave", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const conversion = (subtype, isin, quantity) =>
    activity("account-1", "ADJUSTMENT", "2024-08-01", isin, quantity, { subtype, unitPrice: null, sourceGroupId: "merger-1" });
  const activities = [
    activity("account-1", "BUY", "2024-04-01", "INFZ90K01FC8", "892.104"),
    // A merged fund, not on the statement, whose 1500 units became 2000 of the Flexi Cap fund.
    activity("account-1", "BUY", "2024-04-01", "INFZ90K01MG1", "1500"),
    conversion("CONVERSION_OUT", "INFZ90K01MG1", "1500"),
    conversion("CONVERSION_IN", "INFZ90K01FC8", "2000"),
  ];
  const flexiCap = check(holdings, activities).find((c) => c.ref === "asset-INFZ90K01FC8");
  assert.equal(format(flexiCap.held), "2892.104");
  assert.equal(unitStatus(flexiCap, true), "match");
});

test("activities count towards the statement's date on their day in Wealthfolio's timezone, whatever the device's", async () => {
  const holdings = readHoldings(await fixture("made-up-summary-cams"));
  const bought = activity("account-1", "BUY", "2024-04-01", "INFZ90K01FC8", "3000");
  // Entered in Wealthfolio's form at 02:00 on 01-Apr-2025 in India, and at 21:00 on 31-Mar-2025 in Toronto.
  const india = { ...activity("account-1", "BUY", "2025-04-01", "INFZ90K01FC8", "1"), date: "2025-03-31T20:30:00+00:00" };
  const toronto = { ...activity("account-1", "BUY", "2025-03-31", "INFZ90K01FC8", "2"), date: "2025-04-01T01:00:00+00:00" };
  const bare = (date) => ({ ...activity("account-1", "BUY", date, "INFZ90K01FC8", "4"), date });
  const held = (row, timeZone) => format(check(holdings, [bought, row], { timeZone }).find((c) => c.ref === "asset-INFZ90K01FC8").held);
  inLocalTimeZones(() => {
    assert.equal(held(india, "Asia/Kolkata"), "3000");
    assert.equal(held(toronto, "America/Toronto"), "3002");
    assert.equal(held(india, "UTC"), "3001");
    assert.equal(held(toronto, "UTC"), "3000");
    // A bare date stays as given, not UTC midnight on it.
    assert.equal(held(bare("2025-03-31"), "America/Toronto"), "3004");
    assert.equal(held(bare("2025-04-01"), "America/Toronto"), "3000");
  });
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
  data.folios = [{ ...first, schemes: [worth(first.schemes[0], "10")] }, { ...first, folio: "91234568 / 34", schemes: [{ ...worth(first.schemes[0], "20"), isin: null }] }];
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

/** The made-up summary statement, with three lines as casparser 1.4.1 can misread them without a warning. */
async function misreadSummary() {
  const data = await fixture("made-up-summary-cams");
  const [, liquid] = data.folios[0].schemes;
  const [balanced] = data.folios[1].schemes;
  const [bond] = data.folios[2].schemes;
  // ₹1,16,45,808.40 and a cost of ₹1,10,00,000.00 lose their leading digit, which the cost's adds to the name.
  data.folios[0].schemes[1] = {
    ...liquid, scheme: `${liquid.scheme} 1`, close: "4000.000", valuation: { ...liquid.valuation, cost: "1000000.00", value: "1645808.40" },
  };
  // A NAV and value printed "N.A." come back as 0.
  data.folios[1].schemes[0] = { ...balanced, valuation: { ...balanced.valuation, nav: "0", value: "0" } };
  // Units printed "N.A." come back as 0.
  data.folios[2].schemes[0] = { ...bond, close: "0" };
  return data;
}
const MISREAD = ["INFZ90K01LQ6", "INFZ90K01BA1", "INFZ91T01CB6"];

test("a summary line whose units × NAV don't give its value is left out as possibly misread", async () => {
  const holdings = readHoldings(await misreadSummary());
  const tail = ", so the line may have been misread. Check it against the PDF. The import leaves this holding as it is.";
  assert.deepEqual(holdings.leftOut, [
    {
      source: "Fictiva Mutual Fund, folio 91234567 / 12", name: "Fictiva Liquid Fund - Direct Plan - Growth 1",
      reason: `Its value of ₹1645808.40 differs from 4000.000 units × NAV 2911.4521 by more than the units' and NAV's rounding${tail}`,
    },
    { source: "Fictiva Mutual Fund, folio 91234570/0", name: holdings.sources[1].misread[0].name, reason: `It has 3443.910 units but no NAV${tail}` },
    { source: "Testbridge Mutual Fund, folio 1040012345", name: holdings.sources[2].misread[0].name, reason: `It has no units but a value of ₹102183.67${tail}` },
  ]);
  // Kept to reconcile, but never a holding or a printed zero, so neither their cost nor their price is used.
  assert.deepEqual(holdings.sources.map((s) => s.misread.map((h) => h.isin)), [[MISREAD[0]], [MISREAD[1]], [MISREAD[2]]]);
  assert.ok(holdings.sources.every((s) => s.zero === undefined && s.holdings.every((h) => !MISREAD.includes(h.isin))));

  // Units printed to three decimals: a value off by less than their rounding still matches.
  const data = await fixture("made-up-summary-cams");
  const liquid = data.folios[0].schemes[1];
  const valued = (value) => readHoldings({ ...data, folios: [{ ...data.folios[0], schemes: [{ ...liquid, valuation: { ...liquid.valuation, value } }] }] });
  // 12.296 × 2911.4521 = 35799.215; half a unit's last decimal is worth ₹1.46.
  for (const value of ["35799.22", "35799.21", "35800.38", "35798.05"]) {
    assert.deepEqual([value, valued(value).leftOut, valued(value).sources[0].holdings.length], [value, [], 1]);
  }
  for (const value of ["35800.70", "35797.70", "0"]) assert.deepEqual([value, valued(value).sources[0].misread.length], [value, 1]);
  // A NAV printed to four decimals can hide rounding worth several rupees on many units.
  for (const issuer of ["made-up-summary-cams", "made-up-summary-kfintech"]) {
    const summary = await fixture(issuer);
    const line = summary.folios[0].schemes[0];
    const rounded = (value) => readHoldings({ ...summary, folios: [{ ...summary.folios[0], schemes: [{
      ...line, close: "100000.000", valuation: { ...line.valuation, nav: "10.1234", value },
    }] }] });
    // True NAVs 10.123449 and 10.123351 round to 10.1234.
    for (const value of ["1012344.90", "1012335.10", "1012345.01", "1012334.99"]) assert.deepEqual(rounded(value).leftOut, []);
    for (const value of ["1012345.02", "1012334.98"]) assert.equal(rounded(value).sources[0].misread.length, 1);
  }
  // A printed zero with no value is still only checked.
  const zero = readHoldings({ ...data, folios: [{ ...data.folios[0], schemes: [worth(liquid, "0")] }] });
  assert.deepEqual([zero.sources[0].zero.length, zero.sources[0].misread, zero.leftOut[0].reason], [1, undefined, "No units on the statement."]);
});

test("a misread line's fund keeps the account's units, cost, price and import record, or isn't added", async () => {
  const holdings = readHoldings(await misreadSummary());
  const misread = new Set(holdings.sources.flatMap((s) => s.misread ?? []));
  const refs = (account) => importedRefs(account, noChoices).map(({ source, refs }) => [source.id, Object.keys(refs)]);
  // Without an earlier position, none of them is added, remembered or priced.
  const [fresh] = plan(holdings, { asset: (h) => ({ ...asset(h), manual: true }) });
  assert.deepEqual(fresh.positions.map((p) => p.ref), ["INFZ90K01FC8", "INFZ91T01GL6", "INFZ91T01FT1"].map(ref));
  assert.ok(refs(fresh).every(([, saved]) => MISREAD.every((isin) => !saved.includes(ref(isin)))));
  assert.ok(pricesToSave(fresh, noChoices).every((p) => !MISREAD.map(ref).includes(p.ref)));

  // An earlier import of each folio added them.
  const [first] = plan(readHoldings(await fixture("made-up-summary-cams")));
  const earlier = new Map(importedRefs(first, noChoices).map(({ source, refs }) => [source.id, new Map(Object.entries(refs))]));
  const position = (isin, more = {}) =>
    ({ assetId: `asset-${isin}`, ref: ref(isin), symbol: isin, name: `Asset ${isin}`, units: "100", cost: "1000", currency: "INR", ...more });
  const existing = { ...none, date: "2025-02-28", positions: [
    position(MISREAD[0], { manual: true, price: { close: "2900", currency: "INR" } }),
    position(MISREAD[1]),
    position(MISREAD[2]),
  ] };
  const kept = MISREAD.map((isin) => ({ assetId: `asset-${isin}`, symbol: isin, quantity: "100", currency: "INR", averageCost: "10" }));
  // By the asset confirmed for the line, or else by the identifiers the earlier import recorded.
  for (const confirmed of [asset, (h) => (misread.has(h) ? undefined : asset(h))]) {
    const [account] = plan(holdings, { asset: confirmed, existing: () => existing, remembered: (s) => earlier.get(s.id) });
    const held = account.positions.filter((p) => p.misread);
    assert.deepEqual(held.map((p) => [p.ref, p.lines.length, p.include]), MISREAD.map((isin) => [ref(isin), 0, true]));
    assert.deepEqual(held[0].notes, [
      "Its line in Fictiva Mutual Fund, folio 91234567 / 12 may have been misread, so this import leaves it as it is: its units, cost and price stay. Check it against the PDF.",
    ]);
    // Units that can't be read no longer look sold.
    assert.ok(account.positions.every((p) => !p.notes.some((note) => note.startsWith("Not on the statement any more"))));
    const saved = snapshotOf(account, noChoices).holdings;
    assert.deepEqual(saved.filter((h) => MISREAD.includes(h.symbol)), kept);
    // The preview offers no choice.
    const everything = { flipped: new Set(account.positions.map((p) => p.key)), costs: new Map() };
    assert.deepEqual(snapshotOf(account, everything).holdings.filter((h) => MISREAD.includes(h.symbol)), kept);
    assert.ok(held.every((p) => included(p, everything)));
    assert.deepEqual(
      importedRefs(account, everything).map(({ source, refs }) => [source.id, MISREAD.map(ref).filter((r) => r in refs).map((r) => refs[r])]),
      [...earlier].map(([id, records]) => [id, MISREAD.map(ref).filter((r) => records.has(r)).map((r) => records.get(r))]),
    );
    // The manual-priced one gets back the price it had, or another account's statement price for the date.
    assert.deepEqual(pricesToSave(account, noChoices).map((p) => [p.assetId, p.price, p.from]), [[`asset-${MISREAD[0]}`, "2900", "earlier"]]);
    assert.deepEqual(
      pricesToSave(account, noChoices, new Map([[ref(MISREAD[0]), "2911.4521"]])).map((p) => [p.assetId, p.price, p.from]),
      [[`asset-${MISREAD[0]}`, "2911.4521", "statement"]],
    );
  }
  // Without its price on or before the date, the row says what Wealthfolio does.
  const unpriced = { ...existing, positions: [position(MISREAD[0], { manual: true }), ...existing.positions.slice(1)] };
  const [account] = plan(holdings, { existing: () => unpriced, remembered: (s) => earlier.get(s.id) });
  assert.match(account.positions.find((p) => p.ref === ref(MISREAD[0])).notes[1], /no price on or before this date.*average cost as its price/);
});

test("a fund in two folios, one misread, keeps the account's units and needs review in the check", async () => {
  const data = await fixture("made-up-summary-cams");
  const [first] = data.folios;
  const flexi = first.schemes[0];
  data.folios = [first, { ...first, folio: "91234568 / 34", schemes: [{ ...flexi, close: "0" }] }];
  const holdings = readHoldings(data);
  const [listed, unread] = holdings.sources;
  const line = unread.misread[0];
  const note = "Its line in Fictiva Mutual Fund, folio 91234568 / 34 may have been misread";
  const flexiOf = (account) => account.positions.find((p) => p.ref === ref(flexi.isin));
  // By the asset confirmed for it, or else by its ISIN, which the other folio's line prints.
  for (const confirmed of [asset, (h) => (h === line ? undefined : asset(h))]) {
    // Without an earlier position, neither line is imported.
    const [fresh] = plan(holdings, { asset: confirmed });
    const position = flexiOf(fresh);
    assert.deepEqual([position.lines.map((l) => l.source), position.misread.map((l) => l.source), position.include], [[listed], [unread], false]);
    assert.deepEqual(position.notes, [`${note}, so it isn't imported. Check it against the PDF.`]);
    for (const choices of [noChoices, { flipped: new Set([position.key]), costs: new Map() }]) {
      assert.ok(!snapshotOf(fresh, choices).holdings.some((h) => h.symbol === flexi.isin));
      assert.ok(importedRefs(fresh, choices).every(({ refs }) => !(ref(flexi.isin) in refs)));
    }
    // With one, the account keeps all of its units and cost.
    const [held] = plan(holdings, { asset: confirmed, existing: () => ({ ...none, positions: [{
      assetId: "flexi", ref: ref(flexi.isin), symbol: flexi.isin, name: "Flexi", units: "3000", cost: "150000", currency: "INR",
    }] }) });
    assert.match(flexiOf(held).notes[0], /^Its line in .* so this import leaves it as it is/);
    assert.deepEqual(snapshotOf(held, { flipped: new Set([flexiOf(held).key]), costs: new Map() }).holdings.find((h) => h.assetId === "flexi"),
      { assetId: "flexi", symbol: flexi.isin, quantity: "3000", currency: "INR", averageCost: "50" });

    // The check can't compare a partial total.
    const activities = [activity("account-1", "BUY", "2024-04-01", flexi.isin, "2892.104")];
    const [checked] = check(holdings, activities, { asset: confirmed }).filter((c) => c.ref === `asset-${flexi.isin}`);
    assert.deepEqual(summarised([checked]), [[
      `asset-${flexi.isin}`, [listed.label], "2892.104", [["account-1", "2892.104"]], "2892.104",
      `${note}, so its units on the statement are unknown. Check it against the PDF.`,
    ]]);
    assert.deepEqual(checked.misread.map((l) => l.source), [unread]);
    assert.equal(unitStatus(checked, true), "review");
  }
  // A held-back asset's old import key survives a renamed display code or a new confirmed symbol.
  const oldRef = ref("OLD");
  const records = new Map([[oldRef, [flexi.isin, `CAMS|${flexi.rta_code}`]]]);
  for (const current of ["OLD", "NEW"]) {
    const [renamed] = plan(holdings, {
      asset: (h) => ({ ...asset(h), symbol: "NEW", assetId: h.isin === flexi.isin ? "flexi" : "liquid" }),
      existing: () => ({ ...none, positions: [{
        assetId: "flexi", ref: ref(current), symbol: current, name: "Flexi", units: "3000", cost: "150000", currency: "INR",
      }] }),
      remembered: () => records,
    });
    assert.ok(renamed.positions.find((p) => p.existing?.assetId === "flexi").misread);
    assert.deepEqual(importedRefs(renamed, noChoices).map(({ refs }) => refs[oldRef]), [[flexi.isin, `CAMS|${flexi.rta_code}`], [flexi.isin, `CAMS|${flexi.rta_code}`]]);
  }
  // A folio that goes to another account doesn't hold this account's fund back.
  const accounts = plan(holdings, { account: (s) => (s === unread ? "holdings-2" : "holdings-1") });
  assert.deepEqual(accounts.map((a) => [a.accountId, flexiOf(a)?.include, flexiOf(a)?.units]), [["holdings-1", true, "2892.104"], ["holdings-2", undefined, undefined]]);

  // Quotes belong to the asset: a held-back holding takes the other account's statement price, so
  // the accounts agree whichever saves last.
  const priced = plan(holdings, {
    account: (s) => (s === unread ? "holdings-2" : "holdings-1"),
    asset: (h) => ({ ...asset(h), manual: true }),
    existing: () => ({ ...none, positions: [{
      assetId: "flexi", ref: ref(flexi.isin), symbol: flexi.isin, name: "Flexi", units: "100", cost: "1000", currency: "INR", manual: true,
      price: { close: "7", currency: "INR" },
    }] }),
  });
  const prices = new Map(priced.flatMap((p) => pricesToSave(p, noChoices).filter((p) => p.from === "statement").map((p) => [p.ref, p.price])));
  assert.deepEqual(priced.map((p) => [
    flexiOf(p).misread?.length, pricesToSave(p, noChoices, prices).filter((x) => x.ref === ref(flexi.isin)).map((x) => [x.price, x.from]),
  ]), [
    [undefined, [[flexi.valuation.nav, "statement"]]],
    [1, [[flexi.valuation.nav, "statement"]]],
  ]);

  // A misread line with no other: its own check when its asset is confirmed, with other problems after.
  const alone = readHoldings({ ...data, folios: [data.folios[1]] });
  const [own] = check(alone, []);
  assert.deepEqual([own.ref, own.lines, own.misread.length, format(own.statement), unitStatus(own, true)], [ref(flexi.isin), [], 1, "0", "review"]);
  assert.equal(own.problem, `${note}, so its units on the statement are unknown. Check it against the PDF. No account that tracks transactions has posted activities for it on or before 2025-03-31.`);
  assert.deepEqual(check(alone, [], { asset: () => undefined }), []);
});

test("a statement's price that isn't positive is never saved", () => {
  const h = { kind: "share", isin: "INEZ1", rta: null, rtaCode: null, name: "Unlisted", units: "10", price: "0", value: "0", cost: null };
  const source = (n, holding) => ({ id: `demat|${n}|${n}`, kind: "demat", label: `Demat ${n}`, holdings: [holding] });
  const holdings = { date: "2025-03-31", investor: "x", leftOut: [], sources: [source(1, h)] };
  const manual = (holding) => ({ ...asset(holding), manual: true });
  // A new asset gets none, and its row says to enter one.
  const [fresh] = plan(holdings, { asset: manual });
  assert.deepEqual(pricesToSave(fresh, noChoices), []);
  assert.deepEqual(fresh.positions[0].notes, ["Priced by hand, but the statement prints no price for it. Enter its price for this date on its asset page after saving."]);
  // Another line's positive price is the statement's.
  const [two] = plan({ ...holdings, sources: [source(1, h), source(2, { ...h, price: "12", value: "120" })] }, { asset: manual });
  assert.deepEqual(pricesToSave(two, noChoices).map((p) => [p.price, p.from]), [["12", "statement"]]);
  // One the account has gets back the price it had, whatever another account's import lists that isn't positive.
  const existing = { ...none, positions: [{
    assetId: "kept", ref: ref("INEZ1"), symbol: "INEZ1", name: "Unlisted", units: "10", cost: "100", currency: "INR", manual: true, price: { close: "9", currency: "INR" },
  }] };
  const [held] = plan(holdings, { asset: manual, existing: () => existing });
  const keep = { flipped: new Set([held.positions[0].key]), costs: new Map() };
  for (const choices of [noChoices, keep]) {
    for (const elsewhere of [undefined, "0", "-1", "0.00"]) {
      const listed = new Map(elsewhere === undefined ? [] : [[ref("INEZ1"), elsewhere]]);
      assert.deepEqual(pricesToSave(held, choices, listed).map((p) => [p.assetId, p.price, p.from]), [["kept", "9", "earlier"]]);
    }
  }
  assert.deepEqual(pricesToSave(held, keep, new Map([[ref("INEZ1"), "11"]])).map((p) => [p.price, p.from]), [["11", "statement"]]);
});
