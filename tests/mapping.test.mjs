// The mapping from casparser's JSON to Wealthfolio import rows, on made-up statements.
// Cases that need Wealthfolio's own duplicate check belong with the import screen (#11).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { abs, add, cmp, dec, format, mul, neg, sub } from "../src/cas/decimal.ts";
import { closedScheme, mapStatement, withoutClosed } from "../src/cas/mapping.ts";

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
const charge = (date, type, amount) => tx(date, type, amount);

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
  folios: [{ folio: "F1", amc: "Made-up Mutual Fund", name: null, PAN: null, KYC: null, PANKYC: null, schemes }],
  investor_info: { name: "", email: "", address: "", mobile: "" },
  cas_type: "DETAILED",
  file_type: "CAMS",
  parse_warnings: [],
});

const input = (overrides = {}) => ({
  target: (folio, s) => ({
    accountId: `account-${folio.folio}`,
    asset: { symbol: s.isin ?? s.rta_code, exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "EQUITY" },
    openingCovered: true,
  }),
  alreadyImported: () => false,
  ...overrides,
});

const map = (data, overrides) => {
  const mapping = mapStatement(data, input(overrides));
  for (const transaction of mapping.transactions) checkRows(transaction);
  return mapping;
};

/** What Wealthfolio's import would keep, and that each pair nets to zero. */
function checkRows({ activity, cash, bank, arriving, receiving }) {
  if (arriving) return checkConversion(activity, arriving.activity, cash, bank);
  if (activity.activityType.startsWith("TRANSFER_")) return checkGift(activity, receiving?.activity, cash, bank);
  for (const row of [activity, cash, bank].filter(Boolean)) {
    for (const key of ["activityType", "currency", "date", "symbol", "isDraft", "isValid"]) assert.ok(key in row, key);
    assert.equal(row.currency, "INR");
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.isDraft, false);
    assert.equal(row.isValid, true);
    assert.equal(row.assetId, undefined);
    assert.equal(row.comment, undefined);
    for (const key of ["amount", "quantity", "unitPrice", "tax"]) {
      if (key in row && row[key] !== undefined) assert.equal(typeof row[key], "string", key);
    }
    assert.ok(cmp(dec(row.amount), dec("0")) >= 0, "Wealthfolio stores amount magnitudes");
    if (row.symbol) {
      assert.ok(row.quoteCcy);
      assert.ok(row.instrumentType);
    }
  }
  let effect = dec(activity.amount);
  if (activity.activityType === "BUY" || activity.activityType === "SELL") {
    // Wealthfolio replaces an amount near quantity × unit price ± charges with that figure.
    const value = mul(dec(activity.quantity), dec(activity.unitPrice));
    const tax = dec(activity.tax ?? "0");
    const expected = activity.activityType === "BUY" ? add(value, tax) : sub(value, tax);
    assert.equal(cmp(dec(activity.amount), expected), 0, "amount is Wealthfolio's final cash");
    effect = activity.activityType === "BUY" ? neg(expected) : expected;
  }
  if (activity.subtype === "DRIP") {
    assert.equal(cash, undefined);
    assert.equal(bank, undefined);
    return;
  }
  const into = activity.activityType === "BUY";
  assert.equal(cash.activityType, bank ? (into ? "TRANSFER_IN" : "TRANSFER_OUT") : into ? "DEPOSIT" : "WITHDRAWAL");
  assert.equal(cash.accountId, activity.accountId);
  assert.equal(cash.date, activity.date);
  assert.equal(cash.symbol, "");
  assert.equal(cash.amount, activity.amount, "the pair nets to zero");
  if (bank) {
    assert.equal(bank.activityType, into ? "TRANSFER_OUT" : "TRANSFER_IN");
    assert.notEqual(bank.accountId, cash.accountId);
    for (const key of ["date", "symbol", "amount", "currency"]) assert.equal(bank[key], cash[key], key);
  }
  const cashEffect = into ? dec(cash.amount) : neg(dec(cash.amount));
  assert.equal(cmp(add(effect, cashEffect), dec("0")), 0, "signed host cash nets to zero");
}

/** Wealthfolio's rule for a conversion: one group, one account and day, two assets, units on both, no charges or cash. */
function checkConversion(leaving, arriving, cash, bank) {
  assert.equal(cash, undefined);
  assert.equal(bank, undefined);
  for (const [row, subtype] of [[leaving, "CONVERSION_OUT"], [arriving, "CONVERSION_IN"]]) {
    assert.equal(row.activityType, "ADJUSTMENT");
    assert.equal(row.subtype, subtype);
    assert.equal(row.currency, "INR");
    assert.equal(row.isDraft, false);
    assert.equal(row.isValid, true);
    assert.equal(row.assetId, undefined);
    assert.ok(row.quoteCcy && row.instrumentType);
    assert.ok(cmp(dec(row.quantity), dec("0")) > 0, "units on both rows");
    for (const key of ["amount", "unitPrice", "fee", "tax", "comment"]) assert.equal(row[key], undefined, key);
  }
  assert.match(leaving.sourceGroupId, /^cas-importer-merger:[0-9a-f]{64}$/);
  for (const key of ["sourceGroupId", "accountId", "date"]) assert.equal(arriving[key], leaving[key], key);
  assert.notEqual(arriving.symbol, leaving.symbol);
}

/**
 * A gift's transfer: positive units at a positive NAV, no amount or cash. On its own it's external;
 * with its other side, Wealthfolio links the two by account, day, symbol and units × NAV.
 */
function checkGift(activity, receiving, cash, bank) {
  assert.equal(cash, undefined);
  assert.equal(bank, undefined);
  for (const row of [activity, receiving].filter(Boolean)) {
    assert.ok(["TRANSFER_IN", "TRANSFER_OUT"].includes(row.activityType));
    assert.equal(row.currency, "INR");
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.isDraft, false);
    assert.equal(row.isValid, true);
    assert.ok(row.symbol && row.quoteCcy && row.instrumentType);
    assert.ok(cmp(dec(row.quantity), dec("0")) > 0, "positive units");
    assert.ok(cmp(dec(row.unitPrice), dec("0")) > 0, "positive NAV");
    for (const key of ["amount", "fee", "tax", "comment", "assetId", "sourceGroupId", "subtype"]) assert.equal(row[key], undefined, key);
  }
  if (!receiving) return assert.equal(activity.isExternal, true);
  assert.equal(activity.activityType, "TRANSFER_OUT");
  assert.equal(receiving.activityType, "TRANSFER_IN");
  assert.notEqual(receiving.accountId, activity.accountId);
  for (const key of ["date", "symbol", "exchangeMic", "quantity", "unitPrice"]) assert.equal(receiving[key], activity[key], key);
  for (const row of [activity, receiving]) assert.equal(row.isExternal, undefined, "Wealthfolio marks a linked pair internal");
}

const summary = ({ transactions, warnings }) => ({
  rows: transactions.map(({ activity, cash }) => [
    activity.activityType,
    activity.subtype ?? "",
    activity.quantity ?? "",
    activity.amount,
    activity.tax ?? "",
    cash?.activityType ?? "",
  ]),
  warnings: warnings.map((w) => w.message),
});

