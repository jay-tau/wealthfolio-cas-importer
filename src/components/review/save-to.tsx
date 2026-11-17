import type { Account } from "@wealthfolio/addon-sdk";
import { Label } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import type { Source } from "../../cas/holdings";
import { LEFT_OUT, sourceKey } from "../../lib/choices";
import type { AccountLabel } from "../../lib/account-labels";
import { isProposed } from "../../lib/new-accounts";
import { plural } from "../../lib/plural";
import { AccountSelect, ChooseAgain, type Ignored, newLabel, NumberedNote, numbers, type Proposed } from "../account-choices";
import { Disclosure } from "./parts";

const NOT_HOLDINGS = "doesn't track holdings. A snapshot saved there wouldn't change its holdings";

/**
 * Where the statement's holdings are saved: one account for all of them, and under Save part of it
 * to another account, one for each folio, demat account and NPS account, or none. Each select offers
 * a new account of its own, created when the holdings are saved. Each select's id is its choice's
 * storage key.
 */
export function SaveTo({
  investorName,
  investorKey,
  sources,
  targets,
  labels,
  proposed,
  newLine,
  values,
  ignored,
  named,
  remembered,
  open,
  onOpen,
  onChange,
  partId,
}: {
  investorName: string;
  investorKey: string;
  sources: Source[];
  /** Accounts a snapshot can be saved in today: active, unarchived, tracking holdings. */
  targets: Account[];
  /** How the screen names each account: an account another one shares its name with is told apart. */
  labels: ReadonlyMap<string, AccountLabel>;
  /** The new account each key's select offers, until it's created. */
  proposed: (key: string) => Proposed | undefined;
  /** What's under a select that shows its new account, by key, with what the account is for. */
  newLine: (key: string, label: string) => ReactNode;
  /** Each key's choice as the select shows it: an account ID, a proposed account's, `LEFT_OUT`, "" for Same as above, null for none yet. */
  values: Record<string, string | null>;
  /** Remembered choices that are ignored, by key. */
  ignored: Record<string, Ignored>;
  /** Accounts the screen names outside Save to, by ID, whose numbers its note explains too. */
  named: readonly string[];
  /** The statement's account is the one chosen last time, unchanged. */
  remembered: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (key: string, value: string) => void;
  partId: string;
}) {
  const investorValue = values[investorKey];
  const investorProposal = proposed(investorKey);
  const statementAccount = isProposed(investorValue)
    ? investorProposal && newLabel(investorProposal)
    : targets.some((a) => a.id === investorValue) ? labels.get(investorValue!)?.text : undefined;
  const why = (key: string) => <ChooseAgain ignored={ignored[key]} mode={NOT_HOLDINGS} />;
  const isNew = (key: string) => isProposed(values[key]) && values[key] === proposed(key)?.id;
  // What numbers the accounts the screen names, read with each select when the lists number one.
  const noteId = `${partId}-numbered`;
  const describedBy = numbers(targets, labels) ? noteId : undefined;
  return (
    <section aria-labelledby={`${partId}-heading`} className="grid gap-3">
      <h3 id={`${partId}-heading`} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
        Save to
      </h3>
      <NumberedNote id={noteId} accounts={targets} named={[...Object.values(ignored).flatMap((i) => i.ids ?? []), ...named]} labels={labels} />
      <div className="grid gap-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor={investorKey} className="font-semibold">
            {investorName}'s holdings
          </Label>
          <AccountSelect
            id={investorKey}
            accounts={targets}
            labels={labels}
            describedBy={describedBy}
            proposed={proposed(investorKey)}
            value={values[investorKey]}
            onChange={(id) => onChange(investorKey, id)}
            leaveOut={LEFT_OUT}
            leaveOutLabel="Don't save them"
          />
        </div>
        {isNew(investorKey) && newLine(investorKey, `${investorName}'s holdings`)}
        {why(investorKey)}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 text-sm">
        <span className="text-muted-foreground">{remembered ? "Chosen last time." : "Used again for your next statement."}</span>
        <Disclosure alone label="Save part of it to another account" open={open} onOpenChange={onOpen} id={`${partId}-part`}>
          <div className="mt-2 grid gap-4 rounded-lg border p-4">
            {sources.map((source) => {
              const key = sourceKey(source);
              const count = source.holdings.length + (source.misread?.length ?? 0);
              return (
                <div key={key} className="grid gap-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={key} className="font-normal">
                      {source.title ?? source.label}
                      <span className="text-muted-foreground"> · {plural(count, "holding")}</span>
                    </Label>
                    <AccountSelect
                      id={key}
                      accounts={targets}
                      labels={labels}
                      describedBy={describedBy}
                      proposed={proposed(key)}
                      value={values[key]}
                      onChange={(id) => onChange(key, id)}
                      inherit={`Same as above${statementAccount ? ` (${statementAccount})` : ""}`}
                      leaveOut={LEFT_OUT}
                      leaveOutLabel="Don't save"
                    />
                  </div>
                  {isNew(key) && newLine(key, source.title ?? source.label)}
                  {why(key)}
                </div>
              );
            })}
          </div>
        </Disclosure>
      </div>
    </section>
  );
}
