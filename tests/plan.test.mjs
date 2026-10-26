// Which mapped transactions the import sends, checked against activities as Wealthfolio's
// `activities.getAll` returns them. Wealthfolio's own checks are faked: the real ones run in
// the throwaway-server test described in the pull request.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { format } from "../src/cas/decimal.ts";
import { mapStatement } from "../src/cas/mapping.ts";
import {
  closingUnits,
  importRows,
  indexActivities,
  openingUnits,
  planImport,
  rowsOf,
  sameUnits,
  statementDay,
} from "../src/cas/plan.ts";
import { sha256 } from "../src/lib/sha256.ts";

const tx = (date, type, amount, units = null, nav = null, extra = {}) => ({
  date,
  description: type,
  amount,
  units,
  nav,
  balance: null,
  type,
  dividend_rate: null,
  gift_folio: null,
  ...extra,
});

const scheme = (name, transactions, extra = {}) => ({
  scheme: name,
  advisor: "DIRECT",
  rta_code: name,
  rta: "CAMS",
  type: "N/A",
  isin: `INF-${name}`,
  amfi: null,
  nominees: [],
  open: "0",
  close: "0",
  close_calculated: "0",
  valuation: { date: "2025-03-31", nav: "10", cost: null, value: "0" },
  transactions,
  ...extra,
});

const statement = (...schemes) => ({
  statement_period: { from: "01-Apr-2023", to: "31-Mar-2025" },
  folios: [{ folio: "F1", amc: "Made-up Mutual Fund", name: null, PAN: "ABCDE1234F", KYC: null, PANKYC: null, schemes }],
  investor_info: { name: "", email: "", address: "", mobile: "" },
  cas_type: "DETAILED",
  file_type: "CAMS",
  parse_warnings: [],
});

