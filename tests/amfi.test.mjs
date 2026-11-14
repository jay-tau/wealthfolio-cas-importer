// Which search result the Review screen confirms without a click when Wealthfolio offers AMFI's, and AMFI's state.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { amfiStatus, certain, fromAmfi, pricedElsewhere } from "../src/lib/amfi.ts";

// As Wealthfolio 3.12.0 lists them for a fund's ISIN: Yahoo's listing first, then AMFI's scheme.
const yahoo = { providerId: "YAHOO" };
const amfi = { providerId: "AMFI" };
// An asset Wealthfolio has: one priced from Yahoo or from statements has no provider, one priced
// from AMFI has AMFI's.
const existing = { existingAssetId: "asset-1" };
const existingAmfi = { existingAssetId: "asset-2", providerId: "AMFI" };

test("a fund Wealthfolio prices from another source is told apart from AMFI's", () => {
  assert.equal(pricedElsewhere(existing), true);
  assert.equal(pricedElsewhere(existingAmfi), false);
  assert.equal(pricedElsewhere(amfi), false);
});

test("AMFI results", () => {
  assert.deepEqual([yahoo, amfi, existing, existingAmfi].map(fromAmfi), [false, true, false, true]);
});

test("AMFI's state from Wealthfolio's market data providers", () => {
  // As Wealthfolio 3.13.0 lists them in a new profile, then after AMFI is added.
  const yahooOn = { id: "YAHOO", name: "Yahoo Finance", enabled: true };
  assert.equal(amfiStatus([yahooOn, { id: "AMFI", name: "AMFI", enabled: false }]), "off");
  assert.equal(amfiStatus([{ id: "AMFI", name: "AMFI", enabled: true }, yahooOn]), "on");
  // Without AMFI, without its flag, or not a list of providers, Wealthfolio doesn't say.
  assert.equal(amfiStatus([yahooOn]), "unknown");
  assert.equal(amfiStatus([]), "unknown");
  assert.equal(amfiStatus([{ id: "AMFI", name: "AMFI" }]), "unknown");
  assert.equal(amfiStatus([{ id: "AMFI", enabled: "true" }]), "unknown");
  assert.equal(amfiStatus([null, 3, { id: "AMFI", enabled: true }]), "on");
  for (const value of [undefined, null, {}, "AMFI", { id: "AMFI", enabled: true }]) assert.equal(amfiStatus(value), "unknown");
});

// Which result of the search for a fund's printed ISIN is confirmed without a click.
describe("certain", () => {
  const fits = () => true;
  // Wealthfolio 3.13.0 marks a saved asset found by an identifier, not as a substring, `exactMatch`.
  const scheme = { ...amfi, currency: "INR" };
  const savedScheme = { ...existingAmfi, currency: "INR", exactMatch: true };
  const listing = { ...yahoo, currency: "INR" };

  test("AMFI's scheme for the ISIN, beside other providers' listings", () => {
    assert.equal(certain([listing, scheme], fits), 1);
    assert.equal(certain([scheme], fits), 0);
  });

  test("a saved asset priced from AMFI that the search found by an identifier", () => {
    assert.equal(certain([savedScheme, listing], fits), 0);
    // Saved assets are searched whether or not AMFI is on.
    assert.equal(certain([savedScheme], fits), 0);
  });

  test("not a saved AMFI asset matched only as a substring", () => {
    assert.equal(certain([{ ...savedScheme, exactMatch: undefined }], fits), undefined);
    assert.equal(certain([{ ...savedScheme, exactMatch: false }], fits), undefined);
    assert.equal(certain([{ ...savedScheme, exactMatch: "true" }], fits), undefined);
  });

  test("not without exactly one AMFI result", () => {
    assert.equal(certain([listing], fits), undefined);
    assert.equal(certain([listing, listing], fits), undefined);
    assert.equal(certain([], fits), undefined);
    assert.equal(certain([scheme, scheme], fits), undefined);
    assert.equal(certain([savedScheme, scheme], fits), undefined);
    // Another saved AMFI asset, even one matched only as a substring, can be the same fund.
    assert.equal(certain([{ ...savedScheme, exactMatch: undefined }, scheme], fits), undefined);
  });

  test("not while Wealthfolio has an asset among the results priced from another source", () => {
    assert.equal(certain([{ ...existing, currency: "INR" }, scheme], fits), undefined);
    assert.equal(certain([{ ...existing, currency: "INR", exactMatch: true }, savedScheme], fits), undefined);
  });

  test("only in rupees, as given by the result itself", () => {
    assert.equal(certain([{ ...scheme, currency: undefined }], fits), undefined);
    assert.equal(certain([{ ...scheme, currency: "" }], fits), undefined);
    assert.equal(certain([{ ...scheme, currency: "USD" }], fits), undefined);
    assert.equal(certain([{ ...savedScheme, currency: "USD" }], fits), undefined);
  });

  test("only when `fits` accepts the result, as the plan and option check does", () => {
    assert.equal(certain([listing, scheme], (r) => r !== scheme), undefined);
    assert.equal(certain([listing, scheme], (r) => r === scheme), 1);
  });
});
