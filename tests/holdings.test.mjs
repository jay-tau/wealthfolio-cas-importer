import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dec, div, format, mul } from "../src/cas/decimal.ts";
import {
  assetDetails,
  assetName,
  assetNames,
  checkUnits,
  existingCost,
  importedRefs,
  included,
  keepsDetails,
  labels,
  npsSymbol,
  planSnapshots,
  pricesToSave,
  readHoldings,
  reconcileRecord,
  security,
  registrarSymbol,
  replacesSnapshot,
  snapshotOf,
  splitSince,
  isStatementAsset,
  statementAsset,
  statementSymbol,
  undecided,
  unidentified,
  unitStatus,
  unlistedRefs,
} from "../src/cas/holdings.ts";
import { fundRef } from "../src/cas/plan.ts";
import { holdingKey } from "../src/lib/choices.ts";
import { fundQuery, mayBeCut, planAndOption } from "../src/lib/fund-name.ts";

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
      ["demat|19999901|00012345", 6],
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

test("tells apart two fund houses' depository folios with the same number, or without one, by their first fund", async () => {
  const data = await fixture("made-up-cdsl");
  const folios = data.accounts.find((a) => a.type === "Mutual Fund Folios");
  const before = readHoldings(data).sources.filter((s) => s.kind === "folio");
  // Folios that read differently keep their labels.
  assert.deepEqual(before.map((s) => s.label), ["Folio 91234567/12", "Folio 1040012345"]);

  // The second fund house's folio gets the first one's number, and each fund house a fund without a folio number.
  for (const f of folios.mutual_funds) if (f.folio === "1040012345") f.folio = "91234567/12";
  const [flexi, bond] = folios.mutual_funds;
  folios.mutual_funds.push(
    { ...flexi, name: "FLRDG - Fictiva Liquid Fund - Direct Plan - Growth", isin: "INFZ90K01LQ6", folio: null },
    { ...bond, name: "TSTRG - Testbridge Short Term Fund - Regular Plan - Growth", isin: "INFZ91T01ST2", folio: null },
    { ...bond, name: "TONDG - Testbridge Overnight Fund - Direct Plan - Growth", isin: "INFZ91T01ON4", folio: null, balance: "0", value: "0" },
  );
  const holdings = readHoldings(data);
  const sources = holdings.sources.filter((s) => s.kind === "folio");
  assert.deepEqual(sources.map((s) => [s.id, s.label, s.holdings.length]), [
    ["folio|91234567/12|INFZ90K", "Folio 91234567/12 (Fictiva Flexi Cap Fund - Direct Plan - Growth and 1 other fund)", 2],
    ["folio|91234567/12|INFZ91T", "Folio 91234567/12 (Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout and 1 other fund)", 2],
    ["folio||INFZ90K", "Mutual fund folios (Fictiva Liquid Fund - Direct Plan - Growth)", 1],
    ["folio||INFZ91T", "Mutual fund folios (Testbridge Short Term Fund - Regular Plan - Growth and 1 other fund)", 1],
  ]);
  // The left-out line names the folio the same way, and notes name each folio.
  assert.deepEqual(holdings.leftOut.filter((l) => l.source.startsWith("Mutual")), [{
    source: "Mutual fund folios (Testbridge Short Term Fund - Regular Plan - Growth and 1 other fund)",
    name: "Testbridge Overnight Fund - Direct Plan - Growth",
    reason: "No units on the statement.",
  }]);
  assert.equal(labels(sources.slice(0, 2)), `${sources[0].label} and ${sources[1].label}`);

  // Folios whose first funds have the same name also get its ISIN.
  for (const f of folios.mutual_funds) if (f.folio === null) f.name = "Liquid Fund";
  assert.deepEqual(readHoldings(data).sources.filter((s) => s.id.startsWith("folio||")).map((s) => s.label), [
    "Mutual fund folios (Liquid Fund, INFZ90K01LQ6)",
    "Mutual fund folios (Liquid Fund, INFZ91T01ST2 and 1 other fund)",
  ]);

  // The browser collapses spaces, so different spacing doesn't tell two names apart.
  for (const f of folios.mutual_funds) if (f.folio === null && f.isin.startsWith("INFZ90K")) f.name = "  Liquid  Fund\n";
  assert.deepEqual(readHoldings(data).sources.filter((s) => s.id.startsWith("folio||")).map((s) => s.label), [
    "Mutual fund folios (Liquid Fund, INFZ90K01LQ6)",
    "Mutual fund folios (Liquid Fund, INFZ91T01ST2 and 1 other fund)",
  ]);

  for (const name of ["", null]) {
    for (const f of folios.mutual_funds) if (f.folio === null) f.name = name;
    assert.deepEqual(readHoldings(data).sources.filter((s) => s.id.startsWith("folio||")).map((s) => s.label), [
      "Mutual fund folios (INFZ90K01LQ6)",
      "Mutual fund folios (INFZ91T01ST2 and 1 other fund)",
    ]);
  }
});

test("tells apart depository folios whose fund names and counts give the same label", async () => {
  for (const fileType of ["NSDL", "CDSL"]) {
    const data = await fixture("made-up-cdsl");
    data.file_type = fileType;
    const folios = data.accounts.find((a) => a.type === "Mutual Fund Folios");
    const [flexi, bond] = folios.mutual_funds;
    folios.mutual_funds = [
      { ...flexi, folio: "123", name: "Liquid Fund and 1 other fund" },
      { ...bond, folio: "123", name: "Liquid Fund" },
      { ...bond, folio: "123", name: "Overnight Fund", isin: "INFZ91T01ON4", balance: "0", value: "0" },
      { ...flexi, folio: "123", name: "Liquid Fund and 1 other fund, INFZ90K01FC8", isin: "INFZ92A01LQ6" },
    ];
    const holdings = readHoldings(data);
    const sources = holdings.sources.filter((s) => s.kind === "folio");
    assert.deepEqual(sources.map((s) => [s.label, s.holdings.length]), [
      ["Folio 123 (Liquid Fund and 1 other fund), INFZ90K01FC8", 1],
      ["Folio 123 (Liquid Fund and 1 other fund), INFZ91T01CB6", 1],
      ["Folio 123 (Liquid Fund and 1 other fund, INFZ90K01FC8)", 1],
    ]);
    assert.equal(labels(sources), sources.map((s) => s.label).join(" and "));
    assert.deepEqual(holdings.leftOut.filter((l) => l.source.startsWith("Folio")), [{
      source: sources[1].label, name: "Overnight Fund", reason: "No units on the statement.",
    }]);
  }
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
  // Not on the statement any more: asked, never removed by default.
  assert.deepEqual(byRef(ref("OLD")).ask, { kind: "missing" });
  assert.deepEqual(byRef(ref("OLD")).removable.map((s) => s.label), ["Testbridge Mutual Fund, folio 1040012345"]);
  assert.deepEqual(byRef(ref("OLD")).notes, []);
  assert.equal(undecided(byRef(ref("OLD")), noChoices), true);
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
  // Set to zero by the user's answer.
  const zero = { ...noChoices, keep: new Map([[ref("OLD"), false]]) };
  assert.equal(undecided(byRef(ref("OLD")), zero), false);
  assert.equal(snapshotOf(account, zero).holdings.find((h) => h.symbol === "OLD"), undefined);

  // Keeping the sold one by the user's answer; flipping the hand-added one drops it; a typed cost replaces Wealthfolio's, blank means unknown.
  const flipped = new Set([ref("GILT")]);
  const keep = new Map([[ref("OLD"), true]]);
  const choices = { flipped, keep, costs: new Map([[ref("INFZ91T01GL6"), ""]]) };
  const after = snapshotOf(account, choices).holdings;
  assert.equal(after.find((h) => h.symbol === "GILT"), undefined);
  assert.deepEqual(after.find((h) => h.symbol === "OLD"), { assetId: "a-old", symbol: "OLD", quantity: "5", currency: "INR", averageCost: "10" });
  assert.equal(after.find((h) => h.symbol === "INFZ91T01GL6").averageCost, undefined);
  const typed = snapshotOf(account, { flipped, keep, costs: new Map([[ref("INFZ91T01GL6"), "42275.60"]]) }).holdings;
  assert.equal(typed.find((h) => h.symbol === "INFZ91T01GL6").averageCost, "50");

  assert.deepEqual(
    importedRefs(account, zero).map(({ source, refs }) => [source.id, refs]),
    [
      ["folio|91234567/12|amc:Fictiva Mutual Fund", { [ref("INFZ90K01FC8")]: ["INFZ90K01FC8", "CAMS|FFCDG"], [ref("INFZ90K01LQ6")]: ["INFZ90K01LQ6", "CAMS|FLQDG"] }],
      ["folio|91234570/0|amc:Fictiva Mutual Fund", { [ref("INFZ90K01BA1")]: ["INFZ90K01BA1", "CAMS|FBADR"] }],
      ["folio|1040012345|amc:Testbridge Mutual Fund", { [ref("INFZ91T01CB6")]: ["INFZ91T01CB6", "KFINTECH|TCBRP"], [ref("INFZ91T01GL6")]: ["INFZ91T01GL6", "KFINTECH|TGLDG"], [ref("INFZ91T01FT1")]: ["INFZ91T01FT1", "KFINTECH|TFT12"] }],
    ],
  );
});

test("an existing holding's cost is unknown when Wealthfolio sends none, a null one or 0", () => {
  for (const none of [undefined, null, { local: null, base: null }, { local: 0, base: 0 }]) assert.equal(existingCost(none), null, JSON.stringify(none));
  assert.equal(existingCost({ local: 1234.5, base: null }), "1234.5");
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
      ["brokerage", ["demat|19999901|00012345", "demat|IN999901|10012345"], 8, false],
      ["funds", ["folio|91234567/12|INFZ90K"], 2, true],
      ["pension", ["nps|XXXXXXXX9001"], 3, false],
    ],
  );
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