describe("amounts and charges", () => {
  test("a purchase costs units × NAV plus stamp duty, whichever way the amount is printed", () => {
    for (const printed of ["1000.00", "1001.00"]) {
      const mapping = map(
        statement(scheme("A", [tx("2024-01-10", "PURCHASE", printed, "100.000", "10.0000"), charge("2024-01-10", "STAMP_DUTY_TAX", "1.00")])),
      );
      const [{ activity, cash, rows }] = mapping.transactions;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        [activity.activityType, activity.quantity, activity.unitPrice, activity.amount, activity.tax],
        ["BUY", "100.000", "10.0000", "1001", "1"],
        printed,
      );
      assert.equal(cash.amount, "1001");
      assert.deepEqual(mapping.warnings, []);
    }
  });

  test("a redemption pays units × NAV less STT, whichever way the amount is printed", () => {
    for (const printed of ["-100000.00", "-99999.00"]) {
      const mapping = map(
        statement(scheme("A", [tx("2024-01-10", "REDEMPTION", printed, "-10000.000", "10.0000"), charge("2024-01-10", "STT_TAX", "1.00")])),
      );
      assert.deepEqual(summary(mapping), { rows: [["SELL", "", "10000.000", "99999", "1", "WITHDRAWAL"]], warnings: [] }, printed);
    }
  });

  test("units and NAV keep every printed place", () => {
    const mapping = map(statement(scheme("A", [tx("2024-01-10", "PURCHASE", "1524.15", "12.3456", "123.45678901")])));
    const [{ activity }] = mapping.transactions;
    assert.deepEqual([activity.quantity, activity.unitPrice, activity.amount], ["12.3456", "123.45678901", "1524.148134401856"]);
    assert.deepEqual(mapping.warnings, []);
  });

  test("a printed amount further from units × NAV than the units' rounding is a caveat", () => {
    // Half of 0.001 units at ₹3,000 is ₹1.50, so ₹9,999.50 matches 3.333 units either way.
    const close = map(
      statement(scheme("A", [tx("2024-01-10", "PURCHASE", "9999.50", "3.333", "3000.0000"), charge("2024-01-10", "STAMP_DUTY_TAX", "0.50")])),
    );
    assert.deepEqual(summary(close), { rows: [["BUY", "", "3.333", "9999.5", "0.5", "DEPOSIT"]], warnings: [] });

    const far = map(
      statement(scheme("A", [tx("2024-01-10", "PURCHASE", "1200.00", "100.000", "10.0000"), charge("2024-01-10", "STAMP_DUTY_TAX", "1.00")])),
    );
    assert.deepEqual(summary(far).rows, [["BUY", "", "100.000", "1001", "1", "DEPOSIT"]]);
    assert.deepEqual(
      far.warnings.map((w) => [w.message, w.leftOut, w.rows.length]),
      [
        [
          "The statement's ₹1200 differs from 100.000 units × NAV 10.0000, with or without the ₹1 stamp duty, by more than the units' rounding. It's imported at ₹1001 using the printed units and NAV.",
          false,
          2,
        ],
      ],
    );

    // The allowance follows the units' printed places.
    const coarse = (units) => map(statement(scheme("A", [tx("2024-01-10", "PURCHASE", "1000.40", units, "10.0000")]))).warnings.length;
    assert.equal(coarse("100.0"), 0);
    assert.equal(coarse("100.000"), 1);
  });

  test("the cross-check includes a paisa and accepts the exact tolerance", () => {
    for (const [printed, caveat] of [["1000.015", false], ["1000.0151", true], ["1001.015", false], ["1001.0151", true]]) {
      const mapping = map(statement(scheme("A", [
        tx("2024-01-10", "PURCHASE", printed, "100.000", "10.0000"),
        charge("2024-01-10", "STAMP_DUTY_TAX", "1.00"),
      ])));
      assert.equal(mapping.transactions[0].activity.amount, "1001");
      assert.deepEqual(mapping.warnings.map((w) => w.leftOut), caveat ? [false] : [], printed);
    }
  });

  test("an IDCW payout pays out the gross dividend less TDS, printed either way", () => {
    for (const printed of ["2000.00", "1800.00"]) {
      const mapping = map(
        statement(
          scheme("A", [
            tx("2023-06-01", "PURCHASE", "10000.00", "1000.000", "10.0000", { balance: "1000.000" }),
            tx("2023-12-28", "DIVIDEND_PAYOUT", printed, null, null, { dividend_rate: "2.00" }),
            charge("2023-12-28", "TDS_TAX", "200.00"),
          ]),
        ),
      );
      assert.deepEqual(summary(mapping).rows[1], ["DIVIDEND", "", "", "1800", "200", "WITHDRAWAL"], printed);
      assert.deepEqual(mapping.warnings, []);
    }
  });

  test("a payout that matches the dividend rate neither way is left out", () => {
    const mapping = map(
      statement(
        scheme("A", [
          tx("2023-06-01", "PURCHASE", "10000.00", "1000.000", "10.0000", { balance: "1000.000" }),
          tx("2023-12-28", "DIVIDEND_PAYOUT", "1500.00", null, null, { dividend_rate: "2.00" }),
          charge("2023-12-28", "TDS_TAX", "200.00"),
        ]),
      ),
    );
    assert.equal(mapping.transactions.length, 1);
    assert.deepEqual(summary(mapping).warnings, [
      "₹1500 doesn't match the dividend rate and the units held, with or without the ₹200 TDS.",
    ]);
  });

  test("payout holdings include movements after the last known balance", () => {
    for (const balance of [null, "100.000"]) {
      const mapping = map(statement(scheme("A", [
        tx("2023-06-01", "PURCHASE", "1000.00", "100.000", "10", { balance }),
        tx("2023-07-01", "PURCHASE", "500.00", "50.000", "10"),
        tx("2023-08-01", "REDEMPTION", "-200.00", "-20.000", "10"),
        tx("2023-12-28", "DIVIDEND_PAYOUT", "260.00", null, null, { dividend_rate: "2" }),
        charge("2023-12-28", "TDS_TAX", "26.00"),
      ])));
      assert.deepEqual(mapping.warnings, []);
      assert.deepEqual(summary(mapping).rows.at(-1), ["DIVIDEND", "", "", "234", "26", "WITHDRAWAL"]);
    }
  });

  test("charges exceeding sale proceeds leave the pair out", () => {
    const mapping = map(statement(scheme("A", [
      tx("2024-01-10", "REDEMPTION", "-1.00", "-0.100", "10"),
      charge("2024-01-10", "STT_TAX", "2.00"),
    ])));
    assert.deepEqual(mapping.transactions, []);
    assert.match(mapping.warnings[0].message, /charges exceed/);
    assert.equal(mapping.warnings[0].rows.length, 2);
  });

  test("a trade without a positive NAV is left out", () => {
    for (const nav of [null, "0.0000"]) {
      const mapping = map(statement(scheme("A", [tx("2024-01-10", "PURCHASE", "1000.00", "100.000", nav)])));
      assert.deepEqual(summary(mapping), { rows: [], warnings: ["This row has no NAV."] }, String(nav));
    }
  });

  test("same-day charges that could belong to more than one transaction leave them all out", () => {
    const mapping = map(
      statement(
        scheme("A", [
          tx("2024-01-10", "PURCHASE_SIP", "1000.00", "100.000", "10.0000"),
          tx("2024-01-10", "PURCHASE", "2000.00", "200.000", "10.0000"),
          charge("2024-01-10", "STAMP_DUTY_TAX", "0.05"),
          charge("2024-01-10", "STAMP_DUTY_TAX", "0.10"),
        ]),
      ),
    );
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.rows.map((row) => row.amount), w.message]),
      [
        [["1000.00", "0.05", "0.10"], "Can't tell which of the 2 transactions on this day the ₹0.05 stamp duty belongs to."],
        [["2000.00", "0.05", "0.10"], "Can't tell which of the 2 transactions on this day the ₹0.05 stamp duty belongs to."],
      ],
    );
  });

  test("same-day charges of different kinds go to the transaction each can belong to", () => {
    const mapping = map(
      statement(
        scheme("A", [
          tx("2024-01-10", "REDEMPTION", "-10000.00", "-1000.000", "10.0000"),
          charge("2024-01-10", "STT_TAX", "0.10"),
          tx("2024-01-10", "PURCHASE_SIP", "999.95", "99.995", "10.0000"),
          charge("2024-01-10", "STAMP_DUTY_TAX", "0.05"),
        ]),
      ),
    );
    assert.deepEqual(summary(mapping), {
      rows: [
        ["SELL", "", "1000.000", "9999.9", "0.1", "WITHDRAWAL"],
        ["BUY", "", "99.995", "1000", "0.05", "DEPOSIT"],
      ],
      warnings: [],
    });
  });

  test("a second charge of the same kind, or a charge with no transaction, is a warning", () => {
    const mapping = map(
      statement(
        scheme("A", [
          tx("2024-01-10", "PURCHASE", "1000.00", "100.000", "10.0000"),
          charge("2024-01-10", "STAMP_DUTY_TAX", "0.05"),
          charge("2024-01-10", "STAMP_DUTY_TAX", "0.05"),
          charge("2024-02-10", "STT_TAX", "0.05"),
        ]),
      ),
    );
    assert.deepEqual(summary(mapping), {
      rows: [],
      warnings: ["More than one stamp duty row follows this transaction.", "There's no transaction on this day to add this STT to."],
    });
  });
});

test("a reinvested dividend's stamp duty is dividend tax, not purchase cost", () => {
  const mapping = map(
    statement(
      scheme("A", [
        tx("2023-09-25", "DIVIDEND_REINVEST", "1312.46", "84.054", "15.6145", { dividend_rate: "0.40" }),
        charge("2023-09-25", "STAMP_DUTY_TAX", "0.07"),
      ]),
    ),
  );
  const [{ activity, cash }] = mapping.transactions;
  assert.equal(cash, undefined);
  assert.deepEqual(
    [activity.activityType, activity.subtype, activity.quantity, activity.unitPrice, activity.amount, activity.tax],
    ["DIVIDEND", "DRIP", "84.054", "15.6145", "1312.461183", "0.07"],
  );
  // Wealthfolio splits it (compile.rs `expand`): dividend income with the row's amount and tax,
  // then a purchase of the same amount at the unit price, without charges.
  assert.equal(format(add(dec(activity.amount), dec(activity.tax))), "1312.531183", "gross dividend income");
  const purchaseCost = mul(dec(activity.quantity), dec(activity.unitPrice));
  assert.equal(cmp(purchaseCost, dec(activity.amount)), 0, "the purchase uses all of the dividend");
});

describe("opening balance", () => {
  const data = statement(
    scheme("A", [tx("2024-01-10", "REDEMPTION", "-500.00", "-50.000", "10.0000")], { open: "100.000" }),
  );

  test("without earlier history the scheme is left out", () => {
    const mapping = map(data, { target: (folio, s) => ({ ...input().target(folio, s), openingCovered: false }) });
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.scheme, w.rows, w.leftOut]),
      [["A", [], true]],
    );
    assert.match(mapping.warnings[0].message, /starts with 100\.000 units bought before 01-Apr-2023/);
  });

  test("with earlier history the scheme is imported", () => {
    assert.deepEqual(summary(map(data)).rows, [["SELL", "", "50.000", "500", "", "WITHDRAWAL"]]);
  });

  test("a scheme with no account or fund chosen is left out", () => {
    const mapping = map(data, { target: () => undefined });
    assert.deepEqual(summary(mapping), {
      rows: [],
      warnings: ["No Wealthfolio account or fund is chosen for this scheme, so its transactions are left out."],
    });
  });
});

