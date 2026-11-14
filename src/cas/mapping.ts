import type { ActivityCharge, ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";
import { hasSegregatedMarker, readableName } from "../lib/fund-name.ts";
import { plural } from "../lib/plural.ts";
import { sha256 } from "../lib/sha256.ts";
import { abs, add, cmp, dec, type Dec, format, isZero, mul, neg, step, sub } from "./decimal.ts";
import { fundRef } from "./plan.ts";
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
  /** The Wealthfolio account purchases are paid from and redemptions and payouts paid into, if any. */
  bankAccountId?: string;
  /** The user chose to import the scheme's rows even though they don't add up to its closing balance. */
  importUnbalanced?: boolean;
}

export interface MappingInput {
  /** The account chosen for the folio and the asset for the fund; undefined leaves the scheme out. */
  target(folio: CasFolio, scheme: CasScheme): SchemeTarget | undefined;
  /** Whether Wealthfolio has this row from an earlier import. Asked about reversed purchases and redemptions. */
  alreadyImported(activity: ActivityImport): boolean;
  /**
   * Whether Wealthfolio has activities that may be this gift's row, entered by hand or imported:
   * `giftEntries` in `plan.ts`. Asked about gifts left out because both sides go to one account.
   */
  entered?(activity: ActivityImport): boolean;
}

export interface MappedTransaction {
  folio: string;
  scheme: string;
  /** The statement's transaction, then the charges in its `tax`. */
  rows: CasTransaction[];
  activity: ActivityImport;
  /**
   * The fund account's cash row that balances `activity`: a DEPOSIT or WITHDRAWAL, or a transfer
   * from or to the bank account. A reinvested dividend balances itself.
   */
  cash?: ActivityImport;
  /** The bank account's side of a transfer in `cash`. Wealthfolio links the two when it imports them together. */
  bank?: ActivityImport;
  /**
   * A merger's new fund: its scheme, rows and `CONVERSION_IN` row. `activity` is then the old fund's
   * `CONVERSION_OUT` row, and the two are imported together or not at all.
   */
  arriving?: { scheme: string; rows: CasTransaction[]; activity: ActivityImport };
  /** For a merger: the earlier sale, withdrawal, purchase and deposit, without price or amount when unknown. */
  earlier?: ActivityImport[];
  /**
   * A gift between two folios of this statement, in different accounts: the receiving folio's
   * `TRANSFER_IN`. `activity` is then the giving folio's `TRANSFER_OUT`, and Wealthfolio's import
   * links the two, as they have the same day, fund, units and price.
   */
  receiving?: { folio: string; scheme: string; rows: CasTransaction[]; activity: ActivityImport };
  /** Fields of `activity` whose values stand in for ones the statement doesn't give. */
  standIns?: (keyof ActivityImport)[];
}

export interface MappingWarning {
  folio: string;
  scheme: string;
  /** Empty when the warning is about the whole scheme. */
  rows: CasTransaction[];
  message: string;
  /** False for a caveat on rows that are imported. */
  leftOut: boolean;
  /** The scheme's rows don't add up to its closing balance; `SchemeTarget.importUnbalanced` imports them anyway. */
  unbalanced?: true;
}

/**
 * Why a statement row isn't part of a transaction: its scheme has no account or fund (`unchosen`),
 * starts with units Wealthfolio doesn't have (`opening`), is left out as a whole for another reason
 * (`scheme`) or because its rows don't add up (`unbalanced`); it's a reversed row or its reversal
 * (`reversal`); or the row itself can't be imported (`row`).
 */
export type LeftOutKind = "unchosen" | "opening" | "scheme" | "unbalanced" | "reversal" | "row";

/**
 * A statement row that records something, and what the import does with it: every row of the
 * statement's schemes but event-only rows and charges added to a transaction. A merger's or a gift's
 * two rows share their transaction.
 */
export interface RowOutcome {
  folio: CasFolio;
  scheme: CasScheme;
  row: CasTransaction;
  transaction?: MappedTransaction;
  leftOut?: { kind: LeftOutKind; reason: string };
}

export interface Mapping {
  transactions: MappedTransaction[];
  warnings: MappingWarning[];
  /** Each statement row's outcome, in the statement's order. */
  outcomes: RowOutcome[];
}

const CURRENCY = "INR";
const PAISA = dec("0.01");
const HALF = dec("0.5");
const ZERO = dec("0");
/** casparser's tolerance when it checks the rows against the printed unit balances. */
const UNIT_TOLERANCE = dec("0.005");

type Kind = "buy" | "sell" | "payout" | "reinvest" | "gift" | "segregation";

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
  GIFT_IN: "gift",
  GIFT_OUT: "gift",
  SEGREGATION: "segregation",
};

