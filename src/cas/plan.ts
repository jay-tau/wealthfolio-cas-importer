import type { ActivityDetails, ActivityImport } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, format, isZero, neg } from "./decimal.ts";
import type { FundAsset, MappedTransaction, Mapping } from "./mapping.ts";
import type { CasData, CasFolio, CasScheme } from "./types.ts";

// Which mapped transactions the import sends. Wealthfolio's checkImport doesn't report a
// trade that an earlier import already saved when that import created the fund: the import
// keyed the trade by symbol and exchange, and once the asset exists checkImport keys it by
// the asset's ID (Wealthfolio 3.11.0). Wealthfolio's CSV import creates assets first; add-ons
// can't. So each row is compared with the account's activities on the import key's fields.

export type Status =
  /** Every row is new. */
  | "new"
  /** Wealthfolio has every row. */
  | "existing"
  /** Some row equals an activity Wealthfolio has or another row of this import. */
  | "duplicate"
  /** checkImport rejected a row. */
  | "invalid";

export interface PlannedRow {
  activity: ActivityImport;
  /** checkImport's messages, duplicates aside. */
  errors: string[];
  warnings: string[];
  /** The Wealthfolio activity this row equals. Each one is matched to one row at most. */
  existingId?: string;
  /** The line of an earlier row of this import that this row equals. */
  repeatsLine?: number;
  /** checkImport found a duplicate. */
  flagged: boolean;
}

export interface PlannedTransaction {
  transaction: MappedTransaction;
  /** The activity, then its cash. */
  rows: PlannedRow[];
  status: Status;
}

/** The rows for checkImport, in the order `planImport` reads its results. */
export const rowsOf = (mapping: Mapping) =>
  mapping.transactions.flatMap((t) => (t.cash ? [t.activity, t.cash] : [t.activity]));

/** An activity's date as Wealthfolio's key reads it: the UTC day. */
function day(date: Date | string | undefined) {
  if (date === undefined) return "";
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(date).toISOString().slice(0, 10);
}

/** Wealthfolio leaves a zero fee out of the key; a zero quantity or price is treated the same. */
function amount(value: string | number | null | undefined, zeroIsNone = false) {
  if (value === null || value === undefined || value === "") return "";
  const d = abs(dec(String(value)));
  return zeroIsNone && isZero(d) ? "" : format(d);
}

export const fundRef = (symbol: string, exchangeMic?: string | null) =>
  `${symbol.trim().toUpperCase()}@${exchangeMic ?? ""}`;

function identity(
  accountId: string,
  type: string,
  date: Date | string | undefined,
  fund: string,
  row: Pick<ActivityImport, "quantity" | "unitPrice" | "amount" | "fee" | "currency" | "comment">,
) {
  return [
    accountId,
    type,
    day(date),
    fund,
    amount(row.quantity, true),
    amount(row.unitPrice, true),
    amount(row.amount),
    amount(row.fee, true),
    row.currency ?? "",
    (row.comment ?? "").split(/\s+/).filter(Boolean).join(" "),
  ].join("|");
}

const rowIdentity = (row: ActivityImport) =>
  identity(row.accountId, row.activityType, row.date, row.symbol?.trim() ? fundRef(row.symbol, row.exchangeMic) : "", row);

const activityIdentity = (a: ActivityDetails) =>
  identity(a.accountId, a.activityType, a.date, a.assetSymbol?.trim() ? fundRef(a.assetSymbol, a.exchangeMic) : "", a);

/** Wealthfolio's activities by identity. */
export function indexActivities(existing: ActivityDetails[]) {
  const index = new Map<string, string[]>();
  for (const activity of existing) {
    const key = activityIdentity(activity);
    index.set(key, [...(index.get(key) ?? []), activity.id]);
  }
  return {
    /** Whether Wealthfolio has an activity equal to this row. */
    has: (row: ActivityImport) => index.has(rowIdentity(row)),
    index,
  };
}

const messages = (record: Record<string, string[]> | undefined, skip?: string) =>
  Object.entries(record ?? {}).flatMap(([field, list]) => (field === skip ? [] : list));

/** `checked` is checkImport's answer for `rowsOf(mapping)`. */
export function planImport(mapping: Mapping, existing: ActivityDetails[], checked: ActivityImport[]): PlannedTransaction[] {
  const available = indexActivities(existing).index;
  const seen = new Map<string, number>();
  let position = 0;
  return mapping.transactions.map((transaction) => {
    const rows = [transaction.activity, transaction.cash].flatMap((activity): PlannedRow[] => {
      if (!activity) return [];
      const result = checked[position++];
      const key = rowIdentity(activity);
      const row: PlannedRow = {
        activity,
        errors: messages(result?.errors),
        warnings: messages(result?.warnings, "_duplicate"),
        existingId: available.get(key)?.shift(),
        repeatsLine: seen.get(key),
        flagged: !!(result?.duplicateOfId || result?.duplicateOfLineNumber),
      };
      if (!result) row.errors.push("Wealthfolio didn't check this row.");
      else if (!result.isValid && row.errors.length === 0) row.errors.push("Wealthfolio can't import this row.");
      if (!seen.has(key)) seen.set(key, activity.lineNumber ?? position);
      return [row];
    });
    const status: Status = rows.some((r) => r.errors.length)
      ? "invalid"
      : rows.every((r) => r.existingId)
        ? "existing"
        : rows.some((r) => r.existingId || r.repeatsLine !== undefined || r.flagged)
          ? "duplicate"
          : "new";
    return { transaction, rows, status };
  });
}