test("a switch sells one fund and buys the other, each with its own cash", () => {
  const mapping = map(
    statement(
      scheme("A", [tx("2024-06-20", "SWITCH_OUT", "-100000.00", "-10000.000", "10.0000"), charge("2024-06-20", "STT_TAX", "1.00")]),
      scheme("B", [tx("2024-06-20", "SWITCH_IN", "99994.00", "4999.700", "20.0000"), charge("2024-06-20", "STAMP_DUTY_TAX", "5.00")]),
    ),
  );
  assert.deepEqual(summary(mapping), {
    rows: [
      ["SELL", "", "10000.000", "99999", "1", "WITHDRAWAL"],
      ["BUY", "", "4999.700", "99999", "5", "DEPOSIT"],
    ],
    warnings: [],
  });
  assert.deepEqual(
    mapping.transactions.map((t) => t.activity.symbol),
    ["INF-A", "INF-B"],
  );
});

test("equal purchases of two funds on one day keep both purchases and both deposits", () => {
  const purchase = () => [tx("2024-01-10", "PURCHASE_SIP", "999.95", "99.995", "10.0000"), charge("2024-01-10", "STAMP_DUTY_TAX", "0.05")];
  const mapping = map(statement(scheme("A", purchase()), scheme("B", purchase())));
  const [a, b] = mapping.transactions;
  assert.notEqual(a.activity.symbol, b.activity.symbol);
  // Wealthfolio's duplicate check will match these; #11 lets the user import both.
  const { lineNumber: first, ...deposit } = a.cash;
  const { lineNumber: second, ...otherDeposit } = b.cash;
  assert.deepEqual(deposit, otherDeposit);
  assert.notEqual(first, second);
});

describe("reversals", () => {
  const purchase = tx("2024-01-10", "PURCHASE_SIP", "999.95", "99.995", "10.0000");
  const reversal = tx("2024-01-15", "REVERSAL", "-999.95", "-99.995", "10.0000");

  test("a reversed purchase is left out with its reversal", () => {
    const mapping = map(statement(scheme("A", [purchase, charge("2024-01-10", "STAMP_DUTY_TAX", "0.05"), reversal])));
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.rows.map((row) => row.type), w.message]),
      [[["PURCHASE_SIP", "STAMP_DUTY_TAX", "REVERSAL"], "The statement reverses this purchase, so neither row is imported."]],
    );
  });

  test("a reversed purchase imported earlier needs correcting", () => {
    for (const bankAccountId of [undefined, "bank-1"]) {
      const asked = [];
      const mapping = map(statement(scheme("A", [purchase, reversal])), {
        target: (folio, s) => ({ ...input().target(folio, s), bankAccountId }),
        alreadyImported: (activity) => (asked.push(activity.activityType), activity.activityType === "BUY"),
      });
      assert.deepEqual(asked, ["BUY"]);
      assert.deepEqual(mapping.transactions, []);
      assert.match(mapping.warnings[0].message, /^Wealthfolio has this purchase from an earlier import, but the statement reverses it\. Delete/);
      assert.match(mapping.warnings[0].message, /If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer\. Then delete the bank account's side too, unless it's a row from your bank statement\.$/);
    }
  });

  test("a reversal without its purchase, or with more than one candidate, is a warning", () => {
    assert.deepEqual(summary(map(statement(scheme("A", [reversal])))).warnings, [
      "This reversal's purchase isn't in the statement, so the reversal isn't imported. If Wealthfolio has that purchase, delete it and its cash in the fund account. If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer. Then delete the bank account's side too, unless it's a row from your bank statement.",
    ]);
    const twice = summary(map(statement(scheme("A", [purchase, { ...purchase, date: "2024-01-11" }, reversal]))));
    assert.equal(twice.rows.length, 2);
    assert.match(twice.warnings[0], /^2 purchases in the statement could be the one this reverses/);
    assert.match(twice.warnings[0], /If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer\. Then delete the bank account's side too, unless it's a row from your bank statement\.$/);
  });

  test("a reversal with contradictory or missing amounts does not cancel a purchase", () => {
    for (const amount of ["-2000.00", null]) {
      const mapping = map(statement(scheme("A", [purchase, { ...reversal, amount }])));
      assert.equal(mapping.transactions.length, 1);
      assert.equal(mapping.transactions[0].rows[0], purchase);
      assert.match(mapping.warnings[0].message, /purchase isn't in the statement/);
    }
  });

  // Franklin Templeton's wound-up schemes print "Payment - Units Extinguished-Reversed", which casparser returns as a purchase.
  const extinguished = tx("2021-03-30", "REDEMPTION", "-5126.75", "-171.447", "29.9028", { description: "Payment - Units Extinguished" });
  const restored = tx("2021-04-05", "PURCHASE", "5126.75", "171.447", "29.9028", { description: "Payment - Units Extinguished-Reversed" });
  const repaid = { ...extinguished, date: "2021-04-20" };

  test("a later row with opposite units and amount is left out as a possible redemption reversal", () => {
    const mapping = map(statement(scheme("A", [extinguished, charge("2021-03-30", "STT_TAX", "0.05"), restored, repaid], { open: "171.447" })));
    assert.deepEqual(summary(mapping).rows, [["SELL", "", "171.447", "5126.7453516", "", "WITHDRAWAL"]]);
    assert.equal(mapping.transactions[0].rows[0], repaid);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.rows.map((row) => row.type), w.message]),
      [[["REDEMPTION", "STT_TAX", "PURCHASE"], "A later row has the opposite units and amount to this redemption. This could be a reversal or a new purchase, so neither row is imported. Check the statement and handle these rows by hand."]],
    );
  });

  test("an earlier import needs review before deleting a possible reversed redemption", () => {
    for (const existing of ["SELL", "WITHDRAWAL", "TRANSFER_OUT"]) {
      const asked = [];
      const cashType = existing === "TRANSFER_OUT" ? "TRANSFER_OUT" : "WITHDRAWAL";
      const mapping = map(statement(scheme("A", [extinguished, restored], { open: "171.447" })), {
        target: (folio, s) => ({ ...input().target(folio, s), bankAccountId: existing === "TRANSFER_OUT" ? "bank-1" : undefined }),
        alreadyImported: (activity) => (asked.push(activity.activityType), activity.activityType === existing),
      });
      assert.deepEqual(asked, existing === "SELL" ? ["SELL"] : ["SELL", cashType]);
      assert.deepEqual(mapping.transactions, []);
      assert.match(mapping.warnings[0].message, /could be a reversal or a new purchase/);
      assert.match(mapping.warnings[0].message, /Wealthfolio has the sale or its cash from an earlier import; delete the fund rows only if this is a reversal\./);
      assert.match(mapping.warnings[0].message, /If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer\. Then delete the bank account's side too, unless it's a row from your bank statement\.$/);
    }
    const mapping = map(statement(scheme("A", [{ ...extinguished, nav: null }, restored], { open: "171.447" })));
    assert.deepEqual(mapping.transactions, []);
    assert.match(mapping.warnings[0].message, /If Wealthfolio has the sale or its cash from an earlier import, delete the fund rows only if this is a reversal\./);
    assert.match(mapping.warnings[0].message, /If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer\. Then delete the bank account's side too, unless it's a row from your bank statement\.$/);
  });

  test("an explicit purchase reversal takes priority over a possible redemption reversal", () => {
    for (const type of ["PURCHASE", "PURCHASE_SIP"]) {
      const bought = { ...restored, type };
      const undone = { ...repaid, type: "REVERSAL" };
      const mapping = map(statement(scheme("A", [extinguished, bought, undone], { open: "171.447" })));
      assert.deepEqual(mapping.transactions.map((t) => t.rows), [[extinguished]]);
      assert.deepEqual(mapping.warnings.map((w) => w.rows), [[bought, undone]]);
      assert.equal(mapping.warnings[0].message, "The statement reverses this purchase, so neither row is imported.");
    }
  });

  test("a redemption can be paired only once", () => {
    const bought = { ...restored, type: "PURCHASE_SIP", date: "2021-04-10" };
    const mapping = map(statement(scheme("A", [extinguished, restored, bought], { open: "171.447" })));
    assert.deepEqual(mapping.transactions.map((t) => t.rows), [[bought]]);
    assert.deepEqual(mapping.warnings.map((w) => w.rows), [[extinguished, restored]]);
  });

  test("opposite unit movements without payment keep their separate warnings", () => {
    for (const amount of [null, "0.00"]) {
      for (const type of ["PURCHASE", "PURCHASE_SIP"]) {
        const removed = { ...extinguished, amount };
        const added = { ...restored, type, amount };
        const mapping = map(statement(scheme("A", [removed, added], { open: "171.447" })));
        assert.deepEqual(mapping.transactions, []);
        assert.deepEqual(mapping.warnings.map((w) => w.rows), [[removed], [added]]);
        assert.deepEqual(summary(mapping).warnings, [
          "Units removed without a payment, such as a transmission or a move to another folio, aren't imported yet.",
          "Units added without a payment, such as bonus units or a transmission, aren't imported yet.",
        ]);
      }
    }
  });

  test("a purchase reverses no redemption unless exactly one earlier redemption has the same units and amount", () => {
    const cases = [
      [restored, extinguished],
      [extinguished, { ...restored, amount: "5000.00" }],
      [extinguished, { ...restored, units: "171.446" }],
      [extinguished, { ...extinguished, date: "2021-03-31" }, restored],
    ];
    for (const rows of cases) {
      const mapping = map(statement(scheme("A", rows, { open: "342.894" })));
      assert.equal(mapping.transactions.length, rows.length);
      assert.ok(mapping.warnings.every((w) => !w.leftOut));
    }
  });
});

