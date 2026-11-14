import { cmp, dec } from "../cas/decimal.ts";
import { type AccountPlan, assetName, assetNames, type Choices, included, type PlannedPosition, snapshotOf, type Source } from "../cas/holdings.ts";
import { fundRef } from "../cas/plan.ts";
import { plural } from "./plural.ts";
import { longDate, shortDate, units } from "./review-format.ts";

// What the Review screen's rare questions say: a plain heading, at most one line of evidence, the safe
// answer first, and what each answer did, for its line once answered and for the bar.

/** A rare question's words. `main` is the safe answer. */
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
  /** The answered line, for the main answer (true) or the other. */
  receipt: (main: boolean) => string;
  /** What the bar says the answer does, for the main answer (true) or the other. */
  done: (main: boolean) => string;
}

/** "A, B and C". */
export const list = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const titleOf = (s: Source) => s.title ?? s.label;
const titles = (sources: readonly Source[]) => list([...new Set(sources.map(titleOf))]);
/** "this folio", "this demat account", "this NPS account". */
const thisOne = (s: Source) => (s.kind === "folio" ? "this folio" : s.kind === "demat" ? "this demat account" : "this NPS account");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Import records hold identifiers, not units: removing a holding also removes units added another way. */
const IMPORTS_DONT_RECORD = "imports don't record how many units each folio, demat account or PRAN added";

export const MISSING_WHY =
  "A statement can leave out a fund you still hold, for example one that covers only some fund houses. Set it to zero only if you no longer own any of its units; otherwise keep them, and check a statement that lists this fund.";

/**
 * The words of a position's question (`position.ask`) in `plan`'s account. `name` gives a position's
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
  const held = position.existing ? units(position.existing.units) : "";
  if (ask.kind === "missing") {
    const zero = `Set it to zero on ${shortDate(plan.date)}`;
    return {
      title: `${own} isn't on this statement`,
      line: `${account} holds ${held} units of it, from an earlier import of ${titles(position.removable!)}.`,
      main: `Keep ${held} units`,
      other: zero,
      why: MISSING_WHY,
      receipt: (keep) => (keep ? `${own}: kept at ${held} units` : `${own}: set to zero on ${shortDate(plan.date)}`),
      done: (keep) => (keep ? `${own} kept at ${held} units` : `${own} set to zero`),
    };
  }
  if (ask.kind === "moved") {
    const moved = ask.moved.map((m) => m.source);
    const accounts = [...new Set(ask.moved.map((m) => m.account))];
    const one = moved.length === 1 && position.removable!.length === 1;
    return {
      title: `${titles(moved)} now ${moved.length === 1 ? "goes" : "go"} to ${list(accounts)}`,
      line: `${account} holds ${held} units of ${own} that ${one ? thisOne(moved[0]) : `earlier imports of ${titles(position.removable!)}`} added.`,
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
      line: `${account} also holds ${held} units of it${as}, from an earlier import of ${titles(position.removable!)}.`,
      main: `Keep them in ${account}`,
      other: `Remove them from ${account}`,
      caution: `Remove them only if all of them came from ${titles(position.removable!)}: ${IMPORTS_DONT_RECORD}.`,
      receipt: (keep) => `${name(row)}: ${account}'s ${held} units ${keep ? "kept" : "removed"}`,
      done: (keep) => `${name(row)}: ${account}'s ${held} units ${keep ? "kept" : "removed"}`,
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
    receipt: (keep) => (keep ? `${printed}: kept as ${old} for now` : `${printed}: ${old} replaced with ${now}`),
    done: (keep) => (keep ? `${printed} kept as ${old}` : `${old} replaced with ${now}`),
  };
}

/** A holding still waiting for an answer to which fund it is, on the same-date question. */
export interface Waiting {
  name: string;
  units: string;
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
    if (after === undefined) {
      if (before) lines.push(`${name(p)}: ${units(before.units)} units now, ${missing ? "set to zero" : "removed"}`);
    } else if (!before) lines.push(`${name(p)}: added, ${units(after)} units`);
    else if (missing && !statement) lines.push(`${name(p)}: ${units(before.units)} units now, not on this statement`);
    else if (cmp(dec(before.units), dec(after)) !== 0) lines.push(`${name(p)}: ${units(before.units)} units now, ${units(after)} on this statement`);
    else same++;
  }
  for (const w of waiting) lines.push(`${w.name}: ${units(w.units)} units on this statement, still to be matched`);
  if (same) lines.push(`${lines.length ? plural(same, "other holding") : plural(same, "holding")}: same units`);
  return lines;
}

/** The same-date question's words, for an account that has holdings saved for the statement's date. */
export function sameDateWords(account: string, date: string): Omit<AskWords, "line"> {
  const on = longDate(date);
  return {
    title: `${account} already has holdings saved for ${on}`,
    main: "Keep the saved ones",
    other: "Replace them with this statement",
    receipt: (keep) => (keep ? `${account}: keep the holdings already saved for ${on}` : `${account}: replace the holdings saved for ${on}`),
    done: (keep) => (keep ? `${account}: existing holdings kept for ${on}.` : `${account}: the holdings saved for ${on} are replaced.`),
  };
}
