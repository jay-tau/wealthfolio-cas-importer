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

/**
 * Imports by snapshot date: `fundRef` → the printed ISIN and/or registrar's scheme code, and in `ids`,
 * `fundRef` → the Wealthfolio asset's ID where the import knew it.
 */
const importedKey = (id: string, accountId: string) =>
  `holdings-imported:${sha256(`cas-importer holdings imported ${id}|${accountId}`)}`;

type ImportedRefs = Record<string, string[]>;
type ImportedIds = Record<string, string>;
/**
 * Versions before asset IDs read `refs` alone. They keep `ids` only on an entry they select as stored:
 * their own saves, and the equal-time copies they merge, such as linked folios', go without it. Read
 * `ids` through `idsOf`.
 */
type ImportEntry = { savedAt: number; refs: ImportedRefs; ids?: unknown };
type History = { keys: Set<string>; dates: Record<string, ImportEntry> };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toJSON()?.slice(0, 10) === date;
const IMPORTED = /^holdings-imported:[a-f0-9]{64}$/;

/** An entry's asset IDs of its own refs. Malformed ones are ignored, and its refs still count. */
function idsOf(entry: ImportEntry) {
  const refs = new Set(Object.keys(entry.refs));
  return new Map(record(entry.ids)
    ? Object.entries(entry.ids).filter((pair): pair is [string, string] => refs.has(pair[0]) && typeof pair[1] === "string" && pair[1] !== "")
    : []);
}

/** A source's own keys: its ID's and its issuer-scoped aliases'. */
const keysOf = (source: Source, accountId: string) => [source.id, ...(source.aliases ?? [])].map((id) => importedKey(id, accountId));

/** The history shared by `start` and the keys their records link, followed unless `follow` is false. */
async function importedHistory(storage: Storage, start: string[], follow: boolean, indexed = false): Promise<History> {
  const keys = new Set(start);
  const initial = new Set(keys);
  const siblings = new Set(keys);
  const dates: Record<string, ImportEntry> = {};
  // A copy without IDs must not hide a conflict between the other equal-time copies.
  const observed = new Map<string, Map<string, string>>();
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
      if (!previous || next.savedAt > previous.savedAt) {
        dates[date] = next;
        observed.set(date, idsOf(next));
      } else if (next.savedAt === previous.savedAt) {
        // Conflicting device writes at the same time must not invent removals. Asset IDs that differ
        // dispute their ref too; one only a copy has is dropped, and its ref goes by choices.
        const [before, after] = [idsOf(previous), idsOf(next)];
        const known = observed.get(date)!;
        const refs: ImportedRefs = Object.fromEntries(Object.entries(previous.refs).flatMap(([ref, securities]) => {
          const other = next.refs[ref];
          const agreed = Array.isArray(other) && securities.every((id) => other.includes(id)) && other.every((id) => securities.includes(id));
          const disputed = known.has(ref) && after.has(ref) && known.get(ref) !== after.get(ref);
          return agreed && !disputed && securities.length ? [[ref, securities]] : [];
        }));
        const agreed = new Set(Object.keys(refs));
        const ids = Object.fromEntries([...before].filter(([ref, id]) => agreed.has(ref) && after.get(ref) === id));
        dates[date] = { savedAt: next.savedAt, refs, ...(Object.keys(ids).length > 0 && { ids }) };
        for (const [ref, id] of after) if (!known.has(ref)) known.set(ref, id);
      }
    }
  }
  return { keys, dates };
}

const sourceHistory = (storage: Storage, source: Source, accountId: string) =>
  importedHistory(storage, keysOf(source, accountId), source.aliases?.length !== 0);

/** The record of the latest date on or before `baseDate`. */
const recordAt = ({ dates }: History, baseDate: string) => {
  const date = Object.keys(dates).filter((date) => date <= baseDate).sort().at(-1);
  return date
    ? { remembered: new Map(Object.entries(dates[date].refs)), ids: idsOf(dates[date]) }
    : { remembered: new Map<string, string[]>(), ids: new Map<string, string>() };
};

export async function readImported(storage: Storage, source: Source, accountId: string, baseDate: string | null) {
  if (baseDate !== null) {
    try {
      return recordAt(await sourceHistory(storage, source, accountId), baseDate);
    } catch {
      // Read as no record.
    }
  }
  return { remembered: new Map<string, string[]>(), ids: new Map<string, string>() };
}

async function saveHistory(storage: Storage, { keys, dates }: History, date: string, refs: ImportedRefs, ids: ImportedIds = {}) {
  const savedAt = Math.max(Date.now(), ...Object.values(dates).map((entry) => entry.savedAt + 1));
  dates[date] = { savedAt, refs, ...(Object.keys(ids).length > 0 && { ids }) };
  const value = JSON.stringify({ aliases: [...keys], dates });
  for (const key of keys) await storage.set(key, value);
}

export async function saveImported(storage: Storage, source: Source, accountId: string, date: string, refs: ImportedRefs, ids?: ImportedIds) {
  await saveHistory(storage, await sourceHistory(storage, source, accountId), date, refs, ids);
}

