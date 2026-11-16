import type { Account } from "@wealthfolio/addon-sdk";
import { fold } from "./new-accounts.ts";

/** What a label needs of an account. */
export type Labelled = Pick<Account, "id" | "name" | "currency"> & Partial<Pick<Account, "group" | "accountNumber" | "trackingMode" | "isActive" | "isArchived">>;

/**
 * Where Settings → Accounts lists an account, from Wealthfolio's order: the active ones, then the
 * hidden ones, then the archived ones.
 */
const section = (a: Labelled) => (a.isArchived ? 2 : a.isActive === false ? 1 : 0);

/** How the Review screen shows an account. */
export interface AccountLabel {
  /** In its lines and names: the name, and what tells it apart from another account of the same name. */
  text: string;
  /** In an account select: `text` with the currency, or for an account another one shares its name with, its other details too. */
  option: string;
  /** Numbered by its place among the accounts of its name in Settings → Accounts: "Funds (account 2)". */
  numbered?: boolean;
}


/** The last four characters of an account number, spaces ignored, as Wealthfolio shows them after "··". */
export function numberEnd(accountNumber?: string | null) {
  const compact = accountNumber?.replace(/\s+/g, "") ?? "";
  return compact ? compact.slice(-4) : undefined;
}

const TRACKING: Record<string, string> = { HOLDINGS: "tracks holdings", TRANSACTIONS: "tracks transactions", NOT_SET: "tracking not set up" };

/** What Wealthfolio shows beside an account's name, in its order, and how a label says each. */
const DETAILS: { of: (a: Labelled) => string | undefined; says: (value: string) => string }[] = [
  { of: (a) => numberEnd(a.accountNumber), says: (end) => `ending ${end}` },
  { of: (a) => a.currency?.trim() || undefined, says: (currency) => currency },
  { of: (a) => a.group?.trim() || undefined, says: (group) => `${group} group` },
  // A select lists accounts of one kind, so it doesn't say this.
  { of: (a) => (a.trackingMode ? TRACKING[a.trackingMode] : undefined), says: (mode) => mode },
];
// The order an option lists the details in: Wealthfolio's, currency first.
const OPTION_ORDER = [1, 2, 0];

/** Each set of details, fewest first, then in Wealthfolio's order. */
const SETS = Array.from({ length: (1 << DETAILS.length) - 1 }, (_, i) => i + 1)
  .map((bits) => DETAILS.map((_, d) => d).filter((d) => bits & (1 << d)))
  .sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));

/**
 * Each account's label, by ID, from all of Wealthfolio's accounts in its order (hidden and archived
 * ones included, as its Settings lists them). An account no other one shares its name with is its
 * name. One that shares it is told apart, in brackets, by what Wealthfolio shows beside it: the end of
 * its account number ("Funds (ending 4821)"), its currency ("Funds (USD)"), its group ("Funds (Family
 * group)") or what it tracks ("Funds (tracks transactions)"), the fewest that no other account of the
 * name has, in that order. With none, it's numbered by its place among them in Settings → Accounts
 * ("Funds (account 2)"). No two labels read the same, nor a label and another account's name.
 */
export function accountLabels(accounts: readonly Labelled[]): Map<string, AccountLabel> {
  const byName = new Map<string, Labelled[]>();
  for (const account of accounts) byName.set(fold(account.name), [...(byName.get(fold(account.name)) ?? []), account]);
  // Numbered as Settings → Accounts lists them.
  for (const same of byName.values()) same.sort((a, b) => section(a) - section(b));
  // Every real name is reserved, even when it too needs a label.
  const taken = new Set(byName.keys());
  const labels = new Map<string, AccountLabel>();
  for (const account of accounts) {
    const name = account.name.trim();
    const same = byName.get(fold(account.name))!;
    if (same.length === 1) {
      labels.set(account.id, { text: name, option: `${name} (${account.currency})` });
      continue;
    }
    const values = (a: Labelled) => DETAILS.map((d) => d.of(a));
    const mine = values(account);
    const others = same.filter((a) => a !== account).map(values);
    const free = (text: string) => !taken.has(fold(text));
    // The fewest details it has that no other account of the name has all of.
    const set = SETS.find((set) => set.every((d) => mine[d]) && others.every((theirs) => set.some((d) => theirs[d] !== mine[d])) &&
      free(`${name} (${set.map((d) => DETAILS[d].says(mine[d]!)).join(", ")})`));
    const k = same.indexOf(account) + 1;
    let text = set
      ? `${name} (${set.map((d) => DETAILS[d].says(mine[d]!)).join(", ")})`
      : [`${name} (account ${k})`, `${name} (account ${k} of ${same.length})`].find(free) ?? `${name} (account ${k} of ${same.length})`;
    // Literal names can occupy both numbered forms; keep the order and total truthful.
    while (!free(text)) text += ` (account ${k} of ${same.length})`;
    taken.add(fold(text));
    const rest = OPTION_ORDER.filter((d) => mine[d] && !set?.includes(d)).map((d) => DETAILS[d].says(mine[d]!));
    labels.set(account.id, { text, option: [text, ...rest].join(" · "), ...(!set && { numbered: true }) });
  }
  return labels;
}
