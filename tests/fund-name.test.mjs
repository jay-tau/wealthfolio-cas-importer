// The name searched when a fund's printed ISIN finds nothing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fundName } from "../src/lib/fund-name.ts";

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
