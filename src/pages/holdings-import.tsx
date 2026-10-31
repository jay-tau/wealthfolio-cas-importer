import type { Account, ActivityDetails, AddonContext, Holding, Quote, UpdateAssetProfile } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@wealthfolio/ui";
import { useState } from "react";
import {
  type AccountPlan,
  assetDetails,
  checkUnits,
  type Choices,
  type ExistingSnapshot,
  type HoldingKind,
  type Holdings,
  importedRefs,
  included,
  keepsDetails,
  type LeftOutLine,
  type OtherAccount,
  planSnapshots,
  pricesToSave,
  snapshotOf,
  type Source,
  splitSince,
  statementAsset,
  type StatementHolding,
} from "../cas/holdings";
import { engineTimeZone, fundRef } from "../cas/plan";
import type { Statement } from "../cas/types";
import type { Ignored } from "../components/account-choices";
import { type FundChoice, FundChoicesCard, type FundItem } from "../components/fund-choices";
import { accountForSource, type HoldingsAccountChoices, HoldingsAccountsCard } from "../components/holdings-accounts";
import { HoldingsPreview, HoldingsResult, noChoices, type SavedSnapshots, type Unfinished } from "../components/holdings-preview";
import { type Checked, UnitsCheckCard } from "../components/units-check";
import { holdingKey, LEFT_OUT, readImported, saveImported, sourceKey } from "../lib/choices";
import { instrumentType } from "../lib/instrument-type";

type Api = AddonContext["api"];
type HostInstrument = NonNullable<Holding["instrument"]> & {
  exchangeMic?: string | null;
  pricingMode?: string | null;
  quoteMode?: string | null;
};
const isManual = (instrument: HostInstrument) => (instrument.pricingMode ?? instrument.quoteMode) === "MANUAL";


const NOUNS: Record<HoldingKind, FundItem["noun"]> = { fund: "fund", share: "share", bond: "bond", nps: "NPS scheme" };

/**
 * The statement's holdings, one entry each however many folios, demat accounts or PRANs hold it.
 * Printed zeros are confirmed too, for the check.
 */
export function holdingItems(holdings: Holdings): FundItem[] {
  const items = new Map<string, FundItem & { count: number; units: boolean }>();
  for (const [h, units] of holdings.sources.flatMap((s) => [
    ...s.holdings.map((h) => [h, true] as const),
    ...(s.zero ?? []).map((h) => [h, false] as const),
  ])) {
    const key = holdingKey(h);
    const item = items.get(key) ?? { key, isin: h.isin, name: h.name, noun: NOUNS[h.kind], statementAsset: statementAsset(h), count: 0, units };
    item.count++;
    item.units ||= units;
    items.set(key, item);
  }
  return [...items.values()].map(({ count, units, ...item }) => ({
    ...item,
    where: [
      count > 1 && `in ${count} folios, demat accounts or PRANs`,
      !units && "no units on the statement, so only checked against transactions",
    ].filter(Boolean).join(" · ") || undefined,
  }));
}

const text = (value: number | string) => String(value);

async function snapshotDates(api: Api, accountId: string, holdings = true) {
  const snapshots = await api.snapshots.getAll(accountId);
  // getByDate reads manual snapshots for HOLDINGS accounts and calculated ones for other accounts.
  return [...new Set(snapshots.filter((s) => holdings ? s.source !== "CALCULATED" : s.source === "CALCULATED").map((s) => s.snapshotDate.slice(0, 10)))].sort();
}

