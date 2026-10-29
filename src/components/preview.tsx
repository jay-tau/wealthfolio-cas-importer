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
import { day, type FundUnits, type PlannedRow, type PlannedTransaction, sameUnits, type Status } from "../cas/plan";

const LABELS: Record<string, string> = {
  BUY: "purchase",
  SELL: "sale",
  DIVIDEND: "dividend",
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
  TRANSFER_IN: "transfer in",
  TRANSFER_OUT: "transfer out",
};
const label = (row: { activityType: string; subtype?: string | null }) =>
  row.subtype === "DRIP" ? "reinvested dividend" : LABELS[row.activityType] ?? row.activityType;

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
          {count("new")} new transactions, {count("existing")} already in Wealthfolio, {count("duplicate")} possible
          duplicates and {count("invalid")} Wealthfolio can't import. Each purchase comes with a transfer from the
          bank account you chose, and each sale or dividend payout with a transfer to it. Without one, and for switches
          and mergers, a purchase comes with a deposit and a sale or payout with a withdrawal, as if the money came
          from or went outside Wealthfolio. When you use a bank row Wealthfolio already has, the add-on imports the
          trade first, then adds and links its cash.
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
            purchases on the same day. The add-on compares each row with the account's activities, so a later import of
            this statement still finds them.
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Fund</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead className="text-end">Units</TableHead>
              <TableHead className="text-end">NAV</TableHead>
              <TableHead className="text-end">Tax</TableHead>
              <TableHead className="text-end">Amount</TableHead>
              <TableHead>Cash</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.map((t, i) => {
              const { activity, cash, bank } = t.transaction;
              const notes = [...t.rows.flatMap(reasons), ...caveatsOf(t).map((w) => w.message)];
              const match = matches.get(t);
              return (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap">{String(activity.date)}</TableCell>
                  <TableCell>{t.transaction.scheme}</TableCell>
                  <TableCell>{label(activity)}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.quantity ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.unitPrice ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.tax ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.amount}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {cash ? `${label(cash)} ${cash.amount}` : ""}
                    {bank && (
                      <span className="text-muted-foreground block text-xs">
                        {bank.activityType === "TRANSFER_OUT" ? "from" : "to"} {accountName(bank.accountId)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <Badge variant={STATUS[t.status].variant}>{STATUS[t.status].badge}</Badge>
                      {notes.map((note, j) => (
                        <span key={j} className="text-muted-foreground text-xs">
                          {note}
                        </span>
                      ))}
                      {(t.status === "duplicate" || t.status === "existing") && (
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
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Button type="button" disabled={importing || rowCount === 0} onClick={onImport}>
          {importing && <Spinner />}
          {importing ? "Importing…" : `Import ${rowCount} activities`}
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
              Imported {summary.imported} of {summary.total} activities
            </AlertTitle>
            <AlertDescription>
              Wealthfolio skipped {summary.duplicates} as duplicates and created {summary.assetsCreated} funds.
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
            Linked {links.length - failedLinks.length} of {links.length} bank rows you chose with their transactions.
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