describe("mergers", () => {
  const out = tx("2024-08-01", "SWITCH_OUT_MERGER", "-1000.00", "-100.000", "10.0000");
  const into = tx("2024-08-01", "SWITCH_IN_MERGER", "1000.00", "50.000", "20.0000");
  const group = (mapping) => mapping.transactions.find((t) => t.arriving).activity.sourceGroupId;

  test("a matched merger is a fund conversion, with no cash", () => {
    const mapping = map(statement(scheme("A", [out]), scheme("B", [into])));
    assert.deepEqual(mapping.warnings, []);
    assert.equal(mapping.transactions.length, 1);
    const [{ scheme: name, rows, activity, arriving, earlier }] = mapping.transactions;
    assert.deepEqual([name, rows, arriving.scheme, arriving.rows], ["A", [out], "B", [into]]);
    assert.deepEqual(
      [activity, arriving.activity].map((r) => [r.subtype, r.symbol, r.quantity, r.date, r.symbolName]),
      [
        ["CONVERSION_OUT", "INF-A", "100.000", "2024-08-01", "A"],
        ["CONVERSION_IN", "INF-B", "50.000", "2024-08-01", "B"],
      ],
    );
    // What v1.2.0 and earlier imported instead.
    assert.deepEqual(
      earlier.map((r) => [r.activityType, r.symbol, r.quantity ?? "", r.amount]),
      [
        ["SELL", "INF-A", "100.000", "1000"],
        ["WITHDRAWAL", "", "", "1000"],
        ["BUY", "INF-B", "50.000", "1000"],
        ["DEPOSIT", "", "", "1000"],
      ],
    );
  });

  test("a conversion needs no amount or NAV, but keeps known fields to check earlier imports", () => {
    const mapping = map(statement(scheme("A", [{ ...out, nav: null }]), scheme("B", [into])));
    assert.equal(mapping.transactions.length, 1);
    assert.equal(mapping.transactions[0].earlier.length, 4);
    assert.deepEqual(mapping.transactions[0].earlier.map((r) => r.activityType), ["SELL", "WITHDRAWAL", "BUY", "DEPOSIT"]);
    assert.equal(mapping.transactions[0].earlier[0].unitPrice, undefined);
    assert.equal(mapping.transactions[0].earlier[0].amount, undefined);
  });

  test("a merger's group is the same on every statement that lists it, and different for each merger", () => {
    const first = group(map(statement(scheme("A", [out]), scheme("B", [into]))));
    assert.equal(group(map(statement(scheme("A", [out]), scheme("B", [into])))), first);
    // Both statement issuers can print different codes or omit the same fund's ISIN.
    for (const rta of ["KARVY", "KFIN", "KFINTECH"]) {
      const kfin = statement(
        scheme("A", [out], { isin: null, rta, rta_code: "OLD-A" }),
        scheme("B", [into], { isin: null, rta, rta_code: "NEW-B" }),
      );
      kfin.file_type = "KFINTECH";
      const target = (folio, s) => input().target(folio, { ...s, isin: `INF-${s.scheme}` });
      assert.equal(group(map(kfin, { target })), first);
    }
    // An overlapping statement: another period, other rows, the folio number spaced differently.
    const overlapping = statement(
      scheme("A", [tx("2024-06-10", "PURCHASE", "1000.00", "100.000", "10.0000"), out]),
      scheme("B", [into, tx("2024-09-10", "PURCHASE", "1000.00", "50.000", "20.0000")]),
    );
    overlapping.statement_period = { from: "01-Apr-2024", to: "31-Mar-2026" };
    overlapping.folios[0].folio = " F 1 ";
    assert.equal(group(map(overlapping, { target: (folio, s) => ({ ...input().target(folio, s), accountId: "account-F1" }) })), first);
    assert.ok(!first.includes("F1"));

    // The same folio imported into another account is another conversion: Wealthfolio's groups span accounts.
    assert.notEqual(
      group(map(statement(scheme("A", [out]), scheme("B", [into])), { target: (folio, s) => ({ ...input().target(folio, s), accountId: "account-2" }) })),
      first,
    );
    // The same merger in two folios of one account is two conversions.
    const twoFolios = statement(scheme("A", [out]), scheme("B", [into]));
    twoFolios.folios.push({ ...twoFolios.folios[0], folio: "F2" });
    const mapping = map(twoFolios, { target: (folio, s) => ({ ...input().target(folio, s), accountId: "account-1" }) });
    const groups = mapping.transactions.map((t) => t.activity.sourceGroupId);
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0], groups[1]);
    // Another day, or other funds, is another merger.
    assert.notEqual(group(map(statement(scheme("A", [{ ...out, date: "2024-08-02" }]), scheme("B", [{ ...into, date: "2024-08-02" }])))), first);
    assert.notEqual(group(map(statement(scheme("A", [out]), scheme("C", [into])))), first);
  });

  test("a merger without its other half is left out", () => {
    const counted = (counts) => `Can't match this merger with its other half: the folio has ${counts} on this day.`;
    for (const [schemes, counts] of [
      [[scheme("A", [out])], "1 merger sale and 0 merger purchases"],
      [[scheme("B", [into])], "0 merger sales and 1 merger purchase"],
      [[scheme("A", [out]), scheme("C", [out]), scheme("B", [into])], "2 merger sales and 1 merger purchase"],
      [[scheme("A", [out]), scheme("B", [into]), scheme("D", [into])], "1 merger sale and 2 merger purchases"],
    ]) {
      assert.deepEqual(summary(map(statement(...schemes))), {
        rows: [],
        warnings: schemes.map(() => counted(counts)),
      });
    }
  });

  test("when one half can't be imported, neither is", () => {
    for (const omitted of ["A", "B"]) {
      const mapping = map(statement(scheme("A", [out]), scheme("B", [into])), {
        target: (folio, s) => (s.scheme === omitted ? undefined : input().target(folio, s)),
      });
      assert.deepEqual(mapping.transactions, []);
      assert.deepEqual(
        mapping.warnings.map((w) => w.message),
        ["A", "B"].map((name) => name === omitted
          ? "No Wealthfolio account or fund is chosen for this scheme, so its transactions are left out."
          : "The other half of this merger can't be imported, so neither half is."),
      );
    }
  });

  test("a merger a conversion can't record is left out, both halves", () => {
    const stamped = map(statement(scheme("A", [out]), scheme("B", [into, charge("2024-08-01", "STAMP_DUTY_TAX", "0.05")])));
    const sameFund = map(statement(scheme("A", [out]), scheme("B", [into])), {
      target: (folio, s) => ({ ...input().target(folio, s), asset: { ...input().target(folio, s).asset, symbol: "inf-a" } }),
    });
    const twoAccounts = map(statement(scheme("A", [out]), scheme("B", [into])), {
      target: (folio, s) => ({ ...input().target(folio, s), accountId: `account-${s.scheme}` }),
    });
    const noUnits = map(statement(scheme("A", [out]), scheme("B", [{ ...into, units: "0" }])));
    for (const [mapping, message] of [
      [stamped, "This merger lists stamp duty, which a fund conversion in Wealthfolio can't carry, so neither half is imported."],
      [sameFund, "Both funds of this merger are confirmed as the same Wealthfolio asset, so neither half is imported. Confirm each scheme's own fund under Funds."],
      [twoAccounts, "This merger's funds go to different Wealthfolio accounts, and a fund conversion stays in one, so neither half is imported."],
      [noUnits, "This row has no units, or units with the wrong sign."],
    ]) {
      assert.deepEqual(mapping.transactions, []);
      assert.deepEqual(
        mapping.warnings.map((w) => [w.scheme, w.leftOut]),
        [["A", true], ["B", true]],
      );
      assert.ok(mapping.warnings.some((w) => w.message === message), message);
    }
  });
});

