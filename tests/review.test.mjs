// What the detailed Review screen counts, from the planned transactions: each statement row's outcome,
// each fund's new transactions and units after importing, the statement's transactions by what
// happens to them, the bank movements, and the bank entries that may be them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { format } from "../src/cas/decimal.ts";
import { mapStatement } from "../src/cas/mapping.ts";
import { bankMatches, fundRef, fundRefs, indexActivities, planImport, RECORD_PREFIX, rowsOf } from "../src/cas/plan.ts";
import { bankMovements, bankPairs, breakdown, describes, fundGroups, houseWords, plannedOf, rowUnits, sends, unitsDiffer } from "../src/cas/review.ts";

const tx = (date, type, amount, units = null, nav = null, extra = {}) => ({
  date, description: type, amount, units, nav, balance: null, type, dividend_rate: null, gift_folio: null, ...extra,
});
const scheme = (name, transactions, extra = {}) => ({
  scheme: name, advisor: "DIRECT", rta_code: name, rta: "CAMS", type: "N/A", isin: `INF-${name}`, amfi: null, nominees: [],
  open: "0", close: "0", close_calculated: "0", valuation: { date: "2025-03-31", nav: "10", cost: null, value: "0" }, transactions, ...extra,
});
const folio = (number, schemes, extra = {}) => ({ folio: number, amc: "Fictiva Mutual Fund", name: null, PAN: "ABCDE1234F", KYC: null, PANKYC: null, schemes, ...extra });
const statement = (...folios) => ({
  statement_period: { from: "01-Apr-2023", to: "31-Mar-2025" },
  folios,
  investor_info: { name: "", email: "", address: "", mobile: "" },
  cas_type: "DETAILED",
  file_type: "CAMS",
  parse_warnings: [],
});
const asset = (s) => ({ symbol: s.rta_code.toLowerCase(), exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND" });
const ACCOUNT = "account-1";
const BANK = "bank-1";

/** Wealthfolio's checkImport, without its duplicate check: every row valid. */
const check = (rows) => rows.map((row) => ({ ...row }));
const profiles = new Map();
let id = 0;
/** How Wealthfolio returns an imported row, with the add-on's row ID unless `byHand`. */
const stored = (row, byHand = false) => {
  if (row.symbol) profiles.set(`uuid-${row.symbol}`, fundRef(row.symbol, row.exchangeMic));
  return {
    id: `activity-${++id}`, accountId: row.accountId, activityType: row.activityType, subtype: row.subtype ?? null, status: "POSTED",
    date: `${row.date}T00:00:00+00:00`, quantity: row.quantity ?? null, unitPrice: row.unitPrice ?? null, amount: row.amount ?? null,
    fee: null, tax: row.tax ?? null, currency: row.currency, needsReview: false, comment: null,
    assetId: row.symbol ? `uuid-${row.symbol}` : "", assetSymbol: row.symbol ? row.symbol.toUpperCase() : "", exchangeMic: row.exchangeMic ?? null,
    sourceGroupId: row.sourceGroupId ?? null, sourceRecordId: byHand ? null : `${RECORD_PREFIX}${row.sourceRecordId}`,
  };
};
/** A bank entry, as a bank statement's import records one. */
const entry = (entryId, activityType, amount, date, comment, extra = {}) => ({
  id: entryId, accountId: BANK, activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`, quantity: null, unitPrice: null,
  amount, fee: null, currency: "INR", needsReview: false, comment, assetId: "", assetSymbol: "", ...extra,
});

/** The plan for `data`, with every scheme confirmed and in `ACCOUNT` unless `skip` says otherwise. */
function planFor(data, { existing = [], bank, skip = () => false, covered = () => true, unbalanced = () => false } = {}) {
  const target = (f, s) => (skip(f, s) ? undefined : { accountId: ACCOUNT, asset: asset(s), bankAccountId: bank });
  const funds = fundRefs(data.folios.flatMap((f) => f.schemes.map(asset)), profiles);
  const mapping = mapStatement(data, {
    target: (f, s) => {
      const t = target(f, s);
      return t && { ...t, openingCovered: covered(f, s), importUnbalanced: unbalanced(f, s) };
    },
    alreadyImported: indexActivities(existing, funds).has,
  });
  const plan = planImport(mapping, existing, check(rowsOf(mapping)), funds);
  return { mapping, plan, planned: plannedOf(plan), target, funds, existing };
}

const sip = (date, amount = "4999.75", units = "103.088", nav = "48.5000") => [
  tx(date, "PURCHASE_SIP", amount, units, nav),
  tx(date, "STAMP_DUTY_TAX", "0.25"),
];

describe("row outcomes", () => {
  test("every row but event-only rows and charges added to a transaction, with its transaction or why it's left out", () => {
    const data = statement(folio("F1", [
      scheme("A", [...sip("2023-04-10"), tx("2023-04-11", "STAMP_DUTY_TAX", "0.25"), tx("2023-05-01", "MISC", null, null, null, { description: "Registration of nominee" })]),
      scheme("B", [tx("2023-06-01", "PURCHASE", "1000", "10", "100"), tx("2023-06-03", "REVERSAL", "-1000", "-10", "100")], { close: "0", close_calculated: "0" }),
      scheme("C", [tx("2023-07-01", "PURCHASE", "1000", "10", "100")], { close: "10", close_calculated: "10" }),
      scheme("D", [tx("2023-08-01", "PURCHASE", "1000", "10", "100")], { open: "5", close: "15", close_calculated: "15" }),
    ]));
    const { mapping } = planFor(data, { skip: (f, s) => s.scheme === "C", covered: (f, s) => s.scheme !== "D" });
    assert.deepEqual(
      mapping.outcomes.map((o) => [o.scheme.scheme, o.row.type, o.transaction ? "transaction" : o.leftOut.kind]),
      [
        ["A", "PURCHASE_SIP", "transaction"],
        ["A", "STAMP_DUTY_TAX", "row"],
        ["B", "PURCHASE", "reversal"],
        ["B", "REVERSAL", "reversal"],
        ["C", "PURCHASE", "unchosen"],
        ["D", "PURCHASE", "opening"],
      ],
    );
    assert.equal(mapping.outcomes[0].transaction, mapping.transactions[0]);
  });

  test("a fund whose rows don't add up leaves every row out for that, unless imported anyway", () => {
    const data = statement(folio("F1", [scheme("A", [tx("2023-06-01", "PURCHASE", "1000", "10", "100")], { close: "12", close_calculated: "10" })]));
    assert.deepEqual(planFor(data).mapping.outcomes.map((o) => o.leftOut?.kind), ["unbalanced"]);
    assert.ok(planFor(data, { unbalanced: () => true }).mapping.outcomes[0].transaction);
  });

  test("a merger's two rows share one transaction", () => {
    const data = statement(folio("F1", [
      scheme("OLD", [tx("2024-01-05", "SWITCH_OUT_MERGER", "-1000", "-10", "100")], { open: "10", close: "0", close_calculated: "0" }),
      scheme("NEW", [tx("2024-01-05", "SWITCH_IN_MERGER", "1000", "20", "50")], { close: "20", close_calculated: "20" }),
    ]));
    const { mapping } = planFor(data);
    assert.equal(mapping.transactions.length, 1);
    assert.deepEqual(mapping.outcomes.map((o) => o.transaction === mapping.transactions[0]), [true, true]);
  });
});

describe("funds", () => {
  test("a row's units: trades, transfers, reinvested dividends and conversions; cash has none", () => {
    const units = (row) => (rowUnits({ symbol: "x", quantity: "2.5", ...row }) ? format(rowUnits({ symbol: "x", quantity: "2.5", ...row })) : undefined);
    assert.deepEqual(
      [{ activityType: "BUY" }, { activityType: "SELL" }, { activityType: "TRANSFER_IN" }, { activityType: "TRANSFER_OUT" },
        { activityType: "DIVIDEND", subtype: "DRIP" }, { activityType: "DIVIDEND" }, { activityType: "ADJUSTMENT", subtype: "CONVERSION_IN" },
        { activityType: "ADJUSTMENT", subtype: "conversion-out" }, { activityType: "DEPOSIT", symbol: "" }].map(units),
      ["2.5", "-2.5", "2.5", "-2.5", "2.5", undefined, "2.5", "-2.5", undefined],
    );
  });

  test("each fund counts its new and earlier transactions, and its units after importing match the statement", () => {
    const rows = [...sip("2023-04-10"), ...sip("2023-05-10"), tx("2023-06-01", "REDEMPTION", "-1000.00", "-20.000", "50")];
    const data = statement(folio("F1", [scheme("A", rows, { close: "186.176", close_calculated: "186.176" })]));
    const first = planFor(data);
    // The first SIP is in Wealthfolio already, from an earlier import.
    const existing = first.plan[0].rows.map((r) => stored(r.activity));
    const { mapping, planned, plan, target, funds } = planFor(data, { existing });
    const [group] = fundGroups({ data, mapping, planned, sent: (t) => sends(t, () => false), target, existing, funds, timeZone: "UTC" });
    assert.deepEqual([group.key, group.sent, group.before, group.other, group.forced, format(group.after), format(group.statement)],
      [`${ACCOUNT}|${fundRef("a", "XBOM")}`, 2, 1, 0, 0, "186.176", "186.176"]);
    assert.equal(unitsDiffer(group), false);
    assert.deepEqual(plan.map((t) => t.status), ["existing", "new", "new"]);
  });

  test("a possible duplicate imported anyway adds its units, so they differ from the statement's", () => {
    const data = statement(folio("F1", [scheme("A", [tx("2023-06-01", "PURCHASE", "1000", "10", "100")], { close: "10", close_calculated: "10" })]));
    // The same purchase entered by hand, without its cash.
    const existing = [stored(planFor(data).plan[0].transaction.activity, true)];
    const { mapping, planned, plan, target, funds } = planFor(data, { existing });
    assert.equal(plan[0].status, "duplicate");
    const groupsWith = (yes) => fundGroups({ data, mapping, planned, sent: (t) => sends(t, () => yes), target, existing, funds, timeZone: "UTC" })[0];
    assert.deepEqual([groupsWith(false).sent, groupsWith(false).other, format(groupsWith(false).after)], [0, 1, "10"]);
    const forced = groupsWith(true);
    assert.deepEqual([forced.sent, forced.forced, format(forced.after), unitsDiffer(forced)], [1, 1, "20", true]);
  });

  test("an accepted duplicate gift counts for both accounts, whichever folio comes first", () => {
    for (const receiverFirst of [false, true]) {
      const giving = folio("11111", [scheme("A", [tx("2024-06-03", "GIFT_OUT", "-500", "-10", "50", { gift_folio: "22222" })], { open: "10" })]);
      const receiving = folio("22222", [scheme("A", [tx("2024-06-03", "GIFT_IN", "500", "10", "50", { gift_folio: "11111" })], { close: "10", close_calculated: "10" })]);
      const data = statement(...(receiverFirst ? [receiving, giving] : [giving, receiving]));
      const target = (f, s) => ({ accountId: f.folio, asset: asset(s), openingCovered: true });
      const mapping = mapStatement(data, { target });
      assert.equal(mapping.transactions.length, 1);
      const existing = [stored({ ...mapping.transactions[0].activity, activityType: "BUY", date: "2023-01-01" }, true)];
      const funds = fundRefs([asset(giving.schemes[0])], profiles);
      const plan = planImport(mapping, existing, check(rowsOf(mapping)).map((r) => ({ ...r, duplicateOfId: "host-duplicate" })), funds);
      assert.equal(plan[0].status, "duplicate");
      const groups = fundGroups({ data, mapping, planned: plannedOf(plan), sent: (t) => sends(t, () => true), target, existing, funds, timeZone: "UTC" });
      assert.deepEqual(groups.map((g) => [g.accountId, g.sent, g.forced, format(g.after)]).sort(), [["11111", 1, 1, "0"], ["22222", 1, 1, "10"]]);
    }
  });

  test("a fund whose rows don't add up, imported anyway, says so", () => {
    const data = statement(folio("F1", [scheme("A", [tx("2023-06-01", "PURCHASE", "1000", "10", "100")], { close: "12", close_calculated: "10" })]));
    const { mapping, planned, target, funds } = planFor(data, { unbalanced: () => true });
    const [group] = fundGroups({ data, mapping, planned, sent: (t) => sends(t, () => false), target, existing: [], funds, timeZone: "UTC" });
    assert.deepEqual([group.unbalanced, format(group.after), format(group.statement), unitsDiffer(group)], [true, "10", "12", true]);
  });
});

describe("the statement's transactions", () => {
  test("their parts add up to the total, whatever keeps each row out", () => {
    const data = statement(
      folio("F1", [
        scheme("A", [tx("2023-06-01", "PURCHASE", "1000", "10", "100"), tx("2023-06-02", "PURCHASE", "1000", "10", "100")], { close: "20", close_calculated: "20" }),
        scheme("B", [tx("2023-06-01", "PURCHASE", "1000", "10", "100")], { open: "5", close: "15", close_calculated: "15" }),
        scheme("C", [tx("2023-07-01", "PURCHASE", "1000", "10", "100"), tx("2023-07-02", "REVERSAL", "-1000", "-10", "100")]),
        scheme("D", [tx("2023-08-01", "PURCHASE", "1000", "10", "100")], { close: "12", close_calculated: "10" }),
        scheme("E", [tx("2023-09-01", "PURCHASE", "1000", "10", "100")], { close: "10", close_calculated: "10" }),
      ]),
      folio("F2", [scheme("F", [tx("2023-09-01", "PURCHASE", "1000", "10", "100")], { close: "10", close_calculated: "10" })]),
      folio("F3", [scheme("G", [tx("2023-09-01", "PURCHASE", "1000", "10", "100")], { close: "10", close_calculated: "10" })]),
    );
    const existing = [stored(planFor(data).plan[0].transaction.activity), stored(planFor(data).plan[0].transaction.cash)];
    const { mapping, planned } = planFor(data, {
      existing,
      skip: (f, s) => ["E", "F", "G"].includes(s.scheme),
      covered: (f, s) => s.scheme !== "B",
    });
    const b = breakdown({
      mapping,
      planned,
      sent: (t) => sends(t, () => false),
      why: (f, s) => (s.scheme === "E" ? "skipped" : f.folio === "F2" ? "notImported" : "answers"),
    });
    const { leftOut, ...counts } = b;
    assert.deepEqual(counts, { total: 9, toImport: 1, before: 1, duplicates: 0, answers: 1, earlier: 1, skipped: 1, notImported: 1, unbalanced: 1 });
    assert.deepEqual(leftOut.map((l) => [l.row.scheme.scheme, l.kind]), [["C", "reversal"], ["C", "reversal"]]);
    assert.equal(Object.values(counts).slice(1).reduce((a, n) => a + n, 0) + leftOut.length, b.total);
  });
});

describe("bank entries", () => {
  test("a fund house's own words in a description, not a bank's of the same name", () => {
    assert.deepEqual(houseWords("PPFAS Mutual Fund"), ["PPFAS"]);
    assert.deepEqual(houseWords("Fictiva Bank Mutual Fund"), ["FICTIVA"]);
    assert.deepEqual(houseWords("ICICI Prudential Mutual Fund"), ["ICICI", "PRUDENTIAL"]);
    assert.equal(describes("ACH D- FICTIVA MF SIP", "Fictiva Mutual Fund"), "house");
    assert.equal(describes("NACH DR PPFAS MF", "PPFAS Mutual Fund"), "house");
    assert.equal(describes("UPI/ICICIPRU SIP", "ICICI Prudential Mutual Fund"), "house");
    assert.equal(describes("NEFT DR HDFC BANK SALARY", "HDFC Mutual Fund"), undefined);
    assert.equal(describes("NEFT OTHER BANK SALARY", "Fictiva Bank Mutual Fund"), undefined);
    assert.equal(describes("NEFT OTHER BANK MF", "Fictiva Bank Mutual Fund"), "funds");
    for (const [bank, house] of [["HDFCBANK", "HDFC"], ["ICICIBANK", "ICICI Prudential"], ["AXISBANK", "Axis"]]) {
      assert.equal(describes(`NEFT ${bank} SALARY`, `${house} Mutual Fund`), undefined);
    }
    for (const [description, house] of [["NACH HDFCLIFE INSURANCE PREMIUM", "HDFC"], ["NACH ICICIPRULIFE PREMIUM", "ICICI Prudential"], ["LIC INSURANCE PREMIUM", "LIC"]]) {
      assert.equal(describes(description, `${house} Mutual Fund`), undefined);
    }
    assert.equal(describes("NACH ADITYA BIRLA SUN LIFE SIP", "Aditya Birla Sun Life Mutual Fund"), "house");
    assert.equal(describes("NACH HDFCLIFE INSURANCE PREMIUM MF", "HDFC Mutual Fund"), "funds");
    assert.equal(describes("LIC INSURANCE PREMIUM mutual fund", "LIC Mutual Fund"), "funds");
    assert.equal(describes("BSE STAR MF", "HDFC Mutual Fund"), "funds");
    assert.equal(describes("Mutual Fund purchase", "HDFC Mutual Fund"), "funds");
    assert.equal(describes("UPI/RENT SHARE", "Fictiva Mutual Fund"), undefined);
    assert.equal(describes(null, "Fictiva Mutual Fund"), undefined);
  });

  const data = statement(folio("F1", [
    scheme("A", [
      ...sip("2023-04-10", "4999.75", "103.088", "48.5000"),
      ...sip("2023-05-10", "4999.75", "100.000", "49.9975"),
      ...sip("2023-06-12", "4999.75", "99.000", "50.5025"),
      tx("2023-07-01", "REDEMPTION", "-3000.00", "-60.000", "50"),
    ], { close: "242.088", close_calculated: "242.088" }),
    scheme("B", [tx("2023-12-28", "DIVIDEND_PAYOUT", "7276.48")]),
  ]));
  const pairsFor = (entries, facts = new Map(), linked = new Set()) => {
    const { plan } = planFor(data, { existing: entries, bank: BANK });
    const sent = plan.filter((t) => sends(t, () => false) && t.transaction.bank);
    return bankPairs({ transactions: sent, matches: bankMatches(sent, entries, linked), existing: entries, linked, facts, amcOf: () => "Fictiva Mutual Fund" });
  };
  const view = (pairs) => pairs.map((p) => [p.entry.id, p.strong, p.reason]);

  test("a unique exact same-day entry naming only a bank starts unticked", () => {
    const entries = [entry("bank-only", "WITHDRAWAL", "5000.00", "2023-04-10", "NEFT HDFCBANK SALARY")];
    const { plan } = planFor(data, { existing: entries, bank: BANK });
    const pairs = bankPairs({ transactions: plan, matches: bankMatches(plan, entries, new Set()), existing: entries, linked: new Set(), facts: new Map(), amcOf: () => "HDFC Mutual Fund" });
    assert.deepEqual(pairs.map((p) => [p.exact, p.days, p.otherEntries, p.otherTransactions, p.strong, p.reason]),
      [[true, 0, 0, 0, false, "Same day, but it doesn't name a fund house: check it"]]);
  });

  test("an insurance premium starts unticked even with a unique exact same-day match and no spending split", () => {
    const entries = [entry("insurance", "WITHDRAWAL", "5000.00", "2023-04-10", "NACH HDFCLIFE INSURANCE PREMIUM")];
    const { plan } = planFor(data, { existing: entries, bank: BANK });
    const facts = new Map([["insurance", { converts: true, inSpending: true, spending: { splitCategories: 0, kinds: [] }, synced: false }]]);
    const pairs = bankPairs({ transactions: plan, matches: bankMatches(plan, entries, new Set()), existing: entries, linked: new Set(), facts, amcOf: () => "HDFC Mutual Fund" });
    assert.deepEqual(pairs.map((p) => [p.exact, p.days, p.otherEntries, p.otherTransactions, p.splits, p.strong, p.reason]),
      [[true, 0, 0, 0, false, false, "Same day, but it doesn't name a fund house: check it"]]);
  });

  test("Bank in a fund house's name does not tick an unrelated bank payment", () => {
    const entries = [entry("unrelated-bank", "WITHDRAWAL", "5000.00", "2023-04-10", "NEFT OTHER BANK SALARY")];
    const { plan } = planFor(data, { existing: entries, bank: BANK });
    const facts = new Map([["unrelated-bank", { converts: true, inSpending: true, spending: { splitCategories: 0, kinds: [] }, synced: false }]]);
    const pairs = bankPairs({ transactions: plan, matches: bankMatches(plan, entries, new Set()), existing: entries, linked: new Set(), facts, amcOf: () => "Fictiva Bank Mutual Fund" });
    assert.deepEqual(pairs.map((p) => [p.exact, p.days, p.otherEntries, p.otherTransactions, p.splits, p.strong, p.reason]),
      [[true, 0, 0, 0, false, false, "Same day, but it doesn't name a fund house: check it"]]);
  });

  test("a pair starts ticked only with strong evidence; the others say what to check", () => {
    const entries = [
      entry("same-day", "WITHDRAWAL", "5000.00", "2023-04-10", "ACH D- FICTIVA MF SIP"),
      entry("next-day", "WITHDRAWAL", "5000.00", "2023-05-11", "BSE STAR MF"),
      entry("no-house", "WITHDRAWAL", "5000.00", "2023-06-12", "UPI/CASH TO SELF"),
      entry("late", "DEPOSIT", "3000.00", "2023-07-07", "UPI/RENT SHARE"),
      entry("dividend", "DEPOSIT", "7276.48", "2024-01-01", "FICTIVA MF IDCW"),
    ];
    assert.deepEqual(view(pairsFor(entries)), [
      ["same-day", true, "Same day · names the fund house"],
      ["next-day", true, "1 day apart · mentions mutual funds"],
      ["no-house", false, "Same day, but it doesn't name a fund house: check it"],
      ["late", false, "6 days apart, and it doesn't name a fund house: check it"],
      ["dividend", false, "4 days apart: check it"],
    ]);
  });

  test("an entry that more than one transaction or entry could be is never ticked", () => {
    const twoEntries = [
      entry("ach", "WITHDRAWAL", "5000.00", "2023-04-10", "ACH FICTIVA MF"),
      entry("nach", "WITHDRAWAL", "5000.00", "2023-04-11", "NACH FICTIVA MF"),
    ];
    // The April SIP fits both entries, and gets the closer one.
    assert.deepEqual(view(pairsFor(twoEntries)), [["ach", false, "2 entries match: check it"]]);
    // One entry two SIPs could be: offered to the closer, without a tick.
    const close = statement(folio("F1", [scheme("A", [...sip("2023-04-10"), ...sip("2023-04-13")], { close: "206.176", close_calculated: "206.176" })]));
    const entries = [entry("one", "WITHDRAWAL", "5000.00", "2023-04-11", "FICTIVA MF")];
    const { plan } = planFor(close, { existing: entries, bank: BANK });
    const pairs = bankPairs({ transactions: plan, matches: bankMatches(plan, entries, new Set()), existing: entries, linked: new Set(), facts: new Map(), amcOf: () => "Fictiva Mutual Fund" });
    assert.deepEqual(view(pairs), [["one", false, "2 payments match this entry: check it"]]);
    assert.equal(pairs[0].t, plan[0]);
  });

  test("an entry linking would change into a transfer is ticked only when it's known to have no spending split", () => {
    const entries = [entry("same-day", "WITHDRAWAL", "5000.00", "2023-04-10", "FICTIVA MF")];
    const facts = (f) => new Map([["same-day", { converts: true, synced: false, ...f }]]);
    const one = (f) => view(pairsFor(entries, facts(f)))[0].slice(1);
    assert.deepEqual(one({ inSpending: true, spending: { splitCategories: 0, kinds: [] } }), [true, "Same day · names the fund house"]);
    // An account outside Spending: said once above the matches, not a reason to hold the tick back.
    assert.deepEqual(one({ inSpending: false }), [true, "Same day · names the fund house"]);
    assert.deepEqual(one({ inSpending: true, spending: { splitCategories: 2, splitKind: "expense", kinds: [] } }),
      [false, "Same day · names the fund house, but linking deletes its split across spending categories: check it"]);
    assert.deepEqual(one({ inSpending: true }), [false, "Same day · names the fund house, but its spending split couldn't be checked: check it"]);
    assert.deepEqual(one({ inSpending: undefined }), [false, "Same day · names the fund house, but its spending split couldn't be checked: check it"]);
    // A transfer keeps its type, so its split stays.
    assert.deepEqual(one({ converts: false, inSpending: true }), [true, "Same day · names the fund house"]);
  });

  test("a payment matched by its printed amount with stamp duty counts as exact", () => {
    // The bank pays the printed ₹4,999.75 and ₹0.25 stamp duty: ₹5,000, a few paise off units × NAV.
    const pairs = pairsFor([entry("paid", "WITHDRAWAL", "5000.00", "2023-04-10", "FICTIVA MF")]);
    assert.deepEqual(pairs.map((p) => [p.exact, p.strong]), [[true, true]]);
  });

  test("the bank movements: those that use an entry already there, and those that get a new transfer", () => {
    const { plan } = planFor(data, { bank: BANK });
    const sent = plan.filter((t) => sends(t, () => false));
    assert.deepEqual(bankMovements(sent, (t) => t === sent[0]), { linked: 1, created: 4 });
  });
});
