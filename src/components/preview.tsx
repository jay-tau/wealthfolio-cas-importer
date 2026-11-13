import type { Account, ActivityDetails, ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { type RefCallback, useEffect, useRef } from "react";
import { type EntryFacts, entryNotes, OUTSIDE_SPENDING, outsideSpending, type Reused, type StaleEntry } from "../cas/bank-entries";
import { format } from "../cas/decimal";
import type { Mapping, MappingWarning } from "../cas/mapping";
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
/** Hidden text that tells a transaction's checkboxes apart for screen readers. */
const which = ({ transaction: { activity, scheme, folio } }: PlannedTransaction, number: number) =>
  `${String(activity.date)} ${label(activity)} of ${scheme}${activity.amount ? `, ${activity.amount}` : ""}, folio ${folio}, transaction ${number}`;
/** "the 2023-05-05 purchase of Fictiva Liquid Fund" */
const transactionName = ({ transaction: { activity, scheme } }: PlannedTransaction) =>
  `the ${String(activity.date)} ${label(activity)} of ${scheme}`;
/** "The withdrawal of 25000.00 on 2023-05-04 in Savings (NEFT FICTIVA MF)" */
const entryName = (entry: ActivityDetails, accountName: string) =>
  `The ${label(entry)} of ${entry.amount} on ${day(entry.date)} in ${accountName}${entry.comment ? ` (${entry.comment})` : ""}`;
const list = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";

/** How many transactions the preview has of each status: "13 new transactions, 0 already in Wealthfolio, …". */
export function previewCounts(plan: PlannedTransaction[]) {
  const count = (status: Status) => plan.filter((t) => t.status === status).length;
  return `${plural(count("new"), "new transaction")}, ${count("existing")} already in Wealthfolio, ${plural(count("duplicate"), "possible duplicate")} and ${count("invalid")} Wealthfolio can't import`;
}

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
}