/**
 * Charge rows, and the transactions each kind can belong to. A charge on a gift's or a segregated
 * portfolio's credit's day may be theirs, which their rows can't carry, so it keeps them out.
 */
const CHARGES: Partial<Record<TransactionType, { name: string; label: string; kinds: Kind[] }>> = {
  STAMP_DUTY_TAX: { name: "stamp duty", label: "Stamp duty", kinds: ["buy", "reinvest", "gift", "segregation"] },
  STT_TAX: { name: "STT", label: "STT", kinds: ["sell", "gift", "segregation"] },
  TDS_TAX: { name: "TDS", label: "TDS", kinds: ["sell", "payout", "reinvest", "gift", "segregation"] },
};

/** Rows whose money comes from or goes to the investor's bank account. */
const BANKED = new Set<TransactionType>(["PURCHASE", "PURCHASE_SIP", "REDEMPTION", "DIVIDEND_PAYOUT"]);

/** Rows #1 leaves for later. */
const UNSUPPORTED: Partial<Record<TransactionType, string>> = {
  UNKNOWN: "casparser couldn't tell what this row is, so it isn't imported.",
  MISC: "casparser couldn't tell what this row is, so it isn't imported.",
};

/** Wealthfolio deletes both sides of a linked transfer, and the bank's side may be the user's own row. */
const REVERSAL_CASH_NOTE =
  "If that cash is a transfer, unlink it first: Wealthfolio deletes both sides of a linked transfer. Then delete the bank account's side too, unless it's a row from your bank statement.";

interface Scheme {
  folio: CasFolio;
  scheme: CasScheme;
  target?: SchemeTarget;
  /** Leaves out the whole scheme. */
  problem?: string;
  /** What `problem` is about. */
  problemKind?: "unchosen" | "opening" | "scheme";
  /** How the rows miss the closing balance. Leaves out the scheme's rows unless `target.importUnbalanced`. */
  unbalanced?: string;
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
  /** The other side of a gift between two folios of this statement. */
  counterpart?: Entry;
  rows?: {
    activity: ActivityImport;
    cash?: ActivityImport;
    bank?: ActivityImport;
    /** Imported, with this caveat. */
    note?: string;
    /** A merger's rows as v1.2.0 and earlier imported them. */
    earlier?: ActivityImport[];
    standIns?: (keyof ActivityImport)[];
  };
}

