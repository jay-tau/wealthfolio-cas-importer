import type { ReactNode } from "react";
import type { Breakdown } from "../../cas/review";
import { nameNumber } from "../../lib/name-number";
import { plural } from "../../lib/plural";
import { Disclosure, LinkButton } from "./parts";

/** "A, B and C". */
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * What an account has of a waiting fund before the statement, when that isn't nothing: fewer units
 * than its folios start with ("50.000", and "50.000" to add), more ("150.000", "50.000" too many),
 * or none that can be counted, because of posted splits or option expiries ("5 Jan 2022").
 */
export type EarlierHeld =
  | { kind: "short"; has: string; add: string }
  | { kind: "over"; has: string; extra: string }
  | { kind: "uncounted"; by: { day: string; kind: "split" | "option expiry" }[] };

/** A fund that starts with units bought before the statement, which Wealthfolio doesn't have. */
export interface EarlierFund {
  key: string;
  name: string;
  /** "1,000.000 units" */
  units: string;
  /** Its transactions that wait. */
  waiting: number;
  /**
   * When none wait, but the statement has transactions for the fund elsewhere: the folios that
   * start with these units. `parts`: those folios have transactions in other sections for the fund.
   */
  noTransactionsIn?: { folios: string[]; parts: boolean };
  /**
   * When its folios go to more than one account, or an account has some of its units: each waiting
   * account's units ("100.000"), its name as the screen gives it, its folios' numbers, and what it
   * has of the fund before the statement.
   */
  accounts?: { units: string; account: string; folios: string[]; held?: EarlierHeld }[];
  /**
   * The new accounts its waiting units go to that this import won't create, as nothing ready to
   * import goes into them: each one's name and its folios' numbers.
   */
  uncreated?: { account: string; folios: string[] }[];
}

type EarlierAccount = NonNullable<EarlierFund["accounts"]>[number];

/** "folio 7712045", "folios 91234567 and 3301". */
const folioWords = (folios: string[]) => `${folios.length === 1 ? "folio" : "folios"} ${list(folios)}`;

/** "a split on 5 Jan 2022", "splits on 5 Jan 2022 and 3 Mar 2022 and an option expiry on 1 Jun 2022". */
function uncountedWords(by: Extract<EarlierHeld, { kind: "uncounted" }>["by"]) {
  const kinds = (["split", "option expiry"] as const).map((kind) => by.filter((b) => b.kind === kind).map((b) => b.day)).map((days, i) =>
    !days.length ? "" : days.length === 1 ? `${i ? "an option expiry" : "a split"} on ${days[0]}` : `${i ? "option expiries" : "splits"} on ${list(days)}`,
  );
  return list(kinds.filter(Boolean));
}

/** "100.000 in Mutual funds, from folio 7712045 (50.000 in this account before 1 Apr 2023, so 50.000 to add)". */
function accountLine(a: EarlierAccount, from: string) {
  const where = `${a.units} in ${a.account}, from ${folioWords(a.folios)}`;
  const held = a.held;
  if (!held) return where;
  if (held.kind === "short") return `${where} (${held.has} in this account before ${from}, so ${held.add} to add)`;
  if (held.kind === "over") return `${where} (${held.has} in this account before ${from}, so ${held.extra} too many)`;
  return `${where} (${uncountedWords(held.by)} in this account ${held.by.length === 1 ? "keeps" : "keep"} the fund's units from being counted)`;
}

/** "100.000 units in Mutual funds, from folio 7712045", or just the units to add, with what the account already has. */
function addLine(a: EarlierAccount, from: string) {
  const held = a.held;
  if (held?.kind !== "short") return `${a.units} units in ${a.account}, from ${folioWords(a.folios)}`;
  return `${held.add} units in ${a.account}, from ${folioWords(a.folios)} (${held.has} in this account before ${from})`;
}

/**
 * What to do about an account that has more units than its folios start with, or ones that can't be
 * counted. `none`: the statement has no transactions for the fund, so none are to add by hand.
 */
