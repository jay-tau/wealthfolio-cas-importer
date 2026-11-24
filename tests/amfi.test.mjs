// Which search result the Review screen confirms without a click when Wealthfolio offers AMFI's, and AMFI's state.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addsAsset, amfiIsin, amfiStatus, besideSaved, certain, fromAmfi, pricedElsewhere, savedBesideListing } from "../src/lib/amfi.ts";

// As Wealthfolio 3.12.0 lists them for a fund's ISIN: Yahoo's listing first, then AMFI's scheme.
const yahoo = { providerId: "YAHOO" };
const amfi = { providerId: "AMFI" };
// Saved assets can specify a preferred provider or leave it to Wealthfolio.
const existing = { existingAssetId: "asset-1" };
const existingYahoo = { ...existing, providerId: "YAHOO" };
const existingAmfi = { existingAssetId: "asset-2", providerId: "AMFI" };
const manualAmfi = { ...existingAmfi, quoteMode: "MANUAL", dataSource: "MANUAL" };

test("a fund Wealthfolio prices from another source is told apart from AMFI's", () => {
  assert.equal(pricedElsewhere(existing), true);
  assert.equal(pricedElsewhere(existingAmfi), false);
  assert.equal(pricedElsewhere(amfi), false);
});

test("AMFI results", () => {
  assert.deepEqual([yahoo, amfi, existing, existingAmfi].map(fromAmfi), [false, true, false, true]);
});

test("only AMFI's new listing adds another asset beside a saved asset with another preferred provider or none", () => {
  assert.equal(addsAsset([existingYahoo, amfi]), true);
  assert.equal(addsAsset([existing, amfi]), true);
  // Even beside a saved asset with AMFI selected, which adds none.
  assert.equal(addsAsset([existing, existingAmfi, amfi]), true);
  assert.equal(addsAsset([existing, existingAmfi]), false);
  assert.equal(addsAsset([existingAmfi, amfi]), false);
  assert.equal(addsAsset([manualAmfi, amfi]), false);
  assert.equal(addsAsset([yahoo, amfi]), false);
  assert.equal(addsAsset([existing, yahoo]), false);
  assert.equal(addsAsset([]), false);
});

