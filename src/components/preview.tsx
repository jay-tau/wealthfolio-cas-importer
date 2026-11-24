import type { ActivityDetails, ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
import type { EntryFacts, Reused, StaleEntry } from "../cas/bank-entries";
import { LinkButton, WrapButton } from "./review/parts";
import { abs, dec, format } from "../cas/decimal";
import type { Mapping } from "../cas/mapping";
import type { CasTransaction } from "../cas/types";
import {
  conversionSide,
  day,
  type FundUnits,
  type PlannedRow,
  type PlannedTransaction,
  sameUnits,
  type Status,
} from "../cas/plan";
import { focusDropped } from "../lib/focus";
import { every, plural } from "../lib/plural";
import { longDate, rupees, units } from "../lib/review-format";
import { otherCurrency } from "./fund-choices";

const LABELS: Record<string, string> = {
  BUY: "purchase",
  SELL: "sale",
  DIVIDEND: "dividend",
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
  TRANSFER_IN: "transfer in",
  TRANSFER_OUT: "transfer out",
};
const CONVERSION_LABELS = { CONVERSION_OUT: "fund conversion out", CONVERSION_IN: "fund conversion in" };
const label = (row: { activityType: string; subtype?: string | null }) => {
  const side = row.activityType === "ADJUSTMENT" ? conversionSide(row.subtype) : undefined;
  if (side) return CONVERSION_LABELS[side];
  return row.subtype === "DRIP" ? "reinvested dividend" : LABELS[row.activityType] ?? row.activityType;
};
/**
 * The name a transaction's fund goes by on the Review screen: its chosen listing's, without its plan
 * and option, with its folio when that fund has an equal row in another folio, as its bank pair says.
 */
export type FundName = (t: PlannedTransaction) => string;
/**
 * A transaction's place among its fund and folio's rows with its movement, day and amount on the
 * statement, as its bank pair says: " (1 of 2)", or "" when no other row is equal.
 */
export type Place = (t: PlannedTransaction) => string;
/** "purchase (1 of 2) of Fictiva Liquid Fund on 5 May 2023" */
const transactionWords = (t: PlannedTransaction, fundName: FundName, place: Place) =>
  `${label(t.transaction.activity)}${place(t)} of ${fundName(t)} on ${longDate(String(t.transaction.activity.date).slice(0, 10))}`;
/** "the purchase (1 of 2) of Fictiva Liquid Fund on 5 May 2023" */
const transactionName = (t: PlannedTransaction, fundName: FundName, place: Place) => `the ${transactionWords(t, fundName, place)}`;
/** Words with their first letter in capitals. */
const capital = (words: string) => `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
/** "Purchase (1 of 2) of Fictiva Liquid Fund on 5 May 2023" */
const transactionTitle = (t: PlannedTransaction, fundName: FundName, place: Place) => capital(transactionWords(t, fundName, place));
/** "withdrawal of ₹25,000 on 4 May 2023": a bank entry's amount and day (its `bankDay`) as its review card gives them. */
const movement = (entry: ActivityDetails, on: string) =>
  `${label(entry)}${entry.amount ? ` of ${rupees(String(entry.amount))}` : ""} on ${longDate(on)}`;
/** "The withdrawal of ₹25,000 on 4 May 2023 in Savings (NEFT FICTIVA MF)" */
const entryName = (entry: ActivityDetails, on: string, accountName: string) =>
  `The ${movement(entry, on)} in ${accountName}${entry.comment ? ` (${entry.comment})` : ""}`;
const list = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";

/** A merger an earlier version imported as a sale and a purchase, as far as Wealthfolio has it. */
function earlierNote(t: PlannedTransaction) {
  const found = t.earlier?.filter((r) => r.existingId).map((r) => label(r.activity)) ?? [];
  if (!found.length) return undefined;
  if (t.status === "existing") {
    return "Wealthfolio has this merger from an earlier import, as a sale and a purchase with a withdrawal and a deposit. Replacing them with a conversion is up to you: delete those four rows in Wealthfolio, then read the statement again.";
  }
  return `From that import, Wealthfolio has the ${list(found)}.`;
}

/** A note for each of a transaction's assets quoted in another currency than the statement's rupees. */
const currencyNotes = ({ transaction: { activity, arriving, receiving } }: PlannedTransaction) => [
  ...new Set(
    [activity, arriving?.activity, receiving?.activity].flatMap((row) => (row?.symbol && otherCurrency(row.quoteCcy, row.symbol)) || []),
  ),
];

/** A transaction whose cash went to a bank row already in Wealthfolio, what went wrong and what changed in it. */
export interface BankLink extends Reused {
  transaction: PlannedTransaction;
  /** As read right before the import. */
  bankRow: ActivityDetails;
  /** Its `bankDay` then. */
  day: string;
  /** What linking it changes, as read then, for a retry. */
  facts: EntryFacts;
}

/**
 * A transaction Wealthfolio has all or part of now, saved elsewhere while an import ran, so it isn't
 * sent again, with the day of the bank entry chosen for it: its `bankDay`, as the review showed it.
 */
export interface FoundTransaction {
  transaction: PlannedTransaction;
  entryDay?: string;
}

/** What a transaction found in Wealthfolio after a refused import needs, as its line in the result says it. */
export const foundLine = (f: FoundTransaction, fundName: FundName, place: Place) =>
  `${transactionTitle(f.transaction, fundName, place)}: Wealthfolio now has all or part of it, saved elsewhere while the import ran, so it wasn't imported again${
    f.entryDay ? `, nor linked with the bank entry of ${longDate(f.entryDay)}` : ""
  }. Check it in Wealthfolio, then read the statement again to import anything missing.`;

/** What changed in an entry the user chose, between the review and Import. */
export function staleText(s: StaleEntry, accountName: (id: string) => string, fundName: FundName, place: Place) {
  const then = `${entryName(s.before, s.beforeDay, accountName(s.before.accountId))}, chosen for ${transactionName(s.transaction, fundName, place)},`;
  const now = s.after && `a ${movement(s.after, s.afterDay!)}`;
  const instead = `so the transaction now comes with a new ${label(s.transaction.transaction.bank!)}.`;
  const why = {
    gone: `is no longer in Wealthfolio, ${instead}`,
    unmatched: `is now ${now}, which doesn't match the transaction, ${instead}`,
    linked: `is now linked with another transfer, ${instead}`,
    changed: `is now ${now}.`,
  };
  return [s.reason ? `${then} ${why[s.reason]}` : `${then} changed:`, ...s.notes].join(" ");
}