/** New transactions, plus the duplicates the user chose to import anyway. Both rows of a transaction or neither. */
export function importRows(plan: PlannedTransaction[], importAnyway: (t: PlannedTransaction) => boolean) {
  return plan.flatMap((t) => {
    if (t.status === "new") return t.rows.map((r) => r.activity);
    if (t.status === "invalid" || !importAnyway(t)) return [];
    return t.rows.map((r) => ({ ...r.activity, forceImport: true }));
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** casparser's statement dates, `01-Apr-2023` (or `01-04-2023` and `01/04/2023` from NSDL/CDSL), as `2023-04-01`. */
export function statementDay(date: string) {
  const match = /^(\d{2})[-/]([A-Za-z]{3}|\d{2})[-/](\d{4})$/.exec(date);
  const month =
    match &&
    (/^\d+$/.test(match[2])
      ? Number(match[2]) - 1
      : MONTHS.indexOf(match[2][0].toUpperCase() + match[2].slice(1).toLowerCase()));
  if (!match || month === null || month < 0 || month > 11) throw new Error(`Not a statement date: ${date}`);
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}`;
}

/** Posted units within `range`, or unknown when the history needs Wealthfolio's portfolio engine. */
export function unitsHeld(
  activities: ActivityDetails[],
  accountId: string,
  asset: Pick<FundAsset, "symbol" | "exchangeMic">,
  range: (day: string) => boolean,
) {
  const ref = fundRef(asset.symbol, asset.exchangeMic);
  let units = dec("0");
  for (const a of activities) {
    if (a.status !== "POSTED" || a.accountId !== accountId || !a.assetSymbol || fundRef(a.assetSymbol, a.exchangeMic) !== ref) continue;
    if (!range(day(a.date))) continue;
    if (a.activityType === "SPLIT" || (a.activityType === "ADJUSTMENT" && a.subtype === "OPTION_EXPIRY")) return undefined;
    if (!a.quantity) continue;
    const q = abs(dec(a.quantity));
    const type = a.activityType as string;
    if (
      type === "BUY" || type === "TRANSFER_IN" ||
      (type === "DIVIDEND" && (a.subtype === "DRIP" || a.subtype === "DIVIDEND_IN_KIND")) ||
      (type === "INTEREST" && a.subtype === "STAKING_REWARD")
    ) units = add(units, q);
    else if (type === "SELL" || type === "TRANSFER_OUT") units = add(units, neg(q));
  }
  return units;
}

export interface FundUnits {
  accountId: string;
  asset: FundAsset;
  schemes: CasScheme[];
  /** The statement's units, summed over the folios that hold the fund in this account. */
  statement: Dec;
  /** Wealthfolio's, when the account's activity history is sufficient to count them. */
  held: Dec | undefined;
}

type Target = (folio: CasFolio, scheme: CasScheme) => { accountId: string; asset: FundAsset } | undefined;

function byFund(data: CasData, target: Target) {
  const funds = new Map<string, { accountId: string; asset: FundAsset; schemes: CasScheme[] }>();
  for (const folio of data.folios) {
    for (const scheme of folio.schemes) {
      const t = target(folio, scheme);
      if (!t) continue;
      const key = `${t.accountId}|${fundRef(t.asset.symbol, t.asset.exchangeMic)}`;
      const fund = funds.get(key) ?? { ...t, schemes: [] };
      fund.schemes.push(scheme);
      funds.set(key, fund);
    }
  }
  return [...funds.values()];
}

const sum = (values: string[]) => values.reduce((total, v) => add(total, dec(v)), dec("0"));

/** Opening units against what Wealthfolio holds before the statement starts. */
export function openingUnits(data: CasData, target: Target, activities: ActivityDetails[]): FundUnits[] {
  const from = statementDay(data.statement_period.from);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.open)),
    held: unitsHeld(activities, f.accountId, f.asset, (d) => d < from),
  }));
}

/** Closing units against what Wealthfolio holds at the statement's end. */
export function closingUnits(data: CasData, target: Target, activities: ActivityDetails[]): FundUnits[] {
  const to = statementDay(data.statement_period.to);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.close)),
    held: unitsHeld(activities, f.accountId, f.asset, (d) => d <= to),
  }));
}

export const sameUnits = (f: FundUnits) => f.held !== undefined && cmp(f.statement, f.held) === 0;
