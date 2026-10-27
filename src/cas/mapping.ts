import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, format, isZero, mul, neg, step, sub } from "./decimal.ts";
import type { CasData, CasFolio, CasScheme, CasTransaction, TransactionType } from "./types.ts";

// casparser's statement → the rows sent to Wealthfolio's `activities.checkImport` and
// `activities.import`. Pure: the user's choices come in, rows and warnings come out.

/** The fund the user confirmed from `market.searchTicker`. No `assetId`, so import keys stay stable. */
export interface FundAsset {
  symbol: string;
  exchangeMic?: string;
  quoteCcy: string;
  instrumentType: string;
  providerId?: string;
  providerSymbol?: string;
}

export interface SchemeTarget {
  accountId: string;
  asset: FundAsset;
  /** Wealthfolio already has the units in `scheme.open`, with their original costs and dates. */
  openingCovered: boolean;
}

export interface MappingInput {
  /** The account chosen for the folio and the asset for the fund; undefined leaves the scheme out. */
  target(folio: CasFolio, scheme: CasScheme): SchemeTarget | undefined;
  /** Whether Wealthfolio has this row from an earlier import. Asked about reversed purchases and redemptions. */
  alreadyImported(activity: ActivityImport): boolean;
}

export interface MappedTransaction {
  folio: string;
  scheme: string;
  /** The statement's transaction, then the charges in its `tax`. */
  rows: CasTransaction[];
  activity: ActivityImport;
  /** The DEPOSIT or WITHDRAWAL that balances `activity`. A reinvested dividend balances itself. */
  cash?: ActivityImport;
}

export interface MappingWarning {
  folio: string;
  scheme: string;
  /** Empty when the warning is about the whole scheme. */
  rows: CasTransaction[];
  message: string;
  /** False for a caveat on rows that are imported. */
  leftOut: boolean;
}

export interface Mapping {
  transactions: MappedTransaction[];
  warnings: MappingWarning[];
}

const CURRENCY = "INR";
const PAISA = dec("0.01");
const HALF = dec("0.5");
const ZERO = dec("0");

type Kind = "buy" | "sell" | "payout" | "reinvest";

const KINDS: Partial<Record<TransactionType, Kind>> = {
  PURCHASE: "buy",
  PURCHASE_SIP: "buy",
  SWITCH_IN: "buy",
  SWITCH_IN_MERGER: "buy",
  REDEMPTION: "sell",
  SWITCH_OUT: "sell",
  SWITCH_OUT_MERGER: "sell",
  DIVIDEND_PAYOUT: "payout",
  DIVIDEND_REINVEST: "reinvest",
};

/** Charge rows, and the transactions each kind can belong to. */
const CHARGES: Partial<Record<TransactionType, { name: string; kinds: Kind[] }>> = {
  STAMP_DUTY_TAX: { name: "stamp duty", kinds: ["buy", "reinvest"] },
  STT_TAX: { name: "STT", kinds: ["sell"] },
  TDS_TAX: { name: "TDS", kinds: ["sell", "payout", "reinvest"] },
};

/** Rows #1 leaves for later. */
const UNSUPPORTED: Partial<Record<TransactionType, string>> = {
  GIFT_IN: "Gifts aren't imported yet.",
  GIFT_OUT: "Gifts aren't imported yet.",
  SEGREGATION: "Segregated portfolios aren't imported yet.",
  UNKNOWN: "casparser couldn't tell what this row is, so it isn't imported.",
  MISC: "casparser couldn't tell what this row is, so it isn't imported.",
};

const MERGER_CAVEAT =
  "Imported like a switch, as a sale and a purchase: Wealthfolio may show a gain or loss that didn't happen, and the units' cost and purchase date restart.";

interface Scheme {
  folio: CasFolio;
  scheme: CasScheme;
  target?: SchemeTarget;
  /** Leaves out the whole scheme. */
  problem?: string;
  entries: Entry[];
}

