// What reusing a bank account's entry for a fund's cash changes in it, checked against a fake of
// Wealthfolio 3.13.0's Spending: its settings, its search of cash activities in accounts in
// Spending, and removing a category.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  entryNotes,
  OUTSIDE_SPENDING,
  outsideSpending,
  readEntryFacts,
  recheckEntries,
  recheckLink,
  reuseBankEntry,
} from "../src/cas/bank-entries.ts";
import { mapStatement } from "../src/cas/mapping.ts";
import { fundRefs, indexActivities, planImport, rowsOf } from "../src/cas/plan.ts";

const ACCOUNT = "account-1";
const BANK = "bank-1";

const tx = (date, type, amount, units = null, nav = null) =>
  ({ date, description: type, amount, units, nav, balance: null, type, dividend_rate: null, gift_folio: null });
const statement = (transactions) => ({
  statement_period: { from: "01-Apr-2023", to: "31-Mar-2025" },
  folios: [{
    folio: "F1", amc: "Made-up Mutual Fund", name: null, PAN: "ABCDE1234F", KYC: null, PANKYC: null,
    schemes: [{
      scheme: "A", advisor: "DIRECT", rta_code: "A", rta: "CAMS", type: "N/A", isin: "INF-A", amfi: null, nominees: [],
      open: "0", close: "0", close_calculated: "0", valuation: { date: "2025-03-31", nav: "10", cost: null, value: "0" }, transactions,
    }],
  }],
  investor_info: { name: "", email: "", address: "", mobile: "" },
  cas_type: "DETAILED",
  file_type: "CAMS",
  parse_warnings: [],
});

const asset = { symbol: "a", exchangeMic: "XBOM", quoteCcy: "INR", instrumentType: "MUTUALFUND" };
/** A new transaction with its cash to and from the bank account. */
const transaction = (transactions) => {
  const data = statement(transactions);
  const funds = fundRefs([asset], new Map());
  const mapping = mapStatement(data, {
    target: () => ({ accountId: ACCOUNT, asset, openingCovered: true, bankAccountId: BANK }),
    alreadyImported: indexActivities([], funds).has,
  });
  const [t] = planImport(mapping, [], rowsOf(mapping).map((row) => ({ ...row })), funds);
  assert.equal(t.status, "new");
  return t;
};
// ₹5,000 paid on 2023-04-10, the printed ₹4,999.75 and ₹0.25 stamp duty; ₹3,000 paid in on 2023-06-01.
const purchase = transaction([tx("2023-04-10", "PURCHASE_SIP", "4999.75", "103.088", "48.5000"), tx("2023-04-10", "STAMP_DUTY_TAX", "0.25")]);
const sale = transaction([tx("2023-06-01", "REDEMPTION", "-3000.00", "-61.000", "49.1803")]);

let id = 0;
/** A bank entry as Wealthfolio's `activities.getAll` returns it. */
const entry = (activityType, amount, date, extra = {}) => ({
  id: `entry-${++id}`, accountId: BANK, activityType, subtype: null, status: "POSTED", date: `${date}T00:00:00+00:00`,
  quantity: null, unitPrice: null, amount, fee: null, currency: "INR", needsReview: false, comment: "ACH D- FUND HOUSE",
  assetId: "", assetSymbol: "", isUserModified: false, ...extra,
});
const split = (activityId, categoryId, taxonomyId = "spending_categories") =>
  ({ id: `split-${++id}`, activityId, taxonomyId, categoryId, amount: "1", sortOrder: 0, createdAt: "", updatedAt: "" });
const assignment = (activityId, taxonomyId, categoryId = "category") =>
  ({ id: `assignment-${++id}`, activityId, taxonomyId, categoryId, weight: 1, source: "manual", createdAt: "", updatedAt: "" });

