// How the Funds and Holdings cards show a search result or confirmed fund: its name, or what it is
// when its provider didn't name it, where its prices come from, and the codes behind it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codes, listingName, priceSource, unnamed } from "../src/lib/fund-label.ts";

// Made-up results the way Wealthfolio 3.13.0 lists them for an ISIN: AMFI's scheme, with its code as
// its symbol and no exchange, and Yahoo's listing on the Bombay Stock Exchange.
const amfi = { name: "Fictiva Balanced Advantage Fund - Direct Plan - Growth", symbol: "100123", providerSymbol: "100123", providerId: "AMFI", instrumentType: "MUTUALFUND", quoteCcy: "INR", manual: false };
const yahoo = { name: "Fictiva Bal Adv Dir Gr", symbol: "0P0000XXXX", exchangeMic: "XBOM", providerSymbol: "0P0000XXXX.BO", providerId: "YAHOO", instrumentType: "MUTUALFUND", quoteCcy: "INR", manual: false };

test("a named result shows its own name", () => {
  assert.equal(listingName(amfi), amfi.name);
  assert.equal(listingName(yahoo), "Fictiva Bal Adv Dir Gr");
  assert.equal(listingName({ ...yahoo, name: "  Fictiva Bal Adv Dir Gr " }), "Fictiva Bal Adv Dir Gr");
});

test("a result named only by its ticker, with or without the exchange's suffix, or not at all, is unnamed", () => {
  for (const name of ["0P0000XXXX.BO", "0P0000XXXX", "0p0000xxxx.bo", " 0P0000XXXX.BO ", "", "  "]) {
    assert.equal(listingName({ ...yahoo, name }), undefined, JSON.stringify(name));
  }
  // Wealthfolio's symbol carries the suffix and there's no provider symbol, as for a saved asset.
  assert.equal(listingName({ ...yahoo, symbol: "0P0000XXXX.BO", providerSymbol: undefined, name: "0P0000XXXX" }), undefined);
  // Or only the saved name carries the suffix; its exchange identifies that suffix.
  for (const [exchangeMic, suffix] of [["XBOM", ".BO"], ["XNSE", ".NS"], ["XLON", ".L"]]) {
    assert.equal(listingName({ ...yahoo, exchangeMic, providerSymbol: undefined, name: `0p0000xxxx${suffix.toLowerCase()}` }), undefined);
  }
  assert.equal(unnamed({ ...yahoo, name: "0P0000XXXX.BO" }), "Unnamed Yahoo listing (0P0000XXXX.BO)");
  // Without a provider symbol, Wealthfolio's symbol tells it apart.
  assert.equal(unnamed({ ...yahoo, name: "", providerSymbol: undefined }), "Unnamed Yahoo listing (0P0000XXXX)");
  // Another provider's, or one with no provider, isn't called Yahoo's.
  assert.equal(unnamed({ ...yahoo, name: "", providerId: "FAKE" }), "Unnamed listing (0P0000XXXX.BO)");
  assert.equal(unnamed({ ...yahoo, name: "", providerId: undefined, providerSymbol: undefined }), "Unnamed listing (0P0000XXXX)");
  // A name that only starts with the ticker is a name.
  assert.equal(listingName({ ...yahoo, name: "0P0000XXXX Fund" }), "0P0000XXXX Fund");
  // An AMFI scheme named by its code alone is unnamed too, and not Yahoo's.
  assert.equal(listingName({ ...amfi, name: "100123" }), undefined);
  assert.equal(unnamed({ ...amfi, name: "100123" }), "Unnamed listing (100123)");
});

