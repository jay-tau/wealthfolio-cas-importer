import type { ActivityDetails, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import { add, dec, div, format, isZero, mul } from "./decimal.ts";
import type { FundAsset } from "./mapping.ts";
import { fundRef, statementDay } from "./plan.ts";
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
  /** What else the statement prints about a bond or NPS scheme, as printed. */
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
const printedCost = (value: string | null | undefined) => (positive(value) ? format(dec(value!)) : null);

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

/** Printed details, without the ones the statement leaves blank. */
const printed = (details: Record<string, string | null | undefined>) =>
  Object.fromEntries(Object.entries(details).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

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
      if (!positive(scheme.close)) {
        leftOut.push({ source: label, name: scheme.scheme, reason: "No units on the statement." });
        continue;
      }
      source.holdings.push({
        kind: "fund",
        isin: scheme.isin,
        rta: scheme.rta,
        rtaCode: scheme.rta_code,
        name: scheme.scheme,
        units: scheme.close,
        price: scheme.valuation.nav,
        value: scheme.valuation.value,
        cost: printedCost(scheme.valuation.cost),
      });
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
  });
  const held = (label: string, h: StatementHolding) => {
    if (positive(h.units)) return true;
    leftOut.push({ source: label, name: h.name, reason: "No units on the statement." });
    return false;
  };
  let dematNumber = 0;

  for (const account of data.accounts) {
    if (account.type === "Mutual Fund Folios") {
      const folios = new Map<string, Source>();
      for (const f of account.mutual_funds) {
        const number = folioNumber(f.folio ?? "");
        const label = number ? `Folio ${number}` : "Mutual fund folios";
        const holding = fund(f);
        const id = `folio|${number}|${issuerOf(f.isin) ?? `isin:${f.isin}`}`;
        const source = folios.get(id) ?? { id, kind: "folio", label, holdings: [] };
        if (held(label, holding)) source.holdings.push(holding);
        folios.set(id, source);
      }
      sources.push(...folios.values());
      continue;
    }
    const label = `${account.type} ${++dematNumber}, ${account.name}`.replace(/\s+/g, " ");
    const holdings = [
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
    ].filter((h) => held(label, h));
    sources.push({ id: `demat|${account.dp_id ?? ""}|${account.client_id ?? ""}`, kind: "demat", label, holdings });
  }
  const owner = data.accounts.flatMap((a) => a.owners)[0];
  const investor = (owner?.PAN || data.investor_info.name).trim().toUpperCase();
  if (data.nps) {
    // The PRAN is printed masked, but it's what the statement has to tell PRANs apart. Without
    // one, the investor's: a person has one PRAN.
    const pran = data.nps.pran?.trim();
    const label = pran ? `NPS, PRAN ${pran}` : "National Pension System";
    const holdings = data.nps.schemes.map(
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
    ).filter((h) => held(label, h));
    sources.push({ id: pran ? `nps|${pran}` : `nps|investor:${investor}`, kind: "nps", label, holdings });
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
 * Assets of an older snapshot with a split recorded since: the snapshot's units and cost predate it.
 * Splits in archived accounts are hidden from add-ons, so they go unnoticed.
 */
export function splitSince(existing: ExistingSnapshot, date: string, activities: ActivityDetails[]) {
  const split = new Set<string>();
  if (!existing.date || existing.date >= date) return split;
  const ids = new Set(existing.positions.map((p) => p.assetId));
  // This UTC envelope covers every host timezone; do not replay its split selection here.
  const last = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
  for (const a of activities) {
    if (!a.assetId || !ids.has(a.assetId) || (a.status !== undefined && a.status !== "POSTED")) continue;
    if (a.activityType !== "SPLIT" && !("activityTypeOverride" in a && a.activityTypeOverride === "SPLIT")) continue;
    const time = new Date(a.date).getTime();
    const day = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : undefined;
    if (day === undefined || (day >= existing.date && day <= last)) split.add(a.assetId);
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
  /** What an earlier import put into the baseline snapshot: `fundRef` → security identities. */
  remembered(source: Source, accountId: string): ReadonlyMap<string, string[]>;
  /** Other accounts that hold this asset now. */
  heldElsewhere(ref: string, accountId: string): OtherAccount[];
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
  lines: { source: Source; holding: StatementHolding }[];
  asset?: ChosenAsset;
  /** The statement's units, summed over its lines. */
  units?: string;
  value?: string;
  /** Total cost for the statement's units. Undefined when it's unknown. */
  cost?: { total: string; from: CostSource };
  /** Statement lines: whether they replace the account's units. Others: whether the account keeps them. */
  include: boolean;
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
  positions: PlannedPosition[];
}

/** Each account's snapshot, before the user's changes in the preview. */
export function planSnapshots(holdings: Holdings, input: PlanInput): AccountPlan[] {
  const plans = new Map<string, AccountPlan & { byRef: Map<string, PlannedPosition> }>();
  let order = 0;
  for (const source of holdings.sources) {
    const accountId = input.account(source);
    if (!accountId) continue;
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
      plan = { accountId, date: holdings.date, existing, sources: [], remembered: new Map(), positions: [], byRef };
      plans.set(accountId, plan);
    }
    plan.sources.push(source);
    plan.remembered.set(source.id, input.remembered(source, accountId));
    for (const holding of source.holdings) {
      const asset = input.asset(holding);
      if (!asset) continue;
      const ref = fundRef(asset.symbol, asset.exchangeMic);
      // The host's holding symbol can be a custom display code. A resolved asset ID wins.
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

  return [...plans.values()].map(({ byRef, ...plan }) => {
    for (const [key, position] of byRef) {
      if (!position.lines.length && [...byRef.values()].some((p) => p.ref === position.ref && p.lines.length)) byRef.delete(key);
    }
    for (const position of byRef.values()) {
      if (position.lines.length) settleStatement(position, plan.accountId, input);
      else settleOther(position, plan.sources, plan.accountId, input);
    }
    // The statement's holdings in its order, then the account's others in theirs.
    const positions = [...byRef.values()].sort((a, b) => a.order - b.order);
    return { ...plan, positions };
  });
}

const sum = (values: string[]) => values.reduce((total, v) => add(total, dec(v)), dec("0"));

function settleStatement(position: PlannedPosition, accountId: string, input: PlanInput) {
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

  if (pricedByHand(position)) position.notes.push("Priced by hand: saving also saves the statement's price as its price on this date.");

  const others = input.heldElsewhere(position.ref, accountId);
  const tracked = others.filter((o) => o.tracksTransactions);
  // A folio's fund that an account tracking transactions holds most likely came from a detailed statement.
  if (tracked.length && position.lines.some((l) => l.source.kind === "folio")) {
    position.include = false;
    position.notes.push(
      `${names(tracked)} already ${tracked.length === 1 ? "holds" : "hold"} this fund, from its transactions. Including it here counts it twice.`,
    );
  } else if (others.length) {
    position.notes.push(`${names(others)} also ${others.length === 1 ? "holds" : "hold"} it.`);
  }
}

function settleOther(position: PlannedPosition, sources: Source[], accountId: string, input: PlanInput) {
  // A holding the statement still lists, but that this import leaves out, wasn't sold.
  const listed = new Set(sources.flatMap((s) => s.holdings.flatMap(security)));
  let uncertain = false;
  const from = sources.filter((s) => {
    const earlier = input.remembered(s, accountId).get(position.ref);
    if (!earlier || earlier.some((id) => listed.has(id))) return false;
    // Missing ISINs across formats can leave no common identity to compare.
    if (s.holdings.some((h) => !security(h).some((id) => earlier.some((old) => old.includes("|") === id.includes("|"))))) {
      uncertain = true;
      return false;
    }
    return true;
  });
  if (from.length) {
    position.include = false;
    position.notes.push(`Not on the statement any more. An earlier import of ${from.map((s) => s.label).join(" and ")} added it.`);
  } else if (uncertain) {
    position.notes.push("A listed holding lacks a comparable identifier. Check whether to keep this earlier imported holding.");
  }
  if (position.existing?.split) {
    position.notes.push("A split was recorded since the account's snapshot, so these units predate it. If you keep it, correct its units in Wealthfolio after saving.");
  }
  if (keepsAverageCost(position.existing) && position.existing!.price === undefined) {
    position.notes.push("It's priced by hand and has no price on or before this date. If no included holding supplies the statement's price, Wealthfolio takes its average cost as its price on this date if you keep it.");
  }
}

/** The account's pricing mode for the asset, else the confirmed asset's. */
const pricedByHand = (p: PlannedPosition) => p.existing?.manual ?? p.asset?.manual;

/**
 * Saving it writes its average cost as its price on the snapshot's date: a manual price with a known
 * cost (wealthfolio/wealthfolio#2331).
 */
const keepsAverageCost = (p: ExistingPosition | undefined) => !!p?.manual && nonzero(p.units) && nonzero(p.cost);

const names = (accounts: OtherAccount[]) => accounts.map((a) => a.name).join(", ");

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
}

export const included = (position: PlannedPosition, choices: Choices) =>
  position.include !== choices.flipped.has(position.key);

/** What `snapshots.save` gets for the account. */
export function snapshotOf(plan: AccountPlan, choices: Choices) {
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
    } else if (position.existing && (statement || included(position, choices))) {
      // Left out of the statement's side, or kept: the account's units stay as they are.
      kept.set(position.existing.assetId, { ref: position.ref, holding: existingHolding(position.existing) });
    }
  }
  // Wealthfolio keeps the last of two holdings of one asset. A kept holding matches none of the
  // statement's only when the asset's symbol was renamed, so the statement's come last and win.
  return {
    holdings: [...kept.values()].filter((p) => !listed.has(p.ref)).map((p) => p.holding).concat([...listed.values()].map((p) => p.holding)),
    cash: plan.existing.cash,
  };
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

/** What each source put into the account (`fundRef` → `security`), to remember after the import. */
export function importedRefs(plan: AccountPlan, choices: Choices) {
  const updated = new Set(plan.positions.filter((p) => p.lines.length && included(p, choices)).map((p) => p.ref));
  const kept = new Set(plan.positions.filter((p) => p.existing && !updated.has(p.ref) && (p.lines.length || included(p, choices))).map((p) => p.ref));
  const refs = new Map(plan.sources.map((source) => [source.id, {
    source, refs: Object.fromEntries([...(plan.remembered.get(source.id) ?? [])].filter(([ref]) => kept.has(ref))),
  }]));
  for (const position of plan.positions) {
    if (!position.lines.length || !included(position, choices)) continue;
    for (const { source, holding } of position.lines) {
      const saved = refs.get(source.id)!.refs;
      saved[position.ref] = [...new Set([...(saved[position.ref] ?? []), ...security(holding)])];
    }
  }
  return [...refs.values()];
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
 */
export function pricesToSave(plan: AccountPlan, choices: Choices, listed: ReadonlyMap<string, string> = new Map()): PriceToSave[] {
  const prices = new Map<string, PriceToSave>();
  for (const position of plan.positions) {
    if (!position.lines.length || !included(position, choices) || prices.has(position.ref)) continue;
    if (!pricedByHand(position)) continue;
    const { holding } = position.lines[0];
    prices.set(position.ref, {
      ref: position.ref, assetId: position.existing?.assetId ?? position.asset?.assetId, name: position.name, price: holding.price, currency: CURRENCY, from: "statement",
    });
  }
  for (const position of plan.positions) {
    const p = position.existing;
    if (!p || prices.has(position.ref) || !(position.lines.length || included(position, choices))) continue;
    if (!keepsAverageCost(p)) continue;
    const statement = listed.get(position.ref);
    if (statement !== undefined) {
      prices.set(position.ref, { ref: position.ref, assetId: p.assetId, name: position.name, price: statement, currency: CURRENCY, from: "statement" });
    } else if (p.price) {
      prices.set(position.ref, { ref: position.ref, assetId: p.assetId, name: position.name, price: p.price.close, currency: p.price.currency, from: "earlier" });
    }
  }
  return [...prices.values()];
}

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
 * The asset's metadata with a bond's or NPS scheme's printed details: as printed under
 * `casStatement`, and for a bond asset, any `bond` fields Wealthfolio doesn't have yet.
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