const CASH = ["DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "FEE", "TAX", "INTEREST", "CREDIT"];

/**
 * Wealthfolio 3.13.0's Spending: a search returns nothing outside `accountIds`, or with Spending off,
 * filters by type, inclusive dates and absolute amounts, newest first, `pageSize` a page (50 by
 * default). Removing a category is refused outside Spending.
 */
function spendingApi({ enabled = true, accountIds = [BANK], rows = [], splits = [], assignments = [], pageSize = 50, fail = {} } = {}) {
  const calls = [];
  const time = (date) => new Date(date).getTime();
  const api = {
    calls,
    getContext: async () => {
      calls.push(["getContext"]);
      if (fail.context) throw new Error("no settings");
      return { enabled, accountIds, excludedCategoryIds: [] };
    },
    searchCashActivities: async (request) => {
      calls.push(["search", request]);
      if (fail.search) throw new Error("no search");
      const scope = enabled ? accountIds : [];
      const items = rows
        .filter((a) => scope.includes(a.accountId) && (request.accountIds ?? scope).includes(a.accountId) &&
          (request.activityTypes ?? CASH).includes(a.activityType) &&
          (!request.startDate || time(a.date) >= time(request.startDate)) && (!request.endDate || time(a.date) <= time(request.endDate)) &&
          (request.minAmount === undefined || Math.abs(Number(a.amount)) >= request.minAmount) &&
          (request.maxAmount === undefined || Math.abs(Number(a.amount)) <= request.maxAmount))
        .sort((a, b) => time(b.date) - time(a.date));
      const offset = request.offset ?? 0;
      return {
        items: items.slice(offset, offset + (request.limit ?? pageSize)).map((a) => ({
          ...a, splits: splits.filter((s) => s.activityId === a.id), assignments: assignments.filter((s) => s.activityId === a.id),
        })),
        totalCount: items.length,
      };
    },
    unassignCategory: async (activityId, kind) => {
      calls.push(["unassign", activityId, kind]);
      const row = rows.find((a) => a.id === activityId);
      if (!enabled || !accountIds.includes(row?.accountId)) throw new Error("Activity account is not opted into spending tracking");
      if (fail.unassign?.includes(kind)) throw new Error("refused");
    },
  };
  return api;
}

const accounts = [{ id: BANK, name: "Savings" }, { id: ACCOUNT, name: "Mutual funds" }];
/** Spending's reads, and Wealthfolio's accounts as `accounts.getAll(true)` lists them. */
const reads = (spending, list) => ({
  spending,
  accounts: { getAll: async (includeArchived) => (assert.equal(includeArchived, true), list) },
});
const synced = [{ id: BANK, name: "Savings", provider: "SNAPTRADE", providerAccountId: "connect-1" }];
const SYNCED = "Savings is synced. Once linked, later corrections to this entry from the sync won't change it.";
const UNKNOWN = [
  "Couldn't check whether this entry is split across spending categories; changing it into a transfer deletes any split.",
  "Couldn't check this entry's category; a spending or income one is removed, a savings one stays.",
];
const notes = (facts, row) => entryNotes(facts.get(row.id), "Savings");

describe("before an entry is offered", () => {
  test("with Spending off or the bank account outside it: no search, the note above the matches, the synced note still shown", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const transfer = entry("TRANSFER_OUT", "5000.00", "2023-04-09");
    for (const settings of [{ enabled: false }, { accountIds: ["other"] }]) {
      const spending = spendingApi({ ...settings, rows: [withdrawal, transfer], splits: [split(withdrawal.id, "food")] });
      const facts = await readEntryFacts(reads(spending, synced), [withdrawal, transfer]);
      assert.deepEqual(spending.calls, [["getContext"]]);
      assert.deepEqual(facts.get(withdrawal.id), { converts: true, inSpending: false, spending: undefined, synced: true });
      assert.deepEqual(notes(facts, withdrawal), [SYNCED]);
      assert.equal(outsideSpending(facts.get(withdrawal.id)), true);
      // A transfer keeps its type, so it keeps any split.
      assert.equal(outsideSpending(facts.get(transfer.id)), false);
      assert.deepEqual(notes(facts, transfer), [SYNCED]);
    }
    assert.equal(OUTSIDE_SPENDING, "Changing a withdrawal or deposit into a transfer deletes any split across spending categories, also one saved before Spending was turned off for its account.");
  });

  test("an entry with a split, one without, one found only on the second page, and splits that can't be read", async () => {
    const splitRow = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const plain = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const later = entry("WITHDRAWAL", "5000.02", "2023-04-12");
    const rows = [splitRow, plain, later, entry("WITHDRAWAL", "5000.01", "2023-04-11")];
    const splits = [split(splitRow.id, "food"), split(splitRow.id, "rent"), split(splitRow.id, "food")];
    const spending = spendingApi({ rows, splits, assignments: [assignment(splitRow.id, "spending_categories")], pageSize: 2 });
    const facts = await readEntryFacts(reads(spending, accounts), [splitRow, plain]);
    assert.deepEqual(notes(facts, splitRow), [
      "This entry is split across 2 spending categories. Changing it into a transfer deletes the split.",
      "Its spending category is removed: a transfer isn't spending.",
    ]);
    assert.deepEqual(notes(facts, plain), []);
    // One search for the account, a day and a paisa around the entries, read on until both are found.
    const searches = spending.calls.filter(([call]) => call === "search").map(([, request]) => request);
    assert.deepEqual(searches.map((r) => r.offset), [0, 2]);
    assert.deepEqual(searches[0], {
      accountIds: [BANK], activityTypes: ["DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT"],
      startDate: "2023-04-07T00:00:00.000Z", endDate: "2023-04-11T00:00:00.000Z", minAmount: 4999.99, maxAmount: 5000.01, offset: 0,
    });
    // Not returned, or not readable: unknown.
    const missing = entry("WITHDRAWAL", "5000.00", "2023-04-09");
    for (const options of [{ rows }, { rows: [missing], fail: { search: true } }]) {
      const unknown = await readEntryFacts(reads(spendingApi(options), accounts), [missing]);
      assert.deepEqual(unknown.get(missing.id), { converts: true, inSpending: true, spending: undefined, synced: false });
      assert.deepEqual(notes(unknown, missing), UNKNOWN);
    }
    // Without Spending's settings, nothing is searched, and neither the split nor the category is known.
    const noContext = spendingApi({ rows, splits, fail: { context: true } });
    const unknown = await readEntryFacts(reads(noContext, accounts), [splitRow]);
    assert.deepEqual(noContext.calls, [["getContext"]]);
    assert.deepEqual(unknown.get(splitRow.id).inSpending, undefined);
    assert.deepEqual(notes(unknown, splitRow), UNKNOWN);
    assert.equal(outsideSpending(unknown.get(splitRow.id)), false);
  });

  test("spending and income categories are noted, savings ones not, and an entry already a transfer has no notes about either", async () => {
    const deposit = entry("DEPOSIT", "3000.00", "2023-06-01");
    const savings = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const transfer = entry("TRANSFER_OUT", "5000.00", "2023-04-11");
    const spending = spendingApi({
      rows: [deposit, savings, transfer],
      splits: [split(deposit.id, "salary", "income_sources"), split(deposit.id, "bonus", "income_sources"), split(transfer.id, "food")],
      assignments: [
        assignment(deposit.id, "income_sources"), assignment(savings.id, "savings_categories"),
        assignment(transfer.id, "spending_categories"), assignment(savings.id, "custom_tags"),
      ],
    });
    const facts = await readEntryFacts(reads(spending, accounts), [deposit, savings, transfer]);
    assert.deepEqual(notes(facts, deposit), [
      "This entry is split across 2 income categories. Changing it into a transfer deletes the split.",
      "Its income category is removed: a transfer isn't income.",
    ]);
    assert.deepEqual(facts.get(savings.id).spending, { splitCategories: 0, splitKind: undefined, kinds: ["saving"] });
    assert.deepEqual(notes(facts, savings), []);
    assert.deepEqual(facts.get(transfer.id), {
      converts: false, inSpending: true, spending: { splitCategories: 1, splitKind: "expense", kinds: ["expense"] }, synced: false,
    });
    assert.deepEqual(notes(facts, transfer), []);
  });

  test("a synced bank account, and an entry it already doesn't correct", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const edited = entry("WITHDRAWAL", "5000.00", "2023-04-11", { isUserModified: true });
    const read = (list) => readEntryFacts(reads(spendingApi({ enabled: false }), list), [withdrawal, edited]);
    assert.deepEqual([...(await read(synced)).values()].map((f) => f.synced), [true, false]);
    assert.deepEqual([...(await read([{ id: BANK, name: "Savings", providerAccountId: "connect-1" }])).values()].map((f) => f.synced), [true, false]);
    assert.deepEqual([...(await read(accounts)).values()].map((f) => f.synced), [false, false]);
  });
});

