// Which mapped transactions the import sends, checked against activities as Wealthfolio's
// `activities.getAll` returns them. Wealthfolio's own checks are faked: the real ones run in
// the throwaway-server test described in the pull request.
import assert from "node:assert/strict";
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
  importRows,
  indexActivities,
  linkBankRow,
  localDay,
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
/** How Wealthfolio stores and returns an imported row (Wealthfolio 3.11.0's web API). */
const stored = (row) => {
  if (row.symbol) profiles.set(`uuid-${row.symbol}`, fundRef(row.symbol, row.exchangeMic));
  return {
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
  };
};

/** `activity` moved to another asset, with its own profile. */
const otherFund = (activity, symbol = "OTHER") => {
  profiles.set(`uuid-${symbol}`, fundRef(symbol, "XBOM"));
  return { ...activity, assetId: `uuid-${symbol}`, assetSymbol: symbol };
};

const plan = (data, existing = [], errors = {}, bankAccountId = undefined, funds = fundsOf(data)) => {
  const mapping = map(data, existing, bankAccountId, funds);
  return planImport(mapping, existing, check(rowsOf(mapping), errors), funds);
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
    const [t] = banked(statement(scheme("A", sip("2023-04-10"))));
    const calls = [];
    const api = {
      create: async (a) => (calls.push(["create", a]), { id: "fund-leg" }),
      update: async (a) => void calls.push(["update", a]),
      linkTransfer: async (a, b) => void calls.push(["link", a, b]),
    };
    const withdrawal = bankRow("WITHDRAWAL", "5000.00", "2023-04-08");
    assert.equal(await linkBankRow(api, t, withdrawal), undefined);
    assert.deepEqual(calls, [
      ["create", { accountId: "account-1", activityType: "TRANSFER_IN", activityDate: "2023-04-10", amount: "5000.018", currency: "INR", idempotencyKey: `cas-importer-bank:${withdrawal.id}` }],
      ["update", { id: withdrawal.id, accountId: BANK, activityType: "TRANSFER_OUT", activityDate: withdrawal.date, currency: "INR", comment: "ACH D- FUND HOUSE" }],
      ["link", withdrawal.id, "fund-leg"],
    ]);
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
