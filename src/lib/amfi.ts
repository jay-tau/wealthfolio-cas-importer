import type { Asset, SymbolSearchResult } from "@wealthfolio/addon-sdk";

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

/** AMFI's new listing: its scheme, not yet an asset in Wealthfolio. */
const newListing = (result: Result) => fromAmfi(result) && !result.existingAssetId;

/**
 * Whether the results include AMFI's new listing and a saved asset with another preferred provider
 * or none. Using the new listing adds another asset. Using a saved asset reuses it.
 */
export const addsAsset = (results: Result[]) => results.some(newListing) && results.some(pricedElsewhere);

/**
 * Whether the results include AMFI's new listing and a saved asset, of any preferred provider. Using
 * a new listing adds an asset. Using a saved asset reuses it.
 */
export const besideSaved = (results: Result[]) => results.some(newListing) && results.some((result) => !!result.existingAssetId);

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
 * one with AMFI selected, reuses it. A saved asset with AMFI selected beside AMFI's new listing is
 * `savedBesideListing`'s.
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

/**
 * Of the results of the search for a fund's printed ISIN, a saved asset with AMFI selected beside
 * AMFI's new listing, as when a fund's Yahoo listing saved in Wealthfolio was switched to AMFI: the
 * only saved result, beside exactly one new AMFI listing, found by an identifier, quoted in rupees
 * and accepted by `fits`. It's that fund only once its profile says so (`amfiIsin`): any provider's
 * mapping can find it, and two funds can share a plan and option.
 */
export function savedBesideListing<R extends Result & Pick<SymbolSearchResult, "currency">>(
  results: R[],
  fits: (result: R) => boolean,
): number | undefined {
  const saved = results.flatMap((result, i) => (result.existingAssetId ? [i] : []));
  if (saved.length !== 1 || results.filter(newListing).length !== 1) return undefined;
  const result = results[saved[0]];
  return fromAmfi(result) && exactMatch(result) && result.currency === "INR" && fits(result) ? saved[0] : undefined;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

// Match AMFI's Rust parser, which trims Unicode whitespace and folds only ASCII letters.
const isinCode = (value: unknown) => typeof value === "string"
  ? /^\p{White_Space}*([A-Za-z]{2}[A-Za-z0-9]{9}[0-9])\p{White_Space}*$/u.exec(value)?.[1].toUpperCase()
  : undefined;

/**
 * Whether a saved asset's profile makes it the fund with this ISIN on AMFI: AMFI is its preferred
 * provider, and both its own ISIN (General → ISIN in Wealthfolio's asset editor) and its AMFI mapping
 * (Market data) are this ISIN. Wealthfolio 3.13.1 keeps the two apart, so either alone can name
 * another fund.
 */
export function amfiIsin(asset: Pick<Asset, "providerConfig" | "metadata"> | null | undefined, isin: string) {
  const expected = isinCode(isin);
  const config = field(asset, "providerConfig");
  const mapping = field(field(config, "overrides"), AMFI);
  return expected !== undefined && field(config, "preferred_provider") === AMFI && field(mapping, "type") === "equity_symbol" &&
    isinCode(field(mapping, "symbol")) === expected &&
    isinCode(field(field(field(asset, "metadata"), "identifiers"), "isin")) === expected;
}
