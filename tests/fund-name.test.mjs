// The name searched when a fund's printed ISIN finds nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fundName } from "../src/lib/fund-name.ts";

test("keeps the name before the plan and option", () => {
  assert.equal(fundName("Fictiva Flexi Cap Fund - Direct Plan - Growth"), "Fictiva Flexi Cap Fund");
  assert.equal(fundName("Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout"), "Testbridge Corporate Bond Fund");
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
