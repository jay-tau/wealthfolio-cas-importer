import { Alert, AlertDescription, AlertTitle, Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
import { focusDropped } from "../lib/focus";
import { plural } from "../lib/plural";
import { shortDate } from "../lib/review-format";
import { WrapButton } from "./review/parts";

/** A proposed account Wealthfolio didn't create, so nothing that needed it was saved. */
export interface NotCreated {
  /** Its proposed ID. */
  accountId: string;
  name: string;
  /** Wealthfolio's error, for the log. */
  error: string;
}

/** "A", "A and B", "A, B and C". */
export const names = (all: string[]) => (all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`);

/**
 * The accounts a save couldn't create when nothing else was saved, so the review stays: what wasn't
 * saved or imported. Try again goes with it.
 */
export function NotCreatedAlert({ accounts, nothing }: { accounts: NotCreated[]; nothing: "saved" | "imported" }) {
  if (!accounts.length) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {names(accounts.map((a) => a.name))} couldn't be created, so nothing was {nothing}.
      </AlertTitle>
      <AlertDescription>The review is as you left it. Try again to create {accounts.length === 1 ? "it" : "them"} and go on.</AlertDescription>
    </Alert>
  );
}

/** A saved snapshot's holding whose price or printed details didn't reach Wealthfolio, and what writes it again. */
export interface Unfinished {
  accountId: string;
  name: string;
  what: "price" | "details";
  date: string;
  /** Writes it again; rejects if that fails too. */
  retry: () => Promise<void>;
  /** Written by a retry. */
  done?: boolean;
}

/** What a save did in one account. */
export interface AccountOutcome {
  /** The plan's account in the review: a new account's proposed ID. */
  key: string;
  /** Its Wealthfolio account, once there is one. */
  accountId?: string;
  name: string;
  /** Created by this review. */
  isNew: boolean;
  date: string;
  holdings: number;
  state: "saved" | "not-created" | "failed";
}

/** An account whose snapshot was saved and whose import history wasn't, and what saves it again. */
export interface HistoryFailure {
  accountId: string;
  name: string;
  /** Saves it again; rejects if that fails too. */
  retry: () => Promise<void>;
  done?: boolean;
}

export interface SavedSnapshots {
  /** Each account's outcome, in the review's order. */
  accounts: AccountOutcome[];
  unfinished: Unfinished[];
  history: HistoryFailure[];
}

/** Ids of the result's lines, for the focus after a retry. */
export const resultIds = (base: string) => ({
  title: `${base}-title`,
  account: (key: string) => `${base}-account-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  unfinished: (u: Unfinished) => `${base}-unfinished-${`${u.accountId}-${u.what}-${u.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  history: `${base}-history`,
});

/** What a save did in an account, in a sentence. */
export const accountWords = (a: AccountOutcome) => {
  const when = shortDate(a.date);
  if (a.state === "saved") {
    return a.isNew
      ? `Created ${a.name} and saved ${plural(a.holdings, "holding")} on ${when}.`
      : `Saved ${plural(a.holdings, "holding")} in ${a.name} on ${when}.`;
  }
  if (a.state === "not-created") {
    return `${a.name} couldn't be created, so its ${plural(a.holdings, "holding")} on ${when} ${a.holdings === 1 ? "wasn't" : "weren't"} saved.`;
  }
  return `${a.name}'s ${plural(a.holdings, "holding")} on ${when} ${a.holdings === 1 ? "wasn't" : "weren't"} saved.`;
};

/** A price or set of details a save left, or wrote on a retry, in a sentence. */
export const unfinishedWords = (u: Unfinished) => {
  const when = shortDate(u.date);
  if (u.what === "price") return u.done ? `The price of ${u.name} on ${when} was saved.` : `The price of ${u.name} on ${when} wasn't saved.`;
  return u.done ? `The statement's details for ${u.name} were saved.` : `The statement's details for ${u.name} weren't saved.`;
};

/** ✓ or ✗ before a line: the words say it too, so it isn't read out. */
export const Mark = ({ ok }: { ok: boolean }) => (
  <span aria-hidden="true" className={ok ? "text-success" : "text-destructive"}>
    {ok ? "✓" : "✗"}
  </span>
);

/**
 * What a save did, account by account, until Phase 3's Done screen: each account saved or not, with
 * Try again for each one that wasn't; each price and set of details that didn't reach Wealthfolio,
 * retried on its own; and the import history, if it couldn't be saved.
 */
export function HoldingsResult({
  result,
  base,
  onRetryAccount,
  onRetryUnfinished,
  onRetryHistory,
}: {
  result: SavedSnapshots;
  /** Prefix of the ids of its lines (`resultIds`). */
  base: string;
  /** Saves again what one account didn't get: creates it if it wasn't, then saves its snapshot. */
  onRetryAccount: (key: string) => void;
  onRetryUnfinished: (unfinished: Unfinished) => void;
  onRetryHistory: () => void;
}) {
  const ids = resultIds(base);
  // Shown in place of the review and its Save button, which had the focus: the title takes it,
  // unless the user moved it while the snapshots were saved.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusDropped()) title.current?.focus();
  }, []);
  const saved = result.accounts.filter((a) => a.state === "saved");
  const heading = saved.length === result.accounts.length
    ? "Holdings saved"
    : saved.length
      ? `Holdings saved in ${saved.length} of ${plural(result.accounts.length, "account")}`
      : "No holdings were saved";
  const history = result.history.filter((h) => !h.done);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span ref={title} id={ids.title} tabIndex={-1}>
            {heading}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <ul className="grid gap-2">
          {result.accounts.map((a) => (
            <li key={a.key} id={ids.account(a.key)} tabIndex={-1} className="flex flex-wrap items-center gap-2">
              <Mark ok={a.state === "saved"} />
              <span>{accountWords(a)}</span>
              {a.state !== "saved" && (
                <WrapButton type="button" variant="outline" size="sm" onClick={() => onRetryAccount(a.key)}>
                  Try again<span className="sr-only">: {a.name}</span>
                </WrapButton>
              )}
            </li>
          ))}
        </ul>
        {result.unfinished.length > 0 && (
          <ul className="grid gap-2">
            {result.unfinished.map((u) => (
              <li key={ids.unfinished(u)} id={ids.unfinished(u)} tabIndex={-1} className="flex flex-wrap items-center gap-2">
                {u.done && <Mark ok />}
                <span className={u.done ? "" : "text-warning"}>{unfinishedWords(u)}</span>
                {!u.done && (
                  <WrapButton type="button" variant="outline" size="sm" onClick={() => onRetryUnfinished(u)}>
                    {u.what === "price" ? "Retry saving the price" : "Retry saving the details"}
                    <span className="sr-only">: {u.name}</span>
                  </WrapButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {result.history.length > 0 && (
          <p id={ids.history} tabIndex={-1} className="flex flex-wrap items-center gap-2">
            {history.length ? (
              <>
                <span className="text-warning">
                  {saved.length === 1 || history.length === result.accounts.length ? "Holdings saved" : `Holdings saved in ${names(history.map((h) => h.name))}`},
                  but the import history couldn't be saved. The next import may not know which holdings this statement added.
                </span>
                <WrapButton type="button" variant="outline" size="sm" onClick={onRetryHistory}>
                  Try again<span className="sr-only">: save the import history</span>
                </WrapButton>
              </>
            ) : (
              <>
                <Mark ok />
                The import history was saved.
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
