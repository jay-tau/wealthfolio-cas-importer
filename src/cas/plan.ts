import type { ActivityDetails, ActivityImport, ActivityType, AddonContext } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, div, format, isZero, neg } from "./decimal.ts";
import type { FundAsset, MappedTransaction, Mapping } from "./mapping.ts";
import type { CasData, CasFolio, CasScheme } from "./types.ts";

// Which mapped transactions the import sends. Each row carries its statement row's ID (#5) and
// matches the activity the add-on imported with that ID into its account, whatever its values, as
// Wealthfolio 3.13.0's import does. Otherwise it's compared with the account's activities that have
// no ID from the add-on, on the import key's fields: imports from before the IDs, and activities
// entered by hand. Each activity matches one row at most. Wealthfolio's checkImport can't count
// copies among those: a duplicate row imported with "Import anyway" is stored without a duplicate
// key and isn't found by later checks. Wealthfolio before 3.13.0 drops the IDs, so there two rows
// with equal values are duplicates too. Before Wealthfolio 3.12.0,
// checkImport also missed a trade that an earlier import saved when that import created the
// fund: the import keyed the trade by symbol and exchange, and checkImport keyed it by the
// asset's ID. A merger's conversion rows also go by their direction and group, as Wealthfolio
// 3.12.0's import key does.

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
  /** The activity, then its cash and the bank's side of it, or a merger's two conversion rows. */
  rows: PlannedRow[];
  status: Status;
  /** Earlier merger rows found in Wealthfolio, including uncertain matches when price or amount is missing. */
  earlier?: PlannedRow[];
  /** Why the transaction can't be imported, besides its rows' errors. */
  problem?: string;
}

const rowsOfTransaction = (t: MappedTransaction) =>
  [t.activity, t.cash, t.bank, t.arriving?.activity, t.receiving?.activity].filter((row) => row !== undefined);

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

const dayFormats = new Map<string, Intl.DateTimeFormat>();
function dayFormat(timeZone: string) {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timeZone, format);
  }
  return format;
}

/**
 * Wealthfolio's timezone setting as its portfolio engine reads it: UTC when it's missing or invalid
 * (Wealthfolio 3.11.0). Wealthfolio saves only timezone names it knows.
 */
export async function engineTimeZone(settings: Pick<AddonContext["api"]["settings"], "get">) {
  const { timezone } = await settings.get();
  if (!timezone) return "UTC";
  try {
    dayFormat(timezone);
    return timezone;
  } catch {
    // Not a timezone this browser knows.
    return "UTC";
  }
}

/**
 * An activity's date as Wealthfolio's portfolio engine counts it: its day in `timeZone`, from
 * `engineTimeZone`. Its form saves an activity at the time of day entered, so the UTC day can be
 * another; a bare date is stored on that day in UTC and in the timezone, so it stays as given.
 */