describe("gifts", () => {
  // Descriptions as in casparser 1.4.1's tests; the folios are made up.
  const GIVER = "11111111 / 22";
  const RECEIVER = "33333333";
  const giftOut = (extra = {}) =>
    tx("2024-06-03", "GIFT_OUT", "-50000.00", "-1000.000", "50.0000", {
      description: "Gifting of units-TO Folio No: 33333333",
      gift_folio: "33333333",
      ...extra,
    });
  const giftIn = (extra = {}) =>
    tx("2024-06-03", "GIFT_IN", "50000.00", "1000.000", "50.0000", {
      description: "Gifting of units - From Folio No.11111111",
      gift_folio: "11111111",
      ...extra,
    });
  const folio = (number, ...schemes) => ({ folio: number, amc: "Made-up Mutual Fund", name: null, PAN: null, KYC: null, PANKYC: null, schemes });
  const twoFolios = (out, into, outExtra = {}, inExtra = {}) => ({
    ...statement(),
    folios: [folio(GIVER, scheme("A", out, outExtra)), folio(RECEIVER, scheme("A", into, inExtra))],
  });
  const purchase = tx("2024-01-10", "PURCHASE", "40000.00", "1000.000", "40.0000");
  const messages = (mapping) => mapping.warnings.map((w) => [w.folio, w.leftOut, w.message]);
  const RECEIVED =
    "Imported at NAV 50.0000, the units' value on the day of the gift: Wealthfolio counts their cost and holding period from that day. For tax, a gift keeps the giver's cost and purchase dates, which the statement doesn't show.";
  const LINKED =
    "A gift to folio 33333333: Wealthfolio links this transfer out with that folio's transfer in, so the units keep the costs and purchase dates Wealthfolio has for them here.";
  const OTHER_SIDE = "The other side of this gift can't be imported, so neither side is.";
  const RIVAL =
    "Wealthfolio's import could link this gift with another gift the other way on this day, with the same symbol and value, that may not be its other side, so it isn't imported. Enter these gifts in Wealthfolio by hand.";

  test("a gift received on its own is an external transfer in at the day's NAV, with no cash", () => {
    const mapping = map(statement(scheme("A", [giftIn()])));
    assert.deepEqual(
      mapping.transactions.map(({ activity: a }) => [a.activityType, a.accountId, a.date, a.symbol, a.quantity, a.unitPrice, a.isExternal]),
      [["TRANSFER_IN", "account-F1", "2024-06-03", "INF-A", "1000.000", "50.0000", true]],
    );
    assert.deepEqual(messages(mapping), [["F1", false, RECEIVED]]);
  });

  test("a gift given on its own is an external transfer out of positive units", () => {
    const mapping = map(statement(scheme("A", [purchase, giftOut()])));
    assert.deepEqual(
      mapping.transactions.map(({ activity: a }) => [a.activityType, a.quantity, a.unitPrice ?? "", a.isExternal ?? ""]),
      [["BUY", "1000.000", "40.0000", ""], ["TRANSFER_OUT", "1000.000", "50.0000", true]],
    );
    assert.deepEqual(mapping.warnings, []);
  });

  test("a printed amount further from units × NAV than the units' rounding is a caveat", () => {
    for (const amount of ["50001", "0"]) {
      const off = map(statement(scheme("A", [giftIn({ amount })])));
      assert.deepEqual(messages(off), [
        ["F1", false, `${RECEIVED} The statement's ₹${amount} differs from 1000.000 units × NAV 50.0000 by more than the units' rounding. It's imported at NAV 50.0000.`],
      ]);
    }
    for (const amount of ["50000.03", null]) {
      assert.deepEqual(messages(map(statement(scheme("A", [giftIn({ amount })])))), [["F1", false, RECEIVED]], String(amount));
    }
  });

  test("gifts require signed nonzero units and a positive NAV", () => {
    for (const make of [giftIn, giftOut]) {
      for (const change of [
        ...[null, "0", make === giftIn ? "-1000" : "1000"].map((units) => ({ units })),
        ...[null, "0", "-50"].map((nav) => ({ nav })),
      ]) {
        const mapping = map(statement(scheme("A", [make(change)])));
        assert.deepEqual(mapping.transactions, [], JSON.stringify(change));
        assert.equal(mapping.warnings.length, 1);
        assert.equal(mapping.warnings[0].leftOut, true);
        assert.match(mapping.warnings[0].message, change.units !== undefined ? /no units|wrong sign/ : /no NAV/);
      }
    }
  });

  test("a gift without a NAV or with a charge on its day is left out", () => {
    const noNav = map(statement(scheme("A", [giftIn({ nav: null })])));
    assert.deepEqual(noNav.transactions, []);
    assert.deepEqual(messages(noNav), [["F1", true, "This gift has no NAV, so its value on the day isn't known and it isn't imported."]]);
    const stamped = map(statement(scheme("A", [giftIn(), charge("2024-06-03", "STAMP_DUTY_TAX", "0.15")])));
    assert.deepEqual(stamped.transactions, []);
    assert.deepEqual(stamped.warnings.map((w) => w.rows.map((row) => row.type)), [["GIFT_IN", "STAMP_DUTY_TAX"]]);
    // A charge that could be the gift's or a purchase's keeps both out, as for two purchases.
    const sameDay = map(statement(scheme("A", [{ ...purchase, date: "2024-06-03" }, giftIn(), charge("2024-06-03", "STAMP_DUTY_TAX", "2.00")])));
    assert.deepEqual(sameDay.transactions, []);
    assert.deepEqual(
      sameDay.warnings.map((w) => w.message),
      Array(2).fill("Can't tell which of the 2 transactions on this day the ₹2.00 stamp duty belongs to."),
    );
  });

  test("both sides in different accounts are one transfer, which Wealthfolio links", () => {
    for (const [out, into] of [[giftOut(), giftIn()], [giftOut(), giftIn({ gift_folio: null })], [giftOut({ gift_folio: null }), giftIn()]]) {
      const mapping = map(twoFolios([purchase, out], [into]));
      const gift = mapping.transactions.find((t) => t.receiving);
      assert.ok(gift);
      assert.equal(mapping.transactions.length, 2);
      assert.deepEqual([gift.folio, gift.rows, gift.receiving.folio, gift.receiving.scheme, gift.receiving.rows], [GIVER, [out], RECEIVER, "A", [into]]);
      assert.deepEqual(
        [gift.activity, gift.receiving.activity].map((a) => [a.activityType, a.accountId, a.quantity, a.unitPrice]),
        [
          ["TRANSFER_OUT", `account-${GIVER}`, "1000.000", "50.0000"],
          ["TRANSFER_IN", `account-${RECEIVER}`, "1000.000", "50.0000"],
        ],
      );
      assert.deepEqual(messages(mapping), [[GIVER, false, LINKED]]);
    }
  });

  test("gifts that only look alike aren't paired, and stay out when Wealthfolio could link them", () => {
    // Neither names the other's folio, or one names a third folio.
    for (const [out, into] of [[giftOut({ gift_folio: null }), giftIn({ gift_folio: null })], [giftOut({ gift_folio: "99999999" }), giftIn()]]) {
      const mapping = map(twoFolios([purchase, out], [into]));
      assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY"]);
      assert.deepEqual(messages(mapping), [[GIVER, true, RIVAL], [RECEIVER, true, RIVAL]]);
    }
    // In one account the import links nothing, so each is a gift on its own.
    const oneAccount = map(twoFolios([purchase, giftOut({ gift_folio: null })], [giftIn({ gift_folio: null })]), {
      target: (f, s) => ({ ...input().target(f, s), accountId: "account-1" }),
    });
    assert.deepEqual(oneAccount.transactions.map((t) => [t.activity.activityType, t.activity.isExternal ?? ""]), [
      ["BUY", ""],
      ["TRANSFER_OUT", true],
      ["TRANSFER_IN", true],
    ]);
    // Another day or fund isn't the other side, and couldn't be linked with it.
    for (const [out, into] of [[giftOut(), giftIn({ date: "2024-06-04" })], [giftOut(), giftIn({ units: "999.000" })]]) {
      const data = twoFolios([purchase, out], [into]);
      if (into.units === "999.000") data.folios[1].schemes[0] = scheme("B", [into]);
      const mapping = map(data);
      assert.deepEqual(mapping.transactions.map((t) => [t.activity.activityType, t.activity.isExternal ?? ""]), [
        ["BUY", ""],
        ["TRANSFER_OUT", true],
        ["TRANSFER_IN", true],
      ]);
    }
  });

  test("two gifts of different sizes between the same folios on one day pair by their units", () => {
    const small = (gift) => gift({ amount: gift === giftOut ? "-10000.00" : "10000.00", units: gift === giftOut ? "-200.000" : "200.000" });
    for (const into of [[giftIn(), small(giftIn)], [small(giftIn), giftIn()]]) {
      const mapping = map(twoFolios([purchase, giftOut(), small(giftOut)], into));
      assert.deepEqual(mapping.warnings.filter((w) => w.leftOut), []);
      assert.deepEqual(
        mapping.transactions.filter((t) => t.receiving).map((t) => [t.activity.quantity, t.receiving.activity.quantity, t.receiving.rows[0].units]),
        [["1000.000", "1000.000", "1000.000"], ["200.000", "200.000", "200.000"]],
      );
    }
  });

  test("an excluded exact counterpart neither hides a selected disagreement nor makes a pair ambiguous", () => {
    for (const units of ["200.000", "1000.000"]) {
      const data = twoFolios([purchase, giftOut({ gift_folio: null })], [giftIn()]);
      data.folios.push(folio("55555555", scheme("A", [giftIn({ units, amount: null })])));
      for (const folios of [data.folios, [...data.folios].reverse()]) {
        const mapping = map({ ...data, folios }, {
          target: (f, s) => f.folio === RECEIVER ? undefined : input().target(f, s),
        });
        const gifts = mapping.transactions.filter((t) => t.activity.activityType.startsWith("TRANSFER_"));
        assert.equal(gifts.length, units === "1000.000" ? 1 : 0);
        if (gifts.length) assert.equal(gifts[0].receiving.folio, "55555555");
        else assert.equal(mapping.warnings.filter((w) => /don't have opposite units/.test(w.message)).length, 2);
      }
    }
  });

  test("a named other side with other units or NAV, or none, keeps both out", () => {
    for (const into of [
      ...["999.000", null, "0", "-1000.000"].map((units) => giftIn({ units })),
      ...["50.0100", null, "0", "-50"].map((nav) => giftIn({ nav })),
    ]) {
      const mapping = map(twoFolios([purchase, giftOut()], [into]));
      assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY"]);
      const misread = (other) => `This gift and its other side, in folio ${other}, don't have opposite units and the same NAV, so neither side is imported. Check both rows against the PDF.`;
      assert.deepEqual(messages(mapping), [[GIVER, true, misread(RECEIVER)], [RECEIVER, true, misread(GIVER)]]);
    }
    // With the other side's folio or fund left out, the one chosen is a gift on its own.
    const alone = map(twoFolios([purchase, giftOut()], [giftIn({ units: "999.000" })]), {
      target: (f, s) => (f.folio === RECEIVER ? undefined : input().target(f, s)),
    });
    assert.deepEqual(alone.transactions.map((t) => [t.activity.activityType, t.activity.isExternal ?? ""]), [["BUY", ""], ["TRANSFER_OUT", true]]);
  });

  test("two pairs with the same values are left out, as the import could link them crosswise", () => {
    const data = {
      ...statement(),
      folios: [
        folio(GIVER, scheme("A", [purchase, giftOut()])),
        folio(RECEIVER, scheme("A", [giftIn()])),
        folio("55555555", scheme("A", [purchase, giftOut({ gift_folio: "77777777" })])),
        folio("77777777", scheme("A", [giftIn({ gift_folio: "55555555" })])),
      ],
    };
    const mapping = map(data);
    assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY", "BUY"]);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.folio, w.message]),
      [GIVER, RECEIVER, "55555555", "77777777"].map((f) => [f, RIVAL]),
    );
  });

  test("the import's symbol-only key can link unrelated gifts on different exchanges", () => {
    const data = twoFolios([purchase, giftOut({ gift_folio: null })], [giftIn({ gift_folio: null })]);
    data.folios[1].schemes[0] = scheme("B", [giftIn({ gift_folio: null })]);
    const mapping = map(data, {
      target: (f, s) => ({
        ...input().target(f, s),
        asset: { ...input().target(f, s).asset, symbol: "SHARED", exchangeMic: f.folio === GIVER ? "XBOM" : "XNSE" },
      }),
    });
    assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY"]);
    assert.deepEqual(messages(mapping), [[GIVER, true, RIVAL], [RECEIVER, true, RIVAL]]);
  });

  test("ambiguous candidates remain standalone when excluded or in one account", () => {
    const data = twoFolios([purchase, giftOut(), giftOut()], [giftIn(), giftIn()]);
    for (const target of [
      (f, s) => (f.folio === RECEIVER ? undefined : input().target(f, s)),
      (f, s) => ({ ...input().target(f, s), accountId: "account-1" }),
    ]) {
      const mapping = map(data, { target });
      const gifts = mapping.transactions.filter((t) => t.activity.activityType.startsWith("TRANSFER_"));
      assert.equal(gifts.length, target(data.folios[1], data.folios[1].schemes[0]) ? 4 : 2);
      assert.ok(gifts.every((t) => t.activity.isExternal && !t.receiving));
      assert.ok(!mapping.warnings.some((w) => w.message === RIVAL));
    }
  });

  test("a folio cannot be its own gift counterpart", () => {
    const data = { ...statement(), folios: [folio(GIVER, scheme("A", [purchase, giftOut({ gift_folio: "11111111" }), giftIn()]))] };
    const mapping = map(data);
    assert.deepEqual(mapping.transactions.map((t) => [t.activity.activityType, t.activity.isExternal ?? ""]), [
      ["BUY", ""], ["TRANSFER_OUT", true], ["TRANSFER_IN", true],
    ]);
    assert.ok(mapping.transactions.every((t) => !t.receiving));
  });

  test("both sides in one account are left out: the units stay there", () => {
    const oneAccount = { target: (f, s) => ({ ...input().target(f, s), accountId: "account-1" }) };
    const mapping = map(twoFolios([purchase, giftOut()], [giftIn()]), oneAccount);
    assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY"]);
    const message = "Both sides of this gift go to the same Wealthfolio account, so its units stay there and neither side is imported.";
    assert.deepEqual(messages(mapping), [[GIVER, true, message], [RECEIVER, true, message]]);
    // A side Wealthfolio has, imported before or entered by hand, changed the units' cost and dates.
    for (const type of ["TRANSFER_IN", "TRANSFER_OUT"]) {
      const entered = map(twoFolios([purchase, giftOut()], [giftIn()]), { ...oneAccount, entered: (activity) => activity.activityType === type });
      assert.deepEqual(messages(entered).map(([, , m]) => m), Array(2).fill(
        `${message} Wealthfolio has a transfer or trade of these units on this day, which changes their cost and purchase dates: delete it, with its other side or cash.`,
      ));
    }
  });

  test("when the user leaves one side out, the other is a gift on its own", () => {
    const withoutReceiver = map(twoFolios([purchase, giftOut()], [giftIn()]), {
      target: (f, s) => (f.folio === RECEIVER ? undefined : input().target(f, s)),
    });
    assert.deepEqual(withoutReceiver.transactions.map((t) => [t.activity.activityType, t.activity.isExternal ?? ""]), [["BUY", ""], ["TRANSFER_OUT", true]]);
    const withoutGiver = map(twoFolios([purchase, giftOut()], [giftIn()]), {
      target: (f, s) => (f.folio === GIVER ? undefined : input().target(f, s)),
    });
    assert.deepEqual(withoutGiver.transactions.map((t) => [t.activity.activityType, t.activity.isExternal]), [["TRANSFER_IN", true]]);
    assert.deepEqual(messages(withoutGiver).slice(1), [[RECEIVER, false, RECEIVED]]);
  });

  test("when one side can't be imported, neither is", () => {
    const stamped = map(twoFolios([purchase, giftOut()], [giftIn(), charge("2024-06-03", "STAMP_DUTY_TAX", "0.15")]));
    const heldBack = map(twoFolios([purchase, giftOut()], [giftIn()], {}, { close: "1" }));
    const noHistory = map(twoFolios([giftOut()], [giftIn()], { open: "1000" }), {
      target: (f, s) => ({ ...input().target(f, s), openingCovered: f.folio !== GIVER }),
    });
    for (const mapping of [stamped, heldBack, noHistory]) {
      assert.ok(!mapping.transactions.some((t) => t.activity.activityType.startsWith("TRANSFER_")));
      assert.equal(mapping.warnings.filter((w) => w.message === OTHER_SIDE).length, 1);
    }
  });

  test("both sides confirmed as different Wealthfolio funds are left out", () => {
    const message = "The two sides of this gift are confirmed as different Wealthfolio assets, so neither side is imported. Confirm the same fund for both under Funds.";
    for (const oneAccount of [false, true]) {
      const mapping = map(twoFolios([purchase, giftOut()], [giftIn()]), {
        target: (f, s) => {
          const t = input().target(f, s);
          return {
            ...t,
            accountId: oneAccount ? "account-1" : t.accountId,
            asset: f.folio === RECEIVER ? { ...t.asset, symbol: "OTHER" } : t.asset,
          };
        },
      });
      assert.deepEqual(mapping.transactions.map((t) => t.activity.activityType), ["BUY"]);
      assert.deepEqual(messages(mapping), [[GIVER, true, message], [RECEIVER, true, message]]);
    }
  });
});

test("rows #1 leaves for later are warnings; event-only rows are skipped", () => {
  const mapping = map(
    statement(
      scheme("A", [
        tx("2024-01-10", "GIFT_IN", "1000.00", "100.000", "10.0000"),
        charge("2024-01-10", "STAMP_DUTY_TAX", "0.15"),
        tx("2024-02-10", "SEGREGATION", null, "100.000"),
        tx("2024-03-10", "UNKNOWN", "0.00", "0.000"),
        tx("2024-04-10", "MISC", "50.00"),
        tx("2024-05-10", "MISC", null),
      ]),
    ),
  );
  assert.deepEqual(
    mapping.warnings.map((w) => [w.rows.map((row) => row.type), w.message]),
    [
      [["GIFT_IN", "STAMP_DUTY_TAX"], "This gift has stamp duty on its day, which a transfer can't carry without a cash movement the statement doesn't show, so it isn't imported."],
      [["SEGREGATION"], "Segregated portfolios aren't imported yet."],
      [["UNKNOWN"], "casparser couldn't tell what this row is, so it isn't imported."],
      [["MISC"], "casparser couldn't tell what this row is, so it isn't imported."],
    ],
  );
});

test("units moved without a payment are warnings, whatever casparser calls them", () => {
  const mapping = map(
    statement(
      scheme("A", [
        // casparser#88: a bonus row prints units but no amount or NAV, and comes out as a purchase.
        tx("2024-01-10", "PURCHASE", null, "10.000", null, { description: "Bonus" }),
        tx("2024-02-10", "REDEMPTION", "0.00", "-5.000", "10.0000"),
        tx("2024-03-10", "SWITCH_IN", null, "10.000"),
      ], { open: "5.000" }),
    ),
  );
  assert.deepEqual(summary(mapping), {
    rows: [],
    warnings: [
      "Units added without a payment, such as bonus units or a transmission, aren't imported yet.",
      "Units removed without a payment, such as a transmission or a move to another folio, aren't imported yet.",
      "This row has no amount, or one with the wrong sign.",
    ],
  });
});

test("a row that prints only a balance is skipped unless the balance changes", () => {
  const bought = tx("2024-01-10", "PURCHASE", "1000.00", "100.000", "10.0000", { balance: "100.000" });
  const restated = (balance) => tx("2024-02-10", "MISC", null, null, null, { description: "Transmission", balance });
  assert.deepEqual(summary(map(statement(scheme("A", [bought, restated("100.000")])))).warnings, []);
  assert.deepEqual(summary(map(statement(scheme("A", [bought, restated("150.000")])))), {
    rows: [["BUY", "", "100.000", "1000", "", "DEPOSIT"]],
    warnings: ["This row changes the unit balance from 100 to 150 without listing any units, so it isn't imported."],
  });
  // Without an earlier balance, the units held count from the opening balance.
  assert.deepEqual(summary(map(statement(scheme("A", [restated("10.000")])))).warnings, [
    "This row changes the unit balance from 0 to 10 without listing any units, so it isn't imported.",
  ]);
  assert.ok(closedScheme(scheme("A", [restated("0.000")])));
  assert.ok(!closedScheme(scheme("A", [restated("10.000"), { ...restated("0.000"), date: "2024-03-10" }])));
});

test("balance-only rows do not compete for charges, including before the first printed balance", () => {
  const bought = tx("2024-01-10", "PURCHASE", "1000.00", "100.000", "10.0000");
  const stamp = charge("2024-01-10", "STAMP_DUTY_TAX", "0.05");
  const unchanged = tx("2024-01-10", "MISC", null, null, null, { balance: "105.000" });
  const restated = { ...unchanged, balance: "150.000" };
  const mapping = map(statement(scheme("A", [bought, stamp, unchanged, restated], { open: "5.000" })));
  assert.deepEqual(mapping.transactions.map((t) => t.rows), [[bought, stamp]]);
  assert.deepEqual(mapping.warnings.map((w) => w.rows), [[restated]]);
  assert.deepEqual(summary(mapping), {
    rows: [["BUY", "", "100.000", "1000.05", "0.05", "DEPOSIT"]],
    warnings: ["This row changes the unit balance from 105 to 150 without listing any units, so it isn't imported."],
  });
});

test("explicitly rejected instructions without unit movement are skipped", () => {
  for (const [type, units] of [["UNKNOWN", "0"], ["MISC", null]]) {
    const descriptions = ["SIP Rejected - insufficient funds", "Purchase rejection", "Payment dishonoured", "Insufficient balance", "Payment not received"];
    const mapping = map(statement(scheme("A", descriptions.map((description) =>
      tx("2024-01-10", type, "1000", units, null, { description }),
    ))));
    assert.deepEqual(mapping, { transactions: [], warnings: [] });
  }
});

test("a scheme without units at either end is closed when its rows record nothing", () => {
  const nominee = tx("2024-05-10", "MISC", null);
  const rejected = tx("2024-01-10", "UNKNOWN", "1000", "0", null, { description: "SIP Rejected - insufficient funds" });
  assert.ok(closedScheme(scheme("A", [])));
  assert.ok(closedScheme(scheme("A", [nominee, rejected])));
  // Bought and sold within the statement, held throughout, or an unknown row: not closed.
  const bought = tx("2023-05-05", "PURCHASE", "1000.00", "100.000", "10.0000");
  const sold = tx("2024-05-05", "REDEMPTION", "-1100.00", "-100.000", "11.0000");
  assert.ok(!closedScheme(scheme("A", [bought, sold])));
  assert.ok(!closedScheme(scheme("A", [], { open: "100.000", close: "100.000" })));
  assert.ok(!closedScheme(scheme("A", [tx("2024-04-10", "MISC", "50.00")])));
});

test("withoutClosed drops closed schemes and the folios they leave empty", () => {
  const [folio] = statement().folios;
  const data = {
    ...statement(),
    folios: [
      { ...folio, folio: "F1", schemes: [scheme("A", []), scheme("B", [], { open: "100.000", close: "100.000" })] },
      { ...folio, folio: "F2", schemes: [scheme("C", [tx("2024-05-10", "MISC", null)])] },
    ],
  };
  assert.deepEqual(
    withoutClosed(data).folios.map((f) => [f.folio, f.schemes.map((s) => s.scheme)]),
    [["F1", ["B"]]],
  );
  assert.equal(data.folios[0].schemes.length, 2);
});

test("scientific decimal strings from casparser are sent as printed and computed exactly", () => {
  const mapping = map(statement(scheme("A", [
    tx("2024-01-10", "PURCHASE", "0.01", "1E-7", "100000"),
  ], { open: "0E-8" })));
  assert.deepEqual(mapping.warnings, []);
  assert.equal(mapping.transactions[0].activity.quantity, "1E-7");
  assert.equal(mapping.transactions[0].activity.amount, "0.01");
});

describe("bank account", () => {
  const banked = (folio, s) => ({ ...input().target(folio, s), bankAccountId: "bank-1" });
  const types = ({ transactions }) =>
    transactions.map(({ activity, cash, bank }) =>
      [activity.activityType, cash?.activityType, bank && `${bank.activityType} ${bank.accountId}`].filter(Boolean).join(" "),
    );

  test("purchases, redemptions and payouts are transfers between the bank and fund accounts", () => {
    const mapping = map(
      statement(
        scheme("A", [
          tx("2024-01-10", "PURCHASE_SIP", "1000.00", "100.000", "10.0000", { balance: "100.000" }),
          tx("2024-02-10", "PURCHASE", "1000.00", "100.000", "10.0000", { balance: "200.000" }),
          tx("2024-03-10", "REDEMPTION", "-500.00", "-50.000", "10.0000", { balance: "150.000" }),
          tx("2024-04-10", "DIVIDEND_PAYOUT", "150.00", null, null, { dividend_rate: "1.00" }),
          tx("2024-05-10", "DIVIDEND_REINVEST", "150.00", "15.000", "10.0000"),
        ]),
      ),
      { target: banked },
    );
    assert.deepEqual(types(mapping), [
      "BUY TRANSFER_IN TRANSFER_OUT bank-1",
      "BUY TRANSFER_IN TRANSFER_OUT bank-1",
      "SELL TRANSFER_OUT TRANSFER_IN bank-1",
      "DIVIDEND TRANSFER_OUT TRANSFER_IN bank-1",
      "DIVIDEND",
    ]);
    const lines = mapping.transactions.flatMap((t) => [t.activity, t.cash, t.bank].filter(Boolean).map((row) => row.lineNumber));
    assert.deepEqual(lines, lines.map((_, i) => i + 1));
  });

  test("switches keep the fund house's money in the fund account, and mergers have no cash", () => {
    const mapping = map(
      statement(
        scheme("A", [tx("2024-06-20", "SWITCH_OUT", "-1000.00", "-100.000", "10.0000"), tx("2024-08-01", "SWITCH_OUT_MERGER", "-500.00", "-50.000", "10.0000")]),
        scheme("B", [tx("2024-06-20", "SWITCH_IN", "1000.00", "50.000", "20.0000"), tx("2024-08-01", "SWITCH_IN_MERGER", "500.00", "25.000", "20.0000")]),
      ),
      { target: banked },
    );
    // An investor's switch is a sale and a purchase.
    assert.deepEqual(types(mapping), ["SELL WITHDRAWAL", "ADJUSTMENT", "BUY DEPOSIT"]);
    assert.deepEqual(mapping.transactions[0].earlier, undefined);
    assert.equal(mapping.transactions[1].arriving.activity.subtype, "CONVERSION_IN");
    const lines = mapping.transactions.flatMap((t) =>
      [t.activity, t.cash, t.bank, t.arriving?.activity].filter(Boolean).map((row) => row.lineNumber),
    );
    assert.deepEqual(lines, lines.map((_, i) => i + 1));
  });
});

const units = (activity) =>
  activity.activityType === "SELL" ? sub(dec("0"), dec(activity.quantity)) : dec(activity.quantity ?? "0");

describe("the made-up statement", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));

  test("maps every row, ending each scheme at its closing balance", () => {
    const mapping = map(data);
    assert.deepEqual(mapping.warnings, []);
    assert.equal(mapping.transactions.length, 39);
    const lineNumbers = mapping.transactions.flatMap((t) => [t.activity, t.cash].filter(Boolean).map((row) => row.lineNumber));
    assert.deepEqual(lineNumbers, lineNumbers.map((_, i) => i + 1));
    for (const s of data.folios.flatMap((f) => f.schemes)) {
      const held = mapping.transactions
        .filter((t) => t.scheme === s.scheme)
        .reduce((sum, t) => add(sum, units(t.activity)), dec(s.open));
      assert.equal(cmp(held, dec(s.close)), 0, s.scheme);
    }
  });

  test("leaves out the fund whose opening units have no history", () => {
    const mapping = map(data, { target: (folio, s) => ({ ...input().target(folio, s), openingCovered: false }) });
    assert.deepEqual(
      mapping.warnings.map((w) => w.scheme),
      ["Fictiva Flexi Cap Fund - Direct Plan - Growth"],
    );
    assert.equal(mapping.transactions.length, 13);
  });

  test("its closed schemes need no account or fund", () => {
    const closed = data.folios.flatMap((f) => f.schemes).filter(closedScheme).map((s) => s.scheme);
    assert.deepEqual(closed, ["Fictiva Midcap Fund - Direct Plan - Growth", "Testbridge Gilt Fund - Direct Plan - Growth"]);
    const open = withoutClosed(data);
    assert.equal(open.folios.flatMap((f) => f.schemes).length, 5);
    assert.equal(map(open).transactions.length, 39);
  });

  test("amounts are units × NAV ± charges, within the units' rounding of the statement", () => {
    const rows = Object.fromEntries(
      map(data).transactions.map(({ activity: a }) => [`${a.date} ${a.symbol}`, [a.quantity ?? "", a.unitPrice ?? "", a.amount, a.tax ?? ""]]),
    );
    assert.deepEqual(rows["2023-04-10 INFZ90K01FC8"], ["103.088", "48.5000", "5000.018", "0.25"]);
    assert.deepEqual(rows["2024-01-15 INFZ90K01FC8"], ["200.000", "57.2214", "11444.17", "0.11"]);
    // ₹1.15 above the ₹25,000 paid; half of 0.001 units at this NAV is ₹1.28.
    assert.deepEqual(rows["2023-05-05 INFZ90K01LQ6"], ["9.747", "2564.8812", "25001.1470564", "1.25"]);
    assert.deepEqual(rows["2023-09-25 INFZ90K01BA1"], ["84.054", "15.6145", "1312.461183", "0.07"]);
    assert.deepEqual(rows["2023-12-28 INFZ91T01CB6"], ["", "", "7276.48", "808.5"]);
    assert.deepEqual(rows["2025-03-10 TONDG"], ["6.250", "1306.9834", "8168.64625", ""]);
  });
});

