import type { ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
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
import { type FundUnits, type PlannedRow, type PlannedTransaction, sameUnits, type Status } from "../cas/plan";

const LABELS: Record<string, string> = {
  BUY: "purchase",
  SELL: "sale",
  DIVIDEND: "dividend",
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
};
const label = (row: ActivityImport) => (row.subtype === "DRIP" ? "reinvested dividend" : LABELS[row.activityType] ?? row.activityType);

const STATUS: Record<Status, { badge: string; variant: "success-subtle" | "secondary" | "warning-subtle" | "destructive-subtle" }> = {
  new: { badge: "New", variant: "success-subtle" },
  existing: { badge: "Already in Wealthfolio", variant: "secondary" },
  duplicate: { badge: "Possible duplicate", variant: "warning-subtle" },
  invalid: { badge: "Can't import", variant: "destructive-subtle" },
};

function reasons(row: PlannedRow) {
  const name = label(row.activity);
  const duplicate = row.existingId
    ? `Wealthfolio already has this ${name}.`
    : row.repeatsLine !== undefined
      ? `This ${name} equals another one in this statement.`
      : row.flagged
        ? `Wealthfolio reports this ${name} as a duplicate.`
        : "";
  return [duplicate, ...row.errors, ...row.warnings].filter(Boolean);
}

function Warnings({ title, warnings }: { title: string; warnings: MappingWarning[] }) {
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
  onImport,
  importing,
  rowCount,
}: {
  mapping: Mapping;
  plan: PlannedTransaction[];
  importAnyway: Set<PlannedTransaction>;
  onImportAnyway: (t: PlannedTransaction, yes: boolean) => void;
  onImport: () => void;
  importing: boolean;
  rowCount: number;
}) {
  const count = (status: Status) => plan.filter((t) => t.status === status).length;
  const caveats = mapping.warnings.filter((w) => !w.leftOut);
  const caveatsOf = (t: PlannedTransaction) => caveats.filter((w) => w.rows[0] === t.transaction.rows[0]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <p className="text-muted-foreground text-sm">
          {count("new")} new transactions, {count("existing")} already in Wealthfolio, {count("duplicate")} possible
          duplicates and {count("invalid")} Wealthfolio can't import. Each purchase comes with a deposit and each sale
          or dividend payout with a withdrawal, as if the money came from or went to a bank account outside Wealthfolio;
          the add-on sends a transaction with its cash or neither row.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Warnings title="Left out" warnings={mapping.warnings.filter((w) => w.leftOut)} />
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
              const { activity, cash } = t.transaction;
              const notes = [...t.rows.flatMap(reasons), ...caveatsOf(t).map((w) => w.message)];
              return (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap">{String(activity.date)}</TableCell>
                  <TableCell>{t.transaction.scheme}</TableCell>
                  <TableCell>{label(activity)}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.quantity ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.unitPrice ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.tax ?? ""}</TableCell>
                  <TableCell className="text-end tabular-nums">{activity.amount}</TableCell>
                  <TableCell className="whitespace-nowrap">{cash ? `${label(cash)} ${cash.amount}` : ""}</TableCell>
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
}: {
  result: ImportActivitiesResult;
  /** The rows sent, to tell Wealthfolio's surprises apart. */
  sent: ActivityImport[];
  closing: FundUnits[];
}) {
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