test("a source that lists nothing asks about each holding its earlier import added, never emptying the account", async () => {
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
    // Asked, with Keep as the safe answer: undecided keeps it, and saving waits for the answer.
    assert.deepEqual([account.positions[0].ask, account.positions[0].removable.map((s) => s.id)], [{ kind: "missing" }, [first.id]]);
    assert.equal(undecided(account.positions[0], noChoices), true);
    assert.deepEqual(snapshotOf(account, keeping(account.positions[0].key, true)).holdings.map((h) => h.assetId), ["old"]);
    // Set to zero: the account's other holdings and cash stay.
    assert.deepEqual(snapshotOf(account, keeping(account.positions[0].key, false)), { holdings: [], cash: { INR: "1500" } });
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
  const gone = sold.positions.find((p) => p.existing?.assetId === "earlier");
  assert.deepEqual(gone.ask, { kind: "missing" });
  assert.ok(!snapshotOf(sold, keeping(gone.key, false)).holdings.some((h) => h.assetId === "earlier"));
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
/** The user's answer to replace the asset an earlier import added with the statement row (true), or keep it (false). */
const replacing = (key, replace = true) => ({ flipped: new Set(), costs: new Map(), replace: new Map([[key, replace]]) });
/** A position's question: its `fundRef`, what it asks, the sources it asks about, and its notes. */
const asking = (p) => [p.ref, p.ask?.kind, p.removable?.map((s) => s.label), p.notes];
/** A replace question, with the labels of the sources whose earlier import added the old asset. */
const replaceAsk = (p) => p.ask && { ...p.ask, recorded: p.ask.recorded?.map((s) => s.label) };
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
  // Asked, on the statement row: until it's answered, the account keeps the old asset's 100 units and doesn't add the statement's 110.
  assert.equal(listed.include, false);
  assert.deepEqual(listed.replaces, [old.key]);
  assert.deepEqual([replaceAsk(listed), listed.notes], [{ kind: "replace", recorded: ["Fictiva Mutual Fund, folio 91234567 / 12"] }, []]);
  assert.equal(undecided(listed, noChoices), true);
  assert.equal(old.include, true);
  assert.equal(old.replacedBy, listed.key);
  assert.deepEqual([old.ask, old.notes], [undefined, []]);
  assert.deepEqual(savedOf(next), [["yahoo-asset", "100"]]);
  // Keeping the old asset answers it the same way.
  assert.equal(undecided(listed, replacing(listed.key, false)), false);
  assert.deepEqual(savedOf(next, replacing(listed.key, false)), [["yahoo-asset", "100"]]);
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

// Yahoo's asset, renamed in Wealthfolio after an earlier import of the folio recorded it.
const OLD = fundRef(yahoo.symbol, yahoo.exchangeMic);
const RENAMED = fundRef("RENAMED", "XBOM");
const renamed = { ...yahoo, symbol: "RENAMED", assetId: "yahoo-asset" };
const FLEXI = ["INFZ90K01FC8", "CAMS|FFCDG"];
const FOLIO_ID = "folio|91234567 / 12|amc:Fictiva Mutual Fund";
/** Folio 91234567 / 12's import of 2025-03-31: the fund under Yahoo's symbol. */
const march = () => recordsOf(plan(statementOf("2025-03-31", folioOf("91234567 / 12", flexi("100"))), { asset: () => yahoo })[0]);
const entriesOf = (records) => [...records.values()].map((refs) => [...refs]);
/** The remembered choice: Yahoo's result, confirmed when the asset had its symbol. */
const CHOSEN = [{ ...yahoo, assetId: "yahoo-asset" }];
/** A record without asset IDs, as versions before them saved it, reconciled by remembered choices. */
const byChoices = (remembered, existing, choices) => reconcileRecord({ remembered }, existing, choices).remembered;

test("a kept asset's import record follows it to its current symbol, so a later statement without it asks about it", () => {
  const records = march();
  assert.deepEqual(entriesOf(records), [[[OLD, FLEXI]]]);
  const april = statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110")));
  const current = heldBefore(renamed, "100");
  const inputs = [
    // The page's: the asset's current symbol everywhere, and the remembered choice's own symbol for the record.
    { existing: current, remembered: (s) => byChoices(records.get(s.id), current, CHOSEN) },
    // The account's position under the earlier symbol, which the asset ID matches to the statement's row.
    { existing: heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id) },
  ];
  for (const { existing, remembered } of inputs) {
    const [account] = plan(april, { asset: () => renamed, existing: () => existing, remembered });
    const [row] = account.positions;
    assert.deepEqual([account.positions.length, row.ref, row.existing.assetId, row.include, row.notes], [1, RENAMED, "yahoo-asset", true, []]);
    assert.deepEqual(entriesOf(recordsOf(account)), [[[RENAMED, FLEXI]]]);
    // Left out, the account keeps the asset's 100 units, and the folio's record both identifiers under its current symbol.
    const leftOut = replacing(row.key);
    assert.deepEqual(savedOf(account, leftOut), [["yahoo-asset", "100"]]);
    const kept = recordsOf(account, leftOut);
    assert.deepEqual(entriesOf(kept), [[[RENAMED, FLEXI]]]);
    // The folio's next statement lists no holdings: the user is asked whether to keep the asset or set it to zero.
    const [may] = plan(statementOf("2025-05-31", folioOf("91234567 / 12")), {
      asset: () => renamed, existing: () => ({ ...heldBefore(renamed, "100"), date: "2025-04-30" }), remembered: (s) => kept.get(s.id),
    });
    assert.deepEqual(may.positions.map(asking), [[RENAMED, "missing", [FOLIO], []]]);
    assert.deepEqual(savedOf(may, keeping(may.positions[0].key, false)), []);
  }
  // A statement without the holding right after the rename: its remembered choice still tells the asset.
  const sold = heldBefore(renamed, "100");
  const [next] = plan(statementOf("2025-04-30", folioOf("91234567 / 12")), {
    existing: () => sold, remembered: (s) => byChoices(records.get(s.id), sold, CHOSEN),
  });
  assert.deepEqual(next.positions.map(asking), [[RENAMED, "missing", [FOLIO], []]]);
  assert.deepEqual(entriesOf(recordsOf(next, keeping(next.positions[0].key, true))), [[[RENAMED, FLEXI]]]);
});

test("an import record stays with its own asset when its symbol is unchanged, has no record, or the holding is confirmed to another asset", () => {
  const records = march();
  const april = statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110")));
  const leftOut = (account) => entriesOf(recordsOf(account, replacing(account.positions[0].key)));

  // Unchanged: the record stays under the asset's symbol.
  const unchanged = heldBefore(yahoo, "100");
  const same = byChoices(records.get(FOLIO_ID), unchanged, CHOSEN);
  assert.deepEqual([...same], [[OLD, FLEXI]]);
  const [kept] = plan(april, { asset: () => ({ ...yahoo, assetId: "yahoo-asset" }), existing: () => unchanged, remembered: () => same });
  assert.deepEqual(leftOut(kept), [[[OLD, FLEXI]]]);

  // No record: nothing is added for the kept asset.
  const current = heldBefore(renamed, "100");
  const [unrecorded] = plan(april, {
    asset: () => renamed, existing: () => current, remembered: () => byChoices(new Map(), current, CHOSEN),
  });
  assert.deepEqual(leftOut(unrecorded), [[]]);

  // Confirmed to AMFI's asset, which the account holds too: neither asset takes Yahoo's record.
  const both = { ...current, positions: [...current.positions, { ...heldBefore(amfi, "5").positions[0], assetId: "amfi-asset" }] };
  const other = byChoices(records.get(FOLIO_ID), both, [{ ...amfi, assetId: "amfi-asset" }]);
  assert.deepEqual([...other], [[OLD, FLEXI]]);
  const [confirmed] = plan(april, { asset: () => ({ ...amfi, assetId: "amfi-asset" }), existing: () => both, remembered: () => other });
  assert.deepEqual(confirmed.positions.map((p) => [p.ref, p.include, p.notes]), [[fundRef(amfi.symbol), true, []], [RENAMED, true, []]]);
  assert.deepEqual(leftOut(confirmed), [[]]);
  assert.deepEqual(entriesOf(recordsOf(confirmed)), [[[fundRef(amfi.symbol), FLEXI]]]);

  // Nor does the earlier symbol move to its asset while the account holds another asset under it.
  const taken = { ...current, positions: [...current.positions, { ...heldBefore(yahoo, "5").positions[0], assetId: "another-asset" }] };
  assert.deepEqual([...byChoices(records.get(FOLIO_ID), taken, CHOSEN)], [[OLD, FLEXI]]);
  // Or when it isn't in the account, or remembered choices give the earlier symbol to two assets.
  assert.deepEqual([...byChoices(records.get(FOLIO_ID), { ...none, positions: [] }, CHOSEN)], [[OLD, FLEXI]]);
  const twice = [...CHOSEN, { ...yahoo, assetId: "amfi-asset" }];
  assert.deepEqual([...byChoices(records.get(FOLIO_ID), both, twice)], [[OLD, FLEXI]]);
  // A choice without an asset ID tells nothing.
  assert.deepEqual([...byChoices(records.get(FOLIO_ID), current, [yahoo])], [[OLD, FLEXI]]);
  // A search result's ref can differ from the profile ref the earlier import recorded.
  const search = [{ ...CHOSEN[0], symbol: "SEARCH" }];
  const unmatched = byChoices(records.get(FOLIO_ID), current, search);
  assert.deepEqual([...unmatched], [[OLD, FLEXI]]);
  const [unreconciled] = plan(april, { asset: () => renamed, existing: () => current, remembered: () => unmatched });
  assert.deepEqual(savedOf(unreconciled, replacing(unreconciled.positions[0].key)), [["yahoo-asset", "100"]]);
  assert.deepEqual(leftOut(unreconciled), [[]]);
});

/** Folio 91234567 / 12's import of 2025-03-31, with the ID of the asset its save created for Yahoo's result. */
const marchWithIds = () => {
  const [first] = plan(statementOf("2025-03-31", folioOf("91234567 / 12", flexi("100"))), { asset: () => yahoo });
  const [{ refs, ids }] = importedRefs(first, noChoices, new Map([[OLD, "yahoo-asset"]]));
  return { remembered: new Map(Object.entries(refs)), ids: new Map(Object.entries(ids)) };
};
/** A position the statement no longer lists, asked about: its ref, `include`, question and notes. */
const NOT_LISTED = [true, "missing", []];
const notListed = (p) => [p.ref, p.include, p.ask?.kind, p.notes];
/** A plan of `holdings` from the reconciled record of each source. */
const planReconciled = (holdings, existing, reconciled, more = {}) => plan(holdings, {
  existing: () => existing, remembered: (s) => reconciled(s)?.remembered ?? new Map(), recorded: (s) => reconciled(s) ?? {}, ...more,
});
const entriesAndIds = (account, choices = noChoices, found) => importedRefs(account, choices, found).map(({ refs, ids }) => [refs, ids]);

test("an import record follows its asset by the asset ID it recorded, whatever the remembered choice is", () => {
  const record = marchWithIds();
  assert.deepEqual([[...record.remembered], [...record.ids]], [[[OLD, FLEXI]], [[OLD, "yahoo-asset"]]]);
  const april = statementOf("2025-04-30", folioOf("91234567 / 12"));
  const exchange = fundRef(yahoo.symbol, "XNSE");
  for (const [current, now] of [[heldBefore(renamed, "100"), RENAMED], [heldBefore({ ...yahoo, exchangeMic: "XNSE" }, "100"), exchange]]) {
    // Confirmed again since the change, left out on the Holdings card, confirmed without an asset ID, from a
    // search result's symbol, or still the earlier choice.
    for (const choices of [[{ ...yahoo, symbol: "RENAMED", assetId: "yahoo-asset" }], [], [yahoo], [{ ...CHOSEN[0], symbol: "SEARCH" }], CHOSEN]) {
      const reconciled = reconcileRecord(record, current, choices);
      assert.deepEqual([[...reconciled.remembered], [...reconciled.ids], [...reconciled.aside]], [[[now, FLEXI]], [[now, "yahoo-asset"]], []]);
      const [account] = planReconciled(april, current, () => reconciled);
      assert.deepEqual(account.positions.map(notListed), [[now, ...NOT_LISTED]]);
      const zero = keeping(account.positions[0].key, false);
      assert.deepEqual(savedOf(account, zero), []);
      assert.deepEqual(entriesAndIds(account, zero), [[{}, {}]]);
      // Kept, it stays in the folio's record under its current symbol and exchange, with its ID.
      const kept = keeping(account.positions[0].key, true);
      assert.deepEqual(savedOf(account, kept), [["yahoo-asset", "100"]]);
      assert.deepEqual(entriesAndIds(account, kept), [[{ [now]: FLEXI }, { [now]: "yahoo-asset" }]]);
    }
    // Without its ID, as an older version saves it, a choice confirmed again doesn't match it, as before.
    const legacy = byChoices(record.remembered, current, [{ ...yahoo, symbol: "RENAMED", assetId: "yahoo-asset" }]);
    const [unmatched] = plan(april, { existing: () => current, remembered: () => legacy });
    assert.deepEqual(unmatched.positions.map((p) => [p.include, p.notes]), [[true, []]]);
  }
  // Unchanged, it stays under its symbol.
  const unchanged = reconcileRecord(record, heldBefore(yahoo, "100"), []);
  assert.deepEqual([[...unchanged.remembered], [...unchanged.ids]], [[[OLD, FLEXI]], [[OLD, "yahoo-asset"]]]);
});

test("an asset's recorded ID wins over another asset that now has its symbol, or that a choice names", () => {
  const record = marchWithIds();
  const april = statementOf("2025-04-30", folioOf("91234567 / 12"));
  // Another asset now has the earlier symbol and exchange.
  const other = { ...heldBefore(yahoo, "5").positions[0], assetId: "another-asset" };
  const current = heldBefore(renamed, "100");
  const both = { ...current, positions: [...current.positions, other] };
  // Its own asset still in the account: the record follows it, even if a choice gives the symbol to the other asset.
  for (const choices of [CHOSEN, [{ ...yahoo, assetId: "another-asset" }]]) {
    const followed = reconcileRecord(record, both, choices);
    assert.deepEqual([[...followed.remembered], [...followed.ids], [...followed.aside]], [[[RENAMED, FLEXI]], [[RENAMED, "yahoo-asset"]], []]);
    const [account] = planReconciled(april, both, () => followed);
    assert.deepEqual(account.positions.map((p) => [p.existing.assetId, ...notListed(p)]), [
      ["yahoo-asset", RENAMED, ...NOT_LISTED], ["another-asset", OLD, true, undefined, []],
    ]);
  }
  // Without it, the record's holding is set aside: the other asset is kept with no note, and the folio's record
  // keeps nothing of it.
  const alone = { ...current, positions: [other] };
  const aside = reconcileRecord(record, alone, CHOSEN);
  assert.deepEqual([[...aside.remembered], [...aside.ids], [...aside.aside]], [[], [[OLD, "yahoo-asset"]], [[OLD, FLEXI]]]);
  const [account] = planReconciled(april, alone, () => aside);
  assert.deepEqual(account.positions.map(notListed), [[OLD, true, undefined, []]]);
  assert.deepEqual(entriesAndIds(account), [[{}, {}]]);
  // Without the ID, it would be the other asset's.
  const [legacy] = plan(april, { existing: () => alone, remembered: () => byChoices(record.remembered, alone, CHOSEN) });
  assert.deepEqual(legacy.positions.map(notListed), [[OLD, ...NOT_LISTED]]);
  // A line that may have been misread and may be either asset holds the other asset back, and keeps the record.
  const misread = statementOf("2025-04-30", { ...folioOf("91234567 / 12"), misread: [flexi("100")] });
  const [heldBack] = planReconciled(misread, alone, () => aside, { asset: () => yahoo });
  assert.deepEqual(heldBack.positions.map((p) => [p.ref, p.existing.assetId, p.include]), [[OLD, "another-asset", true]]);
  assert.deepEqual(entriesAndIds(heldBack), [[{ [OLD]: FLEXI }, { [OLD]: "yahoo-asset" }]]);
  // An asset that has its own holding under the symbol takes it: a record keeps one holding by symbol.
  const taken = reconcileRecord({ remembered: new Map([[OLD, FLEXI], [RENAMED, ["INFZ90K01FC9"]]]), ids: new Map([[OLD, "gone-asset"], [RENAMED, "yahoo-asset"]]) },
    { ...current, positions: [{ ...current.positions[0], symbol: yahoo.symbol, ref: OLD }] }, []);
  assert.deepEqual([[...taken.remembered], [...taken.ids], [...taken.aside]], [[[OLD, ["INFZ90K01FC9"]]], [[OLD, "yahoo-asset"]], []]);
});

test("a holding confirmed to another asset doesn't take the record of the asset its earlier import added", () => {
  const record = marchWithIds();
  const current = heldBefore(renamed, "100");
  const reconciled = reconcileRecord(record, current, [amfi]);
  const [account] = planReconciled(statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110"))), current, () => reconciled, { asset: () => amfi });
  const [listed, old] = account.positions;
  assert.deepEqual([listed.ref, listed.include, listed.replaces, listed.ask?.kind], [fundRef("119551"), false, [old.key], "replace"]);
  assert.deepEqual([old.ref, old.existing.assetId, old.replacedBy, old.notes], [RENAMED, "yahoo-asset", listed.key, []]);
  // Kept, the old asset's record keeps its ID; replaced, the new asset's record has the ID its save gave it.
  assert.deepEqual(entriesAndIds(account), [[{ [RENAMED]: FLEXI }, { [RENAMED]: "yahoo-asset" }]]);
  assert.deepEqual(unidentified(account, replacing(listed.key)), [fundRef("119551")]);
  assert.deepEqual(entriesAndIds(account, replacing(listed.key), new Map([[fundRef("119551"), "amfi-asset"]])), [
    [{ [fundRef("119551")]: FLEXI }, { [fundRef("119551")]: "amfi-asset" }],
  ]);
});

test("an import records the IDs of the assets its save created or found, and goes without one it couldn't find", () => {
  const holdings = statementOf("2025-03-31", folioOf("91234567 / 12", flexi("100")));
  const [created] = plan(holdings, { asset: () => yahoo });
  assert.deepEqual(unidentified(created, noChoices), [OLD]);
  assert.deepEqual(entriesAndIds(created, noChoices, new Map([[OLD, "yahoo-asset"]])), [[{ [OLD]: FLEXI }, { [OLD]: "yahoo-asset" }]]);
  // A failed lookup: the holding is recorded without an ID, and later imports match it by remembered choices.
  assert.deepEqual(entriesAndIds(created, noChoices, new Map([["OTHER@XBOM", "other-asset"]])), [[{ [OLD]: FLEXI }, {}]]);
  // A row left out isn't saved, so it isn't looked up.
  assert.deepEqual(unidentified(created, replacing(created.positions[0].key)), []);
  // A resolved choice or the account's asset needs no lookup.
  const [resolved] = plan(holdings, { asset: () => ({ ...yahoo, assetId: "yahoo-asset" }) });
  const [held] = plan(holdings, { asset: () => yahoo, existing: () => heldBefore(yahoo, "90") });
  for (const account of [resolved, held]) {
    assert.deepEqual(unidentified(account, noChoices), []);
    assert.deepEqual(entriesAndIds(account), [[{ [OLD]: FLEXI }, { [OLD]: "yahoo-asset" }]]);
  }
  // A record an older version saved without IDs gets them for the holdings the next import keeps or imports.
  const april = statementOf("2025-04-30", folioOf("91234567 / 12", flexi("110")));
  const legacy = new Map([[OLD, FLEXI]]);
  const [next] = plan(april, { asset: () => yahoo, existing: () => heldBefore(yahoo, "100"), remembered: () => legacy });
  for (const choices of [noChoices, replacing(next.positions[0].key)]) {
    assert.deepEqual(entriesAndIds(next, choices), [[{ [OLD]: FLEXI }, { [OLD]: "yahoo-asset" }]]);
  }
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
  assert.deepEqual([listed.ask?.kind, listed.notes, old.notes], ["replace", [], []]);
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
  assert.deepEqual([listed.ask?.kind, listed.notes], ["replace", []]);
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
  assert.deepEqual([listed.ask?.kind, listed.notes, old.notes], ["replace", [], []]);
  assert.deepEqual(savedOf(shared), [["yahoo-asset", "100"]]);
  assert.deepEqual(savedOf(shared, replacing(listed.key)), [["119551", "120"]]);

  // Another fund that an earlier import of folio 1 added to the same asset is still listed, but left
  // out: how many of the asset's units it holds is unknown, so nothing is replaced.
  const other = flexi("5", { isin: "INFZ90K01FC9", rtaCode: "FFCRG", name: "Fictiva Flexi Cap Fund - Regular Plan - Growth" });
  const [twoFunds] = plan(statementOf("2025-03-31", folioOf("1", flexi("60"), other)), { asset: () => yahoo });
  const twoRecords = recordsOf(twoFunds);
  const mixedNote = `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}. ` +
    `The add-on can't tell how many of its units that holding accounts for, so it's kept and ${AMFI} is left out, so that they aren't counted twice.`;
  const [mixed] = plan(statementOf("2025-04-30", folioOf("1", flexi("66"), other)), {
    asset: (h) => (h.isin === "INFZ90K01FC8" ? amfi : undefined), existing: () => heldBefore(yahoo, "65"), remembered: (s) => twoRecords.get(s.id),
  });
  const [mixedListed, mixedOld] = mixed.positions;
  assert.deepEqual([mixedListed.include, mixedListed.replaces, mixedOld.include, mixedOld.replacedBy], [false, undefined, true, undefined]);
  assert.deepEqual(mixedListed.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added this holding as ${YAHOO}, which may also hold other units, so this row is left out and the account keeps ${YAHOO} as it is, so that its units aren't counted twice.`,
  ]);
  assert.deepEqual(mixedOld.notes, [mixedNote]);
  // Neither is asked about: it's kept with the notes.
  assert.deepEqual([mixedListed.ask, mixedOld.ask, mixedOld.removable], [undefined, undefined, undefined]);
  assert.deepEqual(savedOf(mixed), [["yahoo-asset", "65"]]);
  // The planner keeps each row's own default: turning the statement row around keeps the old asset too.
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
  // Asked as an overlap of the statement row it was added for.
  assert.deepEqual([old.ask, old.notes], [{ kind: "overlap", tracked: [{ name: "Mutual funds", tracksTransactions: true }], row: listed.key }, []]);
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
  assert.deepEqual(row.notes, [OVERLAP]);
  assert.deepEqual(row.ask, { kind: "overlap", tracked: [{ name: "Mutual funds", tracksTransactions: true }], row: row.key });
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
  assert.deepEqual(two.positions[0].notes, [OVERLAP]);
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

test("a holding that a left-out source's earlier import added keeps its units, with a note", () => {
  const next = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, share(S, "50"), share(T, "10")));
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(S, T)]]);
  const [account] = plan(next, {
    account: withoutDemat2, existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => records.get(s.id) ?? new Map(),
  });
  const [shared, unshared] = account.positions;
  assert.deepEqual([shared.ref, shared.units, shared.include], [ref(S), "100", false]);
  assert.deepEqual([shared.notes, shared.ask], [[
    "An earlier import of Demat account 2, which this import leaves out, recorded adding this holding. " +
    "Importing this row would replace the 150 units this account holds with the statement's 100, which don't count any that Demat account 2 holds, so it's left out and the account keeps its units. " +
    "To update them, save Demat account 2 too.",
  ], undefined]);
  // T is only Demat account 2's, so it stays as before, with no note.
  assert.deepEqual([unshared.ref, unshared.include, unshared.notes], [ref(T), true, []]);
  assert.deepEqual(savedOf(account), [[`asset-${S}`, "150"], [`asset-${T}`, "10"]]);
  // Demat account 1 still recorded adding S, whose units stay.
  assert.deepEqual([...recordsOf(account)].map(([id, refs]) => [id, [...refs.keys()]]), [["demat|1|1", [ref(S)]]]);
  // The planner still imports the statement's units when the row is turned around.
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
  assert.deepEqual([row.notes, row.ask], [[
    "An earlier import of Demat account 1 added it, and Demat account 1 no longer lists it. " +
    "An earlier import of Demat account 2, which this import leaves out, added it too, so it's kept. " +
    "Correct its units in Wealthfolio after saving: they may include some that came from Demat account 1, and none are left if Demat account 2 no longer holds any.",
  ], undefined]);
  assert.deepEqual(savedOf(account), [[`asset-${S}`, "150"], [`asset-${U}`, "30"]]);
  assert.deepEqual(savedOf(account, replacing(row.key)), [[`asset-${S}`, "150"]]);
  // Only Demat account 1 added it: it's asked about.
  const own = sold(new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(S)]])).positions.find((p) => p.ref === ref(U));
  assert.deepEqual(asking(own), [ref(U), "missing", ["Demat account 1"], []]);
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
    `An earlier import of Fictiva Mutual Fund, folio 1 added this holding as ${YAHOO}, which may also hold other units, so this row is left out and the account keeps ${YAHOO} as it is, so that its units aren't counted twice.`,
  ]);
  assert.deepEqual(old.notes, [
    `An earlier import of Fictiva Mutual Fund, folio 1 added it for a holding that this import lists under ${AMFI}. ` +
    `The add-on can't tell how many of its units that holding accounts for, so it's kept and ${AMFI} is left out, so that they aren't counted twice.`,
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
    "Importing this row would replace the 100 units this account holds with the statement's 66, which don't count any that Fictiva Mutual Fund, folio 2 holds.",
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
  assert.match(shared.notes[0], /^An earlier import of Demat account 2, which this import leaves out, recorded adding this holding\. .* To update them, save Demat account 2 too\.$/);
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

const UNLISTED_NOTE = "An earlier import added it from a folio, demat account or PRAN that this statement doesn't list, so it's kept. " +
  "Check whether it was redeemed, sold or moved, and if so, correct its units in Wealthfolio after saving.";
const UNLISTED_TOO = "An earlier import of a folio, demat account or PRAN that this statement doesn't list added it too.";
/** The account's snapshot after `account`'s import, as a later import reads it. */
const heldAfter = (account, date, choices = noChoices) => ({
  date, later: [], cash: {},
  positions: snapshotOf(account, choices).holdings.map((h) => ({
    assetId: h.assetId ?? `asset-${h.symbol}`, symbol: h.symbol, ref: ref(h.symbol), name: `Asset ${h.symbol}`, units: h.quantity, cost: null, currency: "INR",
  })),
});
/** The records of the sources with `ids`, as `readUnlisted` finds them for a statement that doesn't list them. */
const unlistedOf = (records, ...ids) => () => ids.map((id) => ({ keys: [`key of ${id}`], remembered: records.get(id) }));

test("a fund that an earlier import of a folio the statement doesn't list added is kept, with a note, until the folio is listed again", async () => {
  const march = readHoldings(await fixture("made-up-summary-cams"));
  const [first] = plan(march);
  const records = recordsOf(first);
  const [liquidFolio, balancedFolio, otherFolio] = march.sources.map((s) => s.id);
  // April's statement lists only folio 91234567 / 12.
  const april = { ...march, date: "2025-04-30", sources: march.sources.slice(0, 1) };
  const omitted = unlistedOf(records, balancedFolio, otherFolio);
  const [account] = plan(april, { existing: () => heldAfter(first, "2025-03-31"), remembered: (s) => records.get(s.id), unlisted: omitted });
  assert.deepEqual(account.unlisted.flatMap((u) => u.keys), [`key of ${balancedFolio}`, `key of ${otherFolio}`]);
  const row = (isin) => account.positions.find((p) => p.ref === ref(isin));
  // The folio's own funds come from the statement, without a note.
  for (const isin of ["INFZ90K01FC8", "INFZ90K01LQ6"]) assert.deepEqual([row(isin).lines.length, row(isin).include, row(isin).notes], [1, true, []]);
  for (const isin of ["INFZ90K01BA1", "INFZ91T01CB6", "INFZ91T01GL6", "INFZ91T01FT1"]) {
    assert.deepEqual([row(isin).lines.length, row(isin).include, row(isin).notes], [0, true, [UNLISTED_NOTE]]);
  }
  assert.ok(snapshotOf(account, noChoices).holdings.some((h) => h.assetId === "asset-INFZ90K01BA1" && h.quantity === "3443.91"));
  // Kept, the records stay as they are; so the next import says the same.
  assert.deepEqual(unlistedRefs(account, noChoices), []);
  const [may] = plan({ ...april, date: "2025-05-31" }, {
    existing: () => heldAfter(account, "2025-04-30"), remembered: (s) => records.get(s.id), unlisted: omitted,
  });
  assert.deepEqual(may.positions.find((p) => p.ref === ref("INFZ90K01BA1")).notes, [UNLISTED_NOTE]);
  // Turned around in the planner, it's removed, and so is it from its folio's record.
  const removed = replacing(row("INFZ90K01BA1").key);
  assert.ok(!snapshotOf(account, removed).holdings.some((h) => h.assetId === "asset-INFZ90K01BA1"));
  assert.deepEqual(unlistedRefs(account, removed), [{ keys: [`key of ${balancedFolio}`], refs: {}, ids: {} }]);

  // Listed again, the folio's record is its own: its fund is the statement's, or gone without it.
  const june = { ...march, date: "2025-06-30", sources: march.sources.slice(0, 2) };
  const [back] = plan(june, {
    existing: () => heldAfter(account, "2025-04-30"), remembered: (s) => records.get(s.id), unlisted: unlistedOf(records, otherFolio),
  });
  const balanced = back.positions.find((p) => p.ref === ref("INFZ90K01BA1"));
  assert.deepEqual([balanced.lines.length, balanced.include, balanced.notes], [1, true, []]);
  const sold = { ...june, sources: [march.sources[0], { ...march.sources[1], holdings: [] }] };
  const [gone] = plan(sold, {
    existing: () => heldAfter(account, "2025-04-30"), remembered: (s) => records.get(s.id), unlisted: unlistedOf(records, otherFolio),
  });
  const without = gone.positions.find((p) => p.ref === ref("INFZ90K01BA1"));
  assert.deepEqual(asking(without), [ref("INFZ90K01BA1"), "missing", ["Fictiva Mutual Fund, folio 91234570/0"], []]);

  // Without a record of the folio, such as an unindexed one, its fund is kept with no note, as before.
  const [unindexed] = plan(april, { existing: () => heldAfter(first, "2025-03-31"), remembered: (s) => records.get(s.id) });
  assert.deepEqual(unindexed.positions.find((p) => p.ref === ref("INFZ90K01BA1")).notes, []);
});

test("a statement row replaces units an unlisted source added, and its record forgets them", () => {
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(S, T)]]);
  const [account] = plan(statementOf("2025-04-30", demat(1, share(S, "150"))), {
    existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: (s) => records.get(s.id), unlisted: unlistedOf(records, "demat|2|2"),
  });
  const [listed, other] = account.positions;
  assert.deepEqual([listed.ref, listed.include, listed.notes], [ref(S), true, []]);
  assert.deepEqual([other.ref, other.include, other.notes], [ref(T), true, [UNLISTED_NOTE]]);
  assert.deepEqual(savedOf(account), [[`asset-${T}`, "10"], [`asset-${S}`, "150"]]);
  assert.deepEqual(unlistedRefs(account, noChoices), [{ keys: ["key of demat|2|2"], refs: { [ref(T)]: [T] }, ids: { [ref(T)]: `asset-${T}` } }]);
  // Leaving S out keeps the account's units, and the record.
  assert.deepEqual(unlistedRefs(account, replacing(listed.key)), []);
  assert.deepEqual(unlistedRefs(account, { flipped: new Set([listed.key, other.key]), costs: new Map() }), [
    { keys: ["key of demat|2|2"], refs: { [ref(S)]: [S] }, ids: { [ref(S)]: `asset-${S}` } },
  ]);
});

