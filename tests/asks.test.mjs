// The words of the Review screen's rare questions, from made-up plans.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerNames, bothRealWords, holdingAskWords, MISSING_WHY, placeWords, sameDateChanges, sameDateWords } from "../src/lib/asks.ts";
import { planSnapshots, snapshotOf } from "../src/cas/holdings.ts";

const folio = { id: "folio|7712045", kind: "folio", label: "Folio 7712045", title: "Mutual fund folio 7712045", holdings: [] };
const other = { id: "folio|91234567", kind: "folio", label: "Folio 91234567", title: "Fictiva Mutual Fund account (folio 91234567)", holdings: [] };
const demat = { id: "demat|1", kind: "demat", label: "CDSL Demat Account 1", title: "Fictiva Securities demat account", holdings: [] };
const existing = (name, units, symbol = name.toUpperCase().replace(/\W+/g, "")) => ({ assetId: `asset-${symbol}`, symbol, ref: `${symbol}@XBOM`, name, units, cost: null, currency: "INR" });
const line = (source, name, units) => ({ source, holding: { kind: "fund", name, units, isin: null, rta: null, rtaCode: null, price: "1", value: units, cost: null } });
const position = (key, more) => ({
  key, ref: key, name: key, lines: [], include: true, notes: [], order: 0,
  asset: { symbol: key.split("@")[0], exchangeMic: "XBOM", quoteCcy: "INR", name: more?.name ?? key, instrumentType: "MUTUALFUND" },
  ...more,
});
const planOf = (...positions) => ({ accountId: "cdsl", date: "2026-07-31", existing: { date: "2026-07-31", positions: [], cash: {}, later: [] }, positions });
const name = (p) => p.name;
const choices = (more = {}) => ({ flipped: new Set(), costs: new Map(), ...more });

test("a holding the statement no longer lists asks to keep it or set it to zero, with why", () => {
  const liquid = position("LIQUID@XBOM", { name: "Fictiva Liquid Fund", existing: existing("Fictiva Liquid Fund", "512.3"), removable: [folio], ask: { kind: "missing" } });
  const words = holdingAskWords(planOf(liquid), liquid, { account: "CDSL Demat", name });
  assert.deepEqual([words.title, words.line, words.main, words.other, words.why], [
    "Fictiva Liquid Fund isn't on this statement",
    "CDSL Demat holds 512.300 units of it, from an earlier import of Mutual fund folio 7712045.",
    "Keep 512.300 units",
    "Set it to zero on 31 Jul",
    MISSING_WHY,
  ]);
  assert.deepEqual([words.receipt(true), words.receipt(false), words.done(true), words.done(false)], [
    // The answered line names the account too: Change answer's name is the line alone.
    "Fictiva Liquid Fund: 512.300 units kept in CDSL Demat", "Fictiva Liquid Fund: set to zero in CDSL Demat on 31 Jul", "Fictiva Liquid Fund kept at 512.300 units", "Fictiva Liquid Fund set to zero",
  ]);
  // An account whose name another has is told apart the same way in its line and answered line.
  const told = holdingAskWords(planOf(liquid), liquid, { account: "CDSL Demat (ending 4821)", name });
  assert.deepEqual([told.line, told.receipt(true), told.receipt(false)], [
    "CDSL Demat (ending 4821) holds 512.300 units of it, from an earlier import of Mutual fund folio 7712045.",
    "Fictiva Liquid Fund: 512.300 units kept in CDSL Demat (ending 4821)", "Fictiva Liquid Fund: set to zero in CDSL Demat (ending 4821) on 31 Jul",
  ]);
});

