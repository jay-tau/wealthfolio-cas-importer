import type { ActivityDetails, ActivityImport } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, format, neg, sub } from "./decimal.ts";
import type { EntryFacts } from "./bank-entries.ts";
import type { FundAsset, Mapping, MappedTransaction, RowOutcome } from "./mapping.ts";
import {
  bankAmounts,
  bankCandidates,
  conversionSide,
  day,
  type FundRefs,
  PAISA,
  fundRef,
  type PlannedTransaction,
  statementDay,
  unitsHeld,
} from "./plan.ts";
import type { CasData, CasFolio, CasScheme } from "./types.ts";

// What the detailed Review screen counts, from the same planned transactions the import sends: each
// fund's new transactions and units after importing, the statement's transactions by what happens to
// them, the bank movements, and the bank entries that may be them.

/** A statement row's transaction, as planned. */
export type Planned = ReadonlyMap<MappedTransaction, PlannedTransaction>;

/** Each mapped transaction's plan. */
export const plannedOf = (plan: PlannedTransaction[]): Planned => new Map(plan.map((t) => [t.transaction, t]));

/** Whether the import sends the transaction: new, or a possible duplicate the user chose to import anyway. */
export const sends = (t: PlannedTransaction, importAnyway: (t: PlannedTransaction) => boolean) =>
  t.status === "new" || ((t.status === "duplicate" || t.status === "existing") && !t.transaction.arriving && importAnyway(t));

/** The units an imported row adds to its fund, or takes away. A cash row has none. */
export function rowUnits(row: ActivityImport): Dec | undefined {
  if (!row.symbol?.trim() || row.quantity === undefined || row.quantity === null || row.quantity === "") return undefined;
  const q = abs(dec(String(row.quantity)));
  const side = row.activityType === "ADJUSTMENT" ? conversionSide(row.subtype) : undefined;
  switch (row.activityType) {
    case "BUY":
    case "TRANSFER_IN":
      return q;
    case "SELL":
    case "TRANSFER_OUT":
      return neg(q);
    case "DIVIDEND":
      return row.subtype === "DRIP" ? q : undefined;
    case "ADJUSTMENT":
      return side === "CONVERSION_IN" ? q : side === "CONVERSION_OUT" ? neg(q) : undefined;
    default:
      return undefined;
  }
}

/** The fund rows of a transaction: its activity, and a merger's or gift's other side. */
const fundRows = ({ transaction }: PlannedTransaction) =>
  [transaction.activity, transaction.arriving?.activity, transaction.receiving?.activity].filter((row) => row !== undefined);

type Target = (folio: CasFolio, scheme: CasScheme) => { accountId: string; asset: FundAsset } | undefined;

/** A fund in an account, as the Ready list shows it: one row however many folios and schemes go to it. */
export interface FundGroup {
  /** `accountId|fundRef`. */
  key: string;
  accountId: string;
  asset: FundAsset;
  schemes: { folio: CasFolio; scheme: CasScheme }[];
  /** Statement rows the import sends. */
  sent: number;
  /** Statement rows Wealthfolio already has. */
  before: number;
  /** Statement rows left out, waiting or not sent. */
  other: number;
  /** The statement's closing units. */
  statement: Dec;
  /**
   * Wealthfolio's units at the statement's end once the import is in: what it has now, and what the
   * import sends. Undefined when its history needs Wealthfolio's portfolio engine.
   */
  after?: Dec;
  /** Possible duplicates the user chose to import anyway, which add to the units. */
  forced: number;
  /** Its rows don't add up to its closing units, and the user chose to import them anyway. */
  unbalanced: boolean;
}

/**
 * Every fund with an account and an asset, grouped by account and asset, with its transactions and
 * units from the planned transactions: the ones the import sends (`sent`) count as new.
 */