const STATUS: Record<Status, { badge: string; variant: "success-subtle" | "secondary" | "warning-subtle" | "destructive-subtle" }> = {
  new: { badge: "New", variant: "success-subtle" },
  existing: { badge: "Already in Wealthfolio", variant: "secondary" },
  duplicate: { badge: "Possible duplicate", variant: "warning-subtle" },
  invalid: { badge: "Can't import", variant: "destructive-subtle" },
  held: { badge: "Not imported", variant: "warning-subtle" },
};

/** Why a held transaction isn't imported, naming the folio when a gift spans two or both funds hold it back. */
function heldNote({ status, transaction: { held = [], receiving } }: PlannedTransaction) {
  if (status !== "held") return undefined;
  const names = held.map(({ folio, scheme }) => (receiving || held.length > 1 ? `${scheme.scheme} in folio ${folio.folio}` : scheme.scheme));
  return names.length > 1
    ? `The rows of ${list(names)} don't add up to their closing balances, so this is imported only if you choose Import with this difference for each.`
    : `The rows of ${names[0]} don't add up to its closing balance, so this is imported only if you choose Import with this difference.`;
}

function reasons(row: PlannedRow) {
  const name = label(row.activity);
  const duplicate = row.existingId
    ? row.existingType
      ? `Wealthfolio already has this ${name}, as a ${label({ activityType: row.existingType })}.`
      : `Wealthfolio already has this ${name}.`
    : row.flagged
      ? `Wealthfolio reports this ${name} as a duplicate.`
      : "";
  return [duplicate, ...row.errors, ...row.warnings].filter(Boolean);
}

