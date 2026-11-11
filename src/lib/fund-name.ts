const SEGREGATED = /\bsegregated\s+portfolio(?:[\s-]*(?:\d+|[IVX]+\b))?/i;

/**
 * The fund's name without its plan and option, for a search when the printed ISIN finds nothing:
 * the scheme name up to the first " - ", without anything in parentheses.
 * "Fictiva Flexi Cap Fund - Direct Plan - Growth" → "Fictiva Flexi Cap Fund". A segregated
 * portfolio keeps "Segregated Portfolio" and its number, or the search finds its main fund.
 */
export function fundName(scheme: string) {
  const name = scheme.replace(/\([^()]*\)/g, " ");
  const first = name.split(" - ")[0];
  const segregated = SEGREGATED.exec(scheme)?.[0];
  const search = segregated && SEGREGATED.test(first)
    ? first.replace(SEGREGATED, segregated)
    : [first, segregated].filter(Boolean).join(" ");
  return search.replace(/\s+/g, " ").trim();
}

export type Plan = "Direct" | "Regular";
export type FundOption = "Growth" | "IDCW";

/** A fund's plan and option as its name gives them. A field the name doesn't give is left out. */
export interface PlanAndOption {
  plan?: Plan;
  option?: FundOption;
}

// Each word or phrase in lower case, with Yahoo's abbreviations, as in "Rg Gr" or "Ann Dr IDCW-P".
const PLANS = new Map<string, Plan>([
  ["direct", "Direct"],
  ["dir", "Direct"],
  ["dr", "Direct"],
  ["regular", "Regular"],
  ["reg", "Regular"],
  ["rg", "Regular"],
]);
// IDCW was called Dividend before April 2021, and older names still say so. Yahoo shortens
// "IDCW-P" to "IDCWP" in a long name, and spells one fund's IDCW "ICDW". ICICI Prudential calls
// some funds' Growth option Cumulative.
const OPTIONS = new Map<string, FundOption>([
  ["growth", "Growth"],
  ["gr", "Growth"],
  ["cumulative", "Growth"],
  ["idcw", "IDCW"],
  ["idcwp", "IDCW"],
  ["idcwr", "IDCW"],
  ["icdw", "IDCW"],
  ["income distribution cum capital withdrawal", "IDCW"],
  ["dividend", "IDCW"],
  ["div", "IDCW"],
]);
// Words that go with a plan or option without telling which one, like "IDCW-P", "Daily IDCW
// Reinvestment", "Discontinued Flexi IDCW" or Yahoo's "Dir Mn IDCW-R".
const FILLERS = new Set([
  "plan", "plan a", "plan b", "option", "opt", "of", "payout", "payment", "py", "reinvestment", "re investment", "reinvest",
  "transfer", "t", "sweep", "p", "r", "ri", "bonus", "bns", "principal units", "princ", "others", "oths",
  "lock in", "loc in", "no lock in", "no loc in", "discontinued", "defunct", "adhoc", "donation",
  "daily", "dl", "weekly", "wk", "wkly", "wly", "fortnightly", "fn", "fr", "ft", "fortn",
  "monthly", "mn", "mly", "mth", "mthly", "bi monthly", "bi m", "periodic", "pd", "prd", "prdic", "prdc", "quarterly", "qt", "qtly",
  "half yearly", "semi annual", "hy", "hf yr", "hf yrly", "annual", "annually", "ann", "an", "yearly", "yr",
  "normal", "nrm", "nor", "flexi", "fl", "standard", "std", "discretionary", "discr", "disc",
]);
// Fillers read by pattern: an option that pays out and reinvests, as in "IDCW - Payout &
// Re-investment" or "Reinvestment and Payout", and a donation option's share, as in "50% IDCW
// Donation Option". "and" and "&" are read nowhere else, since a fund's own name can have them.
const REINVEST = String.raw`re[\s–—-]*invest(?:ment)?`;
const AND = String.raw`(?:[\s–—-]+and[\s–—-]+|[\s–—-]*&[\s–—-]*)`;
const OTHER_FILLERS = String.raw`payout${AND}${REINVEST}|${REINVEST}${AND}payout|\d+%`;
const OTHER_FILLER = new RegExp(String.raw`^(?:${OTHER_FILLERS})$`, "i");