export function fundGroups({
  data,
  mapping,
  planned,
  sent,
  target,
  existing,
  funds,
  timeZone,
}: {
  data: CasData;
  mapping: Mapping;
  planned: Planned;
  sent: (t: PlannedTransaction) => boolean;
  target: Target;
  existing: ActivityDetails[];
  funds: FundRefs;
  timeZone: string;
}): FundGroup[] {
  const to = statementDay(data.statement_period.to);
  const groups = new Map<string, FundGroup>();
  const groupOf = new Map<CasScheme, FundGroup>();
  for (const folio of data.folios) {
    for (const scheme of folio.schemes) {
      const t = target(folio, scheme);
      if (!t) continue;
      const key = `${t.accountId}|${fundRef(t.asset.symbol, t.asset.exchangeMic)}`;
      const group = groups.get(key) ?? {
        key, accountId: t.accountId, asset: t.asset, schemes: [], sent: 0, before: 0, other: 0, statement: dec("0"), forced: 0, unbalanced: false,
      };
      group.schemes.push({ folio, scheme });
      group.statement = add(group.statement, dec(scheme.close));
      groups.set(key, group);
      groupOf.set(scheme, group);
    }
  }
  const unbalanced = mapping.warnings.filter((w) => w.unbalanced && !w.leftOut);
  for (const group of groups.values()) {
    group.unbalanced = group.schemes.some(({ folio, scheme }) => unbalanced.some((w) => w.folio === folio.folio && w.scheme === scheme.scheme));
    const held = unitsHeld(existing, group.accountId, group.asset, funds, (d) => d <= to, timeZone);
    group.after = held;
  }
  const counted = new Set<PlannedTransaction>();
  for (const outcome of mapping.outcomes) {
    const group = groupOf.get(outcome.scheme);
    if (!group) continue;
    const t = outcome.transaction && planned.get(outcome.transaction);
    if (!t) {
      group.other++;
      continue;
    }
    if (sent(t)) {
      group.sent++;
      if (t.status !== "new") group.forced++;
    } else if (t.status === "existing") group.before++;
    else group.other++;
    if (!sent(t) || counted.has(t)) continue;
    counted.add(t);
    // Each fund row of a sent transaction changes its fund's units in its account, once.
    for (const row of fundRows(t)) {
      const units = rowUnits(row);
      const other = units && groups.get(`${row.accountId}|${fundRef(row.symbol!, row.exchangeMic)}`);
      if (other && other.after !== undefined) other.after = add(other.after, units);
    }
  }
  return [...groups.values()];
}

/** Whether a fund's units after the import differ from the statement's. */
export const unitsDiffer = (group: Pick<FundGroup, "after" | "statement">) => group.after !== undefined && cmp(group.after, group.statement) !== 0;

/** Why a statement row isn't imported, from the Review screen's point of view. */
export type Waiting = "answers" | "skipped" | "notImported";

/** The statement's transactions by what happens to them. Their parts add up to `total`. */
export interface Breakdown {
  total: number;
  toImport: number;
  /** Already in Wealthfolio. */
  before: number;
  /** Possible duplicates left out unless chosen under Before importing. */
  duplicates: number;
  /** In funds or folios still waiting for an answer. */
  answers: number;
  /** In funds that start with units Wealthfolio doesn't have. */
  earlier: number;
  /** In funds skipped by an answer. */
  skipped: number;
  /** In folios set to Don't import. */
  notImported: number;
  /** In funds whose rows don't add up, left out unless chosen under Before importing. */
  unbalanced: number;
  /** Left out for a reason of their own: a reversal, a row the add-on can't import, a transaction Wealthfolio refuses. */
  leftOut: { row: RowOutcome; reason: string; kind: "reversal" | "row" }[];
}

export function breakdown({
  mapping,
  planned,
  sent,
  why,
}: {
  mapping: Mapping;
  planned: Planned;
  sent: (t: PlannedTransaction) => boolean;
  /** Why a scheme with no account or fund isn't imported. */
  why: (folio: CasFolio, scheme: CasScheme) => Waiting;
}): Breakdown {
  const b: Breakdown = { total: 0, toImport: 0, before: 0, duplicates: 0, answers: 0, earlier: 0, skipped: 0, notImported: 0, unbalanced: 0, leftOut: [] };
  for (const outcome of mapping.outcomes) {
    b.total++;
    const { leftOut } = outcome;
    if (leftOut) {
      if (leftOut.kind === "unchosen") b[why(outcome.folio, outcome.scheme)]++;
      else if (leftOut.kind === "opening") b.earlier++;
      else if (leftOut.kind === "unbalanced") b.unbalanced++;
      else b.leftOut.push({ row: outcome, reason: leftOut.reason, kind: leftOut.kind === "reversal" ? "reversal" : "row" });
      continue;
    }
    const t = planned.get(outcome.transaction!);
    if (!t) b.leftOut.push({ row: outcome, reason: "This row isn't imported.", kind: "row" });
    else if (sent(t)) b.toImport++;
    else if (t.status === "existing") b.before++;
    else if (t.status === "duplicate") b.duplicates++;
    else b.leftOut.push({ row: outcome, reason: invalidReason(t), kind: "row" });
  }
  return b;
}