export function mapStatement(data: CasData, input: MappingInput): Mapping {
  const schemes = data.folios.flatMap((folio) =>
    folio.schemes.map((scheme) => readScheme(folio, scheme, data.statement_period.from, input)),
  );
  for (const folio of data.folios) matchMergers(schemes.filter((s) => s.folio === folio));
  matchGifts(schemes);
  checkSegregated(schemes);
  const ids = rowIds(schemes);
  for (const entry of schemes.flatMap((s) => s.entries)) {
    const target = entry.scheme.target;
    if (!entry.kind || entry.problem || entry.scheme.problem || !target) continue;
    const rows = entry.partner
      ? conversionRows(entry, target)
      : entry.kind === "gift"
        ? giftRows(entry, target)
        : entry.kind === "segregation"
          ? segregationRows(entry, target)
          : buildRows(entry, target);
    if (typeof rows === "string") entry.problem = rows;
    else {
      if (entry.kind === "sell" && segregated(entry.scheme)) rows.note = [rows.note, SEGREGATED_PAYOUT].filter(Boolean).join(" ");
      entry.rows = identify(rows, entry, ids.get(entry.scheme)![entry.index]);
    }
  }
  const fails = (entry: Entry) => !!(entry.problem || entry.scheme.problem || heldBack(entry.scheme));
  for (const scheme of schemes) {
    for (const entry of scheme.entries) {
      if (entry.partner && !fails(entry) && fails(entry.partner)) {
        entry.problem = "The other half of this merger can't be imported, so neither half is.";
      }
    }
  }
  pairGifts(schemes, fails, input);

  const mapping: Mapping = { transactions: [], warnings: [], outcomes: [] };
  // Each counted row's transaction, or why it's left out, resolved once every transaction is made.
  const made = new Map<Entry, MappedTransaction>();
  const counted: { entry: Entry; leftOut?: RowOutcome["leftOut"] }[] = [];
  let lineNumber = 0;
  const number = (activity: ActivityImport) => ({ ...activity, lineNumber: ++lineNumber });
  for (const state of schemes) {
    const { folio, scheme, problem, unbalanced, entries } = state;
    const names = { folio: folio.folio, scheme: scheme.scheme };
    const warn = (rows: CasTransaction[], message: string, leftOut = true) =>
      mapping.warnings.push({ ...names, rows, message, leftOut });
    if (problem) {
      warn([], problem);
      for (const entry of entries) if (!entry.attached) counted.push({ entry, leftOut: { kind: state.problemKind ?? "scheme", reason: problem } });
      continue;
    }
    const held = heldBack(state);
    if (unbalanced) {
      const message = held
        ? `${unbalanced} None of this fund's rows are imported unless you choose to import it anyway, under Before importing: then check them against the PDF.`
        : `${unbalanced} Its rows are imported anyway: check them against the PDF, and after importing add or correct the missing rows in Wealthfolio.`;
      mapping.warnings.push({ ...names, rows: [], message, leftOut: held, unbalanced: true });
    }
    for (const entry of entries) {
      const rows = [entry.row, ...entry.charges];
      if (entry.attached) continue;
      // A fund held back for rows that don't add up leaves out every row, for that reason.
      const outcome = (leftOut?: RowOutcome["leftOut"]) => ({ entry, ...(held ? { leftOut: { kind: "unbalanced" as const, reason: unbalanced! } } : leftOut && { leftOut }) });
      if (entry.reverses) {
        const original = entry.reverses;
        const message = reversalMessage(original, input);
        warn([original.row, ...original.charges, ...rows], message);
        counted.push({ ...outcome({ kind: "reversal", reason: message }), entry: original }, outcome({ kind: "reversal", reason: message }));
      } else if (entry.reversedBy) {
        continue;
      } else if (held) {
        // A scheme left out still says how to correct earlier imports.
        if (entry.problem && entry.row.type === "REVERSAL") warn(rows, entry.problem);
        counted.push(outcome());
      } else if (entry.problem) {
        warn(rows, entry.problem);
        counted.push({ entry, leftOut: { kind: "row", reason: entry.problem } });
      } else if (entry.rows && entry.partner) {
        counted.push({ entry });
        // The old fund's side carries both rows of the conversion.
        if (entry.row.type === "SWITCH_IN_MERGER") continue;
        const into = entry.partner;
        const [leaving, arriving] = [entry.rows, into.rows!];
        const transaction: MappedTransaction = {
          ...names,
          rows,
          activity: number(leaving.activity),
          arriving: { scheme: into.scheme.scheme.scheme, rows: [into.row, ...into.charges], activity: number(arriving.activity) },
          earlier: leaving.earlier && arriving.earlier && [...leaving.earlier, ...arriving.earlier],
        };
        mapping.transactions.push(transaction);
        made.set(entry, transaction).set(into, transaction);
      } else if (entry.rows && entry.counterpart) {
        counted.push({ entry });
        // The giving folio's side carries both rows of the transfer.
        if (entry.row.type === "GIFT_IN") continue;
        const into = entry.counterpart;
        const transaction: MappedTransaction = {
          ...names,
          rows,
          activity: number(entry.rows.activity),
          receiving: {
            folio: into.scheme.folio.folio,
            scheme: into.scheme.scheme.scheme,
            rows: [into.row, ...into.charges],
            activity: number(into.rows!.activity),
          },
        };
        mapping.transactions.push(transaction);
        made.set(entry, transaction).set(into, transaction);
        if (entry.rows.note) warn(rows, entry.rows.note, false);
      } else if (entry.rows) {
        const { activity, cash, bank, note, standIns } = entry.rows;
        const transaction: MappedTransaction = {
          ...names,
          rows,
          activity: number(activity),
          cash: cash && number(cash),
          bank: bank && number(bank),
          ...(standIns && { standIns }),
        };
        mapping.transactions.push(transaction);
        made.set(entry, transaction);
        counted.push({ entry });
        if (note) warn(rows, note, false);
      } else {
        // Not expected: every other row has a problem or rows.
        counted.push({ entry, leftOut: { kind: "row", reason: "This row isn't imported." } });
      }
    }
  }
  mapping.outcomes = counted.map(({ entry, leftOut }) => {
    const { folio, scheme } = entry.scheme;
    const transaction = leftOut ? undefined : made.get(entry);
    return {
      folio,
      scheme,
      row: entry.row,
      ...(transaction ? { transaction } : { leftOut: leftOut ?? { kind: "row" as const, reason: "This row isn't imported." } }),
    };
  });
  return mapping;
}

/** The scheme's rows don't add up to its closing balance, and the user didn't choose to import them anyway. */
const heldBack = (scheme: Scheme) => !!scheme.unbalanced && !scheme.target?.importUnbalanced;

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

/**
 * The statement with each scheme's name as `readableName` gives it, which detailed imports show,
 * search and save, since they keep no printed details. A name with nothing readable reads as the
 * scheme's ISIN, or else its registrar's scheme code.
 */