function checkLine(a: EarlierAccount, from: string, none: boolean) {
  const held = a.held;
  const startWith = `${a.units} that ${folioWords(a.folios)} ${a.folios.length === 1 ? "starts" : "start"} with`;
  if (held?.kind === "over") {
    return `In ${a.account}, this fund's transactions before ${from} come to ${held.has} units, ${held.extra} more than the ${startWith}: check them in Wealthfolio, and correct or delete the ones that don't belong.`;
  }
  if (held?.kind !== "uncounted") return "";
  const one = held.by.length === 1;
  const cantCount = `In ${a.account}, the add-on can't count this fund's units across ${uncountedWords(held.by)}, so it can't check that they come to the ${startWith}.`;
  if (none) return `${cantCount} Check ${one ? "it" : "them"} in Wealthfolio, and delete ${one ? "it" : "them"} if ${one ? "it's" : "they're"} wrong.`;
  return `${cantCount} Check ${one ? "it" : "them"} in Wealthfolio: if ${one ? "it's" : "they're"} wrong, delete ${one ? "it" : "them"}; if not, add this statement's transactions for this fund from ${folioWords(a.folios)} in Wealthfolio by hand: the add-on will still leave them out.`;
}

/**
 * How to fix a fund waiting for earlier purchases: read an earlier statement, or add the units in
 * Wealthfolio, first creating each new account they go to that this import won't create; and check
 * each account that has too many of them, or ones that can't be counted. Then read this statement
 * again, unless it has no transactions for the fund.
 */
function howToFix(fund: EarlierFund, registrar: string, from: string) {
  const none = fund.waiting === 0;
  const earlier = `Read an earlier ${registrar} statement that includes its first purchase`;
  // An earlier statement or more units can't fix too many, or units that can't be counted.
  const adds = fund.accounts?.filter((a) => !a.held || a.held.kind === "short");
  const checks = (fund.accounts ?? []).map((a) => checkLine(a, from, none)).filter(Boolean).map((line) => `${line} `).join("");
  const buys = adds
    ? `add the units in Wealthfolio as ${adds.length === 1 ? "a buy" : "buys"} with their cost and date: ${adds.map((a) => addLine(a, from)).join("; ")}.`
    : `add the ${fund.units} in Wealthfolio as a buy with their cost and date.`;
  const missing = fund.uncreated ?? [];
  if (!missing.length) {
    const fix = `${adds?.length === 0 ? "" : `${earlier}, or ${buys} `}${checks}`;
    return none ? fix.trimEnd() : `${fix}Then read this statement again: transactions already imported are skipped.`;
  }
  const again = none ? `${earlier}.` : `${earlier}, then this one again.`;
  const end = none ? "" : " Transactions already imported are skipped.";
  // In one account, the account is the fund's only one.
  if (!fund.accounts) {
    const add = `add the ${fund.units} there as a buy with their cost and date`;
    return `${again} Or, as ${missing[0].account} doesn't exist yet, create an account that tracks transactions in Wealthfolio${
      none ? ` and ${add}.` : `, ${add}, then read this statement again and choose that account in “Save to”.`
    }${end}`;
  }
  const one = missing.length === 1;
  const names = list(missing.map((a) => a.account));
  const then = none ? "" : ` Then read this statement again and choose ${one ? "it" : "them"} in “Save to” for ${one ? folioWords(missing[0].folios) : "their folios"}.`;
  return `${checks}${again} Or, as ${names} ${one ? "doesn't" : "don't"} exist yet, first create ${one ? "an account that tracks" : "accounts that track"} transactions in Wealthfolio for ${one ? "its" : "their"} units, then ${buys}${then}${end}`;
}

/** A fund with transactions left out for a reason of their own, each said in a line. */
export interface LeftOutFund {
  key: string;
  name: string;
  /** Its accessible name, numbered when another has the same one. */
  label: string;
  lines: { when: string; reason: string }[];
  /** Its fund can be changed from here, as its reasons may ask. */
  canChange: boolean;
}

const sectionTitle = "text-muted-foreground text-sm font-semibold uppercase tracking-wide";

/**
 * What this import leaves out, each with why: funds waiting for earlier purchases, with How to fix;
 * funds skipped by an answer; folios set to Don't import; funds skipped because their rows don't add
 * up, with Change; possible duplicates skipped by an answer; and transactions left out for a reason
 * of their own.
 */
