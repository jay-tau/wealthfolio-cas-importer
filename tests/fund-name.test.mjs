// The name searched when a fund's printed ISIN finds nothing, and the plan and option a fund's
// name gives.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fundName, planAndOption } from "../src/lib/fund-name.ts";

test("detailed CAMS and KFintech schemes keep their search names", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const schemes = data.folios.flatMap((f) => f.schemes);
  assert.deepEqual([...new Set(schemes.map((s) => s.rta))], ["CAMS", "KFINTECH"]);
  assert.deepEqual(schemes.map((s) => fundName(s.scheme)), [
    "Fictiva Flexi Cap Fund", "Fictiva Liquid Fund", "Fictiva Balanced Advantage Fund", "Fictiva Midcap Fund",
    "Testbridge Corporate Bond Fund", "Testbridge Overnight Fund", "Testbridge Gilt Fund",
  ]);
});

test("keeps the name before the plan and option", () => {
  assert.equal(fundName("Fictiva Flexi Cap Fund - Direct Plan - Growth"), "Fictiva Flexi Cap Fund");
  assert.equal(fundName("Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout"), "Testbridge Corporate Bond Fund");
  assert.equal(
    fundName("Fictiva Balanced Advantage Fund - Direct Plan - Income Distribution cum Capital Withdrawal Option - Reinvestment"),
    "Fictiva Balanced Advantage Fund",
  );
});

test("searches the whole name when no dash separates the plan and option, as before the badges", () => {
  assert.equal(fundName("FICTIVA FLEXI CAP FUND DIRECT PLAN GROWTH"), "FICTIVA FLEXI CAP FUND DIRECT PLAN GROWTH");
  assert.equal(fundName("Fictiva Flexi Cap Fund Dir Gr"), "Fictiva Flexi Cap Fund Dir Gr");
});

test("drops anything in parentheses, even a parenthesis holding a dash", () => {
  assert.equal(fundName("Fictiva Flexi Cap Fund (FoF) - Direct Plan - Growth"), "Fictiva Flexi Cap Fund");
  assert.equal(fundName("Fictiva Fund (Old Name - Direct) - Growth"), "Fictiva Fund");
  assert.equal(fundName("Fictiva Nifty 50 Index Fund (Direct Plan) (Growth)"), "Fictiva Nifty 50 Index Fund");
});

test("keeps a name with no plan, and dashes inside words", () => {
  assert.equal(fundName("Fictiva Nifty 50 ETF"), "Fictiva Nifty 50 ETF");
  assert.equal(fundName("Fictiva Multi-Asset Fund - Direct Plan-Growth"), "Fictiva Multi-Asset Fund");
});

test("keeps a segregated portfolio's name and number, so the search doesn't find its main fund", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-segregated.json", "utf8"));
  assert.deepEqual(data.folios[0].schemes.map((s) => fundName(s.scheme)), [
    "Fictiva Credit Risk Fund", "Fictiva Credit Risk Fund Segregated Portfolio 1",
  ]);
  // codereverser/casparser#46's CAMS name, and other places the words can go.
  assert.equal(fundName("Fictiva Credit Risk Fund- Segregated Portfolio 1 (7.35% Madeup Ltd-18AUG29-Growth Plan)"), "Fictiva Credit Risk Fund- Segregated Portfolio 1");
  assert.equal(fundName("Fictiva Credit Risk Fund - Direct Plan - Growth - Segregated Portfolio II"), "Fictiva Credit Risk Fund Segregated Portfolio II");
  assert.equal(fundName("Fictiva Credit Risk Fund - Direct Plan - Growth (Segregated Portfolio 1)"), "Fictiva Credit Risk Fund Segregated Portfolio 1");
  assert.equal(fundName("Fictiva Credit Risk Fund- Segregated Portfolio - 1 - Direct Plan - Growth"), "Fictiva Credit Risk Fund- Segregated Portfolio - 1");
  assert.equal(fundName("Fictiva Credit Risk Fund - Segregated Portfolio (9.10% Madeup Ltd) - Direct Plan - Growth"), "Fictiva Credit Risk Fund Segregated Portfolio");
});

test("gives nothing to search when only a plan is left", () => {
  assert.equal(fundName("(Direct Plan)"), "");
  assert.equal(fundName(" - Direct Plan - Growth"), "");
});