const ACCOUNT = "account-1";
const target = (folio, s) => ({
  accountId: ACCOUNT,
  asset: { symbol: s.rta_code.toLowerCase(), exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND" },
});

const map = (data, existing = []) =>
  mapStatement(data, {
    target: (folio, s) => ({ ...target(folio, s), openingCovered: true }),
    alreadyImported: indexActivities(existing).has,
  });

/** Wealthfolio's checkImport, without its duplicate check: every row valid unless `errors` names its line. */
const check = (rows, errors = {}) =>
  rows.map((row) =>
    errors[row.lineNumber] ? { ...row, isValid: false, errors: { amount: [errors[row.lineNumber]] } } : { ...row },
  );

let id = 0;
/** How Wealthfolio stores and returns an imported row (Wealthfolio 3.11.0's web API). */
const stored = (row) => ({
  id: `activity-${++id}`,
  accountId: row.accountId,
  activityType: row.activityType,
  subtype: row.subtype ?? null,
  status: "POSTED",
  date: `${row.date}T00:00:00+00:00`,
  quantity: row.quantity ? `${row.quantity}000` : null,
  unitPrice: row.unitPrice ?? null,
  amount: row.activityType === "BUY" || row.activityType === "SELL" ? `${row.amount}0000` : row.amount,
  fee: null,
  tax: row.tax ?? null,
  currency: row.currency,
  needsReview: false,
  comment: null,
  assetId: row.symbol ? `uuid-${row.symbol}` : "",
  assetSymbol: row.symbol ? row.symbol.toUpperCase() : "",
  exchangeMic: row.exchangeMic ?? null,
});

const plan = (data, existing = [], errors = {}) => {
  const mapping = map(data, existing);
  return planImport(mapping, existing, check(rowsOf(mapping), errors));
};

const statuses = (planned) => planned.map((t) => t.status);

const sip = (date, amount = "4999.75", units = "103.088", nav = "48.5000") => [
  tx(date, "PURCHASE_SIP", amount, units, nav),
  tx(date, "STAMP_DUTY_TAX", "0.25"),
];

describe("duplicates", () => {
  const data = statement(scheme("A", [...sip("2023-04-10"), ...sip("2023-05-10")]), scheme("B", sip("2023-04-10", "999.95", "10.000", "99.9950")));

  test("a first import sends every transaction with its cash", () => {
    const planned = plan(data);
    assert.deepEqual(statuses(planned), ["new", "new", "new"]);
    const rows = importRows(planned, () => false);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => !r.forceImport));
  });

  test("a second import finds every row Wealthfolio stored, trades included", () => {
    const existing = importRows(plan(data), () => false).map(stored);
    const planned = plan(data, existing);
    assert.deepEqual(statuses(planned), ["existing", "existing", "existing"]);
    assert.deepEqual(importRows(planned, () => false), []);
    assert.ok(planned.flatMap((t) => t.rows).every((r) => r.existingId));
  });

  test("an overlapping statement sends only the new transactions", () => {
    const first = statement(scheme("A", sip("2023-04-10")));
    const existing = importRows(plan(first), () => false).map(stored);
    const planned = plan(data, existing);
    assert.deepEqual(statuses(planned), ["existing", "new", "new"]);
    assert.deepEqual(
      importRows(planned, () => false).map((r) => `${r.activityType} ${r.date}`),
      ["BUY 2023-05-10", "DEPOSIT 2023-05-10", "BUY 2023-04-10", "DEPOSIT 2023-04-10"],
    );
  });

  test("two equal purchases of different funds on one day keep both deposits once confirmed", () => {
    const twins = statement(scheme("A", sip("2023-04-10")), scheme("B", sip("2023-04-10")));
    const planned = plan(twins);
    assert.deepEqual(statuses(planned), ["new", "duplicate"]);
    const [, second] = planned;
    assert.equal(second.rows[0].repeatsLine, undefined, "the purchases are of different funds");
    assert.equal(second.rows[1].repeatsLine, 2, "the deposit repeats line 2");
    assert.equal(importRows(planned, () => false).length, 2, "skipped unless confirmed");

    const sent = importRows(planned, (t) => t === second);
    assert.deepEqual(
      sent.map((r) => `${r.activityType} ${r.forceImport ? "forced" : ""}`),
      ["BUY ", "DEPOSIT ", "BUY forced", "DEPOSIT forced"],
    );
    // Wealthfolio stores a forced row without its duplicate key; the add-on still recognises it.
    const again = plan(twins, sent.map(stored));
    assert.deepEqual(statuses(again), ["existing", "existing"]);
  });

  test("a transaction Wealthfolio has only half of needs a decision, and goes in whole", () => {
    const [buy] = importRows(plan(data), () => false);
    const planned = plan(data, [stored(buy)]);
    assert.equal(planned[0].status, "duplicate");
    assert.ok(planned[0].rows[0].existingId);
    assert.equal(planned[0].rows[1].existingId, undefined);
    assert.deepEqual(importRows([planned[0]], () => true).map((r) => r.activityType), ["BUY", "DEPOSIT"]);
  });

  test("an activity Wealthfolio has is matched to one row only", () => {
    const purchase = tx("2023-04-10", "PURCHASE", "5000.00", "103.093", "48.5000");
    const twice = statement(scheme("A", [purchase, purchase]));
    const [buy, deposit] = importRows(plan(twice), () => false);
    const planned = plan(twice, [stored(buy), stored(deposit)]);
    assert.deepEqual(statuses(planned), ["existing", "duplicate"]);
    assert.equal(planned[1].rows[0].repeatsLine, 1);
  });

  test("a row checkImport rejects keeps its whole transaction out", () => {
    const planned = plan(data, [], { 2: "Amount is wrong." });
    assert.deepEqual(statuses(planned), ["invalid", "new", "new"]);
    assert.deepEqual(planned[0].rows[1].errors, ["Amount is wrong."]);
    assert.equal(importRows(planned, () => true).length, 4);
  });

  test("a duplicate only Wealthfolio reports still needs a decision", () => {
    const mapping = map(data);
    const checked = check(rowsOf(mapping)).map((r) =>
      r.lineNumber === 2 ? { ...r, duplicateOfId: "elsewhere", warnings: { _duplicate: ["Duplicate activity already exists"] } } : r,
    );
    const planned = planImport(mapping, [], checked);
    assert.equal(planned[0].status, "duplicate");
    assert.deepEqual(planned[0].rows[1].warnings, [], "the duplicate warning is shown as a reason, not repeated");
  });

  test("activities in other accounts, other funds or with a comment aren't duplicates", () => {
    const rows = importRows(plan(data), () => false);
    const elsewhere = [
      { ...stored(rows[0]), accountId: "account-2" },
      { ...stored(rows[0]), assetSymbol: "OTHER" },
      { ...stored(rows[1]), comment: "Salary" },
      { ...stored(rows[1]), date: "2023-04-11T00:00:00+00:00" },
    ];
    assert.deepEqual(statuses(plan(data, elsewhere)), ["new", "new", "new"]);
  });

  test("a reinvested dividend and a payout are matched too", () => {
    const income = statement(
      scheme("A", [tx("2023-09-25", "DIVIDEND_REINVEST", "1312.39", "84.054", "15.6145"), tx("2023-09-25", "STAMP_DUTY_TAX", "0.07")]),
      scheme("B", [tx("2023-12-28", "DIVIDEND_PAYOUT", "7276.48")]),
    );
    const existing = importRows(plan(income), () => false).map(stored);
    assert.equal(existing.length, 3);
    assert.deepEqual(statuses(plan(income, existing)), ["existing", "existing"]);
  });

  test("an earlier import of a reversed purchase is reported by the mapping", () => {
    const purchase = sip("2024-01-10", "999.95", "99.995", "10.0000");
    const earlier = importRows(plan(statement(scheme("A", purchase))), () => false).map(stored);
    const mapping = map(statement(scheme("A", [...purchase, tx("2024-01-15", "REVERSAL", "-999.95", "-99.995", "10.0000")])), earlier);
    assert.deepEqual(mapping.transactions, []);
    assert.match(mapping.warnings[0].message, /^Wealthfolio has this purchase from an earlier import/);
  });
});