const SEPARATORS = String.raw`[\s\-–—_/,:.]`;
// The name's last word, or a phrase from the lists above.
const PHRASES = [...PLANS.keys(), ...OPTIONS.keys(), ...FILLERS].filter((words) => words.includes(" "));
// Keep pattern-only words whole too, without reading them as standalone fillers.
const WORDS = new Set([...PLANS.keys(), ...OPTIONS.keys(), ...FILLERS, "and", "invest"].flatMap((words) => words.split(" ")));
const LAST = new RegExp(
  String.raw`(?:^|${SEPARATORS}+)(${OTHER_FILLERS}|${PHRASES.map((words) => words.replace(/ /g, String.raw`[\s–—-]+`)).join("|")}|[a-z]+)${SEPARATORS}*$`,
  "i",
);
// Some of Yahoo's names join words, mostly ones 40 characters long, as in "Reg MthIDCW-P",
// "toS/TDirDlIDCW-R" or "HYIDCWP": a capital letter after a small one, a capital before a small one
// after another capital, and IDCW start a word.
const WORD_START = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]|IDCW)/g;
// The name's last part in parentheses.
const LAST_GROUP = new RegExp(String.raw`\(([^()]*)\)${SEPARATORS}*$`);

/** Reads the plan and option from the end of `text`, what's left, and how many known entries it read. */
function readEnd(text: string, inGroup = false): PlanAndOption & { rest: string; count: number } {
  const found: PlanAndOption = {};
  let rest = text;
  let count = 0;
  // The plan found is a bare word before the option, so it can belong to the option.
  let beforeOption = false;
  // The word after the one read, in the name's order.
  let next = "";
  // The fund's own name can have these words in it ("Growth Fund", "Regular Savings Fund"), so outside
  // parentheses stop at the first unknown word, or once both fields are found and the plan can't
  // belong to the option.
  while (inGroup || !(found.plan && found.option) || beforeOption) {
    const group = LAST_GROUP.exec(rest);
    if (group) {
      // A part in parentheses counts when it holds nothing else, like "(Direct Plan)"; another, like
      // "(Non-Demat)", is skipped.
      const inside = readEnd(group[1], true);
      rest = rest.slice(0, group.index);
      if (!inside.rest.trim()) {
        // Read recognized group words in context; only inside parentheses does "G" mean Growth.
        rest += ` ${group[1].replace(/(?<![a-z])g(?![a-z])/gi, "Growth")}`;
      } else next = "";
      continue;
    }
    const last = LAST.exec(rest);
    if (!last) break;
    const word = last[1].toLowerCase().replace(/[\s–—-]+/g, " ");
    if (PLANS.has(word)) {
      // Read from the end, the last plan given wins, except that a bare plan word before the option
      // can be part of the option's name, like Axis's "Regular" in "Direct Plan - Regular IDCW Option":
      // a plan followed by "Plan" before it wins.
      const named = /^plan\b/.test(next);
      if (!found.plan || (beforeOption && named)) {
        found.plan = PLANS.get(word);
        beforeOption = !named && !!found.option;
      }
    } else if (OPTIONS.has(word) || (inGroup && word === "g")) {
      // An earlier option ends the look past a bare plan word: don't reach into "Regular Plan Growth
      // Dir IDCW".
      if (!inGroup && found.plan && found.option) break;
      found.option ??= OPTIONS.get(word) ?? "Growth";
    } else if (!FILLERS.has(word) && !OTHER_FILLER.test(word)) break;
    count++;
    next = word;
    rest = rest.slice(0, last.index);
  }
  return { ...found, rest, count };
}

/**
 * Whether a fund's printed name is about as long as a CDSL demat account's long name cut short, which
 * can end partway through a word: a real one ended "- DIRECT GROW" at 101 characters, as casparser
 * joins its lines. casparser adds a space where it joins a word wrapped over two lines, so a few
 * more characters count too.
 */
export function mayBeCut(printed: string) {
  const { length } = printed.replace(/\s+/g, " ").trim();
  return length >= 100 && length <= 105;
}

