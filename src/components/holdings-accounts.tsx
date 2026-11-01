import type { Account } from "@wealthfolio/addon-sdk";
import { Card, CardContent, CardHeader, CardTitle, Label } from "@wealthfolio/ui";
import type { Holdings, Source } from "../cas/holdings";
import { investorKey, LEFT_OUT, sourceKey } from "../lib/choices";
import { AccountSelect, ChooseAgain, type Ignored } from "./account-choices";

/** Remembered or chosen: investor key or source key → account ID, or `LEFT_OUT` for a source. */
export type HoldingsAccountChoices = Record<string, string>;

/** The account a folio, demat account or PRAN goes to; undefined leaves it out. */
export function accountForSource(choices: HoldingsAccountChoices, holdings: Holdings, source: Source) {
  const own = choices[sourceKey(source)];
  if (own === LEFT_OUT) return undefined;
  return own || choices[investorKey(holdings.investor)] || undefined;
}

export function HoldingsAccountsCard({
  holdings,
  accounts,
  choices,
  ignored,
  onChange,
}: {
  holdings: Holdings;
  /** Accounts that track holdings. */
  accounts: Account[];
  choices: HoldingsAccountChoices;
  /** Remembered choices that are ignored: key → the account. */
  ignored: Record<string, Ignored>;
  onChange: (key: string, value: string) => void;
}) {
  const statementKey = investorKey(holdings.investor);
  const statementAccount = accounts.find((a) => a.id === choices[statementKey])?.name;
  const chooseAgain = (key: string) => (
    <ChooseAgain
      ignored={ignored[key]}
      mode="doesn't track holdings. A snapshot saved there wouldn't change its holdings"
    />
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <p className="text-muted-foreground text-sm">
          This statement's holdings go to Wealthfolio accounts that track holdings, as a snapshot of each account on the
          statement's date. Each folio, demat account or NPS account (PRAN) goes to one account, or is left out. The
          add-on remembers your choices, keyed by hashes of the PAN, email or name, and of the folio with its fund issuer,
          the demat account or the PRAN.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {accounts.length === 0 ? (
          <>
            <p>
              No account tracks holdings. To save snapshots, add one in Wealthfolio, set to track holdings, then choose
              Read statement again. The check against transactions below works without one.
            </p>
            {/* Still say why the accounts chosen before are ignored. */}
            {[[statementKey, "All of this statement"], ...holdings.sources.map((s) => [sourceKey(s), s.label])].map(
              ([key, label]) =>
                key in ignored && (
                  <div key={key}>
                    <p>{label}</p>
                    {chooseAgain(key)}
                  </div>
                ),
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={statementKey}>All of this statement</Label>
              <AccountSelect
                id={statementKey}
                accounts={accounts}
                value={choices[statementKey]}
                onChange={(id) => onChange(statementKey, id)}
              />
              {chooseAgain(statementKey)}
            </div>
            <div className="grid gap-4">
              {holdings.sources.map((source) => {
                const key = sourceKey(source);
                // Shown unchosen when its remembered account is ignored, so even going with the statement is a new choice.
                return (
                  <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={key}>
                      {source.label}
                      <span className="text-muted-foreground">
                        {" "}
                        · {source.holdings.length} {source.holdings.length === 1 ? "holding" : "holdings"}
                      </span>
                    </Label>
                    <AccountSelect
                      id={key}
                      accounts={accounts}
                      value={key in ignored ? null : choices[key]}
                      onChange={(id) => onChange(key, id)}
                      inherit={`Same as the statement${statementAccount ? ` (${statementAccount})` : ""}`}
                      leaveOut={LEFT_OUT}
                    />
                    {chooseAgain(key)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
