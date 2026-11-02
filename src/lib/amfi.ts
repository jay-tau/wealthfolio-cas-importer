import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";

/**
 * Wealthfolio's price source for Indian funds' daily NAVs. It's off until added in
 * Settings → Market data, and its search answers only an exact ISIN or AMFI scheme code.
 */
export const AMFI = "AMFI";

type Result = Pick<SymbolSearchResult, "providerId" | "existingAssetId">;

/** AMFI's search result, or an asset with AMFI selected, even if automatic updates are off. */
export const fromAmfi = (result: Result) => result.providerId === AMFI;

/** An asset Wealthfolio already has, priced from another source. */
export const pricedElsewhere = (result: Result) => !!result.existingAssetId && !fromAmfi(result);

/**
 * The result to preselect: AMFI's when there's one, unless Wealthfolio already has the fund priced
 * from another source, since picking AMFI's would add a second asset for it. Otherwise the only
 * result. An automatic name search preselects nothing: the shorter name can match other plans and options.
 */
export function preselected(results: Result[], byName: boolean): number | undefined {
  if (byName) return undefined;
  const amfi = results.flatMap((result, i) => (fromAmfi(result) ? [i] : []));
  if (amfi.length === 1 && !results.some(pricedElsewhere)) return amfi[0];
  return results.length === 1 ? 0 : undefined;
}