interface Entry {
  scheme: Scheme;
  index: number;
  row: CasTransaction;
  kind?: Kind;
  /** For a charge row: whether it was added to a transaction. */
  attached?: boolean;
  charges: CasTransaction[];
  /** Leaves out the transaction and its cash. */
  problem?: string;
  reverses?: Entry;
  reversedBy?: Entry;
  /** The other leg of a merger. */
  partner?: Entry;
  rows?: {
    activity: ActivityImport;
    cash?: ActivityImport;
    /** Imported, with this caveat. */
    note?: string;
  };
}

export function mapStatement(data: CasData, input: MappingInput): Mapping {
  const schemes = data.folios.flatMap((folio) =>
    folio.schemes.map((scheme) => readScheme(folio, scheme, data.statement_period.from, input)),
  );
  for (const folio of data.folios) matchMergers(schemes.filter((s) => s.folio === folio));
  for (const entry of schemes.flatMap((s) => s.entries)) {
    const target = entry.scheme.target;
    if (!entry.kind || entry.problem || entry.scheme.problem || !target) continue;
    const rows = buildRows(entry, target);
    if (typeof rows === "string") entry.problem = rows;
    else entry.rows = rows;
  }
  const fails = (entry: Entry) => !!(entry.problem || entry.scheme.problem);
  for (const scheme of schemes) {
    for (const entry of scheme.entries) {
      if (entry.partner && !fails(entry) && fails(entry.partner)) {
        entry.problem = "The other half of this merger can't be imported, so neither half is.";
      }
    }
  }

  const mapping: Mapping = { transactions: [], warnings: [] };
  let lineNumber = 0;
  const number = (activity: ActivityImport) => ({ ...activity, lineNumber: ++lineNumber });
  for (const { folio, scheme, problem, entries } of schemes) {
    const names = { folio: folio.folio, scheme: scheme.scheme };
    const warn = (rows: CasTransaction[], message: string, leftOut = true) =>
      mapping.warnings.push({ ...names, rows, message, leftOut });
    if (problem) {
      warn([], problem);
      continue;
    }
    for (const entry of entries) {
      const rows = [entry.row, ...entry.charges];
      if (entry.reverses) {
        const original = entry.reverses;
        warn([original.row, ...original.charges, ...rows], reversalMessage(original, input));
      } else if (entry.reversedBy || entry.attached) {
        continue;
      } else if (entry.problem) {
        warn(rows, entry.problem);
      } else if (entry.rows) {
        const { activity, cash, note } = entry.rows;
        mapping.transactions.push({ ...names, rows, activity: number(activity), cash: cash && number(cash) });
        if (note) warn(rows, note, false);
        if (entry.partner) warn(rows, MERGER_CAVEAT, false);
      }
    }
  }
  return mapping;
}

/** Event-only rows, such as a nominee registration, and payments that failed. */
function recordsNothing(row: CasTransaction) {
  if (row.type === "MISC" && (row.amount === null || isZero(dec(row.amount)))) return true;
  return (
    (row.type === "UNKNOWN" || row.type === "MISC") &&
    (row.units === null || isZero(dec(row.units))) &&
    /\breject(?:ed|ion)\b|dishonoured|insufficient\s+(?:balance|funds)|payment\s+not\s+received/i.test(row.description)
  );
}

/** A row whose printed unit balance differs from the units held before it. */
function changesBalance(scheme: CasScheme, index: number) {
  const { balance } = scheme.transactions[index];
  return balance !== null && cmp(dec(balance), unitsHeldBefore(scheme, index)) !== 0;
}

/** Rows that record nothing and leave the unit balance as it was. */
const skipped = (scheme: CasScheme, index: number) =>
  recordsNothing(scheme.transactions[index]) && !changesBalance(scheme, index);

/** A scheme with no units at either end and nothing to import, such as one sold before the statement. */
export const closedScheme = (scheme: CasScheme) =>
  isZero(dec(scheme.open)) && isZero(dec(scheme.close)) && scheme.transactions.every((_, index) => skipped(scheme, index));

/** The statement without closed schemes, which need no account or fund, or the folios they leave empty. */
export function withoutClosed(data: CasData): CasData {
  const folios = data.folios.map((folio) => ({ ...folio, schemes: folio.schemes.filter((s) => !closedScheme(s)) }));
  return { ...data, folios: folios.filter((folio) => folio.schemes.length > 0) };
}