/**
 * Every transaction of the statement the import plans, read-only: its rows, cash and bank account,
 * and its status with the notes that go with it. `sent` says which the import sends, and `linked`
 * which use an entry already in their bank account.
 */
export function ActivityTable({
  mapping,
  plan,
  sent,
  linked,
  accountName,
  which,
  label: tableLabel,
}: {
  mapping: Mapping;
  plan: PlannedTransaction[];
  sent: (t: PlannedTransaction) => boolean;
  linked: (t: PlannedTransaction) => boolean;
  /** An account as the screen names it: told apart from another account of the same name. */
  accountName: (id: string) => string;
  /**
   * How a statement row is told from equal ones, as on its question card: its place among its fund
   * and folio's rows with its movement, day and amount (" (1 of 2)", or ""), and whether to name its
   * folio, as its fund has such a row in another.
   */
  which: (row: CasTransaction) => { place: string; folio: boolean };
  label: string;
}) {
  const caveats = mapping.warnings.filter((w) => !w.leftOut);
  // The mapper's caveats say how a transaction is imported, so a transaction that can't be imported,
  // or that waits for an answer about a fund whose rows don't add up, shows none.
  const caveatsOf = (t: PlannedTransaction) => t.status === "invalid" || t.status === "held"
    ? []
    : caveats.filter((w) => w.rows[0] === t.transaction.rows[0]);
  return (
    // Narrow padding and wrapping Cash keep Status visible with Extra large text in a 1440 px window.
    <Table aria-label={tableLabel}>
      <TableHeader>
        <TableRow>
          <TableHead className="px-1.5">Date</TableHead>
          <TableHead className="px-1.5">Fund</TableHead>
          <TableHead className="px-1.5">Activity</TableHead>
          <TableHead className="px-1.5 text-end">Units</TableHead>
          <TableHead className="px-1.5 text-end">NAV</TableHead>
          <TableHead className="px-1.5 text-end">Tax</TableHead>
          <TableHead className="px-1.5 text-end">Amount</TableHead>
          <TableHead className="px-1.5">Cash</TableHead>
          <TableHead className="px-1.5">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plan.flatMap((t, i) => {
          const { activity, cash, bank, arriving, receiving } = t.transaction;
          const second = arriving ?? receiving;
          const forced = t.status !== "new" && sent(t);
          const notes = [
            ...t.rows.flatMap(reasons),
            ...caveatsOf(t).map((w) => w.message),
            t.problem,
            heldNote(t),
            earlierNote(t),
            ...currencyNotes(t),
            forced ? "Imported anyway, by your answer." : undefined,
          ].filter((note) => note !== undefined);
          // Each row's own statement row tells it from equal ones: its place, and its folio when needed.
          const cells = (side: { scheme: string; folio: string; rows: CasTransaction[] }, row: ActivityImport, standIns: (keyof ActivityImport)[] = []) => {
            const told = which(side.rows[0]);
            return (
              <>
                <TableCell className="px-1.5 whitespace-nowrap">{String(row.date)}</TableCell>
                <TableCell className="px-1.5">{told.folio ? `${side.scheme}, folio ${side.folio}` : side.scheme}</TableCell>
                <TableCell className="px-1.5">
                  {label(row)}
                  {told.place}
                </TableCell>
                <TableCell className="px-1.5 text-end tabular-nums">{row.quantity ?? ""}</TableCell>
                <TableCell className="px-1.5 text-end tabular-nums">{row.unitPrice ?? ""}</TableCell>
                <TableCell className="px-1.5 text-end tabular-nums">{row.tax ?? ""}</TableCell>
                <TableCell className="px-1.5 text-end tabular-nums">
                  {row.amount ?? ""}
                  {standIns.includes("amount") && <span className="text-muted-foreground block text-xs">stand-in</span>}
                </TableCell>
              </>
            );
          };
          return [
            <TableRow key={i}>
              {cells(t.transaction, activity, t.transaction.standIns)}
              <TableCell className="px-1.5">
                {cash && (
                  <>
                    <span className="whitespace-nowrap">{label(cash)}</span> {cash.amount}
                  </>
                )}
                {bank && (
                  <span className="text-muted-foreground block text-xs">
                    {bank.activityType === "TRANSFER_OUT" ? "from" : "to"} {accountName(bank.accountId)}
                    {linked(t) && ", using an entry already there"}
                  </span>
                )}
              </TableCell>
              <TableCell className="px-1.5" rowSpan={second ? 2 : undefined}>
                <div className="grid gap-1">
                  {/* The badge hides its overflow, so without a minimum width Chromium sizes the column without it.
                      Narrow padding keeps "Already in Wealthfolio" in view with the Mono font and Extra large text
                      in a 1440 px window. */}
                  <Badge className="min-w-fit px-1" variant={STATUS[t.status].variant}>
                    {STATUS[t.status].badge}
                  </Badge>
                  {notes.map((note, j) => (
                    <span key={j} className="text-muted-foreground text-xs">
                      {note}
                    </span>
                  ))}
                </div>
              </TableCell>
            </TableRow>,
            ...(second
              ? [
                  <TableRow key={`${i}-second`}>
                    {cells({ folio: t.transaction.folio, ...second }, second.activity)}
                    <TableCell className="px-1.5" />
                  </TableRow>,
                ]
              : []),
          ];
        })}
      </TableBody>
    </Table>
  );
}

