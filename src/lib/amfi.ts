import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";

/**
 * Wealthfolio's price source for Indian funds' daily NAVs. It's off until added in
 * Settings → Market data, and its search answers only an exact ISIN or AMFI scheme code.
 */
export const AMFI = "AMFI";

type Result = Pick<SymbolSearchResult, "providerId" | "existingAssetId">;

/** AMFI's search result, or an asset with AMFI selected, even if automatic updates are off. */
export const fromAmfi = (result: Result) => result.providerId === AMFI;

/** A saved asset with a preferred provider other than AMFI, or with no preferred provider. */
export const pricedElsewhere = (result: Result) => !!result.existingAssetId && !fromAmfi(result);

/**
 * Whether the results include AMFI's new listing and a saved asset with another preferred provider
 * or none. Using the new listing adds another asset. Using a saved asset reuses it.
 */
export const addsAsset = (results: Result[]) =>
  results.some((result) => fromAmfi(result) && !result.existingAssetId) && results.some(pricedElsewhere);

/** Whether AMFI is on in Wealthfolio's Settings → Market data, or "unknown" when Wealthfolio doesn't say. */
export type AmfiStatus = "on" | "off" | "unknown";

/**
 * AMFI's state from Wealthfolio's market data providers. Wealthfolio 3.13.0 lists every provider
 * with an `enabled` flag, which the SDK's type doesn't declare, so a list without AMFI, an AMFI entry
 * without the flag, or anything else that isn't such a list, is "unknown".
 */
export function amfiStatus(providers: unknown): AmfiStatus {
  if (!Array.isArray(providers)) return "unknown";
  const amfi: unknown = providers.find((provider) => (provider as { id?: unknown } | null)?.id === AMFI);
  const enabled = (amfi as { enabled?: unknown } | undefined)?.enabled;
  return typeof enabled === "boolean" ? (enabled ? "on" : "off") : "unknown";
}

/**
 * A saved asset the search found by one of its identifiers, not because its symbol or name merely
 * contains the query. Wealthfolio 3.13.0 marks it `exactMatch`; the SDK's type doesn't declare it.
 */
const exactMatch = (result: Result) => (result as { exactMatch?: unknown }).exactMatch === true;

/**
 * Of the results of the search for a fund's printed ISIN, the one that's certainly that fund: the
 * only AMFI result, either AMFI's own (AMFI answers only an exact ISIN or scheme code) or a saved
 * asset the search found by an identifier, quoted in rupees and accepted by `fits`. None while
 * the results include a saved asset with another preferred provider or none. The user chooses
 * which result to use. Using AMFI's new listing adds another asset. Using a saved asset, including
 * one with AMFI selected, reuses it.
 */
export function certain<R extends Result & Pick<SymbolSearchResult, "currency">>(
  results: R[],
  fits: (result: R) => boolean,
): number | undefined {
  const amfi = results.flatMap((result, i) => (fromAmfi(result) ? [i] : []));
  if (amfi.length !== 1 || results.some(pricedElsewhere)) return undefined;
  const result = results[amfi[0]];
  if (result.existingAssetId && !exactMatch(result)) return undefined;
  return result.currency === "INR" && fits(result) ? amfi[0] : undefined;
}
