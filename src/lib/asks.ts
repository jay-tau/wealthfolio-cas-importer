import { cmp, dec } from "../cas/decimal.ts";
import { type AccountPlan, assetName, assetNames, type Choices, countedIn, included, type PlannedPosition, snapshotOf, type Source, titleOf } from "../cas/holdings.ts";
import { fundRef } from "../cas/plan.ts";
import { nameNumber } from "./name-number.ts";
import { plural } from "./plural.ts";
import { type Counted, figure, longDate, movements, ordinal, quantity, shortDate } from "./review-format.ts";

// What the Review screen's rare questions say: a plain heading, at most one line of evidence, the safe
// answer first, and what each answer did, for its line once answered and for the bar.

/** A rare question's words. `main` is the safe answer, shown first. */
export interface AskWords {
  title: string;
  /** The evidence, one line. */
  line: string;
  main: string;
  other: string;
  /** What the main answer leaves, said under the buttons. */
  note?: string;
  /** What the other answer also removes, said under the buttons. */
  caution?: string;
  /** Why it's asked, behind "Why am I asked?", where the reason isn't obvious. */
  why?: string;
  /**
   * The answered line, for the main answer (true) or the other: what the answer did. It names the
   * question, account included, as Change answer's name is "Change answer: " and this line.
   */
  receipt: (main: boolean) => string;
  /** What the bar says the answer does, for the main answer (true) or the other. */
  done: (main: boolean) => string;
}

/** A possible duplicate's line, as its card shows it: its day, and its units and amount if it has them. */
export interface LineFacts {
  day: string;
  units?: string;
  amount?: string;
}

const BOTH_EQUAL = "Two equal transactions on one day can both be real.";

/**
 * Why both of a possible duplicate's transactions can be real, saying what their lines share: equal
 * only when their day, units and amount are. Without `other`, Wealthfolio reported an equal one.
 */
export function bothRealWords(line: LineFacts, other?: LineFacts) {
  if (!other) return BOTH_EQUAL;
  const day = line.day === other.day;
  const units = !!line.units && line.units === other.units;
  const amount = !!line.amount && line.amount === other.amount;
  if (day && amount && line.units === other.units) return BOTH_EQUAL;
  const same = units && amount ? " with the same units and amount" : units ? " with the same units" : amount ? " for the same amount" : "";
  return `Two transactions${day ? " on one day" : ""}${same} can both be real.`;
}

/**
 * What a numbered possible duplicate's card says its number counts: the statement's rows of its
 * fund and folio with its movement, day and amount, in the statement's order. Rows without an
 * amount are counted apart from rows with one, so it says so.
 */
export function placeWords(place: { n: number; of: number }, word: string, money: string | undefined, day: string) {
  const amount = money ? ` of ${money}` : " with no amount shown";
  return `The statement lists ${plural(place.of, word, movements(word))}${amount} in this fund and folio on ${day}; this is the ${ordinal(place.n)}.`;
}

/**
 * What Change answer's name says after its label for each answered question: its line, then a number
 * when another answered line reads the same, as equal names are numbered elsewhere (", question 2").
 * Undefined lines are open questions.
 */
export function answerNames(lines: readonly (string | undefined)[]) {
  // An open question's empty name never matches an answered line.
  const named = lines.map((line) => ({ name: line ?? "" }));
  return lines.map((line, i) => (line === undefined ? undefined : `${line}${nameNumber(named, i, "question")}`));
}

/** "A, B and C". */
export const list = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const titles = (sources: readonly Source[]) => list([...new Set(sources.map(titleOf))]);
/** "this folio", "this demat account", "this NPS account". */
const thisOne = (s: Source) => (s.kind === "folio" ? "this folio" : s.kind === "demat" ? "this demat account" : "this NPS account");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Import records hold identifiers, not units: removing a holding also removes units added another way. */
const IMPORTS_DONT_RECORD = "imports don't record how many units each folio, demat account or PRAN added";