function readScheme(folio: CasFolio, scheme: CasScheme, from: string, input: MappingInput): Scheme {
  const target = input.target(folio, scheme);
  const state: Scheme = { folio, scheme, target, entries: [] };
  if (!target) {
    state.problem = "No Wealthfolio account or fund is chosen for this scheme, so its transactions are left out.";
  } else if (!isZero(dec(scheme.open)) && !target.openingCovered) {
    state.problem = `The statement starts with ${scheme.open} units bought before ${from}. Import that earlier history, or add the units with their original costs and dates, before this scheme's transactions.`;
  }

  scheme.transactions.forEach((row, index) => {
    if (skipped(scheme, index)) return;
    const entry: Entry = { scheme: state, index, row, kind: KINDS[row.type], charges: [] };
    if (recordsNothing(row)) {
      // casparser returns transmission and transformation restatements with only a balance.
      entry.problem = `This row changes the unit balance from ${format(unitsHeldBefore(scheme, index))} to ${format(dec(row.balance!))} without listing any units, so it isn't imported.`;
    } else if (!entry.kind && !CHARGES[row.type] && row.type !== "REVERSAL") {
      entry.problem = UNSUPPORTED[row.type] ?? UNSUPPORTED.UNKNOWN;
    }
    state.entries.push(entry);
  });

  for (const charge of state.entries) {
    const rule = CHARGES[charge.row.type];
    if (!rule) continue;
    // casparser prints a charge after its transaction, on the same day, but doesn't link them.
    const candidates = state.entries.filter(
      (entry) =>
        entry.row.date === charge.row.date &&
        !CHARGES[entry.row.type] &&
        !recordsNothing(entry.row) &&
        (!entry.kind || rule.kinds.includes(entry.kind)),
    );
    if (candidates.length === 0) {
      charge.problem = `There's no transaction on this day to add this ${rule.name} to.`;
      continue;
    }
    charge.attached = true;
    for (const entry of candidates) {
      if (candidates.length > 1) {
        entry.problem ??= `Can't tell which of the ${candidates.length} transactions on this day the ₹${charge.row.amount} ${rule.name} belongs to.`;
      } else if (entry.charges.some((other) => other.type === charge.row.type)) {
        entry.problem ??= `More than one ${rule.name} row follows this transaction.`;
      }
      entry.charges.push(charge.row);
    }
  }

  for (const reversal of state.entries) {
    if (reversal.row.type !== "REVERSAL") continue;
    const units = reversal.row.units;
    const candidates = state.entries.filter(
      (entry) =>
        entry.index < reversal.index &&
        (entry.row.type === "PURCHASE" || entry.row.type === "PURCHASE_SIP") &&
        !entry.reversedBy &&
        units !== null &&
        entry.row.units !== null &&
        cmp(dec(entry.row.units), neg(dec(units))) === 0 &&
        reversal.row.amount !== null &&
        entry.row.amount !== null &&
        cmp(dec(entry.row.amount), neg(dec(reversal.row.amount))) === 0,
    );
    if (candidates.length === 1) {
      reversal.reverses = candidates[0];
      candidates[0].reversedBy = reversal;
    } else {
      reversal.problem =
        candidates.length === 0
          ? "This reversal's purchase isn't in the statement, so the reversal isn't imported. If Wealthfolio has that purchase, delete it and its deposit."
          : `${candidates.length} purchases in the statement could be the one this reverses, so the reversal isn't imported. Delete the reversed purchase and its deposit after importing.`;
    }
  }

  // casparser 1.4.1 has no type for a row that puts redeemed units back, such as Franklin
  // Templeton's "Payment - Units Extinguished-Reversed", and returns it as a purchase.
  // shortcut: equal units and amounts can also be a new purchase; use an explicit casparser signal when available.
  for (const restore of state.entries) {
    if ((restore.row.type !== "PURCHASE" && restore.row.type !== "PURCHASE_SIP") || restore.reversedBy) continue;
    const { units, amount } = restore.row;
    if (units === null || amount === null || dec(units).n <= 0n || dec(amount).n <= 0n) continue;
    const candidates = state.entries.filter(
      (entry) =>
        entry.index < restore.index &&
        entry.row.type === "REDEMPTION" &&
        !entry.reversedBy &&
        entry.row.units !== null &&
        cmp(dec(entry.row.units), neg(dec(units))) === 0 &&
        entry.row.amount !== null &&
        cmp(dec(entry.row.amount), neg(dec(amount))) === 0,
    );
    if (candidates.length === 1) {
      restore.reverses = candidates[0];
      candidates[0].reversedBy = restore;
    }
  }
  return state;
}

