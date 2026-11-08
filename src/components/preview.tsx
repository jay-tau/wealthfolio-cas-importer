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
import { plural } from "../lib/plural";

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

/** A transaction whose cash went to a bank row already in Wealthfolio, and what went wrong. */
export interface BankLink {
  transaction: PlannedTransaction;
  bankRow: ActivityDetails;
  error?: string;
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
  importing,
}: {
  title: string;
  warnings: MappingWarning[];
  onImportUnbalanced: (w: MappingWarning, yes: boolean) => void;
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
                  <Checkbox disabled={importing} checked={!w.leftOut} onCheckedChange={(yes) => onImportUnbalanced(w, yes)} />
                  Import this fund anyway
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
  onImport,
  importing,
  rowCount,
  matches,
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
  onImport: () => void;
  importing: boolean;
  rowCount: number;
  /** The bank row each new transaction could use instead of a new one. */
  matches: Map<PlannedTransaction, ActivityDetails>;
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
          {plural(count("new"), "new transaction")}, {count("existing")} already in Wealthfolio,{" "}
          {plural(count("duplicate"), "possible duplicate")} and {count("invalid")} Wealthfolio can't import.
          Each purchase comes with a transfer from the
          bank account you chose, and each sale or dividend payout with a transfer to it. Without one, and for
          switches, a purchase comes with a deposit and a sale or payout with a withdrawal, as if the money came from
          or went outside Wealthfolio. When you use a bank row Wealthfolio already has, the add-on imports the trade
          first, then adds and links its cash. A fund house's merger is a fund conversion: the new fund's units keep
          the old fund's cost and purchase dates, nothing is sold and no cash moves. A gift is a transfer of its units
          at that day's NAV, with no cash; when both sides are in two of your accounts, Wealthfolio links them and the
          receiving account keeps the giver's costs and purchase dates.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Warnings
          title="Left out"
          warnings={mapping.warnings.filter((w) => w.leftOut)}
          onImportUnbalanced={onImportUnbalanced}
          importing={importing}
        />
        <Warnings
          title="Imported anyway"
          warnings={caveats.filter((w) => w.unbalanced)}
          onImportUnbalanced={onImportUnbalanced}
          importing={importing}
        />
        {count("duplicate") + count("existing") > 0 && (
          <p className="text-sm">
            Transactions marked as duplicates are skipped unless you tick "Import anyway", for example for two equal
            purchases on the same day. A fund conversion has no "Import anyway": Wealthfolio keeps one per merger. The
            add-on compares each row with the account's activities, so a later import of this statement still finds
            them.
          </p>
        )}
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
              ].filter((note) => note !== undefined);
              const match = matches.get(t);
              const cells = (scheme: string, row: ActivityImport) => (
                <>
                  <TableCell className="px-1.5 whitespace-nowrap">{String(row.date)}</TableCell>
                  <TableCell className="px-1.5">{scheme}</TableCell>
                  <TableCell className="px-1.5">{label(row)}</TableCell>
                  <TableCell className="px-1.5 text-end tabular-nums">{row.quantity ?? ""}</TableCell>
                  <TableCell className="px-1.5 text-end tabular-nums">{row.unitPrice ?? ""}</TableCell>
                  <TableCell className="px-1.5 text-end tabular-nums">{row.tax ?? ""}</TableCell>
                  <TableCell className="px-1.5 text-end tabular-nums">{row.amount ?? ""}</TableCell>
                </>
              );
              return [
                <TableRow key={i}>
                  {cells(t.transaction.scheme, activity)}
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
                          <Label className="flex items-center gap-2 text-xs font-normal">
                            <Checkbox disabled={importing} checked={reuse.has(t)} onCheckedChange={(yes) => onReuse(t, yes)} />
                            Use it instead of a new {label(bank!)}
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
}: {
  result: ImportActivitiesResult;
  /** The rows sent, to tell Wealthfolio's surprises apart. */
  sent: ActivityImport[];
  closing: FundUnits[];
  links: BankLink[];
}) {
  const failedLinks = links.filter((l) => l.error);
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
          <Alert variant="success">
            <AlertTitle>
              Imported {summary.imported} of {plural(summary.total, "activity", "activities")}
            </AlertTitle>
            <AlertDescription>
              Wealthfolio skipped {summary.duplicates} as {summary.duplicates === 1 ? "a duplicate" : "duplicates"} and
              created {plural(summary.assetsCreated, "fund")}.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
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
                <TableHead />
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