/**
 * One import's records for an account: each source's at the date. Linked folios share one history,
 * so each of those sources saves all of their refs, and none erases what another saved. Each ref keeps
 * the asset ID any of them gives it, unless two of them give it different ones. A set-aside entry gives
 * way to a linked source's entry for the current asset; the set-aside markers aren't stored.
 */
export async function saveImports(
  storage: Storage, accountId: string, date: string, records: { source: Source; refs: ImportedRefs; ids?: ImportedIds; aside?: ReadonlySet<string> }[],
) {
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
    const ids = new Map<string, string | null>();
    const group = [...linked(i)];
    const regular = new Set(group.flatMap((j) => Object.keys(records[j].refs).filter((ref) => !records[j].aside?.has(ref))));
    for (const j of group) {
      for (const [ref, security] of Object.entries(records[j].refs)) {
        if (records[j].aside?.has(ref) && regular.has(ref)) continue;
        refs[ref] = [...new Set([...(refs[ref] ?? []), ...security])];
        const id = records[j].ids?.[ref];
        if (id) ids.set(ref, ids.has(ref) && ids.get(ref) !== id ? null : id);
      }
    }
    await saveImported(storage, source, accountId, date, refs, Object.fromEntries([...ids].filter((pair): pair is [string, string] => pair[1] !== null)));
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
  // A failed read throws: without these records, a holding they keep would be asked about as if no other folio had added it.
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
    const record = recordAt(history, baseDate);
    return record.remembered.size ? [{ keys, ...record }] : [];
  });
}

/** Saves an import's records of folios, demat accounts and PRANs it doesn't list, by their indexed keys. */
export async function saveUnlisted(storage: Storage, date: string, records: { keys: string[]; refs: ImportedRefs; ids?: ImportedIds }[]) {
  for (const { keys, refs, ids } of records) {
    for (const key of keys) await saveHistory(storage, await importedHistory(storage, [key], true, true), date, refs, ids);
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

function asFund(value: unknown): ChosenFund | undefined {
  if (!record(value) || typeof value.symbol !== "string" || typeof value.quoteCcy !== "string" ||
      typeof value.name !== "string" || typeof value.instrumentType !== "string") return undefined;
  const { manual, transactions, ...choice } = value;
  return choice as unknown as ChosenFund;
}

/**
 * A remembered choice. Detailed and holdings imports share it, except a holdings import's asset
 * priced from statements, which detailed imports don't use: beside that, `transactions` keeps the
 * fund confirmed for detailed imports.
 */
function parseChoice(value: string | null): { fund?: ChosenFund; transactions?: ChosenFund } {
  let stored: unknown;
  try {
    stored = JSON.parse(value ?? "null");
  } catch {
    return {};
  }
  const fund = asFund(stored);
  const transactions = fund?.statementPrices ? asFund((stored as Record<string, unknown>).transactions) : undefined;
  return fund ? { fund, ...(transactions && !transactions.statementPrices && { transactions }) } : {};
}

const parseFund = (value: string | null) => parseChoice(value).fund;

/** The fund confirmed under `key` for holdings imports, or with `detailed`, for detailed imports. */
export async function readFund(storage: Storage, key: string, detailed = false): Promise<ChosenFund | undefined> {
  const { fund, transactions } = parseChoice(await storage.get(key).catch(() => null));
  return detailed && fund?.statementPrices ? transactions : fund;
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

/**
 * Remembers the fund a holdings import, or with `detailed`, a detailed import, confirmed under `key`.
 * A detailed import's fund goes beside an asset priced from statements, and that asset keeps the fund
 * a detailed import confirmed, or the one it replaces. Other choices replace the stored one. A
 * failed read rejects, so the other import's fund isn't lost.
 */
export async function saveFund(storage: Storage, key: string, fund: ChosenFund, detailed = false) {
  const { manual, ...choice } = fund;
  let value: ChosenFund & { transactions?: ChosenFund } = choice;
  if (detailed || choice.statementPrices) {
    const stored = parseChoice(await storage.get(key));
    if (detailed && !choice.statementPrices && stored.fund?.statementPrices) value = { ...stored.fund, transactions: choice };
    if (!detailed) {
      const transactions = stored.fund?.statementPrices ? stored.transactions : stored.fund;
      if (transactions) value = { ...choice, transactions };
    }
  }
  await storage.set(key, JSON.stringify(value));
}

/**
 * Forgets the fund confirmed under `key`, for both kinds of import. Beside an asset priced from
 * statements, a detailed import forgets only its own.
 */
export async function forgetFund(storage: Storage, key: string, detailed = false) {
  if (detailed) {
    const { fund, transactions } = parseChoice(await storage.get(key));
    if (fund?.statementPrices) {
      if (transactions) await storage.set(key, JSON.stringify(fund));
      return;
    }
  }
  await storage.delete(key);
}

/** The statement password, saved only when the user ticks "Remember". */
export const PASSWORD_SECRET = "statement-password";
