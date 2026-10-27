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
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import {
  type AccountPlan,
  type Choices,
  costOf,
  included,
  manualPriceChange,
  type PlannedPosition,
  replacesSnapshot,
  validCost,
} from "../cas/holdings";

export const noChoices = (): Choices => ({ flipped: new Set(), costs: new Map() });

/** Whether every included typed cost is valid and every replaced snapshot is confirmed. */
export const ready = (plans: AccountPlan[], choices: ReadonlyMap<string, Choices>, confirmed: ReadonlySet<string>) =>
  plans.every((plan) => {
    const chosen = choices.get(plan.accountId) ?? noChoices();
    return (!replacesSnapshot(plan) || confirmed.has(plan.accountId)) &&
      !manualPriceChange(plan, chosen) &&
      plan.positions.every((position) => !position.lines.length || !included(position, chosen) ||
        position.cost?.from === "statement" || validCost(chosen.costs.get(position.key) ?? ""));
  });

function status(position: PlannedPosition, yes: boolean) {
  if (!position.lines.length) return yes ? { badge: "Kept", variant: "secondary" as const } : { badge: "Removed", variant: "warning-subtle" as const };
  if (!yes) return { badge: "Left out", variant: "secondary" as const };
  return position.existing ? { badge: "Updated", variant: "success-subtle" as const } : { badge: "New", variant: "success-subtle" as const };
}

function Cost({
  position,
  yes,
  typed,
  disabled,
  onCost,
}: {
  position: PlannedPosition;
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
        aria-label={`Total cost of ${position.name}`}
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
      ) : null}
    </div>
  );
}

function AccountPreview({
  plan,
  account,
  choices,
  confirmed,
  importing,
  onFlip,
  onCost,
  onConfirm,
}: {
  plan: AccountPlan;
  account: string;
  choices: Choices;
  confirmed: boolean;
  importing: boolean;
  onFlip: (key: string) => void;
  onCost: (key: string, text: string) => void;
  onConfirm: (yes: boolean) => void;
}) {
  const { existing } = plan;
  const cash = Object.entries(existing.cash);
  const unknown = plan.positions.some(
    (p) => p.lines.length > 0 && included(p, choices) && !costOf(p, choices.costs.get(p.key)),
  );
  const manual = manualPriceChange(plan, choices);
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
      {manual && (
        <Alert variant="warning">
          <AlertTitle>{manual.name} uses a manual price</AlertTitle>
          <AlertDescription>
            Saving its cost would replace Wealthfolio's manual price with its average cost.{" "}
            {!manual.lines.length
              ? "Untick Keep for this holding before saving."
              : included(manual, choices) && manual.cost?.from !== "statement"
                ? "Clear its total cost before saving."
                : "Change its price mode in Wealthfolio, reconfirm the fund or share, and preview again."}
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
          {plan.positions.map((position) => {
            const yes = included(position, choices);
            const { badge, variant } = status(position, yes);
            const statement = position.lines.length > 0;
            const before = position.existing?.units;
            return (
              <TableRow key={position.key}>
                <TableCell>
                  <div className="grid gap-1">
                    <span>{position.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {statement ? position.lines.map((l) => l.source.label).join("; ") : "Not on the statement"}
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
                    yes={yes}
                    typed={choices.costs.get(position.key)}
                    disabled={importing}
                    onCost={(text) => onCost(position.key, text)}
                  />
                </TableCell>
                <TableCell>
                  <div className="grid gap-1">
                    <Badge variant={variant}>{badge}</Badge>
                    {position.notes.map((note, i) => (
                      <span key={i} className="text-muted-foreground text-xs">
                        {note}
                      </span>
                    ))}
                    <Label className="flex items-center gap-2 text-xs font-normal">
                      <Checkbox disabled={importing} checked={yes} onCheckedChange={() => onFlip(position.key)} />
                      {statement ? "Import" : "Keep"}
                    </Label>
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
  onConfirm: (accountId: string, yes: boolean) => void;
  onImport: () => void;
}) {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
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
            account={name(plan.accountId)}
            choices={choices.get(plan.accountId) ?? noChoices()}
            confirmed={confirmed.has(plan.accountId)}
            importing={importing}
            onFlip={(key) => onFlip(plan.accountId, key)}
            onCost={(key, text) => onCost(plan.accountId, key, text)}
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

export interface SavedSnapshots {
  saved: { accountId: string; date: string; holdings: number }[];
  failed: { accountId: string; error: string }[];
  /** The snapshots saved, but the add-on couldn't remember what each folio or demat account added. */
  unremembered: boolean;
}

export function HoldingsResult({ result, accounts }: { result: SavedSnapshots; accounts: Account[] }) {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {result.saved.length > 0 && (
          <Alert variant="success">
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
          <Alert variant="destructive">
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
        {result.unremembered && (
          <Alert variant="warning">
            <AlertTitle>Some import history could not be saved</AlertTitle>
            <AlertDescription>
              The next preview may not know which holdings these folios or demat accounts added. Check which holdings
              it proposes to keep or remove before saving.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
