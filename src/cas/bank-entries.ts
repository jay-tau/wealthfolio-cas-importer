import type {
  Account,
  ActivityDetails,
  ActivityType,
  AddonContext,
  CashActivity,
  CashActivitySearchRequest,
  SpendCategoryKind,
} from "@wealthfolio/addon-sdk";
import { plural } from "../lib/plural.ts";
import { bankCandidates, day, linkBankRow, type PlannedTransaction } from "./plan.ts";

// What reusing a bank account's entry for a fund's cash changes in it besides its link, in
// Wealthfolio 3.13.0. Changing a withdrawal or deposit into a transfer deletes its spending splits,
// and Wealthfolio's own screens ask before deleting them. When
// Wealthfolio itself changes one into a linked transfer, it removes both legs' spending and income
// categories and keeps savings ones; the add-on's update and link don't, so it removes them after
// linking. Updating or linking an entry marks it as edited by the user, so the sync of an account
// connected to Wealthfolio leaves it alone from then on. Wealthfolio's Spending calls cover only
// accounts in Spending.

type Spending = AddonContext["api"]["spending"];
type Activities = AddonContext["api"]["activities"];
type Reads = { spending: Pick<Spending, "getContext" | "searchCashActivities">; accounts: Pick<AddonContext["api"]["accounts"], "getAll"> };

/** Wealthfolio's taxonomy of each kind of Spending category. */
const KINDS: Record<string, SpendCategoryKind> = {
  spending_categories: "expense",
  income_sources: "income",
  savings_categories: "saving",
};
/** Each kind as Wealthfolio's Spending names it. */
const WORDS: Record<SpendCategoryKind, string> = { expense: "spending", income: "income", saving: "savings" };
/** The kinds a linked transfer doesn't keep: it's neither spending nor income. */
const REMOVED: SpendCategoryKind[] = ["expense", "income"];

/** A withdrawal or deposit, which the add-on changes into a transfer to link it; a transfer keeps its type. */
export const converts = (entry: Pick<ActivityDetails, "activityType">) =>
  entry.activityType === "WITHDRAWAL" || entry.activityType === "DEPOSIT";

export interface EntrySpending {
  /** How many categories its split spreads it across; 0 without a split. */
  splitCategories: number;
  /** The kind of those categories. */
  splitKind?: SpendCategoryKind;
  /** The kinds of the categories it's assigned. */
  kinds: SpendCategoryKind[];
}

/** What reusing an entry changes besides its type and link, as far as the add-on could find out. */
export interface EntryFacts {
  /** The add-on changes it into a transfer. */
  converts: boolean;
  /** Whether its account is in Spending; undefined when Spending's settings couldn't be read. */
  inSpending?: boolean;
  /** Its split and categories, for an entry in Spending; undefined when they couldn't be read. */
  spending?: EntrySpending;
  /** Its account is synced and the entry isn't marked as edited yet: linking stops the sync's corrections to it. */
  synced: boolean;
}

const DAY = 86_400_000;
const CASH_TYPES: ActivityType[] = ["DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT"];

/** Spending's records of `entries`, all in one account in Spending, by ID: those it found. */
async function search(spending: Pick<Spending, "searchCashActivities">, accountId: string, entries: ActivityDetails[]) {
  const wanted = new Set(entries.map((e) => e.id));
  const times = entries.map((e) => new Date(e.date).getTime());
  const amounts = entries.map((e) => Math.abs(Number(e.amount)));
  const request: CashActivitySearchRequest = {
    accountIds: [accountId],
    activityTypes: CASH_TYPES,
    // A day and a paisa either side, for what dates and amounts can lose on the way.
    startDate: new Date(Math.min(...times) - DAY).toISOString(),
    endDate: new Date(Math.max(...times) + DAY).toISOString(),
    minAmount: Math.min(...amounts) - 0.01,
    maxAmount: Math.max(...amounts) + 0.01,
  };
  const found = new Map<string, CashActivity>();
  // Further pages until each entry is found or the results run out.
  for (let offset = 0; found.size < wanted.size; ) {
    const page = await spending.searchCashActivities({ ...request, offset });
    for (const item of page.items) if (wanted.has(item.id)) found.set(item.id, item);
    offset += page.items.length;
    if (!page.items.length || offset >= page.totalCount) break;
  }
  return found;
}

