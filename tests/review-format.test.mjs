// The Review screen's dates, units, amounts and the purchase cost a user types.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeOf, grouped, longDate, parseCost, rupees, shortDate, units } from "../src/lib/review-format.ts";

test("dates read as a day, a short month and a year", () => {
  assert.equal(longDate("2026-07-31"), "31 Jul 2026");
  assert.equal(longDate("2025-03-01"), "1 Mar 2025");
  assert.equal(shortDate("2026-07-31"), "31 Jul");
  // Anything else stays as it is.
  assert.equal(longDate("31-Jul-2026"), "31-Jul-2026");
});

test("units and amounts are grouped the Indian way", () => {
  assert.equal(grouped("102310"), "1,02,310");
  assert.equal(grouped("12345678.5"), "1,23,45,678.5");
  assert.equal(grouped("999"), "999");
  assert.equal(grouped("-1000"), "-1,000");
  assert.equal(units("2010.4"), "2,010.400");
  assert.equal(units("1234.5678"), "1,234.5678");
  assert.equal(units("40", 0), "40");
  assert.equal(rupees("102310"), "₹1,02,310");
  assert.equal(rupees("102310.5"), "₹1,02,310.50");
  assert.equal(rupees("41906.00"), "₹41,906");
  assert.equal(rupees("0.25"), "₹0.25");
  // An average cost times units can have many decimals: rounded to paise.
  assert.equal(rupees("39999.99999999999999"), "₹40,000");
  assert.equal(rupees("1234.565"), "₹1,234.57");
  assert.equal(rupees("not a number"), "₹not a number");
});

test("a typed purchase cost is read only when the whole input is an amount", () => {
  for (const [typed, amount] of [
    ["40000", "40000"],
    ["40,000", "40000"],
    ["1,02,310", "102310"],
    ["1,02,310.5", "102310.5"],
    ["102,310.50", "102310.50"],
    ["₹40,000", "40000"],
    ["₹ 40000.25", "40000.25"],
    ["  0.5 ", "0.5"],
    ["007", "7"],
  ]) {
    assert.equal(parseCost(typed), amount, typed);
  }
  // Never part of it: "40O00" isn't ₹40.
  for (const typed of ["40O00", "", " ", "0", "0.00", "-5", "1e5", "40.123", "1,0000", "10,00,0", "₹", "40 000", "Rs 40000", "40000₹", ".5", "5."]) {
    assert.equal(parseCost(typed), undefined, typed);
  }
});

test("shares on Indian exchanges go by the exchange's name", () => {
  assert.deepEqual(exchangeOf("XNSE"), { short: "NSE", long: "National Stock Exchange (NSE)" });
  assert.deepEqual(exchangeOf("XBOM"), { short: "BSE", long: "Bombay Stock Exchange (BSE)" });
  assert.equal(exchangeOf("XNYS"), undefined);
  assert.equal(exchangeOf(null), undefined);
});
