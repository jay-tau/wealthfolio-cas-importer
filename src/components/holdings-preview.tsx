import type { Account } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
import { focusDropped } from "../lib/focus";
import { WrapButton } from "./review/parts";

/** A proposed account Wealthfolio didn't create, so nothing that needed it was saved. */
export interface NotCreated {
  /** Its proposed ID. */
  accountId: string;
  name: string;
  error: string;
}

/**
 * The accounts a save couldn't create, each with what wasn't saved for it: "nothing", or its
 * transactions' count.
 */
export function NotCreatedAlert({ accounts, what }: { accounts: NotCreated[]; what: (account: NotCreated) => string }) {
  if (!accounts.length) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>
        Wealthfolio didn't create {accounts.length === 1 ? `the account ${accounts[0].name}` : `${accounts.length} accounts`}
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc ps-4">
          {accounts.map((a) => (
            <li key={a.accountId}>
              {a.name}: {a.error.replace(/\.$/, "")}. {what(a)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
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
  /**
   * The snapshots saved, but the add-on couldn't remember what each folio, demat account or PRAN
   * added, or the ID of an asset the save created or found.
   */
  unremembered: boolean;
  unfinished: Unfinished[];
}

export function HoldingsResult({
  result,
  accounts,
  notCreated = [],
  retry,
}: {
  result: SavedSnapshots;
  accounts: Account[];
  /** Accounts the save couldn't create, so nothing was saved in them. */
  notCreated?: NotCreated[];
  /** Saves again what's left: in accounts still to create, or created ones whose snapshot failed. */
  retry?: () => void;
}) {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  // Shown in place of the preview and its Save button, which had the focus: the first message takes
  // it, or the title if the import stopped before saving or failing any snapshot, unless the user
  // moved it while the snapshots were saved.
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusDropped()) first.current?.focus();
  }, []);
  const lead = result.saved.length ? "saved" : result.failed.length || notCreated.length ? "failed" : "title";
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
        {notCreated.length > 0 && (
          <div {...(result.failed.length ? {} : takesFocus("failed"))}>
            <NotCreatedAlert accounts={notCreated} what={() => "Nothing was saved for it."} />
          </div>
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
        {retry && (
          <WrapButton type="button" variant="outline" onClick={retry}>
            Try again
          </WrapButton>
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