describe("linking a ticked entry", () => {
  /** The add-on's activities calls, recorded. */
  const activitiesApi = (fail = "") => {
    const calls = [];
    const step = (name, result) => async (...args) => {
      calls.push([name, ...args]);
      if (fail === name) throw new Error("nope");
      return result;
    };
    return { calls, create: step("create", { id: "fund-leg" }), update: step("update"), linkTransfer: step("linkTransfer", []) };
  };
  const reuse = async ({ row, t = purchase, spending: options = {}, list = accounts, fail = "" }) => {
    const spending = spendingApi({ rows: [row], ...options });
    const facts = (await readEntryFacts(reads(spending, list), [row])).get(row.id);
    spending.calls.length = 0;
    const activities = activitiesApi(fail);
    const logged = [];
    const result = await reuseBankEntry({ activities, spending, logger: { warn: (message) => logged.push(message) } }, t, row, facts);
    return { result, steps: activities.calls.map(([name]) => name), unassigned: spending.calls.map(([, id, kind]) => [id, kind]), logged };
  };

  test("an entry changed into a transfer loses its split and its spending or income category, and keeps a savings one", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const spent = await reuse({
      row: withdrawal, list: synced,
      spending: { splits: [split(withdrawal.id, "food"), split(withdrawal.id, "rent")], assignments: [assignment(withdrawal.id, "spending_categories"), assignment(withdrawal.id, "savings_categories")] },
    });
    assert.deepEqual(spent.steps, ["create", "update", "linkTransfer"]);
    assert.deepEqual(spent.unassigned, [[withdrawal.id, "expense"]]);
    assert.deepEqual(spent.result, {
      error: undefined,
      stage: undefined,
      fundId: "fund-leg",
      converted: true,
      changes: [
        "Its split across 2 spending categories was deleted.",
        "Its spending category was removed.",
        "Later corrections to it from the sync won't change it.",
      ],
      warnings: [],
    });
    const deposit = entry("DEPOSIT", "3000.00", "2023-06-01");
    const earned = await reuse({ row: deposit, t: sale, spending: { assignments: [assignment(deposit.id, "income_sources")] } });
    assert.deepEqual(earned.unassigned, [[deposit.id, "income"]]);
    assert.deepEqual(earned.result.changes, ["Its income category was removed."]);
    const saved = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const kept = await reuse({ row: saved, spending: { assignments: [assignment(saved.id, "savings_categories")] } });
    assert.deepEqual([kept.unassigned, kept.result.changes], [[], []]);
  });

  test("an entry already a transfer keeps its split and categories", async () => {
    const transfer = entry("TRANSFER_OUT", "5000.00", "2023-04-10");
    const options = { splits: [split(transfer.id, "food")], assignments: [assignment(transfer.id, "spending_categories")] };
    const linked = await reuse({ row: transfer, spending: options });
    assert.deepEqual([linked.steps, linked.unassigned, linked.result.changes], [["create", "linkTransfer"], [], []]);
    // Linking marks it as edited, so a synced account stops correcting it.
    assert.deepEqual((await reuse({ row: transfer, spending: options, list: synced })).result.changes, ["Later corrections to it from the sync won't change it."]);
  });

  test("splits and categories that couldn't be read, and an entry outside Spending", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const unknown = await reuse({ row: withdrawal, spending: { fail: { search: true } } });
    assert.deepEqual(unknown.unassigned, [[withdrawal.id, "expense"], [withdrawal.id, "income"]]);
    assert.deepEqual(unknown.result.changes, ["Any split it had across spending categories was deleted.", "Any spending or income category it had was removed."]);
    // Outside Spending, Wealthfolio refuses to remove a category, and Spending doesn't count the entry.
    const outside = await reuse({ row: withdrawal, spending: { enabled: false } });
    assert.deepEqual(outside.unassigned, []);
    assert.deepEqual(outside.result.changes, ["Any split it had across spending categories was deleted."]);
    // Without Spending's settings, the add-on tries, and says when it couldn't.
    const noContext = await reuse({ row: withdrawal, spending: { accountIds: [], fail: { context: true } } });
    assert.deepEqual(noContext.unassigned, [[withdrawal.id, "expense"], [withdrawal.id, "income"]]);
    assert.deepEqual(noContext.result.changes, ["Any split it had across spending categories was deleted."]);
    assert.deepEqual(noContext.result.warnings, ["spending", "income"].map((word) =>
      `Couldn't remove its ${word} category, if it has one. A transfer isn't ${word}: remove it in Wealthfolio.`));
    assert.equal(noContext.logged.length, 2);
    assert.ok(noContext.logged.every((message) => message.includes("Activity account is not opted into spending tracking")));
  });

  test("a later step that fails: what changed before it is still said", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-10");
    const options = { splits: [split(withdrawal.id, "food")], assignments: [assignment(withdrawal.id, "spending_categories")] };
    // Changed into a transfer, not linked: its split is gone and it's marked as edited, and its category stays.
    const unlinked = await reuse({ row: withdrawal, spending: options, list: synced, fail: "linkTransfer" });
    assert.match(unlinked.result.error, /couldn't link it with the bank's row on 2023-04-10/);
    assert.deepEqual(unlinked.unassigned, []);
    assert.deepEqual(unlinked.result.changes, ["Its split across 1 spending category was deleted.", "Later corrections to it from the sync won't change it."]);
    const retained = (word, unknown = false) =>
      `Its ${word} category${unknown ? ", if it has one," : ""} wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio.`;
    assert.deepEqual(unlinked.result.warnings, [retained("spending")]);
    assert.deepEqual([unlinked.result.stage, unlinked.result.fundId, unlinked.result.converted], ["link", "fund-leg", true]);
    // A retry goes on from the link: the transfer isn't added again, nor the entry changed again, and
    // the category goes once they're linked.
    const facts = (await readEntryFacts(reads(spendingApi({ rows: [withdrawal], ...options }), synced), [withdrawal])).get(withdrawal.id);
    const spending = spendingApi({ rows: [withdrawal], ...options });
    const activities = activitiesApi("");
    const retried = await reuseBankEntry({ activities, spending, logger: { warn() {} } }, purchase, withdrawal, facts, { fundId: unlinked.result.fundId, converted: true });
    assert.deepEqual(activities.calls.map(([name]) => name), ["linkTransfer"]);
    assert.deepEqual(activities.calls[0].slice(1), [withdrawal.id, "fund-leg"]);
    assert.deepEqual(spending.calls.map(([, id, kind]) => [id, kind]), [[withdrawal.id, "expense"]]);
    assert.deepEqual([retried.stage, retried.warnings], [undefined, []]);
    // A category alone is still reported, including income and unreadable categories.
    const deposit = entry("DEPOSIT", "3000.00", "2023-06-01");
    for (const [row, t, spending, warnings] of [
      [withdrawal, purchase, { assignments: options.assignments }, [retained("spending")]],
      [deposit, sale, { assignments: [assignment(deposit.id, "income_sources")] }, [retained("income")]],
      [withdrawal, purchase, { fail: { search: true } }, [retained("spending", true), retained("income", true)]],
    ]) {
      const kept = await reuse({ row, t, spending, fail: "linkTransfer" });
      assert.deepEqual(kept.unassigned, []);
      assert.deepEqual(kept.result.warnings, warnings);
    }
    // Not changed: nothing to say.
    for (const fail of ["create", "update"]) {
      const { result } = await reuse({ row: withdrawal, spending: options, list: synced, fail });
      assert.ok(result.error);
      assert.deepEqual([result.changes, result.warnings], [[], []]);
    }
    // Linked, but its category stays: it counts as linked, with a warning.
    const kept = await reuse({ row: withdrawal, spending: { ...options, fail: { unassign: ["expense"] } } });
    assert.equal(kept.result.error, undefined);
    assert.deepEqual(kept.result.changes, ["Its split across 1 spending category was deleted."]);
    assert.deepEqual(kept.result.warnings, ["Couldn't remove its spending category. A transfer isn't spending: remove it in Wealthfolio."]);
    assert.match(kept.logged[0], /refused/);
  });
});

