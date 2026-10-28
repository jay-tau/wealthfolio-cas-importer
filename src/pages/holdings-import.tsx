import type { Account, AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@wealthfolio/ui";
import { useState } from "react";
import {
  type AccountPlan,
  type Choices,
  type ExistingSnapshot,
  type Holdings,
  importedRefs,
  type LeftOutLine,
  type OtherAccount,
  planSnapshots,
  snapshotOf,
  type Source,
  splitSince,
  type StatementHolding,
} from "../cas/holdings";
import { fundRef } from "../cas/plan";
import type { Statement } from "../cas/types";
import { type FundChoice, FundChoicesCard, type FundItem } from "../components/fund-choices";
import { accountForSource, type HoldingsAccountChoices, HoldingsAccountsCard } from "../components/holdings-accounts";
import { HoldingsPreview, HoldingsResult, noChoices, type SavedSnapshots } from "../components/holdings-preview";
import { holdingKey, LEFT_OUT, readImported, saveImported, sourceKey } from "../lib/choices";

type Api = AddonContext["api"];
type HostInstrument = NonNullable<Holding["instrument"]> & {
  exchangeMic?: string | null;
  pricingMode?: string | null;
  quoteMode?: string | null;
};
const isManual = (instrument: HostInstrument) => (instrument.pricingMode ?? instrument.quoteMode) === "MANUAL";

/** The statement's funds and shares, one entry each however many folios or demat accounts hold it. */
export function holdingItems(holdings: Holdings): FundItem[] {
  const items = new Map<string, FundItem & { count: number }>();
  for (const h of holdings.sources.flatMap((s) => s.holdings)) {
    const key = holdingKey(h);
    const item = items.get(key) ?? { key, isin: h.isin, name: h.name, noun: h.kind, count: 0 };
    item.count++;
    items.set(key, item);
  }
  return [...items.values()].map(({ count, ...item }) => ({
    ...item,
    where: count > 1 ? `in ${count} folios or demat accounts` : undefined,
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
}

export function HoldingsImport({
  ctx,
  statement,
  holdings,
  accounts,
  allAccounts,
  accountChoices,
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
  accountChoices: HoldingsAccountChoices;
  onAccount: (key: string, value: string) => void;
  fundChoices: Record<string, FundChoice | undefined>;
  onFund: (key: string, choice: FundChoice | undefined) => void;
  busy: "" | "preview" | "import";
  setBusy: (busy: "" | "preview" | "import") => void;
}) {
  const { api } = ctx;
  const targets = accounts.filter((a) => a.trackingMode === "HOLDINGS");
  // A remembered account that no longer tracks holdings is ignored.
  const usable: HoldingsAccountChoices = Object.fromEntries(
    Object.entries(accountChoices).filter(([, id]) => id === LEFT_OUT || targets.some((a) => a.id === id)),
  );
  const [preview, setPreview] = useState<Previewed | null>(null);
  const [choices, setChoices] = useState<Map<string, Choices>>(new Map());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SavedSnapshots | null>(null);
  const [error, setError] = useState("");
  const items = holdingItems(holdings);

  const accountOf = (source: Source) => accountForSource(usable, holdings, source);
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
    items.some((item) => !fundChoices[item.key]) || holdings.sources.some((s) => !decided(s));
  const nothing = !undecided && !holdings.sources.some((s) => accountOf(s));
  const leftOut: LeftOutLine[] = [
    ...holdings.leftOut,
    ...holdings.sources.flatMap((source) =>
      source.holdings.flatMap((h) =>
        usable[sourceKey(source)] === LEFT_OUT
          ? [{ source: source.label, name: h.name, reason: "Its folio or demat account is left out." }]
          : fundChoices[holdingKey(h)] && !assetOf(h)
            ? [{ source: source.label, name: h.name, reason: `You left this ${h.kind} out.` }]
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
      const older = [...existing.values()].some((snapshot) => snapshot.date && snapshot.date < holdings.date && snapshot.positions.length > 0);
      const activities = older ? await api.activities.getAll() : [];
      for (const snapshot of existing.values()) {
        const split = splitSince(snapshot, holdings.date, activities);
        for (const position of snapshot.positions) {
          position.manual = modes.get(position.ref) ?? position.manual;
          position.split = split.has(position.assetId);
        }
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
          return asset && { ...asset, manual: modes.get(fundRef(asset.symbol, asset.exchangeMic)) ?? asset.manual };
        },
        existing: (id) => existing.get(id)!,
        remembered: (source, accountId) => remembered.get(`${source.id}|${accountId}`) ?? new Map(),
        heldElsewhere: (ref, accountId) => (held.get(ref) ?? []).filter((o) => o.id !== accountId),
      });
      setPreview({ plans });
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
    const saved: SavedSnapshots = { saved: [], failed: [], unremembered: false };
    try {
      for (const plan of preview.plans) {
        const chosen = choices.get(plan.accountId) ?? noChoices();
        const { holdings: positions, cash } = snapshotOf(plan, chosen);
        try {
          await api.snapshots.save(plan.accountId, positions, cash, plan.date);
          saved.saved.push({ accountId: plan.accountId, date: plan.date, holdings: positions.length });
        } catch (e) {
          saved.failed.push({ accountId: plan.accountId, error: String(e) });
          continue;
        }
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
          onFund(key, choice);
        }}
        title="Funds and shares"
        intro="Confirm the Wealthfolio fund or share for each holding. They are searched by their printed ISIN, and by name when that finds nothing; the add-on remembers what you confirm for each ISIN, for detailed statements too."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={undecided || nothing || busy !== ""} onClick={() => void runPreview()}>
          {busy === "preview" && <Spinner />}
          Preview the snapshots
        </Button>
        {(undecided || nothing) && (
          <span className="text-muted-foreground text-sm">
            {undecided
              ? "Confirm or leave out each fund and share, and choose an account for each folio and demat account first."
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
        {count("folio")} folios, {lines} holdings.
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
