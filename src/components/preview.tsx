import type { Account, ActivityDetails, ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
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
import { format } from "../cas/decimal";
import type { Mapping } from "../cas/mapping";
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
import { plural } from "../lib/plural";
import { longDate, units } from "../lib/review-format";
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
/** "the 2023-05-05 purchase of Fictiva Liquid Fund" */
const transactionName = ({ transaction: { activity, scheme } }: PlannedTransaction) =>
  `the ${String(activity.date)} ${label(activity)} of ${scheme}`;
/** "Purchase of Fictiva Liquid Fund on 5 May 2023" */
const transactionTitle = ({ transaction: { activity, scheme } }: PlannedTransaction) => {
  const what = label(activity);
  return `${what[0].toUpperCase()}${what.slice(1)} of ${scheme} on ${longDate(String(activity.date).slice(0, 10))}`;
};
/** "The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF)" */
const entryName = (entry: ActivityDetails, accountName: string) =>
  `The ${label(entry)} of ${entry.amount} on ${day(entry.date)} in ${accountName}${entry.comment ? ` (${entry.comment})` : ""}`;
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
  /** What linking it changes, as read then, for a retry. */
  facts: EntryFacts;
}

/** What changed in an entry the user chose, between the review and Import. */
export function staleText(s: StaleEntry, accountName: (id: string) => string) {
  const then = `${entryName(s.before, accountName(s.before.accountId))}, chosen for ${transactionName(s.transaction)},`;
  const now = s.after && `a ${label(s.after)} of ${s.after.amount} on ${day(s.after.date)}`;
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
};

function reasons(row: PlannedRow) {
  const name = label(row.activity);
  const duplicate = row.existingId
    ? row.existingType
      ? `Wealthfolio already has this ${name}, as a ${label({ activityType: row.existingType })}.`
      : `Wealthfolio already has this ${name}.`
    : row.repeatsLine !== undefined
      ? `This ${name} equals another one in this statement.`
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
  accounts,
  label: tableLabel,
}: {
  mapping: Mapping;
  plan: PlannedTransaction[];
  sent: (t: PlannedTransaction) => boolean;
  linked: (t: PlannedTransaction) => boolean;
  accounts: Account[];
  label: string;
}) {
  const caveats = mapping.warnings.filter((w) => !w.leftOut);
  const caveatsOf = (t: PlannedTransaction) => caveats.filter((w) => w.rows[0] === t.transaction.rows[0]);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "the bank account";
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
            earlierNote(t),
            ...currencyNotes(t),
            forced ? "Imported anyway, by your answer." : undefined,
          ].filter((note) => note !== undefined);
          const cells = (scheme: string, row: ActivityImport, standIns: (keyof ActivityImport)[] = []) => (
            <>
              <TableCell className="px-1.5 whitespace-nowrap">{String(row.date)}</TableCell>
              <TableCell className="px-1.5">{scheme}</TableCell>
              <TableCell className="px-1.5">{label(row)}</TableCell>
              <TableCell className="px-1.5 text-end tabular-nums">{row.quantity ?? ""}</TableCell>
              <TableCell className="px-1.5 text-end tabular-nums">{row.unitPrice ?? ""}</TableCell>
              <TableCell className="px-1.5 text-end tabular-nums">{row.tax ?? ""}</TableCell>
              <TableCell className="px-1.5 text-end tabular-nums">
                {row.amount ?? ""}
                {standIns.includes("amount") && <span className="text-muted-foreground block text-xs">stand-in</span>}
              </TableCell>
            </>
          );
          return [
            <TableRow key={i}>
              {cells(t.transaction.scheme, activity, t.transaction.standIns)}
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
                    {cells(second.scheme, second.activity)}
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
  const when = longDate(day(l.bankRow.date));
  switch (l.stage) {
    case "trade":
      return `The trade wasn't imported, so the bank entry of ${when} was left as it is.`;
    case "transfer":
      return `The trade is in Wealthfolio, but the fund account's transfer wasn't added, so the bank entry of ${when} wasn't linked.`;
    case "convert":
      return `The trade and the fund account's transfer are in Wealthfolio; the bank entry of ${when} wasn't changed into a transfer or linked.`;
    default:
      return `The trade and the fund account's transfer are in Wealthfolio; the bank entry of ${when} wasn't linked.`;
  }
}

/** ✓ or ✗ before a line: the words say it too, so it isn't read out. */
const Mark = ({ ok }: { ok: boolean }) => (
  <span aria-hidden="true" className={ok ? "text-success" : "text-destructive"}>
    {ok ? "✓" : "✗"}
  </span>
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
  total,
  imported,
  outcomes,
  closing,
  links,
  accounts,
  base,
  onRetryAccount,
  onRetryLink,
  onCheckAgain,
  onOpenAccount,
}: {
  result: ImportActivitiesResult;
  /** The rows sent, to tell Wealthfolio's surprises apart. */
  sent: ActivityImport[];
  /** The transactions the review approved, and those that went in. */
  total: number;
  imported: number;
  outcomes: ImportOutcome[];
  closing: ClosingCheck;
  links: BankLink[];
  accounts: Account[];
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
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "the bank account";
  const failed = result.activities.filter((a) => Object.keys(a.errors ?? {}).length > 0);
  // Rows Wealthfolio skipped that the preview didn't expect to be duplicates.
  const forced = new Set(sent.filter((r) => r.forceImport).map((r) => r.lineNumber));
  const skipped = result.activities.filter(
    (a) => (a.duplicateOfId || a.duplicateOfLineNumber) && !forced.has(a.lineNumber),
  );
  const heading = imported === total
    ? `${plural(total, "transaction")} imported`
    : imported
      ? `${imported} of ${plural(total, "transaction")} imported`
      : "No transactions were imported";
  const created = result.summary.assetsCreated ?? 0;
  const differ = Array.isArray(closing) ? closing.filter((f) => !sameUnits(f)) : [];
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
                <p className="text-warning">
                  {`Checked in Wealthfolio: units differ for ${differ.length} of ${plural(closing.length, "fund")}.`}
                </p>
                <ul className="grid gap-2 ps-4">
                  {differ.map((f) => (
                    <li key={`${f.accountId} ${f.asset.symbol}`} className="flex flex-wrap items-center gap-x-2">
                      <span>
                        {f.schemes[0].scheme}:{" "}
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
                <Mark ok /> Checked in Wealthfolio: units match the statement for{" "}
                {closing.length === 1 ? "the fund" : `all ${closing.length} funds`}.
              </p>
            )}
          </div>
        )}
        {failed.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Wealthfolio rejected rows</AlertTitle>
            <AlertDescription>
              These transactions weren't imported. The rows below say why:
              <ul className="list-disc ps-4">
                {failed.map((a) => (
                  <li key={a.lineNumber}>
                    {String(a.date)} {label(a)}: {Object.values(a.errors ?? {}).flat().join(" ")}
                  </li>
                ))}
              </ul>
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
                <span>
                  {transactionTitle(l.transaction)}: {linkWords(l)}
                </span>
                {l.stage !== "trade" && (
                  <WrapButton type="button" variant="outline" size="sm" onClick={() => onRetryLink(l)}>
                    Try again<span className="sr-only">: link the bank entry of {longDate(day(l.bankRow.date))}</span>
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
                    {entryName(l.bankRow, accountName(l.bankRow.accountId))}, for {transactionName(l.transaction)}:{" "}
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
              <ul className="list-disc ps-4">
                {skipped.map((a) => (
                  <li key={a.lineNumber}>
                    {String(a.date)} {label(a)} {a.symbol} {String(a.amount ?? "")}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