describe("right before importing", () => {
  const recheck = async ({ shownRows, nowRows, spendingThen = {}, spendingNow = spendingThen, linked = [], list = accounts, listThen = list }) => {
    const shown = await readEntryFacts(reads(spendingApi({ rows: shownRows, ...spendingThen }), listThen), shownRows);
    const fetched = [];
    const activities = {
      getAll: async (accountId) => (fetched.push(accountId), nowRows.filter((a) => a.accountId === accountId)),
      getTransferPair: async (id) => (linked.includes(id) ? {} : null),
    };
    const result = await recheckEntries(
      { activities, ...reads(spendingApi({ rows: nowRows, ...spendingNow }), list) },
      shownRows.map((row, i) => [[purchase, sale][i], row]),
      shown,
      (id) => list.find((a) => a.id === id).name,
    );
    return { ...result, fetched };
  };

  test("unchanged entries, or with an edited comment, are used as they are now", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const deposit = entry("DEPOSIT", "3000.00", "2023-06-01");
    const now = [{ ...withdrawal, comment: "Edited" }, deposit];
    const { current, stale, fetched } = await recheck({ shownRows: [withdrawal, deposit], nowRows: now, list: synced });
    assert.deepEqual(fetched, [BANK]);
    assert.deepEqual(stale, []);
    assert.equal(current.get(purchase), now[0]);
    assert.equal(current.get(sale), now[1]);
  });

  test("an entry gone, no longer matching, linked elsewhere, or with another type, amount or day stops the import", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const transfer = entry("TRANSFER_OUT", "5000.00", "2023-04-08");
    const reason = async (shown, now, linked) => {
      const { current, stale } = await recheck({ shownRows: [shown], nowRows: now ? [now] : [], linked });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].after, now);
      return [stale[0].reason, current.get(purchase)];
    };
    assert.deepEqual(await reason(withdrawal), ["gone", undefined]);
    assert.deepEqual(await reason(withdrawal, { ...withdrawal, amount: "4000.00" }), ["unmatched", undefined]);
    assert.deepEqual(await reason(transfer, transfer, [transfer.id]), ["linked", undefined]);
    // Still a match, but not as the preview showed it: offered as it is now.
    const retyped = { ...transfer, activityType: "WITHDRAWAL" };
    assert.deepEqual(await reason(transfer, retyped), ["changed", retyped]);
    const reamounted = { ...withdrawal, amount: "5000.02" };
    assert.deepEqual(await reason(withdrawal, reamounted), ["changed", reamounted]);
    const redated = { ...withdrawal, date: "2023-04-09T00:00:00+00:00" };
    assert.deepEqual(await reason(withdrawal, redated), ["changed", redated]);
  });

  test("a split or category that the notes didn't mention stops the import of an entry to be changed into a transfer, not of one already a transfer", async () => {
    const withdrawal = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const transfer = entry("TRANSFER_OUT", "5000.00", "2023-04-08");
    const added = (row) => ({ splits: [split(row.id, "food"), split(row.id, "rent")], assignments: [assignment(row.id, "spending_categories")] });
    const stopped = await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingNow: added(withdrawal) });
    assert.deepEqual(stopped.stale.map((s) => [s.reason, s.notes]), [[undefined, [
      "This entry is split across 2 spending categories. Changing it into a transfer deletes the split.",
      "Its spending category is removed: a transfer isn't spending.",
    ]]]);
    // The preview then shows those notes, and the next Import goes ahead.
    assert.deepEqual((await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingThen: added(withdrawal) })).stale, []);
    assert.deepEqual((await recheck({ shownRows: [transfer], nowRows: [transfer], spendingNow: added(transfer) })).stale, []);
    // Notes the preview gave cover the same facts now, and fewer facts need no new notes.
    assert.deepEqual((await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingThen: added(withdrawal) })).stale, []);
    assert.deepEqual((await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingThen: added(withdrawal), spendingNow: {} })).stale, []);
    // Unreadable now, though the preview read none: said again before importing.
    const unreadable = await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingNow: { fail: { search: true } } });
    assert.deepEqual(unreadable.stale[0].notes, UNKNOWN);
    // Taken out of Spending: any split saved before can't be read.
    const outside = await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], spendingNow: { enabled: false } });
    assert.deepEqual(outside.stale[0].notes, [OUTSIDE_SPENDING]);
    // An account synced since: said too; one no longer synced needs no note.
    const nowSynced = await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], listThen: accounts, list: synced });
    assert.deepEqual(nowSynced.stale.map((s) => s.notes), [[SYNCED]]);
    assert.deepEqual((await recheck({ shownRows: [withdrawal], nowRows: [withdrawal], listThen: synced, list: accounts })).stale, []);
    // Marked as edited since: the sync already leaves it alone.
    const edited = { ...withdrawal, isUserModified: true };
    assert.deepEqual((await recheck({ shownRows: [withdrawal], nowRows: [edited], list: synced })).stale, []);
  });
});