/** The account's latest snapshot on or before `date`, as `planSnapshots` reads it. */
async function readExisting(api: Api, accountId: string, date: string): Promise<ExistingSnapshot> {
  const dates = await snapshotDates(api, accountId);
  const base = dates.filter((d) => d <= date).pop() ?? null;
  const later = dates.filter((d) => d > date);
  if (!base) return { date: null, positions: [], cash: {}, later };
  const existing: ExistingSnapshot = { date: base, positions: [], cash: {}, later };
  for (const h of await api.snapshots.getByDate(accountId, base)) {
    if (h.holdingType === "cash") {
      existing.cash[h.localCurrency] = text(h.quantity);
      continue;
    }
    // The host sends exchange and pricing mode fields that the SDK's type leaves out.
    const instrument = h.instrument as HostInstrument | null | undefined;
    if (!instrument?.id) throw new Error(`a holding in its snapshot of ${base} has no asset`);
    const cost = h.costBasis ? Number(h.costBasis.local) : 0;
    existing.positions.push({
      assetId: instrument.id,
      symbol: instrument.symbol,
      ref: fundRef(instrument.symbol, instrument.exchangeMic),
      name: instrument.name || instrument.symbol,
      units: text(h.quantity),
      cost: cost !== 0 ? text(h.costBasis!.local) : null,
      currency: h.localCurrency,
      manual: isManual(instrument),
    });
  }
  return existing;
}

/** The asset's latest quote on or before `date`, the price a kept manual-priced holding goes on with. */
async function priceOn(api: Api, assetId: string, date: string) {
  const quotes = await api.quotes.getHistory(assetId);
  const quote = quotes
    .filter((q) => Number.isFinite(q.close) && String(q.timestamp).slice(0, 10) <= date)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .pop();
  return quote && { close: text(quote.close), currency: quote.currency, onDate: String(quote.timestamp).slice(0, 10) === date ? quote : undefined };
}

/** A manual quote for the day, the way Wealthfolio's own quote editor saves one. */
const manualQuote = (assetId: string, date: string, price: string, currency: string): Quote => {
  const n = Number(price);
  return {
    // Wealthfolio's `quote_id` for a manual quote; another ID would be deleted first.
    id: `${assetId}_${date}_MANUAL`,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: `${date}T12:00:00.000Z`,
    assetId,
    open: n,
    high: n,
    low: n,
    close: n,
    adjclose: n,
    volume: 0,
    currency,
    notes: null,
  };
};

/**
 * After the account's snapshot is saved: each manual-priced holding gets the statement's price, or
 * the price it had, on the snapshot's date, over the average cost the save wrote there
 * (wealthfolio/wealthfolio#2331); each bond's and NPS scheme's asset, and each asset of a fund or
 * share priced from statements, gets the statement's details.
 * Returns what didn't work.
 */
async function afterSave(api: Api, plan: AccountPlan, chosen: Choices, listed: ReadonlyMap<string, string>, quotes: ReadonlyMap<string, Quote>, snapshotSaved = true): Promise<Unfinished[]> {
  const unfinished: Unfinished[] = [];
  const prices = pricesToSave(plan, chosen, listed);
  const described = snapshotSaved ? plan.positions.filter((p) => p.lines.length && included(p, chosen) && keepsDetails(p)) : [];
  if (!prices.length && !described.length) return unfinished;
  const ids = new Map<string, string>();
  try {
    for (const h of await api.snapshots.getByDate(plan.accountId, plan.date)) {
      const instrument = h.instrument as HostInstrument | null | undefined;
      if (instrument?.id && instrument.symbol) ids.set(fundRef(instrument.symbol, instrument.exchangeMic), instrument.id);
    }
  } catch {
    // Each holding below is reported.
  }
  for (const p of prices) {
    const assetId = p.assetId ?? ids.get(p.ref);
    // A failed save left no snapshot to find a new asset in, and the failure is already reported.
    if (!assetId && !snapshotSaved) continue;
    try {
      if (!assetId) throw new Error("not in the saved snapshot");
      const fresh = manualQuote(assetId, plan.date, p.price, p.currency);
      const before = quotes.get(assetId);
      await api.quotes.update(assetId, {
        ...fresh,
        ...(p.from === "earlier" && before),
        // A provider quote's ID must not be sent: the host would delete that provider row.
        id: fresh.id,
        dataSource: fresh.dataSource,
        notes: before?.notes ?? null,
      });
    } catch {
      unfinished.push({ accountId: plan.accountId, name: p.name, what: "price", date: plan.date });
    }
  }
  for (const position of described) {
    const assetId = position.existing?.assetId ?? position.asset?.assetId ?? ids.get(position.ref);
    try {
      if (!assetId) throw new Error("not in the saved snapshot");
      const profile = await api.assets.getProfile(assetId);
      let metadata: unknown = profile.metadata;
      for (const { holding } of position.lines) metadata = assetDetails(holding, metadata, profile.instrumentType) ?? metadata;
      if (metadata === profile.metadata) continue;
      // Wealthfolio stores the profile as sent: fields left out are cleared, and the price mode goes back to market.
      await api.assets.updateProfile({
        id: assetId,
        name: profile.name ?? null,
        displayCode: profile.displayCode ?? null,
        notes: profile.notes ?? "",
        kind: profile.kind,
        quoteMode: profile.quoteMode,
        quoteCcy: profile.quoteCcy,
        providerConfig: profile.providerConfig ?? null,
        metadata,
      } as UpdateAssetProfile);
    } catch {
      unfinished.push({ accountId: plan.accountId, name: position.name, what: "details", date: plan.date });
    }
  }
  return unfinished;
}

