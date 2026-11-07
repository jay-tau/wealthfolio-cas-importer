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

test("gives nothing to search when only a plan is left", () => {
  assert.equal(fundName("(Direct Plan)"), "");
  assert.equal(fundName(" - Direct Plan - Growth"), "");
});

test("reads the plan and option of every made-up statement's funds", async () => {
  const names = [];
  for (const file of ["made-up-cas", "made-up-cas-mismatch", "made-up-cas-no-price", "made-up-summary-cams", "made-up-summary-kfintech"]) {
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
  ]) assert.deepEqual(planAndOption(name), expected, name);
});
