import type { ReactNode } from "react";
import type { Breakdown } from "../../cas/review";
import { nameNumber } from "../../lib/name-number";
import { plural } from "../../lib/plural";
import { Disclosure, LinkButton } from "./parts";

/** "A, B and C". */
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A fund that starts with units bought before the statement, which Wealthfolio doesn't have. */
export interface EarlierFund {
  key: string;
  name: string;
  /** "1,000.000 units" */
  units: string;
  /** Its transactions that wait. */
  waiting: number;
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
 * up, with Change; and transactions left out for a reason of their own.
 */
export function NotIncludedDetailed({
  earlier,
  skipped,
  notImported,
  unbalanced,
  leftOut,
  registrar,
  open,
  setOpen,
  partId,
  changeId,
  onChange,
  onReopen,
  changePanel,
}: {
  earlier: EarlierFund[];
  skipped: string[];
  /** Folios set to Don't import, by name. */
  notImported: string[];
  /** Funds whose rows don't add up, skipped by an answer: each can still be changed. */
  unbalanced: Pick<LeftOutFund, "key" | "name" | "label">[];
  leftOut: LeftOutFund[];
  /** "CAMS", "KFintech": whose earlier statement to read. */
  registrar: string;
  open: Record<string, boolean>;
  setOpen: (id: string, open: boolean) => void;
  partId: string;
  changeId: (key: string) => string;
  onChange: (key: string) => void;
  onReopen: (key: string) => void;
  changePanel: (key: string) => ReactNode;
}) {
  if (!earlier.length && !skipped.length && !notImported.length && !unbalanced.length && !leftOut.length) return null;
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
              so its {plural(fund.waiting, "transaction")} {fund.waiting === 1 ? "waits" : "wait"}.
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
              <p className="text-muted-foreground mt-1">
                Read an earlier {registrar} statement that includes its first purchase, or add the {fund.units} in Wealthfolio as a buy with their
                cost and date. Then read this statement again: transactions already imported are skipped.
              </p>
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
            <p key={fund.key}>
              {fund.name} ·{" "}
              <LinkButton type="button" aria-label={`Change: ${fund.label}, transactions don't add up`} onClick={() => onReopen(fund.key)}>
                Change
              </LinkButton>
            </p>
          ))}
        </div>
      )}
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
 * Wealthfolio has every transaction already.
 */
export const nothingWords = (b: Breakdown) =>
  b.total > 0 && b.before === b.total
    ? "Nothing new: every transaction on this statement is already in Wealthfolio."
    : "Nothing is ready to import. See the transactions left out or waiting above.";

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