test("an unlisted source's record of a renamed asset follows it, as an included source's does", () => {
  const records = new Map([["demat|2|2", recorded(S, T)]]);
  const NEW = fundRef("NEW-T", "XBOM");
  const unlisted = unlistedOf(records, "demat|2|2");
  // The page's: the account holds T under its current symbol, and T's remembered choice names the asset by the recorded one.
  const current = sharesHeld([S, "150"], [T, "10"]);
  current.positions[1] = { ...current.positions[1], symbol: "NEW-T", ref: NEW };
  const reconciled = () => unlisted().map(({ keys, ...u }) => ({ keys, ...reconcileRecord(u, current, [{ ...asset(share(T, "1")), assetId: `asset-${T}` }]) }));
  const [account] = plan(statementOf("2025-04-30", demat(1, share(S, "150"))), {
    existing: () => current, remembered: () => new Map(), unlisted: reconciled,
  });
  const [listed, other] = account.positions;
  assert.deepEqual([other.ref, other.include, other.notes], [NEW, true, [UNLISTED_NOTE]]);
  assert.deepEqual(unlistedRefs(account, noChoices), [{ keys: ["key of demat|2|2"], refs: { [NEW]: [T] }, ids: { [NEW]: `asset-${T}` } }]);
  assert.deepEqual(unlistedRefs(account, replacing(listed.key)), []);
  // Without the choice, the record doesn't match: T is kept with no note.
  const [unmatched] = plan(statementOf("2025-04-30", demat(1, share(S, "150"))), { existing: () => current, remembered: () => new Map(), unlisted });
  assert.deepEqual(unmatched.positions[1].notes, []);

  // The account's position under the recorded symbol, matched to the statement's row by asset ID: a kept row's
  // holding goes under the row's symbol when the record is saved.
  const [direct] = plan(statementOf("2025-04-30", demat(1, share(S, "150"), share(T, "10"))), {
    asset: (h) => (h.isin === T ? { ...asset(h), symbol: "NEW-T", assetId: `asset-${T}` } : asset(h)),
    existing: () => sharesHeld([S, "150"], [T, "10"]), remembered: () => new Map(), unlisted,
  });
  const [, row] = direct.positions;
  assert.deepEqual([row.ref, row.existing.ref], [NEW, ref(T)]);
  assert.deepEqual(unlistedRefs(direct, replacing(row.key)), [{ keys: ["key of demat|2|2"], refs: { [NEW]: [T] }, ids: { [NEW]: `asset-${T}` } }]);
});

