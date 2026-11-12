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
