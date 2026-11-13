import type { ReactNode } from "react";
import { Badge, Checkbox, Label, RadioGroup, RadioGroupItem, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import {
  type AccountPlan,
  assetName,
  assetNames,
  type Choices,
  costOf,
  included,
  labels,
  type PlannedPosition,
  replacesSnapshot,
  undecided,
} from "../../cas/holdings";
import { longDate, rupees, units } from "../../lib/review-format";
import { nameNumber } from "../../lib/name-number";
import { otherCurrency } from "../fund-choices";

/** A position's state in the snapshot as saved. */
export function status(position: PlannedPosition, yes: boolean, keep: boolean | undefined) {
  if (position.misread) return position.existing ? { badge: "Kept", variant: "secondary" as const } : { badge: "Left out", variant: "secondary" as const };
  // The account's units, which would otherwise count twice, go with the user's choice.
  if (position.removable && (!position.lines.length || !yes)) {
    if (keep === undefined) return { badge: "Needs a choice", variant: "warning-subtle" as const };
    return keep ? { badge: "Kept", variant: "secondary" as const } : { badge: "Removed", variant: "warning-subtle" as const };
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
 * has, its units before and after, value, total cost and what saving does to it, and the cash.
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
            const { badge, variant } = status(position, yes, choices.keep?.get(position.key));
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

/**
 * The positions of an account's snapshot that today's preview decisions are about: the account's own
 * holdings with something to say or a default to change, statement rows left out by default (an
 * earlier import of a source left out, a holding added under another asset), and units the user must
 * choose to keep or remove. Statement rows that are saved, and those an account that tracks
 * transactions already holds, are shown elsewhere unless the account has them too.
 */
export function decisions(plan: AccountPlan) {
  return plan.positions.filter((p) => {
    if (p.misread) return false;
    if (p.removable) return true;
    if (!p.lines.length) return p.notes.length > 0 || !p.include || !!p.replacedBy;
    // Saving it in both accounts is chosen under Already tracked; what the account holds is said here.
    if (p.heldBy) return !!p.existing;
    return !p.include || !!p.replaces;
  });
}

/** Whether the plan's decisions block saving: an undecided keep or remove, or an unticked same-date replacement. */
export const blockers = (plan: AccountPlan, choices: Choices, confirmed: boolean) =>
  (replacesSnapshot(plan) && !confirmed ? 1 : 0) + plan.positions.filter((p) => undecided(p, choices)).length;

/**
 * Today's other preview decisions, with their behaviour, defaults and wording: keeping or removing
 * a holding the statement no longer lists, a source that moved, a fund left out for overlap that an
 * earlier import recorded, replacing an old asset, and replacing a snapshot already saved for the date.
 */
export function BeforeSaving({
  plan,
  account,
  label,
  choices,
  confirmed,
  onFlip,
  onKeep,
  onConfirm,
  disabled,
  change,
}: {
  plan: AccountPlan;
  account: string;
  /** The account's name in accessible names, numbered when another account has the same one. */
  label: string;
  choices: Choices;
  confirmed: boolean;
  onFlip: (key: string) => void;
  onKeep: (key: string, keep: boolean) => void;
  onConfirm: (yes: boolean) => void;
  disabled: boolean;
  /** A statement row's Change, and its panel while it's open. */
  change?: (position: PlannedPosition) => ReactNode;
}) {
  const list = decisions(plan);
  if (!list.length && !replacesSnapshot(plan)) return null;
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <p className="font-medium">{account}</p>
      {replacesSnapshot(plan) && (
        <div className="grid gap-1">
          <p className="text-sm">Wealthfolio has a snapshot of this account on {longDate(plan.date)}. Saving replaces it with this statement's.</p>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox disabled={disabled} checked={confirmed} onCheckedChange={(yes) => onConfirm(yes)} />
            Replace the snapshot of {longDate(plan.date)}
            <span className="sr-only"> in {label}</span>
          </Label>
        </div>
      )}
      {list.map((position) => {
        const yes = included(position, choices);
        const keep = choices.keep?.get(position.key);
        const statement = position.lines.length > 0;
        const choosing = !!position.removable && (!statement || !yes);
        const before = position.existing?.units;
        const replaces = plan.positions.filter((p) => position.replaces?.includes(p.key));
        const currency = statement && position.asset ? otherCurrency(position.asset.quoteCcy, position.asset.symbol) : undefined;
        const { badge, variant } = status(position, yes, keep);
        const listedIn = [...new Set(position.lines.map((l) => l.source.title ?? l.source.label))];
        // Equal holding names are told apart by their place in the account's snapshot.
        const inAccount = `${label}${nameNumber(plan.positions, plan.positions.indexOf(position), "holding")}`;
        return (
          <div key={position.key} className="grid gap-1 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{position.name}</span>
              <Badge className="min-w-fit" variant={variant}>
                {badge}
              </Badge>
            </div>
            <span className="text-muted-foreground text-xs">
              {listedIn.length ? listedIn.join("; ") : "Not on the statement"}
              {before !== undefined && ` · ${account} holds ${units(before)} units`}
            </span>
            {statement && !yes && !position.misread && change?.(position)}
            {[...position.notes, ...(currency ? [currency] : [])].map((note, i) => (
              <span key={i} className="text-muted-foreground text-sm">
                {note}
              </span>
            ))}
            {!position.replacedBy && !position.heldBy && (statement || !position.removable) && (
              <Label className="flex items-center gap-2 text-sm font-normal">
                <Checkbox disabled={disabled} checked={yes} onCheckedChange={() => onFlip(position.key)} />
                {replaces.length ? (
                  <>
                    Replace {assetNames(replaces)} with {assetName(position)}
                    <span className="sr-only"> in {inAccount}</span>
                  </>
                ) : (
                  <>
                    {statement ? "Import" : "Keep"}
                    <span className="sr-only"> {position.name} in {inAccount}</span>
                  </>
                )}
              </Label>
            )}
            {choosing && (
              <RadioGroup
                aria-label={`Keep or remove its ${before} units for ${position.name} in ${inAccount}`}
                disabled={disabled}
                value={keep === undefined ? "" : keep ? "keep" : "remove"}
                onValueChange={(value) => onKeep(position.key, value === "keep")}
                className="grid gap-1"
              >
                <Label className="flex items-center gap-2 text-sm font-normal">
                  <RadioGroupItem value="keep" />
                  Keep its {before} units
                  <span className="sr-only"> for {position.name} in {inAccount}</span>
                </Label>
                <Label className="flex items-center gap-2 text-sm font-normal">
                  <RadioGroupItem value="remove" />
                  Remove its {before} units: all of them came from {labels(position.removable!)}
                  <span className="sr-only"> for {position.name} in {inAccount}</span>
                </Label>
              </RadioGroup>
            )}
          </div>
        );
      })}
    </div>
  );
}
