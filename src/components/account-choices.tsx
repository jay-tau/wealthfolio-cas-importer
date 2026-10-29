import type { Account } from "@wealthfolio/addon-sdk";
import { Card, CardContent, CardHeader, CardTitle, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@wealthfolio/ui";
import type { CasData, CasFolio } from "../cas/types";
import { bankKey, folioKey, NO_BANK, panKey } from "../lib/choices";

/** Remembered or chosen: PAN key or folio key → account ID. A folio without one follows its PAN. */
export type AccountChoices = Record<string, string>;

/** The account a folio's transactions go to, if one is chosen. */
export const accountFor = (choices: AccountChoices, folio: CasFolio) =>
  choices[folioKey(folio)] || (folio.PAN ? choices[panKey(folio.PAN)] : undefined) || undefined;

/** The account a folio's purchases are paid from and its redemptions and payouts paid into, if any. */
export function bankFor(choices: AccountChoices, folio: CasFolio) {
  const id = choices[bankKey(folioKey(folio))] || (folio.PAN ? choices[bankKey(panKey(folio.PAN))] : undefined);
  return id && id !== NO_BANK ? id : undefined;
}

/**
 * A remembered account that can't be chosen now: its name, unless Wealthfolio no longer lists it,
 * and whether it's hidden or archived there. Without either state, it tracks the wrong thing.
 */
export interface Ignored {
  name?: string;
  state?: string;
}

/** Why a remembered account is ignored. `mode` finishes "which …" for one that tracks the wrong thing. */
export function ChooseAgain({ ignored, mode }: { ignored: Ignored | undefined; mode: string }) {
  if (!ignored) return null;
  const account =
    ignored.name === undefined
      ? "an account that's no longer available"
      : `${ignored.name}, which ${ignored.state ? `is ${ignored.state} in Wealthfolio` : mode}`;
  return <p className="text-muted-foreground w-full text-sm">Chosen before: {account}, so choose again.</p>;
}

const SAME_AS_PAN = "same-as-pan";

export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  inherit,
  leaveOut,
  leaveOutLabel = "Leave out",
}: {
  id: string;
  accounts: Account[];
  /** Empty inherits when `inherit` is given; null shows that nothing is chosen yet. */
  value: string | null | undefined;
  onChange: (accountId: string) => void;
  /** Offer "the PAN's account", which is the empty choice. */
  inherit?: string;
  /** Offer leaving it out, with this value. */
  leaveOut?: string;
  leaveOutLabel?: string;
}) {
  const items = [
    ...(inherit ? [{ value: SAME_AS_PAN, label: inherit }] : []),
    ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` })),
    ...(leaveOut ? [{ value: leaveOut, label: leaveOutLabel }] : []),
  ];
  return (
    <Select
      items={items}
      value={value === null ? null : value || (inherit ? SAME_AS_PAN : null)}
      onValueChange={(next) => onChange(next === SAME_AS_PAN || next === null ? "" : next)}
    >
      <SelectTrigger id={id} className="w-72">
        <SelectValue placeholder="Choose an account" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccountChoicesCard({
  data,
  accounts,
  choices,
  ignored,
  onChange,
}: {
  data: CasData;
  /** Accounts that track transactions. */
  accounts: Account[];
  choices: AccountChoices;
  /** Remembered choices that are ignored: key → the account. */
  ignored: Record<string, Ignored>;
  onChange: (key: string, accountId: string) => void;
}) {
  const pans = [...new Set(data.folios.flatMap((f) => (f.PAN ? [f.PAN] : [])))];
  const name = (id: string | undefined) => accounts.find((a) => a.id === id)?.name;
  const chooseAgain = (key: string) => (
    <ChooseAgain
      ignored={ignored[key]}
      mode="tracks holdings. Transactions imported there wouldn't change its holdings"
    />
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <p className="text-muted-foreground text-sm">
          Each PAN's folios go to one Wealthfolio account that tracks transactions. A folio can go to a different one.
          The add-on remembers your choices, keyed by a hash of the PAN or folio number.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {accounts.length === 0 && (
          <p>
            No account tracks transactions. Add one in Wealthfolio, set to track transactions, then close and reopen the
            add-on.
          </p>
        )}
        <div className="grid gap-4">
          {pans.map((pan) => (
            <div key={pan} className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={panKey(pan)}>PAN {pan}</Label>
              <AccountSelect
                id={panKey(pan)}
                accounts={accounts}
                value={choices[panKey(pan)]}
                onChange={(id) => onChange(panKey(pan), id)}
              />
              {chooseAgain(panKey(pan))}
            </div>
          ))}
        </div>
        <div className="grid gap-4">
          {data.folios.map((folio) => {
            const key = folioKey(folio);
            const panAccount = folio.PAN ? name(choices[panKey(folio.PAN)]) : undefined;
            // Shown unchosen when its remembered account is ignored, so even going with the PAN is a new choice.
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={key}>
                  {folio.amc}, folio {folio.folio}
                  {!folio.PAN && " (no PAN printed)"}
                </Label>
                <AccountSelect
                  id={key}
                  accounts={accounts}
                  value={key in ignored ? null : choices[key]}
                  onChange={(id) => onChange(key, id)}
                  inherit={folio.PAN ? `Same as PAN${panAccount ? ` (${panAccount})` : ""}` : undefined}
                />
                {chooseAgain(key)}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

const OUTSIDE = "Outside Wealthfolio";

export function BankChoicesCard({
  data,
  accounts,
  choices,
  ignored,
  onChange,
}: {
  data: CasData;
  /** Accounts that track transactions. */
  accounts: Account[];
  choices: AccountChoices;
  /** Remembered choices that are ignored: key → the account. */
  ignored: Record<string, Ignored>;
  onChange: (key: string, accountId: string) => void;
}) {
  const pans = [...new Set(data.folios.flatMap((f) => (f.PAN ? [f.PAN] : [])))];
  const name = (id: string | undefined) => accounts.find((a) => a.id === id)?.name;
  const notes = (key: string, accountId?: string, bankId?: string) => (
    <>
      <ChooseAgain ignored={ignored[key]} mode="tracks holdings. Transfers imported there wouldn't change its cash" />
      {bankId && bankId === accountId && (
        <p className="text-destructive w-full text-sm">
          This is also the account for the funds, and cash can't move from an account to itself. Choose another account,
          or {OUTSIDE}.
        </p>
      )}
    </>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bank account</CardTitle>
        <p className="text-muted-foreground text-sm">
          If Wealthfolio tracks the bank account a PAN's or folio's purchases are paid from, and its redemptions and
          dividend payouts paid into, choose it to record each as a transfer between that account and the funds'. With{" "}
          {OUTSIDE}, each comes with a deposit or withdrawal in the funds' account instead. Switches and mergers stay
          with the fund house either way.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4">
          {pans.map((pan) => {
            const key = bankKey(panKey(pan));
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={key}>
                  <span className="sr-only">Bank account for </span>PAN {pan}
                </Label>
                <AccountSelect
                  id={key}
                  accounts={accounts}
                  value={key in ignored ? null : choices[key]}
                  onChange={(next) => onChange(key, next)}
                  inherit={OUTSIDE}
                />
                {notes(key)}
              </div>
            );
          })}
        </div>
        <div className="grid gap-4">
          {data.folios.map((folio) => {
            const key = bankKey(folioKey(folio));
            const panBankKey = folio.PAN && bankKey(panKey(folio.PAN));
            // An ignored PAN bank account is unchosen, so neither it nor Outside Wealthfolio is named.
            const panBank = panBankKey && !(panBankKey in ignored) ? (name(choices[panBankKey]) ?? OUTSIDE) : undefined;
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={key}>
                  <span className="sr-only">Bank account for </span>
                  {folio.amc}, folio {folio.folio}
                </Label>
                <AccountSelect
                  id={key}
                  accounts={accounts}
                  value={key in ignored ? null : choices[key]}
                  onChange={(next) => onChange(key, next)}
                  inherit={folio.PAN ? `Same as PAN${panBank ? ` (${panBank})` : ""}` : OUTSIDE}
                  leaveOut={folio.PAN ? NO_BANK : undefined}
                  leaveOutLabel={OUTSIDE}
                />
                {notes(key, accountFor(choices, folio), bankFor(choices, folio))}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