// What each plan, option and filler word or phrase reads as, to complete a cut one.
const READINGS = new Map<string, Plan | FundOption | "filler">([
  ...PLANS, ...OPTIONS, ...[...FILLERS].map((words) => [words, "filler"] as const),
]);
const PHRASE_GAP = new RegExp(String.raw`^[\s–—-]+$`);
const NAME_END = new RegExp(String.raw`^${SEPARATORS}*$`);

/**
 * `text` with its last word completed, when it ends partway through a plan, option or filler word or
 * phrase, and every one it could be reads the same: "- DIRECT GROW" → "- DIRECT growth", "- INCOME
 * DISTRIBUTION CUM CAP" → "- income distribution cum capital withdrawal". A phrase counts from its
 * second word on, and outruns a word that its last word starts: "INCOME DISTRIBUTION CUM" isn't
 * Cumulative. Undefined for a whole entry, or words that could read differently ("- D" or "- DI":
 * Direct, Dividend or Daily; "- RE": Regular or Reinvestment). A single letter outside a phrase
 * starts too many words of a fund's own name, like Gilt or Institutional, so it isn't completed.
 */
function completeCut(text: string) {
  const words = [...text.matchAll(/[a-z]+/gi)];
  const last = words.at(-1);
  const partial = last?.[0].toLowerCase();
  if (!last || !partial || READINGS.has(partial) || !NAME_END.test(text.slice(last.index + last[0].length))) return undefined;
  let longest = 0;
  const found = new Map<string, { entry: string; start: number }>();
  for (const [entry, reading] of READINGS) {
    const parts = entry.split(" ");
    for (let k = Math.min(parts.length, 2); k <= parts.length && k <= words.length; k++) {
      const tail = words.slice(-k);
      const whole = tail.slice(0, -1).every((word, i) =>
        word[0].toLowerCase() === parts[i] && PHRASE_GAP.test(text.slice(word.index + word[0].length, tail[i + 1].index)));
      const proper = parts[k - 1].startsWith(partial) && (k < parts.length || parts[k - 1] !== partial);
      if (!whole || !proper || (k === 1 && partial.length < 2) || k < longest) continue;
      if (k > longest) found.clear();
      longest = k;
      found.set(reading, { entry, start: tail[0].index });
    }
  }
  if (found.size !== 1) return undefined;
  const [{ entry, start }] = found.values();
  let completed = text.slice(0, start) + entry;
  // A cut inside parentheses loses the closing parenthesis too.
  if (completed.lastIndexOf("(") > completed.lastIndexOf(")")) completed += ")";
  return { text: completed, start };
}

const TRAILING_SEPARATORS = new RegExp(`${SEPARATORS}+$`);

/**
 * The plan (Direct or Regular) and option (Growth or IDCW) at the end of a fund's name, in any of
 * the usual spellings: "- Direct Plan - Growth", "DIRECT PLAN GROWTH", "Dir Gr", "- Growth - Direct
 * Plan", "(Direct Plan) (Growth)", "- Regular Plan - Income Distribution cum Capital Withdrawal
 * Option - Reinvestment", Yahoo's "Reg Wk IDCW-R" and "RegMnIDCW-P". A field the name doesn't give is
 * left out, never guessed. A name that `cut` says may be cut short also reads a last word cut partway
 * through, as in "- DIRECT GROW", when it can only be one plan, option or filler word or phrase.
 */
export function planAndOption(name: string, cut = false): PlanAndOption {
  // Keep recognized words case-insensitive, including the words of a phrase ("PLan A").
  const spaced = name.replace(/[a-z]+/gi, (word) => WORDS.has(word.toLowerCase()) ? word : word.replace(WORD_START, " "));
  const completed = cut ? completeCut(spaced) : undefined;
  let read = readEnd(completed?.text ?? spaced);
  if (completed) {
    // A completed word counts in the plan and option's part of the name: where the reading goes on
    // past it, or after a dash. "# FICTIVA REGU", cut from a fund called Fictiva Regular Savings, doesn't.
    const before = spaced.slice(0, completed.start);
    const stem = before.replace(TRAILING_SEPARATORS, "");
    if (read.count < 2 && !/[–—-]/.test(before.slice(stem.length))) read = readEnd(spaced);
  }
  const { plan, option } = read;
  return { ...(plan && { plan }), ...(option && { option }) };
}