export function NotIncludedDetailed({
  earlier,
  skipped,
  notImported,
  unbalanced,
  duplicates,
  leftOut,
  registrar,
  from,
  open,
  setOpen,
  partId,
  changeId,
  onChange,
  onReopen,
  onReopenAsk,
  changePanel,
}: {
  earlier: EarlierFund[];
  skipped: string[];
  /** Folios set to Don't import, by name. */
  notImported: string[];
  /**
   * Funds whose rows don't add up, skipped by an answer, one per question, by the question's id:
   * Change opens that question again.
   */
  unbalanced: (Pick<LeftOutFund, "name" | "label"> & { id: string })[];
  /** Funds with possible duplicates skipped by an answer, and how many. */
  duplicates: { key: string; name: string; count: number }[];
  leftOut: LeftOutFund[];
  /** "CAMS", "KFintech": whose earlier statement to read. */
  registrar: string;
  /** The statement's first day: "1 Apr 2023". */
  from: string;
  open: Record<string, boolean>;
  setOpen: (id: string, open: boolean) => void;
  partId: string;
  changeId: (key: string) => string;
  onChange: (key: string) => void;
  onReopen: (key: string) => void;
  /** Opens a skipped "don't add up" question again, by its id. */
  onReopenAsk: (id: string) => void;
  changePanel: (key: string) => ReactNode;
}) {
  if (!earlier.length && !skipped.length && !notImported.length && !unbalanced.length && !duplicates.length && !leftOut.length) return null;
  return (
    <section aria-labelledby={`${partId}-heading`} className="grid gap-3">
      <h3 id={`${partId}-heading`} tabIndex={-1} className={sectionTitle}>
        Not included in this import
      </h3>
      {earlier.map((fund, i) => (
        <div key={fund.key} className="grid gap-1 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span>
              <span className="font-semibold">Earlier purchases needed</span>: {fund.name} starts with {fund.units} bought before this statement,
              {fund.waiting
                ? ` so its ${plural(fund.waiting, "transaction")} ${fund.waiting === 1 ? "waits" : "wait"}.`
                : ` and the statement has no transactions for it${fund.noTransactionsIn
                  ? ` in ${fund.noTransactionsIn.parts ? "the parts of " : ""}${folioWords(fund.noTransactionsIn.folios)}${fund.noTransactionsIn.parts ? " that start with these units" : ""}`
                  : ""}.`}
              {fund.accounts && ` Units needed: ${fund.accounts.map((a) => accountLine(a, from)).join("; ")}.`}
              {!!fund.uncreated?.length &&
                (fund.uncreated.length === 1
                  ? ` The new account ${fund.uncreated[0].account} won't be created: nothing ready to import goes into it.`
                  : ` The new accounts ${list(fund.uncreated.map((a) => a.account))} won't be created: nothing ready to import goes into them.`)}
            </span>
            <LinkButton type="button" aria-label={`Change: ${fund.name}${nameNumber(earlier, i, "fund")}, earlier purchases needed`} onClick={() => onReopen(fund.key)}>
              Change
            </LinkButton>
            <Disclosure
              id={`${partId}-how-${fund.key}`}
              label="How to fix"
              ariaLabel={`How to fix: ${fund.name}${nameNumber(earlier, i, "fund")}`}
              open={!!open[`how:${fund.key}`]}
              onOpenChange={(yes) => setOpen(`how:${fund.key}`, yes)}
            >
              <p className="text-muted-foreground mt-1">{howToFix(fund, registrar, from)}</p>
            </Disclosure>
          </div>
        </div>
      ))}
      {skipped.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Skipped ({skipped.length})</span>: {list(skipped)}, by your answer.
        </p>
      )}
      {notImported.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Not imported ({notImported.length})</span>: {list(notImported)}. {notImported.length === 1 ? "Its" : "Their"} account in
          “Save to” is set to Don't import.
        </p>
      )}
      {unbalanced.length > 0 && (
        <div className="grid grid-cols-1 gap-1 text-sm">
          <p>
            <span className="font-semibold">Skipped because their transactions don't add up ({unbalanced.length})</span>, by your answer:
          </p>
          {unbalanced.map((fund) => (
            <p key={fund.id}>
              {fund.name} ·{" "}
              <LinkButton type="button" aria-label={`Change: ${fund.label}, transactions don't add up`} onClick={() => onReopenAsk(fund.id)}>
                Change
              </LinkButton>
            </p>
          ))}
        </div>
      )}
      {duplicates.map((fund) => (
        <p key={fund.key} className="text-sm">
          <span className="font-medium">{fund.name}</span>: {plural(fund.count, "possible duplicate")} skipped by your answer.
        </p>
      ))}
      {leftOut.map((fund) => (
        <div key={fund.key} className="grid gap-1 text-sm">
          <span>
            <span className="font-medium">{fund.name}</span>
            {fund.canChange && (
              <>
                {" "}
                ·{" "}
                <LinkButton id={changeId(fund.key)} type="button" aria-label={`Change: ${fund.label}, not included`} onClick={() => onChange(fund.key)}>
                  Change
                </LinkButton>
              </>
            )}
          </span>
          <ul className="grid gap-1 ps-4">
            {fund.lines.map((line, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{line.when}:</span> {line.reason}
              </li>
            ))}
          </ul>
          {changePanel(fund.key)}
        </div>
      ))}
    </section>
  );
}