/** Why Wealthfolio can't import a planned transaction. */
export const invalidReason = (t: PlannedTransaction) =>
  t.problem ?? ([...new Set(t.rows.flatMap((r) => r.errors))].join(" ") || "Wealthfolio can't import this transaction.");

/** A transaction's bank movement, as the Review screen words it. */
export const MOVEMENT: Record<string, string> = {
  PURCHASE: "Purchase",
  PURCHASE_SIP: "SIP purchase",
  REDEMPTION: "Sale",
  DIVIDEND_PAYOUT: "Cash dividend",
};

/** The bank movements of the sent transactions: those that use an entry already there, and those that get a new transfer. */
export function bankMovements(transactions: PlannedTransaction[], reused: (t: PlannedTransaction) => boolean) {
  const withBank = transactions.filter((t) => t.transaction.bank);
  const linked = withBank.filter(reused).length;
  return { linked, created: withBank.length - linked };
}

// Bank entries that may be a transaction's bank side.

const daysApart = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Words of a fund house's name that don't tell it apart from others. */
const GENERIC = new Set([
  "MUTUAL", "FUND", "FUNDS", "MF", "BANK", "ASSET", "ASSETS", "MANAGEMENT", "MANAGERS", "MANAGER", "INVESTMENT", "INVESTMENTS", "AMC",
  "COMPANY", "CO", "LTD", "LIMITED", "PRIVATE", "PVT", "INDIA", "TRUSTEE", "TRUST", "THE", "AND", "OF",
]);

/** The words that name a fund house: "PPFAS Mutual Fund" → PPFAS. */
export const houseWords = (amc: string) =>
  amc.toUpperCase().split(/[^A-Z0-9]+/).filter((word) => word.length >= 3 && !GENERIC.has(word));

/**
 * What a bank entry's description says about whom it paid or was paid by: the fund house, by a word
 * of its name (a longer word can start a run of letters, as in "ICICIPRU"), not when it's a bank's
 * name ("HDFC BANK"); or mutual funds in general ("MF", "mutual fund").
 */