test("left-out and unlisted sources' records keep their asset IDs, follow renamed assets by them, and never another asset under their symbol", () => {
  const U = "INEZ90U01013";
  const NEW = fundRef("NEW-T", "XBOM");
  // Demat account 2's import added S, T and U. Since then, T's asset has a new symbol, and another asset has U's.
  const record = { remembered: recorded(S, T, U), ids: new Map([S, T, U].map((isin) => [ref(isin), `asset-${isin}`])) };
  const current = sharesHeld([S, "150"], [T, "10"], [U, "7"]);
  current.positions[1] = { ...current.positions[1], symbol: "NEW-T", ref: NEW };
  current.positions[2] = { ...current.positions[2], assetId: "another-asset" };
  const reconciled = reconcileRecord(record, current, []);
  assert.deepEqual([[...reconciled.remembered], [...reconciled.ids], [...reconciled.aside]], [
    [[ref(S), [S]], [NEW, [T]]], [[ref(S), `asset-${S}`], [NEW, `asset-${T}`], [ref(U), `asset-${U}`]], [[ref(U), [U]]],
  ]);
  const second = (s) => (s.id === "demat|2|2" ? reconciled : undefined);
  const notes = (account) => account.positions.map((p) => [p.ref, p.include, p.notes.map((note) => note.slice(0, 70))]);
  const leftOut = "An earlier import of Demat account 2, which this import leaves out, re";

  // Left out (#145): Demat account 1's S row replaces units Demat account 2 added, but its U row doesn't.
  const both = statementOf("2025-04-30", demat(1, share(S, "150"), share(U, "7")), demat(2));
  const [account] = planReconciled(both, current, second, { account: withoutDemat2 });
  assert.deepEqual(notes(account), [[ref(S), false, [leftOut]], [ref(U), true, []], [NEW, true, []]]);
  // Kept, the left-out record stays as it is; S imported, it's saved without S, with the other IDs.
  assert.deepEqual(importedRefs(account, noChoices).map((r) => r.source.id), ["demat|1|1"]);
  const cleared = importedRefs(account, replacing(account.positions[0].key));
  assert.deepEqual(cleared.map(({ source, refs, ids }) => [source.id, refs, ids]), [
    ["demat|1|1", { [ref(S)]: [S], [ref(U)]: [U] }, { [ref(S)]: `asset-${S}`, [ref(U)]: "another-asset" }],
    ["demat|2|2", { [NEW]: [T], [ref(U)]: [U] }, { [NEW]: `asset-${T}`, [ref(U)]: `asset-${U}` }],
  ]);
  // Without IDs, U's row would be left out too, as if Demat account 2 had added the other asset.
  const [legacy] = plan(both, { account: withoutDemat2, existing: () => current, remembered: (s) => byChoices(second(s) ? record.remembered : new Map(), current, []) });
  assert.deepEqual(notes(legacy).slice(0, 2), [[ref(S), false, [leftOut]], [ref(U), false, [leftOut]]]);

  // Unlisted (#154): T has the note under its new symbol; the other asset under U's has none.
  const unlisted = () => [{ keys: ["key of demat|2|2"], ...reconciled }];
  const [listing] = planReconciled(statementOf("2025-04-30", demat(1, share(S, "150"))), current, () => undefined, { unlisted });
  assert.deepEqual(listing.positions.map((p) => [p.ref, p.include, p.notes]), [[ref(S), true, []], [NEW, true, [UNLISTED_NOTE]], [ref(U), true, []]]);
  assert.deepEqual(unlistedRefs(listing, noChoices), [
    { keys: ["key of demat|2|2"], refs: { [NEW]: [T], [ref(U)]: [U] }, ids: { [NEW]: `asset-${T}`, [ref(U)]: `asset-${U}` } },
  ]);
  // Removing the other asset leaves the record's U, which isn't its own; removing T takes it from the record.
  const removed = { flipped: new Set(listing.positions.slice(1).map((p) => p.key)), costs: new Map() };
  assert.deepEqual(unlistedRefs(listing, removed), [{ keys: ["key of demat|2|2"], refs: { [ref(U)]: [U] }, ids: { [ref(U)]: `asset-${U}` } }]);
});