/** #1: a merger is imported like a switch only when both legs can be matched. */
function matchMergers(schemes: Scheme[]) {
  const legs = schemes.flatMap((s) =>
    s.entries.filter((e) => e.row.type === "SWITCH_OUT_MERGER" || e.row.type === "SWITCH_IN_MERGER"),
  );
  for (const leg of legs) {
    const sameDay = legs.filter((other) => other.row.date === leg.row.date);
    const outs = sameDay.filter((e) => e.row.type === "SWITCH_OUT_MERGER");
    const ins = sameDay.filter((e) => e.row.type === "SWITCH_IN_MERGER");
    if (outs.length === 1 && ins.length === 1) {
      leg.partner = leg === outs[0] ? ins[0] : outs[0];
    } else {
      leg.problem ??= `Can't match this merger with its other half: the folio has ${outs.length} merger sales and ${ins.length} merger purchases on this day.`;
    }
  }
}

function reversalMessage(original: Entry, input: MappingInput) {
  const { rows } = original;
  if (original.kind === "sell") {
    const putBack = "A later row has the opposite units and amount to this redemption. This could be a reversal or a new purchase, so neither row is imported. Check the statement and handle these rows by hand.";
    if (rows && (input.alreadyImported(rows.activity) || (rows.cash && input.alreadyImported(rows.cash)))) {
      return `${putBack} Wealthfolio has the sale or its withdrawal from an earlier import; delete them only if this is a reversal.`;
    }
    return rows ? putBack : `${putBack} If Wealthfolio has the sale or its withdrawal from an earlier import, delete them only if this is a reversal.`;
  }
  if (!rows) {
    return "The statement reverses this purchase, so neither row is imported. If Wealthfolio has the purchase from an earlier import, delete it and its deposit.";
  }
  if (input.alreadyImported(rows.activity) || (rows.cash && input.alreadyImported(rows.cash))) {
    return "Wealthfolio has this purchase from an earlier import, but the statement reverses it. Delete that purchase and its deposit; neither row is imported.";
  }
  return "The statement reverses this purchase, so neither row is imported.";
}

function unitsHeldBefore(scheme: CasScheme, index: number) {
  let units = ZERO;
  for (let i = index - 1; i >= 0; i--) {
    const row = scheme.transactions[i];
    if (row.balance !== null) return add(dec(row.balance), units);
    if (row.units !== null) units = add(units, dec(row.units));
  }
  return add(dec(scheme.open), units);
}