export function describes(description: string | null | undefined, amc: string): "house" | "funds" | undefined {
  const tokens = (description ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const words = houseWords(amc);
  const named = tokens.some((token, i) =>
    tokens[i + 1] !== "BANK" && words.some((word) => !token.startsWith(`${word}BANK`) && (token === word || (word.length >= 4 && token.startsWith(word)))));
  if (named && !tokens.includes("INSURANCE") && !tokens.includes("PREMIUM")) return "house";
  if (tokens.includes("MF") || /MUTUAL\s*FUNDS?\b/i.test(description ?? "")) return "funds";
  return undefined;
}

/** A transaction and the bank entry offered for it. */
export interface BankPair {
  /** `sourceRecordId of the transaction's bank row|entry ID`. */
  key: string;
  t: PlannedTransaction;
  entry: ActivityDetails;
  /** Days between the entry and the transaction's bank row. */
  days: number;
  /** The entry's amount is the transaction's bank row's, to the paisa. */
  exact: boolean;
  /** Other unlinked entries that match the transaction. */
  otherEntries: number;
  /** Other transactions to import that match the entry. */
  otherTransactions: number;
  said?: "house" | "funds";
  /** Linking changes it into a transfer, and it has spending splits or they couldn't be checked. */
  splits: boolean;
  /** Every piece of evidence is strong, so it starts ticked. */
  strong: boolean;
  reason: string;
}

/** "Same day", "1 day apart", "6 days apart". */
const apart = (days: number) => (days === 0 ? "Same day" : days === 1 ? "1 day apart" : `${days} days apart`);

/**
 * The bank entries for `transactions`, which the import sends, as the bank matches offer them: each
 * transaction's closest entry, each entry once (`matches`, from `bankMatches`), with the evidence
 * for each pair. A pair starts ticked only when the evidence is strong: the only candidate for the
 * transaction and the entry, the exact amount, at most a day apart, and a description that names the
 * fund house or mutual funds. An entry linking would change into a transfer is never ticked when it
 * has spending splits or they couldn't be checked.
 */
export function bankPairs({
  transactions,
  matches,
  existing,
  linked,
  facts,
  amcOf,
}: {
  transactions: PlannedTransaction[];
  matches: ReadonlyMap<PlannedTransaction, ActivityDetails>;
  existing: ActivityDetails[];
  linked: ReadonlySet<string>;
  facts: ReadonlyMap<string, EntryFacts>;
  amcOf: (t: PlannedTransaction) => string;
}): BankPair[] {
  const candidates = new Map(transactions.map((t) => [t, bankCandidates(t, existing).filter((a) => !linked.has(a.id))]));
  const fits = new Map<string, number>();
  for (const list of candidates.values()) for (const a of list) fits.set(a.id, (fits.get(a.id) ?? 0) + 1);
  return transactions.flatMap((t) => {
    const entry = matches.get(t);
    if (!entry) return [];
    const bank = t.transaction.bank!;
    const days = daysApart(day(entry.date), String(bank.date));
    // Candidates match to the paisa, the transfer's amount or the printed one with or without charges.
    const amounts = bankAmounts(t);
    const exact = entry.amount !== null && amounts.has(PAISA(entry.amount));
    const otherEntries = candidates.get(t)!.length - 1;
    const otherTransactions = (fits.get(entry.id) ?? 1) - 1;
    const said = describes(entry.comment, amcOf(t));
    const f = facts.get(entry.id);
    const knownSplit = !!f?.converts && !!f.spending?.splitCategories;
    const splits = knownSplit || (!!f?.converts && f.inSpending !== false && !f.spending);
    const strong = !otherEntries && !otherTransactions && exact && days <= 1 && !!said;
    return [{
      key: `${bank.sourceRecordId ?? t.transaction.activity.lineNumber}|${entry.id}`,
      t, entry, days, exact, otherEntries, otherTransactions, said, splits, strong: strong && !splits,
      reason: pairReason({ days, exact, otherEntries, otherTransactions, said, splits: splits ? (knownSplit ? "known" : "unknown") : undefined, strong, entry, amounts, paid: bank.activityType === "TRANSFER_OUT" }),
    }];
  });
}

function pairReason({ days, exact, otherEntries, otherTransactions, said, splits, strong, entry, amounts, paid }: {
  days: number; exact: boolean; otherEntries: number; otherTransactions: number; said?: "house" | "funds"; splits?: "known" | "unknown"; strong: boolean;
  entry: ActivityDetails; amounts: Set<string>; paid: boolean;
}) {
  const evidence = `${apart(days)} · ${said === "house" ? "names the fund house" : "mentions mutual funds"}`;
  if (strong && splits) {
    return `${evidence}, but ${splits === "known" ? "linking deletes its split across spending categories" : "its spending split couldn't be checked"}: check it`;
  }
  if (strong) return evidence;
  if (otherEntries) return `${otherEntries + 1} entries match: check it`;
  if (otherTransactions) return `${otherTransactions + 1} ${paid ? "payments" : "payouts"} match this entry: check it`;
  const nearest = [...amounts].map((a) => abs(sub(dec(PAISA(entry.amount ?? "0")), dec(a)))).sort(cmp)[0];
  const gap = exact ? undefined : `its amount differs by ₹${format(nearest)}`;
  const house = said ? undefined : "it doesn't name a fund house";
  const problems = [days > 1 ? undefined : gap, house].filter(Boolean).join(" and ");
  if (days <= 1) return `${apart(days)}, but ${problems}: check it`;
  const more = [gap, house].filter(Boolean).join(" and ");
  return more ? `${apart(days)}, and ${more}: check it` : `${apart(days)}: check it`;
}
