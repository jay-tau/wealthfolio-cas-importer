import {
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
import { dec, format, isZero } from "../cas/decimal";
import { type UnitCheck, unitStatus } from "../cas/holdings";
import { nameNumber } from "../lib/name-number";
import { plural } from "../lib/plural";

const BADGES = {
  match: { badge: "Match", variant: "success-subtle" },
  differ: { badge: "Differ", variant: "warning-subtle" },
  review: { badge: "Needs review", variant: "warning-subtle" },
} as const;

/** Where the statement lists the holding: each folio, demat account or PRAN once. */
const listedIn = (check: UnitCheck) =>
  [...new Set([
    ...check.lines.map(({ source, holding }) => `${source.label}${isZero(dec(holding.units)) ? " (no units)" : ""}`),
    ...(check.misread ?? []).map(({ source }) => `${source.label} (may be misread)`),
  ])].join("; ");

export interface Checked {
  checks: UnitCheck[];
  /** Archived accounts that track transactions: Wealthfolio shows add-ons none of their activities. */
  archived: string[];
}

export function UnitsCheckCard({
  checked,
  same,
  checking,
  blocked,
  onCheck,
  onSame,
}: {
  checked: Checked | null;
  /** Holdings, by `ref`, whose accounts the user confirmed hold the same units as the statement. */
  same: ReadonlySet<string>;
  checking: boolean;
  /** Why the check can't run yet. */
  blocked: string;
  onCheck: () => void;
  onSame: (ref: string, yes: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Check against transactions</CardTitle>
        <p className="text-muted-foreground text-sm">
          Compares each confirmed holding's units on the statement with what Wealthfolio accounts that track transactions
          add up to on the statement's date, from their posted activities. A difference can mean a purchase or
          redemption that wasn't imported, bonus units or shares, a transfer in or out, or shares from a demerger. The
          check only reads, and needs no account that tracks holdings.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={checking || blocked !== ""} onClick={onCheck}>
            {checking && <Spinner />}
            Check units
          </Button>
          {blocked && <span className="text-muted-foreground text-sm">{blocked}</span>}
          <p role="status" className="sr-only">
            {checking
              ? "Checking the units…"
              : checked
                ? `Compared the units of ${checked.checks.filter((c) => !c.problem).length} of ${plural(checked.checks.length, "holding")}.`
                : ""}
          </p>
        </div>
        {checked && (
          <>
            <p className="text-sm">
              Tick Same holdings when the accounts compared hold the holding only for the folios, demat accounts and PRANs
              listed, and hold all of their units. Until then its row needs review: an account can hold units from
              outside this statement, and several folios can share one.
            </p>
            {checked.archived.length > 0 && (
              <p className="text-muted-foreground text-sm">
                Wealthfolio doesn't show add-ons the activities of archived accounts, so {checked.archived.join(", ")}{" "}
                {checked.archived.length === 1 ? "isn't" : "aren't"} compared.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Holding</TableHead>
                  <TableHead>Accounts compared</TableHead>
                  <TableHead className="text-end">Units in the statement</TableHead>
                  <TableHead className="text-end">Units in Wealthfolio</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checked.checks.map((check, i) => {
                  const label = `${check.name.trim()}${nameNumber(checked.checks, i, "holding")}`;
                  const yes = same.has(check.ref);
                  const { badge, variant } = BADGES[unitStatus(check, yes)];
                  return (
                    <TableRow key={check.ref}>
                      <TableCell>
                        <div className="grid gap-1">
                          <span>{check.name}</span>
                          <span className="text-muted-foreground text-xs">{listedIn(check)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="grid gap-1">
                          {check.accounts.map((a) => (
                            <span key={a.id}>
                              {a.name}
                              {check.accounts.length > 1 && (
                                <span className="text-muted-foreground tabular-nums">
                                  {" "}
                                  · {a.units === undefined ? "unknown" : format(a.units)}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{check.misread ? "Unknown" : format(check.statement)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {check.held !== undefined ? format(check.held) : check.accounts.length ? "Unknown" : ""}
                      </TableCell>
                      <TableCell>
                        <div className="grid gap-1">
                          {/* The badge hides its overflow, so without a minimum width Chromium sizes the column without it. */}
                          <Badge className="min-w-fit" variant={variant}>
                            {badge}
                          </Badge>
                          {check.problem ? (
                            <span className="text-muted-foreground text-xs">{check.problem}</span>
                          ) : (
                            <>
                              {!yes && (
                                <span className="text-muted-foreground text-xs">
                                  Confirm that the accounts compared hold the same units as the statement.
                                </span>
                              )}
                              <Label className="flex items-center gap-2 text-xs font-normal">
                                <Checkbox checked={yes} onCheckedChange={(value) => onSame(check.ref, value === true)} />
                                Same holdings
                                <span className="sr-only"> for {label}</span>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