test("a holding a listed source no longer lists is kept when an unlisted source added it too", () => {
  const U = "INEZ90U01013";
  const records = new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(U)], ["demat|3|3", recorded(U)]]);
  const preview = (unlisted, account = () => "holdings-1") => plan(statementOf("2025-04-30", demat(1, share(S, "100")), demat(3, share(U, "5"))), {
    account, existing: () => sharesHeld([S, "100"], [U, "30"]), remembered: (s) => records.get(s.id), unlisted,
  })[0].positions.find((p) => p.ref === ref(U));
  // Demat account 3 lists U, so the statement's units replace the account's.
  const listed = preview(unlistedOf(records, "demat|2|2"));
  assert.deepEqual([listed.lines.length, listed.include, listed.notes], [1, true, []]);
  const kept = preview(unlistedOf(records, "demat|2|2"), (s) => (s.id === "demat|3|3" ? undefined : "holdings-1"));
  assert.equal(kept.include, true);
  assert.deepEqual(kept.notes, [
    "An earlier import of Demat account 1 added it, and Demat account 1 no longer lists it. " +
    "An earlier import of Demat account 3, which this import leaves out, added it too, so it's kept. " +
    "Correct its units in Wealthfolio after saving: they may include some that came from Demat account 1, and none are left if Demat account 3 no longer holds any.",
    UNLISTED_TOO,
  ]);
  const [account] = plan(statementOf("2025-04-30", demat(1, share(S, "100"))), {
    existing: () => sharesHeld([S, "100"], [U, "30"]), remembered: (s) => records.get(s.id), unlisted: unlistedOf(records, "demat|2|2"),
  });
  const row = account.positions.find((p) => p.ref === ref(U));
  assert.equal(row.include, true);
  assert.deepEqual(row.notes, [
    "An earlier import of Demat account 1 added it, and Demat account 1 no longer lists it. " +
    "An earlier import of a folio, demat account or PRAN that this statement doesn't list added it too, so it's kept. " +
    "Check whether it was redeemed, sold or moved from there too, and correct its units in Wealthfolio after saving: they may include some that came from Demat account 1.",
  ]);
  assert.deepEqual(savedOf(account), [[`asset-${U}`, "30"], [`asset-${S}`, "100"]]);
  // Turned around in the planner, removing it clears it from every record that has it.
  assert.deepEqual(unlistedRefs(account, replacing(row.key)), [{ keys: ["key of demat|2|2"], refs: {}, ids: {} }]);
  assert.deepEqual(recordedRefs(account, replacing(row.key)), [["demat|1|1", [ref(S)]]]);
  // A left-out source's record as well as an unlisted one's, and no listed source's.
  const both = plan(statementOf("2025-04-30", demat(1, share(S, "100")), demat(3, share(S, "1"))), {
    account: (s) => (s.id === "demat|3|3" ? undefined : "holdings-1"),
    existing: () => sharesHeld([S, "100"], [U, "30"]), remembered: (s) => (s.id === "demat|1|1" ? recorded(S) : records.get(s.id)),
    unlisted: unlistedOf(records, "demat|2|2"),
  })[0].positions.find((p) => p.ref === ref(U));
  assert.deepEqual([both.include, both.notes], [true, [
    UNLISTED_NOTE,
    "An earlier import of Demat account 3, which this import leaves out, added it too.",
  ]]);
});

test("an asset that an unlisted source's earlier import added isn't offered for replacement or removal", () => {
  const records = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => yahoo })[0]);
  const later = statementOf("2025-04-30", folioOf("1", flexi("66")));
  const folio2 = unlistedOf(records, "folio|2|amc:Fictiva Mutual Fund");
  const [moved] = plan(later, { asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id), unlisted: folio2 });
  const [listed, old] = moved.positions;
  assert.deepEqual([listed.include, listed.replaces, old.include, old.replacedBy], [false, undefined, true, undefined]);
  assert.deepEqual(old.notes.at(-1), UNLISTED_TOO);
  assert.deepEqual(savedOf(moved), [["yahoo-asset", "100"]]);
  // Without it, the old asset is offered for replacement, as before.
  const [alone] = plan(later, { asset: () => amfi, existing: () => heldBefore(yahoo, "100"), remembered: (s) => records.get(s.id) });
  assert.deepEqual([alone.positions[0].replaces, alone.positions[1].replacedBy], [[alone.positions[1].key], alone.positions[0].key]);

  // Left out for overlap: its units may include the unlisted folio's, so they aren't removable.
  const amfiRecords = recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => amfi })[0]);
  const overlap = (unlisted) => plan(later, {
    asset: () => amfi, existing: () => flexiAsset("100"), remembered: (s) => amfiRecords.get(s.id), heldElsewhere: tracking, unlisted,
  })[0].positions[0];
  assert.deepEqual(overlap().removable?.map((s) => s.label), ["Fictiva Mutual Fund, folio 1"]);
  const row = overlap(unlistedOf(amfiRecords, "folio|2|amc:Fictiva Mutual Fund"));
  assert.deepEqual([row.include, row.removable, undecided(row, noChoices)], [false, undefined, false]);
  assert.equal(row.notes.at(-1), "Leaving this row out keeps this account's 100 units of it, so Mutual funds may count them too. " +
    "An earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding, but its units may also include others. Check them in Wealthfolio.");
});

// Demat account 2 now goes to Other shares, and demat account 3 is left out; the rest go to Shares.
const toOtherShares = (s) => (s.id === "demat|2|2" ? "holdings-2" : s.id === "demat|3|3" ? undefined : "holdings-1");
const accountName = (id) => ({ "holdings-1": "Shares", "holdings-2": "Other shares" })[id];
/** Shares' plan: it held `held`, and `records` are what earlier imports into it recorded, by source ID. */
const sharesPlan = (holdings, held, records, more = {}) => plan(holdings, {
  account: toOtherShares, accountName, existing: (id) => (id === "holdings-1" ? held : none),
  remembered: (s, id) => (id === "holdings-1" && records.get(s.id)) || new Map(), ...more,
})[0];
const UNSURE = "A listed holding lacks a comparable identifier, so this earlier imported holding is kept. Check it in Wealthfolio after saving.";
/** A share the statement prints without an ISIN, and that's left out of the import. */
const unnamed = { ...share(null, "1"), name: "Share without an ISIN" };
const withIsin = (h) => (h.isin ? asset(h) : undefined);

test("units that a moved demat account's earlier import added are never removed without the user's choice", () => {
  // Shares has 15 T: 10 from demat account 2's import, and 5 added by hand.
  const account = sharesPlan(statementOf("2025-04-30", demat(1, share(S, "150")), demat(2, share(T, "10"))),
    sharesHeld([S, "150"], [T, "15"]), new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)]]));
  assert.deepEqual(account.reassigned.map((r) => [r.source.id, r.to]), [["demat|2|2", "holdings-2"]]);
  const row = account.positions.find((p) => p.ref === ref(T));
  assert.deepEqual([row.include, row.removable.map((s) => s.label), undecided(row, noChoices)], [true, ["Demat account 2"], true]);
  assert.deepEqual([row.ask, row.notes], [{ kind: "moved", moved: [{ source: account.reassigned[0].source, account: "Other shares" }] }, []]);
  assert.deepEqual(savedOf(account, keeping(row.key, true)), [[`asset-${T}`, "15"], [`asset-${S}`, "150"]]);
  assert.deepEqual(savedOf(account, keeping(row.key, false)), [[`asset-${S}`, "150"]]);
  // Only the user's answer removes them: turning the row around doesn't.
  assert.deepEqual(savedOf(account, replacing(row.key)), [[`asset-${T}`, "15"], [`asset-${S}`, "150"]]);
  // Its record in another account doesn't count, nor does one of a holding the account doesn't have.
  const elsewhere = plan(statementOf("2025-04-30", demat(1, share(S, "150")), demat(2, share(T, "10"))), {
    account: toOtherShares, accountName, existing: (id) => (id === "holdings-1" ? sharesHeld([S, "150"], [T, "15"]) : none),
    remembered: (s, id) => (s.id === "demat|2|2" && id === "holdings-2" ? recorded(T) : s.id === "demat|1|1" ? recorded(S) : new Map()),
  })[0].positions.find((p) => p.ref === ref(T));
  assert.deepEqual([elsewhere.removable, elsewhere.notes], [undefined, []]);
});