export function withReadableNames(data: CasData): CasData {
  const folios = data.folios.map((folio) => ({
    ...folio,
    schemes: folio.schemes.map((s) => ({ ...s, scheme: readableName(s.scheme) || s.isin || s.rta_code || "" })),
  }));
  return { ...data, folios };
}

function readScheme(folio: CasFolio, scheme: CasScheme, from: string, input: MappingInput): Scheme {
  const target = input.target(folio, scheme);
  const state: Scheme = { folio, scheme, target, entries: [] };
  if (!target) {
    state.problem = "No Wealthfolio account or fund is chosen for this scheme, so its transactions are left out.";
    state.problemKind = "unchosen";
  } else if (!isZero(dec(scheme.open)) && !target.openingCovered) {
    state.problem = `The statement starts with ${scheme.open} units bought before ${from}. Import that earlier history, or add the units with their original costs and dates, before this scheme's transactions.`;
    state.problemKind = "opening";
  }
  // casparser's close_calculated is the opening units plus every row's units.
  const calculated = dec(scheme.close_calculated);
  const gap = abs(sub(dec(scheme.close), calculated));
  if (cmp(gap, UNIT_TOLERANCE) > 0) {
    state.unbalanced = `The rows take the unit balance from ${format(dec(scheme.open))} to ${format(calculated)}, but the statement's closing balance is ${format(dec(scheme.close))}, ${format(gap)} units apart: a row was probably dropped or misread.`;
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
          ? `This reversal's purchase isn't in the statement, so the reversal isn't imported. If Wealthfolio has that purchase, delete it and its cash in the fund account. ${REVERSAL_CASH_NOTE}`
          : `${candidates.length} purchases in the statement could be the one this reverses, so the reversal isn't imported. Delete the reversed purchase and its cash in the fund account after importing. ${REVERSAL_CASH_NOTE}`;
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

/** #1: a merger is imported as a fund conversion only when both legs can be matched. */
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
      leg.problem ??= `Can't match this merger with its other half: the folio has ${plural(outs.length, "merger sale")} and ${plural(ins.length, "merger purchase")} on this day.`;
    }
  }
}

/** The fund as the statement names it, by ISIN or else by registrar code. */
const statementFund = ({ scheme }: Scheme) => scheme.isin ?? `${scheme.rta}|${scheme.rta_code}`;
const confirmedFund = ({ target }: Scheme) => target && fundRef(target.asset.symbol, target.asset.exchangeMic);
/** The units × NAV Wealthfolio's import compares when it links a transfer in with a transfer out. */
const giftValue = ({ row }: Entry) => (row.units !== null && row.nav !== null ? mul(abs(dec(row.units)), dec(row.nav)) : undefined);
/** The folio number casparser reads from a gift's description: the folio's first run of digits. */
const folioNumber = (folio: string) => folio.match(/\d+/)?.[0];

/**
 * #1: a gift whose other side is in this statement too. Wealthfolio's import links a transfer out
 * and a transfer in of one day, symbol and value in two accounts, whatever else they say, so a gift
 * that another gift the other way could be taken for is left out.
 */
function matchGifts(schemes: Scheme[]) {
  const gifts = schemes.filter((s) => s.target).flatMap((s) => s.entries.filter((e) => e.kind === "gift"));
  const opposite = (a: Entry, b: Entry) => a.row.type !== b.row.type && a.row.date === b.row.date;
  // The import compares symbols without exchanges: two accounts, one day, symbol and value.
  const linkable = (a: Entry, b: Entry) => {
    const [x, y] = [giftValue(a), giftValue(b)];
    const symbol = a.scheme.target?.asset.symbol.trim().toUpperCase();
    return opposite(a, b) && !!symbol && symbol === b.scheme.target?.asset.symbol.trim().toUpperCase() &&
      a.scheme.target!.accountId !== b.scheme.target!.accountId && !!x && !!y && cmp(x, y) === 0;
  };
  // At least one side names the other's folio, and neither names another.
  const names = (a: Entry, b: Entry) => {
    const [x, y] = [folioNumber(a.scheme.folio.folio), folioNumber(b.scheme.folio.folio)];
    const { gift_folio: toB } = a.row;
    const { gift_folio: toA } = b.row;
    return (toB === y || toA === x) && (!toB || toB === y) && (!toA || toA === x);
  };
  const named = (a: Entry, b: Entry) =>
    a.scheme.folio !== b.scheme.folio && opposite(a, b) && statementFund(a.scheme) === statementFund(b.scheme) && names(a, b);
  const sides = (a: Entry, b: Entry) =>
    named(a, b) &&
    a.row.units !== null && b.row.units !== null && cmp(dec(a.row.units), neg(dec(b.row.units))) === 0 &&
    a.row.nav !== null && b.row.nav !== null && cmp(dec(a.row.nav), dec(b.row.nav)) === 0;
  for (const gift of gifts) {
    const candidates = gifts.filter((other) => sides(gift, other));
    const [other] = candidates;
    if (candidates.length === 1 && gifts.filter((g) => sides(other, g)).length === 1) gift.counterpart = other;
  }
  for (const gift of gifts) {
    // An unpaired other side, named but with other units or NAV, or none: one of the two rows is
    // misread. Two gifts between the same folios on one day pair by their own units first.
    const misread = gifts.filter((g) =>
      !gift.counterpart && !g.counterpart && named(gift, g) && !sides(gift, g));
    if (misread.length) {
      gift.problem ??= `This gift and its other side, in folio ${misread[0].scheme.folio.folio}, don't have opposite units and the same NAV, so neither side is imported. Check both rows against the PDF.`;
    }
    // A gift left out here takes its other side with it, in `pairGifts`.
    const rivals = gifts.filter((g) => g !== gift.counterpart && linkable(gift, g));
    if (rivals.length) {
      gift.problem ??=
        "Wealthfolio's import could link this gift with another gift the other way on this day, with the same symbol and value, that may not be its other side, so it isn't imported. Enter these gifts in Wealthfolio by hand.";
    }
  }
}