/** What changed in an entry the user ticked, between the preview and Import. */
function staleText(s: StaleEntry, accountName: (id: string) => string) {
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

function Warnings({
  title,
  warnings,
  onImportUnbalanced,
  unbalancedRef,
  importing,
}: {
  title: string;
  warnings: MappingWarning[];
  onImportUnbalanced: (w: MappingWarning, yes: boolean) => void;
  unbalancedRef?: (w: MappingWarning) => RefCallback<HTMLElement>;
  importing: boolean;
}) {
  if (!warnings.length) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc ps-4">
          {warnings.map((w, i) => (
            <li key={i}>
              {w.scheme}, folio {w.folio}
              {w.rows.length > 0 && `, ${w.rows[0].date} ${w.rows[0].description}`}: {w.message}
              {w.unbalanced && (
                <Label className="mt-1 flex items-center gap-2 font-normal">
                  <Checkbox
                    ref={unbalancedRef?.(w)}
                    disabled={importing}
                    checked={!w.leftOut}
                    onCheckedChange={(yes) => onImportUnbalanced(w, yes)}
                  />
                  Import this fund anyway
                  <span className="sr-only"> for {w.scheme}, folio {w.folio}</span>
                </Label>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function Preview({
  mapping,
  plan,
  importAnyway,
  onImportAnyway,
  onImportUnbalanced,
  unbalancedRef,
  onImport,
  importing,
  rowCount,
  matches,
  facts,
  stale,
  reuse,
  onReuse,
  accounts,
}: {
  mapping: Mapping;
  plan: PlannedTransaction[];
  importAnyway: Set<PlannedTransaction>;
  onImportAnyway: (t: PlannedTransaction, yes: boolean) => void;
  /** Includes or leaves out a scheme whose rows don't add up to its closing balance, and previews again. */
  onImportUnbalanced: (w: MappingWarning, yes: boolean) => void;
  /** The ref of each scheme's checkbox for `onImportUnbalanced`. */
  unbalancedRef?: (w: MappingWarning) => RefCallback<HTMLElement>;
  onImport: () => void;
  importing: boolean;
  rowCount: number;
  /** The bank row each new transaction could use instead of a new one. */
  matches: Map<PlannedTransaction, ActivityDetails>;
  /** What reusing each of those changes, by its ID. */
  facts: Map<string, EntryFacts>;
  /** Ticked entries that changed since the preview, which stopped the last Import. */
  stale?: StaleEntry[];
  reuse: Set<PlannedTransaction>;
  onReuse: (t: PlannedTransaction, yes: boolean) => void;
  accounts: Account[];
}) {
  const count = (status: Status) => plan.filter((t) => t.status === status).length;
  const caveats = mapping.warnings.filter((w) => !w.leftOut);
  const caveatsOf = (t: PlannedTransaction) => caveats.filter((w) => w.rows[0] === t.transaction.rows[0]);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "the bank account";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <p className="text-muted-foreground text-sm">
          {previewCounts(plan)}. Each purchase comes with a transfer from the
          bank account you chose, and each sale or dividend payout with a transfer to it. Without one, and for
          switches, a purchase comes with a deposit and a sale or payout with a withdrawal, as if the money came from
          or went outside Wealthfolio. When you use a bank row Wealthfolio already has, the add-on imports the trade
          first, then adds and links its cash. A fund house's merger is a fund conversion: the new fund's units keep
          the old fund's cost and purchase dates, nothing is sold and no cash moves. A gift is a transfer of its units
          at that day's NAV, with no cash; when both sides are in two of your accounts, Wealthfolio links them and the
          receiving account keeps the giver's costs and purchase dates. Units a segregated portfolio credits are a
          purchase at a stand-in cost of ₹0, with no cash: Wealthfolio can't move part of the main fund's cost to them.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Warnings
          title="Left out"
          warnings={mapping.warnings.filter((w) => w.leftOut)}
          onImportUnbalanced={onImportUnbalanced}
          unbalancedRef={unbalancedRef}
          importing={importing}
        />
        <Warnings
          title="Imported anyway"
          warnings={caveats.filter((w) => w.unbalanced)}
          onImportUnbalanced={onImportUnbalanced}
          unbalancedRef={unbalancedRef}
          importing={importing}
        />
        {count("duplicate") + count("existing") > 0 && (
          <p className="text-sm">
            Transactions marked as duplicates are skipped unless you tick "Import anyway". Each row the add-on imports
            carries an ID from the statement, which later imports find it by, even after you edit it, so equal
            transactions, such as two equal purchases on one day, each go in once. Activities without such an ID,
            imported by an earlier version of the add-on or entered by hand, are compared by their values: tick "Import
            anyway" for a transaction that isn't one of them. A fund conversion has no "Import anyway": Wealthfolio keeps
            one per merger.
          </p>
        )}
        {[...matches.values()].some((m) => outsideSpending(facts.get(m.id))) && <p className="text-sm">{OUTSIDE_SPENDING}</p>}
        {/* Narrow padding and wrapping Cash keep Status visible with Extra large text in a 1440 px window. */}
        <Table>
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
              const notes = [
                ...t.rows.flatMap(reasons),
                ...caveatsOf(t).map((w) => w.message),
                t.problem,
                earlierNote(t),
                ...currencyNotes(t),
              ].filter((note) => note !== undefined);
              const match = matches.get(t);
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
                      {(t.status === "duplicate" || t.status === "existing") && !arriving && (
                        <Label className="flex items-center gap-2 text-xs font-normal">
                          <Checkbox disabled={importing} checked={importAnyway.has(t)} onCheckedChange={(yes) => onImportAnyway(t, yes)} />
                          Import anyway
                          <span className="sr-only"> for the {which(t, i + 1)}</span>
                        </Label>
                      )}
                      {match && (
                        <>
                          <span className="text-muted-foreground text-xs">
                            {accountName(match.accountId)} has a {label(match)} of {match.amount} on {day(match.date)}
                            {match.comment ? ` (${match.comment})` : ""}.
                            {match.activityType !== bank?.activityType &&
                              ` If you use it, the add-on changes it into a ${label(bank!)} and links it with this ${label(cash!)}.`}
                          </span>
                          {entryNotes(facts.get(match.id), accountName(match.accountId)).map((note, j) => (
                            <span key={`entry-${j}`} className="text-muted-foreground text-xs">
                              {note}
                            </span>
                          ))}
                          <Label className="flex items-center gap-2 text-xs font-normal">
                            <Checkbox disabled={importing} checked={reuse.has(t)} onCheckedChange={(yes) => onReuse(t, yes)} />
                            Use it instead of a new {label(bank!)}
                            <span className="sr-only"> for the {which(t, i + 1)}</span>
                          </Label>
                        </>
                      )}
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
        {stale && stale.length > 0 && (
          <Alert variant="warning">
            <AlertTitle>Nothing was imported: bank entries you chose changed</AlertTitle>
            <AlertDescription>
              The preview now shows them as Wealthfolio has them. Check them, then import again.
              <ul className="list-disc ps-4">
                {stale.map((s) => (
                  <li key={s.before.id}>{staleText(s, accountName)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <Button type="button" disabled={importing || rowCount === 0} onClick={onImport}>
          {importing && <Spinner />}
          {importing ? "Importing…" : `Import ${plural(rowCount, "activity", "activities")}`}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ImportResult({
  result,
  sent,
  closing,
  links,
  accounts,
}: {
  result: ImportActivitiesResult;
  /** The rows sent, to tell Wealthfolio's surprises apart. */
  sent: ActivityImport[];
  closing: FundUnits[];
  links: BankLink[];
  accounts: Account[];
}) {
  // Shown in place of the preview and its Import button, which had the focus: the summary takes it,
  // unless the user moved it while the import ran.
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusDropped()) summaryRef.current?.focus();
  }, []);
  const failedLinks = links.filter((l) => l.error);
  const changedLinks = links.filter((l) => l.changes.length || l.warnings.length);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "the bank account";
  const { summary } = result;
  const failed = result.activities.filter((a) => Object.keys(a.errors ?? {}).length > 0);
  // Rows Wealthfolio skipped that the preview didn't expect to be duplicates.
  const forced = new Set(sent.filter((r) => r.forceImport).map((r) => r.lineNumber));
  const skipped = result.activities.filter(
    (a) => (a.duplicateOfId || a.duplicateOfLineNumber) && !forced.has(a.lineNumber),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {summary.success ? (
          <Alert ref={summaryRef} tabIndex={-1} variant="success">
            <AlertTitle>
              Imported {summary.imported} of {plural(summary.total, "activity", "activities")}
            </AlertTitle>
            <AlertDescription>
              Wealthfolio skipped {summary.duplicates} as {summary.duplicates === 1 ? "a duplicate" : "duplicates"} and
              created {plural(summary.assetsCreated, "fund")}.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert ref={summaryRef} tabIndex={-1} variant="destructive">
            <AlertTitle>Nothing was imported</AlertTitle>
            <AlertDescription>
              {(summary as { errorMessage?: string }).errorMessage ?? "Wealthfolio rejected the import."}
            </AlertDescription>
          </Alert>
        )}
        {failed.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Wealthfolio rejected rows</AlertTitle>
            <AlertDescription>
              Their transactions may lack their purchase, sale or cash. Check these in Wealthfolio:
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
          <p className="text-sm">
            Linked {links.length - failedLinks.length} of {plural(links.length, "bank row")} you chose with{" "}
            {links.length === 1 ? "its transaction" : "their transactions"}.
          </p>
        )}
        {failedLinks.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Bank rows not linked</AlertTitle>
            <AlertDescription>
              <ul className="list-disc ps-4">
                {failedLinks.map((l) => (
                  <li key={l.bankRow.id}>
                    {String(l.transaction.transaction.activity.date)} {label(l.transaction.transaction.activity)}{" "}
                    {l.transaction.transaction.scheme}, bank row of {l.bankRow.amount} on {day(l.bankRow.date)}: {l.error}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {changedLinks.length > 0 && (
          <Alert variant={changedLinks.some((l) => l.warnings.length) ? "warning" : "default"}>
            <AlertTitle>What changed in the bank rows you chose</AlertTitle>
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
        {summary.success && closing.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fund</TableHead>
                <TableHead className="text-end">Units in the statement</TableHead>
                <TableHead className="text-end">Units in Wealthfolio</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {closing.map((f) => (
                <TableRow key={`${f.accountId} ${f.asset.symbol}`}>
                  <TableCell>{f.schemes[0].scheme}</TableCell>
                  <TableCell className="text-end tabular-nums">{format(f.statement)}</TableCell>
                  <TableCell className="text-end tabular-nums">{f.held === undefined ? "Needs review: split or option expiry" : format(f.held)}</TableCell>
                  <TableCell>
                    {sameUnits(f) ? (
                      <Badge variant="success-subtle">Match</Badge>
                    ) : (
                      <Badge variant="warning-subtle">{f.held === undefined ? "Needs review" : "Differ"}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