test("a holding a moved demat account's earlier import added with others' is kept with a note, or asked about once all of theirs are gone", () => {
  const april = statementOf("2025-04-30", demat(1, share(S, "150")), demat(2, share(T, "10")), demat(3, share(T, "5")));
  const held = sharesHeld([S, "150"], [T, "15"]);
  const rowOf = (account) => account.positions.find((p) => p.ref === ref(T));
  const MOVED = "Demat account 2 now goes to Other shares and still lists it.";
  const KEEP = "Correct its units in Wealthfolio after saving: those that came from Demat account 2 may be counted in Other shares too.";
  // Demat account 1 recorded it too, and no longer lists it: removing it is still the user's choice, naming both.
  const both = rowOf(sharesPlan(april, held, new Map([["demat|1|1", recorded(S, T)], ["demat|2|2", recorded(T)]])));
  assert.deepEqual([both.include, both.removable.map((s) => s.label), both.ask.kind, both.ask.moved.map((m) => [m.source.label, m.account]), both.notes], [
    true, ["Demat account 1", "Demat account 2"], "moved", [["Demat account 2", "Other shares"]], [],
  ]);
  // Without demat account 2's record, demat account 1's alone asks whether it's still held.
  const own = rowOf(sharesPlan(april, held, new Map([["demat|1|1", recorded(S, T)]])));
  assert.deepEqual([own.include, ...asking(own)], [true, ref(T), "missing", ["Demat account 1"], []]);
  // Demat account 3, left out, recorded it too.
  const leftOut = rowOf(sharesPlan(april, held, new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)], ["demat|3|3", recorded(T)]])));
  assert.deepEqual([leftOut.include, leftOut.removable, leftOut.notes], [true, undefined, [
    `An earlier import of Demat account 2 recorded adding this holding here. ${MOVED} ` +
    "An earlier import of Demat account 3, which this import leaves out, added it too. Its units may also include others, so it's kept. " + KEEP,
  ]]);
  // A folio, demat account or PRAN the statement doesn't list recorded it too.
  const records = new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)], ["demat|4|4", recorded(T)]]);
  const unlisted = sharesPlan(april, held, records, { unlisted: unlistedOf(records, "demat|4|4") });
  assert.deepEqual([rowOf(unlisted).include, rowOf(unlisted).removable, rowOf(unlisted).notes], [true, undefined, [
    `An earlier import of Demat account 2 recorded adding this holding here. ${MOVED} ` +
    `${UNLISTED_TOO} Its units may also include others, so it's kept. ${KEEP}`,
  ]]);
  // Demat account 1 lists a share without an ISIN, which may be it.
  const unsure = rowOf(sharesPlan(statementOf("2025-04-30", demat(1, share(S, "150"), unnamed), demat(2, share(T, "10"))), held,
    new Map([["demat|1|1", recorded(S, T)], ["demat|2|2", recorded(T)]]), { asset: withIsin }));
  assert.deepEqual([unsure.include, unsure.removable, unsure.notes], [true, undefined, [
    `An earlier import of Demat account 1 and Demat account 2 recorded adding this holding here. ${MOVED} Its units may also include others, so it's kept. ${KEEP}`,
    UNSURE,
  ]]);
  // Demat account 2 itself lists a share without an ISIN: whether it still lists this one is unknown.
  const moved = rowOf(sharesPlan(statementOf("2025-04-30", demat(1, share(S, "150")), demat(2, unnamed)), held,
    new Map([["demat|1|1", recorded(S)], ["demat|2|2", recorded(T)]]), { asset: withIsin }));
  assert.deepEqual([moved.include, moved.removable, moved.notes], [true, undefined, [
    "An earlier import of Demat account 2 recorded adding this holding here. " +
    "Demat account 2 now goes to Other shares, but a holding it lists lacks a comparable identifier, so it may still list this one. " +
    `So it's kept. ${KEEP}`,
  ]]);
});

