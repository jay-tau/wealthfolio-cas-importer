import type { Source } from "../cas/holdings";

// Accounts the add-on proposes when none fits, created only when the import is saved. Until then a
// proposed account goes by an ID of its own, which no Wealthfolio account has, keyed by the choice it
// was proposed for: the investor's, a PAN's, a folio's, a demat account's or a PRAN's.

const PREFIX = "new-account:";
/** The proposed account's ID for the choice with this storage key. */
export const proposedId = (key: string) => `${PREFIX}${key}`;
export const isProposed = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX);
/** The storage key of the choice a proposed account's ID was made for. */
export const proposalKey = (id: string) => id.slice(PREFIX.length);

/** Wealthfolio's account form takes 2 to 50 characters; its backend checks only that a name isn't empty. */
export const NAME_MIN = 2;
export const NAME_MAX = 50;

/** What's wrong with a typed account name, by Wealthfolio's form's rule once trimmed; undefined if nothing. */
export function nameProblem(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "Enter an account name.";
  if (trimmed.length < NAME_MIN) return `Use at least ${NAME_MIN} characters.`;
  if (trimmed.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  return undefined;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** At most `max` UTF-16 units, as Wealthfolio's form counts them, with "…" for what's cut and no half character. */
function cut(text: string, max: number) {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}
/** How much of a name the base keeps, at least, when an investor's name follows it. */
const BASE_KEEPS = 16;

/**
 * A generated name in Wealthfolio's 50 characters: `base`, the investor's name in brackets when
 * given, then ` n` from 2. The base is shortened first, down to 16 characters, then the investor's name.
 */
export function accountName(base: string, who?: string, n = 1) {
  const number = n > 1 ? ` ${n}` : "";
  const room = NAME_MAX - number.length;
  // A base too short for Wealthfolio's form says what it is.
  const short = squash(base);
  const b = short.length >= NAME_MIN ? short : `${short} account`.trim();
  const w = who ? squash(who) : "";
  if (!w) return `${cut(b, room)}${number}`;
  const kept = cut(b, Math.max(Math.min(b.length, BASE_KEEPS), room - w.length - 3));
  return `${kept} (${cut(w, room - kept.length - 3)})${number}`;
}

/** Names compare as Wealthfolio's list shows them: whitespace collapsed, in any case. */
const fold = (name: string) => squash(name).toLocaleLowerCase();

export interface Wanted {
  /** The choice's storage key. */
  key: string;
  base: string;
  /** The investor's name, in brackets after the base. */
  who?: string;
}

/**
 * Each wanted account's name: its own or `renamed` one, numbered from 2 while an existing account,
 * whatever its kind or state, or an earlier proposal has it.
 */
export function proposedNames(wanted: readonly Wanted[], taken: Iterable<string>, renamed: Readonly<Record<string, string>> = {}) {
  const used = new Set([...taken, ...Object.values(renamed)].map(fold));
  const names = new Map<string, string>();
  for (const { key, base, who } of wanted) {
    if (key in renamed) {
      names.set(key, renamed[key]);
      continue;
    }
    let n = 1;
    let name = accountName(base, who, n);
    while (used.has(fold(name))) name = accountName(base, who, ++n);
    used.add(fold(name));
    names.set(key, name);
  }
  return names;
}

/** The investor's account for a summary or depository statement: by the depository, else funds. */
export const holdingsBase = (fileType: string) =>
  fileType === "CDSL" ? "CDSL Demat" : fileType === "NSDL" ? "NSDL Demat" : "Mutual funds";

/** An account of its own for a folio, demat account or PRAN, named after it. */
export function sourceBase(source: Pick<Source, "kind" | "label" | "title">) {
  const title = squash(source.title ?? source.label);
  if (source.kind === "nps") return "NPS";
  if (source.kind === "demat") {
    // "Fictiva Securities demat account" (two at one broker add their label after it); without a
    // readable broker, the label: "CDSL Demat Account 1, …".
    const broker = /^(.+?) demat account\b/.exec(title)?.[1];
    if (broker) return `${broker} demat`;
    return /^(\S+) Demat Account\b/i.exec(title)?.[1]?.concat(" Demat") ?? "Demat";
  }
  // A summary statement's "Fictiva Mutual Fund account (folio 7712045)", a depository's "Mutual fund folio 7712045".
  const folio = /^(.+?) account \(folio (.+)\)$/.exec(title);
  return folio ? `${folio[1]} folio ${folio[2]}` : title;
}

export type NewTracking = "HOLDINGS" | "TRANSACTIONS";

/**
 * What `accounts.create` gets: a securities account in rupees, not the default, active, with no
 * provider link. Wealthfolio requires `isDefault` and `isActive` and has no default for them.
 */
export const newAccount = (name: string, trackingMode: NewTracking) => ({
  name: name.trim(),
  accountType: "SECURITIES",
  currency: "INR",
  isDefault: false,
  isActive: true,
  trackingMode,
});
