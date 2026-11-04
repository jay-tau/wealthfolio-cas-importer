// Which search result the Funds card preselects when Wealthfolio offers AMFI's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromAmfi, preselected, pricedElsewhere } from "../src/lib/amfi.ts";

// As Wealthfolio 3.12.0 lists them for a fund's ISIN: Yahoo's listing first, then AMFI's scheme.
const yahoo = { providerId: "YAHOO" };
const amfi = { providerId: "AMFI" };
// An asset Wealthfolio has: one priced from Yahoo or from statements has no provider, one priced
// from AMFI has AMFI's.
const existing = { existingAssetId: "asset-1" };
const existingAmfi = { existingAssetId: "asset-2", providerId: "AMFI" };

test("AMFI's result is preselected next to Yahoo's", () => {
  assert.equal(preselected([yahoo, amfi], false), 1);
  assert.equal(preselected([amfi, yahoo, yahoo], false), 0);
  assert.equal(preselected([amfi], false), 0);
});

test("an asset Wealthfolio prices from AMFI is preselected", () => {
  assert.equal(preselected([existingAmfi, yahoo], false), 0);
  // Switching a Yahoo asset's provider keeps its symbol and exchange, so AMFI's separate scheme
  // result can still appear. With two AMFI choices, the user picks one.
  assert.equal(preselected([existingAmfi, amfi], false), undefined);
});

test("AMFI's result isn't preselected when Wealthfolio has the fund priced from another source", () => {
  assert.equal(preselected([existing, amfi], false), undefined);
  assert.equal(pricedElsewhere(existing), true);
  assert.equal(pricedElsewhere(existingAmfi), false);
  assert.equal(pricedElsewhere(amfi), false);
});

test("without AMFI, only a single result is preselected", () => {
  assert.equal(preselected([yahoo], false), 0);
  assert.equal(preselected([existing], false), 0);
  assert.equal(preselected([yahoo, yahoo], false), undefined);
  assert.equal(preselected([], false), undefined);
  assert.equal(preselected([amfi, amfi], false), undefined);
});

test("an automatic name search preselects nothing", () => {
  assert.equal(preselected([yahoo], true), undefined);
  assert.equal(preselected([yahoo, amfi], true), undefined);
});

test("AMFI results", () => {
  assert.deepEqual([yahoo, amfi, existing, existingAmfi].map(fromAmfi), [false, true, false, true]);
});