test("a moved folio's earlier import keeps an old asset from replacement, overlap units from removal, and a held-back holding as it is", () => {
  const folio2Moved = (s) => (s.id.includes("folio|2|") ? "holdings-2" : "holdings-1");
  const MOVED = "An earlier import of Fictiva Mutual Fund, folio 2 recorded adding this holding here. Fictiva Mutual Fund, folio 2 now goes to Other shares and still lists it.";
  const later = statementOf("2025-04-30", folioOf("1", flexi("66")), folioOf("2", flexi("44")));
  const first = (chosen) => recordsOf(plan(statementOf("2025-03-31", folioOf("1", flexi("60")), folioOf("2", flexi("40"))), { asset: () => chosen })[0]);
  const inShares = (records, existing, more = {}) => plan(later, {
    account: folio2Moved, accountName, asset: () => amfi, existing: (id) => (id === "holdings-1" ? existing : none),
    remembered: (s, id) => (id === "holdings-1" ? records.get(s.id) : new Map()), ...more,
  })[0];
  // Confirmed to another asset: replacing the old one would take folio 2's units with it.
  const yahooRecords = first(yahoo);
  const [listed, old] = inShares(yahooRecords, heldBefore(yahoo, "100")).positions;
  assert.deepEqual([listed.include, listed.replaces, old.include, old.replacedBy, old.removable], [false, undefined, true, undefined, undefined]);
  assert.equal(old.notes.at(-1), MOVED);
  // Without folio 2's record there, the old asset is offered for replacement, as before.
  const [alone] = plan(later, {
    account: folio2Moved, accountName, asset: () => amfi, existing: (id) => (id === "holdings-1" ? heldBefore(yahoo, "100") : none),
    remembered: (s, id) => (id === "holdings-1" && s.id.includes("folio|1|") ? yahooRecords.get(s.id) : new Map()),
  });
  assert.deepEqual([alone.positions[0].replaces, alone.positions[1].replacedBy], [[alone.positions[1].key], alone.positions[0].key]);
  // Left out for overlap: the account's units may include folio 2's, so they aren't removable.
  const overlap = inShares(first(amfi), flexiAsset("100"), { heldElsewhere: tracking });
  const [row] = overlap.positions;
  assert.deepEqual([row.include, row.removable, undecided(row, noChoices)], [false, undefined, false]);
  assert.deepEqual(row.notes, [
    OVERLAP,
    "Leaving this row out keeps this account's 100 units of it, so Mutual funds may count them too. " +
    "An earlier import of Fictiva Mutual Fund, folio 1 recorded adding this holding, but its units may also include others. Check them in Wealthfolio.",
    MOVED,
  ]);
  // Kept, so folio 2's record there stays.
  assert.deepEqual(importedRefs(overlap, noChoices).map((r) => r.source.id), ["folio|1|amc:Fictiva Mutual Fund"]);

  // A possibly misread line in demat account 1 holds T back as it is.
  const misread = { ...demat(1, share(S, "150")), misread: [share(T, "4")] };
  const held = sharesPlan(statementOf("2025-04-30", misread, demat(2, share(T, "10"))),
    sharesHeld([S, "150"], [T, "15"]), new Map([["demat|1|1", recorded(S, T)], ["demat|2|2", recorded(T)]]));
  const t = held.positions.find((p) => p.ref === ref(T));
  assert.deepEqual([t.include, t.removable, t.misread.length], [true, undefined, 1]);
  assert.deepEqual(t.notes.slice(1), [
    "An earlier import of Demat account 2 recorded adding this holding here. Demat account 2 now goes to Other shares and still lists it. " +
    "Correct its units in Wealthfolio after saving: those that came from Demat account 2 may be counted in Other shares too.",
  ]);
  assert.deepEqual(savedOf(held, keeping(t.key, false)), [[`asset-${T}`, "15"], [`asset-${S}`, "150"]]);
  // Demat account 2's record there stays as it is.
  assert.deepEqual(recordedRefs(held), [["demat|1|1", [ref(T), ref(S)]]]);
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

test("a detailed statement's fund knows its asset priced from statements, which a search result can be", async () => {
  const detailed = await fixture("made-up-cas");
  const summary = readHoldings(await fixture("made-up-summary-cams"));
  const scheme = detailed.folios.flatMap((f) => f.schemes).find((s) => s.isin === "INFZ90K01FC8");
  const holding = summary.sources.flatMap((s) => s.holdings).find((h) => h.isin === scheme.isin);
  assert.equal(statementSymbol(scheme), statementAsset(holding).symbol);
  // Without an ISIN, the registrar and scheme code, as for a summary statement's fund.
  assert.equal(statementSymbol({ isin: null, rta: "KFINTECH", rta_code: "TGLDG" }), "MF-KFINTECH-TGLDG");
  assert.equal(statementSymbol({ isin: null, rta: "KFINTECH", rta_code: "" }), undefined);

  // The asset holdings imports find again: Wealthfolio has it, priced by hand, under the symbol, with no exchange.
  const handPriced = {
    symbol: "MY-CODE", canonicalSymbol: "infz90k01fc8 ", shortName: "Fund", longName: "Fund", exchange: "", quoteType: "EQUITY",
    typeDisplay: "", index: "", score: 100, existingAssetId: "asset-1", quoteMode: "MANUAL",
  };
  assert.equal(isStatementAsset(handPriced, "INFZ90K01FC8"), true);
  assert.equal(isStatementAsset({ ...handPriced, quoteMode: undefined, pricingMode: "MANUAL" }, "INFZ90K01FC8"), true);
  assert.equal(isStatementAsset({ ...handPriced, canonicalSymbol: undefined, symbol: "INFZ90K01FC8" }, "INFZ90K01FC8"), true);
  for (const [result, why] of [
    [{ ...handPriced, quoteMode: "MARKET" }, "priced from market data"],
    [{ ...handPriced, quoteMode: undefined }, "no pricing mode"],
    [{ ...handPriced, existingAssetId: undefined }, "not in Wealthfolio"],
    [{ ...handPriced, canonicalExchangeMic: "XBOM" }, "a listing on an exchange"],
    [{ ...handPriced, exchangeMic: "XBOM" }, "a listing on an exchange"],
    [{ ...handPriced, canonicalSymbol: "INFZ90K01BA1" }, "another fund's"],
  ]) assert.equal(isStatementAsset(result, "INFZ90K01FC8"), false, why);
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
  assert.deepEqual(funds.map((h) => [h.name, fundQuery(h.name), h.details.name]), [
    ["Fictiva Flexi Cap Fund - Direct Plan - Growth", "Fictiva Flexi Cap", "FFCDG - Fictiva Flexi Cap Fund - Direct Plan - Growth"],
    ["Fictiva Midcap Fund - Direct Plan - Growth", "Fictiva Midcap", "FMCDG - Fictiva Midcap Fund - Direct Plan - Growth"],
    ["Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout", "Testbridge Corporate Bond", "TCBRP - Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout"],
    ["Testbridge Gilt Fund - Direct Plan - Growth", "Testbridge Gilt", "TGLDG - Testbridge Gilt Fund - Direct Plan - Growth"],
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

  // Other statements, and CDSL demat accounts, keep their names as printed, even ones that look
  // coded. A CDSL demat fund printed after its fund house drops that, code and all (tested below).
  const coded = (name) => `ABC12 - ${name}`;
  for (const f of data.accounts.flatMap((a) => a.mutual_funds)) f.name = coded(f.name);
  const nsdl = await fixture("made-up-nsdl");
  for (const f of nsdl.accounts.flatMap((a) => a.mutual_funds)) f.name = coded(f.name);
  const summaries = await Promise.all(["made-up-summary-cams", "made-up-summary-kfintech"].map(fixture));
  for (const s of summaries.flatMap((d) => d.folios.flatMap((f) => f.schemes))) s.scheme = coded(s.scheme);
  const kept = (statement, keep = () => true) => readHoldings(statement).sources.filter(keep).flatMap((s) => s.holdings).filter((h) => h.kind === "fund");
  const unchanged = [...kept(data, (s) => s.kind === "demat"), ...kept(nsdl), ...summaries.flatMap((d) => kept(d))]
    .filter((h) => !h.details.name.includes("#"));
  assert.equal(unchanged.length, 20);
  for (const h of unchanged) assert.equal(h.name, h.details.name);
  for (const h of unchanged) assert.match(h.name, /^ABC12 - /);
});

test("marks a CDSL statement's CDSL demat fund printed as long as a cut name, whose plan and option read past its cut word", async () => {
  const data = await fixture("made-up-cdsl");
  const cut = readHoldings(data).sources.flatMap((s) => s.holdings).filter((h) => h.cut);
  const printed = "FICTIVA ASSET MGMT PVT LTD#FICTIVAMF\u0002 FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW";
  const shown = "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW";
  assert.deepEqual(cut.map((h) => [h.kind, h.isin, h.name, h.details.name]), [["fund", "INFZ90K01GS2", shown, printed]]);
  // The mark goes by the printed name's length, with the fund house, its short name and U+0002, not the name shown.
  assert.deepEqual([printed.length, mayBeCut(printed), shown.length, mayBeCut(shown)], [103, true, 65, false]);
  assert.deepEqual(planAndOption(cut[0].name, cut[0].cut), { plan: "Direct", option: "Growth" });
  assert.deepEqual(planAndOption(cut[0].name), {});
  // Its search leaves out "Fund" and everything from the first " - ", cut word included.
  assert.equal(fundQuery(cut[0].name), "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES");

  // The same name keeps its reading elsewhere: in the CDSL statement's NSDL demat account and folios,
  // and in an NSDL statement's CDSL demat account.
  const [fund] = data.accounts[0].mutual_funds.filter((f) => f.name === printed);
  data.accounts.find((a) => a.type === "NSDL Demat Account").mutual_funds.push({ ...fund, isin: "INFZ90K01GT0" });
  data.accounts.find((a) => a.type === "Mutual Fund Folios").mutual_funds.push({ ...fund, isin: "INFZ90K01GU8", folio: "91234567/12" });
  const nsdl = await fixture("made-up-nsdl");
  const cdslInNsdl = nsdl.accounts.find((a) => a.type === "CDSL Demat Account");
  cdslInNsdl.mutual_funds.push({ ...fund, isin: "INFZ90K01GV6" });
  const marked = (statement) => readHoldings(statement).sources.flatMap((s) => s.holdings).filter((h) => h.details.name === printed).map((h) => [h.isin, !!h.cut]);
  assert.deepEqual(marked(data), [["INFZ90K01GS2", true], ["INFZ90K01GU8", false], ["INFZ90K01GT0", false]]);
  assert.deepEqual(marked(nsdl), [["INFZ90K01GV6", false]]);
  // Nor is a shorter or longer name in the CDSL demat account.
  for (const name of [printed.slice(0, 99), `${printed}TH OPTION`]) {
    fund.name = name;
    assert.equal(readHoldings(data).sources[0].holdings.find((h) => h.isin === "INFZ90K01GS2").cut, undefined, name);
  }
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
    ["AB12 - ", "AB12 -"],
    [null, fund.isin],
  ]) {
    fund.name = printed;
    const holding = readHoldings(data).sources[0].holdings[0];
    assert.equal(holding.name, expected);
    assert.equal(holding.details.name, printed ?? undefined);
  }
});

test("a CDSL statement's own demat funds are shown, searched and named without their fund house or control characters", async () => {
  const data = await fixture("made-up-cdsl");
  const holdings = readHoldings(data);
  const demat = holdings.sources.find((s) => s.id === "demat|19999901|00012345");
  // As casparser reads the made-up statement, which prints them as a real CDSL statement does.
  const printed = "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF\u0002 FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH\u0002";
  const fund = demat.holdings.find((h) => h.isin === "INFZ90K01BG8");
  // The name shown and searched, its plan and option, and the printed name kept in the details.
  assert.deepEqual([fund.kind, fund.name, fundQuery(fund.name), planAndOption(fund.name), fund.details.name], [
    "fund", "FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH", "FICTIVA BALANCED ADVANTAGE", { plan: "Direct", option: "Growth" }, printed,
  ]);
  assert.equal(assetDetails(fund, {}, "EQUITY").casStatement.name, printed);
  // Names without "#" stay as printed.
  assert.deepEqual(demat.holdings.map((h) => [h.kind, h.name, h.details.name]), [
    ["share", "FICTIVA INDUSTRIES LIMITED", "FICTIVA INDUSTRIES LIMITED"],
    ["share", "TESTBRIDGE POWER AND INFRASTRUCTURE LIMITED", "TESTBRIDGE POWER AND INFRASTRUCTURE LIMITED"],
    ["fund", "FICTIVA NIFTY 50 ETF", "FICTIVA NIFTY 50 ETF"],
    ["fund", fund.name, printed],
    [
      "fund", "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW",
      "FICTIVA ASSET MGMT PVT LTD#FICTIVAMF\u0002 FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW",
    ],
    ["fund", "TESTBRIDGE GILT FUND", "TESTBRIDGE AMC LTD#TESTBRIDGE MF-TESTBRIDGE GILT FUND"],
  ]);

  // A new asset uses the readable scheme name, even with a statement-price choice remembered with the
  // name as printed, as version 3.0.0 saved it.
  assert.equal(statementAsset(fund).name, fund.name);
  const remembered = (h) => ({ ...statementAsset(h), name: h.details.name });
  for (const asset of [statementAsset, remembered]) {
    const [account] = plan({ ...holdings, sources: [demat] }, { asset });
    assert.equal(account.positions.find((p) => p.ref === fundRef(fund.isin)).name, fund.name);
    assert.equal(snapshotOf(account, noChoices).holdings.find((h) => h.symbol === fund.isin).name, fund.name);
    assert.ok(account.positions.every((p) => !/[\x00-\x1f\x7f#]/.test(p.name)));
  }
  // Check units names it the same way.
  const checks = checkUnits({ ...holdings, sources: [demat] }, {
    asset: (h) => (h === fund ? statementAsset(h) : undefined), accounts: [], activities: [], timeZone: "UTC",
  });
  assert.deepEqual(checks.map((c) => c.name), [fund.name]);
  // So does the Left out alert, for a fund without units.
  Object.assign(data.accounts[0].mutual_funds.find((f) => f.name === printed), { balance: "0", value: "0" });
  const zero = readHoldings(data);
  assert.deepEqual(zero.leftOut.map((l) => l.name), ["TESTBRIDGE POWER AND INFRASTRUCTURE LTD - RE", fund.name]);
  assert.deepEqual(zero.sources[0].zero.map((h) => [h.name, h.details.name]), [
    ["TESTBRIDGE POWER AND INFRASTRUCTURE LTD - RE", "TESTBRIDGE POWER AND INFRASTRUCTURE LTD - RE"], [fund.name, printed],
  ]);
});

test("only a CDSL statement's own demat accounts drop the fund house before a fund's name", async () => {
  const printed = "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF\u0002 FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH\u0002";
  const names = (statement, keep) => readHoldings(statement).sources.filter(keep).flatMap((s) => s.holdings).map((h) => h.name);
  const data = await fixture("made-up-cdsl");
  const [cdsl, folios, nsdl] = data.accounts;
  assert.deepEqual([cdsl.type, folios.type, nsdl.type], ["CDSL Demat Account", "Mutual Fund Folios", "NSDL Demat Account"]);
  const fund = cdsl.mutual_funds.find((f) => f.name === printed);
  // An NSDL demat account inside a CDSL statement, and the shares of its CDSL ones, keep their
  // names, only made readable.
  nsdl.mutual_funds.push({ ...fund });
  for (const e of cdsl.equities) e.name = `FICTIVA HOLDINGS LTD#FICTIVA MF\u0002 ${e.name}`;
  assert.deepEqual(names(data, (s) => s.id === "demat|IN999901|10012345"), [
    "SAMPLEWORKS TECHNOLOGIES LIMITED", "DEMOCORP FINANCE LIMITED",
    "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH",
  ]);
  assert.deepEqual(names(data, (s) => s.id === "demat|19999901|00012345"), [
    "FICTIVA HOLDINGS LTD#FICTIVA MF FICTIVA INDUSTRIES LIMITED",
    "FICTIVA HOLDINGS LTD#FICTIVA MF TESTBRIDGE POWER AND INFRASTRUCTURE LIMITED",
    "FICTIVA NIFTY 50 ETF",
    "FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH",
    "FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW",
    "TESTBRIDGE GILT FUND",
  ]);
  // A CDSL statement's folios drop only the scheme code.
  folios.mutual_funds[0].name = `FFCDG - FICTIVA ASSET MGMT PVT LTD#FICTIVA MF\u0002 ${folios.mutual_funds[0].name.slice("FFCDG - ".length)}`;
  assert.equal(names(data, (s) => s.kind === "folio")[0], "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF Fictiva Flexi Cap Fund - Direct Plan - Growth");
  // So do NPS schemes and an NSDL statement's CDSL demat accounts.
  data.nps.schemes[0].scheme = `FICTIVA PENSION # ${data.nps.schemes[0].scheme}`;
  assert.match(names(data, (s) => s.kind === "nps")[0], /^FICTIVA PENSION # NPS TRUST/);
  const other = await fixture("made-up-nsdl");
  const account = other.accounts.find((a) => a.type === "CDSL Demat Account");
  for (const [i, f] of account.mutual_funds.entries()) f.name = `TESTBRIDGE AMC LTD${i ? " # " : "#TESTBRIDGE MF-"}${f.name}`;
  const kept = readHoldings(other).sources.flatMap((s) => s.holdings).filter((h) => h.details?.name?.includes("#"));
  assert.equal(kept.length, account.mutual_funds.length);
  for (const h of kept) assert.equal(h.name, h.details.name);
  // Summary statements too.
  const summary = await fixture("made-up-summary-cams");
  summary.folios[0].schemes[0].scheme = `FICTIVA ASSET MGMT PVT LTD#FICTIVA MF-${summary.folios[0].schemes[0].scheme}`;
  assert.match(readHoldings(summary).sources[0].holdings[0].name, /^FICTIVA ASSET MGMT PVT LTD#FICTIVA MF-Fictiva /);
});

test("a CDSL demat fund drops its fund house's company name, \"#\" and short name, and keeps a name with nothing readable after them", async () => {
  const data = await fixture("made-up-cdsl");
  const [cdsl] = data.accounts;
  const fund = cdsl.mutual_funds.find((f) => f.isin === "INFZ90K01BG8");
  data.accounts = [cdsl];
  cdsl.equities = [];
  cdsl.mutual_funds = [fund];
  for (const [printed, expected] of [
    // The short name ends in "MF", with or without a space before it, then U+0002 or "-" and any spaces.
    ["FICTIVA ASSET MGMT PVT LTD#FICTIVA MF\u0002 FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH", "FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH"],
    ["FICTIVA ASSET MGMT PVT LTD#FICTIVAMF\u0002 FICTIVA LIQUID FUND-DIRECT PLAN-GROWTH", "FICTIVA LIQUID FUND-DIRECT PLAN-GROWTH"],
    ["TESTBRIDGE AMC LTD#TESTBRIDGE MF-TESTBRIDGE GILT FUND", "TESTBRIDGE GILT FUND"],
    ["TESTBRIDGE AMC LTD # TESTBRIDGE MF - TESTBRIDGE GILT FUND", "TESTBRIDGE GILT FUND"],
    ["FICTIVA AMC#FICTIVA MF \u0002FICTIVA FUND", "FICTIVA FUND"],
    // A second U+0002 at the end, or other control characters, read as spaces.
    ["FICTIVA AMC#FICTIVA MF\u0002 FICTIVA FUND-DIRECT PLAN-GROWTH\u0002", "FICTIVA FUND-DIRECT PLAN-GROWTH"],
    ["FICTIVA AMC#FICTIVA MF\u0002 FICTIVA\u0000\u001fFUND\u007f\r\n", "FICTIVA FUND"],
    // #182's form, with spaces around the "#" and no short name.
    ["FICTIVA AMC # FICTIVA FUND - DIRECT PLAN GROWTH", "FICTIVA FUND - DIRECT PLAN GROWTH"],
    ["FICTIVA AMC\t#  FICTIVA FUND", "FICTIVA FUND"],
    // Without a short name and separator, only up to the "#", with or without spaces around it.
    ["FICTIVA AMC#FICTIVA FUND", "FICTIVA FUND"],
    ["FICTIVA AMC#FICTIVA MUTUAL FUND\u0002 FICTIVA FUND", "FICTIVA MUTUAL FUND FICTIVA FUND"],
    // Only the first "#" counts.
    ["FICTIVA AMC # FICTIVA FUND # SERIES 2 - DIRECT PLAN GROWTH", "FICTIVA FUND # SERIES 2 - DIRECT PLAN GROWTH"],
    ["FICTIVA AMC#FICTIVA MF\u0002 FICTIVA FUND#SERIES 2", "FICTIVA FUND#SERIES 2"],
    ["FICTIVA AMC#FICTIVA FUND#SERIES MF-SAVER FUND", "FICTIVA FUND#SERIES MF-SAVER FUND"],
    ["FICTIVA AMC#FICTIVA FUND # SERIES MF\u0002 SAVER FUND", "FICTIVA FUND # SERIES MF SAVER FUND"],
    // "MF" in the scheme's own name: only a short name right after the "#" goes.
    ["FICTIVA AMC#FICTIVA MF\u0002 FICTIVA MF-SAVER FUND", "FICTIVA MF-SAVER FUND"],
    ["FICTIVA AMC#FICTIVA MFG FUND-DIRECT PLAN", "FICTIVA MFG FUND-DIRECT PLAN"],
    ["FICTIVA AMC#FICTIVA SMALLCAP FUND-MF-DIRECT", "FICTIVA SMALLCAP FUND-MF-DIRECT"],
    ["FICTIVA AMC#MF-FICTIVA FUND", "MF-FICTIVA FUND"],
    // Nothing readable after the cut, or no company name before the "#": the name as printed, made readable.
    ["FICTIVA AMC#FICTIVA MF\u0002", "FICTIVA AMC#FICTIVA MF"],
    ["FICTIVA AMC#FICTIVA MF-\u0002 ", "FICTIVA AMC#FICTIVA MF-"],
    ["FICTIVA AMC # ", "FICTIVA AMC #"],
    ["# FICTIVA FUND", "# FICTIVA FUND"],
    ["\u0002#FICTIVA MF\u0002 FICTIVA FUND", "#FICTIVA MF FICTIVA FUND"],
    // Nothing readable at all: the ISIN, as for a fund printed without a name.
    ["\u0002 \u0002", fund.isin],
    [null, fund.isin],
  ]) {
    fund.name = printed;
    const [holding] = readHoldings(data).sources[0].holdings;
    assert.equal(holding.name, expected, JSON.stringify(printed));
    assert.equal(holding.details.name, printed ?? undefined);
  }
});

test("every statement's names are shown, searched and named readable, and their printed details keep control characters", async () => {
  // Summary statements, from both registrars.
  for (const file of ["made-up-summary-cams", "made-up-summary-kfintech"]) {
    const summary = await fixture(file);
    const identities = (statement) => readHoldings(statement).sources.flatMap((s) => s.holdings).map((h) => [holdingKey(h), security(h)]);
    const before = identities(summary);
    const [first, second] = summary.folios[0].schemes;
    const name = first.scheme;
    first.scheme = `\u0002${name}\u0002 `;
    second.scheme = "\u0002\t\u0002";
    const [one, two] = readHoldings(summary).sources[0].holdings;
    assert.deepEqual([one.name, one.details.name], [name, first.scheme], file);
    // A name with nothing readable reads as the ISIN, or without one, the registrar's scheme code.
    assert.deepEqual([two.name, two.details.name], [second.isin, second.scheme], file);
    // The ISIN, registrar and scheme code identify them as before.
    assert.deepEqual(identities(summary), before, file);
    second.isin = null;
    assert.equal(readHoldings(summary).sources[0].holdings[1].name, second.rta_code, file);
  }

  // A depository statement's shares, bonds and funds.
  const nsdl = await fixture("made-up-nsdl");
  const [demat] = nsdl.accounts;
  const names = [...demat.equities, ...demat.mutual_funds, ...demat.bonds].map((h) => {
    const name = h.name;
    h.name = `${name.replace(" ", "\u0002")}\u0002`;
    return [h.isin, name, h.name];
  });
  const read = readHoldings(nsdl).sources[0].holdings;
  assert.deepEqual(read.map((h) => [h.isin, h.name, h.details.name]), names);
  // And NPS schemes, whose symbol is the same.
  const cdsl = await fixture("made-up-cdsl");
  const [scheme] = cdsl.nps.schemes;
  const code = npsSymbol(scheme.scheme);
  const name = scheme.scheme;
  scheme.scheme = `${name}\u0002\u0002`;
  const nps = readHoldings(cdsl).sources.find((s) => s.kind === "nps").holdings[0];
  assert.deepEqual([nps.name, nps.code, nps.details.scheme], [name, code, scheme.scheme]);
  // A CDSL folio's fund drops its scheme code, and the label that tells apart its folio names it readable.
  const folio = cdsl.accounts.find((a) => a.type === "Mutual Fund Folios").mutual_funds[0];
  folio.name = "FFCDG - Fictiva Flexi Cap Fund\u0002 - Direct Plan - Growth\u0002";
  const holding = readHoldings(cdsl).sources.flatMap((s) => s.holdings).find((h) => h.isin === folio.isin);
  assert.deepEqual([holding.name, holding.details.name], ["Fictiva Flexi Cap Fund - Direct Plan - Growth", folio.name]);
  cdsl.accounts.find((a) => a.type === "Mutual Fund Folios").mutual_funds.forEach((f) => { f.folio = "91234567/12"; });
  const labels = readHoldings(cdsl).sources.filter((s) => s.kind === "folio").map((s) => s.label);
  assert.ok(labels.some((label) => label.includes("(Fictiva Flexi Cap Fund - Direct Plan - Growth")), labels.join(" | "));
  assert.ok(labels.every((label) => !/[\x00-\x1f\x7f]/.test(label)));
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
  assert.deepEqual(checks.map((c) => unitStatus(c)), ["match", "match", "match", "differ", "review", "review"]);
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
  assert.equal(unitStatus(flexiCap), "match");
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
  assert.equal(unitStatus(zero), "match");
  const stillHeld = check(cdsl, sold.slice(0, 1)).find((c) => c.ref === "asset-INEZ91B20013");
  assert.equal(unitStatus(stillHeld), "differ");
  // A printed zero is confirmed and checked, but never planned into a snapshot.
  assert.equal(plan(cdsl)[0].positions.some((p) => p.ref === ref("INEZ91B20013")), false);
  // Left out without a confirmed asset, it isn't checked.
  assert.equal(check(cdsl, sold, { asset: (h) => (h.isin === "INEZ91B20013" ? undefined : asset(h)) }).some((c) => c.ref === "asset-INEZ91B20013"), false);

  const nsdl = readHoldings(await fixture("made-up-nsdl"));
  const shares = check(nsdl, [activity("unset-1", "BUY", "2024-01-01", "INEZ90B01015", "520")]);
  const twice = shares.find((c) => c.ref === "asset-INEZ90B01015");
  assert.deepEqual(twice.lines.map((l) => [l.source.label.replace(/,.*/, ""), l.holding.units]), [["NSDL Demat Account 1", "420"], ["CDSL Demat Account 2", "100.000"]]);
  assert.equal(unitStatus(twice), "match");
  // Holdings nobody bought in an account that tracks transactions need review, not a zero.
  assert.ok(shares.filter((c) => c !== twice).every((c) => c.held === undefined && unitStatus(c) === "review"));

  const unread = check(nsdl, { error: "Error: offline" });
  assert.equal(unread.length, shares.length);
  assert.ok(unread.every((c) => c.problem === "Couldn't read Wealthfolio's activities: Error: offline" && unitStatus(c) === "review"));
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
  assert.ok([ambiguous, unread, unreadRenamed].every((c) => unitStatus(c) === "review"));
  // An explicit ID establishes the asset without reading any profiles.
  const [byId] = check(holdings, partial, { asset: (h) => confirmed(h, { assetId: "fund-1" }), identities });
  assert.equal(unitStatus(byId), "match");
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
  assert.deepEqual(checks.map((c) => [c.ref, format(c.statement), format(c.held), unitStatus(c)]), [
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
    assert.equal(unitStatus(checked), "review");
  }
  // A held-back asset's import record survives a renamed display code or a new confirmed symbol: under
  // its row's symbol when the account's position is under the recorded one, else under the recorded one.
  const oldRef = ref("OLD");
  const ids = [flexi.isin, `CAMS|${flexi.rta_code}`];
  const records = new Map([[oldRef, ids]]);
  for (const [current, kept] of [["OLD", [undefined, ids]], ["NEW", [ids, undefined]]]) {
    const [renamed] = plan(holdings, {
      asset: (h) => ({ ...asset(h), symbol: "NEW", assetId: h.isin === flexi.isin ? "flexi" : "liquid" }),
      existing: () => ({ ...none, positions: [{
        assetId: "flexi", ref: ref(current), symbol: current, name: "Flexi", units: "3000", cost: "150000", currency: "INR",
      }] }),
      remembered: () => records,
    });
    assert.ok(renamed.positions.find((p) => p.existing?.assetId === "flexi").misread);
    assert.deepEqual(importedRefs(renamed, noChoices).map(({ refs }) => [refs[oldRef], refs[ref("NEW")]]), [kept, kept]);
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
  assert.deepEqual([own.ref, own.lines, own.misread.length, format(own.statement), unitStatus(own)], [ref(flexi.isin), [], 1, "0", "review"]);
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

test("a holding one source no longer lists is kept with a note, not asked about, when another's line may be it", () => {
  const U = "INEZ90U01013";
  // Demat account 1 no longer lists U; demat account 2, which recorded it too, lists a share without an ISIN that may be it.
  const next = statementOf("2025-04-30", demat(1, share(S, "100")), demat(2, unnamed));
  const records = new Map([["demat|1|1", recorded(S, U)], ["demat|2|2", recorded(U)]]);
  const [account] = plan(next, { asset: withIsin, existing: () => sharesHeld([S, "100"], [U, "30"]), remembered: (s) => records.get(s.id) ?? new Map() });
  const row = account.positions.find((p) => p.ref === ref(U));
  assert.deepEqual([row.include, row.ask, row.removable, undecided(row, noChoices)], [true, undefined, undefined, false]);
  assert.deepEqual(row.notes, [
    "An earlier import of Demat account 1 added it, and Demat account 1 no longer lists it, but its units may also include others, so it's kept. " +
    "Correct its units in Wealthfolio after saving: they may include some that came from Demat account 1.",
    UNSURE,
  ]);
  assert.deepEqual(savedOf(account), [[`asset-${U}`, "30"], [`asset-${S}`, "100"]]);
});