/**
 * A gift as a transfer of its units at the day's NAV, with no cash. On its own it's external: units
 * received cost their value that day, and units given leave at their cost in Wealthfolio.
 */
function giftRows(entry: Entry, target: SchemeTarget): NonNullable<Entry["rows"]> | string {
  const { row } = entry;
  const into = row.type === "GIFT_IN";
  if (entry.charges.length) {
    const names = [...new Set(entry.charges.map((charge) => CHARGES[charge.type]!.name))].join(" and ");
    return `This gift has ${names} on its day, which a transfer can't carry without a cash movement the statement doesn't show, so it isn't imported.`;
  }
  if (row.units === null || dec(row.units).n * (into ? 1n : -1n) <= 0n) return "This row has no units, or units with the wrong sign.";
  if (row.nav === null || dec(row.nav).n <= 0n) return "This gift has no NAV, so its value on the day isn't known and it isn't imported.";
  const quantity = row.units.replace(/^-/, "");
  const units = dec(quantity);
  const nav = dec(row.nav);
  const tolerance = add(mul(mul(nav, HALF), step(units.scale)), PAISA);
  const printed = row.amount === null ? undefined : abs(dec(row.amount));
  const differs = printed && cmp(abs(sub(printed, mul(units, nav))), tolerance) > 0;
  return {
    activity: {
      ...baseRow(entry, target),
      ...assetOf(entry, target),
      activityType: into ? "TRANSFER_IN" : "TRANSFER_OUT",
      quantity,
      unitPrice: row.nav,
      isExternal: true,
    },
    note: differs
      ? `The statement's ₹${format(printed)} differs from ${quantity} units × NAV ${row.nav} by more than the units' rounding. It's imported at NAV ${row.nav}.`
      : undefined,
  };
}

/**
 * Both sides of a gift go together, in two accounts, as a transfer Wealthfolio links: the
 * receiving account keeps the giving account's costs and purchase dates. When the user leaves one
 * side's folio or fund out, the other is a gift on its own.
 */
function pairGifts(schemes: Scheme[], fails: (entry: Entry) => boolean, input: MappingInput) {
  const gifts = schemes.flatMap((s) => s.entries.filter((e) => e.kind === "gift"));
  for (const out of gifts.filter((g) => g.counterpart && g.row.type === "GIFT_OUT")) {
    const into = out.counterpart!;
    const failed = [out, into].filter(fails);
    const problem = failed.length
      ? "The other side of this gift can't be imported, so neither side is."
      : confirmedFund(out.scheme) !== confirmedFund(into.scheme)
        ? "The two sides of this gift are confirmed as different Wealthfolio assets, so neither side is imported. Choose Change beside each and confirm the same fund for both."
        : out.scheme.target!.accountId === into.scheme.target!.accountId
          ? [out, into].some((side) => side.rows && input.entered?.(side.rows.activity))
            ? "Both sides of this gift go to the same Wealthfolio account, so its units stay there and neither side is imported. Wealthfolio has a transfer or trade of these units on this day, which changes their cost and purchase dates: delete it, with its other side or cash."
            : "Both sides of this gift go to the same Wealthfolio account, so its units stay there and neither side is imported."
          : undefined;
    for (const side of [out, into]) if (problem && !failed.includes(side)) side.problem = problem;
  }
  for (const gift of gifts) {
    const { rows } = gift;
    if (!rows || gift.problem) continue;
    const notes = [rows.note];
    if (gift.counterpart) {
      delete rows.activity.isExternal;
      if (gift.row.type === "GIFT_OUT") {
        notes.unshift(`A gift to folio ${gift.counterpart.scheme.folio.folio}: Wealthfolio links this transfer out with that folio's transfer in, so the units keep the costs and purchase dates Wealthfolio has for them here.`);
        notes.push(gift.counterpart.rows?.note);
      }
    } else if (gift.row.type === "GIFT_IN") {
      notes.unshift(`Imported at NAV ${gift.row.nav}, the units' value on the day of the gift: Wealthfolio counts their cost and holding period from that day. For tax, a gift keeps the giver's cost and purchase dates, which the statement doesn't show.`);
    }
    rows.note = notes.filter(Boolean).join(" ") || undefined;
  }
}

