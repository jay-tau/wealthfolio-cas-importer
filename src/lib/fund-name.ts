/**
 * The fund's name without its plan and option, for a search when the printed ISIN finds nothing:
 * the scheme name up to the first " - ", without anything in parentheses.
 * "Fictiva Flexi Cap Fund - Direct Plan - Growth" → "Fictiva Flexi Cap Fund".
 */
export const fundName = (scheme: string) =>
  scheme.replace(/\([^()]*\)/g, " ").split(" - ")[0].replace(/\s+/g, " ").trim();

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
// "IDCW-P" to "IDCWP" in a long name, and spells one fund's IDCW "ICDW".
const OPTIONS = new Map<string, FundOption>([
  ["growth", "Growth"],
  ["gr", "Growth"],
  ["idcw", "IDCW"],
  ["idcwp", "IDCW"],
  ["idcwr", "IDCW"],
  ["icdw", "IDCW"],
  ["income distribution cum capital withdrawal", "IDCW"],
  ["dividend", "IDCW"],
  ["div", "IDCW"],
]);
// Words that go with a plan or option without telling which one, like "IDCW-P", "Daily IDCW
// Reinvestment" or Yahoo's "Dir Mn IDCW-R".
const FILLERS = new Set([
  "plan", "plan a", "plan b", "option", "opt", "of", "payout", "payment", "py", "reinvestment", "re investment", "reinvest",
  "transfer", "t", "sweep", "p", "r", "ri", "bonus", "bns", "principal units", "princ", "others", "oths",
  "lock in", "loc in", "no lock in", "no loc in",
  "daily", "dl", "weekly", "wk", "wkly", "wly", "fortnightly", "fn", "fr", "ft", "fortn",
  "monthly", "mn", "mly", "mth", "mthly", "bi monthly", "bi m", "periodic", "pd", "prd", "prdic", "prdc", "quarterly", "qt", "qtly",
  "half yearly", "hy", "hf yr", "hf yrly", "annual", "annually", "ann", "an", "yearly", "yr",
  "normal", "nrm", "nor", "flexi", "fl", "standard", "std", "discretionary", "discr", "disc",
]);

const SEPARATORS = String.raw`[\s\-–—_/,:.]`;
// The name's last word, or a phrase from the lists above.
const PHRASES = [...PLANS.keys(), ...OPTIONS.keys(), ...FILLERS].filter((words) => words.includes(" "));
const WORDS = new Set([...PLANS.keys(), ...OPTIONS.keys(), ...FILLERS].flatMap((words) => words.split(" ")));
const LAST = new RegExp(
  String.raw`(?:^|${SEPARATORS}+)(${PHRASES.map((words) => words.replace(/ /g, String.raw`[\s–—-]+`)).join("|")}|[a-z]+)${SEPARATORS}*$`,
  "i",
);
// Some of Yahoo's names join words, mostly ones 40 characters long, as in "Reg MthIDCW-P",
// "toS/TDirDlIDCW-R" or "HYIDCWP": a capital letter after a small one, a capital before a small one
// after another capital, and IDCW start a word.
const WORD_START = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]|IDCW)/g;
// The name's last part in parentheses.
const LAST_GROUP = new RegExp(String.raw`\(([^()]*)\)${SEPARATORS}*$`);

/** Reads the plan and option from the end of `text`, and what's left before them. */
function readEnd(text: string, inGroup = false): PlanAndOption & { rest: string } {
  const found: PlanAndOption = {};
  let rest = text;
  // The fund's own name can have these words in it ("Growth Fund", "Regular Savings Fund"), so outside
  // parentheses stop at the first unknown word or once both fields are found.
  while (inGroup || !(found.plan && found.option)) {
    const group = LAST_GROUP.exec(rest);
    if (group) {
      // A part in parentheses counts when it holds nothing else, like "(Direct Plan)"; another, like
      // "(Non-Demat)", is skipped.
      const inside = readEnd(group[1], true);
      if (!inside.rest.trim()) {
        found.plan ??= inside.plan;
        found.option ??= inside.option;
      }
      rest = rest.slice(0, group.index);
      continue;
    }
    const last = LAST.exec(rest);
    if (!last) break;
    const word = last[1].toLowerCase().replace(/[\s–—-]+/g, " ");
    // Read from the end, the last plan or option given wins.
    if (PLANS.has(word)) found.plan ??= PLANS.get(word);
    else if (OPTIONS.has(word)) found.option ??= OPTIONS.get(word);
    // "(G)" is Growth in compact depository names; a bare Plan G can name an FMP.
    else if (inGroup && word === "g") found.option ??= "Growth";
    else if (!FILLERS.has(word)) break;
    rest = rest.slice(0, last.index);
  }
  return { ...found, rest };
}

/**
 * The plan (Direct or Regular) and option (Growth or IDCW) at the end of a fund's name, in any of
 * the usual spellings: "- Direct Plan - Growth", "DIRECT PLAN GROWTH", "Dir Gr", "- Growth - Direct
 * Plan", "(Direct Plan) (Growth)", "- Regular Plan - Income Distribution cum Capital Withdrawal
 * Option - Reinvestment", Yahoo's "Reg Wk IDCW-R" and "RegMnIDCW-P". A field the name doesn't give is
 * left out, never guessed.
 */
export function planAndOption(name: string): PlanAndOption {
  // Keep recognized words case-insensitive, including the words of a phrase ("PLan A").
  const spaced = name.replace(/[a-z]+/gi, (word) => WORDS.has(word.toLowerCase()) ? word : word.replace(WORD_START, " "));
  const { plan, option } = readEnd(spaced);
  return { ...(plan && { plan }), ...(option && { option }) };
}