test("a source that now goes to another account asks to keep its holding here or remove it", () => {
  const gilt = position("GILT@XBOM", {
    name: "Testbridge Gilt Fund", existing: existing("Testbridge Gilt Fund", "812.3"), removable: [folio],
    ask: { kind: "moved", moved: [{ source: folio, account: "Mutual funds (holdings)" }] },
  });
  const words = holdingAskWords(planOf(gilt), gilt, { account: "CDSL Demat", name });
  assert.deepEqual([words.title, words.line, words.main, words.other, words.why], [
    "Mutual fund folio 7712045 now goes to Mutual funds (holdings)",
    "CDSL Demat holds 812.300 units of Testbridge Gilt Fund that this folio added.",
    "Keep them in CDSL Demat",
    "Remove them from CDSL Demat",
    undefined,
  ]);
  assert.equal(words.receipt(false), "Testbridge Gilt Fund: removed from CDSL Demat");
  // Import records hold identifiers, not units: removing them also removes units added another way.
  assert.equal(words.caution, "Remove them only if all of them came from this folio: imports don't record how many units each folio, demat account or PRAN added.");
  // Another source that no longer lists it recorded it too: both are named.
  const both = { ...gilt, removable: [demat, folio] };
  assert.equal(holdingAskWords(planOf(both), both, { account: "CDSL Demat", name }).line,
    "CDSL Demat holds 812.300 units of Testbridge Gilt Fund that earlier imports of Fictiva Securities demat account and Mutual fund folio 7712045 added.");
  assert.equal(holdingAskWords(planOf(both), both, { account: "CDSL Demat", name }).caution,
    "Remove them only if all of them came from Fictiva Securities demat account and Mutual fund folio 7712045: imports don't record how many units each folio, demat account or PRAN added.");
  // A demat account says so.
  const fromDemat = { ...gilt, removable: [demat], ask: { kind: "moved", moved: [{ source: demat, account: "Shares" }] } };
  assert.match(holdingAskWords(planOf(fromDemat), fromDemat, { account: "CDSL Demat", name }).line, /that this demat account added\.$/);
});

test("units an earlier import added of a fund tracked from its transactions ask to keep them or remove them", () => {
  const tracked = [{ name: "Mutual funds", tracksTransactions: true }];
  const flexi = position("FLEXI@XBOM|overlap", {
    name: "Fictiva Flexi Cap Fund", existing: existing("Fictiva Flexi Cap Fund", "1500"), removable: [other], heldBy: tracked,
    lines: [line(other, "Fictiva Flexi Cap Fund", "1500")], include: false, ask: { kind: "overlap", tracked, row: "FLEXI@XBOM|overlap" },
  });
  const words = holdingAskWords(planOf(flexi), flexi, { account: "CDSL Demat", name });
  assert.deepEqual([words.title, words.line, words.main, words.other, words.caution], [
    "Fictiva Flexi Cap Fund is already tracked in Mutual funds",
    "CDSL Demat also holds 1,500.000 units of it, from an earlier import of Fictiva Mutual Fund account (folio 91234567).",
    "Keep them in CDSL Demat",
    "Remove them from CDSL Demat",
    "Remove them only if all of them came from Fictiva Mutual Fund account (folio 91234567): imports don't record how many units each folio, demat account or PRAN added.",
  ]);
  // The answer names the account without a possessive, which an account named for its holdings would make "holdings's".
  const named = holdingAskWords(planOf(flexi), flexi, { account: "CDSL holdings", name });
  assert.deepEqual([named.receipt(true), named.receipt(false), named.done(true), named.done(false)], [
    "Fictiva Flexi Cap Fund: 1,500.000 units kept in CDSL holdings",
    "Fictiva Flexi Cap Fund: 1,500.000 units removed from CDSL holdings",
    "Fictiva Flexi Cap Fund: 1,500.000 units kept in CDSL holdings",
    "Fictiva Flexi Cap Fund: 1,500.000 units removed from CDSL holdings",
  ]);
  // Added as another asset, for the statement row now left out for the overlap.
  const old = position("OLDFLEXI@XBOM", {
    name: "Fictiva Flexi Reg", existing: existing("Fictiva Flexi Reg", "1500", "OLDFLEXI"), removable: [other],
    ask: { kind: "overlap", tracked, row: flexi.key },
  });
  const both = holdingAskWords(planOf(flexi, old), old, { account: "CDSL Demat", name });
  assert.deepEqual([both.title, both.line], [
    "Fictiva Flexi Cap Fund is already tracked in Mutual funds",
    "CDSL Demat also holds 1,500.000 units of it as Fictiva Flexi Reg (OLDFLEXI · XBOM), from an earlier import of Fictiva Mutual Fund account (folio 91234567).",
  ]);
});

