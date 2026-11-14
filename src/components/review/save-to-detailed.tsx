import type { Account } from "@wealthfolio/addon-sdk";
import { Label } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import type { CasFolio } from "../../cas/types";
import { bankKey, folioKey, LEFT_OUT, NO_BANK } from "../../lib/choices";
import { isProposed } from "../../lib/new-accounts";
import { plural } from "../../lib/plural";
import { AccountSelect, ChooseAgain, type Ignored, newLabel, type Proposed } from "../account-choices";
import { Disclosure } from "./parts";

/** One investor's funds, by PAN, or a folio printed without a PAN, which goes by itself. */
export interface FundsBox {
  /** The PAN's key, or the folio's for a folio without one: its account choice's storage key. */
  key: string;
  /** Who the funds belong to: "A. Investor". */
  name: string;
  /** Its heading: "A. Investor's funds", "Fictiva Mutual Fund folio 123 (no PAN printed)". */
  title: string;
  folios: CasFolio[];
  /** A PAN's box; a folio without a PAN has no folios of its own to send elsewhere. */
  pan: boolean;
}

const NOT_TRANSACTIONS = "tracks holdings. Transactions imported there wouldn't change its holdings";
const NOT_TRANSFERS = "tracks holdings. Transfers imported there wouldn't change its cash";
export const NO_TRANSFERS = "None: don't add bank transfers";
/** What a bank account is for, tied to its select. */
export const BANK_HINT = "Purchases transfer from this account; sales and cash dividends transfer back to it.";

/** "Fictiva Mutual Fund folio 91234567 / 12" */
export const folioName = (folio: CasFolio) => `${folio.amc} folio ${folio.folio}`;

/**
 * Where a detailed statement's transactions go: one box per PAN, named by the investor, with the
 * account for its funds and the bank account for their purchases and payouts, and under Save part of
 * it to another account, each folio's own account and bank account. A folio without a PAN has a box
 * of its own. Each funds' select offers a new account of its own, created when the transactions are
 * imported; bank accounts are existing ones. Each select's id is its choice's storage key. `checks`
 * gives the bank matches shown right under the bank choice that set them.
 */
