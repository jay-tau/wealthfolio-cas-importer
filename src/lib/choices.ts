import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { Source, StatementHolding } from "../cas/holdings";
import type { FundAsset } from "../cas/mapping";
import type { CasFolio, CasScheme } from "../cas/types";
import { sha256 } from "./sha256.ts";

// What the add-on remembers between imports, in Wealthfolio's per-add-on storage, which
// device sync copies to the user's other devices. PANs and folio numbers are stored as
// hashes. There are few enough PANs to try them all, so a hash keeps them out of sight,
// not secret.

type Storage = AddonContext["api"]["storage"];

export const panKey = (pan: string) => `pan:${sha256(`cas-importer pan ${pan.trim().toUpperCase()}`)}`;
export const folioKey = (folio: CasFolio) => `folio:${sha256(`cas-importer folio ${folio.amc}|${folio.folio}`)}`;
/** The bank account for a PAN's or folio's cash, keyed by `panKey` or `folioKey`, or `NO_BANK`. */
export const bankKey = (key: string) => `bank-${key}`;
/** A folio's cash comes from and goes outside Wealthfolio, whatever its PAN's bank account. */
export const NO_BANK = "outside";
/** Funds are found by the printed ISIN, or by the registrar's scheme code when there's none. */
export const fundKey = (scheme: CasScheme) => holdingKey({ isin: scheme.isin, rta: scheme.rta, rtaCode: scheme.rta_code });

/** A holding on any statement; the same key as `fundKey` for the same scheme. NPS schemes go by their symbol. */
export const holdingKey = (h: Pick<StatementHolding, "isin" | "rta" | "rtaCode" | "code">) =>
  h.isin
    ? `isin:${h.isin}`
    : h.code
      ? `nps:${sha256(`cas-importer nps ${h.code}`)}`
      : `fund:${sha256(`cas-importer fund ${h.rta}|${h.rtaCode}`)}`;

// Holdings imports keep their own account choices: accounts that track holdings, not the
// PAN's or folio's account for transactions.

/** The account a summary or depository statement's folios and demat accounts go to by default. */
export const investorKey = (investor: string) => `holdings-investor:${sha256(`cas-importer holdings investor ${investor}`)}`;
/** The account a folio, demat account or PRAN goes to, or `LEFT_OUT`. */
export const sourceKey = (source: Source) => `holdings-source:${sha256(`cas-importer holdings source ${source.id}`)}`;
export const LEFT_OUT = "left-out";

/** Imports by snapshot date: `fundRef` → the printed ISIN and/or registrar's scheme code. */
const importedKey = (id: string, accountId: string) =>
  `holdings-imported:${sha256(`cas-importer holdings imported ${id}|${accountId}`)}`;

type ImportedRefs = Record<string, string[]>;
type ImportEntry = { savedAt: number; refs: ImportedRefs };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toJSON()?.slice(0, 10) === date;

async function importedHistory(storage: Storage, source: Source, accountId: string) {
  const keys = new Set([source.id, ...(source.aliases ?? [])].map((id) => importedKey(id, accountId)));
  const initial = new Set(keys);
  const dates: Record<string, ImportEntry> = {};
  for (const key of keys) {
    const raw = await storage.get(key);
    let stored: unknown;
    try {
      stored = JSON.parse(raw ?? "null");
    } catch {
      continue;
    }
    if (!record(stored)) continue;
    // A mixed-issuer summary can sever a link while its old counterpart still remembers it.
    if (!initial.has(key) && (!Array.isArray(stored.aliases) || !stored.aliases.some((alias) => initial.has(alias)))) {
      keys.delete(key);
      continue;
    }
    if (source.aliases?.length !== 0 && Array.isArray(stored.aliases)) {
      for (const alias of stored.aliases) {
        if (typeof alias === "string" && /^holdings-imported:[a-f0-9]{64}$/.test(alias)) keys.add(alias);
      }
    }
    if (!record(stored.dates)) continue;
    for (const [date, entry] of Object.entries(stored.dates)) {
      if (
        !validDate(date) || !record(entry) || !Number.isSafeInteger(entry.savedAt) || (entry.savedAt as number) < 0 ||
        !record(entry.refs) || !Object.values(entry.refs).every((refs) => Array.isArray(refs) && refs.every((ref) => typeof ref === "string"))
      ) continue;
      const next = entry as ImportEntry;
      const previous = dates[date];
      if (!previous || next.savedAt > previous.savedAt) dates[date] = next;
      else if (next.savedAt === previous.savedAt) {
        // Conflicting device writes at the same time must not invent removals.
        dates[date] = {
          savedAt: next.savedAt,
          refs: Object.fromEntries(Object.entries(previous.refs).flatMap(([ref, securities]) => {
            const other = next.refs[ref];
            const agreed = Array.isArray(other) && securities.every((id) => other.includes(id)) && other.every((id) => securities.includes(id));
            return agreed && securities.length ? [[ref, securities]] : [];
          })),
        };
      }
    }
  }
  return { keys, dates };
}

export async function readImported(storage: Storage, source: Source, accountId: string, baseDate: string | null): Promise<Map<string, string[]>> {
  if (baseDate === null) return new Map();
  try {
    const { dates } = await importedHistory(storage, source, accountId);
    const date = Object.keys(dates).filter((date) => date <= baseDate).sort().at(-1);
    return new Map(Object.entries(date ? dates[date].refs : {}));
  } catch {
    return new Map();
  }
}

export async function saveImported(storage: Storage, source: Source, accountId: string, date: string, refs: ImportedRefs) {
  const { keys, dates } = await importedHistory(storage, source, accountId);
  const savedAt = Math.max(Date.now(), ...Object.values(dates).map((entry) => entry.savedAt + 1));
  dates[date] = { savedAt, refs };
  const value = JSON.stringify({ aliases: [...keys], dates });
  for (const key of keys) await storage.set(key, value);
}

/** A fund the user confirmed, with the name `market.searchTicker` gave it, or a holding priced from statements. */
export interface ChosenFund extends FundAsset {
  assetId?: string;
  name: string;
  /** Wealthfolio's pricing mode at the time; looked up again for each import, so not stored. */
  manual?: boolean;
  statementPrices?: boolean;
}

export async function readFund(storage: Storage, key: string): Promise<ChosenFund | undefined> {
  try {
    const fund = JSON.parse((await storage.get(key)) ?? "null");
    if (typeof fund?.symbol !== "string" || typeof fund?.quoteCcy !== "string") return undefined;
    const { manual, ...choice } = fund;
    return choice;
  } catch {
    return undefined;
  }
}

export const saveFund = (storage: Storage, key: string, fund: ChosenFund) => {
  const { manual, ...choice } = fund;
  return storage.set(key, JSON.stringify(choice));
};

/** The statement password, saved only when the user ticks "Remember". */
export const PASSWORD_SECRET = "statement-password";
