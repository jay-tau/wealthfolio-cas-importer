import type { Account } from "@wealthfolio/addon-sdk";
import { Card, CardContent, CardHeader, CardTitle, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@wealthfolio/ui";
import type { CasData, CasFolio } from "../cas/types";
import { folioKey, panKey } from "../lib/choices";

/** Remembered or chosen: PAN key or folio key → account ID. A folio without one follows its PAN. */
export type AccountChoices = Record<string, string>;

/** The account a folio's transactions go to, if one is chosen. */
export const accountFor = (choices: AccountChoices, folio: CasFolio) =>
  choices[folioKey(folio)] || (folio.PAN ? choices[panKey(folio.PAN)] : undefined) || undefined;

const SAME_AS_PAN = "same-as-pan";

function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  inherit,
}: {
  id: string;
  accounts: Account[];
  value: string | undefined;
  onChange: (accountId: string) => void;
  /** Offer "the PAN's account", which is the empty choice. */
  inherit?: string;
}) {
  const items = [
    ...(inherit ? [{ value: SAME_AS_PAN, label: inherit }] : []),
    ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` })),
  ];
  return (
    <Select
      items={items}
      value={value || (inherit ? SAME_AS_PAN : null)}
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
  onChange,
}: {
  data: CasData;
  accounts: Account[];
  choices: AccountChoices;
  onChange: (key: string, accountId: string) => void;
}) {
  const pans = [...new Set(data.folios.flatMap((f) => (f.PAN ? [f.PAN] : [])))];
  const name = (id: string | undefined) => accounts.find((a) => a.id === id)?.name;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <p className="text-muted-foreground text-sm">
          Each PAN's folios go to one Wealthfolio account. A folio can go to a different one. The add-on remembers your
          choices, keyed by a hash of the PAN or folio number.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {accounts.length === 0 && <p>Add an account in Wealthfolio first.</p>}
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
            </div>
          ))}
        </div>
        <div className="grid gap-4">
          {data.folios.map((folio) => {
            const key = folioKey(folio);
            const panAccount = folio.PAN ? name(choices[panKey(folio.PAN)]) : undefined;
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={key}>
                  {folio.amc}, folio {folio.folio}
                  {!folio.PAN && " (no PAN printed)"}
                </Label>
                <AccountSelect
                  id={key}
                  accounts={accounts}
                  value={choices[key]}
                  onChange={(id) => onChange(key, id)}
                  inherit={folio.PAN ? `Same as PAN${panAccount ? ` (${panAccount})` : ""}` : undefined}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