describe("the made-up statement without a Price column", async () => {
  // casparser gives each trade amount ÷ units as its NAV, and doesn't say so (#90).
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-no-price.json", "utf8"));
  const printed = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));

  test("maps the same rows as with its NAVs printed, but at amount ÷ units", () => {
    const mapping = map(data);
    assert.deepEqual(mapping.warnings, []);
    const withoutPrices = ({ activity, cash }) => {
      const { unitPrice, amount, ...rest } = activity;
      return [rest, cash && { ...cash, amount: undefined }];
    };
    assert.deepEqual(mapping.transactions.map(withoutPrices), map(printed).transactions.map(withoutPrices));
    for (const { activity, rows } of mapping.transactions) assert.equal(activity.unitPrice, rows[0].nav ?? undefined);
  });

  test("values before charges stay within the units' rounding of the statement's amounts", () => {
    const { transactions } = map(data);
    for (const { activity, rows: [row] } of transactions.filter(({ activity }) => activity.unitPrice)) {
      const nav = dec(activity.unitPrice);
      const off = abs(sub(mul(dec(activity.quantity), nav), abs(dec(row.amount))));
      assert.ok(cmp(off, mul(mul(nav, dec("0.5")), dec("0.001"))) <= 0, `${row.date} ${row.amount}`);
    }
    const rows = Object.fromEntries(
      transactions.map(({ activity: a }) => [`${a.date} ${a.symbol}`, [a.quantity ?? "", a.unitPrice ?? "", a.amount, a.tax ?? ""]]),
    );
    assert.deepEqual(rows["2023-04-10 INFZ90K01FC8"], ["103.088", "48.4998", "4999.9973824", "0.25"]);
    // ₹25,000 paid; the printed NAV, 2564.8812, gives ₹25,001.15.
    assert.deepEqual(rows["2023-05-05 INFZ90K01LQ6"], ["9.747", "2564.7635", "24999.9998345", "1.25"]);
    assert.deepEqual(rows["2025-03-10 TONDG"], ["6.250", "1306.9840", "8168.65", ""]);
  });
});

