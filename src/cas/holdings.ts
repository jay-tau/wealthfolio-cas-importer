import type { ActivityDetails, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import { add, dec, div, format, isZero, mul } from "./decimal.ts";
import type { FundAsset } from "./mapping.ts";
import { fundRef, statementDay } from "./plan.ts";
import { type CasData, type DepositoryData, isDepository, type Statement } from "./types.ts";

// A summary or NSDL/CDSL statement's holdings → the snapshots saved to Wealthfolio accounts that
// track holdings. Wealthfolio's snapshot is the account's whole state on its date, so each one
// starts from the account's latest snapshot: the statement's holdings replace their own, and
// the account's other holdings and cash carry over unless an earlier import of the same folio
// or demat account put them there. Pure: the user's choices come in, snapshots come out.

const CURRENCY = "INR";
/** Decimals of the average cost sent to Wealthfolio, which multiplies it back by the units. */
const COST_PLACES = 20;

export type HoldingKind = "fund" | "share";

/** A fund in a folio, or a fund or share in a demat account. */
export interface StatementHolding {
  kind: HoldingKind;
  isin: string | null;
  /** The registrar and its scheme code, for a summary statement's fund without an ISIN. */
  rta: string | null;
  rtaCode: string | null;
  name: string;
  units: string;
  price: string;
  value: string;
  /** Printed total cost. A printed zero is taken as unknown. */
  cost: string | null;
}

/** A folio or a demat account. The statement lists every holding in it, so each goes to one account. */
export interface Source {
  /** Stable across statements; hashed before it's stored. */
  id: string;
  /** Issuer-scoped folio links; [] severs old links, undefined retains learned ones. */
  aliases?: string[];
  kind: "folio" | "demat";
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
];

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
    ].filter((h) => held(label, h));
    for (const bond of account.bonds) {
      leftOut.push({ source: label, name: bond.name ?? bond.isin, reason: "Bonds aren't imported yet." });
    }
    sources.push({ id: `demat|${account.dp_id ?? ""}|${account.client_id ?? ""}`, kind: "demat", label, holdings });
  }
  for (const scheme of data.nps?.schemes ?? []) {
    leftOut.push({ source: "National Pension System", name: scheme.scheme, reason: "NPS holdings aren't imported yet." });
  }
  const owner = data.accounts.flatMap((a) => a.owners)[0];
  return {
    date: statementDay(data.statement_period.to),
    investor: (owner?.PAN || data.investor_info.name).trim().toUpperCase(),
    sources,
    leftOut,
  };
}

/** The fund or share the user confirmed, as `market.searchTicker` gave it. */
export interface ChosenAsset extends FundAsset {
  name: string;
  manual?: boolean;
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
  /** Saving a nonzero average cost would overwrite this asset's manual market price. */
  manual?: boolean;
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

export type CostSource = "statement" | "wealthfolio";

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
      const overlap = source.kind === "folio" && input.heldElsewhere(ref, accountId).some((o) => o.tracksTransactions);
      const key = overlap ? `${ref}|overlap` : ref;
      const position = plan.byRef.get(key) ?? {
        key, ref, name: asset.name || holding.name, existing: plan.existing.positions.find((p) => p.ref === ref),
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
  if (printed.some((c) => c !== null) && printed.some((c) => c === null)) {
    position.notes.push("The statement prints a cost for only some of its lines for this holding.");
  }

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
}

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

/** Wealthfolio's save would turn this outgoing cost into a manual market price. */
export const manualPriceChange = (plan: AccountPlan, choices: Choices) => plan.positions.find((p) => {
  if (!p.existing?.manual && !p.asset?.manual) return false;
  const listed = plan.positions.filter((other) => other.ref === p.ref && other.lines.length && included(other, choices));
  if (listed.length) {
    const costs = listed.map((other) => costOf(other, choices.costs.get(other.key)));
    if (costs.some((cost) => cost === undefined)) return false;
    try {
      return costs.some(nonzero);
    } catch {
      return false;
    }
  }
  return (p.lines.length > 0 || included(p, choices)) && nonzero(p.existing?.units) && nonzero(p.existing?.cost);
});

/** What `snapshots.save` gets for the account. */
export function snapshotOf(plan: AccountPlan, choices: Choices) {
  const unsafe = manualPriceChange(plan, choices);
  if (unsafe) throw new Error(`Saving ${unsafe.name} would overwrite its manual price with its average cost.`);
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
        ...(position.existing
          ? { assetId: position.existing.assetId }
          : {
              symbol: asset.symbol,
              exchangeMic: asset.exchangeMic,
              quoteCcy: asset.quoteCcy,
              instrumentType: asset.instrumentType,
              providerId: asset.providerId,
              providerSymbol: asset.providerSymbol,
              name: asset.name,
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
