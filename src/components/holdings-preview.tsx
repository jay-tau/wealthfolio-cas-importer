import type { Account } from "@wealthfolio/addon-sdk";
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
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
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
  validCost,
} from "../cas/holdings";
import { nameNumber } from "../lib/name-number";
import { otherCurrency } from "./fund-choices";

export const noChoices = (): Choices => ({ flipped: new Set(), costs: new Map() });

/**
 * Whether every included typed cost is valid, every replaced snapshot is confirmed, and the user chose
 * to keep or remove each holding's units that would otherwise count twice.
 */
export const ready = (plans: AccountPlan[], choices: ReadonlyMap<string, Choices>, confirmed: ReadonlySet<string>) =>
  plans.every((plan) => {
    const chosen = choices.get(plan.accountId) ?? noChoices();
    return (!replacesSnapshot(plan) || confirmed.has(plan.accountId)) &&
      plan.positions.every((position) => !undecided(position, chosen) && (!position.lines.length || !included(position, chosen) ||
        position.cost?.from === "statement" || validCost(chosen.costs.get(position.key) ?? "")));
  });

function status(position: PlannedPosition, yes: boolean, keep: boolean | undefined) {
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

function Cost({
  position,
  account,
  yes,
  typed,
  disabled,
  onCost,
}: {
  position: PlannedPosition;
  account: string;
  yes: boolean;
  typed: string | undefined;
  disabled: boolean;
  onCost: (text: string) => void;
}) {
  if (!position.lines.length || !yes) return <>{position.existing?.cost ?? (position.existing ? "Unknown" : "")}</>;
  if (position.cost?.from === "statement") {
    return (
      <div className="grid gap-1">
        <span className="tabular-nums">{position.cost.total}</span>
        <span className="text-muted-foreground text-xs">Printed on the statement</span>
      </div>
    );
  }
  const text = typed ?? position.cost?.total ?? "";
  return (
    <div className="grid gap-1">
      <Input
        aria-label={`Total cost of ${position.name} in ${account}`}
        className="w-36 text-end tabular-nums"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        placeholder="Unknown"
        onChange={(event) => onCost(event.target.value)}
      />
      {!validCost(text) ? (
        <span className="text-destructive text-xs">Type an amount like 12345.67, or leave it blank.</span>
      ) : typed === undefined && position.cost?.from === "wealthfolio" ? (
        <span className="text-muted-foreground text-xs">From the account's average cost in Wealthfolio</span>
      ) : typed === undefined && position.cost?.from === "face" ? (
        <span className="text-muted-foreground text-xs">From the face value</span>
      ) : null}
    </div>
  );
}

function AccountPreview({
  plan,
  account,
  label,
  choices,
  confirmed,
  importing,
  onFlip,
  onCost,
  onKeep,
  onConfirm,
}: {
  plan: AccountPlan;
  account: string;
  label: string;
  choices: Choices;
  confirmed: boolean;
  importing: boolean;
  onFlip: (key: string) => void;
  onCost: (key: string, text: string) => void;
  onKeep: (key: string, keep: boolean) => void;
  onConfirm: (yes: boolean) => void;
}) {
  const { existing } = plan;
  const cash = Object.entries(existing.cash);
  const unknown = plan.positions.some(
    (p) => p.lines.length > 0 && included(p, choices) && !costOf(p, choices.costs.get(p.key)),
  );
  return (
    <section className="space-y-4">
      <h3 className="font-medium">
        {account}: snapshot of {plan.date}
      </h3>
      {replacesSnapshot(plan) ? (
        <Alert variant="warning">
          <AlertTitle>Wealthfolio has a snapshot of this account on {plan.date}</AlertTitle>
          <AlertDescription>
            Importing replaces it with the one below.
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox disabled={importing} checked={confirmed} onCheckedChange={(yes) => onConfirm(yes)} />
              Replace the snapshot of {plan.date}
              <span className="sr-only"> in {label}</span>
            </Label>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground text-sm">
          {existing.date
            ? `Starts from the account's snapshot of ${existing.date}: holdings the statement doesn't list carry over unless you remove them.`
            : "The account has no snapshot before this date, so this one starts empty."}
        </p>
      )}
      {existing.later.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Wealthfolio has later snapshots of this account</AlertTitle>
          <AlertDescription>
            Its current holdings come from the snapshot of {existing.later[existing.later.length - 1]}, so this import only
            changes its history before {existing.later[0]}.
          </AlertDescription>
        </Alert>
      )}
      <Table>
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
          {plan.positions.map((position, i) => {
            const inAccount = `${label}${nameNumber(plan.positions, i, "holding")}`;
            const yes = included(position, choices);
            const keep = choices.keep?.get(position.key);
            const { badge, variant } = status(position, yes, keep);
            const statement = position.lines.length > 0;
            // Removable units are chosen for once the statement's lines, if any, are left out.
            const choosing = !!position.removable && (!statement || !yes);
            const before = position.existing?.units;
            const listedIn = [...new Set([...position.lines, ...(position.misread ?? [])].map((l) => l.source.label))];
            const replaces = plan.positions.filter((p) => position.replaces?.includes(p.key));
            // A misread line holds back the statement's lines, so its asset gets nothing from them.
            const currency = statement && !position.misread && position.asset ? otherCurrency(position.asset.quoteCcy, position.asset.symbol) : undefined;
            return (
              <TableRow key={position.key}>
                <TableCell>
                  <div className="grid gap-1">
                    <span>{position.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {listedIn.length ? listedIn.join("; ") : "Not on the statement"}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-end tabular-nums whitespace-nowrap">
                  {statement && yes ? (before !== undefined ? `${before} → ${position.units}` : position.units) : (before ?? "")}
                </TableCell>
                <TableCell className="text-end tabular-nums">{statement ? position.value : ""}</TableCell>
                <TableCell className="text-end">
                  <Cost
                    position={position}
                    account={inAccount}
                    yes={yes}
                    typed={choices.costs.get(position.key)}
                    disabled={importing}
                    onCost={(text) => onCost(position.key, text)}
                  />
                </TableCell>
                <TableCell>
                  <div className="grid gap-1">
                    {/* The badge hides its overflow, so without a minimum width Chromium sizes the column without it. */}
                    <Badge className="min-w-fit" variant={variant}>
                      {badge}
                    </Badge>
                    {[...position.notes, ...(currency ? [currency] : [])].map((note, i) => (
                      <span key={i} className="text-muted-foreground text-xs">
                        {note}
                      </span>
                    ))}
                    {/*
                      A misread line holds it back: the import leaves the account's position as it is. One that
                      a statement position replaces goes with that position's choice. A removable one without
                      statement lines has only the choice to keep or remove its units.
                    */}
                    {!position.misread && !position.replacedBy && (statement || !position.removable) && (
                      <Label className="flex items-center gap-2 text-xs font-normal">
                        <Checkbox disabled={importing} checked={yes} onCheckedChange={() => onFlip(position.key)} />
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
                        disabled={importing}
                        value={keep === undefined ? "" : keep ? "keep" : "remove"}
                        onValueChange={(value) => onKeep(position.key, value === "keep")}
                        className="grid gap-1"
                      >
                        <Label className="flex items-center gap-2 text-xs font-normal">
                          <RadioGroupItem value="keep" />
                          Keep its {before} units
                          <span className="sr-only"> for {position.name} in {inAccount}</span>
                        </Label>
                        <Label className="flex items-center gap-2 text-xs font-normal">
                          <RadioGroupItem value="remove" />
                          Remove its {before} units: all of them came from {labels(position.removable!)}
                          <span className="sr-only"> for {position.name} in {inAccount}</span>
                        </Label>
                      </RadioGroup>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {unknown && (
        <p className="text-sm">
          A blank total cost is unknown. Wealthfolio stores it as zero, so it counts the holding's whole value as gain
          until the cost is filled in, here or in Wealthfolio.
        </p>
      )}
      <p className="text-muted-foreground text-sm">
        {cash.length
          ? `Cash carried over from the snapshot of ${existing.date}: ${cash.map(([ccy, amount]) => `${ccy} ${amount}`).join(", ")}.`
          : "No cash."}
      </p>
    </section>
  );
}

export function HoldingsPreview({
  plans,
  accounts,
  choices,
  confirmed,
  importing,
  onFlip,
  onCost,
  onKeep,
  onConfirm,
  onImport,
}: {
  plans: AccountPlan[];
  accounts: Account[];
  choices: ReadonlyMap<string, Choices>;
  confirmed: ReadonlySet<string>;
  importing: boolean;
  onFlip: (accountId: string, key: string) => void;
  onCost: (accountId: string, key: string, text: string) => void;
  onKeep: (accountId: string, key: string, keep: boolean) => void;
  onConfirm: (accountId: string, yes: boolean) => void;
  onImport: () => void;
}) {
  const name = (id: string) => {
    const i = accounts.findIndex((a) => a.id === id);
    return i < 0 ? id : `${accounts[i].name.trim()}${nameNumber(accounts, i, "account")}`;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <p className="text-muted-foreground text-sm">
          A snapshot is an account's holdings and cash on a date. Wealthfolio values the account from it until the next
          one, and counts units added or removed since the previous snapshot as money put in or taken out.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {plans.map((plan) => (
          <AccountPreview
            key={plan.accountId}
            plan={plan}
            account={accounts.find((a) => a.id === plan.accountId)?.name ?? plan.accountId}
            label={name(plan.accountId)}
            choices={choices.get(plan.accountId) ?? noChoices()}
            confirmed={confirmed.has(plan.accountId)}
            importing={importing}
            onFlip={(key) => onFlip(plan.accountId, key)}
            onCost={(key, text) => onCost(plan.accountId, key, text)}
            onKeep={(key, keep) => onKeep(plan.accountId, key, keep)}
            onConfirm={(yes) => onConfirm(plan.accountId, yes)}
          />
        ))}
        <Button type="button" disabled={importing || plans.length === 0 || !ready(plans, choices, confirmed)} onClick={onImport}>
          {importing && <Spinner />}
          {importing ? "Saving…" : `Save ${plans.length} ${plans.length === 1 ? "snapshot" : "snapshots"}`}
        </Button>
      </CardContent>
    </Card>
  );
}

/** A saved snapshot's holding whose price or printed details didn't reach Wealthfolio. */
export interface Unfinished {
  accountId: string;
  name: string;
  what: "price" | "details";
  date: string;
}

export interface SavedSnapshots {
  saved: { accountId: string; date: string; holdings: number }[];
  failed: { accountId: string; error: string }[];
  /** The snapshots saved, but the add-on couldn't remember what each folio, demat account or PRAN added. */
  unremembered: boolean;
  unfinished: Unfinished[];
}

export function HoldingsResult({ result, accounts }: { result: SavedSnapshots; accounts: Account[] }) {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  // Shown in place of the preview and its Save button, which had the focus: the first message takes
  // it, or the title if the import stopped before saving or failing any snapshot.
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => first.current?.focus(), []);
  const lead = result.saved.length ? "saved" : result.failed.length ? "failed" : "title";
  const takesFocus = (part: typeof lead) => (part === lead ? { ref: first, tabIndex: -1 } : {});
  return (
    <Card>
      <CardHeader>
        <CardTitle {...takesFocus("title")}>Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {result.saved.length > 0 && (
          <Alert {...takesFocus("saved")} variant="success">
            <AlertTitle>
              Saved {result.saved.length} {result.saved.length === 1 ? "snapshot" : "snapshots"}
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc ps-4">
                {result.saved.map((s) => (
                  <li key={s.accountId}>
                    {name(s.accountId)}, {s.date}: {s.holdings} {s.holdings === 1 ? "holding" : "holdings"}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {result.failed.length > 0 && (
          <Alert {...takesFocus("failed")} variant="destructive">
            <AlertTitle>Wealthfolio didn't save these snapshots</AlertTitle>
            <AlertDescription>
              <ul className="list-disc ps-4">
                {result.failed.map((f) => (
                  <li key={f.accountId}>
                    {name(f.accountId)}: {f.error}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {result.unfinished.length > 0 && (
          <Alert variant="warning">
            <AlertTitle>Some prices or details weren't saved</AlertTitle>
            <AlertDescription>
              <ul className="list-disc ps-4">
                {result.unfinished.map((u, i) => (
                  <li key={i}>
                    {name(u.accountId)}, {u.name}:{" "}
                    {u.what === "price"
                      ? `Wealthfolio may value it at its average cost on ${u.date}. Enter its price for ${u.date} on its asset page.`
                      : "the statement's details (its name and identifiers, a bond's coupon, maturity and face value, or an NPS scheme's fund manager and tier) aren't on its asset. Importing the statement again retries."}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {result.unremembered && (
          <Alert variant="warning">
            <AlertTitle>Some import history could not be saved</AlertTitle>
            <AlertDescription>
              The next preview may not know which holdings these folios, demat accounts or PRANs added. Check which holdings
              it proposes to keep or remove before saving.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