test("an old asset to replace keeps it for now as the main answer, and says what that leaves", () => {
  const old = position("0P0000GILT.BO@XBOM", { name: "Testbridge Gilt Reg Gr", existing: { ...existing("Testbridge Gilt Reg Gr", "812.3", "0P0000GILT.BO") }, replacedBy: "119551" });
  const gilt = position("119551@", {
    name: "Testbridge Gilt Fund", asset: { symbol: "119551", quoteCcy: "INR", instrumentType: "MUTUALFUND", providerId: "AMFI", name: "Testbridge Gilt Fund" },
    lines: [line(folio, "Testbridge Gilt Fund", "812.3")], include: false, replaces: [old.key], ask: { kind: "replace", recorded: [folio, demat] },
  });
  const amfi = holdingAskWords(planOf(gilt, old), gilt, { account: "CDSL Demat", name, provider: (p) => p.asset?.providerId });
  assert.deepEqual([amfi.title, amfi.line, amfi.main, amfi.note, amfi.other, amfi.caution], [
    "Testbridge Gilt Fund is now matched to its AMFI fund",
    "CDSL Demat holds it as Testbridge Gilt Reg Gr (0P0000GILT.BO · XBOM).",
    "Keep Testbridge Gilt Reg Gr for now",
    "The AMFI fund isn't saved, so its units aren't counted twice.",
    "Replace Testbridge Gilt Reg Gr with the AMFI fund",
    "Replace Testbridge Gilt Reg Gr only if all its units came from Mutual fund folio 7712045 and Fictiva Securities demat account: imports don't record how many units each folio, demat account or PRAN added.",
  ]);
  assert.deepEqual([amfi.receipt(true), amfi.receipt(false)], [
    "Testbridge Gilt Fund: kept as Testbridge Gilt Reg Gr in CDSL Demat for now",
    "Testbridge Gilt Fund: Testbridge Gilt Reg Gr replaced with the AMFI fund in CDSL Demat",
  ]);
  // Another provider's result goes by its name, with its symbol when the statement's name is the same;
  // the statement row is named as the statement prints it.
  const yahoo = holdingAskWords(planOf(gilt, old), gilt, { account: "CDSL Demat", name, provider: () => "Yahoo Finance" });
  assert.deepEqual([yahoo.title, yahoo.other], ["Testbridge Gilt Fund is now matched to Testbridge Gilt Fund (119551)", "Replace Testbridge Gilt Reg Gr with Testbridge Gilt Fund"]);
  const printed = holdingAskWords(planOf(gilt, old), gilt, { account: "CDSL Demat", name, statement: () => "TESTBRIDGE GILT FUND - DIRECT PLAN" });
  assert.equal(printed.title, "TESTBRIDGE GILT FUND - DIRECT PLAN is now matched to Testbridge Gilt Fund");
  // Two assets of one name are told apart by their symbols.
  const twin = { ...old, name: "Testbridge Gilt Fund" };
  assert.equal(holdingAskWords(planOf(gilt, twin), gilt, { account: "CDSL Demat", name }).other,
    "Replace Testbridge Gilt Fund (0P0000GILT.BO · XBOM) with Testbridge Gilt Fund (119551)");
});

