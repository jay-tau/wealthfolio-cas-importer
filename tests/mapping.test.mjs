// The mapping from casparser's JSON to Wealthfolio import rows, on made-up statements.
// Cases that need Wealthfolio's own duplicate check belong with the import screen (#11).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { add, cmp, dec, format, mul, neg, sub } from "../src/cas/decimal.ts";
import { mapStatement } from "../src/cas/mapping.ts";

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
function checkRows({ activity, cash }) {
  for (const row of [activity, cash].filter(Boolean)) {
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
    return;
  }
  const direction = { BUY: "DEPOSIT", SELL: "WITHDRAWAL", DIVIDEND: "WITHDRAWAL" }[activity.activityType];
  assert.equal(cash.activityType, direction);
  assert.equal(cash.accountId, activity.accountId);
  assert.equal(cash.date, activity.date);
  assert.equal(cash.symbol, "");
  assert.equal(cash.amount, activity.amount, "the pair nets to zero");
  const cashEffect = cash.activityType === "DEPOSIT" ? dec(cash.amount) : neg(dec(cash.amount));
  assert.equal(cmp(add(effect, cashEffect), dec("0")), 0, "signed host cash nets to zero");
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
    const asked = [];
    const mapping = map(statement(scheme("A", [purchase, reversal])), {
      alreadyImported: (activity) => (asked.push(activity.activityType), activity.activityType === "BUY"),
    });
    assert.deepEqual(asked, ["BUY"]);
    assert.deepEqual(mapping.transactions, []);
    assert.match(mapping.warnings[0].message, /^Wealthfolio has this purchase from an earlier import, but the statement reverses it\. Delete/);
  });

  test("a reversal without its purchase, or with more than one candidate, is a warning", () => {
    assert.deepEqual(summary(map(statement(scheme("A", [reversal])))).warnings, [
      "This reversal's purchase isn't in the statement, so the reversal isn't imported. If Wealthfolio has that purchase, delete it and its deposit.",
    ]);
    const twice = summary(map(statement(scheme("A", [purchase, { ...purchase, date: "2024-01-11" }, reversal]))));
    assert.equal(twice.rows.length, 2);
    assert.match(twice.warnings[0], /^2 purchases in the statement could be the one this reverses/);
  });

  test("a reversal with contradictory or missing amounts does not cancel a purchase", () => {
    for (const amount of ["-2000.00", null]) {
      const mapping = map(statement(scheme("A", [purchase, { ...reversal, amount }])));
      assert.equal(mapping.transactions.length, 1);
      assert.equal(mapping.transactions[0].rows[0], purchase);
      assert.match(mapping.warnings[0].message, /purchase isn't in the statement/);
    }
  });
});

describe("mergers", () => {
  const out = tx("2024-08-01", "SWITCH_OUT_MERGER", "-1000.00", "-100.000", "10.0000");
  const into = tx("2024-08-01", "SWITCH_IN_MERGER", "1000.00", "50.000", "20.0000");

  test("a matched merger is imported like a switch, with a caveat", () => {
    const mapping = map(statement(scheme("A", [out]), scheme("B", [into])));
    assert.deepEqual(summary(mapping).rows, [
      ["SELL", "", "100.000", "1000", "", "WITHDRAWAL"],
      ["BUY", "", "50.000", "1000", "", "DEPOSIT"],
    ]);
    assert.deepEqual(
      mapping.warnings.map((w) => [w.scheme, w.leftOut]),
      [["A", false], ["B", false]],
    );
  });

  test("a merger without its other half is left out", () => {
    const mapping = map(statement(scheme("A", [out])));
    assert.deepEqual(summary(mapping), {
      rows: [],
      warnings: ["Can't match this merger with its other half: the folio has 1 merger sales and 0 merger purchases on this day."],
    });
  });

  test("when one half can't be imported, neither is", () => {
    const mapping = map(statement(scheme("A", [out]), scheme("B", [into])), {
      target: (folio, s) => (s.scheme === "B" ? undefined : input().target(folio, s)),
    });
    assert.deepEqual(mapping.transactions, []);
    assert.deepEqual(
      mapping.warnings.map((w) => w.message),
      [
        "The other half of this merger can't be imported, so neither half is.",
        "No Wealthfolio account or fund is chosen for this scheme, so its transactions are left out.",
      ],
    );
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
      [["GIFT_IN", "STAMP_DUTY_TAX"], "Gifts aren't imported yet."],
      [["SEGREGATION"], "Segregated portfolios aren't imported yet."],
      [["UNKNOWN"], "casparser couldn't tell what this row is, so it isn't imported."],
      [["MISC"], "casparser couldn't tell what this row is, so it isn't imported."],
    ],
  );
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

test("scientific decimal strings from casparser are sent as printed and computed exactly", () => {
  const mapping = map(statement(scheme("A", [
    tx("2024-01-10", "PURCHASE", "0.01", "1E-7", "100000"),
  ], { open: "0E-8" })));
  assert.deepEqual(mapping.warnings, []);
  assert.equal(mapping.transactions[0].activity.quantity, "1E-7");
  assert.equal(mapping.transactions[0].activity.amount, "0.01");
});

describe("the made-up statement", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const units = (activity) =>
    activity.activityType === "SELL" ? sub(dec("0"), dec(activity.quantity)) : dec(activity.quantity ?? "0");

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

test("decimals drop trailing zeros and read exponents exactly", () => {
  assert.equal(format(dec("-0.050")), "-0.05");
  assert.equal(format(dec("1.25E+3")), "1250");
  assert.equal(format(dec("-1.25e-3")), "-0.00125");
});