test("reads the plan and option of every made-up statement's funds", async () => {
  const names = [];
  for (const file of ["made-up-cas", "made-up-cas-mismatch", "made-up-cas-no-price", "made-up-cas-segregated", "made-up-summary-cams", "made-up-summary-kfintech"]) {
    const data = JSON.parse(await readFile(`tests/fixtures/${file}.json`, "utf8"));
    names.push(...data.folios.flatMap((f) => f.schemes.map((s) => s.scheme)));
  }
  for (const file of ["made-up-cdsl", "made-up-nsdl"]) {
    const data = JSON.parse(await readFile(`tests/fixtures/${file}.json`, "utf8"));
    names.push(...data.accounts.flatMap((a) => a.mutual_funds.map((f) => f.name)));
  }
  const read = Object.fromEntries([...new Set(names)].map((name) => [name, planAndOption(name)]));
  assert.deepEqual(read, {
    "Fictiva Flexi Cap Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Fictiva Liquid Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment": { plan: "Direct", option: "IDCW" },
    "Fictiva Balanced Advantage Fund - Direct Plan - Income Distribution cum Capital Withdrawal Option - Reinvestment": { plan: "Direct", option: "IDCW" },
    "Fictiva Midcap Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout": { plan: "Regular", option: "IDCW" },
    "Testbridge Overnight Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Testbridge Gilt Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Fictiva Credit Risk Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Fictiva Credit Risk Fund - Segregated Portfolio 1 - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "Testbridge Fixed Term Plan - Series 12 - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "FFCDG - Fictiva Flexi Cap Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "FMCDG - Fictiva Midcap Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "TCBRP - Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout": { plan: "Regular", option: "IDCW" },
    "TGLDG - Testbridge Gilt Fund - Direct Plan - Growth": { plan: "Direct", option: "Growth" },
    "TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH": { plan: "Direct", option: "Growth" },
    // Depository statements list ETFs among mutual funds.
    "FICTIVA NIFTY 50 ETF": {},
    "TESTBRIDGE GOLD ETF": {},
  });
});