function spendingOf(item: CashActivity): EntrySpending {
  const splits = item.splits ?? [];
  return {
    splitCategories: new Set(splits.map((s) => s.categoryId)).size,
    splitKind: splits.length ? KINDS[splits[0].taxonomyId] : undefined,
    kinds: [...new Set((item.assignments ?? []).flatMap((a) => KINDS[a.taxonomyId] ?? []))],
  };
}

/**
 * `EntryFacts` of each entry, by ID. A failed read of Spending leaves what it would have found
 * unknown, and an entry Spending's search doesn't return has unknown splits and categories. The
 * accounts are read afresh, as one can be connected to a sync while the page is open.
 */
export async function readEntryFacts({ spending, accounts: accountsApi }: Reads, entries: ActivityDetails[]) {
  const facts = new Map<string, EntryFacts>();
  if (!entries.length) return facts;
  // The host supports includeArchived; the SDK omits this argument.
  const accounts = await (accountsApi.getAll as (includeArchived: boolean) => Promise<Account[]>)(true);
  const context = await spending.getContext().catch(() => undefined);
  const inSpending = (accountId: string) => !!context?.enabled && context.accountIds.includes(accountId);
  const found = new Map<string, CashActivity>();
  for (const accountId of new Set(entries.map((e) => e.accountId))) {
    if (!inSpending(accountId)) continue;
    try {
      for (const [id, item] of await search(spending, accountId, entries.filter((e) => e.accountId === accountId))) found.set(id, item);
    } catch {
      // Unknown, and said so.
    }
  }
  for (const entry of entries) {
    const account = accounts.find((a) => a.id === entry.accountId);
    const item = found.get(entry.id);
    facts.set(entry.id, {
      converts: converts(entry),
      inSpending: context ? inSpending(entry.accountId) : undefined,
      spending: item && spendingOf(item),
      synced: !!(account?.provider || account?.providerAccountId) && !entry.isUserModified,
    });
  }
  return facts;
}

/** Said once above the bank matches when one in an account outside Spending would be changed into a transfer. */
export const OUTSIDE_SPENDING =
  "Changing a withdrawal or deposit into a transfer deletes any split across spending categories, also one saved before Spending was turned off for its account.";

/** Whether `OUTSIDE_SPENDING` is about this entry. */
export const outsideSpending = (facts: EntryFacts | undefined) => !!facts?.converts && facts.inSpending === false;

const splitText = (s: EntrySpending) => {
  const word = WORDS[s.splitKind ?? "expense"];
  return plural(s.splitCategories, `${word} category`, `${word} categories`);
};

/** What reusing the entry changes besides its type and link, said on it before it's ticked. */
export function entryNotes(facts: EntryFacts | undefined, accountName: string) {
  if (!facts) return [];
  const notes: string[] = [];
  if (facts.converts && facts.inSpending !== false) {
    const s = facts.spending;
    if (!s) {
      notes.push(
        "Couldn't check whether this entry is split across spending categories; changing it into a transfer deletes any split.",
        "Couldn't check this entry's category; a spending or income one is removed, a savings one stays.",
      );
    } else {
      if (s.splitCategories) notes.push(`This entry is split across ${splitText(s)}. Changing it into a transfer deletes the split.`);
      for (const kind of REMOVED) {
        if (s.kinds.includes(kind)) notes.push(`Its ${WORDS[kind]} category is removed: a transfer isn't ${WORDS[kind]}.`);
      }
    }
  }
  if (facts.synced) notes.push(`${accountName} is synced. Once linked, later corrections to this entry from the sync won't change it.`);
  return notes;
}

const notesOf = (facts: EntryFacts | undefined, accountName: string) => [
  ...entryNotes(facts, accountName),
  ...(outsideSpending(facts) ? [OUTSIDE_SPENDING] : []),
];

/** A ticked entry that changed between the preview and Import. */
export interface StaleEntry {
  transaction: PlannedTransaction;
  /** As the preview showed it. */
  before: ActivityDetails;
  /** As read again; undefined when it's gone. */
  after?: ActivityDetails;
  /**
   * Gone, or no longer offered for the transaction: it no longer matches it, or it's linked with
   * another transfer. Otherwise its type, amount or day changed.
   */
  reason?: "gone" | "unmatched" | "linked" | "changed";
  /** Notes it needs now that the preview didn't show. */
  notes: string[];
}

/**
 * Reads again the entries ticked for transactions about to be imported, and what reusing each
 * changes, right before importing: Wealthfolio keeps the page loaded while the user changes
 * things elsewhere. `shown` has the facts the preview's notes said. `current` has each entry still
 * offered as just read, with its `facts`; `stale` what changed, if anything.
 */
