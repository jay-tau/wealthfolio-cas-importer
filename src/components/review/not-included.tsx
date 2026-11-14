import { Button } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { units as grouped } from "../../lib/review-format";
import { Disclosure, LinkButton } from "./parts";

/** How an already-tracked fund's units compare with the accounts that track it from transactions. */
export type Comparison =
  | { kind: "checking" }
  | { kind: "match" }
  | { kind: "differ"; theirs: string; ours: string; accounts: { id: string; name: string }[]; accountName: string }
  | { kind: "unknown"; why: string };

/** A fund on the statement that an account tracking transactions already holds. */
export interface TrackedFund {
  key: string;
  name: string;
  /** Its accessible name, numbered when another tracked fund has the same displayed name. */
  label: string;
  /** Its plan and option badges, or anything else after its name. */
  badges?: ReactNode;
  /** The statement's units of its folio lines. */
  units: string;
  comparison: Comparison;
  /** Its folios go to an account, so it can be saved there too. */
  canSave: boolean;
  /** Saved in both accounts by the user's choice. */
  included: boolean;
  /** What the account the folio goes to keeps of it, and why. */
  notes?: string[];
}

/** Already-tracked funds, by the accounts that track them. */
export interface TrackedGroup {
  accounts: string;
  funds: TrackedFund[];
}

export interface LeftOutLine {
  name: string;
  where: string;
  reason: string;
}