export const MISSING_WHY =
  "A statement can leave out a fund you still hold, for example one that covers only some fund houses. Set it to zero only if you no longer own any of its units; otherwise keep them, and check a statement that lists this fund.";

/**
 * The words of a position's question (`position.ask`) in `plan`'s account, which `account` names as
 * the screen does: told apart from another account of the same name. `name` gives a position's
 * name as the Review screen shows it, and `statement` a statement row's name as the statement prints
 * it; `provider` the price source of a statement row's chosen asset.
 */
export function holdingAskWords(
  plan: AccountPlan,
  position: PlannedPosition,
  { account, name, statement = name, provider }: {
    account: string;
    name: (p: PlannedPosition) => string;
    statement?: (p: PlannedPosition) => string;
    provider?: (p: PlannedPosition) => string | undefined;
  },
): AskWords {
  const ask = position.ask!;
  const own = name(position);
  // The account's units, counted as their holding is: "100 shares", "512.300 units".
  const held = position.existing ? quantity(countedIn(position), position.existing.units) : "";
  if (ask.kind === "missing") {
    const zero = `Set it to zero on ${shortDate(plan.date)}`;
    return {
      title: `${own} isn't on this statement`,
      line: `${account} holds ${held} of it, from an earlier import of ${titles(position.removable!)}.`,
      main: `Keep ${held}`,
      other: zero,
      why: MISSING_WHY,
      receipt: (keep) => (keep ? `${own}: ${held} kept in ${account}` : `${own}: set to zero in ${account} on ${shortDate(plan.date)}`),
      done: (keep) => (keep ? `${own} kept at ${held}` : `${own} set to zero`),
    };
  }
  if (ask.kind === "moved") {
    const moved = ask.moved.map((m) => m.source);
    const accounts = [...new Set(ask.moved.map((m) => m.account))];
    const one = moved.length === 1 && position.removable!.length === 1;
    return {
      title: `${titles(moved)} now ${moved.length === 1 ? "goes" : "go"} to ${list(accounts)}`,
      line: `${account} holds ${held} of ${own} that ${one ? thisOne(moved[0]) : `earlier imports of ${titles(position.removable!)}`} added.`,
      main: `Keep them in ${account}`,
      other: `Remove them from ${account}`,
      caution: `Remove them only if all of them came from ${one ? thisOne(moved[0]) : titles(position.removable!)}: ${IMPORTS_DONT_RECORD}.`,
      receipt: (keep) => `${own}: ${keep ? "kept in" : "removed from"} ${account}`,
      done: (keep) => `${own} ${keep ? "kept in" : "removed from"} ${account}`,
    };
  }
  if (ask.kind === "overlap") {
    const row = plan.positions.find((p) => p.key === ask.row) ?? position;
    const as = row === position ? "" : ` as ${assetName(position)}`;
    return {
      title: `${name(row)} is already tracked in ${list(ask.tracked.map((a) => a.name))}`,
      line: `${account} also holds ${held} of it${as}, from an earlier import of ${titles(position.removable!)}.`,
      main: `Keep them in ${account}`,
      other: `Remove them from ${account}`,
      caution: `Remove them only if all of them came from ${titles(position.removable!)}: ${IMPORTS_DONT_RECORD}.`,
      receipt: (keep) => `${name(row)}: ${held} ${keep ? "kept in" : "removed from"} ${account}`,
      done: (keep) => `${name(row)}: ${held} ${keep ? "kept in" : "removed from"} ${account}`,
    };
  }
  // A statement row that would replace an asset an earlier import added it as. The answers go by
  // the assets' names, with their symbols where the names alone don't tell them apart.
  const olds = plan.positions.filter((p) => position.replaces?.includes(p.key));
  const printed = statement(position);
  const alike = olds.some((p) => p.name === position.name);
  const old = alike ? assetNames(olds) : list([...new Set(olds.map((p) => p.name))]);
  const amfi = provider?.(position) === "AMFI";
  const now = amfi ? "the AMFI fund" : alike ? assetName(position) : position.name;
  return {
    title: `${printed} is now matched to ${amfi ? "its AMFI fund" : now === printed ? assetName(position) : now}`,
    line: `${account} holds it as ${assetNames(olds)}.`,
    main: `Keep ${old} for now`,
    note: `${capital(now)} isn't saved, so its units aren't counted twice.`,
    other: `Replace ${old} with ${now}`,
    caution: `Replace ${old} only if all ${olds.length > 1 ? "their" : "its"} units came from ${titles(ask.recorded ?? position.lines.map((l) => l.source))}: ${IMPORTS_DONT_RECORD}.`,
    receipt: (keep) => (keep ? `${printed}: kept as ${old} in ${account} for now` : `${printed}: ${old} replaced with ${now} in ${account}`),
    done: (keep) => (keep ? `${printed} kept as ${old}` : `${old} replaced with ${now}`),
  };
}

