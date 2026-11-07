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

const PLANS = new Map<string, Plan>([["direct", "Direct"], ["dir", "Direct"], ["regular", "Regular"], ["reg", "Regular"]]);
// IDCW was called Dividend before April 2021, and older names still say so.
const OPTIONS = new Map<string, FundOption>([
  ["growth", "Growth"],
  ["gr", "Growth"],
  ["idcw", "IDCW"],
  ["income distribution cum capital withdrawal", "IDCW"],
  ["dividend", "IDCW"],
  ["div", "IDCW"],
]);
// Words that go with a plan or option without telling which one, like "IDCW-P" or "Daily IDCW Reinvestment".
const FILLERS = new Set([
  "plan", "plan a", "plan b", "option", "opt", "of", "payout", "payment", "reinvestment", "re investment", "reinvest", "transfer", "sweep", "p", "r", "ri", "bonus",
  "daily", "weekly", "fortnightly", "monthly", "bi monthly", "periodic", "quarterly", "half yearly", "annual", "yearly",
]);

const SEPARATORS = String.raw`[\s\-–—_/,:.]`;
// The name's last word, or a phrase from the lists above.
const LAST = new RegExp(
  String.raw`(?:^|${SEPARATORS}+)(income\s+distribution\s+cum\s+capital\s+withdrawal|half[\s–—-]+yearly|bi[\s–—-]+monthly|plan[\s–—-]+[ab]|re[\s–—-]*investment|[a-z]+)${SEPARATORS}*$`,
  "i",
);
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
 * Option - Reinvestment". A field the name doesn't give is left out, never guessed.
 */
export function planAndOption(name: string): PlanAndOption {
  const { plan, option } = readEnd(name);
  return { ...(plan && { plan }), ...(option && { option }) };
}