/** "A, B and C". */
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function Tracked({
  group,
  open,
  why,
  onOpen,
  onWhy,
  onSaveBoth,
  onReview,
  ids,
}: {
  group: TrackedGroup;
  open: boolean;
  why: boolean;
  onOpen: (open: boolean) => void;
  onWhy: (open: boolean) => void;
  onSaveBoth: (key: string) => void;
  onReview: (accountId: string, accountName: string) => void;
  ids: { show: string; why: string; saveBoth: (key: string) => string };
}) {
  const shownFunds = group.funds.filter((f) => !f.included);
  if (!shownFunds.length) return null;
  const n = shownFunds.length;
  const checking = shownFunds.some((f) => f.comparison.kind === "checking");
  const matches = shownFunds.filter((f) => f.comparison.kind === "match").length;
  return (
    <div className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span>
          <span className="font-semibold">
            Already tracked in {group.accounts} ({n})
          </span>
          : not saved here too, so {n === 1 ? "it isn't" : "they aren't"} counted twice.
        </span>
        <Disclosure id={ids.show} label={n === 1 ? "Show it" : "Show them"} open={open} onOpenChange={onOpen}>
          <ul className="mt-2 grid gap-2">
            {shownFunds.map((fund) => (
              <li key={fund.key} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{fund.name}</span>
                  {fund.badges}
                  <span className="text-muted-foreground"> · {fund.units}</span>
                </span>
                {fund.canSave ? (
                  <Button
                    id={ids.saveBoth(fund.key)}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Save in both accounts: ${fund.label}`}
                    onClick={() => onSaveBoth(fund.key)}
                  >
                    Save in both accounts
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-sm">Choose an account in “Save to” above first.</span>
                )}
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
      <div className="grid grid-cols-1 gap-1 text-sm">
        {checking ? (
          <span className="text-muted-foreground">Comparing the units with {group.accounts}…</span>
        ) : (
          matches > 0 && (
            <span className="text-success">
              ✓ {matches === n ? (n === 1 ? "It matches" : `All ${n} match`) : `${matches} ${matches === 1 ? "matches" : "match"}`} this statement.
            </span>
          )
        )}
        {shownFunds.map((fund) => {
          const c = fund.comparison;
          if (c.kind === "differ") {
            return (
              <span key={fund.key} className="text-warning">
                {fund.name} differs: {c.accountName} has {c.theirs}, this statement {c.ours}. A transaction may be missing from {c.accountName}.{" "}
                {c.accounts.map((account) => (
                  <span key={account.id}>
                    <LinkButton type="button" onClick={() => onReview(account.id, account.name)}>
                      Review its transactions in {account.name}
                    </LinkButton>{" "}
                  </span>
                ))}
              </span>
            );
          }
          if (c.kind === "unknown") {
            return (
              <span key={fund.key} className="text-muted-foreground">
                {fund.name}: couldn't compare. {c.why}
              </span>
            );
          }
          return null;
        })}
        {shownFunds.flatMap((fund) => (fund.notes ?? []).map((note, i) => (
          <span key={`${fund.key}-note-${i}`} className="text-muted-foreground">
            {fund.name}: {note}
          </span>
        )))}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <Disclosure id={ids.why} label="Why?" ariaLabel={`Why? Already tracked in ${group.accounts}`} open={why} onOpenChange={onWhy}>
          <p className="text-muted-foreground mt-1">
            {group.accounts} already {group.accounts.includes(", ") ? "count" : "counts"} these funds from their transactions. Saving the same
            units in another Wealthfolio account would count them twice.
          </p>
        </Disclosure>
      </div>
    </div>
  );
}

/** A statement row left out so that units aren't counted twice, with why and its Change. */
export interface LeftOutRow {
  key: string;
  name: string;
  notes: string[];
  /** Its Change links, */
  change: ReactNode;
  /** and the Change panel while it's open. */
  panel?: ReactNode;
}

/**
 * What this save leaves out, each with why: funds an account that tracks transactions already holds
 * (compared with it), holdings skipped by an answer, holdings of folios, demat accounts and PRANs set
 * to Don't save, statement rows left out so that units aren't counted twice, and lines that may be
 * misread or have no units.
 */
export function NotIncluded({
  tracked,
  counted,
  skipped,
  unsaved,
  defaulted,
  lines,
  open,
  setOpen,
  onSaveBoth,
  onDontSave,
  onReview,
  partId,
}: {
  tracked: TrackedGroup[];
  /** Already-tracked funds the user saves in both accounts. */
  counted: Pick<TrackedFund, "key" | "name" | "label">[];
  skipped: string[];
  unsaved: string[];
  defaulted: LeftOutRow[];
  lines: LeftOutLine[];
  open: Record<string, boolean>;
  setOpen: (id: string, open: boolean) => void;
  onSaveBoth: (key: string) => void;
  onDontSave: (key: string) => void;
  onReview: (accountId: string, accountName: string) => void;
  partId: string;
}) {
  const anyTracked = tracked.some((g) => g.funds.some((f) => !f.included));
  if (!anyTracked && !counted.length && !skipped.length && !unsaved.length && !defaulted.length && !lines.length) return null;
  return (
    <section aria-labelledby={`${partId}-heading`} className="grid gap-3">
      <h3 id={`${partId}-heading`} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
        Not included in this save
      </h3>
      {tracked.map((group, g) => (
        <Tracked
          key={group.accounts}
          group={group}
          open={!!open[`show:${group.accounts}`]}
          why={!!open[`why:${group.accounts}`]}
          onOpen={(yes) => setOpen(`show:${group.accounts}`, yes)}
          onWhy={(yes) => setOpen(`why:${group.accounts}`, yes)}
          onSaveBoth={onSaveBoth}
          onReview={onReview}
          ids={{
            show: `${partId}-show-${g}`,
            why: `${partId}-why-${g}`,
            saveBoth: (key) => `${partId}-both-${key}`,
          }}
        />
      ))}
      {counted.length > 0 && (
        <p className="text-warning text-sm">
          Counted in both accounts:{" "}
          {counted.map((fund, i) => (
            <span key={fund.key}>
              {i > 0 && ", "}
              {fund.name}{" "}
              <LinkButton id={`${partId}-dont-${fund.key}`} type="button" aria-label={`Don't save it here: ${fund.label}`} onClick={() => onDontSave(fund.key)}>
                Don't save it here
              </LinkButton>
            </span>
          ))}
        </p>
      )}
      {skipped.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Skipped ({skipped.length})</span>: {list(skipped)}, by your answer.
        </p>
      )}
      {unsaved.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Not saved ({unsaved.length})</span>: {list(unsaved)}. Their account in “Save to” is set to Don't save.
        </p>
      )}
      {defaulted.length > 0 && (
        <div className="grid gap-2 text-sm">
          <p className="font-semibold">Left out, so units aren't counted twice ({defaulted.length})</p>
          <ul className="grid gap-2">
            {defaulted.map((row) => (
              <li key={row.key} className="grid grid-cols-1 gap-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 font-medium">{row.name}</span>
                  {row.change}
                </span>
                {row.notes.map((note, i) => (
                  <span key={i} className="text-muted-foreground">
                    {note}
                  </span>
                ))}
                {row.panel}
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {lines.map((line, i) => (
            <li key={i}>
              <span className="font-medium">{line.name}</span>, {line.where}: {line.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const unitsText = (value: string) => `${grouped(value)} units`;