/**
 * A segregated portfolio: casparser credits its units in `SEGREGATION` rows, or its name has its own
 * marker, "Segregated Portfolio" or a dated note such as AMFI's "(Segregated - 06032020)". A main
 * fund's note counting its segregated portfolios, such as AMFI's "(no. of segregated portfolio-1)",
 * doesn't make it one.
 */
const segregated = ({ scheme }: Scheme) =>
  scheme.transactions.some((row) => row.type === "SEGREGATION") || hasSegregatedMarker(scheme.scheme);

/**
 * #1: a segregated portfolio confirmed as the same Wealthfolio asset as a fund that isn't one, such as
 * its main fund found by name, would add its units to that fund and sell them at its own NAV.
 */
function checkSegregated(schemes: Scheme[]) {
  for (const state of schemes.filter((s) => s.target && !s.problem && segregated(s))) {
    const other = schemes.find((s) => s.target && !segregated(s) && confirmedFund(s) === confirmedFund(state));
    if (other) {
      state.problem = `This segregated portfolio is confirmed as the same Wealthfolio asset as ${other.scheme.scheme}, so its transactions are left out. Choose Change on its fund and confirm the segregated portfolio's own fund: search its ISIN or AMFI scheme code.`;
      state.problemKind = "scheme";
    }
  }
}

const SEGREGATION_NOTE =
  "Units credited in a segregated portfolio, imported at a stand-in cost of ₹0 with no cash. For tax, they cost the main portfolio units' cost × the segregated assets' NAV ÷ the whole portfolio's NAV just before segregation, and the main portfolio units' cost goes down by as much, but the statement doesn't give these NAVs. Wealthfolio can't move part of a holding's cost to another fund, so the main fund keeps its whole cost there: unless that share is zero, each fund's cost and later gains in Wealthfolio differ from those for tax. Wealthfolio also counts these units' holding period from this day; for tax, they're held from when the main portfolio's units were bought.";

/** On a later statement too, where the credit is in Wealthfolio already. */
const SEGREGATED_PAYOUT =
  "A payout from a segregated portfolio: Wealthfolio counts its gain against the cost it has for these units, a stand-in ₹0 if the add-on imported them. For tax, they cost a share of the main portfolio units' cost and are held from when those were bought.";

/**
 * #1: units a segregated portfolio credits, as a purchase with a zero total: no cash moves, and
 * the units cost ₹0 until the user corrects it. No unit price, which Wealthfolio would save as the
 * day's NAV of a fund priced by hand.
 */
function segregationRows(entry: Entry, target: SchemeTarget): NonNullable<Entry["rows"]> | string {
  const { row } = entry;
  if (entry.charges.length) {
    const names = [...new Set(entry.charges.map((charge) => CHARGES[charge.type]!.name))].join(" and ");
    return `This segregated portfolio credit has ${names} on its day, which a purchase at ₹0 can't carry without a cash movement the statement doesn't show, so it isn't imported.`;
  }
  if (row.units === null || dec(row.units).n <= 0n) return "This row has no units, or units with the wrong sign.";
  if (row.amount !== null && !isZero(dec(row.amount))) {
    return `This segregated portfolio row lists ₹${format(abs(dec(row.amount)))}, which units credited without a payment don't have, so it isn't imported. Check it against the PDF.`;
  }
  return {
    activity: { ...baseRow(entry, target), ...assetOf(entry, target), activityType: "BUY", quantity: row.units, amount: "0" },
    note: SEGREGATION_NOTE,
    standIns: ["amount"],
  };
}

