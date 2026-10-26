import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { FundAsset } from "../cas/mapping";
import type { CasFolio, CasScheme } from "../cas/types";
import { sha256 } from "./sha256";

// What the add-on remembers between imports, in Wealthfolio's per-add-on storage, which
// device sync copies to the user's other devices. PANs and folio numbers are stored as
// hashes. There are few enough PANs to try them all, so a hash keeps them out of sight,
// not secret.

type Storage = AddonContext["api"]["storage"];

export const panKey = (pan: string) => `pan:${sha256(`cas-importer pan ${pan.trim().toUpperCase()}`)}`;
export const folioKey = (folio: CasFolio) => `folio:${sha256(`cas-importer folio ${folio.amc}|${folio.folio}`)}`;
/** Funds are found by the printed ISIN, or by the registrar's scheme code when there's none. */
export const fundKey = (scheme: CasScheme) =>
  scheme.isin ? `isin:${scheme.isin}` : `fund:${sha256(`cas-importer fund ${scheme.rta}|${scheme.rta_code}`)}`;

/** A fund the user confirmed, with the name `market.searchTicker` gave it. */
export interface ChosenFund extends FundAsset {
  name: string;
}

export async function readFund(storage: Storage, key: string): Promise<ChosenFund | undefined> {
  try {
    const fund = JSON.parse((await storage.get(key)) ?? "null");
    return typeof fund?.symbol === "string" && typeof fund?.quoteCcy === "string" ? fund : undefined;
  } catch {
    return undefined;
  }
}

export const saveFund = (storage: Storage, key: string, fund: ChosenFund) => storage.set(key, JSON.stringify(fund));

/** The statement password, saved only when the user ticks "Remember". */
export const PASSWORD_SECRET = "statement-password";
