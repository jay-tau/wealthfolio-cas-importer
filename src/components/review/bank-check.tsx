import type { ActivityDetails } from "@wealthfolio/addon-sdk";
import { Checkbox } from "@wealthfolio/ui";
import { converts, type EntryFacts, entryNotes, OUTSIDE_SPENDING, outsideSpending } from "../../cas/bank-entries";
import { day } from "../../cas/plan";
import { type BankPair, MOVEMENT } from "../../cas/review";
import { longDate, rupees } from "../../lib/review-format";
import { LinkButton, WrapButton } from "./parts";

/** The bank matches for one effective bank account, as one question. */
export interface BankCheckModel {
  /** `the bank choice's key|bank account ID`. */
  id: string;
  /** The key of the bank choice that set it, which it's shown under. */
  anchor: string;
  bankId: string;
  bankName: string;
  /** Its investor's box and bank, distinguishing repeated controls. */
  label: string;
  pairs: BankPair[];
  /** The pairs' keys, which an answer and ticks hold on to. */
  signature: string;
}

/** Whether the import pays out of the bank account: a purchase. */
export const paid = (pair: Pick<BankPair, "t">) => pair.t.transaction.bank!.activityType === "TRANSFER_OUT";

/** What a check's pairs are: "purchases", "payouts", or both. */
function kinds(pairs: BankPair[]) {
  const purchases = pairs.some(paid);
  const payouts = pairs.some((p) => !paid(p));
  const sales = pairs.some((p) => p.t.transaction.rows[0].type === "REDEMPTION");
  const dividends = pairs.some((p) => p.t.transaction.rows[0].type === "DIVIDEND_PAYOUT");
  return { purchases, payouts, incoming: sales && dividends ? "sales and cash dividends" : sales ? "sales" : "cash dividends" };
}

/** "6 entries already in Savings account look like these purchases and payouts" */
export function checkHeading(check: BankCheckModel) {
  const n = check.pairs.length;
  const { purchases, payouts } = kinds(check.pairs);
  const what = purchases && payouts ? "purchases and payouts" : purchases ? "purchases" : "payouts";
  return n === 1
    ? `1 entry already in ${check.bankName} looks like this ${what.replace(/s\b/g, "")}`
    : `${n} entries already in ${check.bankName} look like these ${what}`;
}

/** What happens to the pairs left unlinked, said before the choice. */
export function unlinkedWords(check: BankCheckModel) {
  const { purchases, payouts, incoming } = kinds(check.pairs);
  const parts = [
    purchases && `Unlinked purchases get new transfers from ${check.bankName}`,
    payouts && `${purchases ? "unlinked" : "Unlinked"} ${incoming} get new transfers ${purchases ? "back to it" : `to ${check.bankName}`}`,
  ].filter(Boolean);
  const which = purchases && payouts ? "payment or payout" : purchases ? "payment" : "payout";
  return `${parts.join("; ")}. If an entry above is that ${which}, the new transfer would count it twice.`;
}

/** What the answer did, for its line. */
export function checkReceipt(check: BankCheckModel, linked: number) {
  const n = check.pairs.length;
  const { purchases, payouts } = kinds(check.pairs);
  const noun = purchases && payouts ? ["payment or payout", "payments and payouts"] : purchases ? ["payment", "payments"] : ["payout", "payouts"];
  if (!linked) {
    const dir = purchases && payouts ? "with" : purchases ? "from" : "to";
    return n === 1
      ? `Not linked: the ${noun[0]} gets a new transfer ${dir} ${check.bankName}`
      : `Not linked: all ${n} ${noun[1]} get new transfers ${dir} ${check.bankName}`;
  }
  if (linked === n) {
    return n === 1
      ? `The ${noun[0]} is linked to an entry already in ${check.bankName}`
      : `All ${n} ${noun[1]} linked to entries already in ${check.bankName}`;
  }
  return `${linked} of ${n} ${noun[1]} linked to entries already in ${check.bankName}; the rest get new transfers`;
}

/** A movement as today's preview words it: "Purchase · 5 Jan 2026 · ₹5,000, from Savings account". */
export function movementWords(pair: BankPair, bankName: string) {
  const { rows, bank } = pair.t.transaction;
  // The amount the entry matched, printed or with charges, else the transfer's.
  const amount = pair.exact && pair.entry.amount !== null ? pair.entry.amount : String(bank!.amount);
  return `${MOVEMENT[rows[0].type] ?? "Payment"} · ${longDate(String(bank!.date))} · ${rupees(amount)}, ${paid(pair) ? "from" : "to"} ${bankName}`;
}

/** The bank entry: its description, day and amount, with a sign for money out. */
const entryWords = (entry: ActivityDetails, out: boolean) =>
  `${longDate(day(entry.date))} · ${out ? "−" : "+"}${rupees(String(entry.amount ?? ""))}`;