test("reads the plan and option however they're spelled", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    ["FICTIVA FLEXI CAP FUND DIRECT PLAN GROWTH", both("Direct", "Growth")],
    ["Fictiva Flexi Cap Fund Dir Gr", both("Direct", "Growth")],
    ["Fictiva Flexi Cap Fund Reg IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Fund - dIrect PLan - gRowth", both("Direct", "Growth")],
    ["Fictiva Fund (Direct Plan) - IDcw", both("Direct", "IDCW")],
    ["Fictiva Fund (dIrect PLan - INcome DistRibution CUm CApital WithDrawal OPtion - RE INvestment)", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Fund - Growth - Direct Plan", both("Direct", "Growth")],
    ["Fictiva Flexi Cap Fund - Direct Plan-Growth Option", both("Direct", "Growth")],
    ["Fictiva Nifty 50 Index Fund (Direct Plan) (Growth)", both("Direct", "Growth")],
    ["Fictiva Liquid Fund - Regular Plan - Daily IDCW Re-investment", both("Regular", "IDCW")],
    ["Fictiva Liquid Fund - Direct Plan - Half-Yearly IDCW Payout", both("Direct", "IDCW")],
    ["Fictiva Liquid Fund - Direct Plan - Half - Yearly IDCW", both("Direct", "IDCW")],
    ["Fictiva Liquid Fund - Regular Plan - Half  Yearly IDCW", both("Regular", "IDCW")],
    ["Fictiva Liquid Fund - Direct Plan - Half–Yearly IDCW", both("Direct", "IDCW")],
    ["Fictiva Medium Term Fund - Direct Plan - Bi Monthly IDCW", both("Direct", "IDCW")],
    ["Fictiva Medium Term Fund - Regular Plan - Bi-Monthly IDCW", both("Regular", "IDCW")],
    ["Fictiva Medium Term Fund - Direct Plan - Periodic IDCW", both("Direct", "IDCW")],
    ["Fictiva Dynamic Term Fund - Regular Plan B - Growth", both("Regular", "Growth")],
    ["Fictiva Gilt Fund - Regular - Plan B - Half Yearly IDCW", both("Regular", "IDCW")],
    ["Fictiva Conservative Hybrid Fund - Growth / Payment - Direct Plan", both("Direct", "Growth")],
    ["Fictiva Arbitrage Fund - Payout of Income Distribution cum Capital Withdrawal Option - Direct", both("Direct", "IDCW")],
    // IDCW was called Dividend before April 2021.
    ["Fictiva Flexi Cap Fund - Regular Plan - Dividend Payout", both("Regular", "IDCW")],
    ["Fictiva Flexi Cap Fund Dir Div", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Fund - Direct Plan - Dividend Re Investment", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Fund - Direct Plan - Dividend Re  Investment", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Fund - Direct Plan - Dividend Re - Investment", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Fund - Direct Plan - Dividend Re—Investment", both("Direct", "IDCW")],
    ["Fictiva Liquid Fund (Daily IDCW Reinvestment - Direct Plan)", both("Direct", "IDCW")],
    ["Fictiva Fund (Payout of Income Distribution cum Capital Withdrawal Option - Direct Plan)", both("Direct", "IDCW")],
    ["Fictiva FMP-XXXVII-1302D-SEP 2016(1)-REG(G)", both("Regular", "Growth")],
    ["Fictiva FTP-178-1154D-Reg(G)", both("Regular", "Growth")],
    ["Fictiva FMP-82-1136D-P(G)-DIRECT PLAN", both("Direct", "Growth")],
    // A note in parentheses after them is skipped.
    ["Fictiva Flexi Cap Fund - Direct Plan - Growth (Non-Demat)", both("Direct", "Growth")],
    ["Fictiva Liquid Sup Inst Dir Gr", both("Direct", "Growth")],
    ["Fictiva Liquid Unclmd Div Reg Gr", both("Regular", "Growth")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

test("reads Yahoo's abbreviations between or after the plan and option", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    // Daily, weekly, fortnightly, monthly, quarterly, half-yearly, annual and periodic IDCW.
    ["Fictiva Liquid Dir Dl IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Overnight Reg Wk IDCW-R", both("Regular", "IDCW")],
    ["Fictiva Money Market Reg Wkly IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Ultra Short Dir Wly IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Liquid Dir Fn IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Savings Reg Fr IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Money Market Dir Ft IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Overnight Reg Fortn IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Liquid Dir Mn IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Conservative Hybrid Reg Mly IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Banking and PSU Debt Reg Mth IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Conservative Hybrid Dir Mthly IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Medium Term Dir Bi-M IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Corporate Bond Dir Qt IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Conservative Hybrid Reg Qtly IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Dynamic Term Dir HY IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Large Cap Reg Hy IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Equity Savings Dir Hf Yr IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Credit Risk Reg Hf Yrly IDCW-R", both("Regular", "IDCW")],
    ["Fictiva Gilt Dir Ann IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Large & Mid Cap Dir An IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Hybrid Dir Annually IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Flexi Cap Dir Yr IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Credit Risk Reg Pd IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Credit Risk Reg Prd IDCW-R", both("Regular", "IDCW")],
    ["Fictiva Gilt Reg Prdic IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Ultra Short Reg Prdc IDCW-P", both("Regular", "IDCW")],
    // Normal, flexi, standard and discretionary IDCW, and a monthly payment plan.
    ["Fictiva Medium Term Dir Nrm IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Medium Term Dir Nor IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Medium Term Reg Normal IDCW-R", both("Regular", "IDCW")],
    ["Fictiva Money Market Dir Flexi IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Money Market Dir Fl IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Medium Term Reg Std IDCW-P", both("Regular", "IDCW")],
    ["FICTIVA MEDIUM TERM FUND - REGULAR PLAN - STANDARD IDCW", both("Regular", "IDCW")],
    ["Fictiva Corporate Bond Dir Disc IDCW-R", both("Direct", "IDCW")],
    ["Fictiva Ultra Short Dir Discr IDCW-P", both("Direct", "IDCW")],
    ["FICTIVA CORPORATE BOND FUND - DIRECT PLAN - DISCRETIONARY IDCW", both("Direct", "IDCW")],
    ["Fictiva Conservative Hybrid Reg Mn Py IDCW-P", both("Regular", "IDCW")],
    // Rg and Dr, also after the frequency.
    ["Fictiva Nifty 50 Index Rg Gr", both("Regular", "Growth")],
    ["Fictiva Nifty G-Sec 1230 Ann Dr IDCW-P", both("Direct", "IDCW")],
    // IDCW-T, IDCW-P without its dash, one fund's "ICDW", and other IDCW.
    ["Fictiva Focused Dir IDCW-T", both("Direct", "IDCW")],
    ["Fictiva Nifty SDL 0927 Reg Ann IDCWP", both("Regular", "IDCW")],
    ["Fictiva Ultra Short Term Dir Flexi IDCWR", both("Direct", "IDCW")],
    ["Fictiva Overnight Dir ICDW", both("Direct", "IDCW")],
    ["Fictiva Floating Rate Dir IDCW-P Oths", both("Direct", "IDCW")],
    ["Fictiva Floating Rate Fund - Regular Plan - IDCW Others", both("Regular", "IDCW")],
    // Lock-in options.
    ["Fictiva Children's Dir Loc in IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Children's Reg No Loc in Gr", both("Regular", "Growth")],
    ["Fictiva Children's Fund - Direct Plan - Lock-in - Growth", both("Direct", "Growth")],
    ["Fictiva Children's Fund - Direct Plan - No Lock-in - Growth", both("Direct", "Growth")],
    ["Fictiva Liquid Fund (Dir Mn IDCW-P)", both("Direct", "IDCW")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
  // Bonus is neither displayed option, but the plan before it counts.
  for (const name of ["Fictiva Ultra Short Dir Bns", "Fictiva Ultra Short Dir Bns Princ", "Fictiva Liquid Fund - Direct Plan - Bonus Option - Principal Units"]) {
    assert.deepEqual(planAndOption(name), { plan: "Direct" }, name);
  }
});

test("reads a Yahoo name whose words lost their spaces", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    ["Fictiva ELSS Tax Saver DirGr", both("Direct", "Growth")],
    ["Fictiva Banking and PSU Debt Reg MthIDCW-P", both("Regular", "IDCW")],
    ["Fictiva CRISIL IBX Gilt 0428 RgIDCW-P", both("Regular", "IDCW")],
    ["Fictiva Gold ETF FOF DirIDCWP", both("Direct", "IDCW")],
    ["Fictiva Long Term DirHYIDCWP", both("Direct", "IDCW")],
    ["Fictiva Ultra Shrt toS/TDirDlIDCW-R", both("Direct", "IDCW")],
    ["Fictiva Intl REIT Omni FOFRegIDCW-P", both("Regular", "IDCW")],
    ["Fictiva Nifty500 Multicap Idx RegIDCW-R", both("Regular", "IDCW")],
    ["Fictiva Children's Dir No Loc inIDCW-R", both("Direct", "IDCW")],
    ["Fictiva Liquid RegMnIDCW-P(Discon)", both("Regular", "IDCW")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

test("leaves out a plan or option the name doesn't give", () => {
  for (const [name, expected] of [
    ["Fictiva Flexi Cap Fund - Direct Plan", { plan: "Direct" }],
    ["Fictiva Flexi Cap Fund Dir", { plan: "Direct" }],
    ["Fictiva Flexi Cap Fund - Growth", { option: "Growth" }],
    ["Fictiva Flexi Cap Fund IDCW", { option: "IDCW" }],
    ["Fictiva Flexi Cap Fund", {}],
    ["Fund INFZ90K01FC8", {}],
    ["Scheme 123456", {}],
    ["", {}],
    // Bonus is neither displayed option, but the explicit plan still counts.
    ["Fictiva Gilt Fund - Direct Plan - Bonus", { plan: "Direct" }],
    // A part in parentheses with anything else in it says nothing.
    ["Fictiva Fund (Old Name - Direct) - Growth", { option: "Growth" }],
    ["Fictiva Fund (Old Name - Direct Growth)", {}],
    // Yahoo's names for retail, institutional, super institutional and Eco plans, or with no plan.
    ["Fictiva Liquid Retl Wk IDCW-P", { option: "IDCW" }],
    ["Fictiva Liquid Instl Dl IDCW-R", { option: "IDCW" }],
    ["Fictiva Liquid Inst Dl IDCW-R", { option: "IDCW" }],
    ["Fictiva Liquid SI Wk IDCW-P", { option: "IDCW" }],
    ["Fictiva Conservative Hybrid Eco Mly IDCW-P", { option: "IDCW" }],
    ["Fictiva Liquid Wk IDCW-P", { option: "IDCW" }],
    ["Fictiva Growth Md Cp Reg InstlIDCWP", { option: "IDCW" }],
    ["Fictiva Overnight Dir Unc Red Stb Sch", {}],
    ["Fictiva Gilt Dir PFAutoYrIDCW-R", { option: "IDCW" }],
    ["Fictiva Fund (Old Name Dir Mn IDCW-P)", {}],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

test("doesn't read the plan or option from the fund's own name", () => {
  for (const [name, expected] of [
    ["Fictiva Growth Fund - Direct Plan - IDCW", { plan: "Direct", option: "IDCW" }],
    ["Fictiva Growth Fund", {}],
    ["Fictiva Regular Savings Fund - Growth", { option: "Growth" }],
    ["Fictiva Direct Opportunities Fund - Growth", { option: "Growth" }],
    ["Fictiva Dividend Yield Fund - Regular Plan - Growth", { plan: "Regular", option: "Growth" }],
    // Without "Fund", the reading stops once both are found.
    ["Fictiva Growth Dir IDCW", { plan: "Direct", option: "IDCW" }],
    ["NPS TRUST- A/C FICTIVA PENSION FUND MANAGEMENT LIMITED SCHEME E - TIER I", {}],
    ["FICTIVA NIFTY 50 ETF", {}],
    ["Fictiva Fixed Maturity Plan A - Growth", { option: "Growth" }],
    ["Fictiva Fixed Maturity Plan G", {}],
    ["Fictiva Fund Constructor", {}],
    // Nor from a word that only looks like one of Yahoo's abbreviations, or a capital inside a word.
    ["Fictiva Regular Savings Mn IDCW-P", { option: "IDCW" }],
    ["Fictiva Annual Interval Instl Gr", { option: "Growth" }],
    ["Fictiva FoF Gr", { option: "Growth" }],
    ["Fictiva DirectEdge Fund", {}],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});
