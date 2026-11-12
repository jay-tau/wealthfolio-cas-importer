// The name searched when a fund's, share's, bond's or NPS scheme's printed ISIN finds nothing, and
// the plan and option a fund's name gives.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { differs, fundName, fundQuery, mayBeCut, planAndOption, readableName } from "../src/lib/fund-name.ts";

test("detailed CAMS and KFintech schemes keep their search names", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas.json", "utf8"));
  const schemes = data.folios.flatMap((f) => f.schemes);
  assert.deepEqual([...new Set(schemes.map((s) => s.rta))], ["CAMS", "KFINTECH"]);
  assert.deepEqual(schemes.map((s) => fundName(s.scheme)), [
    "Fictiva Flexi Cap Fund", "Fictiva Liquid Fund", "Fictiva Balanced Advantage Fund", "Fictiva Midcap Fund",
    "Testbridge Corporate Bond Fund", "Testbridge Overnight Fund", "Testbridge Gilt Fund",
  ]);
  // Funds are searched without "Fund".
  assert.deepEqual(schemes.map((s) => fundQuery(s.scheme)), [
    "Fictiva Flexi Cap", "Fictiva Liquid", "Fictiva Balanced Advantage", "Fictiva Midcap",
    "Testbridge Corporate Bond", "Testbridge Overnight", "Testbridge Gilt",
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

test("keeps the whole name when no dash separates the plan and option, for other securities' searches", () => {
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
  assert.equal(fundName("Fictiva Credit Risk Fund - Units of Segregated Portfolio 1 - Direct Plan - Growth"), "Fictiva Credit Risk Fund Segregated Portfolio 1");
  assert.equal(fundName("Fictiva Credit Risk Fund - Direct Plan - Growth (Units of Segregated Portfolio 1)"), "Fictiva Credit Risk Fund Segregated Portfolio 1");
});

test("gives nothing to search when only a plan is left", () => {
  assert.equal(fundName("(Direct Plan)"), "");
  assert.equal(fundName(" - Direct Plan - Growth"), "");
  for (const name of ["(Direct Plan)", " - Direct Plan - Growth", "DIRECT PLAN GROWTH"]) assert.equal(fundQuery(name), "", name);
});

test("searches a fund without a final \"Fund\", in any case", () => {
  for (const [name, query] of [
    ["Fictiva Flexi Cap Fund - Direct Plan - Growth", "Fictiva Flexi Cap"],
    ["FICTIVA FLEXI CAP FUND - DIRECT PLAN - GROWTH", "FICTIVA FLEXI CAP"],
    ["Fictiva Flexi Cap fund - Direct Plan - Growth", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap fUnD - Direct Plan - Growth", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund (FoF) - Direct Plan - Growth", "Fictiva Flexi Cap"],
    ["Fictiva Nifty 50 Index Fund (Direct Plan) (Growth)", "Fictiva Nifty 50 Index"],
    ["Fictiva Multi-Asset Fund - Direct Plan-Growth", "Fictiva Multi-Asset"],
    ["Fictiva Flexi Cap Fund", "Fictiva Flexi Cap"],
    // Only a final, standalone "Fund", and the words of the fund's own name before it.
    ["Fictiva Growth Fund - Direct Plan - IDCW", "Fictiva Growth"],
    ["Fictiva Regular Savings Fund - Growth", "Fictiva Regular Savings"],
    ["Fictiva Fund of Funds - Direct Plan - Growth", "Fictiva Fund of Funds"],
    ["Fictiva Fund Constructor - Regular Plan - Growth", "Fictiva Fund Constructor"],
    ["Fictiva Mutualfund - Direct Plan - Growth", "Fictiva Mutualfund"],
    ["Fund", "Fund"],
    // Names without "Fund".
    ["Fictiva Flexi Cap - Direct Plan - Growth", "Fictiva Flexi Cap"],
    ["Fictiva Nifty 50 ETF", "Fictiva Nifty 50 ETF"],
    ["Testbridge Fixed Term Plan - Series 12 - Direct Plan - Growth", "Testbridge Fixed Term Plan"],
  ]) assert.equal(fundQuery(name), query, name);
});

test("searches a fund named without a dash without the plan and option at its end", () => {
  for (const [name, query] of [
    ["FICTIVA FLEXI CAP FUND DIRECT PLAN GROWTH", "FICTIVA FLEXI CAP"],
    ["Fictiva Flexi Cap Fund Direct Plan Growth", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Dir Gr", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Reg IDCW-P", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Growth Option", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Plan Growth", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Plan A IDCW Direct Plan", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Plan B Growth", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Annual Plan Growth Direct Plan", "Fictiva Flexi Cap"],
    ["FICTIVA FLEXI CAP DIRECT PLAN GROWTH", "FICTIVA FLEXI CAP"],
    ["Fictiva Liquid Fund Regular Plan Daily IDCW Reinvestment", "Fictiva Liquid"],
    ["Fictiva Energy Fund Direct Plan IDCW Payout & Reinvestment", "Fictiva Energy"],
    ["Fictiva Gilt Fund Direct Plan Regular IDCW Option", "Fictiva Gilt"],
    ["Fictiva Gilt Fund Regular Plan B Half Yearly IDCW", "Fictiva Gilt"],
    // Joined words, kept as printed in the name before them.
    ["Fictiva Flexi Cap Fund DirGr", "Fictiva Flexi Cap"],
    ["Fictiva DirectEdge Fund RegMnIDCW-P", "Fictiva DirectEdge"],
    // The fund's own words stay, even ones that read like a plan, option or filler word.
    ["FICTIVA GROWTH FUND DIRECT PLAN IDCW", "FICTIVA GROWTH"],
    ["Fictiva Dividend Yield Fund Regular Plan Growth", "Fictiva Dividend Yield"],
    ["Fictiva Regular Savings Fund Direct IDCW", "Fictiva Regular Savings"],
    ["Fictiva Fixed Maturity Plan Dir Gr", "Fictiva Fixed Maturity Plan"],
    ["Fictiva Short Term Income Plan Direct Plan", "Fictiva Short Term Income Plan"],
    ["Fictiva Flexi Cap Fund Growth Option Direct Plan", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Daily IDCW Direct Plan", "Fictiva Flexi Cap"],
    ["Fictiva Flexi Cap Fund Payout of IDCW Direct Plan", "Fictiva Flexi Cap"],
    ["Fictiva Regular Plan Growth Dir IDCW", "Fictiva Regular Plan Growth"],
    ["Fictiva Banking and PSU Debt Fund Growth", "Fictiva Banking and PSU Debt"],
    // A name with no plan or option, or with words after them, stays whole but for "Fund".
    ["Fictiva Fixed Maturity Plan", "Fictiva Fixed Maturity Plan"],
    ["Fictiva Payout Fund", "Fictiva Payout"],
    ["FICTIVA NIFTY 50 ETF", "FICTIVA NIFTY 50 ETF"],
    ["Fictiva Flexi Cap Fund Direct Plan Growth Non Demat", "Fictiva Flexi Cap Fund Direct Plan Growth Non Demat"],
    ["Fictiva Gilt Fund Direct Plan Bonus", "Fictiva Gilt"],
  ]) assert.equal(fundQuery(name), query, name);
});

test("keeps the fund's own plan phrase before an option without a dash", () => {
  for (const [name, query] of [
    ["Fictiva Fixed Maturity Plan Growth", "Fictiva Fixed Maturity Plan"],
    ["Fictiva Fixed Maturity Plan A Growth Option", "Fictiva Fixed Maturity Plan A"],
    ["Fictiva Fixed Maturity Plan B IDCW Reinvestment", "Fictiva Fixed Maturity Plan B"],
    ["Fictiva Monthly Income Plan Daily IDCW", "Fictiva Monthly Income Plan"],
    ["Fictiva Monthly Income Plan Daily IDCW Direct Plan", "Fictiva Monthly Income Plan"],
    ["Fictiva FixedMaturityPlanA Growth", "Fictiva FixedMaturityPlanA"],
  ]) assert.equal(fundQuery(name), query, name);
});

test("removes an option's plan word before a trailing plan without changing the badges", () => {
  for (const [suffix, plan] of [
    ["Regular IDCW Direct Plan", "Direct"],
    ["Direct IDCW Regular Plan", "Regular"],
    ["Annual Regular IDCW Direct Plan", "Direct"],
    ["Regular IDCW Direct", "Direct"],
    ["RegMnIDCWDirectPlan", "Direct"],
  ]) {
    const name = `Fictiva Flexi Cap Fund ${suffix}`;
    assert.equal(fundQuery(name), "Fictiva Flexi Cap", name);
    assert.deepEqual(planAndOption(name), { plan, option: "IDCW" }, name);
  }
  // Without "Fund", the earlier word can belong to the fund's own name.
  assert.equal(fundQuery("Fictiva Regular IDCW Direct Plan"), "Fictiva Regular");
  assert.equal(fundQuery("Fictiva Growth Direct Plan IDCW"), "Fictiva Growth");
  assert.equal(fundQuery("Fictiva Fund Growth Direct Plan IDCW"), "Fictiva Fund Growth");
  assert.equal(fundQuery("Fictiva Fund Direct Direct Plan Growth"), "Fictiva Fund Direct");
  assert.equal(fundQuery("Fictiva Fund Direct Growth Direct Plan"), "Fictiva Fund Direct");
  assert.equal(fundQuery("Fictiva Fund Regular Regular Plan Growth"), "Fictiva Fund Regular");
  assert.equal(fundQuery("Fictiva Fund Regular Growth Regular Plan"), "Fictiva Fund Regular");
});

test("searches a segregated portfolio with its marker and number after the shorter name", async () => {
  const data = JSON.parse(await readFile("tests/fixtures/made-up-cas-segregated.json", "utf8"));
  assert.deepEqual(data.folios[0].schemes.map((s) => fundQuery(s.scheme)), [
    "Fictiva Credit Risk", "Fictiva Credit Risk Segregated Portfolio 1",
  ]);
  for (const [name, query] of [
    ["Fictiva Credit Risk Fund- Segregated Portfolio 1 (7.35% Madeup Ltd-18AUG29-Growth Plan)", "Fictiva Credit Risk Segregated Portfolio 1"],
    ["Fictiva Credit Risk Fund - Direct Plan - Growth - Segregated Portfolio II", "Fictiva Credit Risk Segregated Portfolio II"],
    ["Fictiva Credit Risk Fund - Direct Plan - Growth (Segregated Portfolio 1)", "Fictiva Credit Risk Segregated Portfolio 1"],
    ["Fictiva Credit Risk Fund- Segregated Portfolio - 1 - Direct Plan - Growth", "Fictiva Credit Risk Segregated Portfolio - 1"],
    ["Fictiva Credit Risk Fund - Segregated Portfolio (9.10% Madeup Ltd) - Direct Plan - Growth", "Fictiva Credit Risk Segregated Portfolio"],
    ["FICTIVA CREDIT RISK FUND SEGREGATED PORTFOLIO 1 DIRECT PLAN GROWTH", "FICTIVA CREDIT RISK SEGREGATED PORTFOLIO 1"],
    ["FICTIVA CREDIT RISK FUND DIRECT PLAN GROWTH SEGREGATED PORTFOLIO 2", "FICTIVA CREDIT RISK SEGREGATED PORTFOLIO 2"],
    ["Fictiva Credit Risk Fund - Units of Segregated Portfolio 1 - Direct Plan - Growth", "Fictiva Credit Risk Segregated Portfolio 1"],
    ["Fictiva Credit Risk Fund - Direct Plan - Growth (Units of Segregated Portfolio 1)", "Fictiva Credit Risk Segregated Portfolio 1"],
  ]) assert.equal(fundQuery(name), query, name);
});

test("searches a main fund whose name counts its segregated portfolios as a main fund", () => {
  // AMFI's count notes, and singular counts with other spacing or wording.
  for (const [name, search, query] of [
    ["Fictiva Short Term Fund (the scheme has 2 segregated portfolios) - Regular Plan - Defunct Growth", "Fictiva Short Term Fund", "Fictiva Short Term"],
    ["Fictiva Credit Risk Fund (No. of segregated portfolios-3) - Direct Plan - Growth", "Fictiva Credit Risk Fund", "Fictiva Credit Risk"],
    ["Fictiva Credit Risk Fund (no. of segregated portfolios- 2) - Direct Plan - IDCW", "Fictiva Credit Risk Fund", "Fictiva Credit Risk"],
    ["Fictiva Credit Risk Fund (Existing Number of Segregated Portfolios - 1) - Regular Plan - Growth", "Fictiva Credit Risk Fund", "Fictiva Credit Risk"],
    ["Fictiva Ultra Short Bond Fund (no. of segregated portfolio-1) - Direct Plan - Growth", "Fictiva Ultra Short Bond Fund", "Fictiva Ultra Short Bond"],
    ["Fictiva Ultra Short Bond Fund (No.of Segregated Portfolio-1) - Direct Plan - Growth", "Fictiva Ultra Short Bond Fund", "Fictiva Ultra Short Bond"],
    ["Fictiva Credit Risk Fund (Existing Number of Segregated Portfolio - 1) - Regular Plan - Growth", "Fictiva Credit Risk Fund", "Fictiva Credit Risk"],
    ["FICTIVA ULTRA SHORT BOND FUND (NO. OF SEGREGATED PORTFOLIO-1) DIRECT PLAN GROWTH", "FICTIVA ULTRA SHORT BOND FUND DIRECT PLAN GROWTH", "FICTIVA ULTRA SHORT BOND"],
  ]) {
    for (const form of [(text) => text, (text) => text.toUpperCase(), (text) => text.toLowerCase()]) {
      assert.equal(fundName(form(name)), form(search), form(name));
      assert.equal(fundQuery(form(name)), form(query), form(name));
    }
  }
  // A segregated portfolio's own marker after such a note still counts, with its number.
  for (const note of ["(No. of segregated portfolios-3)", "(no. of segregated portfolio-1)"]) {
    const portfolio = `Fictiva Credit Risk Fund ${note} - Segregated Portfolio 2 - Direct Plan - Growth`;
    assert.equal(fundName(portfolio), "Fictiva Credit Risk Fund Segregated Portfolio 2");
    assert.equal(fundQuery(portfolio), "Fictiva Credit Risk Segregated Portfolio 2");
  }
});

test("searches a segregated portfolio named with a dated note, as AMFI names UTI's, with \"Segregated\" and its date", () => {
  // AMFI's form and its spacing variants, after a plan and option too, and a date with separators.
  for (const [name, search, query] of [
    ["Fictiva Credit Risk Fund (Segregated - 15032020)", "Fictiva Credit Risk Fund Segregated - 15032020", "Fictiva Credit Risk Segregated - 15032020"],
    ["Fictiva Credit Risk Fund ( Segregated - 15032020)", "Fictiva Credit Risk Fund Segregated - 15032020", "Fictiva Credit Risk Segregated - 15032020"],
    ["Fictiva Medium Term Fund ( Segregated - 15032020 )", "Fictiva Medium Term Fund Segregated - 15032020", "Fictiva Medium Term Segregated - 15032020"],
    ["Fictiva Credit Risk Fund (Segregated - 15032020) - Direct Plan - Growth", "Fictiva Credit Risk Fund Segregated - 15032020", "Fictiva Credit Risk Segregated - 15032020"],
    ["Fictiva Credit Risk Fund - Direct Plan - Growth (Segregated - 15032020)", "Fictiva Credit Risk Fund Segregated - 15032020", "Fictiva Credit Risk Segregated - 15032020"],
    ["Fictiva Credit Risk Fund (Segregated - 15-03-2020)", "Fictiva Credit Risk Fund Segregated - 15-03-2020", "Fictiva Credit Risk Segregated - 15-03-2020"],
    ["FICTIVA CREDIT RISK FUND (SEGREGATED - 15032020) DIRECT PLAN GROWTH", "FICTIVA CREDIT RISK FUND DIRECT PLAN GROWTH SEGREGATED - 15032020", "FICTIVA CREDIT RISK SEGREGATED - 15032020"],
  ]) {
    for (const form of [(text) => text, (text) => text.toUpperCase(), (text) => text.toLowerCase()]) {
      assert.equal(fundName(form(name)), form(search), form(name));
      assert.equal(fundQuery(form(name)), form(query), form(name));
    }
  }
});

test("keeps other securities' searches whole", () => {
  for (const name of ["Fictiva Growth", "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31", "Fictiva Fund", "Fictiva Direct Plan Growth"]) {
    assert.equal(fundName(name), name);
  }
  // A fund of that name is searched shorter.
  assert.equal(fundQuery("Fictiva Growth"), "Fictiva");
  assert.equal(fundQuery("Fictiva Fund"), "Fictiva");
});

test("reads a name with each control character as a space, repeated spaces as one, trimmed", () => {
  // As casparser reads a real CDSL statement's fund names, with U+0002.
  assert.equal(readableName("FICTIVA ASSET MGMT PVT LTD#FICTIVA MF\u0002 FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH\u0002"),
    "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH");
  // Every C0 control character and U+007F, tabs and line breaks included.
  const controls = [...Array(32).keys(), 0x7f].map((code) => String.fromCharCode(code));
  assert.equal(readableName(`Fictiva${controls.join("")}Fund`), "Fictiva Fund");
  for (const c of controls) assert.equal(readableName(`${c} Fictiva ${c}${c}Fund ${c}`), "Fictiva Fund", c.charCodeAt(0));
  assert.equal(readableName("  Fictiva   Flexi  Cap Fund - Direct Plan  "), "Fictiva Flexi Cap Fund - Direct Plan");
  // Nothing else: an empty name.
  assert.equal(readableName("\u0002 \u0002\t"), "");
  assert.equal(readableName(""), "");
  // Other characters stay as they are.
  assert.equal(readableName("Fictiva\u0080Fund\u00a0– Direct"), "Fictiva\u0080Fund\u00a0– Direct");
  // A trailing U+0002 hides the option from the plan and option's reading until it's read as a space.
  assert.deepEqual(planAndOption("FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH\u0002"), {});
  assert.deepEqual(planAndOption(readableName("FICTIVA FLEXI CAP FUND-DIRECT PLAN-GROWTH\u0002")), { plan: "Direct", option: "Growth" });
});

test("reads the plan and option of every made-up statement's funds", async () => {
  // As the add-on reads them: control characters as spaces.
  const names = [];
  for (const file of ["made-up-cas", "made-up-cas-mismatch", "made-up-cas-no-price", "made-up-cas-segregated", "made-up-summary-cams", "made-up-summary-kfintech"]) {
    const data = JSON.parse(await readFile(`tests/fixtures/${file}.json`, "utf8"));
    names.push(...data.folios.flatMap((f) => f.schemes.map((s) => s.scheme)));
  }
  for (const file of ["made-up-cdsl", "made-up-nsdl"]) {
    const data = JSON.parse(await readFile(`tests/fixtures/${file}.json`, "utf8"));
    names.push(...data.accounts.flatMap((a) => a.mutual_funds.map((f) => readableName(f.name))));
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
    "FICTIVA ASSET MGMT PVT LTD#FICTIVA MF FICTIVA BALANCED ADVANTAGE FUND-DIRECT PLAN-GROWTH": { plan: "Direct", option: "Growth" },
    "TESTBRIDGE AMC LTD#TESTBRIDGE MF-TESTBRIDGE GILT FUND": {},
    "TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH": { plan: "Direct", option: "Growth" },
    // Cut short, as CDSL prints a long name: read as cut only in a CDSL demat account (`mayBeCut`).
    "FICTIVA ASSET MGMT PVT LTD#FICTIVAMF FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES FUND - DIRECT GROW": {},
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
    ["Fictiva Fund (Direct_G)", both("Direct", "Growth")],
    ["Fictiva Fund (G_Direct)", both("Direct", "Growth")],
    ["Fictiva Fund (Direct_Plan_G)", both("Direct", "Growth")],
    ["Fictiva Fund (G_)", { option: "Growth" }],
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

test("reads the plan past AMFI's other option words, and Cumulative as Growth", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    ["Fictiva Short Term Fund - Direct Plan - Discontinued Flexi IDCW", both("Direct", "IDCW")],
    ["Fictiva Short Term Fund - Regular Plan - Discontinued Growth", both("Regular", "Growth")],
    ["Fictiva Short Term Fund - Regular Plan - Discontinued Quarterly Dividend Plan", both("Regular", "IDCW")],
    ["Fictiva Short Term Fund (the scheme has 2 segregated portfolios) - Regular Plan - Defunct Growth", both("Regular", "Growth")],
    ["Fictiva Short Term Fund - Direct Plan - Defunct Weekly IDCW Reinvestment", both("Direct", "IDCW")],
    ["Fictiva Corporate Bond Fund - Direct Plan - Semi Annual IDCW", both("Direct", "IDCW")],
    ["Fictiva Corporate Bond Fund - Regular Plan - Semi-Annual IDCW", both("Regular", "IDCW")],
    ["FICTIVA ARBITRAGE FUND - Direct Plan - Adhoc IDCW Option", both("Direct", "IDCW")],
    ["Fictiva Charity Fund - Regular Plan - 50% IDCW Donation Option", both("Regular", "IDCW")],
    ["Fictiva Charity Fund - Direct Plan - 75% IDCW Donation Option", both("Direct", "IDCW")],
    // Some funds call their Growth option Cumulative.
    ["Fictiva Nifty 50 Index Fund - Direct Plan - Cumulative", both("Direct", "Growth")],
    ["Fictiva Equity Savings Fund - Regular Plan - Cumulative Option", both("Regular", "Growth")],
    // An option that pays out or reinvests.
    ["Fictiva Energy Fund - Direct Plan - IDCW-Payout & Reinvestment", both("Direct", "IDCW")],
    ["Fictiva Energy Fund - Regular Plan - IDCW-PAYOUT & REINVESTMENT", both("Regular", "IDCW")],
    ["Fictiva Energy Fund - Direct Plan - IDCW PAYOUT AND REINVESTMENT", both("Direct", "IDCW")],
    ["Fictiva Energy Fund - Regular Plan - IDCW payout and reinvestment", both("Regular", "IDCW")],
    ["Fictiva Energy Fund - Direct Plan - IDCW Payout aNd Reinvestment", both("Direct", "IDCW")],
    ["Fictiva Energy Fund - Direct Plan - IDCW Payout and Re-InVeSt", both("Direct", "IDCW")],
    ["Fictiva Liquid Fund (Regular Plan - IDCW Reinvestment aNd Payout)", both("Regular", "IDCW")],
    ["FICTIVA ENERGY FUND - DIRECT PLAN - IDCW - PAYOUT-AND-REINVESTMENT", both("Direct", "IDCW")],
    ["Fictiva Energy Fund - Direct Plan - IDCW - Dividend Payout & Reinvestment", both("Direct", "IDCW")],
    ["Fictiva Arbitrage Fund - Regular Plan - IDCW - Payout & Re-investment of Income Distribution cum capital withdrawal option", both("Regular", "IDCW")],
    ["Fictiva Gilt Fund - Direct Plan - Quarterly IDCW Payout and Re-Investment", both("Direct", "IDCW")],
    ["Fictiva Liquid Fund - Regular Plan - Weekly - Reinvestment & Payout of Income Distribution cum Capital Withdrawal Option", both("Regular", "IDCW")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
  // Neither Payout nor Reinvest names the option.
  assert.deepEqual(planAndOption("Fictiva Small Cap Fund - Direct Plan - Payout and Reinvest"), { plan: "Direct" });
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
    ["Fictiva Cumulative Growth Fund - Regular Plan - IDCW", { plan: "Regular", option: "IDCW" }],
    ["Fictiva Semi Annual Income Fund - Growth", { option: "Growth" }],
    ["Fictiva Donation Fund", {}],
    ["Fictiva Life Discontinued Pension Fund", {}],
    // Nor past "and" or "&" outside an option that pays out and reinvests.
    ["Fictiva Banking and PSU Debt Fund - Growth", { option: "Growth" }],
    ["Fictiva Banking & PSU Debt Fund - Direct Plan - IDCW Payout & Reinvestment", { plan: "Direct", option: "IDCW" }],
    ["Fictiva Payout and Reinvestment Fund - Growth", { option: "Growth" }],
    ["Fictiva Savings Regular and Growth", { option: "Growth" }],
    ["Fictiva Savings Direct & Payout", {}],
    ["Fictiva Savings Direct & Payout & Reinvestment", {}],
    // Nor from a word that only looks like one of Yahoo's abbreviations, or a capital inside a word.
    ["Fictiva Regular Savings Mn IDCW-P", { option: "IDCW" }],
    ["Fictiva Annual Interval Instl Gr", { option: "Growth" }],
    ["Fictiva FoF Gr", { option: "Growth" }],
    ["Fictiva DirectEdge Fund", {}],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

test("reads a bare plan word between a named plan and the option as part of the option", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    // Axis calls an IDCW option "Regular IDCW" in both plans.
    ["Fictiva Gilt Fund - Direct Plan - Regular IDCW Option", both("Direct", "IDCW")],
    ["Fictiva Aggressive Hybrid Fund - Direct Plan - Regular IDCW", both("Direct", "IDCW")],
    ["FICTIVA ULTRA SHORT TERM FUND - DIRECT PLAN - REGULAR IDCW OPTION", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Regular Plan - Regular IDCW Option", both("Regular", "IDCW")],
    ["Fictiva Gilt Fund (Direct Plan) - Regular IDCW Option", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund (Direct Plan - Regular IDCW Option)", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund (Direct Plan - Regular) IDCW", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund (Direct Plan - Regular) Growth", both("Direct", "Growth")],
    ["FICTIVA GILT FUND (DIRECT PLAN - REGULAR) (IDCW)", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Direct (Plan) - Regular IDCW Option", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund (Direct) Plan - Regular IDCW Option", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Direct Plan - Regular IDCW (Option)", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Direct Plan A - Regular IDCW", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Regular Plan B - Direct IDCW", both("Regular", "IDCW")],
    // Others repeat their own plan.
    ["Fictiva Liquid Fund - Regular Plan - Regular IDCW", both("Regular", "IDCW")],
    ["Fictiva Liquid Fund - Direct Plan - Direct IDCW", both("Direct", "IDCW")],
    ["Fictiva Focused Fund - Direct Plan - Direct - IDCW", both("Direct", "IDCW")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

test("still reads a bare plan word as the plan without a named plan before it", () => {
  const both = (plan, option) => ({ plan, option });
  for (const [name, expected] of [
    ["Fictiva Aggressive Hybrid Fund Reg IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Focused Reg IDCW-P", both("Regular", "IDCW")],
    ["Fictiva Ultra Short Term Fd Dir IDCW-P", both("Direct", "IDCW")],
    ["Fictiva Gilt Fund - Regular IDCW Option", both("Regular", "IDCW")],
    ["Fictiva Gilt Fund (Regular IDCW Option)", both("Regular", "IDCW")],
    ["Fictiva Gilt Fund (Direct) - IDCW", both("Direct", "IDCW")],
    // Nor from the fund's own name, past a word that isn't a plan or option.
    ["Fictiva Regular Savings Fund - Direct IDCW", both("Direct", "IDCW")],
    ["Fictiva Direct Opportunities Fund - Regular IDCW", both("Regular", "IDCW")],
    ["Fictiva Fixed Maturity Plan Dir Gr", both("Direct", "Growth")],
    // An earlier option stops the look-back before the fund's own "Regular Plan".
    ["Fictiva Regular Plan Growth Dir IDCW", both("Direct", "IDCW")],
    ["FICTIVA REGULAR PLAN GROWTH DIR IDCW", both("Direct", "IDCW")],
    ["Fictiva Regular Plan Growth (Dir) (IDCW)", both("Direct", "IDCW")],
    ["Fictiva Regular Plan (Growth - Direct) - IDCW", both("Direct", "IDCW")],
    ["Fictiva Regular Plan (Growth Dir IDCW)", both("Direct", "IDCW")],
    ["Fictiva Regular Plan (G - Direct) - IDCW", both("Direct", "IDCW")],
  ]) assert.deepEqual(planAndOption(name), expected, name);
});

// A made-up CDSL demat fund's name `length` characters long that ends in `end`: the fund house's
// company name, "#" and the scheme name, which is cut to fit.
const printed = (length, end) => {
  const scheme = "FICTIVA ASSET MANAGEMENT PVT LTD # FICTIVA TESTBRIDGE GLOBAL PLACEHOLDERS SAMPLES OPPORTUNITIES MULTI ASSET ALLOCATION";
  const name = `${scheme.slice(0, length - end.length).replace(/ $/, "S")}${end}`;
  assert.equal(name.length, length, name);
  return name;
};
const both = (plan, option) => ({ plan, option });

test("takes a name of 100 to 105 characters as one CDSL may have cut short", () => {
  for (const [length, cut] of [[99, false], [100, true], [101, true], [105, true], [106, false]]) {
    assert.equal(mayBeCut(printed(length, " FUND - DIRECT GROW")), cut, String(length));
  }
  // Counted with each run of spaces as one, as casparser joins a name's lines.
  assert.equal(mayBeCut(` ${printed(99, " FUND -  DIRECT GROW")}\n`), false);
  assert.equal(mayBeCut(printed(101, " FUND -  DIRECT GROW")), true);
});

test("reads a plan or option word cut short at the end of a name CDSL may have cut", () => {
  for (const length of [100, 101]) {
    for (const [end, expected] of [
      // The real statement's ending, cut from "- DIRECT GROWTH".
      [" FUND - DIRECT GROW", both("Direct", "Growth")],
      // Cut within each plan word,
      [" FUND - GROWTH - DIREC", both("Direct", "Growth")],
      [" FUND - GROWTH - DIRE", both("Direct", "Growth")],
      [" FUND - IDCW - REGULA", both("Regular", "IDCW")],
      [" FUND - IDCW - REGU", both("Regular", "IDCW")],
      // each option word,
      [" FUND - DIRECT PLAN - GROWT", both("Direct", "Growth")],
      [" FUND - DIRECT PLAN - GRO", both("Direct", "Growth")],
      [" FUND - DIRECT PLAN - CUMULATIV", both("Direct", "Growth")],
      [" FUND - DIRECT PLAN - CU", both("Direct", "Growth")],
      [" FUND - REGULAR PLAN - IDC", both("Regular", "IDCW")],
      [" FUND - REGULAR PLAN - ID", both("Regular", "IDCW")],
      [" FUND - REGULAR PLAN - DIVIDEN", both("Regular", "IDCW")],
      [" FUND - REGULAR PLAN - DIVI", both("Regular", "IDCW")],
      [" FUND - DIRECT PLAN - INCOME DISTRIBUTION CUM CAPITAL WITHDRAWA", both("Direct", "IDCW")],
      [" FUND - DIRECT PLAN - INCOME DISTRIBUTION CUM CAP", both("Direct", "IDCW")],
      // where a phrase's word outruns a word of its own: not Cumulative,
      [" FUND - DIRECT PLAN - INCOME DISTRIBUTION CUM", both("Direct", "IDCW")],
      [" FUND - DIRECT PLAN - INCOME D", both("Direct", "IDCW")],
      // and words read past, like Option, Plan, Monthly or "Payout & Reinvestment".
      [" FUND - DIRECT PLAN - GROWTH OPTI", both("Direct", "Growth")],
      [" FUND - GROWTH - DIRECT PL", both("Direct", "Growth")],
      [" FUND - REGULAR PLAN - IDCW - MONTH", both("Regular", "IDCW")],
      [" FUND - DIRECT PLAN - IDCW PAYOUT & REINV", both("Direct", "IDCW")],
      [" FUND (DIRECT PLAN) GRO", both("Direct", "Growth")],
      [" FUND (DIRECT PLAN GRO", both("Direct", "Growth")],
      [" FUND (DIRECT GRO", both("Direct", "Growth")],
      [" FUND (DIRECT PLAN) (GRO", both("Direct", "Growth")],
      [" FUND - DIRECT PLAN - (INCOME D", both("Direct", "IDCW")],
      [" FUND (GROWTH DIREC", both("Direct", "Growth")],
      [" FUND (REGULAR PLAN IDC", both("Regular", "IDCW")],
      // A dash before it is enough on its own.
      [" FUND - GROW", { option: "Growth" }],
      [" FUND - DIREC", { plan: "Direct" }],
    ]) {
      const name = printed(length, end);
      assert.equal(mayBeCut(name), true, name);
      assert.deepEqual(planAndOption(name, true), expected, name);
    }
  }
});

test("reads a cut name's last word as before when it's whole, or when it could be words that read differently", () => {
  for (const length of [100, 101]) {
    for (const [end, expected] of [
      // Whole words and abbreviations,
      [" FUND - DIRECT GROWTH", both("Direct", "Growth")],
      [" FUND DIR GR", both("Direct", "Growth")],
      [" FUND RG IDCW-P", both("Regular", "IDCW")],
      [" FUND - DIRECT PLAN - R", { plan: "Direct" }],
      [" FUND - DIRECT PLAN - IDCW - PAYOUT & REINVESTMENT", both("Direct", "IDCW")],
      [" FUND (DIRECT PLAN) (GROWTH)", both("Direct", "Growth")],
      // Direct, Dividend or Daily, Discontinued...,
      [" FUND - DIRECT PLAN - D", {}],
      [" FUND - DIRECT PLAN - DI", {}],
      [" FUND - GROWTH - DI", {}],
      // Regular or Reinvestment,
      [" FUND - DIRECT PLAN - IDCW - RE", {}],
      [" FUND - GROWTH - RE", {}],
      // a single letter, which starts too many words of a fund's own name (Gilt, Institutional, Class),
      [" FUND - DIRECT G", {}],
      [" FUND - DIRECT PLAN - I", {}],
      [" FUND - DIRECT PLAN - C", {}],
      // and Income, which a fund's own name has too, without the next word of the IDCW phrase.
      [" FUND - DIRECT PLAN - INCOME", {}],
      [" FUND - DIRECT PLAN - INCO", {}],
    ]) {
      const name = printed(length, end);
      assert.deepEqual(planAndOption(name, true), expected, name);
      assert.deepEqual(planAndOption(name), expected, name);
    }
  }
});

test("doesn't read a cut word in the fund's own name", () => {
  // Cut from "Fictiva Regular Savings Fund", "Fictiva Growth Opportunities Fund" or "Fictiva Direct
  // Equity Fund": no dash before it, and nothing before it is a plan, option or filler word.
  for (const end of [
    " FICTIVA REGU", " FICTIVA GROW", " FICTIVA DIREC", " JUN 2036 IDC",
    " FICTIVA (INDIA) REGU", " FICTIVA (INDIA) GROW", " FICTIVA (INDIA) DIREC", " FICTIVA (JUN 2036) IDC",
    " FICTIVA (INDIA GROW",
  ]) for (const length of [100, 101]) {
    const name = printed(length, end);
    assert.deepEqual(planAndOption(name, true), {}, name);
  }
});

test("reads a shorter or longer name's last word, or one not marked as cut, as before", () => {
  for (const end of [" FUND - DIRECT GROW", " FUND - REGULAR PLAN - IDC", " FUND - GROWTH - DIRE", " FUND - IDCW - REGU"]) {
    for (const length of [99, 106]) {
      const name = printed(length, end);
      assert.deepEqual(planAndOption(name, mayBeCut(name)), {}, name);
    }
    // Only a fund in a CDSL statement's CDSL demat account is marked as cut.
    assert.deepEqual(planAndOption(printed(100, end)), {}, end);
  }
});

test("a plan or option differs only when both names give it", () => {
  const statement = { plan: "Direct", option: "Growth" };
  assert.equal(differs({ plan: "Regular", option: "Growth" }, statement, "plan"), true);
  assert.equal(differs({ plan: "Regular", option: "Growth" }, statement, "option"), false);
  assert.equal(differs({ plan: "Direct", option: "IDCW" }, statement, "option"), true);
  assert.equal(differs({}, statement, "plan"), false);
  assert.equal(differs({ plan: "Regular" }, { option: "Growth" }, "plan"), false);
  assert.equal(differs({ plan: "Regular" }, undefined, "plan"), false);
});