function buildRows(entry: Entry, target: SchemeTarget): NonNullable<Entry["rows"]> | string {
  const { row, kind } = entry;
  const sign = kind === "sell" ? -1n : 1n;
  // casparser 1.4.1 returns bonus units, and units passed on by transmission, as purchases or redemptions.
  const plain = row.type === "PURCHASE" || row.type === "PURCHASE_SIP" || row.type === "REDEMPTION";
  if (plain && (row.amount === null || isZero(dec(row.amount))) && row.units !== null && dec(row.units).n * sign > 0n) {
    return kind === "buy"
      ? "Units added without a payment, such as bonus units or a transmission, aren't imported yet."
      : "Units removed without a payment, such as a transmission or a move to another folio, aren't imported yet.";
  }
  if (row.amount === null || dec(row.amount).n * sign <= 0n) return "This row has no amount, or one with the wrong sign.";
  const printed = abs(dec(row.amount));
  let charges = ZERO;
  for (const charge of entry.charges) {
    if (charge.amount === null || dec(charge.amount).n <= 0n) return "One of this transaction's charges has no positive amount.";
    charges = add(charges, dec(charge.amount));
  }
  const names = `₹${format(charges)} ${[...new Set(entry.charges.map((charge) => CHARGES[charge.type]!.name))].join(" and ")}`;
  const base = { accountId: target.accountId, currency: CURRENCY, date: row.date, isDraft: false, isValid: true };
  const tax = isZero(charges) ? {} : { tax: format(charges) };
  const asset = {
    symbol: target.asset.symbol,
    exchangeMic: target.asset.exchangeMic,
    quoteCcy: target.asset.quoteCcy,
    instrumentType: target.asset.instrumentType,
    providerId: target.asset.providerId,
    providerSymbol: target.asset.providerSymbol,
    symbolName: entry.scheme.scheme.scheme,
  };
  const cash = (activityType: "DEPOSIT" | "WITHDRAWAL", amount: Dec): ActivityImport => ({
    ...base,
    activityType,
    symbol: "",
    amount: format(amount),
  });

  if (kind === "payout") {
    let gross = printed;
    if (!isZero(charges)) {
      // Printed before or after TDS: the dividend rate × the units held shows which.
      const unsure = `Can't tell whether ₹${format(printed)} is before or after the ${names}`;
      if (row.dividend_rate === null) return `${unsure}: the dividend rate is missing.`;
      const worth = mul(dec(row.dividend_rate), unitsHeldBefore(entry.scheme.scheme, entry.index));
      const fits = [printed, add(printed, charges)].filter((amount) => cmp(abs(sub(worth, amount)), PAISA) <= 0);
      if (fits.length !== 1) {
        return fits.length
          ? `${unsure}: both fit the dividend rate and the units held.`
          : `₹${format(printed)} doesn't match the dividend rate and the units held, with or without the ${names}.`;
      }
      gross = fits[0];
    }
    const final = sub(gross, charges);
    if (final.n < 0n) return "This transaction's charges exceed its proceeds.";
    return {
      activity: { ...base, ...asset, ...tax, activityType: "DIVIDEND", amount: format(final) },
      cash: cash("WITHDRAWAL", final),
    };
  }

  if (row.units === null || dec(row.units).n * sign <= 0n) return "This row has no units, or units with the wrong sign.";
  if (row.nav === null || dec(row.nav).n <= 0n) return "This row has no NAV.";
  // The printed units and NAV are authoritative. Wealthfolio keeps an amount equal to
  // quantity × unit price ± charges, and flags any other for review.
  // shortcut: older layouts without a NAV column get amount ÷ units from casparser; #6 could supply the published NAV.
  const quantity = row.units.replace(/^-/, "");
  const units = dec(quantity);
  const nav = dec(row.nav);
  const value = mul(units, nav);
  const charged = kind === "sell" ? sub(value, charges) : add(value, charges);
  const final = kind === "reinvest" ? value : charged;
  if (final.n < 0n) return "This transaction's charges exceed its proceeds.";
  // The statement prints the amount before or after the charges, off by the units' rounding.
  const tolerance = add(mul(mul(nav, HALF), step(units.scale)), PAISA);
  const matches = [value, charged].some((amount) => cmp(abs(sub(printed, amount)), tolerance) <= 0);
  const note = matches
    ? undefined
    : `The statement's ₹${format(printed)} differs from ${quantity} units × NAV ${row.nav}${isZero(charges) ? "" : `, with or without the ${names},`} by more than the units' rounding. It's imported at ₹${format(final)} using the printed units and NAV.`;
  const trade = { ...base, ...asset, ...tax, quantity, unitPrice: row.nav };
  if (kind === "reinvest") {
    // Wealthfolio splits this into dividend income, which takes the tax, and a purchase of `value`.
    return { activity: { ...trade, activityType: "DIVIDEND", subtype: "DRIP", amount: format(value) }, note };
  }
  return {
    activity: { ...trade, activityType: kind === "buy" ? "BUY" : "SELL", amount: format(final) },
    cash: cash(kind === "buy" ? "DEPOSIT" : "WITHDRAWAL", final),
    note,
  };
}
