// The words of the Review screen's rare questions, from made-up plans.
import assert from "node:assert/strict";
import { test } from "node:test";
import { holdingAskWords, MISSING_WHY, sameDateChanges, sameDateWords } from "../src/lib/asks.ts";
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
    "Fictiva Liquid Fund: kept at 512.300 units", "Fictiva Liquid Fund: set to zero on 31 Jul", "Fictiva Liquid Fund kept at 512.300 units", "Fictiva Liquid Fund set to zero",
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
    "Testbridge Gilt Fund: kept as Testbridge Gilt Reg Gr for now",
    "Testbridge Gilt Fund: Testbridge Gilt Reg Gr replaced with the AMFI fund",
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
    "CDSL Demat: keep the holdings already saved for 31 Jul 2026",
    "CDSL Demat: replace the holdings saved for 31 Jul 2026",
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