function reversalMessage(original: Entry, input: MappingInput) {
  const { rows } = original;
  if (original.kind === "sell") {
    const putBack = "A later row has the opposite units and amount to this redemption. This could be a reversal or a new purchase, so neither row is imported. Check the statement and handle these rows by hand.";
    if (rows && (input.alreadyImported(rows.activity) || (rows.cash && input.alreadyImported(rows.cash)))) {
      return `${putBack} Wealthfolio has the sale or its cash from an earlier import; delete the fund rows only if this is a reversal. ${REVERSAL_CASH_NOTE}`;
    }
    return rows ? putBack : `${putBack} If Wealthfolio has the sale or its cash from an earlier import, delete the fund rows only if this is a reversal. ${REVERSAL_CASH_NOTE}`;
  }
  if (!rows) {
    return `The statement reverses this purchase, so neither row is imported. If Wealthfolio has the purchase from an earlier import, delete it and its cash in the fund account. ${REVERSAL_CASH_NOTE}`;
  }
  if (input.alreadyImported(rows.activity) || (rows.cash && input.alreadyImported(rows.cash))) {
    return `Wealthfolio has this purchase from an earlier import, but the statement reverses it. Delete that purchase and its cash in the fund account; neither row is imported. ${REVERSAL_CASH_NOTE}`;
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

const baseRow = (entry: Entry, target: SchemeTarget) => ({
  accountId: target.accountId,
  currency: CURRENCY,
  date: entry.row.date,
  isDraft: false,
  isValid: true,
});

const assetOf = (entry: Entry, target: SchemeTarget) => ({
  symbol: target.asset.symbol,
  exchangeMic: target.asset.exchangeMic,
  quoteCcy: target.asset.quoteCcy,
  instrumentType: target.asset.instrumentType,
  providerId: target.asset.providerId,
  providerSymbol: target.asset.providerSymbol,
  symbolName: entry.scheme.scheme.scheme,
});

/**
 * One fund's side of a merger, as a row of a fund conversion: the new fund's units keep the old
 * ones' cost and purchase dates, and no cash moves. Wealthfolio pairs the two rows by their group,
 * and refuses either without the other.
 */
function conversionRows(entry: Entry, target: SchemeTarget): NonNullable<Entry["rows"]> | string {
  const { row, partner } = entry;
  const leaving = row.type === "SWITCH_OUT_MERGER";
  const other = partner!.scheme.target;
  if (!other) return "The other half of this merger can't be imported, so neither half is.";
  if (entry.charges.length) {
    const names = [...new Set(entry.charges.map((charge) => CHARGES[charge.type]!.name))].join(" and ");
    return `This merger lists ${names}, which a fund conversion in Wealthfolio can't carry, so neither half is imported.`;
  }
  if (row.units === null || dec(row.units).n * (leaving ? -1n : 1n) <= 0n) return "This row has no units, or units with the wrong sign.";
  if (other.accountId !== target.accountId) {
    return "This merger's funds go to different Wealthfolio accounts, and a fund conversion stays in one, so neither half is imported.";
  }
  if (fundRef(other.asset.symbol, other.asset.exchangeMic) === fundRef(target.asset.symbol, target.asset.exchangeMic)) {
    return "Both funds of this merger are confirmed as the same Wealthfolio asset, so neither half is imported. Choose Change beside each and confirm each scheme's own fund.";
  }
  const [out, into] = leaving ? [entry, partner!] : [partner!, entry];
  const earlier = row.nav !== null && dec(row.nav).n > 0n
    ? buildRows({ ...entry, row: { ...row, amount: format(mul(dec(row.units), dec(row.nav))) } }, target)
    : buildRows(entry, target);
  return {
    activity: {
      ...baseRow(entry, target),
      ...assetOf(entry, target),
      activityType: "ADJUSTMENT",
      subtype: leaving ? "CONVERSION_OUT" : "CONVERSION_IN",
      quantity: row.units.replace(/^-/, ""),
      sourceGroupId: mergerGroup(target.accountId, out, into),
    },
    earlier: typeof earlier === "string"
      ? [
          { ...baseRow(entry, target), ...assetOf(entry, target), activityType: leaving ? "SELL" : "BUY", quantity: row.units.replace(/^-/, "") },
          { ...baseRow(entry, target), activityType: leaving ? "WITHDRAWAL" : "DEPOSIT", symbol: "" },
        ]
      : [earlier.activity, earlier.cash!],
  };
}

/**
 * The same for a merger on every statement that lists it, and different for each merger: a folio
 * has one on a day at most, or `matchMergers` leaves them out. Wealthfolio's groups span accounts,
 * so the account goes in too: importing the folio into another account makes another conversion.
 * The folio number goes in hashed, which keeps it out of view, not secret.
 */
function mergerGroup(accountId: string, out: Entry, into: Entry) {
  // A statement can omit the ISIN or print another registrar code for the same confirmed fund.
  const fund = ({ target }: Scheme) => fundRef(target!.asset.symbol, target!.asset.exchangeMic);
  const folio = out.scheme.folio.folio.replace(/\s+/g, "");
  const key = [accountId, folio, out.row.date, fund(out.scheme), fund(into.scheme)].join("|");
  return `cas-importer-merger:${sha256(`cas-importer merger ${key}`)}`;
}

/**
 * #5: each statement row's ID, the same on every statement that lists the row and different for
 * every other row: a hash of its folio, day, units and amount, and how many equal transaction rows
 * of the folio come before it. Charge and unsupported rows don't count: they make no activity to
 * match. A day's rows are all on a statement or all off it, so that count holds. The fund
 * is left out, as one statement can omit its ISIN or print another registrar code than another
 * (see `mergerGroup`), and the confirmed fund can change; so is the fund house, whose printed name
 * changes when it's renamed. Two funds' rows in one folio, or two fund houses' folios with the same
 * number, are equal only with the same units and amount on one day: the count tells those apart,
 * though statements that list them in another order can swap which equal activity each matches.
 * casparser's type is left out too, as a later casparser can read the same row as another type.
 */
function rowIds(schemes: Scheme[]) {
  const ids = new Map<Scheme, string[]>();
  const counts = new Map<string, number>();
  const value = (d: string | null) => (d === null ? "" : format(dec(d)));
  for (const state of schemes) {
    const { folio, scheme } = state;
    ids.set(state, scheme.transactions.map((row) => {
      const key = [folio.folio.replace(/\s+/g, ""), row.date, value(row.units), value(row.amount)].join("|");
      const count = counts.get(key) ?? 0;
      if (KINDS[row.type]) counts.set(key, count + 1);
      return sha256(`cas-importer row ${key}|${count}`);
    }));
  }
  return ids;
}

/** A PAN: five letters, four digits and a letter. */
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;

/**
 * The statement row's ID on each activity it makes: its transaction, the transaction's cash and
 * the bank's side of that, each with its own suffix, since Wealthfolio matches IDs per account.
 * Each carries what the statement says about the row, without PANs, which Wealthfolio keeps with
 * the activity.
 */
function identify(rows: NonNullable<Entry["rows"]>, entry: Entry, id: string): NonNullable<Entry["rows"]> {
  const { folio, scheme } = entry.scheme;
  const { type, description } = entry.row;
  const tag = <T extends ActivityImport | undefined>(row: T, suffix = "") =>
    row && {
      ...row,
      sourceRecordId: `${id}${suffix}`,
      metadata: { folio: folio.folio, registrar: scheme.rta, casparserType: type, description: description.replace(PAN, "[PAN]") },
    };
  return { ...rows, activity: tag(rows.activity), cash: tag(rows.cash, ":cash"), bank: tag(rows.bank, ":bank") };
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
  const lines: ActivityCharge[] = [];
  for (const charge of entry.charges) {
    if (charge.amount === null || dec(charge.amount).n <= 0n) return "One of this transaction's charges has no positive amount.";
    charges = add(charges, dec(charge.amount));
    lines.push({ category: "tax", label: CHARGES[charge.type]!.label, amount: format(dec(charge.amount)) });
  }
  const names = `₹${format(charges)} ${[...new Set(entry.charges.map((charge) => CHARGES[charge.type]!.name))].join(" and ")}`;
  const base = baseRow(entry, target);
  const tax = isZero(charges) ? {} : { tax: format(charges), charges: lines };
  const asset = assetOf(entry, target);
  // A purchase is paid from the bank account and a redemption or payout paid into it, when there
  // is one; a switch's or merger's money stays with the fund house.
  const bankAccountId = BANKED.has(row.type) ? target.bankAccountId : undefined;
  /** The cash rows for `amount` moving into the fund account, or out of it. */
  const cash = (into: boolean, amount: Dec) => {
    const cashRow = (accountId: string, activityType: ActivityType): ActivityImport => ({
      ...base,
      accountId,
      activityType,
      symbol: "",
      amount: format(amount),
    });
    if (!bankAccountId) return { cash: cashRow(target.accountId, into ? "DEPOSIT" : "WITHDRAWAL") };
    return {
      cash: cashRow(target.accountId, into ? "TRANSFER_IN" : "TRANSFER_OUT"),
      bank: cashRow(bankAccountId, into ? "TRANSFER_OUT" : "TRANSFER_IN"),
    };
  };

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
      ...cash(false, final),
    };
  }

  if (row.units === null || dec(row.units).n * sign <= 0n) return "This row has no units, or units with the wrong sign.";
  if (row.nav === null || dec(row.nav).n <= 0n) return "This row has no NAV.";
  // The printed units and NAV are authoritative. Wealthfolio keeps an amount equal to
  // quantity × unit price ± charges, and flags any other for review.
  // shortcut: casparser 1.4.1 doesn't mark NAVs derived from amount ÷ units; until it does,
  // they are used as printed NAVs, treating the amount as before charges (#90).
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
    ...cash(kind === "buy", final),
    note,
  };
}
