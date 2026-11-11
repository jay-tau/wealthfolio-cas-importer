// Which mapped transactions the import sends, checked against activities as Wealthfolio's
// `activities.getAll` returns them. Wealthfolio's own checks are faked here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { format } from "../src/cas/decimal.ts";
import { mapStatement } from "../src/cas/mapping.ts";
import {
  bankCandidates,
  bankMatches,
  closingUnits,
  engineTimeZone,
  fundRef,
  fundRefs,
  giftEntries,
  importRows,
  indexActivities,
  linkBankRow,
  localDay,
  openingUnits,
  planImport,
  RECORD_PREFIX,
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

/** Each stored asset's profile: `fundRef` of the symbol and exchange the import created it with. */
const profiles = new Map();
/** Which fund each stored asset is. `target` confirms funds without asset IDs, so they go by profile. */
const fundsOf = (data) => fundRefs(data.folios.flatMap((f) => f.schemes.map((s) => target(f, s).asset)), profiles);

const map = (data, existing = [], bankAccountId = undefined, funds = fundsOf(data)) =>
  mapStatement(data, {
    target: (folio, s) => ({ ...target(folio, s), openingCovered: true, bankAccountId }),
    alreadyImported: indexActivities(existing, funds).has,
  });

/** Wealthfolio's checkImport, without its duplicate check: every row valid unless `errors` names its line. */
const check = (rows, errors = {}) =>
  rows.map((row) =>
    errors[row.lineNumber] ? { ...row, isValid: false, errors: { amount: [errors[row.lineNumber]] } } : { ...row },
  );
/** The same before Wealthfolio 3.13.0, which drops the rows' IDs and metadata. */
const checkWithoutIds = (rows, errors = {}) => check(rows, errors).map(({ sourceRecordId, metadata, ...row }) => row);

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

let id = 0;
/** A decimal with trailing zeros, as Wealthfolio returns it. */
const padded = (value) => `${value}${value.includes(".") ? "" : "."}`;
/**
 * How Wealthfolio stores and returns an imported row (Wealthfolio 3.12.0's web API): without its ID,
 * as version 2.2.0 and earlier imported it, or as one entered by hand.
 */
const stored = (row) => {
  if (row.symbol) profiles.set(`uuid-${row.symbol}`, fundRef(row.symbol, row.exchangeMic));
  return {
    id: `activity-${++id}`,
    accountId: row.accountId,
    activityType: row.activityType,
    subtype: row.subtype ?? null,
    status: "POSTED",
    date: `${row.date}T00:00:00+00:00`,
    quantity: row.quantity ? `${padded(row.quantity)}000` : null,
    unitPrice: row.unitPrice ?? null,
    amount: row.activityType === "BUY" || row.activityType === "SELL" ? `${padded(row.amount)}0000` : row.amount ?? null,
    fee: null,
    tax: row.tax ?? null,
    currency: row.currency,
    needsReview: false,
    comment: null,
    assetId: row.symbol ? `uuid-${row.symbol}` : "",
    assetSymbol: row.symbol ? row.symbol.toUpperCase() : "",
    exchangeMic: row.exchangeMic ?? null,
    sourceGroupId: row.sourceGroupId ?? null,
    sourceRecordId: null,
  };
};

/** The same in Wealthfolio 3.13.0, which keeps the row's ID behind the add-on's prefix. */
const storedWithId = (row) => ({ ...stored(row), sourceRecordId: `${RECORD_PREFIX}${row.sourceRecordId}` });

/** `activity` moved to another asset, with its own profile. */
const otherFund = (activity, symbol = "OTHER") => {
  profiles.set(`uuid-${symbol}`, fundRef(symbol, "XBOM"));
  return { ...activity, assetId: `uuid-${symbol}`, assetSymbol: symbol };
};

const plan = (data, existing = [], errors = {}, bankAccountId = undefined, funds = fundsOf(data), checker = check) => {
  const mapping = map(data, existing, bankAccountId, funds);
  return planImport(mapping, existing, checker(rowsOf(mapping), errors), funds);
};
/** `plan` with Wealthfolio before 3.13.0. */
const planWithoutIds = (data, existing = [], errors = {}, bankAccountId = undefined, funds = fundsOf(data)) =>
  plan(data, existing, errors, bankAccountId, funds, checkWithoutIds);

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

  test("two equal purchases of different funds on one day keep both deposits, which their IDs tell apart", () => {
    const twins = statement(scheme("A", sip("2023-04-10")), scheme("B", sip("2023-04-10")));
    const planned = plan(twins);
    assert.deepEqual(statuses(planned), ["new", "new"]);
    assert.equal(planned[1].rows[1].repeatsLine, undefined);
    const sent = importRows(planned, () => false);
    assert.equal(sent.length, 4);
    assert.ok(sent.every((r) => !r.forceImport));
    const again = plan(twins, sent.map(storedWithId));
    assert.deepEqual(statuses(again), ["existing", "existing"]);
  });

  test("before Wealthfolio 3.13.0, two equal purchases of different funds on one day keep both deposits once confirmed", () => {
    const twins = statement(scheme("A", sip("2023-04-10")), scheme("B", sip("2023-04-10")));
    const planned = planWithoutIds(twins);
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
    const again = planWithoutIds(twins, sent.map(stored));
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
    const existing = [stored(buy), stored(deposit)];
    const before = planWithoutIds(twice, existing);
    assert.deepEqual(statuses(before), ["existing", "duplicate"]);
    assert.equal(before[1].rows[0].repeatsLine, 1);
    // Wealthfolio 3.13.0 reports the second as a duplicate of the same activity, by its values.
    const mapping = map(twice, existing);
    const checked = check(rowsOf(mapping)).map((r) => (r.lineNumber > 2 ? { ...r, duplicateOfId: existing[r.lineNumber - 3].id } : r));
    const planned = planImport(mapping, existing, checked, fundsOf(twice));
    assert.deepEqual(statuses(planned), ["existing", "duplicate"]);
    assert.deepEqual(planned[1].rows.map((r) => [r.existingId, r.repeatsLine, r.flagged]), [[undefined, undefined, true], [undefined, undefined, true]]);
  });

  test("a row checkImport rejects keeps its whole transaction out", () => {
    const planned = plan(data, [], { 2: "Amount is wrong." });
    assert.deepEqual(statuses(planned), ["invalid", "new", "new"]);
    assert.deepEqual(planned[0].rows[1].errors, ["Amount is wrong."]);
    assert.equal(importRows(planned, () => true).length, 4);
  });

  test("checkImport's answer for a new fund chosen from AMFI counts like any other row's", () => {
    // Since Wealthfolio 3.13.0, checkImport accepts a trade in a fund chosen from AMFI that it
    // doesn't have yet, as its import does, although AMFI's funds have no exchange.
    const amfi = { symbol: "122639", quoteCcy: "INR", instrumentType: "MUTUALFUND", providerId: "AMFI", providerSymbol: "122639" };
    const assetOf = (folio, s) => (s.rta_code === "A" ? amfi : target(folio, s).asset);
    const mapping = mapStatement(data, {
      target: (folio, s) => ({ accountId: ACCOUNT, asset: assetOf(folio, s), openingCovered: true }),
      alreadyImported: () => false,
    });
    const funds = fundRefs(data.folios[0].schemes.map((s) => assetOf(data.folios[0], s)), profiles);
    const planned = planImport(mapping, [], rowsOf(mapping), funds);
    assert.deepEqual(statuses(planned), ["new", "new", "new"]);
    assert.equal(importRows(planned, () => false).length, 6);
    // An error for its trade, even the symbol error Wealthfolio 3.12.0 gave every such trade, keeps
    // the transaction out and is shown.
    const noExchange = ["Could not find '122639' in market data. Please search for the correct ticker symbol."];
    const rejected = rowsOf(mapping).map((r) => (r.symbol === "122639" ? { ...r, isValid: false, errors: { symbol: noExchange } } : { ...r }));
    const refused = planImport(mapping, [], rejected, funds);
    assert.deepEqual(statuses(refused), ["invalid", "invalid", "new"]);
    assert.deepEqual(refused[0].rows[0].errors, noExchange);
    assert.equal(importRows(refused, () => false).length, 2);
    // So does a rejection without a message, which gets one of its own.
    const silent = rowsOf(mapping).map((r) => (r.symbol === "122639" ? { ...r, isValid: false, errors: {} } : { ...r }));
    const unexplained = planImport(mapping, [], silent, funds);
    assert.deepEqual(statuses(unexplained), ["invalid", "invalid", "new"]);
    assert.deepEqual(unexplained[0].rows[0].errors, ["Wealthfolio can't import this row."]);
    assert.equal(importRows(unexplained, () => false).length, 2);
  });

  test("a duplicate only Wealthfolio reports still needs a decision", () => {
    const mapping = map(data);
    const checked = check(rowsOf(mapping)).map((r) =>
      r.lineNumber === 2 ? { ...r, duplicateOfId: "elsewhere", warnings: { _duplicate: ["Duplicate activity already exists"] } } : r,
    );
    const planned = planImport(mapping, [], checked, fundsOf(data));
    assert.equal(planned[0].status, "duplicate");
    assert.deepEqual(planned[0].rows[1].warnings, [], "the duplicate warning is shown as a reason, not repeated");
  });

  test("activities in other accounts, other funds or with a comment aren't duplicates", () => {
    const rows = importRows(plan(data), () => false);
    const elsewhere = [
      { ...stored(rows[0]), accountId: "account-2" },
      otherFund(stored(rows[0])),
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

describe("row IDs", () => {
  const data = statement(scheme("A", [...sip("2023-04-10"), ...sip("2023-05-10")]));
  const sent = () => importRows(plan(data), () => false);

  test("Wealthfolio keeps the IDs behind the manifest's id", async () => {
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.equal(RECORD_PREFIX, `addon:${manifest.id}:`);
  });

  test("a row matches the activity imported with its ID, whatever was changed in Wealthfolio since", () => {
    const existing = sent().map(storedWithId).map((a) => ({ ...a, amount: "1.00", comment: "Edited", date: "2023-04-11T00:00:00+00:00" }));
    const planned = plan(data, existing);
    assert.deepEqual(statuses(planned), ["existing", "existing"]);
    assert.deepEqual(planned.flatMap((t) => t.rows.map((r) => r.existingId)), existing.map((a) => a.id));
    assert.deepEqual(importRows(planned, () => false), []);
  });

  test("rows imported before the IDs are found by their values, each once", () => {
    const planned = plan(data, sent().map(stored));
    assert.deepEqual(statuses(planned), ["existing", "existing"]);
    assert.deepEqual(importRows(planned, () => false), []);
  });

  test("an activity imported with another row's ID isn't this row, whatever its values", () => {
    // Another folio's equal purchase, from another statement, in the same account.
    const other = statement(scheme("A", sip("2023-04-10")));
    other.folios[0].folio = "F2";
    const existing = importRows(plan(other), () => false).map(storedWithId);
    const mine = statement(scheme("A", sip("2023-04-10")));
    assert.deepEqual(statuses(plan(mine, existing)), ["new"]);
    // Imported before the IDs, it's taken for this row by its values.
    assert.deepEqual(statuses(plan(mine, existing.map((a) => ({ ...a, sourceRecordId: null })))), ["existing"]);
  });

  test("IDs match in their own account, and only the add-on's", () => {
    const moved = sent().map(storedWithId).map((a) => ({ ...a, accountId: "account-2" }));
    assert.deepEqual(statuses(plan(data, moved)), ["new", "new"]);
    // Another add-on's or a broker's IDs don't count: those activities match by their values.
    const others = sent().map((r) => ({ ...stored(r), sourceRecordId: `addon:other-addon:${r.sourceRecordId}` }));
    assert.deepEqual(statuses(plan(data, others)), ["existing", "existing"]);
    assert.deepEqual(statuses(plan(data, others.map((a) => ({ ...a, comment: "Edited" })))), ["new", "new"]);
  });

  test("a statement that omits the fund's ISIN finds the rows a statement with it imported", () => {
    const existing = importRows(plan(data), () => false).map(storedWithId);
    // Another issuer's statement of the same folio, confirmed as the same fund.
    for (const extra of [{ isin: null }, { isin: null, rta: "KFINTECH" }]) {
      const other = statement(scheme("A", [...sip("2023-04-10"), ...sip("2023-05-10")], extra));
      const planned = plan(other, existing);
      assert.deepEqual(statuses(planned), ["existing", "existing"], JSON.stringify(extra));
      assert.deepEqual(importRows(planned, () => false), []);
    }
  });

  test("another fund's charge or unsupported row doesn't change a unit-less payout's ID when funds are reordered", () => {
    const payout = scheme("B", [tx("2024-01-10", "DIVIDEND_PAYOUT", "100")]);
    for (const type of ["TDS_TAX", "STT_TAX", "STAMP_DUTY_TAX", "UNKNOWN", "MISC", "REVERSAL"]) {
      const other = scheme("A", [
        tx("2024-01-10", "REDEMPTION", "-1000", "-100", "10"),
        tx("2024-01-10", type, "100"),
      ]);
      for (const bank of [undefined, "bank-1"]) {
        const existing = importRows(plan(statement(other, payout), [], {}, bank), () => false).map(storedWithId);
        assert.equal(existing.length, bank ? 6 : 4);
        const planned = plan(statement(payout, other), existing, {}, bank);
        assert.deepEqual(statuses(planned), ["existing", "existing"], `${type}, bank ${bank}`);
        assert.deepEqual(importRows(planned, () => false), []);
      }
    }
  });

  test("a fund account's cash found by its ID keeps it without its trade", () => {
    const [, deposit] = sent();
    const existing = [storedWithId(deposit)];
    const planned = plan(data, existing);
    assert.equal(planned[0].status, "duplicate");
    assert.deepEqual(planned[0].rows.map((r) => r.existingId), [undefined, existing[0].id]);
  });

  test("a fund account's cash found by its ID under the other type says so", () => {
    // Imported as a deposit, and now with a bank account as a transfer in.
    const planned = plan(data, sent().map(storedWithId), {}, "bank-1");
    assert.deepEqual(statuses(planned), ["existing", "existing"]);
    assert.deepEqual(
      planned[0].rows.map((r) => [r.activity.activityType, r.existingType]),
      [["BUY", undefined], ["TRANSFER_IN", "DEPOSIT"], ["TRANSFER_OUT", undefined]],
    );
  });

  test("a reversed purchase imported with its ID needs correcting, even after an edit", () => {
    const purchase = tx("2023-04-10", "PURCHASE", "5000.00", "103.093", "48.5000");
    const existing = importRows(plan(statement(scheme("A", [purchase]))), () => false)
      .map(storedWithId)
      .map((a) => ({ ...a, comment: "Edited" }));
    const reversed = statement(scheme("A", [purchase, tx("2023-04-20", "REVERSAL", "-5000.00", "-103.093", "48.5000")]));
    const mapping = map(reversed, existing);
    assert.match(mapping.warnings[0].message, /^Wealthfolio has this purchase from an earlier import, but the statement reverses it\./);
  });
});

describe("mergers", () => {
  const out = (date = "2024-08-01") => tx(date, "SWITCH_OUT_MERGER", "-1000.00", "-100.000", "10.0000");
  const into = (date = "2024-08-01") => tx(date, "SWITCH_IN_MERGER", "1000.00", "50.000", "20.0000");
  const data = statement(scheme("A", [out()]), scheme("B", [into()]));
  /** What v1.2.0 and earlier imported for the merger, as Wealthfolio returns it. */
  const earlierImport = () => plan(data)[0].transaction.earlier.map(stored);

  test("a merger sends both conversion rows, and a second read finds both", () => {
    const planned = plan(data);
    assert.deepEqual(statuses(planned), ["new"]);
    const sent = importRows(planned, () => false);
    assert.deepEqual(importRows(planned, () => true, () => true), sent, "bank-row reuse cannot split a conversion");
    assert.deepEqual(
      sent.map((r) => `${r.activityType} ${r.subtype} ${r.symbol}`),
      ["ADJUSTMENT CONVERSION_OUT a", "ADJUSTMENT CONVERSION_IN b"],
    );
    const again = plan(data, sent.map(stored));
    assert.deepEqual(statuses(again), ["existing"]);
    assert.ok(again[0].rows.every((r) => r.existingId));
    assert.equal(again[0].earlier, undefined);
    assert.deepEqual(importRows(again, () => true), [], "a conversion is never forced");
  });

  test("a statement that omits the funds' ISINs finds the conversion a statement with them imported", () => {
    const existing = importRows(plan(data), () => false).map(storedWithId);
    const other = statement(scheme("A", [out()], { isin: null }), scheme("B", [into()], { isin: null }));
    const planned = plan(other, existing);
    assert.deepEqual(statuses(planned), ["existing"]);
    assert.equal(planned[0].problem, undefined);
    assert.deepEqual(importRows(planned, () => false), []);
  });

  test("an overlapping statement finds the merger, and separate mergers aren't mistaken for each other", () => {
    const existing = importRows(plan(data), () => false).map(stored);
    const overlapping = statement(
      scheme("A", [...sip("2024-07-10", "1000.00", "100.000", "10.0000"), out(), out("2024-09-01")]),
      scheme("B", [into(), into("2024-09-01")]),
    );
    // The same merger in a second folio of the same account is another conversion.
    overlapping.folios.push({ ...overlapping.folios[0], folio: "F2", schemes: [scheme("A", [out()]), scheme("B", [into()])] });
    const planned = plan(overlapping, existing);
    assert.deepEqual(
      planned.map((t) => `${t.transaction.folio} ${t.transaction.activity.date} ${t.status}`),
      ["F1 2024-07-10 new", "F1 2024-08-01 existing", "F1 2024-09-01 new", "F2 2024-08-01 new"],
    );
  });

  test("a conversion changed in Wealthfolio isn't imported again, as Wealthfolio would refuse its group", () => {
    const [leaving, arriving] = importRows(plan(data), () => false).map(stored);
    const moved = (a) => ({ ...a, date: "2024-08-02T00:00:00+00:00" });
    for (const existing of [[leaving, { ...arriving, quantity: "51" }], [moved(leaving), moved(arriving)], [leaving], [arriving]]) {
      const [t] = plan(data, existing);
      assert.equal(t.status, "invalid");
      assert.match(t.problem, /^Wealthfolio has this conversion from an earlier import, changed since, so it isn't imported again\./);
      assert.deepEqual(importRows([t], () => true), []);
    }
    // Another merger's group is no conflict.
    assert.deepEqual(statuses(plan(data, [{ ...moved(leaving), sourceGroupId: "another" }])), ["new"]);
  });

  test("a merger an earlier version imported as a sale and a purchase is already in Wealthfolio", () => {
    const earlier = earlierImport();
    assert.deepEqual(earlier.map((a) => `${a.activityType} ${a.assetSymbol}`), ["SELL A", "WITHDRAWAL ", "BUY B", "DEPOSIT "]);
    const [t] = plan(data, earlier);
    assert.equal(t.status, "existing");
    assert.deepEqual(
      t.earlier.map((r) => r.existingId),
      earlier.map((a) => a.id),
    );
    assert.equal(t.problem, undefined);
    assert.deepEqual(importRows([t], () => true), []);
  });

  test("an earlier import that lacks a row blocks the conversion", () => {
    const earlier = earlierImport();
    for (const missing of earlier) {
      const [t] = plan(data, earlier.filter((a) => a !== missing));
      assert.equal(t.status, "invalid");
      assert.match(t.problem, /^Wealthfolio has part of this merger from an earlier import/);
      assert.deepEqual(
        t.earlier.map((r) => !!r.existingId),
        earlier.map((a) => a !== missing),
      );
      assert.deepEqual(importRows([t], () => true), []);
    }
  });

  test("a row checkImport rejects keeps both out", () => {
    for (const line of [1, 2]) {
      const [t] = plan(data, [], { [line]: "A conversion must be two rows." });
      assert.equal(t.status, "invalid");
      assert.deepEqual(importRows([t], () => true), []);
    }
  });

  test("earlier merger checks don't take an ordinary transaction's cash", () => {
    const purchase = statement(scheme("C", [tx("2024-08-01", "PURCHASE", "1000", "25", "40")]));
    const existing = importRows(plan(purchase), () => false).map(stored);
    for (const first of [true, false]) {
      const combined = structuredClone(data);
      combined.folios[first ? "push" : "unshift"]({ ...purchase.folios[0], folio: "F2" });
      const planned = plan(combined, existing);
      assert.deepEqual(statuses(planned), first ? ["new", "existing"] : ["existing", "new"]);
      assert.equal(importRows(planned, () => false).length, 2);
      for (const s of combined.folios.flatMap((f) => f.schemes)) {
        if (s.transactions[0].type.endsWith("_MERGER")) s.transactions[0].nav = null;
      }
      assert.deepEqual(statuses(plan(combined, existing)), first ? ["new", "existing"] : ["existing", "new"]);
    }
  });

  test("earlier merger trades get their cash before an unrelated new merger", () => {
    const legacy = statement(scheme("C", [out()]), scheme("D", [into()]));
    const existing = plan(legacy)[0].transaction.earlier.map(stored);
    for (const first of [true, false]) {
      const combined = structuredClone(data);
      combined.folios[first ? "push" : "unshift"]({ ...legacy.folios[0], folio: "F2" });
      const planned = plan(combined, existing);
      assert.deepEqual(statuses(planned), first ? ["new", "existing"] : ["existing", "new"]);
      assert.equal(importRows(planned, () => false).length, 2);
    }
  });

  test("a new purchase doesn't take an earlier merger's cash", () => {
    const purchase = statement(scheme("C", [tx("2024-08-01", "PURCHASE", "1000", "25", "40")]));
    const existing = earlierImport();
    for (const first of [true, false]) {
      const combined = structuredClone(data);
      combined.folios[first ? "push" : "unshift"]({ ...purchase.folios[0], folio: "F2" });
      const planned = plan(combined, existing);
      assert.deepEqual(statuses(planned), first ? ["existing", "new"] : ["new", "existing"]);
      assert.deepEqual(importRows(planned, () => false).map((r) => r.activityType), ["BUY", "DEPOSIT"]);
    }
  });

  test("cash-only earlier merger evidence isn't taken by new transactions or another merger", () => {
    const earlier = earlierImport();
    for (const [type, units, cash] of [["PURCHASE", "25", "DEPOSIT"], ["REDEMPTION", "-25", "WITHDRAWAL"]]) {
      const ordinary = statement(scheme("C", [tx("2024-08-01", type, type === "PURCHASE" ? "1000" : "-1000", units, "40")]));
      const cashOnly = earlier.filter((a) => a.activityType === cash);
      const otherMerger = statement(scheme("C", [out()]), scheme("D", [into()]));
      for (const first of [true, false]) {
        for (const other of [ordinary, otherMerger]) {
          const combined = structuredClone(data);
          combined.folios[first ? "push" : "unshift"]({ ...other.folios[0], folio: "F2" });
          const planned = plan(combined, cashOnly);
          const mergers = planned.filter((t) => t.transaction.arriving);
          assert.ok(mergers.every((t) => t.status === "invalid"));
          assert.ok(mergers.every((t) => t.problem.startsWith("Wealthfolio has part of this merger")));
          assert.deepEqual(importRows(planned, () => false), []);
        }
      }
    }
  });

  test("missing amount or NAV still finds earlier trades and blocks another import", () => {
    const existing = earlierImport();
    for (const fields of [["nav"], ["amount"], ["nav", "amount"]]) {
      for (const sides of [[0], [1], [0, 1]]) {
        const incomplete = structuredClone(data);
        for (const side of sides) for (const field of fields) incomplete.folios[0].schemes[side].transactions[0][field] = null;
        const [t] = plan(incomplete, existing);
        assert.equal(t.status, fields.includes("nav") ? "invalid" : "existing");
        if (fields.includes("nav")) assert.match(t.problem, /^Wealthfolio has rows that may belong to an earlier import/);
        assert.deepEqual(importRows([t], () => true), []);
        assert.deepEqual(statuses(plan(incomplete)), ["new"], "new conversions need no amount or NAV");
      }
    }
    // Either or both leftover cash rows block an earlier import, even without either NAV or amount.
    for (const fields of [["nav"], ["amount"], ["nav", "amount"]]) {
      const incomplete = structuredClone(data);
      for (const s of incomplete.folios[0].schemes) for (const field of fields) s.transactions[0][field] = null;
      for (const kept of [["DEPOSIT"], ["WITHDRAWAL"], ["DEPOSIT", "WITHDRAWAL"]]) {
        const [t] = plan(incomplete, existing.filter((a) => kept.includes(a.activityType)));
        assert.equal(t.status, "invalid");
        assert.ok(t.problem);
        assert.deepEqual(importRows([t], () => true), []);
      }
    }
    const twins = structuredClone(data);
    for (const s of twins.folios[0].schemes) s.transactions[0].nav = null;
    twins.folios.push({ ...twins.folios[0], folio: "F2" });
    assert.deepEqual(statuses(plan(twins, existing.filter((a) => a.activityType === "DEPOSIT"))), ["invalid", "invalid"], "uncertain cash cannot be assigned to only one possible merger");
    // The remaining complete side's cash can be the only evidence of an earlier import.
    const incomplete = structuredClone(data);
    incomplete.folios[0].schemes[0].transactions[0].nav = null;
    const [cashOnly] = plan(incomplete, existing.filter((a) => a.activityType === "DEPOSIT"));
    assert.equal(cashOnly.status, "invalid");
    assert.match(cashOnly.problem, /^Wealthfolio has rows that may belong to an earlier import/);
    assert.deepEqual(cashOnly.earlier.filter((r) => r.existingId).map((r) => r.activity.activityType), ["DEPOSIT"]);
  });

  test("stored groups, canonical subtypes and checkImport flags keep conversions together", () => {
    const mapping = map(data);
    const rows = rowsOf(mapping);
    const storedRows = rows.map(stored).map((a) => ({
      ...a, subtype: ` ${a.subtype.toLowerCase().replace("_", " ")} `, sourceGroupId: ` ${a.sourceGroupId} `,
    }));
    assert.deepEqual(statuses(plan(data, storedRows)), ["existing"]);
    const moved = storedRows.map((a) => ({ ...a, accountId: "another-account" }));
    assert.deepEqual(statuses(plan(data, moved)), ["invalid"]);
    for (const flag of [{ duplicateOfId: "elsewhere" }, { duplicateOfLineNumber: 8 }]) {
      const checked = check(rows);
      Object.assign(checked[1], flag);
      const planned = planImport(mapping, [], checked, fundsOf(data));
      assert.deepEqual(statuses(planned), ["duplicate"]);
      assert.deepEqual(importRows(planned, () => true), []);
    }
    const otherRow = { ...storedRows[0], activityType: "BUY", subtype: null };
    assert.deepEqual(statuses(plan(data, [otherRow])), ["invalid"], "any stored row in the group blocks new conversion rows");
  });

  test("a conversion moves units from the old fund to the new one", () => {
    const bought = importRows(plan(statement(scheme("A", sip("2023-03-10", "1000.00", "100.000", "10.0000")))), () => false);
    const merged = statement(
      scheme("A", [out()], { open: "100.000", close: "0", close_calculated: "0" }),
      scheme("B", [into()], { close: "50.000", close_calculated: "50.000" }),
    );
    const activities = [...bought, ...importRows(plan(merged), () => false)].map(stored);
    const funds = fundsOf(merged);
    assert.ok(openingUnits(merged, target, activities, funds, "UTC").every(sameUnits));
    const closing = closingUnits(merged, target, activities, funds, "UTC");
    assert.deepEqual(closing.map((f) => format(f.held)), ["0", "50"]);
    assert.ok(closing.every(sameUnits));
    // Any spelling Wealthfolio accepts.
    for (const separator of ["_", "-", " "]) {
      const spelled = activities.map((a) => (a.subtype ? { ...a, subtype: ` ${a.subtype.toLowerCase().replace("_", separator)} ` } : a));
      assert.deepEqual(closingUnits(merged, target, spelled, funds, "UTC").map((f) => format(f.held)), ["0", "50"]);
    }
  });
});

describe("gifts", () => {
  const GIVER = "11111111";
  const RECEIVER = "33333333";
  const giftOut = tx("2024-06-03", "GIFT_OUT", "-500.00", "-10.000", "50.0000", {
    description: `Gifting of units-TO Folio No: ${RECEIVER}`, gift_folio: RECEIVER,
  });
  const giftIn = tx("2024-06-03", "GIFT_IN", "500.00", "10.000", "50.0000", {
    description: `Gifting of units - From Folio No.${GIVER}`, gift_folio: GIVER,
  });
  const folio = (number, ...schemes) => ({ folio: number, amc: "Made-up Mutual Fund", name: null, PAN: "ABCDE1234F", KYC: null, PANKYC: null, schemes });
  const pair = { ...statement(), folios: [folio(GIVER, scheme("A", [giftOut])), folio(RECEIVER, scheme("A", [giftIn]))] };
  const received = statement(scheme("A", [giftIn]));
  const given = statement(scheme("A", [giftOut]));
  /** Each folio in its own account. */
  const planGifts = (data, existing = [], errors = {}, timeZone = undefined) => {
    const funds = fundsOf(data);
    const mapping = mapStatement(data, {
      target: (f, s) => ({ ...target(f, s), accountId: `account-${f.folio}`, openingCovered: true }),
      alreadyImported: indexActivities(existing, funds).has,
    });
    return planImport(mapping, existing, check(rowsOf(mapping), errors), funds, timeZone);
  };

  test("a gift between two folios sends both sides together, and a second read finds both", () => {
    const planned = planGifts(pair);
    assert.deepEqual(statuses(planned), ["new"]);
    const sent = importRows(planned, () => false);
    assert.deepEqual(sent.map((r) => `${r.activityType} ${r.accountId} ${r.quantity}`), [
      `TRANSFER_OUT account-${GIVER} 10.000`,
      `TRANSFER_IN account-${RECEIVER} 10.000`,
    ]);
    // Wealthfolio's import links the two with a group.
    const linked = sent.map(stored).map((a) => ({ ...a, sourceGroupId: "linked-1" }));
    const again = planGifts(pair, linked);
    assert.deepEqual(statuses(again), ["existing"]);
    assert.deepEqual(importRows(again, () => true).map((r) => [r.activityType, r.forceImport]), [["TRANSFER_OUT", true], ["TRANSFER_IN", true]]);
    // Imported separately, or unlinked since, they need linking or importing again.
    for (const groups of [[null, null], ["linked-1", null], ["linked-1", "linked-2"]]) {
      const unlinked = planGifts(pair, sent.map(stored).map((a, i) => ({ ...a, sourceGroupId: groups[i] })));
      assert.deepEqual(statuses(unlinked), ["invalid"]);
      assert.match(unlinked[0].problem, /^Wealthfolio has both sides of this gift, but they aren't linked to each other/);
    }
  });

  test("Wealthfolio having only one side of a gift keeps both out", () => {
    const [out, into] = importRows(planGifts(pair), () => false);
    for (const side of [out, into]) {
      const planned = planGifts(pair, [stored(side)]);
      assert.deepEqual(statuses(planned), ["invalid"]);
      assert.match(planned[0].problem, /^Wealthfolio has one side of this gift from an earlier import but not the other/);
      assert.deepEqual(importRows(planned, () => true), []);
    }
  });

  test("a gift on its own is found again on a second read", () => {
    for (const [data, type] of [[received, "TRANSFER_IN"], [given, "TRANSFER_OUT"]]) {
      const sent = importRows(planGifts(data), () => false);
      assert.deepEqual(sent.map((r) => [r.activityType, r.isExternal]), [[type, true]]);
      const again = planGifts(data, sent.map(stored));
      assert.deepEqual(statuses(again), ["existing"]);
      assert.deepEqual(importRows(again, () => false), []);
    }
  });

  test("a prior transfer or trade of these units keeps an incoming or outgoing gift out", () => {
    for (const [data, direction, trade, name] of [[received, "in", "BUY", "purchase"], [given, "out", "SELL", "sale"]]) {
      const [row] = importRows(planGifts(data), () => false);
      for (const [change, found] of [
        [{ unitPrice: "40" }, `a transfer ${direction} at 40`],
        [{ comment: "Earlier gift" }, `a transfer ${direction} at 50 ("Earlier gift")`],
        [{ amount: "500.00" }, `a transfer ${direction} at 50`],
        [{ fee: "1.00" }, `a transfer ${direction} at 50`],
        [{ activityType: trade, amount: "500.0000" }, `a ${name} at 50`],
      ]) {
        const existing = [{ ...stored(row), ...change }];
        const planned = planGifts(data, existing);
        assert.deepEqual(statuses(planned), ["invalid"], JSON.stringify(change));
        assert.equal(
          planned[0].problem,
          `Wealthfolio has ${found} of these units on this day, perhaps entered by hand, so this gift isn't imported. If that's this gift, keep it, or delete it and any cash that came with it and read the statement again to import the statement's.`,
        );
        const again = planGifts(data, existing);
        assert.deepEqual(statuses(again), ["invalid"]);
        assert.deepEqual(importRows(again, () => true), []);
      }
    }
    // Another day, account, fund, direction or number of units isn't this gift.
    const [row] = importRows(planGifts(received), () => false);
    for (const change of [
      { date: "2024-06-04T00:00:00+00:00" },
      { accountId: "elsewhere" },
      otherFund(stored(row)),
      { activityType: "TRANSFER_OUT" },
      { activityType: "SELL" },
      { quantity: "11.000" },
    ]) {
      assert.deepEqual(statuses(planGifts(received, [{ ...stored(row), unitPrice: "40", ...change }])), ["new"], JSON.stringify(change));
    }
  });

  test("a gift entered by hand is found on its day in Wealthfolio's timezone", () => {
    for (const [data, trade] of [[received, "BUY"], [given, "SELL"]]) {
      const [row] = importRows(planGifts(data), () => false);
      for (const activityType of [row.activityType, trade]) {
        // Entered at 02:00 on 03-Jun in India, and at 21:00 on 03-Jun in Toronto.
        const india = { ...stored(row), activityType, unitPrice: "40", date: "2024-06-02T20:30:00+00:00" };
        const toronto = { ...stored(row), activityType, unitPrice: "40", date: "2024-06-04T01:00:00+00:00" };
        inLocalTimeZones(() => {
          assert.deepEqual(statuses(planGifts(data, [india], {}, "Asia/Kolkata")), ["invalid"]);
          assert.deepEqual(statuses(planGifts(data, [toronto], {}, "America/Toronto")), ["invalid"]);
          // Another local day isn't this gift, even when its UTC day is the statement's.
          assert.deepEqual(statuses(planGifts(data, [india], {}, "America/Toronto")), ["new"]);
          assert.deepEqual(statuses(planGifts(data, [toronto], {}, "Asia/Kolkata")), ["new"]);
          assert.deepEqual(statuses(planGifts(data, [{ ...india, date: "2024-06-03T20:30:00+00:00" }], {}, "Asia/Kolkata")), ["new"]);
          assert.deepEqual(statuses(planGifts(data, [{ ...toronto, date: "2024-06-03T01:00:00+00:00" }], {}, "America/Toronto")), ["new"]);
        });
      }
      // Wealthfolio stores a bare imported date on that day in UTC and in its timezone.
      const imported = { ...stored(row), sourceSystem: "CSV", date: "2024-06-03T04:00:00+00:00" };
      assert.deepEqual(statuses(planGifts(data, [imported], {}, "America/Toronto")), ["existing"]);
      assert.deepEqual(statuses(planGifts(data, [{ ...imported, unitPrice: "40" }], {}, "America/Toronto")), ["invalid"]);
    }
  });

  test("an exact UTC reservation on another day cannot hide a hand-entered gift", () => {
    for (const base of [received, given]) {
      const [row] = importRows(planGifts(base), () => false);
      for (const [timeZone, date, otherDay] of [
        ["America/Toronto", "2024-06-04T01:00:00+00:00", "2024-06-04"],
        ["Asia/Kolkata", "2024-06-02T20:30:00+00:00", "2024-06-02"],
      ]) {
        const data = structuredClone(base);
        const transactions = data.folios[0].schemes[0].transactions;
        transactions.push({ ...transactions[0], date: otherDay });
        const existing = [{ ...stored(row), date }];
        const planned = planGifts(data, existing, {}, timeZone);
        assert.deepEqual(statuses(planned), ["invalid", "new"]);
        assert.deepEqual(importRows(planned, () => true).map((r) => r.date), [otherDay]);
        // An imported row belongs to its UTC day, even if the setting changed since its import.
        assert.deepEqual(statuses(planGifts(data, [{ ...existing[0], sourceSystem: "CSV" }], {}, timeZone)), ["new", "existing"]);
        // A current trade can reserve the UTC key too; it must not hide the gift's local day.
        const into = row.activityType === "TRANSFER_IN";
        transactions[1] = tx(otherDay, into ? "PURCHASE" : "REDEMPTION", into ? "500.00" : "-500.00", into ? "10.000" : "-10.000", "50.0000");
        const trade = { ...existing[0], activityType: into ? "BUY" : "SELL", amount: "500.00" };
        const withTrade = planGifts(data, [trade], {}, timeZone);
        assert.equal(withTrade[0].status, "invalid");
        assert.equal(withTrade[1].rows[0].existingId, trade.id);
        assert.match(withTrade[0].problem, /^Wealthfolio has a (purchase|sale) at 50/);
      }
    }
  });

  test("imported gifts keep their UTC day after a timezone change, including changed and forced copies", () => {
    for (const data of [received, given, pair]) {
      const mapping = { transactions: planGifts(data).map((t) => t.transaction), warnings: [] };
      const rows = rowsOf(mapping);
      const existing = rows.map(stored).map((a) => ({ ...a, sourceSystem: "CSV", sourceGroupId: rows.length === 2 ? "linked-1" : null }));
      const funds = fundsOf(data);
      for (const flagged of [false, true]) {
        const checked = check(rows).map((r, i) => ({ ...r, duplicateOfId: flagged ? existing[i].id : undefined }));
        const planned = planImport(mapping, existing, checked, funds, "America/Toronto");
        assert.deepEqual(statuses(planned), ["existing"]);
        assert.deepEqual(planned[0].rows.map((r) => r.existingId), existing.map((a) => a.id));
        assert.deepEqual(importRows(planned, () => false), []);
      }
      for (let side = 0; side < rows.length; side++) {
        const changed = existing.map((a, i) => i === side ? { ...a, unitPrice: "40", isUserModified: true } : a);
        const planned = planImport(mapping, changed, check(rows), funds, "America/Toronto");
        assert.deepEqual(statuses(planned), ["invalid"]);
        assert.deepEqual(importRows(planned, () => true), []);
      }
      // The same instant from the form is on June 2 in Toronto, not this June 3 gift.
      const manual = existing.map((a) => ({ ...a, sourceSystem: "MANUAL" }));
      assert.deepEqual(statuses(planImport(mapping, manual, check(rows), funds, "America/Toronto")), ["new"]);
    }
  });

  test("a CSV gift edited in the form is found by its local day even when its UTC key is reserved", () => {
    for (const base of [received, given]) {
      const [row] = importRows(planGifts(base), () => false);
      for (const [timeZone, date, otherDay] of [
        ["Asia/Kolkata", "2024-06-02T20:30:00+00:00", "2024-06-02"],
        ["America/Toronto", "2024-06-04T01:00:00+00:00", "2024-06-04"],
      ]) {
        const edited = { ...stored(row), sourceSystem: "CSV", isUserModified: true, date };
        assert.deepEqual(statuses(planGifts(base, [edited], {}, timeZone)), ["invalid"]);
        const data = structuredClone(base);
        const transactions = data.folios[0].schemes[0].transactions;
        transactions.push({ ...transactions[0], date: otherDay });
        // The edited row may belong to either day; neither gift may be forced.
        const planned = planGifts(data, [edited], {}, timeZone);
        assert.deepEqual(statuses(planned), ["invalid", "invalid"]);
        assert.deepEqual(importRows(planned, () => true), []);
        const into = row.activityType === "TRANSFER_IN";
        transactions[1] = tx(otherDay, into ? "PURCHASE" : "REDEMPTION", into ? "500.00" : "-500.00", into ? "10.000" : "-10.000", "50.0000");
        const trade = { ...edited, activityType: into ? "BUY" : "SELL", amount: "500.00" };
        const withTrade = planGifts(data, [trade], {}, timeZone);
        assert.equal(withTrade[0].status, "invalid");
        assert.equal(withTrade[1].rows[0].existingId, trade.id);
        assert.match(withTrade[0].problem, /^Wealthfolio has a (purchase|sale) at 50/);
      }
    }
  });

  test("a confirmed same-day trade is not mistaken for a gift after a timezone change", () => {
    for (const [base, type, amount, units] of [[received, "PURCHASE", "400.00", "10.000"], [given, "REDEMPTION", "-400.00", "-10.000"]]) {
      const data = structuredClone(base);
      data.folios[0].schemes[0].transactions.push(tx("2024-06-03", type, amount, units, "40.0000"));
      const [gift, trade] = planGifts(data);
      const storedTrade = importRows([trade], () => false).map(stored).map((a) => ({ ...a, sourceSystem: "CSV" }));
      for (const isUserModified of [false, true]) {
        const existing = storedTrade.map((a) => ({ ...a, isUserModified }));
        const planned = planGifts(data, existing, {}, "America/Toronto");
        assert.deepEqual(statuses(planned), ["new", "existing"]);
        assert.deepEqual(planned[1].rows.map((r) => r.existingId), existing.map((a) => a.id));
        assert.deepEqual(importRows(planned, () => false), [gift.transaction.activity]);
      }
    }
  });

  test("rejecting either row of a gift pair keeps both out, even when forced", () => {
    for (const line of [1, 2]) {
      const planned = planGifts(pair, [], { [line]: "This row is invalid." });
      assert.deepEqual(statuses(planned), ["invalid"]);
      assert.deepEqual(planned[0].rows[line - 1].errors, ["This row is invalid."]);
      assert.deepEqual(importRows(planned, () => true), []);
    }
  });

  test("a gift imported with its ID is found by it after an edit, not taken for one entered by hand", () => {
    for (const data of [received, given]) {
      const [row] = importRows(planGifts(data), () => false);
      // Moved to 02:00 on 03-Jun in India, the 2nd in UTC.
      const edited = { ...storedWithId(row), unitPrice: "40", isUserModified: true, date: "2024-06-02T20:30:00+00:00" };
      const planned = planGifts(data, [edited], {}, "Asia/Kolkata");
      assert.deepEqual(statuses(planned), ["existing"]);
      assert.equal(planned[0].problem, undefined);
    }
  });

  test("an exact earlier gift does not hide another changed entry of the same units", () => {
    for (const data of [received, given, pair]) {
      const rows = importRows(planGifts(data), () => false);
      const exact = rows.map(stored).map((a) => ({ ...a, sourceGroupId: rows.length === 2 ? "linked-1" : null }));
      for (const side of rows) {
        const planned = planGifts(data, [...exact, { ...stored(side), unitPrice: "40" }]);
        assert.deepEqual(statuses(planned), ["invalid"]);
        assert.match(planned[0].problem, /^Wealthfolio has a transfer (in|out) at 40/);
        assert.deepEqual(importRows(planned, () => true), []);
      }
    }
  });

  test("an incomplete legacy merger cannot hide a prior gift trade, but confirmed trades can", () => {
    const combined = structuredClone(pair);
    combined.folios[1].schemes.unshift(scheme("B", [tx(giftOut.date, "SWITCH_OUT_MERGER", "-500.00", "-10.000", "50.0000")]));
    combined.folios[1].schemes[1].transactions.unshift(tx(giftIn.date, "SWITCH_IN_MERGER", "500.00", "10.000", "50.0000"));
    const earlier = planGifts(combined).find((t) => t.transaction.arriving).transaction.earlier.map(stored);
    const purchase = earlier.filter((a) => a.activityType === "BUY");
    for (const nav of ["50.0000", null]) {
      const data = structuredClone(combined);
      data.folios[1].schemes[1].transactions[0].nav = nav;
      const planned = planGifts(data, purchase);
      assert.deepEqual(statuses(planned), ["invalid", "invalid"], `merger NAV ${nav}`);
      assert.match(planned[0].problem, /^Wealthfolio has a purchase at 50/);
      assert.ok(planned[1].problem);
      assert.deepEqual(importRows(planned, () => true), []);
    }
    const complete = planGifts(combined, earlier);
    assert.deepEqual(statuses(complete), ["new", "existing"]);
    assert.deepEqual(importRows(complete, () => false).map((r) => r.activityType), ["TRANSFER_OUT", "TRANSFER_IN"]);
    combined.folios[1].schemes[1].transactions.push(tx(giftIn.date, "PURCHASE", "500.00", "10.000", "50.0000"));
    const current = planGifts(combined, earlier.filter((a) => ["BUY", "DEPOSIT"].includes(a.activityType)));
    assert.deepEqual(statuses(current), ["new", "new", "existing"]);
    assert.equal(current[0].problem, undefined);
  });

  test("a same-account pair stays skipped and checks actual prior gift entries before skipping", () => {
    const legs = importRows(planGifts(pair), () => false).map((r) => ({ ...r, accountId: ACCOUNT }));
    for (const sides of [[], [0], [1], [0, 1]]) {
      for (const [timeZone, change] of [
        ["Asia/Kolkata", {}], ["Asia/Kolkata", { unitPrice: "40" }], ["Asia/Kolkata", { comment: "Earlier gift" }],
        ["Asia/Kolkata", { date: "2024-06-02T20:30:00+00:00" }], ["America/Toronto", { sourceSystem: "CSV" }],
        ["Asia/Kolkata", { sourceSystem: "CSV", isUserModified: true, date: "2024-06-02T20:30:00+00:00" }],
      ]) {
        const existing = sides.map((i) => ({ ...stored(legs[i]), ...change }));
        const funds = fundsOf(pair);
        const entered = giftEntries(existing, funds, timeZone);
        const input = {
          target: (f, s) => ({ ...target(f, s), openingCovered: true }),
          alreadyImported: indexActivities(existing, funds).has,
          entered: (r) => entered(r).length > 0,
        };
        const mapping = mapStatement(pair, input);
        assert.deepEqual(mapping.transactions, []);
        assert.equal(mapping.warnings.length, 2);
        for (const warning of mapping.warnings) {
          assert.equal(warning.leftOut, true);
          assert.match(warning.message, /^Both sides of this gift go to the same Wealthfolio account/);
          assert.equal(warning.message.includes("Wealthfolio has a transfer or trade"), sides.length > 0);
        }
        assert.deepEqual(mapStatement(pair, input), mapping, "a second read keeps the pair skipped");
      }
    }
  });
});

describe("segregated portfolios", () => {
  const credit = (units) => tx("2024-02-16", "SEGREGATION", null, units, null, { description: "Creation of units - Segregated Portfolio" });
  const credited = (...units) => statement(
    scheme("M", [tx("2023-05-08", "PURCHASE", "1000.00", "100.000", "10.0000")]),
    scheme("S", units.map(credit), { scheme: "Made-up Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth" }),
  );
  const segregation = (rows) => rows.filter((r) => r.symbol === "s");
  const handEntered = (found) =>
    `Wealthfolio has ${found} of this fund on this day, perhaps entered by hand, so this credit of segregated units isn't imported. If that's this credit, or the day's credits entered as one, keep it, or delete it and any cash that came with it and read the statement again to import the statement's.`;

  test("each credit goes in alone, and a second read finds them, all or some", () => {
    const data = credited("99.987", "0.013");
    const planned = plan(data);
    assert.deepEqual(statuses(planned), ["new", "new", "new"]);
    const sent = importRows(planned, () => false);
    assert.deepEqual(segregation(sent).map((r) => [r.activityType, r.quantity, r.unitPrice, r.amount]), [["BUY", "99.987", undefined, "0"], ["BUY", "0.013", undefined, "0"]]);
    assert.deepEqual(statuses(plan(data, sent.map(stored))), ["existing", "existing", "existing"]);
    // An overlapping statement with one credit in Wealthfolio sends the other.
    const main = sent.filter((r) => r.symbol !== "s").map(stored);
    const [first, second] = segregation(sent);
    const partly = plan(data, [...main, stored(first)]);
    assert.deepEqual(statuses(partly), ["existing", "existing", "new"]);
    assert.deepEqual(segregation(importRows(partly, () => false)).map((r) => r.quantity), [second.quantity]);
  });

  test("equal credits of a day each go in once, with their own IDs", () => {
    const data = credited("50.000", "50.000");
    const planned = plan(data);
    assert.deepEqual(statuses(planned), ["new", "new", "new"]);
    const sent = importRows(planned, () => false);
    assert.deepEqual(segregation(sent).map((r) => [r.quantity, r.forceImport ?? false]), [["50.000", false], ["50.000", false]]);
    assert.deepEqual(statuses(plan(data, sent.map(storedWithId))), ["existing", "existing", "existing"]);
    // With one imported before the IDs, the other is new to the add-on.
    const main = sent.filter((r) => r.symbol !== "s").map(storedWithId);
    const one = plan(data, [...main, stored(segregation(sent)[0])]);
    assert.deepEqual(statuses(one), ["existing", "existing", "new"]);
  });

  test("before Wealthfolio 3.13.0, equal credits of a day are possible duplicates of each other, and import anyway sends each once", () => {
    const data = credited("50.000", "50.000");
    const planned = planWithoutIds(data);
    assert.deepEqual(statuses(planned), ["new", "new", "duplicate"]);
    const sent = importRows(planned, (t) => t === planned[2]);
    assert.deepEqual(segregation(sent).map((r) => [r.quantity, r.forceImport ?? false]), [["50.000", false], ["50.000", true]]);
    // Wealthfolio stores both; a second read finds one for each.
    assert.deepEqual(statuses(planWithoutIds(data, sent.map(stored))), ["existing", "existing", "existing"]);
    // With only one in Wealthfolio, the other is still a possible duplicate, of this statement's first.
    const main = sent.filter((r) => r.symbol !== "s").map(stored);
    const one = planWithoutIds(data, [...main, stored(segregation(sent)[0])]);
    assert.deepEqual(statuses(one), ["existing", "existing", "duplicate"]);
  });

  test("credits use gifts' date handling for manual entries, imports and edited imports", () => {
    for (const [timeZone, date, otherDay] of [
      ["Asia/Kolkata", "2024-02-16T20:30:00+00:00", "2024-02-17"],
      ["America/Toronto", "2024-02-16T01:00:00+00:00", "2024-02-15"],
    ]) {
      const data = credited("100.000");
      const transactions = data.folios[0].schemes[1].transactions;
      transactions.push({ ...transactions[0], date: otherDay });
      const [row] = segregation(importRows(plan(data), () => false));
      for (const [source, expected] of [
        [{ sourceSystem: "MANUAL" }, ["new", "new", "invalid"]],
        [{ sourceSystem: "CSV" }, ["new", "existing", "new"]],
        [{ sourceSystem: "CSV", isUserModified: true }, ["new", "invalid", "invalid"]],
      ]) {
        const existing = [{ ...stored(row), date, ...source }];
        const mapping = map(data, existing);
        inLocalTimeZones(() => {
          const planned = planImport(mapping, existing, check(rowsOf(mapping)), fundsOf(data), timeZone);
          assert.deepEqual(statuses(planned), expected, JSON.stringify({ timeZone, source }));
          assert.deepEqual(segregation(importRows(planned, (t) => t.status !== "existing")).map((r) => r.date),
            source.sourceSystem === "MANUAL" ? ["2024-02-16"] : source.isUserModified ? [] : [otherDay]);
        });
      }
    }
  });

  test("a purchase or transfer in of this fund entered by hand that day keeps the day's new credits out", () => {
    const data = credited("99.987", "0.013");
    const [row] = segregation(importRows(plan(data), () => false));
    for (const [change, found] of [
      // Entered one by one, at another price or with a comment.
      [{ unitPrice: "10", amount: "999.8700" }, "a purchase of 99.987 units at 10"],
      [{ comment: "Segregated" }, 'a purchase of 99.987 units ("Segregated")'],
      [{ activityType: "TRANSFER_IN", unitPrice: "10", amount: null }, "a transfer in of 99.987 units at 10"],
      // Both credits entered as one.
      [{ quantity: "100.000" }, "a purchase of 100 units"],
    ]) {
      const planned = plan(data, [{ ...stored(row), ...change }]);
      assert.deepEqual(statuses(planned), ["new", "invalid", "invalid"], JSON.stringify(change));
      assert.deepEqual(planned.slice(1).map((t) => t.problem), [handEntered(found), handEntered(found)]);
      assert.deepEqual(segregation(importRows(planned, () => true)), []);
    }
    // One credit imported before, and the rest entered by hand: the imported one stays found.
    const credits = credited("99.000", "0.987", "0.013");
    const sent = segregation(importRows(plan(credits), () => false));
    const partly = plan(credits, [stored(sent[0]), { ...stored(sent[1]), quantity: "1.000" }]);
    assert.deepEqual(statuses(partly), ["new", "existing", "invalid", "invalid"]);
    assert.equal(partly[2].problem, handEntered("a purchase of 1 units"));
    // Another day, account, fund or direction isn't a credit of this day.
    for (const change of [
      { date: "2024-02-17T00:00:00+00:00" },
      { accountId: "elsewhere" },
      otherFund(stored(row)),
      { activityType: "SELL" },
    ]) {
      assert.deepEqual(statuses(plan(data, [{ ...stored(row), unitPrice: "10", ...change }])), ["new", "new", "new"], JSON.stringify(change));
    }
  });
});

describe("bank account", () => {
  const BANK = "bank-1";
  const banked = (data, existing = [], errors = {}) => plan(data, existing, errors, BANK);
  const redemption = (date, amount = "-3000.00") => tx(date, "REDEMPTION", amount, "-61.000", "49.1803");
  const data = statement(
    scheme("A", [...sip("2023-04-10"), redemption("2023-06-01")]),
    scheme("B", [tx("2023-12-28", "DIVIDEND_PAYOUT", "7276.48")]),
  );
  const rowText = (r) => `${r.activityType} ${r.accountId}`;

  /** Wealthfolio 3.11.0's link_imported_transfer_pairs: each transfer in takes the first unused transfer out in another account with the same day, currency, symbol and amount. */
  function linkedPairs(rows) {
    const key = (r) => [r.date, r.currency, r.symbol, r.amount].join("|");
    const used = new Set();
    return rows.flatMap((r, i) => {
      if (r.activityType !== "TRANSFER_IN") return [];
      const j = rows.findIndex((o, k) => o.activityType === "TRANSFER_OUT" && !used.has(k) && key(o) === key(r) && o.accountId !== r.accountId);
      if (j < 0) return [];
      used.add(j);
      return [[Math.min(i, j), Math.max(i, j)]];
    });
  }

  test("purchases, redemptions and payouts move cash between the bank and the fund account", () => {
    const rows = importRows(banked(data), () => false);
    assert.deepEqual(rows.map(rowText), [
      "BUY account-1", "TRANSFER_IN account-1", "TRANSFER_OUT bank-1",
      "SELL account-1", "TRANSFER_OUT account-1", "TRANSFER_IN bank-1",
      "DIVIDEND account-1", "TRANSFER_OUT account-1", "TRANSFER_IN bank-1",
    ]);
    assert.deepEqual(linkedPairs(rows), [[1, 2], [4, 5], [7, 8]]);
  });

  test("each transaction's legs link to each other, even when another moves the same amount the same day", () => {
    // A purchase in one folio and a redemption of the same amount in another, on one day.
    const twin = statement(
      scheme("A", sip("2023-04-10", "5000.00", "100.000", "50.0000")),
      scheme("B", [tx("2023-04-10", "REDEMPTION", "-5000.25", "-100.005", "50.0000")]),
    );
    const mapping = mapStatement(twin, {
      target: (folio, s) => ({ ...target(folio, s), accountId: `account-${s.scheme}`, openingCovered: true, bankAccountId: BANK }),
      alreadyImported: () => false,
    });
    const rows = rowsOf(mapping);
    assert.equal(new Set(rows.filter((r) => r.activityType.startsWith("TRANSFER")).map((r) => r.amount)).size, 1);
    assert.deepEqual(linkedPairs(rows), [[1, 2], [4, 5]]);
  });

  test("a v1 import's deposits and withdrawals are the transactions' cash", () => {
    const v1 = importRows(plan(data), () => false).map(stored);
    const planned = banked(data, v1);
    assert.deepEqual(statuses(planned), ["existing", "existing", "existing"]);
    assert.deepEqual(planned.map((t) => t.rows[1].existingType), ["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL"]);
    assert.ok(planned.every((t) => t.rows[2].existingId === undefined), "the bank's side isn't looked for");
    assert.deepEqual(importRows(planned, () => false), []);
    // And the other way round, once the bank account is no longer chosen.
    const transfers = importRows(banked(data), () => false).map(stored);
    assert.deepEqual(statuses(plan(data, transfers)), ["existing", "existing", "existing"]);
  });

  test("a second import finds the transfers, and the bank's side doesn't matter once the fund's is in", () => {
    const rows = importRows(banked(data), () => false).map(stored);
    assert.deepEqual(statuses(banked(data, rows)), ["existing", "existing", "existing"]);
    // A reused bank row keeps its own day and amount.
    const fundSide = rows.filter((r) => r.accountId !== BANK);
    const bankSide = rows.filter((r) => r.accountId === BANK).map((r) => ({ ...r, amount: "1", date: "2023-01-01T00:00:00+00:00" }));
    assert.deepEqual(statuses(banked(data, [...fundSide, ...bankSide])), ["existing", "existing", "existing"]);
  });

  test("a bank transfer Wealthfolio already has makes a new transaction a possible duplicate", () => {
    const [, , bankLeg] = importRows(banked(statement(scheme("A", sip("2023-04-10")))), () => false);
    const planned = banked(statement(scheme("B", sip("2023-04-10"))), [stored(bankLeg)]);
    assert.equal(planned[0].status, "duplicate");
    assert.ok(planned[0].rows[2].existingId);
  });

  test("reusing a bank row sends only the trade", () => {
    const planned = banked(data);
    assert.deepEqual(importRows(planned, () => false, (t) => t === planned[1]).map(rowText), [
      "BUY account-1", "TRANSFER_IN account-1", "TRANSFER_OUT bank-1",
      "SELL account-1",
      "DIVIDEND account-1", "TRANSFER_OUT account-1", "TRANSFER_IN bank-1",
    ]);
  });

  const bankRow = (activityType, amount, date, extra = {}) => ({
    id: `bank-${++id}`, accountId: BANK, activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`,
    quantity: null, unitPrice: null, amount, fee: null, currency: "INR", needsReview: false, comment: "ACH D- FUND HOUSE",
    assetId: "", assetSymbol: "", ...extra,
  });

  test("bank rows that may be a transaction's bank side", () => {
    // The statement prints ₹4,999.75 after ₹0.25 stamp duty; the bank paid ₹5,000.
    const purchase = statement(scheme("A", sip("2023-04-10")));
    const [t] = banked(purchase);
    const ids = (rows) => bankCandidates(t, rows).map((r) => r.amount);
    assert.equal(t.transaction.cash.amount, "5000.018");
    assert.deepEqual(ids([bankRow("WITHDRAWAL", "5000.00", "2023-04-08"), bankRow("TRANSFER_OUT", "5000.02", "2023-04-17"), bankRow("WITHDRAWAL", "4999.75", "2023-04-03")]), ["5000.00", "5000.02", "4999.75"]);
    assert.deepEqual(ids([
      bankRow("DEPOSIT", "5000.00", "2023-04-10"),
      bankRow("WITHDRAWAL", "5000.01", "2023-04-10"),
      bankRow("WITHDRAWAL", "5000.00", "2023-04-18"),
      bankRow("WITHDRAWAL", "5000.00", "2023-04-10", { accountId: "account-1" }),
      bankRow("WITHDRAWAL", "5000.00", "2023-04-10", { status: "DRAFT" }),
      bankRow("WITHDRAWAL", "5000.00", "2023-04-10", { currency: "USD" }),
      bankRow("WITHDRAWAL", "5000.00", "2023-04-10", { assetSymbol: "FUND" }),
    ]), [], "other directions, amounts, days, accounts, statuses, currencies and assets");
    // A redemption printed before STT is paid in without it.
    const [sale] = banked(statement(scheme("A", [redemption("2023-06-01"), tx("2023-06-01", "STT_TAX", "0.03")])));
    assert.deepEqual(bankCandidates(sale, [bankRow("DEPOSIT", "2999.97", "2023-06-03"), bankRow("WITHDRAWAL", "2999.97", "2023-06-03")]).map((r) => r.activityType), ["DEPOSIT"]);
    // Existing transactions and those without a bank account have nothing to match.
    const existing = importRows(banked(purchase), () => false).map(stored);
    assert.deepEqual(bankCandidates(banked(purchase, existing)[0], [bankRow("WITHDRAWAL", "5000.00", "2023-04-10")]), []);
    assert.deepEqual(bankCandidates(plan(purchase)[0], [bankRow("WITHDRAWAL", "5000.00", "2023-04-10")]), []);
  });

  test("each bank row is offered for one transaction, closest days first, and linked transfers never", () => {
    const planned = banked(statement(scheme("A", [...sip("2023-04-05", "5000.00", "100.000", "49.9975"), ...sip("2023-04-06", "5000.00", "100.000", "49.9975")])));
    const early = bankRow("WITHDRAWAL", "5000.00", "2023-04-04");
    const same = bankRow("WITHDRAWAL", "5000.00", "2023-04-06");
    const linked = bankRow("TRANSFER_OUT", "5000.00", "2023-04-05");
    const matches = bankMatches(planned, [early, same, linked], new Set([linked.id]));
    assert.equal(matches.get(planned[1]), same);
    assert.equal(matches.get(planned[0]), early);
    assert.equal(bankMatches(planned, [same], new Set()).size, 1);
  });

  test("using a bank row adds the fund's transfer, changes a withdrawal into a transfer and links them", async () => {
    const data = statement(scheme("A", sip("2023-04-10")));
    const [t] = banked(data);
    const calls = [];
    const api = {
      create: async (a) => (calls.push(["create", a]), { id: "fund-leg" }),
      update: async (a) => void calls.push(["update", a]),
      linkTransfer: async (a, b) => void calls.push(["link", a, b]),
    };
    const withdrawal = bankRow("WITHDRAWAL", "5000.00", "2023-04-08");
    assert.equal(await linkBankRow(api, t, withdrawal), undefined);
    const sourceRecordId = `${RECORD_PREFIX}${t.transaction.cash.sourceRecordId}`;
    assert.deepEqual(calls, [
      ["create", {
        accountId: "account-1", activityType: "TRANSFER_IN", activityDate: "2023-04-10", amount: "5000.018", currency: "INR",
        sourceRecordId,
        metadata: { addons: { "cas-importer": t.transaction.cash.metadata } },
        idempotencyKey: `cas-importer-bank:${withdrawal.id}`,
      }],
      ["update", { id: withdrawal.id, accountId: BANK, activityType: "TRANSFER_OUT", activityDate: withdrawal.date, currency: "INR", comment: "ACH D- FUND HOUSE" }],
      ["link", withdrawal.id, "fund-leg"],
    ]);
    const created = calls[0][1];
    const existing = [storedWithId(t.transaction.activity), {
      ...stored(t.transaction.cash), sourceRecordId: created.sourceRecordId, metadata: created.metadata,
      amount: "1", comment: "Edited", date: "2023-04-11T00:00:00+00:00",
    }];
    const again = banked(data, existing);
    assert.deepEqual(statuses(again), ["existing"]);
    assert.deepEqual(importRows(again, () => false), []);
    // A transfer keeps its type.
    calls.length = 0;
    assert.equal(await linkBankRow(api, t, bankRow("TRANSFER_OUT", "5000.00", "2023-04-08")), undefined);
    assert.deepEqual(calls.map(([step]) => step), ["create", "link"]);
    // Each step's failure says what's left to do.
    const failing = (step) => ({ ...api, [step]: async () => { throw new Error("nope"); } });
    assert.match(await linkBankRow(failing("create"), t, withdrawal), /^Couldn't add the fund account's transfer: Error: nope\. The trade is in Wealthfolio without its cash\.$/);
    assert.match(await linkBankRow(failing("update"), t, withdrawal), /couldn't change the bank's row on 2023-04-08 into a transfer: Error: nope\. Change it and link the two in Wealthfolio\.$/);
    assert.match(await linkBankRow(failing("linkTransfer"), t, withdrawal), /couldn't link it with the bank's row on 2023-04-08: Error: nope\. Link the two in Wealthfolio\.$/);
  });

  test("equal confirmed bank rows get distinct cash, including Import anyway, but retries cannot create it twice", async () => {
    const [t] = banked(statement(scheme("A", sip("2023-04-10"))));
    const keys = new Set();
    const api = {
      create: async (a) => {
        // Wealthfolio computes a content key when none is supplied, then rejects an existing key.
        const key = a.idempotencyKey ?? JSON.stringify(a);
        if (keys.has(key)) throw new Error("Duplicate activity");
        keys.add(key);
        return { id: key };
      },
      update: async () => {},
      linkTransfer: async () => {},
    };
    const first = bankRow("WITHDRAWAL", "5000.00", "2023-04-10");
    const second = bankRow("WITHDRAWAL", "5000.00", "2023-04-10");
    assert.equal(await linkBankRow(api, t, first), undefined);
    const duplicate = { ...t, status: "duplicate" };
    assert.deepEqual(importRows([duplicate], () => true, () => true), [{ ...t.transaction.activity, forceImport: true }]);
    assert.equal(await linkBankRow(api, duplicate, second), undefined);
    assert.equal(keys.size, 2);
    assert.match(await linkBankRow(api, t, first), /Duplicate activity/);
    assert.equal(keys.size, 2);
  });
});

describe("display codes", () => {
  // Activities show each asset's display code, which the user can change.
  const renamed = (activities, code = "My Flexi Cap") => activities.map((a) => (a.assetId ? { ...a, assetSymbol: code } : a));
  const balanced = (open, close, transactions) => scheme("A", transactions, { open, close, close_calculated: close });
  /** `target`'s funds chosen from existing assets: by ID, with no profiles read. */
  const byId = (data) =>
    fundRefs(data.folios.flatMap((f) => f.schemes.map((s) => ({ ...target(f, s).asset, assetId: `uuid-${target(f, s).asset.symbol}` }))), new Map());

  for (const [how, fundsFor] of [["without an asset ID", fundsOf], ["with an asset ID", byId]]) {
    test(`a fund chosen ${how} is found under another display code`, () => {
      const drip = tx("2023-09-25", "DIVIDEND_REINVEST", "731.39", "15.054", "48.5844");
      const data = statement(balanced("0", "118.142", [...sip("2023-04-10"), drip]));
      const existing = renamed(importRows(plan(data), () => false).map(stored));
      const planned = plan(data, existing, {}, undefined, fundsFor(data));
      assert.deepEqual(statuses(planned), ["existing", "existing"], "the reinvested dividend has no cash row to match");
      assert.deepEqual(importRows(planned, () => false), []);
      assert.ok(sameUnits(closingUnits(data, target, existing, fundsFor(data), "UTC")[0]));
    });

    test(`a fund chosen ${how} covers its opening units under another display code`, () => {
      const earlier = renamed(importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored));
      const data = statement(balanced("103.088", "206.176", sip("2023-04-10")));
      const [fund] = openingUnits(data, target, earlier, fundsFor(data), "UTC");
      assert.equal(format(fund.held), "103.088");
      assert.ok(sameUnits(fund));
    });

    test(`a reversed purchase of a fund chosen ${how} is found under another display code`, () => {
      const purchase = sip("2024-01-10", "999.95", "99.995", "10.0000");
      const [trade] = renamed(importRows(plan(statement(scheme("A", purchase))), () => false).map(stored));
      const data = statement(scheme("A", [...purchase, tx("2024-01-15", "REVERSAL", "-999.95", "-99.995", "10.0000")]));
      const mapping = map(data, [trade], undefined, fundsFor(data));
      assert.match(mapping.warnings[0].message, /^Wealthfolio has this purchase from an earlier import/);
    });
  }

  test("two assets sharing a display code keep their own units", () => {
    const data = statement(
      balanced("0", "103.088", sip("2023-04-10")),
      { ...balanced("0", "10", sip("2023-04-10", "999.95", "10.000", "99.9950")), scheme: "B", rta_code: "B", isin: "INF-B" },
    );
    // B's display code is A's symbol.
    const existing = importRows(plan(data), () => false).map(stored).map((a) => (a.assetId === "uuid-b" ? { ...a, assetSymbol: "A" } : a));
    for (const funds of [fundsOf(data), byId(data)]) {
      assert.deepEqual(closingUnits(data, target, existing, funds, "UTC").map((f) => format(f.held)), ["103.088", "10"]);
    }
  });

  test("a fund chosen with an asset ID goes by that ID alone", () => {
    const data = statement(balanced("0", "103.088", sip("2023-04-10")));
    const [trade] = importRows(plan(data), () => false).map(stored);
    // Another asset with the fund's symbol and exchange, and the fund's own asset given another symbol.
    const lookalike = { ...trade, id: "lookalike", assetId: "uuid-lookalike" };
    const profiles = new Map([["uuid-lookalike", fundRef("a", "XBOM")], ["uuid-a", fundRef("A2", "XBOM")]]);
    const funds = fundRefs(data.folios[0].schemes.map((s) => ({ ...target(data.folios[0], s).asset, assetId: "uuid-a" })), profiles);
    assert.equal(format(closingUnits(data, target, [trade, lookalike], funds, "UTC")[0].held), "103.088");
  });

  test("several assets with the symbol and exchange of a fund without an asset ID need a choice", () => {
    const fund = { symbol: "A", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND", name: "Fictiva Flexi Cap Fund" };
    const profiles = new Map([["uuid-1", fundRef("a", "XBOM")], ["uuid-2", fundRef(" A", "XBOM")], ["uuid-3", fundRef("A", "XNSE")]]);
    assert.throws(
      () => fundRefs([fund], profiles),
      /Several Wealthfolio assets have the symbol and exchange of Fictiva Flexi Cap Fund \(A on XBOM\)\. Under Funds, choose Change, search for A and pick the asset to import into\./,
    );
    assert.deepEqual(fundRefs([{ ...fund, assetId: "uuid-2" }], profiles), new Map([["uuid-2", "A@XBOM"]]));
    assert.deepEqual(fundRefs([fund], new Map([...profiles].slice(1))), new Map([["uuid-2", "A@XBOM"]]));
  });

  test("choices with and without IDs cannot combine different assets under one import key", () => {
    const fund = { symbol: "A", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND" };
    const chosen = { ...fund, assetId: "chosen" };
    const profiles = new Map([["chosen", "A@XBOM"], ["other", "A@XBOM"]]);
    assert.throws(() => fundRefs([chosen, fund], profiles), /Several Wealthfolio assets/);
    assert.throws(() => fundRefs([chosen, { ...fund, assetId: "other" }], profiles), /Several Wealthfolio assets/);
    assert.deepEqual(fundRefs([chosen, fund], new Map([["chosen", "A@XBOM"]])), new Map([["chosen", "A@XBOM"]]));
    assert.deepEqual(fundRefs([chosen, chosen], profiles), new Map([["chosen", "A@XBOM"]]));
  });
});

describe("units", () => {
  const opening = (open, close, transactions) =>
    statement(scheme("A", transactions, { open, close, close_calculated: close }));

  test("statement dates", () => {
    assert.equal(statementDay("01-Apr-2023"), "2023-04-01");
    assert.equal(statementDay("31-DEC-2024"), "2024-12-31");
    assert.equal(statementDay("31-03-2026"), "2026-03-31");
    assert.equal(statementDay("31/03/2026"), "2026-03-31");
    assert.throws(() => statementDay("2023-04-01"));
    assert.throws(() => statementDay("31-13-2026"));
  });

  test("an opening balance is covered by Wealthfolio's units before the statement", () => {
    const earlier = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const later = importRows(plan(statement(scheme("A", sip("2023-04-10")))), () => false).map(stored);
    const data = opening("103.088", "206.176", sip("2023-04-10"));
    const [fund] = openingUnits(data, target, [...earlier, ...later], fundsOf(data), "UTC");
    assert.equal(format(fund.statement), "103.088");
    assert.equal(format(fund.held), "103.088", "only activities before the statement count");
    assert.ok(sameUnits(fund));
    assert.ok(!sameUnits(openingUnits(data, target, later, fundsOf(data), "UTC")[0]));
  });

  test("only posted activities count towards opening and closing units", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const data = opening("103.088", "103.088", []);
    const activities = [buy, ...["DRAFT", "PENDING", "VOID"].map((status) => ({ ...buy, status, quantity: "999" }))];
    assert.ok(sameUnits(openingUnits(data, target, activities, fundsOf(data), "UTC")[0]));
    assert.ok(sameUnits(closingUnits(data, target, activities, fundsOf(data), "UTC")[0]));
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
    const data = opening("0", "13", []);
    assert.ok(sameUnits(closingUnits(data, target, activities, fundsOf(data), "UTC")[0]));
  });

  test("splits and option expiry leave units unknown only within the matching posted history", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const data = opening("103.088", "103.088", []);
    const split = { ...buy, activityType: "SPLIT", quantity: null, amount: "2" };
    const expiry = { ...buy, activityType: "ADJUSTMENT", subtype: "OPTION_EXPIRY", quantity: "10" };
    for (const row of [split, expiry]) {
      for (const count of [openingUnits, closingUnits]) {
        const [fund] = count(data, target, [buy, row], fundsOf(data), "UTC");
        assert.equal(fund.held, undefined);
        assert.ok(!sameUnits(fund));
      }
    }
    const irrelevant = [
      { ...split, status: "DRAFT" },
      { ...split, date: "2025-04-01" },
      { ...split, accountId: "another-account" },
      otherFund(split, "ANOTHER-FUND"),
    ];
    assert.ok(sameUnits(closingUnits(data, target, [buy, ...irrelevant], fundsOf(data), "UTC")[0]));
    const during = { ...split, date: "2023-04-01" };
    assert.ok(sameUnits(openingUnits(data, target, [buy, during], fundsOf(data), "UTC")[0]));
    assert.equal(closingUnits(data, target, [buy, during], fundsOf(data), "UTC")[0].held, undefined);
  });

  test("Wealthfolio's timezone setting, or UTC when it's missing or invalid", async () => {
    const settings = (timezone) => ({ get: async () => ({ timezone }) });
    for (const timezone of ["UTC", "America/Toronto", "Asia/Kolkata", "US/Eastern", "Etc/GMT+5"]) {
      assert.equal(await engineTimeZone(settings(timezone)), timezone);
    }
    for (const timezone of [undefined, "", "Mars/Phobos"]) {
      const timeZone = await engineTimeZone(settings(timezone));
      assert.equal(timeZone, "UTC");
      for (const date of ["2025-03-31T20:30:00+00:00", "2025-04-01T01:00:00+00:00"]) {
        assert.equal(localDay(date, timeZone), date.slice(0, 10));
      }
    }
    await assert.rejects(engineTimeZone({ get: async () => { throw new Error("Not allowed"); } }), /Not allowed/);
  });

  test("activity timestamps keep their instant across DST changes and timestamp formats", () => {
    for (const [date, timeZone, expected] of [
      ["2025-03-09T04:59:59.999999999+00:00", "America/Toronto", "2025-03-08"],
      ["2025-03-09T07:00:00Z", "America/Toronto", "2025-03-09"],
      ["2025-11-02T01:30:00-04:00", "America/Toronto", "2025-11-02"],
      ["2025-11-02T01:30:00-05:00", "America/Toronto", "2025-11-02"],
      ["2024-09-08T03:59:59Z", "America/Santiago", "2024-09-07"],
      ["2024-09-08T04:00:00Z", "America/Santiago", "2024-09-08"],
    ]) {
      inLocalTimeZones(() => {
        assert.equal(localDay(date, timeZone), expected);
        assert.equal(localDay(new Date(date), timeZone), expected);
      });
    }
    assert.equal(localDay(undefined, "UTC"), "");
    assert.throws(() => localDay("invalid", "UTC"), RangeError);
  });

  test("activities count on their day in Wealthfolio's timezone, whatever the device's", () => {
    const [buy] = importRows(plan(statement(scheme("A", sip("2023-03-10")))), () => false).map(stored);
    const data = opening("103.088", "103.088", []);
    const entered = (date, quantity) => ({ ...buy, id: `entered-${date}`, date, quantity });
    // Entered in Wealthfolio's form at 02:00 on 01-Apr in India, and at 21:00 on 31-Mar in Toronto.
    const india = (year) => entered(`${year}-03-31T20:30:00+00:00`, "1");
    const toronto = (year) => entered(`${year}-04-01T01:00:00+00:00`, "2");
    const held = (count, row, timeZone) => format(count(data, target, [buy, row], fundsOf(data), timeZone)[0].held);
    inLocalTimeZones(() => {
      // The statement runs from 01-Apr-2023 to 31-Mar-2025.
      assert.equal(held(openingUnits, india(2023), "Asia/Kolkata"), "103.088");
      assert.equal(held(openingUnits, toronto(2023), "America/Toronto"), "105.088");
      assert.equal(held(closingUnits, india(2025), "Asia/Kolkata"), "103.088");
      assert.equal(held(closingUnits, toronto(2025), "America/Toronto"), "105.088");
      // Their UTC days, when Wealthfolio's timezone is UTC.
      assert.equal(held(openingUnits, india(2023), "UTC"), "104.088");
      assert.equal(held(openingUnits, toronto(2023), "UTC"), "103.088");
      assert.equal(held(closingUnits, india(2025), "UTC"), "104.088");
      assert.equal(held(closingUnits, toronto(2025), "UTC"), "103.088");
      // A bare date stays as given, not UTC midnight on it.
      assert.equal(held(openingUnits, entered("2023-03-31", "1"), "America/Toronto"), "104.088");
      assert.equal(held(openingUnits, entered("2023-04-01", "1"), "America/Toronto"), "103.088");
      assert.equal(held(closingUnits, entered("2025-03-31", "1"), "America/Toronto"), "104.088");
      assert.equal(held(closingUnits, entered("2025-04-01", "1"), "America/Toronto"), "103.088");
    });
  });

  test("sales and reinvested dividends count, cash and other funds don't", () => {
    const data = opening("0", "57.142", [
      ...sip("2023-04-10"),
      tx("2023-06-01", "REDEMPTION", "-3000.00", "-61.000", "49.1803"),
      tx("2023-09-25", "DIVIDEND_REINVEST", "731.39", "15.054", "48.5844"),
    ]);
    const rows = importRows(plan(data), () => false);
    const other = otherFund(stored(rows[0]));
    const [fund] = closingUnits(data, target, [...rows.map(stored), other], fundsOf(data), "UTC");
    assert.equal(format(fund.held), "57.142");
    assert.ok(sameUnits(fund));
  });
});

test("sha256", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("a".repeat(56)), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
});