test("replacing holdings saved for the date says what changes, from what would be saved there", () => {
  const added = position("BAL@XBOM", { name: "Fictiva Balanced Advantage Fund", lines: [line(folio, "Fictiva Balanced Advantage Fund", "1000")], units: "1000" });
  const same = (n) => position(`SAME${n}@XBOM`, { name: `Same ${n}`, existing: existing(`Same ${n}`, "10", `SAME${n}`), lines: [line(folio, `Same ${n}`, "10")], units: "10" });
  const changed = position("MID@XBOM", { name: "Fictiva Midcap Fund", existing: existing("Fictiva Midcap Fund", "3471.427"), lines: [line(folio, "Fictiva Midcap Fund", "3532.777")], units: "3532.777" });
  const missing = position("LIQUID@XBOM", { name: "Fictiva Liquid Fund", existing: existing("Fictiva Liquid Fund", "512.3"), removable: [folio], ask: { kind: "missing" } });
  // Left out for an overlap, and kept by hand: neither changes.
  const excluded = position("FLEXI@XBOM", { name: "Flexi", existing: existing("Flexi", "5"), lines: [line(folio, "Flexi", "6")], units: "6", include: false, heldBy: [{ name: "MF" }] });
  const byHand = position("GOLD@XBOM", { name: "Gold", existing: existing("Gold", "2") });
  const plan = planOf(added, same(1), same(2), changed, missing, excluded, byHand);
  assert.deepEqual(sameDateChanges(plan, choices(), name), [
    "Fictiva Balanced Advantage Fund: added, 1,000.000 units",
    "Fictiva Midcap Fund: 3,471.427 units now, 3,532.777 on this statement",
    "Fictiva Liquid Fund: 512.300 units now, not on this statement",
    "4 other holdings: same units",
  ]);
  // Answered, and a holding still waiting to be matched.
  assert.deepEqual(sameDateChanges(plan, choices({ keep: new Map([[missing.key, false]]) }), name, [{ name: "Unmatched Fund", units: "5" }]).slice(2), [
    "Fictiva Liquid Fund: 512.300 units now, set to zero",
    "Unmatched Fund: 5.000 units on this statement, still to be matched",
    "4 other holdings: same units",
  ]);
  assert.deepEqual(sameDateChanges(planOf(same(1)), choices(), name), ["1 holding: same units"]);
  const words = sameDateWords("CDSL Demat", "2026-07-31");
  assert.deepEqual([words.title, words.main, words.other, words.receipt(true), words.receipt(false)], [
    "CDSL Demat already has holdings saved for 31 Jul 2026",
    "Keep the saved ones",
    "Replace them with this statement",
    // What the answer did, as the other answered lines say it.
    "CDSL Demat: kept the holdings already saved for 31 Jul 2026",
    "CDSL Demat: replaced the holdings saved for 31 Jul 2026 with this statement",
  ]);
  // An account whose name another has is told apart the same way in its title, answered line and the bar.
  const told = sameDateWords("CDSL Demat (ending 4821)", "2026-07-31");
  assert.deepEqual([told.title, told.receipt(true), told.done(false)], [
    "CDSL Demat (ending 4821) already has holdings saved for 31 Jul 2026", "CDSL Demat (ending 4821): kept the holdings already saved for 31 Jul 2026",
    "CDSL Demat (ending 4821): the holdings saved for 31 Jul 2026 are replaced.",
  ]);
});