/** "a reversed purchase and its reversal", for the transactions left out because of reversals. */
function reversalWords(pairs: { sale: boolean }[]) {
  const sales = pairs.filter((p) => p.sale).length;
  const purchases = pairs.length - sales;
  return [
    purchases === 1 ? "a reversed purchase and its reversal" : purchases ? `${purchases} reversed purchases and their reversals` : "",
    sales === 1 ? "a sale and a later row that may reverse it" : sales ? `${sales} sales and later rows that may reverse them` : "",
  ].filter(Boolean);
}

/**
 * The parts of the statement's transactions, each only when it isn't zero: "128 to import · 8 waiting
 * for your answers · 2 left out: a reversed purchase and its reversal".
 */
export function breakdownParts(b: Breakdown) {
  const reversals = b.leftOut.filter((l) => l.kind === "reversal");
  const pairs = reversals.filter((_, i) => i % 2 === 0).map((l) => ({ sale: l.row.row.type === "REDEMPTION" }));
  const others = b.leftOut.length - reversals.length;
  const reversed = reversalWords(pairs);
  const leftOut = reversed.length
    ? `${b.leftOut.length} left out: ${list(reversed)}${others ? `, and ${others} more listed under “Not included”` : ""}`
    : `${b.leftOut.length} left out, listed under “Not included”`;
  return [
    b.toImport && `${b.toImport} to import`,
    b.importedDuplicates && `${plural(b.importedDuplicates, "possible duplicate")}, imported by your answer`,
    b.before && `${b.before} imported before, skipped`,
    b.duplicates && `${plural(b.duplicates, "possible duplicate")}, waiting for your answer`,
    b.skippedDuplicates && `${plural(b.skippedDuplicates, "possible duplicate")}, skipped by your answer`,
    b.otherDuplicates && `${plural(b.otherDuplicates, "possible duplicate")}, skipped`,
    b.answers && `${b.answers} waiting for your answers`,
    b.earlier && `${b.earlier} waiting for earlier purchases`,
    b.skipped && `${b.skipped} in skipped funds`,
    b.notImported && `${b.notImported} in folios not imported`,
    b.unbalanced && `${b.unbalanced} in funds whose rows don't add up, waiting for your answer`,
    b.skippedUnbalanced && `${b.skippedUnbalanced} in funds whose rows don't add up, skipped by your answer`,
    b.leftOut.length && leftOut,
  ].filter((part): part is string => !!part);
}

/**
 * What the footer and the transactions say when nothing is ready to import: "Nothing new" only when
 * Wealthfolio has every transaction already, or the statement has none and nothing is under “Not
 * included”, which `notIncluded` says. A statement with no transactions points at no transactions.
 */
export function nothingWords(b: Breakdown, notIncluded: boolean) {
  if (b.total > 0) {
    return b.before === b.total
      ? "Nothing new: every transaction on this statement is already in Wealthfolio."
      : "Nothing is ready to import. See the transactions left out or waiting above.";
  }
  return notIncluded ? "This statement has no transactions. See what's not included above." : "Nothing new: this statement has no transactions.";
}

/** The statement's transactions by what happens to them, whose parts add up to the total. */
export function TransactionsSummary({ breakdown, range, partId }: { breakdown: Breakdown; range: string; partId: string }) {
  const parts = breakdownParts(breakdown);
  return (
    <section aria-labelledby={`${partId}-heading`} className="grid gap-3">
      <h3 id={`${partId}-heading`} className={sectionTitle}>
        Transactions in this statement
      </h3>
      <div className="grid gap-1 rounded-lg border p-3 text-sm">
        <p>
          <span className="font-semibold">{plural(breakdown.total, "transaction")}</span>, {range}
        </p>
        {parts.length > 0 && (
          <p className="text-muted-foreground">
            {parts.map((part, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {i === 0 && (breakdown.toImport || breakdown.importedDuplicates) ? <span className="text-foreground font-medium">{part}</span> : part}
              </span>
            ))}
          </p>
        )}
      </div>
    </section>
  );
}
