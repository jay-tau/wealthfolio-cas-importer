import type { ActivityDetails, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import { abs, add, cmp, dec, type Dec, div, format, isZero, mul, step, sub } from "./decimal.ts";
import type { FundAsset } from "./mapping.ts";
import { countUnits, fundRef, localDay, sameUnits, statementDay } from "./plan.ts";
import { type CasData, type DepositoryData, isDepository, type Statement } from "./types.ts";

// A summary or NSDL/CDSL statement's holdings → the snapshots saved to Wealthfolio accounts that
// track holdings. Wealthfolio's snapshot is the account's whole state on its date, so each one
// starts from the account's latest snapshot: the statement's holdings replace their own, and
// the account's other holdings and cash carry over unless an earlier import of the same folio,
// demat account or PRAN put them there. Pure: the user's choices come in, snapshots come out.

const CURRENCY = "INR";
/** Decimals of the average cost sent to Wealthfolio, which multiplies it back by the units. */
const COST_PLACES = 20;

export type HoldingKind = "fund" | "share" | "bond" | "nps";

/** A fund in a folio, a fund, share or bond in a demat account, or an NPS scheme under a PRAN. */
export interface StatementHolding {
  kind: HoldingKind;
  isin: string | null;
  /** The registrar and its scheme code, for a summary statement's fund without an ISIN. */
  rta: string | null;
  rtaCode: string | null;
  /** An NPS scheme's symbol (`npsSymbol`), its identity without an ISIN. */
  code?: string;
  name: string;
  units: string;
  /** The price of one unit, share or bond. */
  price: string;
  value: string;
  /** Printed total cost. A printed zero is taken as unknown. */
  cost: string | null;
  /**
   * What the statement prints about the holding, as printed, to keep on its asset: a bond's or NPS
   * scheme's details, and a fund's or share's name and identifiers.
   */
  details?: Record<string, string>;
}

/** A folio, a demat account or a PRAN. The statement lists every holding in it, so each goes to one account. */
export interface Source {
  /** Stable across statements; hashed before it's stored. */
  id: string;
  /** Issuer-scoped folio links; [] severs old links, undefined retains learned ones. */
  aliases?: string[];
  kind: "folio" | "demat" | "nps";
  label: string;
  holdings: StatementHolding[];
  /** Holdings printed with zero units: checked against transactions, never put in a snapshot. */
  zero?: StatementHolding[];
  /**
   * Summary statement lines that may have been misread: kept to reconcile their identifiers, never
   * put in a snapshot. Their asset's holding stays as it is.
   */
  misread?: StatementHolding[];
}

export interface LeftOutLine {
  source: string;
  name: string;
  reason: string;
}

export interface Holdings {
  /** The statement's date, `2025-03-31`. */
  date: string;
  /** Whose statement it is: the first holder's PAN, or the summary statement's email or name. */
  investor: string;
  sources: Source[];
  leftOut: LeftOutLine[];
}

const positive = (value: string | null | undefined) => value != null && value !== "" && dec(value).n > 0n;
const nonzero = (value: string | null | undefined) => value != null && value !== "" && !isZero(dec(value));
const zero = (value: string | null | undefined) => value != null && value !== "" && isZero(dec(value));
const printedCost = (value: string | null | undefined) => (positive(value) ? format(dec(value!)) : null);

/** Whether the holding has units. One without is left out; a printed zero still gets checked. */
function withUnits(leftOut: LeftOutLine[], label: string, source: Source, h: StatementHolding) {
  if (positive(h.units)) return true;
  leftOut.push({ source: label, name: h.name, reason: "No units on the statement." });
  if (zero(h.units)) (source.zero ??= []).push(h);
  return false;
}

const PAISA = dec("0.01");
const HALF = dec("0.5");

/**
 * Why a summary statement's line may have been misread, or undefined when its units × NAV give its
 * value to the paisa plus the units' and NAV's rounding, or it has neither units nor value. casparser
 * reads a cell it can't read as 0, and a number too wide for its column without its leading
 * digits, without a warning.
 */
function misread(h: StatementHolding) {
  if (!positive(h.units)) return positive(h.value) ? `It has no units but a value of ₹${h.value}` : undefined;
  if (!positive(h.price)) return `It has ${h.units} units but no NAV`;
  const units = dec(h.units);
  const nav = dec(h.price);
  const halfUnit = mul(HALF, step(units.scale));
  const halfNav = mul(HALF, step(nav.scale));
  const tolerance = add(add(mul(nav, halfUnit), mul(add(units, halfUnit), halfNav)), PAISA);
  if (cmp(abs(sub(mul(units, nav), dec(h.value || "0"))), tolerance) <= 0) return undefined;
  return `Its value of ₹${h.value || "0"} differs from ${h.units} units × NAV ${h.price} by more than the units' and NAV's rounding`;
}

/** Keep both identities: a later summary can omit an ISIN that was printed before. */
export const security = (h: StatementHolding) => [
  ...(h.isin ? [h.isin] : []),
  ...(h.rta && h.rtaCode ? [`${h.rta}|${h.rtaCode}`] : []),
  ...(h.code ? [`nps|${h.code}`] : []),
];

// Words that every pension fund manager's or scheme's name repeats. "NPS TRUST" and "A/C" go
// as phrases, since A and C on their own are asset classes.
const NPS_FILLER = new Set(["PENSION", "FUND", "FUNDS", "MANAGEMENT", "PRIVATE", "PVT", "LIMITED", "LTD", "COMPANY", "SCHEME"]);
const TIERS: Record<string, string> = { "1": "I", "2": "II" };

/**
 * An NPS scheme's symbol in Wealthfolio, from its printed name: the statement prints no scheme
 * code. "NPS TRUST- A/C SBI PENSION FUNDS PRIVATE LIMITED SCHEME E - TIER I" → "NPS-SBI-E-TIER-I".
 */
export function npsSymbol(scheme: string) {
  const words = scheme.toUpperCase().replace(/\bNPS\s+TRUST\b/g, " ").replace(/\bA\s*\/\s*C\b/g, " ").split(/[^A-Z0-9]+/).filter(Boolean);
  const kept = words.map((w, i) => (words[i - 1] === "TIER" && TIERS[w]) || w).filter((w) => !NPS_FILLER.has(w));
  return ["NPS", ...kept].join("-");
}

/**
 * The symbol of a summary statement's fund without an ISIN, priced from statements: its registrar
 * and scheme code, "KFINTECH" and "TONDG" → "MF-KFINTECH-TONDG". Undefined without both.
 */
export function registrarSymbol(rta: string | null, code: string | null) {
  const parts = [rta, code].map((part) => (part ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  return parts.every(Boolean) ? ["MF", ...parts].join("-") : undefined;
}

// Wealthfolio stores funds as EQUITY too; MUTUALFUND is what its search calls them.
const TYPES: Record<HoldingKind, string> = { fund: "MUTUALFUND", share: "EQUITY", bond: "BOND", nps: "EQUITY" };

/**
 * The INR asset priced by hand from statements, offered when no search result fits: a fund, share
 * or bond by its ISIN, a summary statement's fund without one by its registrar and scheme code,
 * and an NPS scheme by its symbol.
 */
export function statementAsset(h: StatementHolding): ChosenAsset | undefined {
  const symbol = h.kind === "nps" ? h.code : (h.isin ?? (h.kind === "fund" ? registrarSymbol(h.rta, h.rtaCode) : undefined));
  if (!symbol) return undefined;
  return { symbol, quoteCcy: CURRENCY, instrumentType: TYPES[h.kind], name: h.name, manual: true, statementPrices: true };
}

/** Printed details, without the ones the statement leaves blank. */
const printed = (details: Record<string, string | null | undefined>) =>
  Object.fromEntries(Object.entries(details).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

/**
 * A CDSL statement prints a folio's fund as "<scheme code> - <scheme name>", and casparser keeps
 * the code, which it finds with the same pattern. "FMCDG - Fictiva Midcap Fund - Direct Plan -
 * Growth" → "Fictiva Midcap Fund - Direct Plan - Growth".
 */
const withoutSchemeCode = (name: string) => name.replace(/^\s*[A-Z0-9]+\s*-\s*/, "") || name;

/** The same folio prints as `91234567 / 12` on CAMS statements and `91234567/12` on NSDL ones. */
export const folioNumber = (folio: string) => folio.replace(/\s+/g, "");

// Indian mutual-fund ISINs identify the issuer in their first seven characters.
const issuerOf = (isin: string | null) => isin?.startsWith("INF") ? isin.slice(0, 7) : undefined;

export function readHoldings(statement: Statement): Holdings {
  return isDepository(statement) ? readDepository(statement) : readSummary(statement);
}

function readSummary(data: CasData): Holdings {
  const leftOut: LeftOutLine[] = [];
  const sources = new Map<string, Source>();
  for (const folio of data.folios) {
    const label = `${folio.amc}, folio ${folio.folio}`;
    const number = folioNumber(folio.folio);
    const id = `folio|${number}|amc:${folio.amc}`;
    const source: Source = sources.get(id) ?? { id, kind: "folio", label, holdings: [] };
    // casparser keys summary folios by number alone, so funds from several issuers may be two
    // AMCs' folios merged into one. Such a folio isn't linked to depository folios.
    const issuers = new Set([...source.holdings, ...folio.schemes].map((s) => issuerOf(s.isin)).filter(Boolean));
    source.aliases = issuers.size === 1 ? [`folio|${number}|${[...issuers][0]}`] : issuers.size > 1 ? [] : undefined;
    sources.set(id, source);
    for (const scheme of folio.schemes) {
      const holding: StatementHolding = {
        kind: "fund",
        isin: scheme.isin,
        rta: scheme.rta,
        rtaCode: scheme.rta_code,
        name: scheme.scheme,
        units: scheme.close,
        price: scheme.valuation.nav,
        value: scheme.valuation.value,
        cost: printedCost(scheme.valuation.cost),
        details: printed({ name: scheme.scheme, isin: scheme.isin, registrar: scheme.rta, schemeCode: scheme.rta_code }),
      };
      const why = misread(holding);
      if (why) {
        leftOut.push({ source: label, name: holding.name, reason: `${why}, so the line may have been misread. Check it against the PDF. The import leaves this holding as it is.` });
        (source.misread ??= []).push(holding);
      } else if (withUnits(leftOut, label, source, holding)) source.holdings.push(holding);
    }
  }
  return {
    date: statementDay(data.statement_period.to),
    investor: (data.investor_info.email || data.investor_info.name).trim().toLowerCase(),
    sources: [...sources.values()],
    leftOut,
  };
}

function readDepository(data: DepositoryData): Holdings {
  const leftOut: LeftOutLine[] = [];
  const sources: Source[] = [];
  const fund = (f: DepositoryData["accounts"][number]["mutual_funds"][number]): StatementHolding => ({
    kind: "fund",
    isin: f.isin,
    rta: null,
    rtaCode: null,
    name: f.name ?? f.isin,
    units: f.balance,
    price: f.nav,
    value: f.value,
    cost: printedCost(f.total_cost) ?? (positive(f.avg_cost) ? format(mul(dec(f.avg_cost!), dec(f.balance))) : null),
    details: printed({ name: f.name, isin: f.isin }),
  });
  let dematNumber = 0;

  for (const account of data.accounts) {
    if (account.type === "Mutual Fund Folios") {
      const folios = new Map<string, Source>();
      for (const f of account.mutual_funds) {
        const number = folioNumber(f.folio ?? "");
        const label = number ? `Folio ${number}` : "Mutual fund folios";
        const holding = fund(f);
        // The search and a new asset go by the scheme name; the printed details keep the code.
        if (data.file_type === "CDSL" && f.name) holding.name = withoutSchemeCode(f.name);
        const id = `folio|${number}|${issuerOf(f.isin) ?? `isin:${f.isin}`}`;
        const source = folios.get(id) ?? { id, kind: "folio", label, holdings: [] };
        if (withUnits(leftOut, label, source, holding)) source.holdings.push(holding);
        folios.set(id, source);
      }
      sources.push(...folios.values());
      continue;
    }
    const label = `${account.type} ${++dematNumber}, ${account.name}`.replace(/\s+/g, " ");
    const source: Source = { id: `demat|${account.dp_id ?? ""}|${account.client_id ?? ""}`, kind: "demat", label, holdings: [] };
    source.holdings = [
      ...account.equities.map(
        (e): StatementHolding => ({
          kind: "share",
          isin: e.isin,
          rta: null,
          rtaCode: null,
          name: e.name ?? e.isin,
          units: e.num_shares,
          price: e.price,
          value: e.value,
          cost: null,
          details: printed({ name: e.name, isin: e.isin }),
        }),
      ),
      ...account.mutual_funds.map(fund),
      ...account.bonds.map(
        (b): StatementHolding => ({
          kind: "bond",
          isin: b.isin,
          rta: null,
          rtaCode: null,
          name: b.name ?? b.isin,
          units: b.num_bonds,
          // NSDL demat accounts print each bond's value but not its price.
          price: b.market_price ?? (positive(b.num_bonds) ? format(div(dec(b.value), dec(b.num_bonds), 6)) : "0"),
          value: b.value,
          cost: null,
          details: printed({
            name: b.name, isin: b.isin, couponRate: b.coupon_rate, couponFrequency: b.coupon_frequency,
            maturityDate: b.maturity_date, faceValue: b.face_value,
          }),
        }),
      ),
    ].filter((h) => withUnits(leftOut, label, source, h));
    sources.push(source);
  }
  const owner = data.accounts.flatMap((a) => a.owners)[0];
  const investor = (owner?.PAN || data.investor_info.name).trim().toUpperCase();
  if (data.nps) {
    // The PRAN is printed masked, but it's what the statement has to tell PRANs apart. Without
    // one, the investor's: a person has one PRAN.
    const pran = data.nps.pran?.trim();
    const label = pran ? `NPS, PRAN ${pran}` : "National Pension System";
    const source: Source = { id: pran ? `nps|${pran}` : `nps|investor:${investor}`, kind: "nps", label, holdings: [] };
    source.holdings = data.nps.schemes.map(
      (s): StatementHolding => ({
        kind: "nps",
        isin: null,
        rta: null,
        rtaCode: null,
        code: npsSymbol(s.scheme),
        name: s.scheme,
        units: s.units,
        price: s.nav,
        value: s.value,
        cost: null,
        details: printed({ scheme: s.scheme, fundManager: s.fund_manager, tier: s.tier, assetClass: s.asset_class }),
      }),
    ).filter((h) => withUnits(leftOut, label, source, h));
    sources.push(source);
  }
  return {
    date: statementDay(data.statement_period.to),
    investor,
    sources,
    leftOut,
  };
}

/** The holding's asset: what the user confirmed from `market.searchTicker`, or one priced from statements. */
export interface ChosenAsset extends FundAsset {
  assetId?: string;
  name: string;
  manual?: boolean;
  /** Priced by hand from each statement's prices, when no search result fits. */
  statementPrices?: boolean;
}

/** A position in the snapshot an import starts from. */
export interface ExistingPosition {
  assetId: string;
  symbol: string;
  /** `fundRef` of the asset's symbol and exchange. */
  ref: string;
  name: string;
  units: string;
  /** Total cost; null when Wealthfolio has none. */
  cost: string | null;
  currency: string;
  /** Priced by hand: saving a nonzero average cost writes it as the asset's price on the snapshot's date. */
  manual?: boolean;
  /** For a manual-priced asset, its latest quote on or before the statement's date. */
  price?: { close: string; currency: string };
  /** A split was recorded since the snapshot, so its units and cost predate it. */
  split?: boolean;
}

export interface ExistingSnapshot {
  /** The latest snapshot on or before the statement's date; null when there's none. */
  date: string | null;
  positions: ExistingPosition[];
  cash: Record<string, string>;
  /** Snapshots after the statement's date. */
  later: string[];
}

/**
 * Assets of an older snapshot whose units and cost may predate a recorded split.
 * A split counts on its `localDay` in `timeZone`, from `engineTimeZone`; one with an unreadable date
 * is flagged. Splits in archived accounts are hidden from add-ons, so they go unnoticed.
 */
export function splitSince(existing: ExistingSnapshot, date: string, activities: ActivityDetails[], timeZone: string) {
  const split = new Set<string>();
  if (!existing.date || existing.date >= date) return split;
  const ids = new Set(existing.positions.map((p) => p.assetId));
  for (const a of activities) {
    if (!a.assetId || !ids.has(a.assetId) || (a.status !== undefined && a.status !== "POSTED")) continue;
    if (a.activityType !== "SPLIT" && !("activityTypeOverride" in a && a.activityTypeOverride === "SPLIT")) continue;
    const time = a.date == null ? NaN : new Date(a.date).getTime();
    const bare = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date);
    // An impossible bare date or a timestamp without an offset has no known day.
    const readable = Number.isFinite(time) && (typeof a.date !== "string" ||
      (bare ? new Date(time).toISOString().slice(0, 10) === a.date : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(a.date)));
    const day = readable ? localDay(a.date, timeZone) : undefined;
    if (day === undefined || (day >= existing.date && day <= date)) split.add(a.assetId);
  }
  return split;
}

export interface OtherAccount {
  name: string;
  /** False for an account that tracks holdings. */
  tracksTransactions: boolean;
}

export interface PlanInput {
  /** The account a source goes to; undefined leaves it out. */
  account(source: Source): string | undefined;
  /** Undefined leaves the holding out. */
  asset(holding: StatementHolding): ChosenAsset | undefined;
  existing(accountId: string): ExistingSnapshot;
  /**
   * What an earlier import put into the baseline snapshot: `fundRef` → security identities. Asked
   * for the folios, demat accounts and PRANs this import leaves out too.
   */
  remembered(source: Source, accountId: string): ReadonlyMap<string, string[]>;
  /** Other accounts that hold this asset now. */
  heldElsewhere(ref: string, accountId: string): OtherAccount[];
  /**
   * What earlier imports of the investor's statements put into the account's baseline snapshot from
   * folios, demat accounts and PRANs this statement doesn't list, as far as the add-on indexed them.
   */
  unlisted?(accountId: string): Unlisted[];
}

/**
 * An earlier import's record of a folio, demat account or PRAN that the statement doesn't list:
 * only hashed storage keys identify the linked records.
 */
export interface Unlisted {
  keys: string[];
  /** `fundRef` → security identities, as `remembered` gives them. */
  remembered: ReadonlyMap<string, string[]>;
}

/** A holding as a folio, demat account or PRAN lists it. */
export interface Line {
  source: Source;
  holding: StatementHolding;
}

/** A bond's face value times the number of bonds stands in for its unprinted cost. */
export type CostSource = "statement" | "wealthfolio" | "face";

export interface PlannedPosition {
  /** The preview row, separate from the asset when overlapping folio units need their own toggle. */
  key: string;
  /** `fundRef` of the asset. */
  ref: string;
  name: string;
  /** Set when the account's snapshot has the asset. */
  existing?: ExistingPosition;
  /** The statement's lines for the asset; empty when only the account has it. */
  lines: Line[];
  /**
   * The statement's lines that may have been misread and may be this asset. With any, the account's
   * position stays as it is, without the statement's lines, and the user can't change that.
   */
  misread?: Line[];
  asset?: ChosenAsset;
  /** The statement's units, summed over its lines. */
  units?: string;
  value?: string;
  /** Total cost for the statement's units. Undefined when it's unknown. */
  cost?: { total: string; from: CostSource };
  /** Statement lines: whether they replace the account's units. Others: whether the account keeps them. */
  include: boolean;
  /**
   * Statement lines that an earlier import of their source added under other assets: the keys of
   * those positions. Importing these lines replaces them, so they stay unless these are imported.
   */
  replaces?: string[];
  /** The key of the statement's position whose import replaces this one. */
  replacedBy?: string;
  /** Accounts that track transactions and hold it, so its folio lines are left out by default. */
  heldBy?: OtherAccount[];
  /**
   * The folios, demat accounts or PRANs whose earlier import added the account's units of it, set
   * when keeping those units counts them twice: the holding they were added for is left out because
   * an account that tracks transactions holds it. Saving needs the user's choice to keep them, or
   * to remove them once all of them came from these sources.
   */
  removable?: Source[];
  notes: string[];
  /** Where the statement first lists it. */
  order: number;
}

export interface AccountPlan {
  accountId: string;
  date: string;
  existing: ExistingSnapshot;
  /** The statement's folios and demat accounts that go to this account. */
  sources: Source[];
  remembered: Map<string, ReadonlyMap<string, string[]>>;
  /** The statement's folios, demat accounts and PRANs this import leaves out, with what their earlier imports into this account recorded. */
  unread: { source: Source; remembered: ReadonlyMap<string, string[]> }[];
  /** The records of folios, demat accounts and PRANs the statement doesn't list. */
  unlisted: Unlisted[];
  positions: PlannedPosition[];
}

/** Each account's snapshot, before the user's changes in the preview. */
export function planSnapshots(holdings: Holdings, input: PlanInput): AccountPlan[] {
  const plans = new Map<string, AccountPlan & { byRef: Map<string, PlannedPosition>; misread: Line[] }>();
  // The folios, demat accounts and PRANs left out: the units their earlier imports added stay.
  const unread: Source[] = [];
  let order = 0;
  for (const source of holdings.sources) {
    const accountId = input.account(source);
    if (!accountId) {
      unread.push(source);
      continue;
    }
    let plan = plans.get(accountId);
    if (!plan) {
      const existing = input.existing(accountId);
      const duplicate = existing.positions.find((p, i) => existing.positions.findIndex((other) => other.ref === p.ref) !== i);
      if (duplicate) throw new Error(`The account's snapshot has multiple assets for ${duplicate.ref}. Resolve their identity in Wealthfolio or choose another account.`);
      const byRef = new Map(
        existing.positions.map((p): [string, PlannedPosition] => [
          p.ref,
          { key: p.ref, ref: p.ref, name: p.name, existing: p, lines: [], include: true, notes: [], order: Infinity },
        ]),
      );
      plan = {
        accountId, date: holdings.date, existing, sources: [], remembered: new Map(), unread: [],
        unlisted: input.unlisted?.(accountId) ?? [], positions: [], byRef, misread: [],
      };
      plans.set(accountId, plan);
    }
    plan.sources.push(source);
    plan.remembered.set(source.id, input.remembered(source, accountId));
    plan.misread.push(...(source.misread ?? []).map((holding) => ({ source, holding })));
    for (const holding of source.holdings) {
      const chosen = input.asset(holding);
      if (!chosen) continue;
      // A remembered statement-price choice can predate a corrected statement name.
      const asset = chosen.statementPrices ? { ...chosen, name: holding.name } : chosen;
      const ref = fundRef(asset.symbol, asset.exchangeMic);
      // A resolved asset ID wins over the symbol and exchange.
      const existing = plan.existing.positions.find((p) => asset.assetId ? p.assetId === asset.assetId : p.ref === ref);
      if (existing && existing.ref !== ref && !plan.byRef.get(existing.ref)?.lines.length) plan.byRef.delete(existing.ref);
      const overlap = source.kind === "folio" && input.heldElsewhere(ref, accountId).some((o) => o.tracksTransactions);
      const key = overlap ? `${ref}|overlap` : ref;
      const position = plan.byRef.get(key) ?? {
        key, ref, name: asset.name || holding.name, existing,
        lines: [], include: true, notes: [], order,
      };
      position.order = Math.min(position.order, order++);
      position.asset ??= asset;
      position.lines.push({ source, holding });
      plan.byRef.set(key, position);
    }
  }

  return [...plans.values()].map(({ byRef, misread, ...plan }) => {
    for (const [key, position] of byRef) {
      if (!position.lines.length && [...byRef.values()].some((p) => p.ref === position.ref && p.lines.length)) byRef.delete(key);
    }
    const positions = [...byRef.values()];
    holdBack(positions, misread, plan.remembered, input);
    const elsewhere = (position: PlannedPosition): Elsewhere => ({
      unread: unreadOf(position, unread, plan.accountId, input),
      unlisted: inRecords(position, plan.unlisted.map((u) => u.remembered)),
    });
    for (const position of positions) {
      if (position.misread) settleHeldBack(position);
      else if (position.lines.length) settleStatement(position, plan.accountId, input, elsewhere(position).unread);
    }
    for (const position of positions) {
      if (position.heldBy && position.existing) settleOverlap(position, positions, plan.sources, plan.accountId, input, elsewhere);
    }
    // The account's others last: an earlier import may have added one for a line the statement's now take.
    settleOthers(positions, plan.sources, plan.accountId, input, elsewhere);
    // The statement's holdings in its order, then the account's others in theirs.
    positions.sort((a, b) => a.order - b.order);
    return { ...plan, unread: unread.map((source) => ({ source, remembered: input.remembered(source, plan.accountId) })), positions };
  });
}

const sum = (values: string[]) => values.reduce((total, v) => add(total, dec(v)), dec("0"));

/**
 * Gives each misread line to the positions that may be its asset: the one the user confirmed for
 * it, any whose lines print one of its identifiers, and any an earlier import recorded under one.
 * Their lines would add up to only part of the account's units, so none of them changes.
 */
function holdBack(positions: PlannedPosition[], misread: Line[], remembered: AccountPlan["remembered"], input: PlanInput) {
  for (const line of misread) {
    const ids = new Set(security(line.holding));
    const shares = (list: readonly string[] | undefined) => !!list?.some((id) => ids.has(id));
    const chosen = input.asset(line.holding);
    const chosenRef = chosen && fundRef(chosen.symbol, chosen.exchangeMic);
    const refs = new Set(positions.filter((p) =>
      p.ref === chosenRef ||
      (chosen?.assetId !== undefined && p.existing?.assetId === chosen.assetId) ||
      p.lines.some((l) => shares(security(l.holding))) ||
      (p.existing && [...remembered.values()].some((r) => shares(r.get(p.ref)) || shares(r.get(p.existing!.ref)))),
    ).map((p) => p.ref));
    for (const p of positions) if (refs.has(p.ref)) (p.misread ??= []).push(line);
  }
}

const misreadIn = (lines: Line[]) =>
  `Its ${lines.length > 1 ? "lines" : "line"} in ${[...new Set(lines.map((l) => l.source.label))].join(" and ")} may have been misread`;
const checkPdf = (lines: Line[]) => `Check ${lines.length > 1 ? "them" : "it"} against the PDF.`;

/** A position a misread line may be: the account keeps it as it is, or doesn't get it. */
function settleHeldBack(position: PlannedPosition) {
  // Statement lines aren't imported; the account's position is kept.
  position.include = !position.lines.length;
  const misread = position.misread!;
  position.notes.push(
    position.existing
      ? `${misreadIn(misread)}, so this import leaves it as it is: its units, cost and price stay. ${checkPdf(misread)}`
      : `${misreadIn(misread)}, so it isn't imported. ${checkPdf(misread)}`,
  );
  if (position.existing?.split) {
    position.notes.push("A split was recorded since the account's snapshot, so these units predate it. Correct its units in Wealthfolio after saving.");
  }
  if (keepsAverageCost(position.existing) && position.existing!.price === undefined) {
    position.notes.push("It's priced by hand and has no price on or before this date. If no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date.");
  }
}

function settleStatement(position: PlannedPosition, accountId: string, input: PlanInput, unread: Source[]) {
  const holdings = position.lines.map((l) => l.holding);
  const units = sum(holdings.map((h) => h.units));
  position.units = format(units);
  position.value = format(sum(holdings.map((h) => h.value)));
  const printed = holdings.map((h) => h.cost);
  const before = position.existing;
  if (printed.every((c) => c !== null)) {
    position.cost = { total: format(sum(printed as string[])), from: "statement" };
  } else if (before?.split) {
    position.notes.push("A split was recorded since the account's snapshot, so its cost there doesn't fit these units. Enter the total cost, or leave it unknown.");
  } else if (before?.cost && nonzero(before.units)) {
    if (before.currency === CURRENCY) {
      const average = div(dec(before.cost), dec(before.units), COST_PLACES);
      position.cost = { total: format(mul(average, units)), from: "wealthfolio" };
    } else {
      position.notes.push(`The account's existing cost is in ${before.currency}. Enter a total cost in INR, or leave it unknown.`);
    }
  }
  const faces = holdings.map((h) => (h.kind === "bond" && positive(h.details?.faceValue) ? mul(dec(h.details!.faceValue), dec(h.units)) : null));
  if (!position.cost && faces.every((f) => f !== null)) {
    position.cost = { total: format(faces.reduce((total, f) => add(total, f!), dec("0"))), from: "face" };
  }
  if (printed.some((c) => c !== null) && printed.some((c) => c === null)) {
    position.notes.push("The statement prints a cost for only some of its lines for this holding.");
  }

  const others = input.heldElsewhere(position.ref, accountId);
  const tracked = others.filter((o) => o.tracksTransactions);
  // A folio's fund that an account tracking transactions holds most likely came from a detailed statement.
  const overlap = tracked.length > 0 && position.lines.some((l) => l.source.kind === "folio");
  const leftOut = overlap || unread.length > 0;
  if (pricedByHand(position)) {
    position.notes.push(statementPrice(position) !== undefined
      ? `Priced by hand: ${leftOut ? "importing this row" : "saving"} also saves the statement's price as its price on this date.`
      : `Priced by hand, but the statement prints no price for it. ${leftOut ? "If you keep or import it, enter" : "Enter"} its price for this date on its asset page after saving.`);
  }

  if (overlap) {
    position.include = false;
    position.heldBy = tracked;
    position.notes.push(
      `${alreadyHold(tracked)} this fund, from its transactions. Including it here counts it twice.`,
    );
  } else if (others.length) {
    position.notes.push(`${names(others)} also ${others.length === 1 ? "holds" : "hold"} it.`);
  }
  settleUnread(position, unread);
}

/** Whether one of the records lists the account's position, under its asset or the account's symbol. */
const inRecords = (position: PlannedPosition, records: ReadonlyMap<string, string[]>[]) => {
  const existing = position.existing;
  return !!existing && records.some((record) => record.has(position.ref) || record.has(existing.ref));
};

/**
 * The folios, demat accounts or PRANs this import leaves out whose earlier import recorded adding the
 * account's units of the position: some of those units may be theirs, which none of its lines count.
 */
const unreadOf = (position: PlannedPosition, unread: Source[], accountId: string, input: PlanInput) =>
  unread.filter((s) => inRecords(position, [input.remembered(s, accountId)]));

/** Imports that may have added some of the account's units of a position that its lines don't count. */
interface Elsewhere {
  /** The folios, demat accounts or PRANs this import leaves out, as `unreadOf` finds them. */
  unread: Source[];
  /** Whether a folio, demat account or PRAN the statement doesn't list recorded adding it. */
  unlisted: boolean;
}

/** Whether `labels` names more than one. */
const several = (sources: Iterable<Source>) => new Set([...sources].map((s) => s.label)).size > 1;
const holds = (sources: Source[]) => `${labels(sources)} ${several(sources) ? "hold" : "holds"}`;
const leavesOut = (sources: Source[]) => `An earlier import of ${labels(sources)}, which this import leaves out,`;
const onlyIfNoneIn = (sources: Source[]) => `only if ${labels(sources)} no longer ${several(sources) ? "hold" : "holds"} any`;
const UNLISTED = "a folio, demat account or PRAN that this statement doesn't list";

/**
 * A statement row whose lines would replace units that a left-out source's earlier import added: it's
 * left out by default, so the account keeps them, as it keeps that source's other holdings.
 */
function settleUnread(position: PlannedPosition, unread: Source[]) {
  if (!unread.length) return;
  const replaces = `Importing this row replaces the ${position.existing!.units} units this account holds with the statement's ${position.units}, which don't count any that ${holds(unread)}`;
  position.notes.push(`${leavesOut(unread)} recorded adding this holding. ${replaces}${position.include
    ? `, so it's left out by default. Import it ${onlyIfNoneIn(unread)}.`
    : "."}`);
  position.include = false;
  if (keepsAverageCost(position.existing) && position.existing!.price === undefined) {
    position.notes.push("It's priced by hand and has no price on or before this date. If no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date.");
  }
}

/** A source's listed holdings, possibly misread ones included. */
const listedIn = (s: Source) => [...s.holdings, ...(s.misread ?? [])];
/** Missing ISINs across formats can leave no common identity to compare. */
const incomparable = (s: Source, earlier: string[]) =>
  listedIn(s).some((h) => !security(h).some((id) => earlier.some((old) => old.includes("|") === id.includes("|"))));
const IMPORTS_DONT_RECORD = "imports don't record how many units each folio, demat account or PRAN added";

/**
 * A folio's holding left out because an account that tracks transactions holds it, when this
 * account's snapshot has its asset too. Leaving the row out keeps the account's units, which counts
 * them in both accounts. The user may remove them only when an earlier import of the row's own
 * folios added them for its own lines and nothing else, and must then choose; otherwise they stay,
 * with a note to check them.
 */
function settleOverlap(
  position: PlannedPosition,
  positions: PlannedPosition[],
  sources: Source[],
  accountId: string,
  input: PlanInput,
  elsewhere: (position: PlannedPosition) => Elsewhere,
) {
  const existing = position.existing!;
  // Another statement row for the asset replaces the account's units when it's imported.
  if (positions.some((p) => p !== position && p.lines.length && (p.ref === position.ref || p.existing?.assetId === existing.assetId))) return;
  const own = new Set(position.lines.map((l) => l.source));
  const listed = new Set(sources.flatMap((s) => listedIn(s).flatMap(security)));
  const from: Source[] = [];
  // A left-out or unlisted source's earlier import may have added some of them too.
  const { unread, unlisted } = elsewhere(position);
  let mixed = unread.length > 0 || unlisted;
  for (const s of sources) {
    const record = input.remembered(s, accountId);
    const earlier = record.get(position.ref) ?? record.get(existing.ref);
    if (!earlier) continue;
    from.push(s);
    // Added for this row's lines alone, as far as the identifiers tell.
    const ids = new Set(position.lines.filter((l) => l.source === s).flatMap((l) => security(l.holding)));
    if (!earlier.some((id) => ids.has(id)) || earlier.some((id) => listed.has(id) && !ids.has(id)) || incomparable(s, earlier)) mixed = true;
  }
  const units = existing.units;
  if (from.length && !mixed) {
    position.removable = from;
    position.notes.push(
      `An earlier import of ${labels(from)} recorded adding this holding. Leaving this row out keeps the ${units} units this account holds unless you remove them. Keeping them counts them here and in ${names(position.heldBy!)}. ` +
      `Keep them, or remove them only if all of them came from ${labels(from)}: ${IMPORTS_DONT_RECORD}.`,
    );
    return;
  }
  const why = from.length
    ? `An earlier import of ${labels(from)} recorded adding this holding, but its units may also include others.`
    : `No earlier import of ${labels(own)} recorded adding this holding.`;
  position.notes.push(`Leaving this row out keeps this account's ${units} units of it, so ${names(position.heldBy!)} may count them too. ${why} Check them in Wealthfolio.`);
}

/** A position's name, with its symbol and exchange to tell apart two assets of one holding. */
export const assetName = (position: PlannedPosition) => {
  const symbol = position.existing?.symbol ?? position.asset?.symbol;
  const ref = position.existing?.ref ?? position.ref;
  const exchange = ref.slice(ref.lastIndexOf("@") + 1);
  const identity = [symbol, exchange].filter(Boolean).join(" · ");
  return identity && identity !== position.name ? `${position.name} (${identity})` : position.name;
};

export const labels = (sources: Iterable<Source>) => [...new Set([...sources].map((s) => s.label))].join(" and ");
export const assetNames = (positions: Iterable<PlannedPosition>) => [...new Set([...positions].map(assetName))].join(" and ");

/** A position an earlier import added for lines the statement now puts under another asset. */
interface Moved {
  old: PlannedPosition;
  /** Sources whose lines it was added for. */
  sources: Source[];
  /** Every source that recorded adding it. */
  recorded: Source[];
}

/**
 * The account's holdings the statement doesn't list under their asset. One an earlier import added
 * for lines the statement now puts under another asset would count them twice: it's kept, and those
 * lines left out, until the user replaces it with them. Import records hold identifiers, not units,
 * so a holding that may also have other units is only kept, with a note.
 */
function settleOthers(
  positions: PlannedPosition[],
  sources: Source[],
  accountId: string,
  input: PlanInput,
  elsewhere: (position: PlannedPosition) => Elsewhere,
) {
  const importable = new Set(positions.filter((p) => p.lines.length && p.include && !p.misread));
  const under = new Map(positions.flatMap((p) => p.lines.map((l) => [l.holding, p] as const)));
  const replacing = new Map<PlannedPosition, { whole: Moved[]; part: Moved[] }>();
  for (const position of positions) {
    // A statement row's lines replace its own units; a held-back one keeps them.
    if (!position.existing || (position.lines.length && !position.misread)) continue;
    const moved = settleOther(position, under, importable, sources, accountId, input, elsewhere(position));
    if (!moved) continue;
    for (const target of moved.targets) {
      const entry = replacing.get(target) ?? { whole: [], part: [] };
      (moved.whole ? entry.whole : entry.part).push(moved);
      replacing.set(target, entry);
    }
  }
  for (const [target, { whole, part }] of replacing) {
    if (whole.length) {
      target.include = false;
      target.replaces = whole.map((m) => m.old.key);
      const old = assetNames(whole.map((m) => m.old));
      const them = whole.length > 1;
      target.notes.push(
        `An earlier import of ${labels(whole.flatMap((m) => m.sources))} added this holding as ${old}. So that it isn't counted twice, it's left out unless you replace ${old} with it. ` +
        `Replace ${them ? "them" : "it"} only if all ${them ? "their" : "its"} units came from ${labels(whole.flatMap((m) => m.recorded))}: imports don't record how many units each folio, demat account or PRAN added.`,
      );
    }
    if (part.length) {
      const old = assetNames(part.map((m) => m.old));
      const added = `An earlier import of ${labels(part.flatMap((m) => m.sources))} added this holding as ${old}`;
      if (importable.has(target)) {
        target.include = false;
        target.notes.push(`${added}, which may also hold other units, so it's left out by default. If you keep both, correct the units of ${old} in Wealthfolio so that they aren't counted twice.`);
      } else {
        target.notes.push(`${added}.`);
      }
    }
  }
}

function settleOther(
  position: PlannedPosition,
  under: ReadonlyMap<StatementHolding, PlannedPosition>,
  importable: ReadonlySet<PlannedPosition>,
  sources: Source[],
  accountId: string,
  input: PlanInput,
  { unread, unlisted }: Elsewhere,
) {
  // A holding the statement still lists, but that this import leaves out, wasn't sold.
  const listed = new Set(sources.flatMap((s) => listedIn(s).flatMap(security)));
  let uncertain = false;
  // It may also hold units that no listed holding under another asset replaces, such as a left-out or unlisted source's.
  let mixed = !!position.misread || unread.length > 0 || unlisted;
  const moved: { source: Source; to: PlannedPosition }[] = [];
  const recorded: Source[] = [];
  const from = sources.filter((s) => {
    const earlier = input.remembered(s, accountId).get(position.ref) ?? input.remembered(s, accountId).get(position.existing!.ref);
    if (!earlier) return false;
    recorded.push(s);
    // The source's own listed holdings it was added for: each is now left out, or under another asset.
    const own = s.holdings.filter((h) => security(h).some((id) => earlier.includes(id)));
    for (const holding of own) {
      const to = under.get(holding);
      if (to && to.ref !== position.ref && to.existing?.assetId !== position.existing!.assetId) moved.push({ source: s, to });
      else mixed = true;
    }
    const unsure = incomparable(s, earlier);
    if (unsure) mixed = true;
    if (own.length) {
      if (earlier.some((id) => listed.has(id) && !own.some((h) => security(h).includes(id)))) mixed = true;
      return false;
    }
    if (earlier.some((id) => listed.has(id))) {
      mixed = true;
      return false;
    }
    uncertain ||= unsure;
    return !unsure;
  });
  if (!moved.length && position.misread) return;
  let replaced: (Moved & { targets: PlannedPosition[]; whole: boolean }) | undefined;
  if (moved.length) {
    const targets = [...new Set(moved.map((m) => m.to))];
    const whole = !mixed && targets.length === 1 && importable.has(targets[0]);
    replaced = { old: position, sources: moved.map((m) => m.source), recorded, targets, whole };
    const them = moved.length > 1;
    const added = `An earlier import of ${labels(replaced.sources)} added it for ${them ? "holdings" : "a holding"} that this import lists under ${assetNames(targets)}.`;
    if (whole) {
      position.replacedBy = targets[0].key;
      position.notes.push(`${added} It's kept unless you replace it with ${assetName(targets[0])}.`);
    } else if (!mixed && targets.length === 1 && targets[0].heldBy) {
      // Left out because an account that tracks transactions holds it: keeping this one counts its units twice.
      position.removable = recorded;
      position.notes.push(
        `${added} ${alreadyHold(targets[0].heldBy)} ${them ? "those holdings" : "that holding"}, so keeping this one counts its units in both accounts. ` +
        `Keep it, or remove it only if all its units came from ${labels(recorded)}: ${IMPORTS_DONT_RECORD}.`,
      );
    } else {
      const left = targets.filter((t) => importable.has(t));
      position.notes.push(left.length
        ? `${added} The add-on can't tell how many of its units ${them ? "those holdings account" : "that holding accounts"} for, so it's kept and ${assetNames(left)} ${left.length > 1 ? "are" : "is"} left out by default. ` +
          `If you keep both, correct this holding's units in Wealthfolio so that they aren't counted twice.`
        : added);
      const overlapping = targets.filter((t) => t.heldBy);
      const heldBy = [...new Map(overlapping.flatMap((t) => t.heldBy!).map((a) => [a.name, a])).values()];
      if (heldBy.length) {
        position.notes.push(`${alreadyHold(heldBy)} ${assetNames(overlapping)}, so this holding's units may be counted there too. Check them in Wealthfolio.`);
      }
    }
    if (unread.length) position.notes.push(`${leavesOut(unread)} added it too.`);
    if (unlisted) position.notes.push(`An earlier import of ${UNLISTED} added it too.`);
  } else if (from.length && unread.length) {
    // Removing it would take the left-out source's units too.
    position.notes.push(
      `An earlier import of ${labels(from)} added it, and ${labels(from)} no longer ${several(from) ? "list" : "lists"} it. ${leavesOut(unread)} added it too, so it's kept. ` +
      `Remove it ${onlyIfNoneIn(unread)}. If you keep it, correct its units in Wealthfolio: they may include some that came from ${labels(from)}.`,
    );
    if (unlisted) position.notes.push(`An earlier import of ${UNLISTED} added it too.`);
  } else if (from.length && unlisted) {
    // The statement may leave that one out for another reason than its units having gone.
    position.notes.push(
      `An earlier import of ${labels(from)} added it, and ${labels(from)} no longer ${several(from) ? "list" : "lists"} it. An earlier import of ${UNLISTED} added it too, so it's kept. ` +
      `Check whether it was redeemed, sold or moved from there too, and untick Keep if so. If you keep it, correct its units in Wealthfolio: they may include some that came from ${labels(from)}.`,
    );
  } else if (from.length) {
    position.include = false;
    position.notes.push(`Not on the statement any more. An earlier import of ${from.map((s) => s.label).join(" and ")} added it.`);
  } else {
    if (unlisted) {
      position.notes.push(`An earlier import added it from ${UNLISTED}. Check whether it was redeemed, sold or moved, and untick Keep if so.`);
      if (unread.length) position.notes.push(`${leavesOut(unread)} added it too: untick Keep ${onlyIfNoneIn(unread)}.`);
    }
    if (uncertain) position.notes.push("A listed holding lacks a comparable identifier. Check whether to keep this earlier imported holding.");
  }
  if (position.misread) return replaced;
  if (position.existing?.split) {
    position.notes.push("A split was recorded since the account's snapshot, so these units predate it. If you keep it, correct its units in Wealthfolio after saving.");
  }
  if (keepsAverageCost(position.existing) && position.existing!.price === undefined) {
    position.notes.push("It's priced by hand and has no price on or before this date. If no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date if you keep it.");
  }
  return replaced;
}

/**
 * Whether saving gives its asset the statement's details: a bond's or NPS scheme's always, a fund's
 * or share's when it's priced from statements.
 */
export const keepsDetails = (position: PlannedPosition) =>
  position.lines.some(({ holding }) => holding.details && (holding.kind === "bond" || holding.kind === "nps" || position.asset?.statementPrices));

/** The account's pricing mode for the asset, else the confirmed asset's. */
const pricedByHand = (p: PlannedPosition) => p.existing?.manual ?? p.asset?.manual;

/**
 * Saving it writes its average cost as its price on the snapshot's date: a manual price with a known
 * cost (wealthfolio/wealthfolio#2331).
 */
const keepsAverageCost = (p: ExistingPosition | undefined) => !!p?.manual && nonzero(p.units) && nonzero(p.cost);

const names = (accounts: { name: string }[]) => accounts.map((a) => a.name).join(", ");
const alreadyHold = (accounts: { name: string }[]) =>
  `${names(accounts)} already ${accounts.length === 1 ? "holds" : "hold"}`;

/** The first positive price the statement's lines print for the position. */
const statementPrice = (position: PlannedPosition) => position.lines.map((l) => l.holding.price).find((price) => positive(price));

/** The total cost a position goes in with, after the user's typing; undefined when unknown. */
export function costOf(position: PlannedPosition, typed: string | undefined) {
  if (position.cost?.from === "statement") return position.cost.total;
  if (typed !== undefined) return typed.trim() === "" ? undefined : typed.trim();
  return position.cost?.total;
}

/** A typed total cost: a positive amount, or blank for unknown. */
export const validCost = (typed: string) => typed.trim() === "" || (/^\d+(\.\d+)?$/.test(typed.trim()) && positive(typed.trim()));

export interface Choices {
  /** Preview rows whose default the user flipped, by `key`. */
  flipped: ReadonlySet<string>;
  /** Typed total costs by `key`. */
  costs: ReadonlyMap<string, string>;
  /** For `removable` rows, by `key`: true keeps the account's units, false removes them. Undecided until set. */
  keep?: ReadonlyMap<string, boolean>;
}

/**
 * Whether the statement's lines replace the account's units, or for others whether the account keeps
 * them. One that a statement position replaces is kept unless that position is imported.
 */
export const included = (position: PlannedPosition, choices: Choices) =>
  position.misread ? position.include
  : position.removable && !position.lines.length ? choices.keep?.get(position.key) !== false
  : position.include !== choices.flipped.has(position.replacedBy ?? position.key);

/** Whether the account's units of a `removable` row still need the user's choice to keep or remove them. */
export const undecided = (position: PlannedPosition, choices: Choices) =>
  !!position.removable && !choices.keep?.has(position.key) && !(position.lines.length && included(position, choices));

/** Whether saving removes the account's units of a statement row that isn't imported: the user chose to. */
const removed = (position: PlannedPosition, choices: Choices) =>
  !!position.removable && position.lines.length > 0 && !included(position, choices) && choices.keep?.get(position.key) === false;

/** What `snapshots.save` gets for the account. */
export function snapshotOf(plan: AccountPlan, choices: Choices) {
  const { listed, kept } = composition(plan, choices);
  return {
    holdings: [...kept.values()].map((p) => p.holding).concat([...listed.values()].map((p) => p.holding)),
    cash: plan.existing.cash,
  };
}

/**
 * The snapshot's holdings: the statement's, by `fundRef`, and the account's that it keeps as they
 * are, by asset ID.
 */
function composition(plan: AccountPlan, choices: Choices) {
  const listed = new Map<string, { holding: SnapshotHoldingInput; total: string | undefined }>();
  const kept = new Map<string, { ref: string; holding: SnapshotHoldingInput }>();
  for (const position of plan.positions) {
    const statement = position.lines.length > 0;
    if (statement && included(position, choices)) {
      let total = costOf(position, choices.costs.get(position.key));
      const asset = position.asset!;
      const before = listed.get(position.ref);
      const quantity = before ? format(add(dec(before.holding.quantity), dec(position.units!))) : position.units!;
      if (before) total = before.total !== undefined && total !== undefined ? format(add(dec(before.total), dec(total))) : undefined;
      const holding: SnapshotHoldingInput = {
        ...(position.existing || asset.assetId
          ? { assetId: position.existing?.assetId ?? asset.assetId }
          : {
              symbol: asset.symbol,
              exchangeMic: asset.exchangeMic,
              quoteCcy: asset.quoteCcy,
              instrumentType: asset.instrumentType,
              providerId: asset.providerId,
              providerSymbol: asset.providerSymbol,
              name: asset.name,
              // A new asset priced from statements. One Wealthfolio prices from market data stays so.
              ...(asset.statementPrices && asset.manual && { dataSource: "MANUAL" }),
            }),
        symbol: asset.symbol,
        quantity,
        currency: CURRENCY,
        ...(total && { averageCost: format(div(dec(total), dec(quantity), COST_PLACES)) }),
      };
      listed.set(position.ref, { holding, total });
    } else if (position.existing && !removed(position, choices) && (statement || included(position, choices))) {
      // Left out of the statement's side, or kept: the account's units stay as they are.
      kept.set(position.existing.assetId, { ref: position.ref, holding: existingHolding(position.existing) });
    }
  }
  // Wealthfolio keeps the last of two holdings of one asset. A kept holding matches none of the
  // statement's only when the asset's symbol was renamed, so the statement's come last and win.
  for (const [assetId, p] of kept) if (listed.has(p.ref)) kept.delete(assetId);
  return { listed, kept };
}

function existingHolding(p: ExistingPosition): SnapshotHoldingInput {
  const units = dec(p.units);
  return {
    assetId: p.assetId,
    symbol: p.symbol,
    quantity: p.units,
    currency: p.currency,
    ...(p.cost && !isZero(units) && { averageCost: format(div(dec(p.cost), units, COST_PLACES)) }),
  };
}

/**
 * What each source put into the account (`fundRef` → `security`), to remember after the import. A
 * left-out source's record comes too when the import replaces or removes the account's units of a
 * holding it recorded: without that holding, since none of those units are its own any more.
 */
export function importedRefs(plan: AccountPlan, choices: Choices) {
  const updated = new Set(plan.positions.filter((p) => p.lines.length && included(p, choices)).map((p) => p.ref));
  const kept = new Set(plan.positions.filter((p) =>
    p.existing && !updated.has(p.ref) && !removed(p, choices) && (p.lines.length || included(p, choices))).map((p) => p.ref));
  const heldBack = plan.positions.filter((p) => p.misread && p.existing);
  const ids = new Set(heldBack.flatMap((p) => [...p.lines, ...p.misread!].flatMap((l) => security(l.holding))));
  for (const p of heldBack) kept.add(p.existing!.ref);
  const refs = new Map(plan.sources.map((source) => [source.id, {
    // Held-back positions keep their recorded identifiers even under an earlier symbol.
    source, refs: Object.fromEntries([...(plan.remembered.get(source.id) ?? [])].filter(([ref, security]) => kept.has(ref) || security.some((id) => ids.has(id)))),
  }]));
  for (const position of plan.positions) {
    if (!position.lines.length || !included(position, choices)) continue;
    for (const { source, holding } of position.lines) {
      const saved = refs.get(source.id)!.refs;
      saved[position.ref] = [...new Set([...(saved[position.ref] ?? []), ...security(holding)])];
    }
  }
  const replaced = replacedRefs(plan, choices);
  const cleared = plan.unread.flatMap(({ source, remembered }) => {
    const left = without(remembered, replaced);
    return left ? [{ source, refs: left }] : [];
  });
  return [...refs.values(), ...cleared];
}

/** A record without the replaced `fundRef`s, or undefined when it has none of them. */
function without(remembered: ReadonlyMap<string, string[]>, replaced: ReadonlySet<string>) {
  const left = [...remembered].filter(([ref]) => !replaced.has(ref));
  return left.length < remembered.size ? Object.fromEntries(left) : undefined;
}

/**
 * The records of folios, demat accounts and PRANs the statement doesn't list, to save without the
 * holdings whose units the import replaces or removes, like a left-out source's in `importedRefs`.
 * Only those it changes.
 */
export function unlistedRefs(plan: AccountPlan, choices: Choices) {
  const replaced = replacedRefs(plan, choices);
  return plan.unlisted.flatMap(({ keys, remembered }) => {
    const refs = without(remembered, replaced);
    return refs ? [{ keys, refs }] : [];
  });
}

/**
 * The `fundRef`s, as `unreadOf` matches them, of the holdings whose units the snapshot sets to the
 * statement's or removes. Those of a holding it keeps as it is never count.
 */
function replacedRefs(plan: AccountPlan, choices: Choices) {
  const { listed, kept } = composition(plan, choices);
  const listedIds = new Set([...listed.values()].map((l) => l.holding.assetId));
  const replaced = new Set<string>();
  const unchanged = new Set<string>();
  for (const position of plan.positions) {
    const refs = [position.ref, ...(position.existing ? [position.existing.ref] : [])];
    const same = position.existing && kept.has(position.existing.assetId) && !listedIds.has(position.existing.assetId);
    if (same) for (const ref of refs) unchanged.add(ref);
    else if (position.existing || listed.has(position.ref)) for (const ref of refs) replaced.add(ref);
  }
  for (const ref of unchanged) replaced.delete(ref);
  return replaced;
}

/** Whether the snapshot changes anything the account has on the statement's date. */
export const replacesSnapshot = (plan: AccountPlan) => plan.existing.date === plan.date;

/**
 * A price to save on the snapshot's date once it's saved, over the average cost Wealthfolio's save
 * writes there for a manual-priced asset (wealthfolio/wealthfolio#2331).
 */
export interface PriceToSave {
  ref: string;
  /** Undefined for an asset the save creates. */
  assetId?: string;
  name: string;
  price: string;
  currency: string;
  /** The statement's price, or the price a kept holding had. */
  from: "statement" | "earlier";
}

/**
 * The manual-priced holdings in the account's snapshot, and the price each should have on its date.
 * `listed` has the statement's price for each asset any account's import lists (`fundRef` → price):
 * one this account only keeps gets it too, since saving this snapshot writes its average cost over it.
 * A statement's price that isn't positive is never saved; a kept holding then gets the price it had.
 */
export function pricesToSave(plan: AccountPlan, choices: Choices, listed: ReadonlyMap<string, string> = new Map()): PriceToSave[] {
  const prices = new Map<string, PriceToSave>();
  for (const position of plan.positions) {
    if (!position.lines.length || !included(position, choices) || prices.has(position.ref)) continue;
    const price = pricedByHand(position) ? statementPrice(position) : undefined;
    if (price === undefined) continue;
    prices.set(position.ref, {
      ref: position.ref, assetId: position.existing?.assetId ?? position.asset?.assetId, name: position.name, price, currency: CURRENCY, from: "statement",
    });
  }
  for (const position of plan.positions) {
    const p = position.existing;
    if (!p || prices.has(position.ref) || removed(position, choices) || !(position.lines.length || included(position, choices))) continue;
    if (!keepsAverageCost(p)) continue;
    const statement = listed.get(position.ref);
    if (positive(statement)) {
      prices.set(position.ref, { ref: position.ref, assetId: p.assetId, name: position.name, price: statement!, currency: CURRENCY, from: "statement" });
    } else if (p.price) {
      prices.set(position.ref, { ref: position.ref, assetId: p.assetId, name: position.name, price: p.price.close, currency: p.price.currency, from: "earlier" });
    }
  }
  return [...prices.values()];
}

/** An account that tracks transactions, with its units of a holding on the statement's date. */
export interface CheckedAccount {
  id: string;
  name: string;
  /** Undefined when its history needs Wealthfolio's portfolio engine. */
  units: Dec | undefined;
}

/** A holding's units on the statement against those of the accounts that track transactions. */
export interface UnitCheck {
  /** The Wealthfolio asset's ID, or `fundRef` of a choice whose identity couldn't be resolved. */
  ref: string;
  name: string;
  /** The statement's lines for the asset, printed zeros included. */
  lines: Line[];
  /** Lines that may have been misread and may be this asset: its units on the statement are unknown. */
  misread?: Line[];
  /** Summed over its lines, without any misread ones. */
  statement: Dec;
  /** Accounts with posted activities for the asset on or before the statement's date. */
  accounts: CheckedAccount[];
  /** Summed over its accounts; undefined when one can't be counted or there are none. */
  held: Dec | undefined;
  /** Why it needs review, whichever way the user confirms its accounts. */
  problem?: string;
}

export interface CheckInput {
  /** Undefined leaves the holding out. */
  asset(holding: StatementHolding): ChosenAsset | undefined;
  /** Accounts that track transactions, NOT_SET included, whose activities Wealthfolio shows. */
  accounts: { id: string; name: string }[];
  /** Wealthfolio's activities, or why they couldn't be read. */
  activities: ActivityDetails[] | { error: string };
  /**
   * Asset ID → `fundRef` of the asset's symbol and exchange in Wealthfolio, or why its profile
   * couldn't be read, for the assets of `activities`. Needed for choices without an asset ID.
   */
  identities?: ReadonlyMap<string, string | { error: string }>;
  /** Wealthfolio's timezone setting, from `engineTimeZone`: each activity counts on its `localDay` there. */
  timeZone: string;
}

/**
 * Each confirmed holding's units on the statement against what its accounts that track transactions
 * add up to on the statement's date. An asset's lines are summed once however many folios, demat
 * accounts or PRANs list it, and its accounts once however many of those they share. Only reads.
 */
export function checkUnits(holdings: Holdings, input: CheckInput): UnitCheck[] {
  const { activities, identities = new Map(), timeZone } = input;
  const until = (d: string) => d <= holdings.date;
  const accounts = new Set(input.accounts.map((a) => a.id));
  const history = Array.isArray(activities)
    ? activities.filter((a) => a.status === "POSTED" && a.assetId && accounts.has(a.accountId) && until(localDay(a.date, timeZone)))
    : [];
  // Activities show an asset's display code, which the user can change, so a choice without an
  // asset ID goes by the symbol and exchange on the asset's profile.
  const identify = (asset: ChosenAsset): { ref: string; problem?: string } => {
    if (asset.assetId) return { ref: asset.assetId };
    const ref = fundRef(asset.symbol, asset.exchangeMic);
    const ids = new Set<string>();
    for (const a of history) {
      const identity = identities.get(a.assetId);
      if (identity === ref) ids.add(a.assetId);
      else if (typeof identity !== "string") {
        return { ref, problem: `Couldn't read a Wealthfolio asset's profile${identity ? `: ${identity.error}` : "."}` };
      }
    }
    if (ids.size > 1) return { ref, problem: "Several Wealthfolio assets have its symbol and exchange. Choose the existing asset for it under Holdings." };
    return { ref: ids.size ? [...ids][0] : ref };
  };
  const checks = new Map<string, UnitCheck>();
  for (const source of holdings.sources) {
    for (const holding of [...source.holdings, ...(source.zero ?? [])]) {
      const asset = input.asset(holding);
      if (!asset) continue;
      const { ref, problem } = identify(asset);
      const check = checks.get(ref) ?? { ref, name: holding.name, lines: [], statement: dec("0"), accounts: [], held: undefined };
      check.problem ??= problem;
      check.lines.push({ source, holding });
      check.statement = add(check.statement, dec(holding.units));
      checks.set(ref, check);
    }
  }
  // A misread line goes with its asset's check, and with the checks of lines that print one of its identifiers.
  for (const source of holdings.sources) {
    for (const holding of source.misread ?? []) {
      const ids = new Set(security(holding));
      const targets = new Set([...checks.values()].filter((c) => c.lines.some((l) => security(l.holding).some((id) => ids.has(id)))));
      const asset = input.asset(holding);
      if (asset) {
        const { ref, problem } = identify(asset);
        const check = checks.get(ref) ?? { ref, name: holding.name, lines: [], statement: dec("0"), accounts: [], held: undefined };
        check.problem ??= problem;
        checks.set(ref, check);
        targets.add(check);
      }
      for (const check of targets) (check.misread ??= []).push({ source, holding });
    }
  }
  return [...checks.values()].map((check) => {
    if (!Array.isArray(activities)) return { ...check, problem: `Couldn't read Wealthfolio's activities: ${activities.error}` };
    if (check.problem) return check;
    const rows = history.filter((a) => a.assetId === check.ref);
    check.accounts = input.accounts
      .filter((account) => rows.some((a) => a.accountId === account.id))
      .map(({ id, name }) => ({ id, name, units: countUnits(rows.filter((a) => a.accountId === id), until, timeZone) }));
    const unknown = check.accounts.filter((a) => a.units === undefined);
    if (!check.accounts.length) {
      check.problem = `No account that tracks transactions has posted activities for it on or before ${holdings.date}.`;
    } else if (unknown.length) {
      check.problem = `A split or option expiry in ${names(unknown)} needs Wealthfolio's portfolio engine to count its units.`;
    } else {
      check.held = check.accounts.reduce((total, a) => add(total, a.units!), dec("0"));
    }
    return check;
  }).map((check) => {
    if (!check.misread) return check;
    const misread = `${misreadIn(check.misread)}, so its units on the statement are unknown. ${checkPdf(check.misread)}`;
    return { ...check, problem: check.problem ? `${misread} ${check.problem}` : misread };
  });
}

export type UnitStatus = "match" | "differ" | "review";

/** `same`: the user confirmed that the accounts compared hold the same units as the statement's lines. */
export const unitStatus = (check: UnitCheck, same: boolean): UnitStatus =>
  check.problem || !same ? "review" : sameUnits(check) ? "match" : "differ";

// Wealthfolio's `BondSpec` (asset metadata `bond`) knows these coupon frequencies; its pricer
// takes any other as semi-annual, so the rest stay only in the printed details.
const FREQUENCIES: [RegExp, string][] = [
  [/^(half[- ]?yearly|semi[-_ ]?annual(ly)?|bi[- ]?annual(ly)?|twice (a year|per year|yearly))$/i, "SEMI_ANNUAL"],
  [/^(quarterly|once (a|per) quarter)$/i, "QUARTERLY"],
  [/^(once (a|per) year|annual(ly)?|yearly)$/i, "ANNUAL"],
];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The asset's metadata with the holding's printed details: as printed under `casStatement`, and
 * for a bond asset, any `bond` fields Wealthfolio doesn't have yet.
 * Undefined when nothing changes.
 */
export function assetDetails(holding: StatementHolding, metadata: unknown, instrumentType: string | null | undefined) {
  if (!holding.details) return undefined;
  const before = record(metadata);
  const next: Record<string, unknown> = { ...before, casStatement: { ...record(before.casStatement), ...holding.details } };
  if (holding.kind === "bond" && instrumentType === "BOND") {
    const d = holding.details;
    const spec: Record<string, unknown> = {};
    if (d.isin) spec.isin = d.isin;
    try {
      if (d.maturityDate) {
        const day = statementDay(d.maturityDate);
        if (new Date(day).toJSON()?.slice(0, 10) === day) spec.maturityDate = day;
      }
    } catch {
      // Left in the printed details only.
    }
    if (d.couponRate && /^\d+(\.\d+)?$/.test(d.couponRate)) spec.couponRate = Number(format(div(dec(d.couponRate), dec("100"), 10)));
    const frequency = FREQUENCIES.find(([pattern]) => pattern.test(d.couponFrequency?.trim() ?? ""));
    if (frequency) spec.couponFrequency = frequency[1];
    if (positive(d.faceValue)) spec.faceValue = Number(d.faceValue);
    // Wealthfolio's or the user's own values win; it writes unknown ones as null.
    const bond = record(before.bond);
    const missing = Object.entries(spec).filter(([key]) => bond[key] == null);
    if (missing.length) next.bond = { ...bond, ...Object.fromEntries(missing) };
  }
  return JSON.stringify(next) === JSON.stringify(before) ? undefined : next;
}