test("AMFI's new listing beside a saved asset of any preferred provider (#376)", () => {
  assert.equal(besideSaved([existingAmfi, amfi]), true);
  assert.equal(besideSaved([existing, amfi]), true);
  assert.equal(besideSaved([yahoo, manualAmfi, amfi]), true);
  assert.equal(besideSaved([existingAmfi, yahoo]), false);
  assert.equal(besideSaved([existing, existingAmfi]), false);
  assert.equal(besideSaved([yahoo, amfi]), false);
  assert.equal(besideSaved([]), false);
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

// #376: a fund's saved Yahoo listing switched to AMFI, which the search for its ISIN finds beside AMFI's new listing.
describe("savedBesideListing", () => {
  const fits = () => true;
  const scheme = { ...amfi, currency: "INR" };
  const switched = { existingAssetId: "switched", providerId: "AMFI", currency: "INR", exactMatch: true };
  const listing = { ...yahoo, currency: "INR" };

  test("the only saved result, with AMFI selected, beside one new AMFI listing and other providers' listings", () => {
    assert.equal(savedBesideListing([switched, scheme], fits), 0);
    assert.equal(savedBesideListing([listing, scheme, switched], fits), 2);
    // `certain` leaves it to this: there are two AMFI results.
    assert.equal(certain([switched, scheme], fits), undefined);
  });

  test("not beside another saved asset, whatever its provider", () => {
    assert.equal(savedBesideListing([switched, { ...switched, existingAssetId: "other" }, scheme], fits), undefined);
    assert.equal(savedBesideListing([switched, { ...existingYahoo, currency: "INR", exactMatch: true }, scheme], fits), undefined);
    assert.equal(savedBesideListing([switched, { ...existing, currency: "INR" }, scheme], fits), undefined);
  });

  test("not without exactly one new AMFI listing", () => {
    assert.equal(savedBesideListing([switched], fits), undefined);
    assert.equal(savedBesideListing([switched, listing], fits), undefined);
    assert.equal(savedBesideListing([switched, scheme, { ...scheme, symbol: "other" }], fits), undefined);
  });

  test("not a saved asset with another provider or none, beside AMFI's new listing", () => {
    assert.equal(savedBesideListing([{ ...switched, providerId: "YAHOO" }, scheme], fits), undefined);
    assert.equal(savedBesideListing([{ ...switched, providerId: undefined }, scheme], fits), undefined);
  });

  test("keeps the checks on an identifier match, rupees and `fits`", () => {
    for (const exactMatch of [undefined, false, "true"]) assert.equal(savedBesideListing([{ ...switched, exactMatch }, scheme], fits), undefined);
    for (const currency of [undefined, "", "USD"]) assert.equal(savedBesideListing([{ ...switched, currency }, scheme], fits), undefined);
    assert.equal(savedBesideListing([switched, scheme], (r) => r !== switched), undefined);
    assert.equal(savedBesideListing([switched, scheme], (r) => r === switched), 0);
  });
});

describe("amfiIsin", () => {
  const isin = "INFZ90K01LQ6";
  // As Wealthfolio 3.13.1's asset editor saves AMFI as the preferred provider, its mapping, and the ISIN under General.
  const profile = (preferred, mapped, own) => ({
    providerConfig: { preferred_provider: preferred, overrides: { AMFI: { type: "equity_symbol", symbol: mapped } } },
    metadata: { identifiers: { isin: own } },
  });

  test("AMFI selected, mapped to the ISIN, and the ISIN as the asset's own", () => {
    assert.equal(amfiIsin(profile("AMFI", isin, isin), isin), true);
    assert.equal(amfiIsin(profile("AMFI", ` ${isin.toLowerCase()} `, isin.toLowerCase()), isin), true);
  });

  test("not when either setting names another fund or is missing", () => {
    assert.equal(amfiIsin(profile("AMFI", isin, "INFZ90K01FC8"), isin), false);
    assert.equal(amfiIsin(profile("AMFI", "INFZ90K01FC8", isin), isin), false);
    // AMFI mapped to a scheme code rather than the ISIN.
    assert.equal(amfiIsin(profile("AMFI", "123456", isin), isin), false);
    assert.equal(amfiIsin({ ...profile("AMFI", isin, isin), metadata: {} }, isin), false);
    assert.equal(amfiIsin({ ...profile("AMFI", isin, isin), metadata: null }, isin), false);
    assert.equal(amfiIsin({ ...profile("AMFI", isin, isin), providerConfig: { preferred_provider: "AMFI" } }, isin), false);
    assert.equal(amfiIsin({ ...profile("AMFI", isin, isin), providerConfig: { preferred_provider: "AMFI", overrides: { YAHOO: { type: "equity_symbol", symbol: isin } } } }, isin), false);
  });

  test("not with another preferred provider or none", () => {
    assert.equal(amfiIsin(profile("YAHOO", isin, isin), isin), false);
    assert.equal(amfiIsin(profile(undefined, isin, isin), isin), false);
    assert.equal(amfiIsin(profile(" AMFI ", isin, isin), isin), false);
  });

  test("AMFI accepts only an equity symbol mapping, even if another type gives an exact alias match", () => {
    for (const type of [undefined, "crypto_symbol"]) {
      const asset = profile("AMFI", isin, isin);
      asset.providerConfig.overrides.AMFI.type = type;
      assert.equal(amfiIsin(asset, isin), false);
    }
  });

  test("ISINs use AMFI's ASCII letters and whitespace rules", () => {
    assert.equal(amfiIsin(profile("AMFI", `\u0085${isin.toLowerCase()}\u0085`, isin), isin), true);
    for (const invalid of [`\u0131${isin.slice(1).toLowerCase()}`, `\uFEFF${isin}`]) {
      assert.equal(amfiIsin(profile("AMFI", invalid, isin), isin), false);
      assert.equal(amfiIsin(profile("AMFI", isin, invalid), isin), false);
    }
  });

  test("not from a profile that isn't one", () => {
    for (const value of [undefined, null, {}, "AMFI", { providerConfig: null, metadata: null }]) assert.equal(amfiIsin(value, isin), false);
  });
});