test("dotted names stay whole when compared with a ticker", () => {
  assert.equal(listingName({ ...yahoo, name: "Fictiva.Ltd", symbol: "FICTIVA", providerSymbol: "FICTIVA.BO" }), "Fictiva.Ltd");
  assert.equal(listingName({ ...yahoo, name: "TEST.B", symbol: "TEST.A", providerSymbol: undefined }), "TEST.B");
  assert.equal(listingName({ ...yahoo, name: "TEST.B", symbol: "TEST.B.L", exchangeMic: "XLON", providerSymbol: undefined }), undefined);
  assert.equal(listingName({ ...yahoo, name: "Fictiva", symbol: "FICTIVA.B", exchangeMic: "XNYS", providerSymbol: "FICTIVA-B" }), "Fictiva");
  assert.equal(listingName({ ...yahoo, name: "Fictiva", symbol: "FICTIVA.B", exchangeMic: undefined, providerSymbol: undefined }), "Fictiva");
  // An ISIN is a name unless it is also one of the listing's symbols.
  assert.equal(listingName({ ...amfi, name: "INFZ90K01FC8" }), "INFZ90K01FC8");
  assert.equal(listingName({ ...amfi, name: "INFZ90K01FC8", symbol: "INFZ90K01FC8" }), undefined);
});

test("each result says where its prices come from", () => {
  assert.equal(priceSource(amfi), "AMFI");
  assert.equal(priceSource(yahoo), "Yahoo Finance");
  // Wealthfolio's other providers go by the names its Market data settings give them.
  assert.equal(priceSource({ ...yahoo, providerId: "ALPHA_VANTAGE" }), "Alpha Vantage");
  assert.equal(priceSource({ ...yahoo, providerId: "OPENFIGI" }), "OpenFIGI");
  assert.equal(priceSource({ ...yahoo, providerId: "BOERSE_FRANKFURT" }), "Börse Frankfurt");
  // The browser tests' fake host, and any provider Wealthfolio doesn't name, go by the provider's ID.
  assert.equal(priceSource({ ...yahoo, providerId: "FAKE" }), "FAKE");
  assert.equal(priceSource({ ...yahoo, providerId: "CUSTOM:FICTIVA-NAV" }), "CUSTOM:FICTIVA-NAV");
  for (const providerId of ["constructor", "toString", "__proto__"]) {
    assert.equal(priceSource({ providerId }), providerId);
  }
  // A choice to use the statement's prices has no provider. It's priced by hand too, but says from what.
  assert.equal(priceSource({ symbol: "INEZ91A07012", instrumentType: "BOND", quoteCcy: "INR", name: "Democorp 8.10% NCD", manual: true, statementPrices: true }), "Statement prices");
  assert.equal(priceSource({ providerId: undefined, statementPrices: true }), "Statement prices");
  // A saved asset priced by hand, even one with AMFI or Yahoo preferred for automatic updates.
  assert.equal(priceSource({ ...amfi, manual: true }), "Priced by hand");
  assert.equal(priceSource({ ...yahoo, manual: true }), "Priced by hand");
  assert.equal(priceSource({ providerId: undefined, manual: true }), "Priced by hand");
  // A remembered choice from before providers were kept, or a saved asset with no provider preferred.
  assert.equal(priceSource({ ...yahoo, providerId: undefined, manual: undefined }), "Unknown source");
  assert.equal(priceSource({ ...yahoo, providerId: " ", manual: false }), "Unknown source");
});

test("a result's details list its symbol, exchange, type and currency", () => {
  assert.equal(codes(yahoo), "Symbol 0P0000XXXX · Exchange XBOM · Type MUTUALFUND · Currency INR");
  // AMFI's schemes have no exchange.
  assert.equal(codes(amfi), "Symbol 100123 · Type MUTUALFUND · Currency INR");
  // A non-rupee listing's currency is a warning beside its name and listed here too.
  assert.equal(codes({ symbol: "DMCB", exchangeMic: "XNYS", instrumentType: "EQUITY", quoteCcy: "USD" }), "Symbol DMCB · Exchange XNYS · Type EQUITY · Currency USD");
  assert.equal(codes({ symbol: "X", instrumentType: "", quoteCcy: "INR" }), "Symbol X · Currency INR");
});
