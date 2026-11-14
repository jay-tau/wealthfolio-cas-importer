import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";
import { statementSymbol } from "../cas/holdings";
import type { CasData, CasScheme } from "../cas/types";
import { type ChosenFund, fundKey } from "../lib/choices";

// A statement's funds and shares to confirm, and the choices made for them.

/** Undefined while undecided. */
export type FundChoice = { fund: ChosenFund } | { leftOut: true };

/** The import fields the way Wealthfolio's own import builds them from a search result. */
export function toFund(result: SymbolSearchResult): ChosenFund {
  const mode = result as SymbolSearchResult & { pricingMode?: string | null; quoteMode?: string | null };
  return {
    assetId: result.existingAssetId,
    symbol: (result.canonicalSymbol || result.symbol).trim().toUpperCase(),
    exchangeMic: result.canonicalExchangeMic || result.exchangeMic,
    // Statements are in rupees; a result without a currency is taken to be one too.
    quoteCcy: result.currency || "INR",
    instrumentType: result.quoteType,
    providerId: result.providerId,
    providerSymbol: result.providerSymbol,
    name: result.longName || result.shortName || result.symbol,
    manual: (mode.pricingMode ?? mode.quoteMode) === "MANUAL",
  };
}

/** The currency of the statement and its imported activities and snapshot holdings. */
const RUPEES = "INR";

/**
 * Why an asset quoted in another currency than the statement's rupees needs checking, or undefined
 * for one quoted in rupees: Wealthfolio values the units at the chosen listing's price, in its currency.
 */
export const otherCurrency = (quoteCcy: string | undefined, asset = "this asset") =>
  quoteCcy && quoteCcy !== RUPEES
    ? `The statement's prices and amounts are in rupees, but ${asset} is quoted in ${quoteCcy}. Check that it's the right listing.`
    : undefined;

/** The statement's funds, one entry per fund however many folios hold it. */
export function fundsOf(data: CasData) {
  const funds = new Map<string, CasScheme[]>();
  for (const scheme of data.folios.flatMap((f) => f.schemes)) {
    const key = fundKey(scheme);
    funds.set(key, [...(funds.get(key) ?? []), scheme]);
  }
  return funds;
}

/** A fund or share to confirm, however many lines of the statement hold it. */
export interface FundItem {
  key: string;
  isin: string | null;
  /**
   * As printed, without a CDSL folio's leading scheme code or a CDSL demat fund's fund house, and with
   * control characters as spaces (`readableName`).
   */
  name: string;
  /** The name can end partway through a word, as a CDSL demat account cuts a long one short. */
  cut?: boolean;
  noun: "fund" | "share" | "bond" | "NPS scheme";
  /** Where else the statement lists it, e.g. "in 2 folios". */
  where?: string;
  /** The asset priced by hand from statements, offered when no search result fits. */
  statementAsset?: ChosenFund;
  /**
   * A detailed statement's fund: the symbol of its asset that holdings imports price from statements.
   * Detailed imports don't use that asset, so the search doesn't offer it.
   */
  statementSymbol?: string;
}

export const fundItems = (data: CasData): FundItem[] =>
  [...fundsOf(data)].map(([key, schemes]) => ({
    key,
    isin: schemes[0].isin,
    name: schemes[0].scheme,
    noun: "fund",
    where: schemes.length > 1 ? `in ${schemes.length} folios` : undefined,
    statementSymbol: statementSymbol(schemes[0]),
  }));;
