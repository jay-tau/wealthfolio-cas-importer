import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { Source, StatementHolding, Unlisted } from "../cas/holdings";
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

/**
 * The key of a holding's confirmed choice, from one of the identifiers an import recorded for it
 * (`security`): its ISIN, its registrar and scheme code, or its NPS symbol.
 */
export function securityKey(id: string) {
  const at = id.indexOf("|");
  if (at < 0) return holdingKey({ isin: id, rta: null, rtaCode: null });
  const [prefix, rest] = [id.slice(0, at), id.slice(at + 1)];
  return prefix === "nps" ? holdingKey({ isin: null, rta: null, rtaCode: null, code: rest }) : holdingKey({ isin: null, rta: prefix, rtaCode: rest });
}

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
type History = { keys: Set<string>; dates: Record<string, ImportEntry> };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toJSON()?.slice(0, 10) === date;
const IMPORTED = /^holdings-imported:[a-f0-9]{64}$/;

/** A source's own keys: its ID's and its issuer-scoped aliases'. */
const keysOf = (source: Source, accountId: string) => [source.id, ...(source.aliases ?? [])].map((id) => importedKey(id, accountId));

/** The history shared by `start` and the keys their records link, followed unless `follow` is false. */
async function importedHistory(storage: Storage, start: string[], follow: boolean, indexed = false): Promise<History> {
  const keys = new Set(start);
  const initial = new Set(keys);
  const siblings = new Set(keys);
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
    if (indexed && initial.has(key) && Array.isArray(stored.aliases)) {
      for (const alias of stored.aliases) if (typeof alias === "string" && IMPORTED.test(alias)) siblings.add(alias);
    }
    // A mixed-issuer summary can sever a link while its old counterpart still remembers it.
    // A failed alias write can leave older copies linked only to each other; a severed one links only itself.
    if (!initial.has(key) && (!Array.isArray(stored.aliases) || !stored.aliases.some((alias) =>
      initial.has(alias) || (indexed && alias !== key && siblings.has(alias))))) {
      keys.delete(key);
      continue;
    }
    if (follow && Array.isArray(stored.aliases)) {
      for (const alias of stored.aliases) {
        if (typeof alias === "string" && IMPORTED.test(alias)) keys.add(alias);
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

const sourceHistory = (storage: Storage, source: Source, accountId: string) =>
  importedHistory(storage, keysOf(source, accountId), source.aliases?.length !== 0);

/** The refs of the latest date on or before `baseDate`. */
const refsAt = ({ dates }: History, baseDate: string) => {
  const date = Object.keys(dates).filter((date) => date <= baseDate).sort().at(-1);
  return new Map(Object.entries(date ? dates[date].refs : {}));
};

export async function readImported(storage: Storage, source: Source, accountId: string, baseDate: string | null): Promise<Map<string, string[]>> {
  if (baseDate === null) return new Map();
  try {
    return refsAt(await sourceHistory(storage, source, accountId), baseDate);
  } catch {
    return new Map();
  }
}

async function saveHistory(storage: Storage, { keys, dates }: History, date: string, refs: ImportedRefs) {
  const savedAt = Math.max(Date.now(), ...Object.values(dates).map((entry) => entry.savedAt + 1));
  dates[date] = { savedAt, refs };
  const value = JSON.stringify({ aliases: [...keys], dates });
  for (const key of keys) await storage.set(key, value);
}

export async function saveImported(storage: Storage, source: Source, accountId: string, date: string, refs: ImportedRefs) {
  await saveHistory(storage, await sourceHistory(storage, source, accountId), date, refs);
}

/**
 * One import's records for an account: each source's at the date. Linked folios share one history,
 * so each of those sources saves all of their refs, and none erases what another saved.
 */
export async function saveImports(storage: Storage, accountId: string, date: string, records: { source: Source; refs: ImportedRefs }[]) {
  // Sever mixed-issuer links before another source can follow their stale copies.
  records = [...records].sort((a, b) => Number(b.source.aliases?.length === 0) - Number(a.source.aliases?.length === 0));
  const keys = await Promise.all(records.map(async ({ source }) => (await sourceHistory(storage, source, accountId)).keys));
  for (const [i, { source }] of records.entries()) {
    if (source.aliases?.length === 0) {
      for (const [j, other] of keys.entries()) if (i !== j) other.delete(importedKey(source.id, accountId));
    }
  }
  const linked = (i: number) => {
    const found = new Set([i]);
    for (const j of found) {
      keys.forEach((other, k) => {
        if (!found.has(k) && [...other].some((key) => keys[j].has(key))) found.add(k);
      });
    }
    return found;
  };
  for (const [i, { source }] of records.entries()) {
    const refs: ImportedRefs = {};
    for (const j of linked(i)) {
      for (const [ref, ids] of Object.entries(records[j].refs)) refs[ref] = [...new Set([...(refs[ref] ?? []), ...ids])];
    }
    await saveImported(storage, source, accountId, date, refs);
  }
}

// Storage can't list its keys, so each account keeps an index of the import records it has, to find
// those of folios, demat accounts and PRANs a later statement doesn't list.

/** The account's import records by investor: `investorKey` → `importedKey`s. */
const indexKey = (accountId: string) => `holdings-sources:${sha256(`cas-importer holdings sources ${accountId}`)}`;

async function readIndex(storage: Storage, accountId: string): Promise<Record<string, string[]>> {
  // A failed read throws, so the index isn't overwritten without what it can't read.
  const raw = await storage.get(indexKey(accountId));
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  if (!record(stored)) return {};
  return Object.fromEntries(Object.entries(stored).flatMap(([investor, keys]) =>
    /^holdings-investor:[a-f0-9]{64}$/.test(investor) && Array.isArray(keys)
      ? [[investor, keys.filter((key): key is string => typeof key === "string" && IMPORTED.test(key))]]
      : []));
}

/**
 * After an import into the account: adds the investor's `sources` to its index, keeping every other
 * entry. A statement that names no investor can't tell whose they are, so it adds none.
 */
export async function indexSources(storage: Storage, accountId: string, investor: string, sources: Source[]) {
  if (!investor) return;
  // shortcut: concurrent device writes can lose index entries, merge them when storage offers atomic updates.
  const index = await readIndex(storage, accountId);
  const group = investorKey(investor);
  const keys = new Set(index[group]);
  const size = keys.size;
  for (const source of sources) keys.add(importedKey(source.id, accountId));
  if (keys.size === size) return;
  index[group] = [...keys];
  await storage.set(indexKey(accountId), JSON.stringify(index));
}

/**
 * What earlier imports of the investor's statements into the account recorded, on or before
 * `baseDate`, for the indexed folios, demat accounts and PRANs that `listed` neither includes nor
 * links to. Linked records count once; empty ones not at all.
 */
export async function readUnlisted(storage: Storage, accountId: string, investor: string, listed: Source[], baseDate: string | null): Promise<Unlisted[]> {
  if (baseDate === null || !investor) return [];
  // A failed read throws: without these records, a holding they keep could be removed by default.
  const known = new Set(listed.flatMap((source) => keysOf(source, accountId)));
  const indexed = ((await readIndex(storage, accountId))[investorKey(investor)] ?? []).filter((key) => !known.has(key));
  if (!indexed.length) return [];
  for (const source of listed) for (const key of (await sourceHistory(storage, source, accountId)).keys) known.add(key);
  const groups: { keys: string[]; history: History }[] = [];
  for (const key of indexed) {
    const group = { keys: [key], history: await importedHistory(storage, [key], true, true) };
    for (let i = 0; i < groups.length;) {
      const other = groups[i];
      if (![...other.history.keys].some((key) => group.history.keys.has(key))) { i++; continue; }
      group.keys.push(...other.keys);
      group.history = await importedHistory(storage, [...new Set([...group.history.keys, ...other.history.keys])], true);
      groups.splice(i, 1);
      i = 0;
    }
    groups.push(group);
  }
  return groups.flatMap(({ keys, history }) => {
    if ([...history.keys].some((key) => known.has(key))) return [];
    const remembered = refsAt(history, baseDate);
    return remembered.size ? [{ keys, remembered }] : [];
  });
}

/** Saves an import's records of folios, demat accounts and PRANs it doesn't list, by their indexed keys. */
export async function saveUnlisted(storage: Storage, date: string, records: { keys: string[]; refs: ImportedRefs }[]) {
  for (const { keys, refs } of records) {
    for (const key of keys) await saveHistory(storage, await importedHistory(storage, [key], true, true), date, refs);
  }
}

/** A fund the user confirmed, with the name `market.searchTicker` gave it, or a holding priced from statements. */
export interface ChosenFund extends FundAsset {
  assetId?: string;
  name: string;
  /** Wealthfolio's pricing mode at the time; looked up again for each import, so not stored. */
  manual?: boolean;
  statementPrices?: boolean;
}

function parseFund(value: string | null): ChosenFund | undefined {
  try {
    const fund = JSON.parse(value ?? "null");
    if (typeof fund?.symbol !== "string" || typeof fund?.quoteCcy !== "string") return undefined;
    const { manual, ...choice } = fund;
    return choice;
  } catch {
    return undefined;
  }
}

export async function readFund(storage: Storage, key: string): Promise<ChosenFund | undefined> {
  return parseFund(await storage.get(key).catch(() => null));
}

/**
 * The remembered choices under `keys`, for `reconcileRecord`: the Holdings card's own as they are there,
 * undecided ones too, and the others from storage. A failed read rejects, so the preview stops.
 */
export async function readRecordChoices(storage: Storage, keys: Iterable<string>, current: ReadonlyMap<string, ChosenFund | undefined>) {
  const choices = await Promise.all([...keys].map(async (key) =>
    current.has(key) ? current.get(key) : parseFund(await storage.get(key))));
  return choices.filter((choice) => choice !== undefined);
}

export const saveFund = (storage: Storage, key: string, fund: ChosenFund) => {
  const { manual, ...choice } = fund;
  return storage.set(key, JSON.stringify(choice));
};

/** The statement password, saved only when the user ticks "Remember". */
export const PASSWORD_SECRET = "statement-password";