test("the same-date comparison counts the actual saved asset once when overlap splits its contributions", () => {
  const holding = { kind: "fund", isin: "INFTEST", name: "Example Fund", units: "60", price: "1", value: "60", cost: null };
  const holdings = { date: "2026-07-31", investor: "TEST", leftOut: [], sources: [
    { ...demat, holdings: [holding] },
    { ...folio, holdings: [{ ...holding, units: "40", value: "40" }] },
  ] };
  const [plan] = planSnapshots(holdings, {
    account: () => "cdsl", accountName: () => "CDSL Demat",
    asset: () => ({ symbol: "INFTEST", exchangeMic: "XBOM", quoteCcy: "INR", name: "Example Fund", instrumentType: "MUTUALFUND" }),
    existing: () => ({ date: holdings.date, positions: [existing("Example Fund", "100", "INFTEST")], cash: {}, later: [] }),
    remembered: () => new Map(), heldElsewhere: () => [{ name: "Transactions", tracksTransactions: true }],
  });
  const overlap = plan.positions.find((p) => p.heldBy);
  assert.equal(snapshotOf(plan, choices()).holdings[0].quantity, "60");
  assert.deepEqual(sameDateChanges(plan, choices(), name), ["Example Fund: 100.000 units now, 60.000 on this statement"]);
  const both = choices({ flipped: new Set([overlap.key]) });
  assert.equal(snapshotOf(plan, both).holdings[0].quantity, "100");
  assert.deepEqual(sameDateChanges(plan, both, name), ["1 holding: same units"]);
});

test("a possible duplicate's two transactions are called equal only when their day, units and amount are", () => {
  const statement = { day: "5 May 2023", units: "9.747 units", amount: "₹24,998.75" };
  // Equal, or reported equal by Wealthfolio.
  assert.equal(bothRealWords(statement, { ...statement }), "Two equal transactions on one day can both be real.");
  assert.equal(bothRealWords(statement), "Two equal transactions on one day can both be real.");
  // A cash dividend has no units: its amount and day are all there is to compare.
  assert.equal(bothRealWords({ day: "5 May 2023", amount: "₹120" }, { day: "5 May 2023", amount: "₹120" }), "Two equal transactions on one day can both be real.");
  // What they share, without "equal", once anything differs.
  assert.equal(bothRealWords(statement, { ...statement, amount: "₹25,001.15" }), "Two transactions on one day with the same units can both be real.");
  assert.equal(bothRealWords(statement, { ...statement, units: "9.748 units" }), "Two transactions on one day for the same amount can both be real.");
  assert.equal(bothRealWords(statement, { day: "5 May 2023", amount: "₹25,000" }), "Two transactions on one day can both be real.");
  // A bank entry has no units, so a purchase and its entry are never equal.
  assert.equal(bothRealWords(statement, { day: "5 May 2023", amount: "₹24,998.75" }), "Two transactions on one day for the same amount can both be real.");
  assert.equal(bothRealWords(statement, { ...statement, day: "4 May 2023" }), "Two transactions with the same units and amount can both be real.");
  assert.equal(bothRealWords(statement, { day: "4 May 2023", units: "1.000 units", amount: "₹1" }), "Two transactions can both be real.");
});

test("answered lines that read the same are numbered for Change answer, open questions never", () => {
  const same = "Demat: kept the holdings already saved for 31 Jul 2026";
  assert.deepEqual(answerNames([same, undefined, "Fund: skipped", undefined, ` ${same}`]),
    [`${same}, question 1`, undefined, "Fund: skipped", undefined, ` ${same}, question 5`]);
  assert.deepEqual(answerNames([same, "Fund: skipped"]), [same, "Fund: skipped"]);
  assert.deepEqual(answerNames([undefined, undefined]), [undefined, undefined]);
});

test("a numbered possible duplicate says what its number counts, amount or none", () => {
  assert.equal(placeWords({ n: 1, of: 2 }, "purchase", "₹5,000", "3 Jul 2026"),
    "The statement lists 2 purchases of ₹5,000 in this fund and folio on 3 Jul 2026; this is the first.");
  assert.equal(placeWords({ n: 2, of: 2 }, "switch in", "₹9,162.28", "20 Jun 2024"),
    "The statement lists 2 switches in of ₹9,162.28 in this fund and folio on 20 Jun 2024; this is the second.");
  // Rows without an amount are counted apart from rows with one.
  assert.equal(placeWords({ n: 11, of: 12 }, "gift received", undefined, "4 Jun 2024"),
    "The statement lists 12 gifts received with no amount shown in this fund and folio on 4 Jun 2024; this is the 11th.");
});