describe("before retrying a bank link", () => {
  const recheck = async ({ before, now = before, from = {}, fund, pair, fundPair, spendingThen = {}, spendingNow = spendingThen, fail = "" }) => {
    const shown = (await readEntryFacts(reads(spendingApi({ rows: [before], ...spendingThen }), accounts), [before])).get(before.id);
    const fetched = [];
    const paired = [];
    const api = {
      ...reads(spendingApi({ rows: now ? [now] : [], ...spendingNow }), accounts),
      activities: {
        getAll: async (accountId) => {
          fetched.push(accountId);
          if (fail === "rows") throw new Error("made-up row read failure");
          return [now, fund].filter((r) => r?.accountId === accountId);
        },
        getTransferPair: async (id) => {
          paired.push(id);
          if (fail === "pair") throw new Error("made-up pair read failure");
          return (id === before.id ? pair : fundPair) ?? null;
        },
      },
    };
    return { ...(await recheckLink(api, purchase, before, shown, from)), fetched, paired };
  };
  const fundRow = () => entry("TRANSFER_IN", String(purchase.transaction.cash.amount), "2023-04-10", { id: "fund-leg", accountId: ACCOUNT });

  test("unchanged entries resume from the saved transfer and conversion", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const untouched = await recheck({ before });
    assert.equal(untouched.row, before);
    assert.equal(untouched.linked, false);
    assert.deepEqual(untouched.fetched, [BANK]);
    assert.deepEqual(untouched.paired, []);
    const fund = fundRow();
    for (const converted of [false, true]) {
      const now = converted ? { ...before, activityType: "TRANSFER_OUT", isUserModified: true } : before;
      const result = await recheck({ before, now, fund, from: { fundId: fund.id, converted } });
      assert.equal(result.row, now);
      assert.equal(result.linked, false);
      assert.deepEqual(result.fetched, [BANK, ACCOUNT]);
      assert.deepEqual(result.paired, converted ? [before.id, fund.id] : [fund.id]);
    }
  });

  test("changed or missing bank entries stop a retry, including changes within the original matching tolerance", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    for (const changed of [
      null, { amount: "4000.00" }, { amount: "5000.02" }, { activityType: "TRANSFER_OUT" },
      { accountId: ACCOUNT }, { date: "2023-04-09T00:00:00+00:00" }, { currency: "USD" }, { status: "PENDING" },
    ]) {
      await assert.rejects(recheck({ before, now: changed && { ...before, ...changed } }), /The bank entry changed since the import/);
    }
    await assert.rejects(recheck({ before, from: { fundId: "fund-leg", converted: true }, fund: fundRow() }), /The bank entry changed since the import/);
  });

  test("changed, missing or linked fund transfers stop a retry", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const from = { fundId: "fund-leg" };
    for (const changed of [
      null, { amount: "4000.00" }, { accountId: BANK }, { date: "2023-04-09T00:00:00+00:00" },
      { activityType: "DEPOSIT" }, { currency: "USD" }, { assetSymbol: "A" }, { status: "PENDING" },
    ]) {
      await assert.rejects(recheck({ before, from, fund: changed && { ...fundRow(), ...changed } }), /The fund account's transfer changed since the import/);
    }
    await assert.rejects(recheck({ before, from, fund: fundRow(), fundPair: { transferOut: { id: "elsewhere" }, transferIn: { id: from.fundId } } }), /already linked with another transfer/);
  });

  test("a link to this import's own transfer is already done; a different link stops the retry", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const now = { ...before, activityType: "TRANSFER_OUT", isUserModified: true };
    const fund = fundRow();
    const from = { fundId: fund.id, converted: true };
    const pair = { transferOut: now, transferIn: fund };
    const result = await recheck({ before, now, fund, from, pair, fundPair: pair });
    assert.equal(result.linked, true);
    const elsewhere = { transferOut: now, transferIn: { id: "elsewhere" } };
    await assert.rejects(recheck({ before, now, fund, from, pair: elsewhere }), /already linked with another transfer/);
  });

  test("new spending consequences need consent, including categories added after this import converted the entry", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const spendingNow = { assignments: [assignment(before.id, "spending_categories")] };
    await assert.rejects(recheck({ before, spendingNow }), /The bank entry's spending details changed since the import/);
    const now = { ...before, activityType: "TRANSFER_OUT", isUserModified: true };
    await assert.rejects(recheck({ before, now, fund: fundRow(), from: { fundId: "fund-leg", converted: true }, spendingNow }), /The bank entry's spending details changed since the import/);
    assert.equal((await recheck({ before, now, fund: fundRow(), from: { fundId: "fund-leg", converted: true }, spendingThen: spendingNow })).linked, false);
  });

  test("a link that went through still has its spending read again: a category added since stops the retry", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const now = { ...before, activityType: "TRANSFER_OUT", isUserModified: true };
    const fund = fundRow();
    const from = { fundId: fund.id, converted: true };
    const pair = { transferOut: now, transferIn: fund };
    const spendingThen = { assignments: [assignment(before.id, "spending_categories")] };
    const spendingNow = { assignments: [assignment(before.id, "spending_categories"), assignment(before.id, "income_sources")] };
    const unchanged = await recheck({ before, now, fund, from, pair, fundPair: pair, spendingThen, spendingNow: spendingThen });
    assert.equal(unchanged.linked, true);
    assert.deepEqual(unchanged.facts.spending.kinds, ["expense"]);
    await assert.rejects(recheck({ before, now, fund, from, pair, fundPair: pair, spendingThen, spendingNow }), /The bank entry's spending details changed since the import/);
  });

  test("an entry changed into a transfer whose answer was lost resumes as this import's change", async () => {
    const before = entry("WITHDRAWAL", "5000.00", "2023-04-08");
    const now = { ...before, activityType: "TRANSFER_OUT", isUserModified: true };
    const fund = fundRow();
    const resumed = await recheck({ before, now, fund, from: { fundId: fund.id, converted: false } });
    assert.deepEqual([resumed.row, resumed.linked, resumed.converted], [now, false, true]);
    // Before the fund account's transfer was added, or into another type, it's still someone else's change.
    await assert.rejects(recheck({ before, now, fund }), /The bank entry changed since the import/);
    await assert.rejects(recheck({ before, now: { ...before, activityType: "DEPOSIT" }, fund, from: { fundId: fund.id } }), /The bank entry changed since the import/);
  });

  test("a failed row or pair read has a plain retry message and does not change progress", async () => {
    const before = entry("TRANSFER_OUT", "5000.00", "2023-04-08");
    for (const fail of ["rows", "pair"]) {
      await assert.rejects(recheck({ before, fail }), /We couldn't check the bank entries again\. Nothing more was changed\. Try again\./);
    }
  });
});