export function SaveToDetailed({
  boxes,
  targets,
  proposed,
  newLine,
  values,
  ignored,
  conflicts,
  remembered,
  open,
  onOpen,
  onChange,
  checks,
  partId,
}: {
  boxes: FundsBox[];
  /** Accounts transactions can go to today: active, unarchived, tracking transactions. */
  targets: Account[];
  /** The new account each funds' select offers, by key, until it's created. */
  proposed: (key: string) => Proposed | undefined;
  /** What's under a select that shows its new account, by key, with what the account is for. */
  newLine: (key: string, label: string) => ReactNode;
  /** Each key's choice as its select shows it: an account ID, a proposed account's, `LEFT_OUT`, `NO_BANK`, "" for Same as above or None, null for none yet. */
  values: Record<string, string | null>;
  /** Remembered choices that are ignored, by key. */
  ignored: Record<string, Ignored>;
  /** Bank choices that are also the funds' account, by key. */
  conflicts: ReadonlySet<string>;
  /** How many boxes' accounts are the ones chosen last time. */
  remembered: "all" | "some" | "none";
  /** Which boxes' Save part of it to another account is open, by key. */
  open: Record<string, boolean>;
  onOpen: (key: string, open: boolean) => void;
  onChange: (key: string, value: string) => void;
  checks: (bankChoiceKey: string) => ReactNode;
  partId: string;
}) {
  const nameOf = (key: string) => {
    const id = values[key];
    const account = proposed(key);
    if (isProposed(id)) return account && newLabel(account);
    return targets.find((a) => a.id === id)?.name;
  };
  const isNew = (key: string) => isProposed(values[key]) && values[key] === proposed(key)?.id;
  const heading = (
    <h3 id={`${partId}-heading`} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
      Save to
    </h3>
  );
  const why = (key: string, mode: string) => <ChooseAgain ignored={ignored[key]} mode={mode} />;
  const conflict = (key: string) =>
    conflicts.has(key) && (
      <p className="text-destructive w-full text-sm">
        This is also the account for the funds, and cash can't move from an account to itself. Choose another account, or None.
      </p>
    );
  const bankChoice = (key: string, label: ReactNode, select: (hint: string) => ReactNode) => {
    const hint = `${partId}-${key}-hint`;
    return (
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor={key} className="font-normal">
            {label}
          </Label>
          {select(hint)}
        </div>
        {why(key, NOT_TRANSFERS)}
        {conflict(key)}
        <p id={hint} className="text-muted-foreground text-xs">
          {BANK_HINT}
        </p>
        {checks(key)}
      </div>
    );
  };
  return (
    <section aria-labelledby={`${partId}-heading`} className="grid gap-3">
      {heading}
      {boxes.map((box) => {
        const account = values[box.key] === LEFT_OUT ? "Don't import" : nameOf(box.key);
        const bank = values[bankKey(box.key)];
        const bankName = bank === "" || bank === NO_BANK ? "None" : nameOf(bankKey(box.key));
        return (
          <div key={box.key} role="group" aria-labelledby={`${partId}-${box.key}-title`} className="grid gap-3 rounded-lg border p-4">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <Label id={`${partId}-${box.key}-title`} htmlFor={box.key} className="font-semibold">
                  {box.title}
                </Label>
                <AccountSelect
                  id={box.key}
                  accounts={targets}
                  proposed={proposed(box.key)}
                  value={values[box.key]}
                  onChange={(id) => onChange(box.key, id)}
                  leaveOut={LEFT_OUT}
                  leaveOutLabel="Don't import them"
                />
              </div>
              {isNew(box.key) && newLine(box.key, box.title)}
              {why(box.key, NOT_TRANSACTIONS)}
            </div>
            {bankChoice(
              bankKey(box.key),
              <>
                Bank account for purchases and payouts (optional)
                <span className="sr-only">: {box.title}</span>
              </>,
              (hint) => (
                <AccountSelect
                  id={bankKey(box.key)}
                  accounts={targets}
                  value={values[bankKey(box.key)]}
                  onChange={(id) => onChange(bankKey(box.key), id)}
                  inherit={NO_TRANSFERS}
                  describedBy={hint}
                />
              ),
            )}
            {box.pan && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 text-sm">
                <Disclosure
                  label="Save part of it to another account"
                  ariaLabel={`Save part of it to another account: ${box.title}`}
                  open={!!open[box.key]}
                  onOpenChange={(yes) => onOpen(box.key, yes)}
                  id={`${partId}-${box.key}-part`}
                >
                  <div className="mt-2 grid gap-4 rounded-lg border p-4">
                    {box.folios.map((folio) => {
                      const key = folioKey(folio);
                      return (
                        <div key={key} className="grid gap-2">
                          <div className="grid gap-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Label htmlFor={key} className="font-normal">
                                {folioName(folio)}
                                <span className="text-muted-foreground"> · {plural(folio.schemes.length, "fund")}</span>
                              </Label>
                              <AccountSelect
                                id={key}
                                accounts={targets}
                                proposed={proposed(key)}
                                value={values[key]}
                                onChange={(id) => onChange(key, id)}
                                inherit={`Same as above${account ? ` (${account})` : ""}`}
                                leaveOut={LEFT_OUT}
                                leaveOutLabel="Don't import"
                              />
                            </div>
                            {isNew(key) && newLine(key, folioName(folio))}
                            {why(key, NOT_TRANSACTIONS)}
                          </div>
                          {bankChoice(
                            bankKey(key),
                            <>
                              Bank account<span className="sr-only"> for {folioName(folio)}</span>
                            </>,
                            (hint) => (
                              <AccountSelect
                                id={bankKey(key)}
                                accounts={targets}
                                value={values[bankKey(key)]}
                                onChange={(id) => onChange(bankKey(key), id)}
                                inherit={`Same as above${bankName ? ` (${bankName})` : ""}`}
                                leaveOut={NO_BANK}
                                leaveOutLabel={NO_TRANSFERS}
                                leaveOutFirst
                                describedBy={hint}
                              />
                            ),
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Disclosure>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-muted-foreground text-sm">
        {remembered === "all" ? "Chosen last time." : remembered === "some" ? "Chosen last time where there was one." : "Used again for your next statement."}
      </p>
    </section>
  );
}