/** Which accounts hold each asset now: `fundRef` → accounts. */
async function holders(api: Api, accounts: Account[]) {
  const held = new Map<string, (OtherAccount & { id: string })[]>();
  const modes = new Map<string, boolean>();
  await Promise.all(
    accounts.map(async (account) => {
      let positions = await api.portfolio.getHoldings(account.id);
      const archivedSnapshot = account.isArchived && positions.length === 0;
      if (archivedSnapshot) {
        const date = (await snapshotDates(api, account.id, account.trackingMode === "HOLDINGS")).pop();
        positions = date ? await api.snapshots.getByDate(account.id, date) : [];
      }
      for (const h of positions) {
        const instrument = h.instrument as HostInstrument | null | undefined;
        if (h.holdingType === "cash" || !instrument?.symbol) continue;
        const ref = fundRef(instrument.symbol, instrument.exchangeMic);
        const mode = instrument.pricingMode ?? instrument.quoteMode;
        if (mode) modes.set(ref, modes.get(ref) === true || mode === "MANUAL");
        const quantity = Number(h.quantity);
        if (archivedSnapshot || !Number.isFinite(quantity) || quantity === 0) continue;
        const others = held.get(ref) ?? [];
        if (!others.some((o) => o.id === account.id)) {
          others.push({ id: account.id, name: account.name, tracksTransactions: account.trackingMode !== "HOLDINGS" });
        }
        held.set(ref, others);
      }
    }),
  );
  return { held, modes };
}

interface Previewed {
  plans: AccountPlan[];
  quotes: Map<string, Quote>;
}