export function localDay(date: Date | string | undefined, timeZone: string) {
  if (date === undefined) return "";
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parts = Object.fromEntries(dayFormat(timeZone).formatToParts(new Date(date)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Wealthfolio leaves a zero fee out of the key; a zero quantity or price is treated the same. */
function amount(value: string | number | null | undefined, zeroIsNone = false) {
  if (value === null || value === undefined || value === "") return "";
  const d = abs(dec(String(value)));
  return zeroIsNone && isZero(d) ? "" : format(d);
}

export const fundRef = (symbol: string, exchangeMic?: string | null) =>
  `${symbol.trim().toUpperCase()}@${exchangeMic ?? ""}`;

/** A fund conversion's side, from a subtype in any spelling Wealthfolio accepts. */
export function conversionSide(subtype: string | null | undefined) {
  const canonical = subtype?.trim().replace(/[ -]/g, "_").toUpperCase();
  return canonical === "CONVERSION_OUT" || canonical === "CONVERSION_IN" ? canonical : undefined;
}

/** The type Wealthfolio's import key hashes: a conversion row's with its side and group, as two can otherwise be equal. */
function keyType(type: string, subtype: string | null | undefined, group: string | null | undefined) {
  const side = conversionSide(subtype);
  return side ? `${type}/${side}/${group?.trim() ?? ""}` : type;
}

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
  identity(
    row.accountId,
    keyType(row.activityType, row.subtype, row.sourceGroupId),
    row.date,
    row.symbol?.trim() ? fundRef(row.symbol, row.exchangeMic) : "",
    row,
  );

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

/** Wealthfolio 3.12.0 returns an activity's group, though the SDK's ActivityDetails doesn't declare it. */
const groupOf = (a: ActivityDetails) => (a as ActivityDetails & { sourceGroupId?: string | null }).sourceGroupId?.trim() || undefined;

/** Undefined for an activity of an asset that isn't a confirmed fund. */
function activityIdentity(a: ActivityDetails, funds: FundRefs) {
  const fund = a.assetId ? funds.get(a.assetId) : "";
  return fund === undefined ? undefined : identity(a.accountId, keyType(a.activityType, a.subtype, groupOf(a)), a.date, fund, a);
}

/** Wealthfolio stores an add-on's row IDs behind `addon:<the manifest's id>:`. */
export const RECORD_PREFIX = "addon:cas-importer:";

/** The row ID the add-on imported an activity with, if any. */
const recordOf = (a: ActivityDetails) =>
  a.sourceRecordId?.startsWith(RECORD_PREFIX) ? a.sourceRecordId.slice(RECORD_PREFIX.length) : undefined;

const recordKey = (accountId: string, id: string) => `${accountId}|${id}`;

/**
 * Wealthfolio's activities: those the add-on imported with row IDs by account and ID in `records`,
 * and the others by identity in `index`. A row with an ID matches the first only by its ID.
 */
export function indexActivities(existing: ActivityDetails[], funds: FundRefs) {
  const index = new Map<string, string[]>();
  const records = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  for (const activity of existing) {
    const record = recordOf(activity);
    if (record) {
      add(records, recordKey(activity.accountId, record), activity.id);
      continue;
    }
    const key = activityIdentity(activity, funds);
    if (key !== undefined) add(index, key, activity.id);
  }
  return {
    /** Whether Wealthfolio has this row, by its ID or as an activity equal to it; for a cash row, under either type. */
    has: (row: ActivityImport) =>
      (!!row.sourceRecordId && records.has(recordKey(row.accountId, row.sourceRecordId))) ||
      cashIdentities(row).some(({ key }) => index.has(key)),
    index,
    records,
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
  /** Wealthfolio's timezone setting, from `engineTimeZone`: the day it counts a hand-entered activity on. */
  timeZone = "UTC",
): PlannedTransaction[] {
  const { index: available, records } = indexActivities(existing, funds);
  const byId = new Map(existing.map((a) => [a.id, a]));
  // Wealthfolio 3.13.0 and newer return the rows' IDs; older versions drop them.
  const keepsIds = checked.some((r) => r?.sourceRecordId);
  // Stored group rows can make a new conversion fail the whole import.
  const groups = new Set(existing.flatMap((a) => groupOf(a) ?? []));
  const seen = new Map<string, number>();
  let position = 0;
  const planned: PlannedTransaction[] = mapping.transactions.map((transaction) => {
    let tradeFound = false;
    const plan = (activity: ActivityImport, settled = false): PlannedRow => {
      const result = checked[position++];
      // A fund account's cash may have come in under the other type, from a v1 import or before a
      // bank account was chosen; the bank's side never does: its deposits and withdrawals are the
      // bank's own rows.
      const keys = activity === transaction.cash ? cashIdentities(activity) : [{ key: rowIdentity(activity), type: undefined }];
      // Rows with different IDs aren't duplicates of each other where Wealthfolio keeps the IDs.
      const own = keepsIds && activity.sourceRecordId ? `record:${recordKey(activity.accountId, activity.sourceRecordId)}` : keys[0].key;
      const recorded = settled || !activity.sourceRecordId ? undefined : records.get(recordKey(activity.accountId, activity.sourceRecordId))?.shift();
      const recordedType = recorded && byId.get(recorded)!.activityType;
      const deferCash = activity === transaction.cash && !tradeFound;
      const match = recorded || settled || deferCash ? undefined : keys.find(({ key }) => available.get(key)?.length);
      // Keep untouched imported dates; gifts and segregated credits entered or edited in the form must match their engine day.
      const ids = match && available.get(match.key)!;
      const at = ids?.findIndex((id) => !activity.symbol?.trim() ||
        (!activity.activityType.startsWith("TRANSFER_") && transaction.rows[0]?.type !== "SEGREGATION") ||
        giftDay(byId.get(id)!, timeZone) === day(activity.date)) ?? -1;
      const row: PlannedRow = {
        activity,
        errors: messages(result?.errors),
        warnings: messages(result?.warnings, "_duplicate"),
        existingId: recorded ?? (at < 0 ? undefined : ids!.splice(at, 1)[0]),
        existingType: recordedType ? (recordedType === activity.activityType ? undefined : recordedType) : match?.type,
        repeatsLine: settled ? undefined : seen.get(own),
        flagged: !!(result?.duplicateOfId || result?.duplicateOfLineNumber),
      };
      if (!result) row.errors.push("Wealthfolio didn't check this row.");
      else if (!result.isValid && row.errors.length === 0) row.errors.push("Wealthfolio can't import this row.");
      if (!settled && !seen.has(own)) seen.set(own, activity.lineNumber ?? position);
      return row;
    };
    const rows = [plan(transaction.activity)];
    tradeFound = !!rows[0].existingId;
    if (transaction.cash) rows.push(plan(transaction.cash));
    if (transaction.arriving) rows.push(plan(transaction.arriving.activity));
    if (transaction.receiving) rows.push(plan(transaction.receiving.activity));
    // Wealthfolio has the transaction when it has the trade and the fund account's cash, whatever
    // the bank account shows, or both rows of a conversion or of a gift between two folios.
    const settled = rows.every((r) => r.existingId);
    if (transaction.bank) rows.push(plan(transaction.bank, settled));
    return { transaction, rows, status: "new" };
  });

  // Reserve current trades and their cash before looking for earlier SELL + BUY imports.
  const mergers = planned.filter((t) => t.transaction.arriving && !t.rows.every((r) => r.existingId));
  for (const t of mergers) {
    if (t.rows.some((r) => r.existingId) || groups.has(t.transaction.activity.sourceGroupId!)) {
      t.problem = CHANGED_CONVERSION;
    } else if (t.transaction.earlier) {
      t.earlier = t.transaction.earlier.map((activity) => ({ activity, errors: [], warnings: [], flagged: false }));
    }
  }
  const takeAvailable = (row: PlannedRow) => {
    // A row found by its ID keeps that activity.
    if (row.existingId) return;
    const keys = cashIdentities(row.activity);
    const match = keys.find(({ key }) => available.get(key)?.length);
    row.existingId = match && available.get(match.key)!.shift();
    row.existingType = match?.type;
  };
  // Match every merger's trades before cash: an unrelated merger can have equal cash rows.
  for (const t of mergers) {
    for (const r of t.earlier ?? []) if (r.activity.symbol?.trim() && r.activity.unitPrice !== undefined) takeAvailable(r);
  }
  for (const t of mergers) {
    for (const r of t.earlier ?? []) {
      if (!r.activity.symbol?.trim() || r.activity.unitPrice !== undefined) continue;
      // Without a printed amount or NAV, a matching earlier trade is enough to block a second import.
      const match = existing.find((a) => {
        const key = activityIdentity(a, funds);
        return key !== undefined && available.get(key)?.includes(a.id) &&
          activityIdentity({ ...a, unitPrice: null, amount: null }, funds) === rowIdentity(r.activity);
      });
      if (match) {
        r.existingId = match.id;
        const ids = available.get(activityIdentity(match, funds)!)!;
        ids.splice(ids.indexOf(match.id), 1);
      }
    }
  }
  // Trades already found get their cash first, ahead of any cash-only matches.
  const withTrades = new Set(mergers.filter((t) => t.earlier?.some((r) => r.existingId)));
  for (const t of withTrades) {
    for (const r of t.earlier!) if (!r.activity.symbol?.trim()) takeAvailable(r);
  }
  // Cash without a matched trade can belong to several mergers; block them without reserving it.
  for (const t of mergers) {
    for (const r of t.earlier ?? []) {
      if (r.activity.symbol?.trim() || r.existingId) continue;
      // Without the old amount, any remaining cash on this day may belong to the earlier import.
      const match = existing.find((a) => {
        const key = activityIdentity(a, funds);
        return key !== undefined && available.get(key)?.includes(a.id) && a.amount && dec(a.amount).n > 0n &&
          cashIdentities({ ...r.activity, amount: r.activity.amount ?? a.amount }).some((candidate) => candidate.key === key);
      });
      if (match) t.problem = t.earlier!.some((r) => r.activity.symbol?.trim() && r.activity.unitPrice === undefined)
        ? UNCERTAIN_EARLIER : PART_OF_EARLIER;
    }
  }
  for (const t of planned) {
    if (t.transaction.cash && !t.rows[0].existingId) takeAvailable(t.rows[1]);
    // Sent alone, one side of a gift between two folios would be a transfer with no other side.
    if (t.transaction.receiving && t.rows.some((r) => r.existingId) && !t.rows.every((r) => r.existingId)) t.problem = PART_OF_GIFT;
  }
  const likely = giftEntries(existing, funds, timeZone);
  for (const t of planned) {
    const { receiving } = t.transaction;
    // Both sides of a gift between two folios count as imported once Wealthfolio has linked them.
    if (receiving && t.rows.every((r) => r.existingId)) {
      const [out, into] = t.rows.map((r) => byId.get(r.existingId!)!);
      if (!groupOf(out) || groupOf(out) !== groupOf(into)) t.problem = UNLINKED_GIFT;
    }
  }
  const completeEarlier = (t: PlannedTransaction) => t.earlier?.every(
    (r) => r.existingId && (!r.activity.symbol?.trim() || r.activity.unitPrice !== undefined),
  );
  for (const t of mergers) {
    const earlier = t.earlier;
    if (!earlier) continue;
    if (!withTrades.has(t)) {
      for (const r of earlier) if (!r.activity.symbol?.trim()) takeAvailable(r);
    }
    if (earlier.some((r) => r.existingId) && !completeEarlier(t)) {
      const uncertain = earlier.some((r) => r.activity.symbol?.trim() && r.activity.unitPrice === undefined);
      t.problem = uncertain ? UNCERTAIN_EARLIER : PART_OF_EARLIER;
      // An incomplete legacy merger must not hide a possible earlier gift entry.
      for (const r of earlier) {
        if (!r.existingId || !r.activity.symbol?.trim()) continue;
        const a = byId.get(r.existingId)!;
        available.get(activityIdentity(a, funds)!)!.push(a.id);
      }
    }
  }
  for (const t of planned) {
    // A gift entered by hand has the same units on the same day, as a transfer or a trade. A
    // segregated portfolio's credits of a day may have been entered as one, so any units count, once
    // earlier imports have matched theirs.
    const segregation = t.transaction.rows[0]?.type === "SEGREGATION";
    for (const r of t.rows) {
      if ((!segregation && !r.activity.activityType.startsWith("TRANSFER_")) || !r.activity.symbol?.trim()) continue;
      if (segregation && r.existingId) continue;
      // A UTC match reserved on another day must not hide this day's hand-entered row. An activity
      // with an ID from the add-on is an import of a statement row, not an entry by hand.
      const found = likely(r.activity, segregation).filter((a) => !recordOf(a) &&
        (available.get(activityIdentity(a, funds)!)?.includes(a.id) || day(a.date) !== day(r.activity.date)));
      if (found.length) t.problem ??= handEntered(found, segregation);
    }
  }
  for (const t of planned) {
    const settled = t.rows.filter((r) => r.activity !== t.transaction.bank).every((r) => r.existingId);
    t.status = t.problem || t.rows.some((r) => r.errors.length)
      ? "invalid"
      : settled || completeEarlier(t)
        ? "existing"
        : t.rows.some((r) => r.existingId || r.repeatsLine !== undefined || r.flagged)
          ? "duplicate"
          : "new";
  }
  return planned;
}

const CHANGED_CONVERSION =
  "Wealthfolio has this conversion from an earlier import, changed since, so it isn't imported again. To import it as the statement has it, delete the conversion in Wealthfolio (deleting either row deletes both) and read the statement again.";
const PART_OF_EARLIER =
  "Wealthfolio has part of this merger from an earlier import, which recorded it as a sale and a purchase with a withdrawal and a deposit, so it isn't imported as a conversion. Correct that import, then read the statement again: delete what's left of it to import the merger as a conversion, or add the missing rows to keep it as a sale and a purchase.";

const UNCERTAIN_EARLIER =
  "Wealthfolio has rows that may belong to an earlier import of this merger, but this statement lacks the amount or NAV needed to check the earlier import, so the merger isn't imported again. Check the sale, purchase and their cash in Wealthfolio. To replace them with a conversion, delete those rows and read the statement again.";
const PART_OF_GIFT =
  "Wealthfolio has one side of this gift from an earlier import but not the other, so neither is imported: Wealthfolio links the two only when they're imported together. To import the gift, delete that side in Wealthfolio and read the statement again.";
const UNLINKED_GIFT =
  "Wealthfolio has both sides of this gift, but they aren't linked to each other, so the receiving account doesn't have the giver's costs and purchase dates. Link the two transfers in Wealthfolio, or delete both and read the statement again.";
const handEntered = (found: ActivityDetails[], segregation: boolean) => {
  const names = found.map((a) => {
    const type = { BUY: "purchase", SELL: "sale", TRANSFER_IN: "transfer in", TRANSFER_OUT: "transfer out" }[a.activityType as string];
    const units = segregation && a.quantity ? ` of ${amount(a.quantity)} units` : "";
    const price = a.unitPrice ? ` at ${amount(a.unitPrice)}` : "";
    return `a ${type}${units}${price}${a.comment?.trim() ? ` ("${a.comment.trim()}")` : ""}`;
  }).join(" and ");
  const fix = "keep it, or delete it and any cash that came with it and read the statement again to import the statement's.";
  return segregation
    ? `Wealthfolio has ${names} of this fund on this day, perhaps entered by hand, so this credit of segregated units isn't imported. If that's this credit, or the day's credits entered as one, ${fix}`
    : `Wealthfolio has ${names} of these units on this day, perhaps entered by hand, so this gift isn't imported. If that's this gift, ${fix}`;
};

/** Form edits preserve CSV origin but can change its date; untouched imports keep their UTC day. */
const giftDay = (a: ActivityDetails, timeZone: string) =>
  a.sourceSystem === "CSV" && !a.isUserModified ? day(a.date) : localDay(a.date, timeZone);

/**
 * Activities that may be a gift's row entered another way: in its account and fund, on its day,
 * with its units (any units with `anyUnits`, for a segregated portfolio's credits, which may have
 * been entered as one), as a transfer or a trade in the same direction. CSV imports use their UTC day;
 * edited ones may also use their engine day, since the edit needn't have changed the date. Other
 * entries use their day in `timeZone`, from `engineTimeZone`. Exact import keys stay UTC.
 */
export function giftEntries(existing: ActivityDetails[], funds: FundRefs, timeZone: string) {
  return (row: ActivityImport, anyUnits = false) => {
    const types = row.activityType === "TRANSFER_IN" || row.activityType === "BUY" ? ["TRANSFER_IN", "BUY"] : ["TRANSFER_OUT", "SELL"];
    const fund = fundRef(row.symbol!, row.exchangeMic);
    const on = day(row.date);
    return existing.filter((a) =>
      a.accountId === row.accountId && types.includes(a.activityType) && !!a.assetId && funds.get(a.assetId) === fund &&
      (giftDay(a, timeZone) === on || (a.sourceSystem === "CSV" && day(a.date) === on)) &&
      (anyUnits || amount(a.quantity) === amount(row.quantity)));
  };
}

/**
 * New transactions, plus the duplicates the user chose to import anyway. All rows of a transaction
 * or none, except that a transaction whose bank row the user chose to reuse sends only its trade:
 * `linkBankRow` adds its cash afterwards. A conversion is never forced: a copy would join the
 * group Wealthfolio has, and Wealthfolio refuses a third row in a group.
 */
export function importRows(
  plan: PlannedTransaction[],
  importAnyway: (t: PlannedTransaction) => boolean,
  reuseBankRow: (t: PlannedTransaction) => boolean = () => false,
) {
  return plan.flatMap((t) => {
    const rows = t.transaction.bank && reuseBankRow(t) ? t.rows.filter((r) => r.activity === t.transaction.activity) : t.rows;
    if (t.status === "new") return rows.map((r) => r.activity);
    if (t.status === "invalid" || t.transaction.arriving || !importAnyway(t)) return [];
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
    // create bypasses the import bridge, so namespace the fields here. ActivityCreate omits
    // sourceRecordId and idempotencyKey, but Wealthfolio keeps both.
    const sourceRecordId = `${RECORD_PREFIX}${cash.sourceRecordId}`;
    const transfer = {
      accountId: cash.accountId,
      activityType: cash.activityType,
      activityDate: String(cash.date),
      amount: cash.amount,
      currency: cash.currency,
      sourceRecordId,
      metadata: { addons: { "cas-importer": cash.metadata } },
      // Keep retries from duplicating this bank row's cash, including copies made with "Import anyway".
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

/**
 * Posted units of activities whose `localDay` in `timeZone` is within `range`, or unknown when the
 * history needs Wealthfolio's portfolio engine.
 */
export function unitsHeld(
  activities: ActivityDetails[],
  accountId: string,
  asset: Pick<FundAsset, "symbol" | "exchangeMic">,
  funds: FundRefs,
  range: (day: string) => boolean,
  timeZone: string,
) {
  const ref = fundRef(asset.symbol, asset.exchangeMic);
  return countUnits(activities.filter((a) => a.accountId === accountId && a.assetId && funds.get(a.assetId) === ref), range, timeZone);
}

/** `unitsHeld` for activities already narrowed to one asset in one account. */
export function countUnits(activities: ActivityDetails[], range: (day: string) => boolean, timeZone: string) {
  let units = dec("0");
  for (const a of activities) {
    if (a.status !== "POSTED" || !range(localDay(a.date, timeZone))) continue;
    if (a.activityType === "SPLIT" || (a.activityType === "ADJUSTMENT" && a.subtype === "OPTION_EXPIRY")) return undefined;
    if (!a.quantity) continue;
    const q = abs(dec(a.quantity));
    const type = a.activityType as string;
    const conversion = type === "ADJUSTMENT" ? conversionSide(a.subtype) : undefined;
    if (
      type === "BUY" || type === "TRANSFER_IN" || conversion === "CONVERSION_IN" ||
      (type === "DIVIDEND" && (a.subtype === "DRIP" || a.subtype === "DIVIDEND_IN_KIND")) ||
      (type === "INTEREST" && a.subtype === "STAKING_REWARD")
    ) units = add(units, q);
    else if (type === "SELL" || type === "TRANSFER_OUT" || conversion === "CONVERSION_OUT") units = add(units, neg(q));
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
export function openingUnits(
  data: CasData,
  target: Target,
  activities: ActivityDetails[],
  funds: FundRefs,
  timeZone: string,
): FundUnits[] {
  const from = statementDay(data.statement_period.from);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.open)),
    held: unitsHeld(activities, f.accountId, f.asset, funds, (d) => d < from, timeZone),
  }));
}

/** Closing units against what Wealthfolio holds at the statement's end. */
export function closingUnits(
  data: CasData,
  target: Target,
  activities: ActivityDetails[],
  funds: FundRefs,
  timeZone: string,
): FundUnits[] {
  const to = statementDay(data.statement_period.to);
  return byFund(data, target).map((f) => ({
    ...f,
    statement: sum(f.schemes.map((s) => s.close)),
    held: unitsHeld(activities, f.accountId, f.asset, funds, (d) => d <= to, timeZone),
  }));
}

export const sameUnits = (f: Pick<FundUnits, "statement" | "held">) => f.held !== undefined && cmp(f.statement, f.held) === 0;