/** A holding still waiting for an answer to which fund it is, on the same-date question. */
export interface Waiting {
  name: string;
  units: string;
  noun: Counted;
}

/**
 * What replacing an account's holdings saved for the statement's date changes, from what the import
 * would save there: holdings added, units that change, and holdings the statement doesn't list, then
 * a count of the others. Each asset uses its actual saved quantity, leaving out skipped, excluded
 * and rerouted statement contributions.
 */
export function sameDateChanges(plan: AccountPlan, choices: Choices, name: (p: PlannedPosition) => string, waiting: readonly Waiting[] = []) {
  const lines: string[] = [];
  let same = 0;
  const keyOf = (p: PlannedPosition) => {
    const id = p.existing?.assetId ?? p.asset?.assetId;
    return id ? `id:${id}` : `ref:${p.ref}`;
  };
  // The host keeps the last row of an asset; split contributions have already been added together.
  const saved = new Map(snapshotOf(plan, choices).holdings.map((h) =>
    [h.assetId ? `id:${h.assetId}` : `ref:${fundRef(h.symbol!, h.exchangeMic)}`, h.quantity]));
  const groups = new Map<string, PlannedPosition[]>();
  for (const p of plan.positions) {
    const key = keyOf(p);
    const positions = groups.get(key) ?? [];
    positions.push(p);
    groups.set(key, positions);
  }
  for (const [key, positions] of groups) {
    const statement = positions.find((p) => p.lines.length && !p.misread && included(p, choices));
    const missing = positions.find((p) => p.ask?.kind === "missing");
    const p = statement ?? missing ?? positions[0];
    const before = positions.find((p) => p.existing)?.existing;
    const after = saved.get(key);
    const noun = countedIn(p);
    if (after === undefined) {
      if (before) lines.push(`${name(p)}: ${quantity(noun, before.units)} now, ${missing ? "set to zero" : "removed"}`);
    } else if (!before) lines.push(`${name(p)}: added, ${quantity(noun, after)}`);
    else if (missing && !statement) lines.push(`${name(p)}: ${quantity(noun, before.units)} now, not on this statement`);
    else if (cmp(dec(before.units), dec(after)) !== 0) lines.push(`${name(p)}: ${quantity(noun, before.units)} now, ${figure(noun, after)} on this statement`);
    else same++;
  }
  for (const w of waiting) lines.push(`${w.name}: ${quantity(w.noun, w.units)} on this statement, still to be matched`);
  if (same) lines.push(`${lines.length ? plural(same, "other holding") : plural(same, "holding")}: same units`);
  return lines;
}

/**
 * The same-date question's words, for an account that has holdings saved for the statement's date.
 * `account` is as the screen names it: told apart from another account of the same name.
 */
export function sameDateWords(account: string, date: string): Omit<AskWords, "line"> {
  const on = longDate(date);
  return {
    title: `${account} already has holdings saved for ${on}`,
    main: "Keep the saved ones",
    other: "Replace them with this statement",
    receipt: (keep) => (keep ? `${account}: kept the holdings already saved for ${on}` : `${account}: replaced the holdings saved for ${on} with this statement`),
    done: (keep) => (keep ? `${account}: existing holdings kept for ${on}.` : `${account}: the holdings saved for ${on} are replaced.`),
  };
}