describe("units", () => {
  const opening = (open, close, transactions) =>
    statement(scheme("A", transactions, { open, close }));

  test("statement dates", () => {
    assert.equal(statementDay("01-Apr-2023"), "2023-04-01");
    assert.equal(statementDay("31-DEC-2024"), "2024-12-31");
    assert.throws(() => statementDay("2023-04-01"));
  });

  test("an opening balance is covered by Wealthfolio's units before the statement", () => {
    const earlier = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const later = importRows(plan(statement(scheme("A", sip("2023-04-10")))), () => false).map(stored);
    const data = opening("103.088", "206.176", sip("2023-04-10"));
    const [fund] = openingUnits(data, target, [...earlier, ...later]);
    assert.equal(format(fund.statement), "103.088");
    assert.equal(format(fund.held), "103.088", "only activities before the statement count");
    assert.ok(sameUnits(fund));
    assert.ok(!sameUnits(openingUnits(data, target, later)[0]));
  });

  test("only posted activities count towards opening and closing units", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const data = opening("103.088", "103.088", []);
    const activities = [buy, ...["DRAFT", "PENDING", "VOID"].map((status) => ({ ...buy, status, quantity: "999" }))];
    assert.ok(sameUnits(openingUnits(data, target, activities)[0]));
    assert.ok(sameUnits(closingUnits(data, target, activities)[0]));
  });

  test("asset income and security transfers contribute their received or delivered units", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-04-10")))), () => false).map(stored);
    const activities = [
      { ...buy, activityType: "DIVIDEND", subtype: "DIVIDEND_IN_KIND", quantity: "5" },
      { ...buy, activityType: "INTEREST", subtype: "STAKING_REWARD", quantity: "7" },
      { ...buy, activityType: "TRANSFER_IN", quantity: "3" },
      { ...buy, activityType: "TRANSFER_OUT", quantity: "2" },
      { ...buy, activityType: "DIVIDEND", subtype: null, quantity: "100" },
      { ...buy, activityType: "ADJUSTMENT", subtype: "RETURN_OF_CAPITAL", quantity: "100" },
    ];
    assert.ok(sameUnits(closingUnits(opening("0", "13", []), target, activities)[0]));
  });

  test("splits and option expiry leave units unknown only within the matching posted history", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const data = opening("103.088", "103.088", []);
    const split = { ...buy, activityType: "SPLIT", quantity: null, amount: "2" };
    const expiry = { ...buy, activityType: "ADJUSTMENT", subtype: "OPTION_EXPIRY", quantity: "10" };
    for (const row of [split, expiry]) {
      for (const count of [openingUnits, closingUnits]) {
        const [fund] = count(data, target, [buy, row]);
        assert.equal(fund.held, undefined);
        assert.ok(!sameUnits(fund));
      }
    }
    const irrelevant = [
      { ...split, status: "DRAFT" },
      { ...split, date: "2025-04-01" },
      { ...split, accountId: "another-account" },
      { ...split, assetSymbol: "ANOTHER-FUND" },
    ];
    assert.ok(sameUnits(closingUnits(data, target, [buy, ...irrelevant])[0]));
    const during = { ...split, date: "2023-04-01" };
    assert.ok(sameUnits(openingUnits(data, target, [buy, during])[0]));
    assert.equal(closingUnits(data, target, [buy, during])[0].held, undefined);
  });

  test("sales and reinvested dividends count, cash and other funds don't", () => {
    const data = opening("0", "57.142", [
      ...sip("2023-04-10"),
      tx("2023-06-01", "REDEMPTION", "-3000.00", "-61.000", "49.1803"),
      tx("2023-09-25", "DIVIDEND_REINVEST", "731.39", "15.054", "48.5844"),
    ]);
    const rows = importRows(plan(data), () => false);
    const other = { ...stored(rows[0]), assetSymbol: "OTHER" };
    const [fund] = closingUnits(data, target, [...rows.map(stored), other]);
    assert.equal(format(fund.held), "57.142");
    assert.ok(sameUnits(fund));
  });
});

test("sha256", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("a".repeat(56)), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
});
