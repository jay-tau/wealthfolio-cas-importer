import { dec, div, format } from "../cas/decimal.ts";

// How the Review screen writes dates, units, amounts and the names of exchanges, and how it reads a
// purchase cost the user types.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-31" → "31 Jul 2026"; anything else as it is. */
export function longDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/** "2026-07-31" → "31 Jul"; anything else as it is. */
export const shortDate = (iso: string) => longDate(iso).replace(/ \d{4}$/, "");

/** An integer's digits with Indian grouping: "102310" → "1,02,310". */
function indian(digits: string) {
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last}`;
}

/** A decimal string with Indian grouping and its decimals as given: "2010.400" → "2,010.400". */
export function grouped(value: string) {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (!match) return value;
  return `${match[1]}${indian(match[2])}${match[3] ?? ""}`;
}

/** Units as the statement prints them, grouped, with at least three decimals for funds: "812.3" → "812.300". */
export function units(value: string, decimals = 3) {
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  return grouped(fraction ? `${match[1]}.${fraction}` : match[1]);
}

/**
 * A rupee amount, grouped and rounded to paise, with its paise only when it has any: "102310.50" →
 * "₹1,02,310.50", "40000" → "₹40,000", an average cost's "39999.9999999999" → "₹40,000".
 */
export function rupees(value: string) {
  let rounded: string;
  try {
    rounded = format(div(dec(value.trim()), dec("1"), 2));
  } catch {
    return `₹${value}`;
  }
  const [whole, paise = ""] = rounded.split(".");
  return `₹${grouped(whole)}${paise ? `.${paise.padEnd(2, "0")}` : ""}`;
}

/**
 * A purchase cost as typed: digits with Indian (1,02,310) or Western (102,310) grouping commas or
 * none, at most two decimals, and an optional ₹, more than 0. The whole input must be such an amount:
 * "40O00" is no amount, never ₹40. Returns the amount without commas or ₹, or undefined.
 */
export function parseCost(typed: string) {
  const text = typed.trim().replace(/^₹\s*/, "");
  const match = /^(\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3}|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const whole = match[1].replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const amount = match[2] ? `${whole}.${match[2]}` : whole;
  return /[1-9]/.test(amount) ? amount : undefined;
}

/** What a cost box says when what's typed isn't an amount. */
export const COST_HINT = "Enter the total purchase cost using numbers, for example 40000.";

/** Indian stock exchanges by their MIC, as the Review screen names a share's listing. */
const EXCHANGES = new Map([
  ["XNSE", { short: "NSE", long: "National Stock Exchange (NSE)" }],
  ["XBOM", { short: "BSE", long: "Bombay Stock Exchange (BSE)" }],
]);

export const exchangeOf = (mic: string | null | undefined) => (mic ? EXCHANGES.get(mic) : undefined);
