/**
 * The fund's name without its plan and option, for a search when the printed ISIN finds nothing:
 * the scheme name up to the first " - ", without anything in parentheses.
 * "Fictiva Flexi Cap Fund - Direct Plan - Growth" → "Fictiva Flexi Cap Fund".
 */
export const fundName = (scheme: string) =>
  scheme.replace(/\([^()]*\)/g, " ").split(" - ")[0].replace(/\s+/g, " ").trim();
