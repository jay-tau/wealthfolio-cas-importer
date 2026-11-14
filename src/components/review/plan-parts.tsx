import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import { type AccountPlan, type Choices, costOf, included, type PlannedPosition, undecided } from "../../cas/holdings";
import { longDate, rupees, units } from "../../lib/review-format";

/** A position's state in the snapshot as saved. */
export function status(position: PlannedPosition, yes: boolean, keep: boolean | undefined, open = false) {
  if (position.misread) return position.existing ? { badge: "Kept", variant: "secondary" as const } : { badge: "Left out", variant: "secondary" as const };
  if (open) return { badge: "Needs an answer", variant: "warning-subtle" as const };
  // The account's units go with the user's answer.
  if (position.removable && (!position.lines.length || !yes)) {
    return keep !== false ? { badge: "Kept", variant: "secondary" as const } : { badge: "Removed", variant: "warning-subtle" as const };
  }
  if (!position.lines.length) {
    if (yes) return { badge: "Kept", variant: "secondary" as const };
    return { badge: position.replacedBy ? "Replaced" : "Removed", variant: "warning-subtle" as const };
  }
  if (!yes) return { badge: "Left out", variant: "secondary" as const };
  return position.existing ? { badge: "Updated", variant: "success-subtle" as const } : { badge: "New", variant: "success-subtle" as const };
}

/**
 * The account's whole snapshot after saving, read-only: every holding the statement or the account
 * has, its units before and after, value, total cost, what saving does to it and why, and the cash.
 */
export function SnapshotTable({ plan, choices, account }: { plan: AccountPlan; choices: Choices; account: string }) {
  const cash = Object.entries(plan.existing.cash);
  return (
    <div className="grid gap-2">
      <Table aria-label={`${account}'s holdings on ${longDate(plan.date)} after saving`}>
        <TableHeader>
          <TableRow>
            <TableHead>Holding</TableHead>
            <TableHead className="text-end">Units</TableHead>
            <TableHead className="text-end">Value</TableHead>
            <TableHead className="text-end">Total cost</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plan.positions.map((position) => {
            const yes = included(position, choices);
            const { badge, variant } = status(position, yes, choices.keep?.get(position.key), undecided(position, choices));
            const statement = position.lines.length > 0;
            const before = position.existing?.units;
            const listedIn = [...new Set([...position.lines, ...(position.misread ?? [])].map((l) => l.source.title ?? l.source.label))];
            const cost = statement && yes ? costOf(position, choices.costs.get(position.key)) : position.existing?.cost ?? undefined;
            const currency = statement && yes ? "INR" : position.existing?.currency;
            return (
              <TableRow key={position.key}>
                <TableCell>
                  <div className="grid gap-1">
                    <span>{position.name}</span>
                    <span className="text-muted-foreground text-xs">{listedIn.length ? listedIn.join("; ") : "Not on the statement"}</span>
                    {position.notes.map((note, i) => (
                      <span key={i} className="text-muted-foreground text-xs">
                        {note}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-end tabular-nums whitespace-nowrap">
                  {statement && yes ? (before !== undefined ? `${units(before)} → ${units(position.units!)}` : units(position.units!)) : before !== undefined ? units(before) : ""}
                </TableCell>
                <TableCell className="text-end tabular-nums whitespace-nowrap">{statement && position.value ? rupees(position.value) : ""}</TableCell>
                <TableCell className="text-end tabular-nums whitespace-nowrap">{cost ? currency === "INR" ? rupees(cost) : `${currency} ${cost}` : position.existing || (statement && yes) ? "Unknown" : ""}</TableCell>
                <TableCell>
                  {/* The badge hides its overflow, so without a minimum width Chromium sizes the column without it. */}
                  <Badge className="min-w-fit" variant={variant}>
                    {badge}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-muted-foreground text-sm">
        {cash.length
          ? `Cash carried over from the snapshot of ${longDate(plan.existing.date!)}: ${cash.map(([ccy, amount]) => `${ccy} ${amount}`).join(", ")}.`
          : "No cash."}
      </p>
    </div>
  );
}