/**
 * The bank matches for one bank account, as a question: every pair at once, the strong ones ticked,
 * each with its evidence, then Link N selected or Create new transfers instead. Answered, it's one
 * line with Change answer.
 */
export function BankCheck({
  check,
  ticked,
  answered,
  facts,
  fundName,
  headingId,
  changeId,
  pairId,
  onTick,
  onLink,
  onNone,
  onChange,
}: {
  check: BankCheckModel;
  ticked: ReadonlySet<string>;
  /** The answer, as how many pairs it links; undefined while it's open. */
  answered?: number;
  facts: ReadonlyMap<string, EntryFacts>;
  fundName: (pair: BankPair) => string;
  headingId: string;
  changeId: string;
  /** The id of a pair's checkbox. */
  pairId: (pair: BankPair) => string;
  onTick: (key: string, yes: boolean) => void;
  onLink: () => void;
  onNone: () => void;
  onChange: () => void;
}) {
  if (answered !== undefined) {
    const text = checkReceipt(check, answered);
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border p-3 text-sm">
        <span aria-hidden="true" className="text-success">
          ✓
        </span>
        <span className="min-w-0 flex-1">{text}</span>
        <LinkButton id={changeId} type="button" aria-label={`Change answer: ${text}: ${check.label}`} onClick={onChange}>
          Change answer
        </LinkButton>
      </div>
    );
  }
  const count = check.pairs.filter((p) => ticked.has(p.key)).length;
  const hint = `${headingId}-unlinked`;
  return (
    <section aria-labelledby={headingId} className="border-warning grid gap-3 rounded-lg border p-4">
      <h4 id={headingId} tabIndex={-1} className="font-semibold">
        {checkHeading(check)}
      </h4>
      <p className="text-muted-foreground text-sm">
        Linking uses the existing bank entry for this payment or payout, so it's counted once. Ticked: exact amount within a day, a
        unique match, and the description names the fund house or mentions mutual funds.
      </p>
      {check.pairs.some((p) => outsideSpending(facts.get(p.entry.id))) && <p className="text-sm">{OUTSIDE_SPENDING}</p>}
      <ul className="grid gap-2" aria-label={`Bank entries in ${check.bankName} to link`}>
        {check.pairs.map((pair, i) => {
          const out = paid(pair);
          const notes = entryNotes(facts.get(pair.entry.id), check.bankName);
          return (
            <li key={pair.key} className="rounded-md border p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id={pairId(pair)}
                  className="mt-0.5"
                  checked={ticked.has(pair.key)}
                  aria-labelledby={`${pairId(pair)}-fund ${pairId(pair)}-movement ${pairId(pair)}-entry ${pairId(pair)}-context`}
                  aria-describedby={`${pairId(pair)}-reason`}
                  onCheckedChange={(yes) => onTick(pair.key, yes)}
                />
                <div className="grid min-w-0 flex-1 gap-1 text-sm">
                  <span id={`${pairId(pair)}-context`} className="sr-only">Pair {i + 1}: {check.label}</span>
                  <span id={`${pairId(pair)}-fund`} className="font-medium">
                    {fundName(pair)}
                  </span>
                  <span id={`${pairId(pair)}-movement`} className="text-muted-foreground">
                    {movementWords(pair, check.bankName)}
                  </span>
                  <span id={`${pairId(pair)}-entry`} style={{ overflowWrap: "anywhere" }}>
                    {check.bankName}: <span className="font-medium">{pair.entry.comment?.trim() || "No description"}</span> ·{" "}
                    <span className="text-muted-foreground">{entryWords(pair.entry, out)}</span>
                  </span>
                  <span id={`${pairId(pair)}-reason`} className={pair.strong ? "text-muted-foreground" : "text-warning"}>
                    {pair.reason}
                  </span>
                  {notes.map((note) => (
                    <span key={note} className="text-muted-foreground text-xs">
                      {note}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {check.pairs.some((p) => converts(p.entry)) && (
        <p className="text-muted-foreground text-sm">
          Linking changes {check.pairs.every((p) => converts(p.entry)) ? "each" : "a"} withdrawal or deposit into a transfer, linked with the fund account's.
        </p>
      )}
      <p id={hint} className="text-muted-foreground text-sm">
        {unlinkedWords(check)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <WrapButton type="button" disabled={!count} aria-label={`Link ${count} selected: ${check.label}`} aria-describedby={hint} onClick={onLink}>
          Link {count} selected
        </WrapButton>
        <WrapButton type="button" variant="outline" aria-label={`Create new transfers instead: ${check.label}`} aria-describedby={hint} onClick={onNone}>
          Create new transfers instead
        </WrapButton>
      </div>
    </section>
  );
}