describe("rows that don't add up to the closing balance", async () => {
  // The made-up statement without one of the Flexi Cap fund's purchases.
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-mismatch.json", "utf8"));
  const flexi = data.folios[0].schemes[0];
  const anyway = { target: (folio, s) => ({ ...input().target(folio, s), importUnbalanced: true }) };
  const gap =
    "The rows take the unit balance from 1250 to 2798.066, but the statement's closing balance is 2892.104, 94.038 units apart: a row was probably dropped or misread.";

  test("leave out the fund's rows, with both figures", () => {
    const mapping = map(data);
    assert.equal(mapping.transactions.length, 13);
    assert.ok(mapping.transactions.every((t) => t.scheme !== flexi.scheme));
    // The removed purchase's stamp duty is part of the gap, so it gets no warning of its own.
    assert.deepEqual(
      mapping.warnings.map((w) => [w.scheme, w.folio, w.rows, w.leftOut, w.unbalanced, w.message]),
      [[
        "Fictiva Flexi Cap Fund - Direct Plan - Growth",
        "91234567 / 12",
        [],
        true,
        true,
        `${gap} None of this fund's rows are imported. Tick "Import this fund anyway" to list them below and check them against the PDF.`,
      ]],
    );
  });

  test("the user can import them anyway, with a caveat", () => {
    const mapping = map(data, anyway);
    const rows = mapping.transactions.filter((t) => t.scheme === flexi.scheme);
    assert.equal(rows.length, 25);
    assert.equal(mapping.transactions.length, 38);
    assert.equal(format(rows.reduce((sum, t) => add(sum, units(t.activity)), dec(flexi.open))), flexi.close_calculated);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.leftOut, w.unbalanced ?? false, w.message]),
      [
        [false, true, `${gap} Its rows are imported anyway: check them against the PDF, and after importing add or correct the missing rows in Wealthfolio.`],
        [true, false, "There's no transaction on this day to add this stamp duty to."],
      ],
    );
  });

  test("they add up within casparser's 0.005 units", () => {
    const purchase = tx("2024-01-10", "PURCHASE", "1000.00", "100.000", "10.0000");
    for (const [close, apart] of [["100.005", ""], ["99.995", ""], ["100.006", "0.006"], ["99.994", "0.006"]]) {
      const mapping = map(statement(scheme("A", [purchase], { close, close_calculated: "100.000" })));
      assert.equal(mapping.transactions.length, apart ? 0 : 1, close);
      assert.deepEqual(
        mapping.warnings.map((w) => w.message.split(":")[0]),
        apart ? [`The rows take the unit balance from 0 to 100, but the statement's closing balance is ${close}, ${apart} units apart`] : [],
        close,
      );
    }
  });

  test("a fund left out still says how to correct earlier imports", () => {
    const purchase = tx("2024-01-10", "PURCHASE_SIP", "999.95", "99.995", "10.0000");
    const reversal = tx("2024-01-15", "REVERSAL", "-999.95", "-99.995", "10.0000");
    const orphan = tx("2024-02-15", "REVERSAL", "-300.00", "-30.000", "10.0000");
    const redemption = tx("2024-04-01", "REDEMPTION", "-500.00", "-50.000", "10.0000");
    const putBack = tx("2024-04-05", "PURCHASE", "500.00", "50.000", "10.0000");
    const gift = tx("2024-05-01", "GIFT_IN", "0", "10.000");
    const rows = [purchase, reversal, orphan, redemption, putBack, gift];
    const mapping = map(statement(scheme("A", rows, { close: "1" })), {
      alreadyImported: (activity) => activity.activityType === "BUY" || activity.activityType === "SELL",
    });
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.rows.map((row) => row.date), w.leftOut, w.unbalanced ?? false]),
      [
        [[], true, true],
        [["2024-01-10", "2024-01-15"], true, false],
        [["2024-02-15"], true, false],
        [["2024-04-01", "2024-04-05"], true, false],
      ],
    );
    assert.match(mapping.warnings[1].message, /^Wealthfolio has this purchase from an earlier import, but the statement reverses it\. Delete/);
    assert.match(mapping.warnings[2].message, /^This reversal's purchase isn't in the statement/);
    assert.match(mapping.warnings[3].message, /Wealthfolio has the sale or its cash from an earlier import/);
  });

  test("a merger's other half is left out with the fund", () => {
    const out = tx("2024-08-01", "SWITCH_OUT_MERGER", "-1000.00", "-100.000", "10.0000");
    const into = tx("2024-08-01", "SWITCH_IN_MERGER", "1000.00", "50.000", "20.0000");
    const mapping = map(statement(scheme("A", [out], { close: "1" }), scheme("B", [into])));
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.scheme, w.unbalanced ?? false]),
      [["A", true], ["B", false]],
    );
    assert.equal(mapping.warnings[1].message, "The other half of this merger can't be imported, so neither half is.");
  });
});

test("decimals drop trailing zeros and read exponents exactly", () => {
  assert.equal(format(dec("-0.050")), "-0.05");
  assert.equal(format(dec("1.25E+3")), "1250");
  assert.equal(format(dec("-1.25e-3")), "-0.00125");
});
