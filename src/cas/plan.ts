import type { ActivityDetails, ActivityImport, ActivityType, AddonContext } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, div, format, isZero, neg } from "./decimal.ts";
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
  /** The type of that activity, when it's the transaction's cash under the other type: a deposit for a transfer in, say. */
  existingType?: ActivityType;
  /** The line of an earlier row of this import that this row equals. */
  repeatsLine?: number;
  /** checkImport found a duplicate. */
  flagged: boolean;
}

export interface PlannedTransaction {
  transaction: MappedTransaction;
  /** The activity, then its cash and the bank's side of it. */
  rows: PlannedRow[];
  status: Status;
}

const rowsOfTransaction = (t: MappedTransaction) => [t.activity, t.cash, t.bank].filter((row) => row !== undefined);

/**
 * The rows for checkImport and the import, in the order `planImport` reads its results. Each
 * transaction's transfers stay together, so Wealthfolio's import links each pair, not two
 * transactions' legs with the same day and amount.
 */
export const rowsOf = (mapping: Mapping) => mapping.transactions.flatMap(rowsOfTransaction);

/** An activity's date as Wealthfolio's key reads it: the UTC day. */
export function day(date: Date | string | undefined) {
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

/** A fund account's cash row as the other kind of import has it: a deposit for a transfer in, say. */
const OTHER_CASH: Partial<Record<ActivityType, ActivityType>> = {
  DEPOSIT: "TRANSFER_IN",
  TRANSFER_IN: "DEPOSIT",
  WITHDRAWAL: "TRANSFER_OUT",
  TRANSFER_OUT: "WITHDRAWAL",
};

/** The row's identity, then a cash row's identity under the other type. */
function cashIdentities(row: ActivityImport) {
  const other = row.symbol?.trim() ? undefined : OTHER_CASH[row.activityType];
  return [
    { key: rowIdentity(row), type: undefined },
    ...(other ? [{ key: rowIdentity({ ...row, activityType: other }), type: other }] : []),
  ];
}

/**
 * Asset ID → `fundRef` of the confirmed fund the asset is. Activities show an asset's display code,
 * which the user can change, so a fund chosen with an asset ID goes by that ID, and one without by
 * the symbol and exchange on each asset's profile, as `checkUnits` does.
 */
export type FundRefs = ReadonlyMap<string, string>;

/**
 * `FundRefs` for the confirmed funds. `profiles` has `fundRef` of the symbol and exchange on each
 * profile of the activities' assets. Throws when one import key resolves to several assets.
 */
export function fundRefs(funds: (FundAsset & { assetId?: string; name?: string })[], profiles: ReadonlyMap<string, string>) {
  const refs = new Map<string, string>();
  const found = new Map<string, string>();
  const add = (id: string, ref: string, fund: (typeof funds)[number]) => {
    if (found.has(ref) && found.get(ref) !== id) {
      const symbol = [fund.symbol, fund.exchangeMic].filter(Boolean).join(" on ");
      throw new Error(
        `Several Wealthfolio assets have the symbol and exchange of ${fund.name ?? symbol} (${symbol}). Under Funds, choose Change, search for ${fund.symbol} and pick the asset to import into.`,
      );
    }
    found.set(ref, id);
    refs.set(id, ref);
  };
  for (const f of funds) if (f.assetId) add(f.assetId, fundRef(f.symbol, f.exchangeMic), f);
  const byProfile = new Map(funds.filter((f) => !f.assetId).map((f) => [fundRef(f.symbol, f.exchangeMic), f]));
  for (const [id, ref] of profiles) {
    const fund = byProfile.get(ref);
    if (fund) add(id, ref, fund);
  }
  return refs;
}

/** Undefined for an activity of an asset that isn't a confirmed fund. */
function activityIdentity(a: ActivityDetails, funds: FundRefs) {
  const fund = a.assetId ? funds.get(a.assetId) : "";
  return fund === undefined ? undefined : identity(a.accountId, a.activityType, a.date, fund, a);
}

/** Wealthfolio's activities by identity. */
export function indexActivities(existing: ActivityDetails[], funds: FundRefs) {
  const index = new Map<string, string[]>();
  for (const activity of existing) {
    const key = activityIdentity(activity, funds);
    if (key === undefined) continue;
    index.set(key, [...(index.get(key) ?? []), activity.id]);
  }
  return {
    /** Whether Wealthfolio has an activity equal to this row; for a cash row, under either type. */
    has: (row: ActivityImport) => cashIdentities(row).some(({ key }) => index.has(key)),
    index,
  };
}

const messages = (record: Record<string, string[]> | undefined, skip?: string) =>
  Object.entries(record ?? {}).flatMap(([field, list]) => (field === skip ? [] : list));

/** `checked` is checkImport's answer for `rowsOf(mapping)`. */
export function planImport(
  mapping: Mapping,
  existing: ActivityDetails[],
  checked: ActivityImport[],
  funds: FundRefs,
): PlannedTransaction[] {
  const available = indexActivities(existing, funds).index;
  const seen = new Map<string, number>();
  let position = 0;
  return mapping.transactions.map((transaction) => {
    const plan = (activity: ActivityImport, settled = false): PlannedRow => {
      const result = checked[position++];
      // A fund account's cash may have come in under the other type, from a v1 import or before a
      // bank account was chosen; the bank's side never does: its deposits and withdrawals are the
      // bank's own rows.
      const keys = activity === transaction.cash ? cashIdentities(activity) : [{ key: rowIdentity(activity), type: undefined }];
      const match = settled ? undefined : keys.find(({ key }) => available.get(key)?.length);
      const row: PlannedRow = {
        activity,
        errors: messages(result?.errors),
        warnings: messages(result?.warnings, "_duplicate"),
        existingId: match && available.get(match.key)!.shift(),
        existingType: match?.type,
        repeatsLine: settled ? undefined : seen.get(keys[0].key),
        flagged: !!(result?.duplicateOfId || result?.duplicateOfLineNumber),
      };
      if (!result) row.errors.push("Wealthfolio didn't check this row.");
      else if (!result.isValid && row.errors.length === 0) row.errors.push("Wealthfolio can't import this row.");
      if (!settled && !seen.has(keys[0].key)) seen.set(keys[0].key, activity.lineNumber ?? position);
      return row;
    };
    const rows = [plan(transaction.activity)];
    if (transaction.cash) rows.push(plan(transaction.cash));
    // Wealthfolio has the transaction when it has the trade and the fund account's cash, whatever
    // the bank account shows.
    const settled = rows.every((r) => r.existingId);
    if (transaction.bank) rows.push(plan(transaction.bank, settled));
    const status: Status = rows.some((r) => r.errors.length)
      ? "invalid"
      : settled
        ? "existing"
        : rows.some((r) => r.existingId || r.repeatsLine !== undefined || r.flagged)
          ? "duplicate"
          : "new";
    return { transaction, rows, status };
  });
}

/**
 * New transactions, plus the duplicates the user chose to import anyway. All rows of a transaction
 * or none, except that a transaction whose bank row the user chose to reuse sends only its trade:
 * `linkBankRow` adds its cash afterwards.
 */
export function importRows(
  plan: PlannedTransaction[],
  importAnyway: (t: PlannedTransaction) => boolean,
  reuseBankRow: (t: PlannedTransaction) => boolean = () => false,
) {
  return plan.flatMap((t) => {
    const rows = reuseBankRow(t) ? t.rows.filter((r) => r.activity === t.transaction.activity) : t.rows;
    if (t.status === "new") return rows.map((r) => r.activity);
    if (t.status === "invalid" || !importAnyway(t)) return [];
    return rows.map((r) => ({ ...r.activity, forceImport: true }));
  });
}

/** How many days before or after a transaction the bank's side of it may be. */
export const BANK_DAYS = 7;
const PAISA = (value: string) => format(div(abs(dec(value)), dec("1"), 2));
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Rows in the bank account that may be a new transaction's bank side, already in Wealthfolio: cash
 * moving the same way, within `BANK_DAYS`, to the paisa of the transaction's cash, or of its printed
 * amount with or without its charges, whichever way the statement prints it. A bank import usually
 * records them as deposits and withdrawals. Transfers already linked can't be reused; the caller
 * finds which those are.
 */
export function bankCandidates(t: PlannedTransaction, existing: ActivityDetails[]) {
  const { bank, rows } = t.transaction;
  if (!bank || t.status === "existing" || t.status === "invalid") return [];
  const paid = bank.activityType === "TRANSFER_OUT";
  const types: string[] = paid ? ["WITHDRAWAL", "TRANSFER_OUT"] : ["DEPOSIT", "TRANSFER_IN"];
  const printed = abs(dec(rows[0].amount ?? "0"));
  const charges = rows.slice(1).reduce((total, charge) => add(total, dec(charge.amount ?? "0")), dec("0"));
  const amounts = new Set(
    [String(bank.amount), format(printed), format(paid ? add(printed, charges) : add(printed, neg(charges)))].map(PAISA),
  );
  return existing.filter(
    (a) =>
      a.accountId === bank.accountId &&
      a.status === "POSTED" &&
      types.includes(a.activityType) &&
      !a.assetSymbol?.trim() &&
      a.currency === bank.currency &&
      a.amount !== null &&
      amounts.has(PAISA(a.amount)) &&
      days(day(a.date), String(bank.date)) <= BANK_DAYS,
  );
}

/** For each new transaction, the bank row to offer reusing: closest days first, each row offered once. */
export function bankMatches(plan: PlannedTransaction[], existing: ActivityDetails[], linked: ReadonlySet<string>) {
  const options = plan.flatMap((t, index) =>
    bankCandidates(t, existing)
      .filter((a) => !linked.has(a.id))
      .map((activity) => ({ t, index, activity, apart: days(day(activity.date), String(t.transaction.bank!.date)) })),
  );
  options.sort((a, b) => a.apart - b.apart || a.index - b.index || day(a.activity.date).localeCompare(day(b.activity.date)));
  const matches = new Map<PlannedTransaction, ActivityDetails>();
  const used = new Set<string>();
  for (const { t, activity } of options) {
    if (matches.has(t) || used.has(activity.id)) continue;
    matches.set(t, activity);
    used.add(activity.id);
  }
  return matches;
}

type LinkApi = Pick<AddonContext["api"]["activities"], "create" | "update" | "linkTransfer">;

/**
 * After the import sent a transaction's trade, records its cash against the bank row the user chose
 * to reuse: adds the fund account's transfer, changes a bank deposit or withdrawal into the
 * matching transfer, and links the two. Returns what went wrong, if anything.
 */
export async function linkBankRow(activities: LinkApi, t: PlannedTransaction, bankRow: ActivityDetails) {
  const cash = t.transaction.cash!;
  const type = t.transaction.bank!.activityType;
  const when = `on ${day(bankRow.date)}`;
  let fundId: string;
  try {
    // Wealthfolio accepts this key even though ActivityCreate omits it; equal confirmed bank rows need distinct cash.
    const transfer = {
      accountId: cash.accountId,
      activityType: cash.activityType,
      activityDate: String(cash.date),
      amount: cash.amount,
      currency: cash.currency,
      idempotencyKey: `cas-importer-bank:${bankRow.id}`,
    };
    ({ id: fundId } = await activities.create(transfer));
  } catch (e) {
    return `Couldn't add the fund account's transfer: ${String(e)}. The trade is in Wealthfolio without its cash.`;
  }
  if (bankRow.activityType !== type) {
    try {
      // Fields left out keep their values.
      await activities.update({
        id: bankRow.id,
        accountId: bankRow.accountId,
        activityType: type,
        activityDate: bankRow.date,
        currency: bankRow.currency,
        comment: bankRow.comment ?? null,
      });
    } catch (e) {
      return `Added the fund account's transfer, but couldn't change the bank's row ${when} into a transfer: ${String(e)}. Change it and link the two in Wealthfolio.`;
    }
  }
  try {
    await activities.linkTransfer(bankRow.id, fundId);
  } catch (e) {
    return `Added the fund account's transfer, but couldn't link it with the bank's row ${when}: ${String(e)}. Link the two in Wealthfolio.`;
  }
  return undefined;
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
  funds: FundRefs,
  range: (day: string) => boolean,
) {
  const ref = fundRef(asset.symbol, asset.exchangeMic);
  return countUnits(activities.filter((a) => a.accountId === accountId && a.assetId && funds.get(a.assetId) === ref), range);
}

/** `unitsHeld` for activities already narrowed to one asset in one account. */
export function countUnits(activities: ActivityDetails[], range: (day: string) => boolean) {
  let units = dec("0");
  for (const a of activities) {
    if (a.status !== "POSTED" || !range(day(a.date))) continue;
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
export function openingUnits(data: CasData, target: Target, activities: ActivityDetails[], funds: FundRefs): FundUnits[] {
  const from = statementDay(data.statement_period.from);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.open)),
    held: unitsHeld(activities, f.accountId, f.asset, funds, (d) => d < from),
  }));
}

/** Closing units against what Wealthfolio holds at the statement's end. */
export function closingUnits(data: CasData, target: Target, activities: ActivityDetails[], funds: FundRefs): FundUnits[] {
  const to = statementDay(data.statement_period.to);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.close)),
    held: unitsHeld(activities, f.accountId, f.asset, funds, (d) => d <= to),
  }));
}

export const sameUnits = (f: Pick<FundUnits, "statement" | "held">) => f.held !== undefined && cmp(f.statement, f.held) === 0;