/** What an import did in one account the review imports into. */
export interface ImportOutcome {
  /** The account in the review: a new account's proposed ID. */
  key: string;
  /** Its Wealthfolio account, once there is one. */
  accountId?: string;
  name: string;
  /** Created by this review. */
  isNew: boolean;
  /** Whose transactions they are, for an account that wasn't created: "B. Investor's". */
  who?: string;
  /** Its transactions imported. */
  imported: number;
  /** Its transactions that wait for it: it wasn't created, or Wealthfolio didn't import them. */
  waiting: number;
  /** Whether this account's Try again can finish any of them now. */
  retryable?: boolean;
  /** A missing account holding back this account's transactions. */
  waitingFor?: string;
  state: "imported" | "not-created" | "failed";
}

/** The units check after an import: not run, failed, or each fund's units. */
export type ClosingCheck = FundUnits[] | "failed" | undefined;

/** Ids of the result's lines, for the focus after a retry. */
export const importIds = (base: string) => ({
  title: `${base}-title`,
  account: (key: string) => `${base}-account-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  link: (link: BankLink) => `${base}-link-${link.bankRow.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  units: `${base}-units`,
  linked: `${base}-linked`,
});

/** What an import did in an account, in a sentence. */
export function outcomeWords(a: ImportOutcome) {
  const named = `${a.name}${a.isNew ? " (new)" : ""}`;
  if (a.state === "not-created") {
    return `${a.name} couldn't be created, so ${a.who ?? "its"} ${plural(a.waiting, "transaction")} ${a.waiting === 1 ? "wasn't" : "weren't"} imported.`;
  }
  if (a.state === "failed") {
    const words = a.imported
      ? `${a.waiting} of ${plural(a.imported + a.waiting, "transaction")} for ${named} weren't imported.`
      : `${plural(a.waiting, "transaction")} for ${named} ${a.waiting === 1 ? "wasn't" : "weren't"} imported.`;
    return a.retryable === false ? `${words} ${a.waitingFor ? `Try again for ${a.waitingFor}.` : "The rows below say why."}` : words;
  }
  if (!a.imported) return `None of the transactions for ${named} were imported; the rows below say why.`;
  return `${plural(a.imported, "transaction")} imported into ${named}`;
}

/** What happened to a bank entry the user chose, when using it failed part-way. */
export function linkWords(l: BankLink) {
  const when = longDate(l.day);
  switch (l.stage) {
    case "trade":
      return `The trade wasn't imported, so the bank entry of ${when} was left as it is.`;
    case "transfer":
      return `The trade is in Wealthfolio, but the fund account's transfer wasn't added, so the bank entry of ${when} wasn't linked.`;
    case "exists":
      return `The trade is in Wealthfolio, but Wealthfolio refused the fund account's transfer as a duplicate: it may already have one for the bank entry of ${when}, from an earlier try. Check the fund account's transfers, then link the bank entry in Wealthfolio.`;
    case "convert":
      return `The trade and the fund account's transfer are in Wealthfolio; the bank entry of ${when} wasn't changed into a transfer or linked.`;
    default:
      return `The trade and the fund account's transfer are in Wealthfolio; the bank entry of ${when} wasn't linked.`;
  }
}

/**
 * Whether Try again can go on with a bank entry that wasn't linked: not when its trade wasn't
 * imported, nor when Wealthfolio may already have its transfer, which only the user can check.
 */
export const canRetryLink = (l: BankLink) => !!l.stage && l.stage !== "trade" && l.stage !== "exists";

/**
 * A bank entry that wasn't linked, as its line in the result says it, its transaction told from equal
 * ones: "Purchase (1 of 2) of Fictiva Liquid Fund on 3 Jul 2026: The trade is in Wealthfolio, …".
 */
export const linkLine = (l: BankLink, fundName: FundName, place: Place) =>
  `${transactionTitle(l.transaction, fundName, place)}: ${linkWords(l)}`;

/** "₹24,998.75": a transaction's amount on the statement, as its question cards give it. */
const statementAmount = ({ transaction: { rows } }: PlannedTransaction) =>
  rows[0]?.amount ? rupees(format(abs(dec(rows[0].amount)))) : undefined;

/** A transaction with its rows Wealthfolio rejected or skipped, as the result lists them. */
export interface RowsLine {
  key: string;
  /**
   * The transaction, its fund by the Review screen's name, and where its row was, when one row or
   * one reason covers it: "Purchase (1 of 2) of Fictiva Liquid Fund on 5 May 2023, ₹24,998.75, in
   * Mutual funds: The fund could not be created".
   */
  text: string;
  /** Otherwise, each of its rows under it, those with the same reasons together, each with its reasons. */
  rows: string[];
}

/**
 * Rows Wealthfolio rejected or skipped, each transaction on a line of its own, named as a bank entry
 * that wasn't linked names it, with its amount on the statement. Each row says its movement and its
 * account: "the transfer out of Savings", "the transfer into Mutual funds", "the purchase in Mutual
 * funds". `reasons` gives a rejected row's reasons; skipped rows have none.
 */
export function rowsLines(
  answered: ActivityImport[],
  transactions: PlannedTransaction[],
  fundName: FundName,
  place: Place,
  accountName: (id: string) => string,
  reasons?: (row: ActivityImport) => string,
): RowsLine[] {
  const ofLine = new Map<number, PlannedTransaction>();
  for (const t of transactions) for (const { activity } of t.rows) if (activity.lineNumber !== undefined) ofLine.set(activity.lineNumber, t);
  // Each transaction's answered rows by line, its last answer for each; a row the plan doesn't know stands alone.
  const groups = new Map<PlannedTransaction | ActivityImport, Map<number | undefined, ActivityImport>>();
  for (const a of answered) {
    const owner = (a.lineNumber !== undefined && ofLine.get(a.lineNumber)) || a;
    groups.set(owner, (groups.get(owner) ?? new Map<number | undefined, ActivityImport>()).set(a.lineNumber, a));
  }
  const why = (a: ActivityImport) => reasons?.(a) ?? "";
  return [...groups].map(([t, byLine], i) => {
    if (!("transaction" in t)) {
      // Not expected: every row sent is one of a reviewed transaction's.
      const amount = t.amount ? rupees(format(abs(dec(String(t.amount))))) : undefined;
      const what = `${capital(label(t))}${t.symbol ? ` of ${t.symbol}` : ""} on ${longDate(day(t.date))}${amount ? `, ${amount}` : ""}, in ${accountName(t.accountId)}`;
      return { key: `row-${i}`, text: reasons ? `${what}: ${why(t)}` : what, rows: [] };
    }
    const { activity, arriving } = t.transaction;
    const head = [transactionTitle(t, fundName, place), statementAmount(t)].filter(Boolean).join(", ");
    // A merger's new fund, as the Review screen names it.
    const into = arriving && fundName({ ...t, transaction: { ...t.transaction, scheme: arriving.scheme, rows: arriving.rows } });
    const words = (row: ActivityImport) => {
      const account = accountName(row.accountId);
      const side = row.activityType === "ADJUSTMENT" ? conversionSide(row.subtype) : undefined;
      if (side === "CONVERSION_OUT") return `the fund conversion out of ${fundName(t)} in ${account}`;
      if (side === "CONVERSION_IN") return `the fund conversion into ${into ?? fundName(t)} in ${account}`;
      if (row.activityType === "TRANSFER_OUT") return `the transfer out of ${account}`;
      if (row.activityType === "TRANSFER_IN") return `the transfer into ${account}`;
      return `the ${label(row)} in ${account}`;
    };
    // The transaction's own rows, in its order, with the answers about them.
    const rows = t.rows.flatMap(({ activity: row }) => {
      const a = byLine.get(row.lineNumber);
      return a ? [{ row, reason: why(a) }] : [];
    });
    const where = (some: ActivityImport[]) =>
      some.length === 1 && some[0] === activity ? `in ${accountName(activity.accountId)}` : list(some.map(words));
    const byReason = new Map<string, ActivityImport[]>();
    for (const { row, reason } of rows) byReason.set(reason, [...(byReason.get(reason) ?? []), row]);
    const key = `transaction-${activity.lineNumber}`;
    if (!reasons) return { key, text: `${head}${rows.length === 1 && rows[0].row === activity ? ", " : ": "}${where(rows.map((r) => r.row))}`, rows: [] };
    if (byReason.size === 1) {
      const [[reason, some]] = byReason;
      return { key, text: `${head}, ${where(some)}: ${reason}`, rows: [] };
    }
    return { key, text: `${head}:`, rows: [...byReason].map(([reason, some]) => `${capital(list(some.map(words)))}: ${reason}`) };
  });
}

/** A rejected row's reasons, as Wealthfolio or the add-on gave them. */
export const rejection = (a: ActivityImport) => Object.values(a.errors ?? {}).flat().join(" ");

/** The unit mismatch sentence shared by the import result and the Check again announcement. */
export const unitsDifferWords = (differ: number, total: number) =>
  `Checked in Wealthfolio: units differ for ${differ === total ? every(total, "fund") : `${differ} of ${plural(total, "fund")}`}.`;

/** ✓ or ✗ before a line: the words say it too, so it isn't read out. */
const Mark = ({ ok }: { ok: boolean }) => (
  <span aria-hidden="true" className={ok ? "text-success" : "text-destructive"}>
    {ok ? "✓" : "✗"}
  </span>
);

/** Rows Wealthfolio rejected or skipped, a transaction on each line, with its rows under it when needed. */
const RowsList = ({ lines }: { lines: RowsLine[] }) => (
  <ul className="list-disc ps-4">
    {lines.map((line) => (
      <li key={line.key}>
        {line.text}
        {line.rows.length > 0 && (
          <ul className="list-disc ps-4">
            {line.rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        )}
      </li>
    ))}
  </ul>
);

/**
 * What an import did, until Phase 3's Done screen: how many transactions went in, account by
 * account, with Try again for an account that didn't get its transactions; rows Wealthfolio
 * rejected or skipped; the bank entries the user chose, with Try again for one that wasn't linked;
 * and the check of each fund's units in Wealthfolio, with Check again if it couldn't run.
 */
export function ImportResult({
  result,
  sent,
  found = [],
  total,
  imported,
  outcomes,
  closing,
  links,
  transactions,
  fundName,
  place,
  unitsFund,
  accountName,
  base,
  onRetryAccount,
  onRetryLink,
  onCheckAgain,
  onOpenAccount,
}: {
  result: ImportActivitiesResult;
  /** The rows sent, to tell Wealthfolio's surprises apart. */
  sent: ActivityImport[];
  /** Transactions not imported again because Wealthfolio has all or part of them now. */
  found?: FoundTransaction[];
  /** The transactions the review approved, and those that went in. */
  total: number;
  imported: number;
  outcomes: ImportOutcome[];
  closing: ClosingCheck;
  links: BankLink[];
  /** The transactions the review approved, to name those of the rows Wealthfolio rejected or skipped. */
  transactions: PlannedTransaction[];
  /** The name each transaction's fund goes by on the Review screen, with its folio when needed. */
  fundName: FundName;
  /** Each transaction's place among equal rows on the statement. */
  place: Place;
  /**
   * A fund of the units check as the Review screen names it, and its label there, which tells it from
   * another fund the screen names the same; `key` is the same for one fund in two accounts.
   */
  unitsFund: (f: FundUnits) => { key: string; name: string; label: string };
  /** An account as the screen names it: told apart from another account of the same name. */
  accountName: (id: string) => string;
  /** Prefix of the ids of its lines (`importIds`). */
  base: string;
  onRetryAccount: (key: string) => void;
  onRetryLink: (link: BankLink) => void;
  onCheckAgain: () => void;
  onOpenAccount: (accountId: string) => void;
}) {
  const ids = importIds(base);
  // Shown in place of the review and its Import button, which had the focus: the title takes it,
  // unless the user moved it while the import ran.
  const title = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (focusDropped()) title.current?.focus();
  }, []);
  const failedLinks = links.filter((l) => l.stage);
  const changedLinks = links.filter((l) => l.changes.length || l.warnings.length);
  const failed = rowsLines(
    result.activities.filter((a) => Object.keys(a.errors ?? {}).length > 0), transactions, fundName, place, accountName, rejection);
  // Rows Wealthfolio skipped that the preview didn't expect to be duplicates.
  const forced = new Set(sent.filter((r) => r.forceImport).map((r) => r.lineNumber));
  const skipped = rowsLines(
    result.activities.filter((a) => (a.duplicateOfId || a.duplicateOfLineNumber) && !forced.has(a.lineNumber)),
    transactions, fundName, place, accountName);
  const heading = imported === total
    ? `${plural(total, "transaction")} imported`
    : imported
      ? `${imported} of ${plural(total, "transaction")} imported`
      : "No transactions were imported";
  const created = result.summary.assetsCreated ?? 0;
  const differ = Array.isArray(closing) ? closing.filter((f) => !sameUnits(f)) : [];
  // Each fund that differs by the Review screen's name, or by its label there when another fund
  // listed goes by the same name.
  const differNames = differ.map(unitsFund);
  const differName = (i: number) => {
    const { key, name, label } = differNames[i];
    return differNames.some((o) => o.key !== key && o.name.toUpperCase() === name.toUpperCase()) ? label : name;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span ref={title} id={ids.title} tabIndex={-1}>
            {heading}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <ul className="grid gap-2">
          {outcomes.map((a) => (
            <li key={a.key} id={ids.account(a.key)} tabIndex={-1} className="flex flex-wrap items-center gap-2">
              <Mark ok={a.state === "imported" && a.imported > 0} />
              <span>{outcomeWords(a)}</span>
              {a.state !== "imported" && a.retryable !== false && (
                <WrapButton type="button" variant="outline" size="sm" onClick={() => onRetryAccount(a.key)}>
                  Try again<span className="sr-only">: {a.name}</span>
                </WrapButton>
              )}
            </li>
          ))}
        </ul>
        {found.length > 0 && (
          <ul className="grid gap-2">
            {found.map((f) => (
              <li key={f.transaction.transaction.activity.lineNumber} className="flex flex-wrap items-center gap-2">
                <Mark ok={false} />
                <span>{foundLine(f, fundName, place)}</span>
              </li>
            ))}
          </ul>
        )}
        {created > 0 && <p className="text-muted-foreground">Wealthfolio added {plural(created, "fund")}.</p>}
        {closing === "failed" && (
          <p id={ids.units} tabIndex={-1} className="flex flex-wrap items-center gap-2">
            <span className="text-warning">Saved, but the units couldn't be checked in Wealthfolio.</span>
            <WrapButton type="button" variant="outline" size="sm" onClick={onCheckAgain}>
              Check again<span className="sr-only">: the units in Wealthfolio</span>
            </WrapButton>
          </p>
        )}
        {Array.isArray(closing) && closing.length > 0 && (
          <div id={ids.units} tabIndex={-1} className="grid gap-2">
            {differ.length ? (
              <>
                <p className="text-warning">{unitsDifferWords(differ.length, closing.length)}</p>
                <ul className="grid gap-2 ps-4">
                  {differ.map((f, i) => (
                    <li key={`${f.accountId} ${f.asset.symbol}`} className="flex flex-wrap items-center gap-x-2">
                      <span>
                        {differName(i)}:{" "}
                        {f.held === undefined
                          ? "its units need a look in Wealthfolio, after a split or an option's expiry."
                          : `Wealthfolio has ${units(format(f.held))} units, the statement says ${units(format(f.statement))}.`}
                      </span>
                      <LinkButton type="button" onClick={() => onOpenAccount(f.accountId)}>
                        Open {accountName(f.accountId)}
                      </LinkButton>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                <Mark ok /> Checked in Wealthfolio: units match the statement for {every(closing.length, "fund")}.
              </p>
            )}
          </div>
        )}
        {failed.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Wealthfolio rejected rows</AlertTitle>
            <AlertDescription>
              These transactions weren't imported. The rows below say why:
              <RowsList lines={failed} />
            </AlertDescription>
          </Alert>
        )}
        {links.length > failedLinks.length && (
          <p id={ids.linked} tabIndex={-1}>
            <Mark ok /> Linked {links.length - failedLinks.length} of {plural(links.length, "bank entry", "bank entries")} you chose with{" "}
            {links.length === 1 ? "its transaction" : "their transactions"}.
          </p>
        )}
        {failedLinks.length > 0 && (
          <ul className="grid gap-2">
            {failedLinks.map((l) => (
              <li key={l.bankRow.id} id={ids.link(l)} tabIndex={-1} className="flex flex-wrap items-center gap-2">
                <Mark ok={false} />
                <span>{linkLine(l, fundName, place)}</span>
                {canRetryLink(l) && (
                  <WrapButton type="button" variant="outline" size="sm" onClick={() => onRetryLink(l)}>
                    Try again
                    <span className="sr-only">
                      : link the bank entry of {longDate(l.day)} with {transactionName(l.transaction, fundName, place)}
                    </span>
                  </WrapButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {changedLinks.length > 0 && (
          <Alert variant={changedLinks.some((l) => l.warnings.length) ? "warning" : "default"}>
            <AlertTitle>What changed in the bank entries you chose</AlertTitle>
            <AlertDescription>
              Check these in Wealthfolio:
              <ul className="list-disc ps-4">
                {changedLinks.map((l) => (
                  <li key={l.bankRow.id}>
                    {entryName(l.bankRow, l.day, accountName(l.bankRow.accountId))}, for {transactionName(l.transaction, fundName, place)}:{" "}
                    {[...l.changes, ...l.warnings].join(" ")}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {skipped.length > 0 && (
          <Alert variant="warning">
            <AlertTitle>Wealthfolio skipped rows the preview didn't expect</AlertTitle>
            <AlertDescription>
              Their transactions may now lack their purchase, sale or cash. Check these in Wealthfolio:
              <RowsList lines={skipped} />
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