export async function recheckEntries(
  api: Reads & { activities: Pick<Activities, "getAll" | "getTransferPair"> },
  chosen: [PlannedTransaction, ActivityDetails][],
  shown: ReadonlyMap<string, EntryFacts>,
  accountName: (id: string) => string,
) {
  const rows = new Map<string, ActivityDetails>();
  for (const accountId of new Set(chosen.map(([, entry]) => entry.accountId))) {
    for (const row of await api.activities.getAll(accountId)) rows.set(row.id, row);
  }
  const current = new Map<PlannedTransaction, ActivityDetails>();
  const stale: StaleEntry[] = [];
  for (const [t, before] of chosen) {
    const after = rows.get(before.id);
    let reason: StaleEntry["reason"];
    if (!after) reason = "gone";
    else if (!bankCandidates(t, [after]).length) reason = "unmatched";
    else if (after.activityType.startsWith("TRANSFER_") && (await api.activities.getTransferPair(after.id))) reason = "linked";
    else if (after.activityType !== before.activityType || after.amount !== before.amount || day(after.date) !== day(before.date)) {
      reason = "changed";
    }
    if (reason) stale.push({ transaction: t, before, after, reason, notes: [] });
    if (after && (!reason || reason === "changed")) current.set(t, after);
  }
  const facts = await readEntryFacts(api, [...current.values()]);
  for (const [t, after] of current) {
    const name = accountName(after.accountId);
    const before = notesOf(shown.get(after.id), name);
    const notes = notesOf(facts.get(after.id), name).filter((note) => !before.includes(note));
    if (!notes.length) continue;
    const known = stale.find((s) => s.transaction === t);
    if (known) known.notes = notes;
    else stale.push({ transaction: t, before: chosen.find(([c]) => c === t)![1], after, notes });
  }
  return { current, facts, stale };
}

/** A reused entry, and what changed in it besides its type and link. */
export interface Reused {
  /** What went wrong linking, if anything. */
  error?: string;
  /** What the result says changed in the entry. */
  changes: string[];
  /** Categories that should have been removed and weren't. */
  warnings: string[];
}

/**
 * Links the entry with the transaction as `linkBankRow` does, then removes the spending and
 * income categories of an entry it changed into a transfer, keeping a savings one, as Wealthfolio's
 * own conversion does. An entry that was already a transfer keeps its categories, as when
 * Wealthfolio links two transfers. Says what changed, also when a later step failed.
 */
export async function reuseBankEntry(
  api: { activities: Pick<Activities, "create" | "update" | "linkTransfer">; spending: Pick<Spending, "unassignCategory"> },
  t: PlannedTransaction,
  entry: ActivityDetails,
  facts: EntryFacts,
): Promise<Reused> {
  const { error, converted, linked } = await linkBankRow(api.activities, t, entry);
  const changes: string[] = [];
  const warnings: string[] = [];
  const known = facts.inSpending === false ? undefined : facts.spending;
  if (converted) {
    if (!known) changes.push("Any split it had across spending categories was deleted.");
    else if (known.splitCategories) changes.push(`Its split across ${splitText(known)} was deleted.`);
  }
  if (converted && facts.inSpending !== false) {
    const kinds = known ? REMOVED.filter((kind) => known.kinds.includes(kind)) : REMOVED;
    const removed: SpendCategoryKind[] = [];
    for (const kind of kinds) {
      if (!linked) {
        warnings.push(
          `Its ${WORDS[kind]} category${known ? "" : ", if it has one,"} wasn't removed because linking failed. After linking the transfers, remove it in Wealthfolio.`,
        );
        continue;
      }
      try {
        await api.spending.unassignCategory(entry.id, kind);
        removed.push(kind);
      } catch (e) {
        warnings.push(
          `Couldn't remove its ${WORDS[kind]} category${known ? "" : ", if it has one"}: ${String(e)}. A transfer isn't ${WORDS[kind]}: remove it in Wealthfolio.`,
        );
      }
    }
    if (known) changes.push(...removed.map((kind) => `Its ${WORDS[kind]} category was removed.`));
    else if (removed.length) changes.push(`Any ${removed.map((kind) => WORDS[kind]).join(" or ")} category it had was removed.`);
  }
  if (facts.synced && (converted || linked)) changes.push("Later corrections to it from the sync won't change it.");
  return { error, changes, warnings };
}