export function HoldingsImport({
  ctx,
  statement,
  holdings,
  accounts,
  allAccounts,
  accountChoices,
  unavailable,
  onAccount,
  fundChoices,
  onFund,
  busy,
  setBusy,
}: {
  ctx: AddonContext;
  statement: Statement;
  holdings: Holdings;
  /** Active accounts. */
  accounts: Account[];
  allAccounts: Account[];
  /** Remembered choices of active, unarchived accounts, or `LEFT_OUT`. */
  accountChoices: HoldingsAccountChoices;
  /** Remembered choices of hidden, archived or missing accounts, ignored: key → the account. */
  unavailable: Record<string, Ignored>;
  onAccount: (key: string, value: string) => void;
  fundChoices: Record<string, FundChoice | undefined>;
  onFund: (key: string, choice: FundChoice | undefined) => void;
  busy: "" | "preview" | "import" | "check";
  setBusy: (busy: "" | "preview" | "import" | "check") => void;
}) {
  const { api } = ctx;
  const targets = accounts.filter((a) => a.trackingMode === "HOLDINGS");
  // Like a hidden, archived or missing one, a remembered account that no longer tracks holdings is
  // ignored, and its row says why.
  const usable: HoldingsAccountChoices = Object.fromEntries(
    Object.entries(accountChoices).filter(([, id]) => id === LEFT_OUT || targets.some((a) => a.id === id)),
  );
  const ignored: Record<string, Ignored> = {
    ...unavailable,
    ...Object.fromEntries(
      Object.entries(accountChoices).flatMap(([key, id]) => {
        const account = accounts.find((a) => a.id === id && a.trackingMode !== "HOLDINGS");
        return account ? [[key, { name: account.name }]] : [];
      }),
    ),
  };
  const [preview, setPreview] = useState<Previewed | null>(null);
  const [choices, setChoices] = useState<Map<string, Choices>>(new Map());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SavedSnapshots | null>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  // Holdings whose accounts compared the user confirmed hold the same units as the statement, by `ref`.
  const [same, setSame] = useState<Set<string>>(new Set());
  const items = holdingItems(holdings);
  // Printed zeros never go in a snapshot, so the snapshot preview doesn't wait for them.
  const snapshotKeys = new Set(holdings.sources.flatMap((s) => s.holdings.map(holdingKey)));

  // A source whose own account is ignored needs choosing again, even to go with the statement.
  const accountOf = (source: Source) => sourceKey(source) in ignored ? undefined : accountForSource(usable, holdings, source);
  const assetOf = (h: StatementHolding) => {
    const choice = fundChoices[holdingKey(h)];
    return choice && "fund" in choice ? choice.fund : undefined;
  };

  const changed = () => {
    setPreview(null);
    setResult(null);
  };

  // Empty sources still reconcile what an earlier import added to their account.
  const decided = (s: Source) => usable[sourceKey(s)] === LEFT_OUT || accountOf(s) !== undefined;
  const undecided =
    items.some((item) => snapshotKeys.has(item.key) && !fundChoices[item.key]) || holdings.sources.some((s) => !decided(s));
  const nothing = !undecided && !holdings.sources.some((s) => accountOf(s));
  const leftOut: LeftOutLine[] = [
    ...holdings.leftOut,
    ...holdings.sources.flatMap((source) =>
      source.holdings.flatMap((h) =>
        usable[sourceKey(source)] === LEFT_OUT
          ? [{ source: source.label, name: h.name, reason: "Its folio, demat account or PRAN is left out." }]
          : fundChoices[holdingKey(h)] && !assetOf(h)
            ? [{ source: source.label, name: h.name, reason: `You left this ${NOUNS[h.kind]} out.` }]
            : [],
      ),
    ),
  ];

  const runPreview = async () => {
    setBusy("preview");
    setError("");
    changed();
    try {
      const bySource = holdings.sources.flatMap((source) => {
        const accountId = accountOf(source);
        return accountId ? [{ source, accountId }] : [];
      });
      const ids = [...new Set(bySource.map((s) => s.accountId))];
      const [existing, { held, modes }] = await Promise.all([
        Promise.all(ids.map(async (id) => [id, await readExisting(api, id, holdings.date)] as const)).then((e) => new Map(e)),
        holders(api, allAccounts),
      ]);
      const resolved = new Map<string, { assetId: string; symbol: string; exchangeMic?: string; manual: boolean }>();
      const assets = new Map(bySource.flatMap(({ source }) => source.holdings.flatMap((h) => {
        const asset = assetOf(h);
        return asset ? [[fundRef(asset.symbol, asset.exchangeMic), asset] as const] : [];
      })));
      // Without a resolved asset, the choice's own fields create or find it on saving, as before.
      await Promise.all([...assets].map(async ([ref, asset]) => {
        try {
          let assetId = asset.assetId;
          if (!assetId && (asset.statementPrices || modes.get(ref) || asset.manual)) {
            const same = (await api.market.searchTicker(asset.symbol)).filter((r) =>
              r.existingAssetId && fundRef(r.canonicalSymbol || r.symbol, r.canonicalExchangeMic || r.exchangeMic) === ref);
            const type = instrumentType(asset.instrumentType);
            // Keep exact types first; snapshot saving defaults an unknown choice type to EQUITY.
            const found = same.find((r) => instrumentType(r.quoteType) === type) ??
              (!/^(EQUITY|CRYPTO|FX|OPTION|METAL|BOND)$/.test(type) ? same.find((r) => instrumentType(r.quoteType) === "EQUITY") : undefined);
            assetId = found?.existingAssetId;
          }
          if (!assetId && modes.get(ref)) throw new Error("Existing manual asset not found");
          if (!assetId) return;
          // Throws for an asset deleted since it was chosen.
          const profile = await api.assets.getProfile(assetId);
          const current = {
            assetId, symbol: profile.instrumentSymbol || asset.symbol, exchangeMic: profile.instrumentExchangeMic ?? undefined,
            manual: profile.quoteMode === "MANUAL",
          };
          resolved.set(ref, current);
          modes.set(ref, current.manual);
          modes.set(fundRef(current.symbol, current.exchangeMic), current.manual);
        } catch {
          // A manual asset's ID is needed to preserve its quote before saving.
          if (modes.get(ref) ?? asset.manual ?? asset.statementPrices) {
            throw new Error(`Couldn't verify pricing for ${asset.name}. Try the preview again.`);
          }
          // Unresolved: left to the choice's fields.
        }
      }));
      const refs = new Map([...resolved.values()].map((asset) => [asset.assetId, fundRef(asset.symbol, asset.exchangeMic)]));
      const older = [...existing.values()].some((snapshot) => snapshot.date && snapshot.date < holdings.date && snapshot.positions.length > 0);
      const activities = older ? await api.activities.getAll() : [];
      for (const snapshot of existing.values()) {
        const split = splitSince(snapshot, holdings.date, activities);
        for (const position of snapshot.positions) {
          position.ref = refs.get(position.assetId) ?? position.ref;
          position.manual = modes.get(position.ref) ?? position.manual;
          position.split = split.has(position.assetId);
        }
      }
      // Capture prices and same-day quote details before the host's snapshot write replaces them.
      const manualIds = new Set([
        ...[...existing.values()].flatMap((s) => s.positions.filter((p) => p.manual).map((p) => p.assetId)),
        ...[...resolved.values()].filter((a) => a.manual).map((a) => a.assetId),
      ]);
      const prices = new Map(await Promise.all([...manualIds].map(async (id) => [id, await priceOn(api, id, holdings.date)] as const)));
      for (const snapshot of existing.values()) {
        for (const position of snapshot.positions) position.price = prices.get(position.assetId);
      }
      const remembered = new Map(await Promise.all(
        bySource.map(async ({ source, accountId }) => [
          `${source.id}|${accountId}`,
          await readImported(api.storage, source, accountId, existing.get(accountId)!.date),
        ] as const),
      ));
      const plans = planSnapshots(holdings, {
        account: accountOf,
        asset: (holding) => {
          const asset = assetOf(holding);
          if (!asset) return undefined;
          // A remembered choice doesn't store the pricing mode; one priced from statements is manual until Wealthfolio says otherwise.
          const ref = fundRef(asset.symbol, asset.exchangeMic);
          // A remembered asset ID that no longer resolves would make Wealthfolio create a bare asset under it.
          return { ...asset, assetId: undefined, ...resolved.get(ref), manual: modes.get(ref) ?? asset.manual ?? asset.statementPrices };
        },
        existing: (id) => existing.get(id)!,
        remembered: (source, accountId) => remembered.get(`${source.id}|${accountId}`) ?? new Map(),
        heldElsewhere: (ref, accountId) => (held.get(ref) ?? []).filter((o) => o.id !== accountId),
      });
      setPreview({ plans, quotes: new Map([...prices].flatMap(([id, p]) => p?.onDate ? [[id, p.onDate] as const] : [])) });
      setChoices(new Map(plans.map((p) => [p.accountId, noChoices()])));
      setConfirmed(new Set());
    } catch (e) {
      setError(`Couldn't prepare the preview: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy("import");
    setError("");
    const saved: SavedSnapshots = { saved: [], failed: [], unremembered: false, unfinished: [] };
    try {
      // The statement's price for each manual-priced asset any account's snapshot lists.
      const listed = new Map(preview.plans.flatMap((plan) =>
        pricesToSave(plan, choices.get(plan.accountId) ?? noChoices()).filter((p) => p.from === "statement").map((p) => [p.ref, p.price] as const)));
      for (const plan of preview.plans) {
        const chosen = choices.get(plan.accountId) ?? noChoices();
        const { holdings: positions, cash } = snapshotOf(plan, chosen);
        try {
          await api.snapshots.save(plan.accountId, positions, cash, plan.date);
          saved.saved.push({ accountId: plan.accountId, date: plan.date, holdings: positions.length });
        } catch (e) {
          saved.failed.push({ accountId: plan.accountId, error: String(e) });
          // A failed host save can already have written average-cost quotes.
          saved.unfinished.push(...(await afterSave(api, plan, chosen, listed, preview.quotes, false)));
          continue;
        }
        saved.unfinished.push(...(await afterSave(api, plan, chosen, listed, preview.quotes)));
        try {
          for (const { source, refs } of importedRefs(plan, chosen)) await saveImported(api.storage, source, plan.accountId, plan.date, refs);
        } catch {
          saved.unremembered = true;
        }
      }
    } catch (e) {
      setError(`The import stopped: ${String(e)}`);
    } finally {
      setPreview(null);
      setResult(saved);
      for (const key of [QueryKeys.HOLDINGS, QueryKeys.SNAPSHOTS, QueryKeys.ACCOUNTS, QueryKeys.PORTFOLIO_SUMMARY, QueryKeys.HISTORY_VALUATION]) {
        api.query.invalidateQueries([key]);
      }
      setBusy("");
    }
  };

  const runCheck = async () => {
    setBusy("check");
    setError("");
    setChecked(null);
    setSame(new Set());
    try {
      const tracked = allAccounts.filter((a) => a.trackingMode !== "HOLDINGS");
      const accounts = tracked.filter((a) => !a.isArchived);
      const timeZone = await engineTimeZone(api.settings);
      let activities: ActivityDetails[] | { error: string };
      try {
        activities = await api.activities.getAll();
      } catch (e) {
        activities = { error: String(e) };
      }
      // A choice without an asset ID is matched by the symbol and exchange on each asset's profile.
      const identities = new Map<string, string | { error: string }>();
      const unidentified = holdings.sources.some((s) => [...s.holdings, ...(s.zero ?? [])].some((h) => assetOf(h) && !assetOf(h)!.assetId));
      if (Array.isArray(activities) && unidentified) {
        const ids = new Set(activities.filter((a) => a.assetId && accounts.some((account) => account.id === a.accountId)).map((a) => a.assetId));
        await Promise.all([...ids].map(async (id) => {
          try {
            const profile = await api.assets.getProfile(id);
            identities.set(id, fundRef(profile.instrumentSymbol ?? "", profile.instrumentExchangeMic));
          } catch (e) {
            identities.set(id, { error: String(e) });
          }
        }));
      }
      setChecked({
        // Wealthfolio shows add-ons no activities of archived accounts.
        checks: checkUnits(holdings, { asset: assetOf, accounts, activities, identities, timeZone }),
        archived: tracked.filter((a) => a.isArchived).map((a) => a.name),
      });
    } catch (e) {
      setError(`Couldn't check the units: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };
  const confirmedAny = items.some((item) => {
    const choice = fundChoices[item.key];
    return choice && "fund" in choice;
  });

  const update = (accountId: string, change: (c: Choices) => Choices) =>
    setChoices((all) => new Map(all).set(accountId, change(all.get(accountId) ?? noChoices())));

  return (
    <>
      <HoldingsSummary statement={statement} holdings={holdings} />
      {leftOut.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Left out</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ps-4">
              {leftOut.map((line, i) => (
                <li key={i}>{line.name}, {line.source}: {line.reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <HoldingsAccountsCard
        holdings={holdings}
        accounts={targets}
        choices={usable}
        ignored={ignored}
        onChange={(key, value) => {
          changed();
          onAccount(key, value);
        }}
      />
      <FundChoicesCard
        ctx={ctx}
        items={items}
        choices={fundChoices}
        onChange={(key, choice) => {
          changed();
          setChecked(null);
          onFund(key, choice);
        }}
        title="Holdings"
        intro="Confirm the Wealthfolio asset for each holding. Holdings are searched by their printed ISIN, and by name when that finds nothing or no ISIN is printed. A holding that no result fits can use the statement's prices: the add-on creates an asset priced by hand, saves the statement's price on its date, and keeps the printed name, identifiers and details on the asset. Its price then changes only with the statements you import or the prices you enter, not with market data. The add-on remembers what you confirm for each ISIN or scheme, for detailed statements too, except the statement's prices, which detailed statements don't use."
      />
      <UnitsCheckCard
        checked={checked}
        same={same}
        checking={busy === "check"}
        blocked={
          items.some((item) => !fundChoices[item.key])
            ? "Confirm or leave out each holding first."
            : !confirmedAny
              ? "Every holding is left out, so there's nothing to check."
              : ""
        }
        onCheck={() => void runCheck()}
        onSame={(ref, yes) =>
          setSame((set) => {
            const next = new Set(set);
            if (yes) next.add(ref);
            else next.delete(ref);
            return next;
          })
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={undecided || nothing || busy !== ""} onClick={() => void runPreview()}>
          {busy === "preview" && <Spinner />}
          Preview the snapshots
        </Button>
        {(undecided || nothing) && (
          <span className="text-muted-foreground text-sm">
            {targets.length === 0
              ? "No account tracks holdings, so there's nowhere to save a snapshot."
              : undecided
                ? "Confirm or leave out each holding, and choose an account for each folio, demat account and PRAN first."
                : "Everything is left out, so there's nothing to import."}
          </span>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {preview && (
        <HoldingsPreview
          plans={preview.plans}
          accounts={accounts}
          choices={choices}
          confirmed={confirmed}
          importing={busy === "import"}
          onFlip={(accountId, key) =>
            update(accountId, (c) => {
              const flipped = new Set(c.flipped);
              if (!flipped.delete(key)) flipped.add(key);
              return { ...c, flipped };
            })
          }
          onCost={(accountId, key, text) => update(accountId, (c) => ({ ...c, costs: new Map(c.costs).set(key, text) }))}
          onConfirm={(accountId, yes) =>
            setConfirmed((set) => {
              const next = new Set(set);
              if (yes) next.add(accountId);
              else next.delete(accountId);
              return next;
            })
          }
          onImport={() => void runImport()}
        />
      )}
      {result && <HoldingsResult result={result} accounts={accounts} />}
    </>
  );
}

function HoldingsSummary({ statement, holdings }: { statement: Statement; holdings: Holdings }) {
  const kind = "cas_type" in statement ? `${statement.file_type} summary` : statement.file_type;
  const count = (k: Source["kind"]) => holdings.sources.filter((s) => s.kind === k).length;
  const lines = holdings.sources.reduce((n, s) => n + s.holdings.length, 0);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {kind} statement for {statement.investor_info.name}, as on {statement.statement_period.to}:{" "}
        {count("demat") > 0 && `${count("demat")} demat accounts, `}
        {count("folio")} folios, {count("nps") > 0 && `${count("nps")} NPS ${count("nps") === 1 ? "account" : "accounts"}, `}
        {lines} holdings.
      </p>
      {"cas_type" in statement && (
        <p className="text-muted-foreground text-sm">
          Check each folio's funds and AMC against the PDF. The parser can merge equal folio numbers across AMCs without a warning.
        </p>
      )}
      {statement.parse_warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>casparser reported warnings</AlertTitle>
          <AlertDescription>
            Check these warnings against the PDF before importing.
            <ul className="list-disc ps-4">
              {statement.parse_warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
