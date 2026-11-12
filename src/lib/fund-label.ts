import { AMFI } from "./amfi.ts";
import type { ChosenFund } from "./choices";

/** Wealthfolio's ID for Yahoo Finance. */
export const YAHOO = "YAHOO";

/**
 * Wealthfolio 3.13.0's built-in providers by the names its Market data settings give them. Others,
 * such as a custom provider's `CUSTOM:` code, go by their ID.
 */
const PROVIDERS = new Map([
  [AMFI, "AMFI"],
  [YAHOO, "Yahoo Finance"],
  ["MARKETDATA_APP", "MarketData.app"],
  ["ALPHA_VANTAGE", "Alpha Vantage"],
  ["FINNHUB", "Finnhub"],
  ["US_TREASURY_CALC", "US Treasury (Calculated)"],
  ["BOERSE_FRANKFURT", "Börse Frankfurt"],
  // Finds bonds, and doesn't price them: a numeric search, such as an AMFI scheme code, lists many.
  ["OPENFIGI", "OpenFIGI"],
  ["METAL_PRICE_API", "Metal Price API"],
  ["MOEX", "Moscow Exchange"],
  ["CUSTOM_SCRAPER", "Custom Provider"],
]);

/** Recognized exchange suffixes; a dot in a name or share-class symbol alone isn't evidence of one. */
const SUFFIXES = new Map([["XBOM", ".BO"], ["XNSE", ".NS"], ["XLON", ".L"]]);

type Fund = Pick<ChosenFund, "name" | "symbol" | "exchangeMic" | "providerSymbol" | "providerId">;

/**
 * A search result's or confirmed fund's name, or undefined when its provider gave it none: an empty
 * name, or only its symbol, with or without an exchange suffix.
 */
export function listingName(fund: Fund): string | undefined {
  const name = fund.name.trim();
  if (!name) return undefined;
  const own = name.toUpperCase();
  // Saved assets can keep a Yahoo name but no provider symbol; use their exchange's suffix.
  const suffix = SUFFIXES.get(fund.exchangeMic ?? "");
  return [fund.symbol, fund.providerSymbol].some((symbol) => {
    const ticker = symbol?.trim().toUpperCase();
    return ticker && (ticker === own || (suffix && (ticker === own + suffix || own === ticker + suffix)));
  }) ? undefined : name;
}

/** What a listing without a name is shown as: the kind, and the ticker that tells it apart from others. */
export const unnamed = (fund: Fund) =>
  `${fund.providerId === YAHOO ? "Unnamed Yahoo listing" : "Unnamed listing"} (${fund.providerSymbol || fund.symbol})`;

/** Where a search result's or confirmed fund's prices come from. */
export function priceSource(fund: Pick<ChosenFund, "providerId" | "manual" | "statementPrices">) {
  if (fund.statementPrices) return "Statement prices";
  // A saved asset priced by hand keeps the provider preferred for automatic updates, which are off.
  if (fund.manual) return "Priced by hand";
  const provider = fund.providerId?.trim();
  return provider ? (PROVIDERS.get(provider) ?? provider) : "Unknown source";
}

/** The codes behind a search result or confirmed fund, for its Details. */
export const codes = (fund: Pick<ChosenFund, "symbol" | "exchangeMic" | "instrumentType" | "quoteCcy">) =>
  [
    `Symbol ${fund.symbol}`,
    fund.exchangeMic && `Exchange ${fund.exchangeMic}`,
    fund.instrumentType && `Type ${fund.instrumentType}`,
    `Currency ${fund.quoteCcy}`,
  ]
    .filter(Boolean)
    .join(" · ");
