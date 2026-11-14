import type { Account, ActivityDetails, AddonContext, Asset, Holding, Quote, UpdateAssetProfile } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Spinner } from "@wealthfolio/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { abs, add, dec, format, sub } from "../cas/decimal";
import {
  type AccountPlan,
  asked,
  assetDetails,
  assetNames,
  checkUnits,
  type Choices,
  existingCost,
  type ExistingSnapshot,
  type HoldingKind,
  type Holdings,
  importedRefs,
  included,
  keepsDetails,
  type OtherAccount,
  type PlannedPosition,
  planSnapshots,
  pricesToSave,
  reconcileRecord,
  replacesSnapshot,
  snapshotOf,
  type Source,
  splitSince,
  statementAsset,
  type StatementHolding,
  type UnitCheck,
  undecided,
  unidentified,
  unitStatus,
  unlistedRefs,
} from "../cas/holdings";
import { engineTimeZone, fundRef } from "../cas/plan";
import type { Statement } from "../cas/types";
import { type Ignored, NewAccountLine, type Proposed, type Renaming } from "../components/account-choices";
import type { AmfiCheck } from "../components/amfi-banner";
import type { FundChoice, FundItem } from "../components/fund-choices";
import { HoldingsResult, type NotCreated, NotCreatedAlert, type SavedSnapshots, type Unfinished } from "../components/holdings-preview";
import { useReviewFocus } from "../components/review/focus";
import { Footer } from "../components/review/footer";
import { ReviewHeader } from "../components/review/header";
import { type Comparison, NotIncluded, type TrackedFund, type TrackedGroup, unitsText } from "../components/review/not-included";
import { Disclosure, LinkButton, PlanBadges, providerName, shownName, useWide, WrapButton } from "../components/review/parts";
import { AskAnswered, AskCard } from "../components/review/asks";
import { SnapshotTable } from "../components/review/plan-parts";
import { AnsweredLine, answerWords, Picker, pickerIds, QuestionCard } from "../components/review/question";
import { OtherChanges, type ReadyHandlers, type ReadyRow, ReadyTable, planWarnings } from "../components/review/ready";
import { SaveTo } from "../components/review/save-to";
import { statementPlan, useHoldingSearches } from "../components/review/search";
import {
  type ChosenFund,
  holdingKey,
  indexSources,
  investorKey,
  LEFT_OUT,
  readImported,
  readRecordChoices,
  readUnlisted,
  saveImports,
  saveUnlisted,
  securityKey,
  sourceKey,
} from "../lib/choices";
import { type AskWords, holdingAskWords, list, sameDateChanges, sameDateWords } from "../lib/asks";
import { fundName, readableName } from "../lib/fund-name";
import { instrumentType } from "../lib/instrument-type";
import { nameNumber } from "../lib/name-number";
import { holdingsBase, isProposed, nameProblem, newAccount, proposalKey, proposedId, proposedNames, sourceBase } from "../lib/new-accounts";
import { plural } from "../lib/plural";
import { grouped, longDate, parseCost, rupees, units } from "../lib/review-format";
import { sha256 } from "../lib/sha256";

/** Remembered or chosen: investor key or source key → account ID, or `LEFT_OUT`. */
export type HoldingsAccountChoices = Record<string, string>;

type Api = AddonContext["api"];
type HostInstrument = NonNullable<Holding["instrument"]> & {
  exchangeMic?: string | null;
  pricingMode?: string | null;
  quoteMode?: string | null;
};
const isManual = (instrument: HostInstrument) => (instrument.pricingMode ?? instrument.quoteMode) === "MANUAL";

type Profiles = (assetId: string) => Promise<Asset>;
/** Reads each asset's profile once. */
const profiles = (api: Api): Profiles => {
  const read = new Map<string, Promise<Asset>>();
  return (id) => {
    if (!read.has(id)) read.set(id, api.assets.getProfile(id));
    return read.get(id)!;
  };
};

/**
 * Asset ID → `fundRef` of the symbol and exchange on its profile, for each security of `holdings`.
 * A holding shows its asset's display code, which the user can change.
 */
async function refsOf(profileOf: Profiles, holdings: Holding[]) {
  const instruments = holdings.flatMap((h) => (h.holdingType !== "cash" && h.instrument?.id ? [h.instrument as HostInstrument] : []));
  return new Map(await Promise.all(instruments.map(async (instrument) => {
    let asset: Asset;
    try {
      asset = await profileOf(instrument.id);
    } catch (e) {
      throw new Error(`Couldn't read the Wealthfolio profile of ${instrument.name || instrument.symbol}: ${String(e)}. Try again.`);
    }
    return [instrument.id, fundRef(asset.instrumentSymbol || instrument.symbol, asset.instrumentExchangeMic)] as const;
  })));
}

const NOUNS: Record<HoldingKind, FundItem["noun"]> = { fund: "fund", share: "share", bond: "bond", nps: "NPS scheme" };

/**
 * The statement's holdings, one entry each however many folios, demat accounts or PRANs hold it.
 * Misread lines are asked about too, to hold their asset back; printed zeros are counted and listed
 * as not included, but never asked about.
 */
export function holdingItems(holdings: Holdings): FundItem[] {
  const items = new Map<string, FundItem & { count: number; misread: boolean }>();
  for (const [h, line] of holdings.sources.flatMap((s) => [
    ...s.holdings.map((h) => [h, "units"] as const),
    ...(s.zero ?? []).map((h) => [h, "zero"] as const),
    ...(s.misread ?? []).map((h) => [h, "misread"] as const),
  ])) {
    const key = holdingKey(h);
    const item = items.get(key) ??
      { key, isin: h.isin, name: h.name, cut: h.cut, noun: NOUNS[h.kind], statementAsset: statementAsset(h), count: 0, misread: false };
    item.count++;
    item.misread ||= line === "misread";
    items.set(key, item);
  }
  return [...items.values()].map(({ count, misread, ...item }) => ({
    ...item,
    where: [
      count > 1 && `in ${count} folios, demat accounts or PRANs`,
      misread && "a line may have been misread, so the import leaves its holding as it is",
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
async function readExisting(api: Api, profileOf: Profiles, accountId: string, date: string): Promise<ExistingSnapshot> {
  const dates = await snapshotDates(api, accountId);
  const base = dates.filter((d) => d <= date).pop() ?? null;
  const later = dates.filter((d) => d > date);
  if (!base) return { date: null, positions: [], cash: {}, later };
  const existing: ExistingSnapshot = { date: base, positions: [], cash: {}, later };
  const holdings = await api.snapshots.getByDate(accountId, base);
  const refs = await refsOf(profileOf, holdings);
  for (const h of holdings) {
    if (h.holdingType === "cash") {
      existing.cash[h.localCurrency] = text(h.quantity);
      continue;
    }
    // The host sends exchange and pricing mode fields that the SDK's type leaves out.
    const instrument = h.instrument as HostInstrument | null | undefined;
    if (!instrument?.id) throw new Error(`a holding in its snapshot of ${base} has no asset`);
    existing.positions.push({
      assetId: instrument.id,
      symbol: instrument.symbol,
      ref: refs.get(instrument.id)!,
      name: instrument.name || instrument.symbol,
      units: text(h.quantity),
      cost: existingCost(h.costBasis),
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
 * The assets of the account's snapshot on the date, as saved: `fundRef` → ID, for those the save
 * created or found. One whose profile can't be read is missing, as all are when the snapshot can't be
 * read; the caller reports each one it misses.
 */
async function savedAssets(api: Api, accountId: string, date: string) {
  const ids = new Map<string, string>();
  try {
    const profileOf = profiles(api);
    await Promise.all((await api.snapshots.getByDate(accountId, date)).map(async (h) => {
      try {
        for (const [id, ref] of await refsOf(profileOf, [h])) ids.set(ref, id);
      } catch {
        // Keep readable assets' IDs.
      }
    }));
  } catch {
    // None found.
  }
  return ids;
}

/**
 * After the account's snapshot is saved: each manual-priced holding gets the statement's price, or
 * the price it had, on the snapshot's date, over the average cost the save wrote there
 * (wealthfolio/wealthfolio#2331); each bond's and NPS scheme's asset, and each asset of a fund or
 * share priced from statements, gets the statement's details. `saved` gives `savedAssets`.
 * Returns what didn't work.
 */
async function afterSave(
  api: Api, plan: AccountPlan, chosen: Choices, listed: ReadonlyMap<string, string>, quotes: ReadonlyMap<string, Quote>,
  saved: () => Promise<ReadonlyMap<string, string>>, snapshotSaved = true,
): Promise<Unfinished[]> {
  const unfinished: Unfinished[] = [];
  const prices = pricesToSave(plan, chosen, listed);
  const described = snapshotSaved ? plan.positions.filter((p) => p.lines.length && included(p, chosen) && keepsDetails(p)) : [];
  if (!prices.length && !described.length) return unfinished;
  const idOf = (p: PlannedPosition) => p.existing?.assetId ?? p.asset?.assetId;
  // An asset the save created or found: `fundRef` → ID.
  const ids = prices.some((p) => !p.assetId) || described.some((p) => !idOf(p)) ? await saved() : new Map<string, string>();
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
    const assetId = idOf(position) ?? ids.get(position.ref);
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
async function holders(api: Api, profileOf: Profiles, accounts: Account[]) {
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
      const refs = await refsOf(profileOf, positions);
      for (const h of positions) {
        const instrument = h.instrument as HostInstrument | null | undefined;
        const ref = instrument && refs.get(instrument.id);
        if (!ref) continue;
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


/** What the automatic plan found: each account's snapshot, who holds what, and the overlap comparison. */
interface Prepared {
  /** The choices it was worked out from. */
  signature: string;
  plans: AccountPlan[];
  quotes: Map<string, Quote>;
  /** `fundRef` → the accounts that hold the asset now. */
  held: Map<string, (OtherAccount & { id: string })[]>;
  /** The check of the confirmed holdings against the accounts that track transactions, when one holds any. */
  checks?: UnitCheck[];
}

/** An edit that's open: a cost editor or a holding's Change. */
type Editor =
  | { kind: "cost"; rowId: string; accountId: string; key: string; name: string; draft: string; error: boolean }
  | { kind: "change"; rowId: string; itemKey: string; name: string };

export interface Remembered {
  accounts: [string, string][];
  funds: [string, FundChoice][];
}

/** A question only some imports ask, on the Review screen. */
interface Ask {
  id: string;
  accountId: string;
  words: AskWords;
  /** What replacing the account's saved holdings changes, for the same-date question. */
  changes?: string[];
  /** What its buttons act on, after their visible labels, with the numbered account when names repeat. */
  target: string;
  /** True for the main (safe) answer, false for the other; undefined until answered. */
  answer: boolean | undefined;
  set: (answer: boolean | undefined) => void;
}

const KINDS: Record<string, string> = { CAMS: "CAMS", KFINTECH: "KFintech", NSDL: "NSDL", CDSL: "CDSL" };
/** The order of an account's rare questions. */
const ASK_ORDER = ["missing", "moved", "overlap", "replace"];
/** A mutual fund's symbol: its ISIN (INF…), an AMFI scheme code, a Yahoo fund listing (0P…) or the statement's price. */
const FUND_SYMBOL = /^(INF|\d+$|0P|MF-)/i;
const OVERLAP_NOTE = "from its transactions. Including it here counts it twice.";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const unitWords = (item: FundItem, value: string) =>
  item.noun === "share" ? `${grouped(value)} ${value === "1" ? "share" : "shares"}`
  : item.noun === "bond" ? `${grouped(value)} ${value === "1" ? "bond" : "bonds"}`
  : `${units(value)} units`;

/**
 * A summary or depository statement's holdings on one Review screen: where they're saved, what needs
 * an answer, what will be saved and what won't, and one button. Each account's snapshot is worked out
 * again as the answers settle. Nothing is remembered until the snapshots are saved or the review is
 * finished, so Use another file discards it all.
 */
export function HoldingsImport({
  ctx,
  statement,
  holdings,
  fileName,
  accounts,
  allAccounts,
  accountChoices,
  unavailable,
  fundChoices,
  amfi,
  visit,
  busy,
  setBusy,
  onRemember,
  onCreated,
  onAnother,
}: {
  ctx: AddonContext;
  statement: Statement;
  holdings: Holdings;
  fileName: string;
  /** Active accounts. */
  accounts: Account[];
  allAccounts: Account[];
  /** Remembered choices of active, unarchived accounts, or `LEFT_OUT`. */
  accountChoices: HoldingsAccountChoices;
  /** Remembered choices of hidden, archived or missing accounts, ignored: key → the account. */
  unavailable: Record<string, Ignored>;
  /** Remembered fund choices. */
  fundChoices: Record<string, FundChoice | undefined>;
  amfi: AmfiCheck;
  /** The page's route location, new each time the page is opened again. */
  visit: unknown;
  busy: "" | "preview" | "import" | "check";
  setBusy: (busy: "" | "preview" | "import" | "check") => void;
  /** Remembers the review's account and fund choices. */
  onRemember: (remembered: Remembered) => void;
  /** Adds the accounts the save created to the page's accounts. */
  onCreated: (accounts: Account[]) => void;
  /** Leaves the review for the file form; `notice` says what happened. */
  onAnother: (notice?: string) => void;
}) {
  const { api } = ctx;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (part: string) => `${uid}-${part.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const targets = accounts.filter((a) => a.trackingMode === "HOLDINGS");
  // Accounts that track transactions, which in Wealthfolio include NOT_SET; the unarchived ones are compared.
  const compared = allAccounts.filter((a) => a.trackingMode !== "HOLDINGS" && !a.isArchived);
  const comparedLabels = new Map(compared.map((a, i) => [a.id, `${a.name.trim()}${nameNumber(compared, i, "account")}`]));
  // Like a hidden, archived or missing one, a remembered account that no longer tracks holdings is
  // ignored, and its row says why.
  const usable: HoldingsAccountChoices = Object.fromEntries(
    Object.entries(accountChoices).filter(([, account]) => account === LEFT_OUT || targets.some((a) => a.id === account)),
  );
  const ignored: Record<string, Ignored> = {
    ...unavailable,
    ...Object.fromEntries(
      Object.entries(accountChoices).flatMap(([key, account]) => {
        const found = accounts.find((a) => a.id === account && a.trackingMode !== "HOLDINGS");
        return found ? [[key, { name: found.name }]] : [];
      }),
    ),
  };
  const items = useMemo(() => holdingItems(holdings), [holdings]);
  const itemOf = new Map(items.map((item) => [item.key, item]));
  const labelOf = new Map(items.map((item, i) => [item.key, `${item.name.trim()}${nameNumber(items, i, item.noun)}`]));
  const investor = investorKey(holdings.investor);
  const date = longDate(holdings.date);
  // Printed zeros never go in a snapshot; misread lines hold back their asset, so they need one.
  const snapshotKeys = new Set(holdings.sources.flatMap((s) => [...s.holdings, ...(s.misread ?? [])].map(holdingKey)));

  // A new account each select offers, created when the holdings are saved: the investor's, named after
  // the depository or "Mutual funds", and each folio's, demat account's and PRAN's, named after it.
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  // The accounts this review created, by proposed ID: saving again goes into them, never creating another.
  const created = useRef(new Map<string, Account>());
  // Names a save tried and couldn't create, kept while the created accounts take theirs.
  const tried = useRef<Record<string, string>>({});
  const proposalNames = proposedNames(
    [{ key: investor, base: holdingsBase(statement.file_type) }, ...holdings.sources.map((s) => ({ key: sourceKey(s), base: sourceBase(s) }))],
    allAccounts.map((a) => a.name),
    { ...tried.current, ...renamed },
  );
  const proposed = (key: string): Proposed => ({ id: proposedId(key), name: proposalNames.get(key) ?? "" });
  // Accounts this review creates don't change what it preselected.
  const proposeNew = useRef(targets.length === 0).current;

  // The review's own choices, over the remembered ones.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, FundChoice | undefined>>({});
  const [matched, setMatched] = useState<Record<string, ChosenFund>>({});
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [costs, setCosts] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());
  // Answers to the rare questions, by account: keep (true) or remove an account's units of a
  // position, replace (true) or keep an old asset, and keep (true) or replace the holdings saved for the date.
  const [keeps, setKeeps] = useState<ReadonlyMap<string, ReadonlyMap<string, boolean>>>(new Map());
  const [replaced, setReplaced] = useState<ReadonlyMap<string, ReadonlyMap<string, boolean>>>(new Map());
  const [sameDate, setSameDate] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [alsoSave, setAlsoSave] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [open, setOpenState] = useState<Record<string, boolean>>({});
  const setOpen = (key: string, yes: boolean) => setOpenState((all) => ({ ...all, [key]: yes }));
  const [editor, setEditor] = useState<Editor | null>(null);
  const [nag, setNag] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [openedSettings, setOpenedSettings] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [prepareError, setPrepareError] = useState("");
  const [result, setResult] = useState<SaveResult | null>(null);
  // Accounts the last save couldn't create; it saved nothing else, so the review stays.
  const [notCreated, setNotCreated] = useState<NotCreated[]>([]);
  // Bumped by each save, so its result takes the focus again.
  const [saves, setSaves] = useState(0);
  const [saving, setSaving] = useState<Record<string, "saving" | "saved" | "failed">>({});
  const [error, setError] = useState("");
  // Bumped when the page is opened again or Try again is pressed: Wealthfolio may have changed meanwhile.
  const [generation, setGeneration] = useState(0);
  // Refreshed holdings can change the evidence for every snapshot and holding question.
  useEffect(() => {
    setSameDate(new Map());
    setKeeps(new Map());
    setReplaced(new Map());
  }, [generation]);
  const wide = useWide();

  // One status region says what changed, and the focus moves with the answers.
  const { said, announce, focusSoon } = useReviewFocus();

  // Each choice as the select shows it: an account ID, `LEFT_OUT`, "" for Same as above, null for none yet.
  // With no account that tracks holdings when the review starts, the investor's new one is chosen.
  const valueOf = (key: string): string | null =>
    key in picks ? picks[key] : key in ignored ? null : (usable[key] ?? (key === investor ? (proposeNew ? proposedId(investor) : null) : ""));
  /** Where a folio, demat account or PRAN goes: an account, `LEFT_OUT`, or undefined until chosen. */
  const destination = (source: Source) => {
    const own = valueOf(sourceKey(source));
    if (own === null) return undefined;
    if (own) return own;
    return valueOf(investor) || undefined;
  };
  const accountOf = (source: Source) => {
    const to = destination(source);
    return to && to !== LEFT_OUT ? to : undefined;
  };
  const choiceOf = (key: string): FundChoice | undefined =>
    key in answers ? answers[key] : matched[key] ? { fund: matched[key] } : fundChoices[key];
  const fundOf = (key: string) => {
    const choice = choiceOf(key);
    return choice && "fund" in choice ? choice.fund : undefined;
  };
  const assetOf = (h: StatementHolding) => {
    const fund = fundOf(holdingKey(h));
    // A remembered statement-price choice can predate a corrected statement name.
    return fund?.statementPrices ? { ...fund, name: h.name } : fund;
  };
  const sourcesOf = (key: string) => holdings.sources.filter((s) => [...s.holdings, ...(s.misread ?? [])].some((h) => holdingKey(h) === key));
  const savedSource = (s: Source) => destination(s) !== LEFT_OUT;
  // Accounts whose holdings already saved for the statement's date the user chose to keep: nothing is
  // saved there, so what goes there needs no answers.
  const keptSaved = new Set((prepared?.plans ?? []).filter((plan) => replacesSnapshot(plan) && sameDate.get(plan.accountId) === true).map((p) => p.accountId));
  const savingSource = (s: Source) => savedSource(s) && !keptSaved.has(accountOf(s) ?? "");

  // Holdings that need an answer: on the statement with units or a misread line, in a folio, demat
  // account or PRAN that's saved, and with no asset confirmed.
  const questionKeys = items
    .filter((item) => snapshotKeys.has(item.key) && sourcesOf(item.key).some(savingSource) && !choiceOf(item.key))
    .map((item) => item.key);
  const changing = editor?.kind === "change" ? editor.itemKey : undefined;
  const searches = useHoldingSearches(ctx, items, {
    wanted: changing && !questionKeys.includes(changing) ? [...questionKeys, changing] : questionKeys,
    handled,
    amfiSearches: amfi.searches,
    // Only a holding with no choice is answered this way: Change on a remembered one searches too.
    onMatch: (key, fund) => {
      if (!choiceOf(key)) {
        clearAssetWrites(key, { fund });
        setMatched((all) => ({ ...all, [key]: fund }));
      }
    },
    // The focus goes to what the search found, without using or picking it; a failed one leaves it in the box.
    onTyped: (key, outcome) => {
      const picker = pickerIds(changingRef.current === key ? id(`picker-change-${key}`) : id(`picker-${key}`));
      if ("error" in outcome || !outcome.found) {
        focusSoon(picker.field, false, outcome.origin);
        return announce("error" in outcome ? `The search didn't work: ${outcome.error}` : `Nothing found for “${outcome.text}”. Check the code.`);
      }
      if (outcome.total === 1) {
        focusSoon(picker.single, false, outcome.origin);
        announce("1 result found. Use it to continue.");
      } else {
        focusSoon(picker.firstTyped, false, outcome.origin);
        announce(`${plural(outcome.found, "result")} found. Choose one to continue.`);
      }
    },
  });
  const changingRef = useRef(changing);
  changingRef.current = changing;
  // A question shows once its first search is done, so funds AMFI confirms don't flash up as questions.
  const searched = useRef(new Set<string>());
  for (const { key } of items) {
    const auto = searches.get(key).auto;
    if (auto && auto.status !== "searching") searched.current.add(key);
  }
  const lookingUp = questionKeys.filter((key) => !searched.current.has(key));
  const openKeys = questionKeys.filter((key) => searched.current.has(key));
  const undecidedSources = holdings.sources.filter((s) => destination(s) === undefined);
  const accountQuestion = undecidedSources.length > 0;

  // The automatic plan: worked out again whenever the accounts or confirmed assets change, from reads
  // of Wealthfolio cached until the page is opened again.
  const cache = useRef({ reads: new Map<string, Promise<unknown>>(), profileOf: profiles(api) });
  const firstVisit = useRef(true);
  useEffect(() => {
    if (firstVisit.current) {
      firstVisit.current = false;
      return;
    }
    cache.current = { reads: new Map(), profileOf: profiles(api) };
    setGeneration((n) => n + 1);
  }, [visit]);

  const destinations = holdings.sources.map((s) => accountOf(s) ?? "");
  const signature = JSON.stringify([generation, destinations, items.map((item) => fundOf(item.key) ?? null)]);
  // Try again stays, busy, while the plan is worked out again, so its focus does too; once it's worked
  // out, the focus goes to the bar's summary, unless the user moved it meanwhile.
  const [retrying, setRetrying] = useState(false);
  const retryFrom = useRef<Element | null>(null);
  const settleRetry = (ok: boolean) => {
    const from = retryFrom.current;
    retryFrom.current = null;
    setRetrying(false);
    if (ok && from) focusSoon(id("summary"), false, from);
  };
  const latestPrepare = useRef(0);
  useEffect(() => {
    if (result) return;
    const run = ++latestPrepare.current;
    setPrepareError("");
    prepare(signature).then(
      (next) => {
        if (run !== latestPrepare.current) return;
        setPrepared(next);
        settleRetry(true);
      },
      (e) => {
        if (run !== latestPrepare.current) return;
        setPrepareError(`Couldn't work out what will be saved: ${String(e)}`);
        settleRetry(false);
      },
    );
  }, [signature]);
  const current = prepared?.signature === signature ? prepared : null;

  async function prepare(signature: string): Promise<Prepared> {
    const bySource = holdings.sources.flatMap((source) => {
      const accountId = accountOf(source);
      return accountId ? [{ source, accountId }] : [];
    });
    const ids = [...new Set(bySource.map((s) => s.accountId))];
    const { reads, profileOf } = cache.current;
    const once = <T,>(key: string, read: () => Promise<T>): Promise<T> => {
      if (!reads.has(key)) {
        const promise = read();
        reads.set(key, promise);
        promise.catch(() => reads.delete(key));
      }
      return reads.get(key) as Promise<T>;
    };
    const [existingList, holdersRead] = await Promise.all([
      Promise.all(ids.map(async (accountId) => {
        // An account still to create has no snapshot, nor any import's record.
        const read = await once(`existing:${accountId}`, async () =>
          isProposed(accountId) ? { date: null, positions: [], cash: {}, later: [] } : readExisting(api, profileOf, accountId, holdings.date));
        // Each plan sets fields on these, so it gets its own copy.
        return [accountId, structuredClone(read)] as const;
      })),
      once("holders", () => holders(api, profileOf, allAccounts)),
    ]);
    const existing = new Map(existingList);
    const { held } = holdersRead;
    const modes = new Map(holdersRead.modes);
    const resolved = new Map<string, { assetId: string; symbol: string; exchangeMic?: string; manual: boolean }>();
    const assets = new Map(bySource.flatMap(({ source }) => [...source.holdings, ...(source.misread ?? [])].flatMap((h) => {
      const asset = assetOf(h);
      return asset ? [[fundRef(asset.symbol, asset.exchangeMic), asset] as const] : [];
    })));
    // Without a resolved asset, the choice's own fields create or find it on saving, as before.
    await Promise.all([...assets].map(async ([ref, asset]) => {
      try {
        const found = await once(`asset:${JSON.stringify([asset, holdersRead.modes.get(ref)])}`, async () => {
          let assetId = asset.assetId;
          if (!assetId && (asset.statementPrices || holdersRead.modes.get(ref) || asset.manual)) {
            const same = (await api.market.searchTicker(asset.symbol)).filter((r) =>
              r.existingAssetId && fundRef(r.canonicalSymbol || r.symbol, r.canonicalExchangeMic || r.exchangeMic) === ref);
            const type = instrumentType(asset.instrumentType);
            // Keep exact types first; snapshot saving defaults an unknown choice type to EQUITY.
            const exact = same.find((r) => instrumentType(r.quoteType) === type) ??
              (!/^(EQUITY|CRYPTO|FX|OPTION|METAL|BOND)$/.test(type) ? same.find((r) => instrumentType(r.quoteType) === "EQUITY") : undefined);
            assetId = exact?.existingAssetId;
          }
          if (!assetId && holdersRead.modes.get(ref)) throw new Error("Existing manual asset not found");
          if (!assetId) return undefined;
          // Throws for an asset deleted since it was chosen.
          const profile = await profileOf(assetId);
          return {
            assetId, symbol: profile.instrumentSymbol || asset.symbol, exchangeMic: profile.instrumentExchangeMic ?? undefined,
            manual: profile.quoteMode === "MANUAL",
          };
        });
        if (!found) return;
        resolved.set(ref, found);
        modes.set(ref, found.manual);
        modes.set(fundRef(found.symbol, found.exchangeMic), found.manual);
      } catch {
        // A manual asset's ID is needed to preserve its quote before saving.
        if (modes.get(ref) ?? asset.manual ?? asset.statementPrices) {
          throw new Error(`Couldn't verify pricing for ${asset.name}. Try again.`);
        }
        // Unresolved: left to the choice's fields.
      }
    }));
    const refs = new Map([...resolved.values()].map((asset) => [asset.assetId, fundRef(asset.symbol, asset.exchangeMic)]));
    const older = [...existing.values()].some((snapshot) => snapshot.date && snapshot.date < holdings.date && snapshot.positions.length > 0);
    const activities = older ? await once("activities", () => api.activities.getAll()) : [];
    const timeZone = older ? await once("timezone", () => engineTimeZone(api.settings)) : "UTC";
    for (const snapshot of existing.values()) {
      const split = splitSince(snapshot, holdings.date, activities, timeZone);
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
    const prices = new Map(await Promise.all([...manualIds].map(async (assetId) =>
      [assetId, await once(`price:${assetId}`, () => priceOn(api, assetId, holdings.date))] as const)));
    for (const snapshot of existing.values()) {
      for (const position of snapshot.positions) position.price = prices.get(position.assetId);
    }
    // Each folio, demat account and PRAN's earlier import into each account: a left-out one's units
    // stay, and those of one that now goes to another account may be counted there again.
    const records = await Promise.all(
      holdings.sources.flatMap((source) => ids.map((accountId) => ({ source, accountId }))).map(async ({ source, accountId }) => {
        const snapshot = existing.get(accountId)!;
        const record = await once(`record:${source.id}|${accountId}|${snapshot.date}`, () => readImported(api.storage, source, accountId, snapshot.date));
        return { key: `${source.id}|${accountId}`, snapshot, record };
      }),
    );
    // Earlier imports of the investor's folios, demat accounts and PRANs this statement doesn't list.
    const unlistedRecords = await Promise.all(ids.map(async (accountId) => {
      const snapshot = existing.get(accountId)!;
      const read = await once(`unlisted:${accountId}|${snapshot.date}`, () =>
        readUnlisted(api.storage, accountId, holdings.investor, holdings.sources, snapshot.date));
      return { accountId, snapshot, records: read };
    }));
    // The remembered choices of holdings recorded without an asset ID under a `fundRef` the account
    // doesn't hold, which may be their asset's earlier one; the statement's holdings' as they are now.
    const read = [...records, ...unlistedRecords.flatMap(({ snapshot, records }) => records.map((record) => ({ snapshot, record })))];
    const keys = new Set(read.flatMap(({ snapshot, record }) => {
      const heldHere = new Set(snapshot.positions.map((p) => p.ref));
      return [...record.remembered].flatMap(([ref, security]) => (heldHere.has(ref) || record.ids?.has(ref) ? [] : security.map(securityKey)));
    }));
    const now = new Map(items.map(({ key }) => [key, fundOf(key)] as const));
    const recordChoices = await readRecordChoices(api.storage, keys, now);
    const remembered = new Map(records.map(({ key, snapshot, record }) => [key, reconcileRecord(record, snapshot, recordChoices)]));
    const unlisted = new Map(unlistedRecords.map(({ accountId, snapshot, records }) =>
      [accountId, records.map(({ keys, ...record }) => ({ keys, ...reconcileRecord(record, snapshot, recordChoices) }))]));
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
      existing: (accountId) => existing.get(accountId)!,
      remembered: (source, accountId) => remembered.get(`${source.id}|${accountId}`)?.remembered ?? new Map(),
      recorded: (source, accountId) => remembered.get(`${source.id}|${accountId}`) ?? {},
      heldElsewhere: (ref, accountId) => (held.get(ref) ?? []).filter((o) => o.id !== accountId),
      accountName,
      unlisted: (accountId) => unlisted.get(accountId) ?? [],
    });
    // The funds an account that tracks transactions already holds are compared with it, as Check units did.
    let checks: UnitCheck[] | undefined;
    const overlapping = items.some((item) => {
      const fund = fundOf(item.key);
      return fund && sourcesOf(item.key).some((s) => s.kind === "folio") &&
        (held.get(fundRef(fund.symbol, fund.exchangeMic)) ?? []).some((o) => o.tracksTransactions);
    }) || plans.some((plan) => plan.positions.some((p) => p.heldBy));
    if (overlapping && compared.length) {
      const timeZone = await once("timezone", () => engineTimeZone(api.settings));
      let activities: ActivityDetails[] | { error: string };
      try {
        activities = await once("activities", () => api.activities.getAll());
      } catch (e) {
        activities = { error: String(e) };
      }
      // A choice without an asset ID is matched by the symbol and exchange on each asset's profile.
      const identities = new Map<string, string | { error: string }>();
      if (Array.isArray(activities) && items.some((item) => fundOf(item.key) && !fundOf(item.key)!.assetId)) {
        const assetIds = new Set(activities.filter((a) => a.assetId && compared.some((account) => account.id === a.accountId)).map((a) => a.assetId));
        await Promise.all([...assetIds].map(async (assetId) => {
          try {
            const profile = await once(`profile:${assetId}`, () => api.assets.getProfile(assetId));
            identities.set(assetId, fundRef(profile.instrumentSymbol ?? "", profile.instrumentExchangeMic));
          } catch (e) {
            identities.set(assetId, { error: String(e) });
          }
        }));
      }
      checks = checkUnits(holdings, { asset: assetOf, accounts: compared, activities, identities, timeZone });
    }
    return { signature, plans, quotes: new Map([...prices].flatMap(([assetId, p]) => p?.onDate ? [[assetId, p.onDate] as const] : [])), held, checks };
  }

  const choicesFor = (accountId: string, plan?: AccountPlan): Choices => {
    const overlap = plan
      ? plan.positions.filter((p) => p.heldBy && p.lines.some((l) => alsoSave.has(holdingKey(l.holding)))).map((p) => p.key)
      : [];
    return {
      flipped: new Set(overlap),
      costs: costs.get(accountId) ?? new Map(),
      keep: keeps.get(accountId) ?? new Map(),
      replace: replaced.get(accountId) ?? new Map(),
    };
  };
  // The plans of the accounts this import saves: not those whose saved holdings the user keeps.
  const allPlans = current?.plans ?? [];
  const plans = allPlans.filter((plan) => !keptSaved.has(plan.accountId));
  const clearPositionWrites = (affected: (plan: AccountPlan, position: PlannedPosition) => boolean) => {
    const removed = new Set((current?.plans ?? prepared?.plans ?? []).flatMap((plan) => plan.positions.filter((p) => affected(plan, p)).map((p) => `${plan.accountId}|${p.key}`)));
    const clean = <T,>(all: ReadonlyMap<string, ReadonlyMap<string, T>>) => new Map([...all].map(([account, values]) =>
      [account, new Map([...values].filter(([key]) => !removed.has(`${account}|${key}`)))]));
    setCosts(clean);
    setKeeps(clean);
    setReplaced(clean);
    setEditor((e) => e && removed.has(e.rowId) ? null : e);
  };
  const clearAssetWrites = (key: string, choice?: FundChoice) => {
    const next = choice && "fund" in choice ? choice.fund : undefined;
    const before = fundOf(key);
    const ref = next && fundRef(next.symbol, next.exchangeMic);
    if (before && ref === fundRef(before.symbol, before.exchangeMic) && next?.assetId === before.assetId) return;
    const accounts = new Set(sourcesOf(key).map(accountOf));
    clearPositionWrites((plan, p) => p.lines.some((l) => holdingKey(l.holding) === key) ||
      (accounts.has(plan.accountId) && !!ref && (p.ref === ref || p.lines.some((l) => {
        const asset = assetOf(l.holding);
        return asset && fundRef(asset.symbol, asset.exchangeMic) === ref;
      }))));
  };
  function accountName(accountId: string) {
    const account = created.current.get(accountId);
    if (account) return account.name;
    if (isProposed(accountId)) return proposalNames.get(proposalKey(accountId)) ?? "";
    return allAccounts.find((a) => a.id === accountId)?.name ?? [...created.current.values()].find((a) => a.id === accountId)?.name ?? accountId;
  }
  /** The account's name in accessible names, numbered when another account has the same one. */
  const accountLabel = (accountId: string) => {
    const i = accounts.findIndex((a) => a.id === accountId);
    return i < 0 ? accountName(accountId) : `${accounts[i].name.trim()}${nameNumber(accounts, i, "account")}`;
  };

  // The holdings that will be saved, a row each per account.
  const itemsIn = (position: PlannedPosition) =>
    [...new Set(position.lines.map((l) => holdingKey(l.holding)))].map((key) => itemOf.get(key)!);
  /** A statement row of an account's snapshot, as a ready row shows it. */
  const toRow = (plan: AccountPlan, position: PlannedPosition, chosen: Choices): ReadyRow => {
    const item = itemOf.get(holdingKey(position.lines[0].holding))!;
    const choice = fundOf(item.key) ?? position.asset!;
    const fund = {
      ...choice,
      assetId: position.existing?.assetId ?? position.asset?.assetId ?? choice.assetId,
      manual: position.existing?.manual ?? position.asset?.manual ?? choice.manual,
    };
    const typed = chosen.costs.get(position.key);
    const rowId = `${plan.accountId}|${position.key}`;
    const name = shownName(item, fund);
    const listed = plan.positions.filter((p) => p.lines.length);
    const names = listed.map((p) => {
      const key = holdingKey(p.lines[0].holding);
      return { name: shownName(itemOf.get(key)!, fundOf(key)) };
    });
    return {
      id: rowId,
      accountId: plan.accountId,
      accountName: accountName(plan.accountId),
      position,
      item,
      items: itemsIn(position),
      fund,
      by: item.key in answers ? "you" : matched[item.key] ? "auto" : "before",
      name,
      label: `${name.trim()}${nameNumber(names, listed.indexOf(position), "holding")}`,
      units: unitWords(item, position.units!),
      cost: typed !== undefined
        ? { total: typed, from: "typed" }
        : position.cost ? { total: position.cost.total, from: position.cost.from } : undefined,
      notes: position.notes.filter((note) => !note.endsWith(OVERLAP_NOTE)),
      touched: touched.has(rowId) || position.lines.some((l) => touched.has(holdingKey(l.holding))),
    };
  };
  const rows: ReadyRow[] = plans.flatMap((plan) => {
    const chosen = choicesFor(plan.accountId, plan);
    return plan.positions.filter((p) => p.lines.length && !p.misread && included(p, chosen)).map((position) => toRow(plan, position, chosen));
  });
  // Holdings of folios, demat accounts and PRANs whose account isn't chosen yet, or of every saved
  // one while no snapshot could be worked out: shown as they'll be saved, without what the account's
  // snapshot would add, such as a cost from earlier holdings, and with Change to fix what's wrong.
  const unplanned = !prepared && prepareError ? holdings.sources.filter((s) => destination(s) !== LEFT_OUT) : undecidedSources;
  const waiting = new Map<string, PlannedPosition>();
  for (const source of unplanned) {
    for (const holding of source.holdings) {
      const asset = assetOf(holding);
      if (!asset) continue;
      const ref = fundRef(asset.symbol, asset.exchangeMic);
      const position = waiting.get(ref) ?? { key: ref, ref, name: asset.name || holding.name, asset, lines: [], include: true, notes: [], order: waiting.size };
      position.lines.push({ source, holding });
      waiting.set(ref, position);
    }
  }
  const source0 = (position: PlannedPosition) => position.lines[0].source;
  for (const position of waiting.values()) {
    const held = position.lines.map((l) => l.holding);
    const total = (values: string[]) => format(values.reduce((sum, v) => add(sum, dec(v)), dec("0")));
    position.units = total(held.map((h) => h.units));
    position.value = total(held.map((h) => h.value));
    if (held.every((h) => h.cost !== null)) position.cost = { total: total(held.map((h) => h.cost!)), from: "statement" };
    const item = itemOf.get(holdingKey(held[0]))!;
    rows.push({
      id: `|${position.key}`,
      accountId: "",
      accountName: accountOf(source0(position)) ? accountName(accountOf(source0(position))!) : "an account still to choose",
      position,
      item,
      items: itemsIn(position),
      fund: fundOf(item.key)!,
      by: item.key in answers ? "you" : matched[item.key] ? "auto" : "before",
      name: shownName(item, fundOf(item.key)),
      label: "",
      units: unitWords(item, position.units),
      cost: position.cost,
      notes: [],
      touched: touched.has(`|${position.key}`) || position.lines.some((l) => touched.has(holdingKey(l.holding))),
    });
  }
  rows.forEach((row, i) => {
    row.label = `${row.name.trim()}${nameNumber(rows, i, "holding")}`;
  });
  const readyKeys = new Set(rows.flatMap((r) => r.position.lines.map((l) => holdingKey(l.holding))));
  const autoCount = new Set(rows.filter((r) => r.by === "auto").map((r) => r.item.key)).size;

  // Funds that an account tracking transactions already holds.
  const comparison = (key: string): Comparison => {
    if (!current) return { kind: "checking" };
    const check = current.checks?.find((c) => c.lines.some((l) => holdingKey(l.holding) === key));
    if (!check) return { kind: "unknown", why: "No account that tracks transactions could be compared." };
    const status = unitStatus(check);
    if (status === "review" || check.held === undefined) return { kind: "unknown", why: check.problem ?? "" };
    if (status === "match") return { kind: "match" };
    const accounts = check.accounts.map((a) => ({ ...a, name: comparedLabels.get(a.id) ?? a.name }));
    return { kind: "differ", theirs: `${units(format(check.held))} units`, ours: units(format(check.statement)), accounts, accountName: accounts.map((a) => a.name).join(", ") };
  };
  const trackedFunds = (prepared ? items : []).flatMap((item) => {
    const fund = fundOf(item.key);
    const folios = sourcesOf(item.key).filter((s) => s.kind === "folio" && !keptSaved.has(accountOf(s) ?? ""));
    if (!fund || !folios.length) return [];
    const inPlans = plans.flatMap((plan) => plan.positions.filter((p) => p.heldBy && p.lines.some((l) => holdingKey(l.holding) === item.key)));
    const by = (prepared!.held.get(inPlans[0]?.ref ?? fundRef(fund.symbol, fund.exchangeMic)) ?? []).filter((o) => o.tracksTransactions);
    if (!by.length) return [];
    const folioUnits = folios.flatMap((s) => s.holdings.filter((h) => holdingKey(h) === item.key)).map((h) => h.units);
    const canSave = folios.some((s) => accountOf(s));
    const savedHere = plans.some((plan) => plan.positions.some((p) => p.heldBy &&
      p.lines.some((l) => holdingKey(l.holding) === item.key) && included(p, choicesFor(plan.accountId, plan))));
    const plan = statementPlan(item);
    return [{
      accounts: by.map((o) => comparedLabels.get(o.id) ?? o.name).join(", "),
      fund: {
        key: item.key,
        name: shownName(item, fund),
        label: "",
        badges: plan && <PlanBadges own={plan} />,
        units: unitsText(folioUnits.reduce((total, u) => format(add(dec(total), dec(u))), "0")),
        comparison: comparison(item.key),
        canSave,
        included: savedHere,
        notes: inPlans.flatMap((p) => p.notes.filter((note) => !note.endsWith(OVERLAP_NOTE))),
      } satisfies TrackedFund,
    }];
  });
  const allTracked = trackedFunds.map((t) => t.fund);
  allTracked.forEach((fund, i) => {
    fund.label = `${fund.name.trim()}${nameNumber(allTracked, i, "fund")}`;
  });
  const tracked: TrackedGroup[] = [...new Set(trackedFunds.map((t) => t.accounts))].map((accounts) => ({
    accounts,
    funds: trackedFunds.filter((t) => t.accounts === accounts).map((t) => t.fund),
  }));
  const trackedKeys = new Set(trackedFunds.filter((t) => !t.fund.included).map((t) => t.fund.key));
  const counted = trackedFunds.filter((t) => t.fund.included).map((t) => ({ key: t.fund.key, name: t.fund.name, label: t.fund.label }));
  const skipped = items.filter((item) => {
    const choice = choiceOf(item.key);
    return snapshotKeys.has(item.key) && choice && !("fund" in choice) && sourcesOf(item.key).some(savingSource);
  });
  // Funds already tracked elsewhere stay listed unless their account's saved snapshot is kept.
  const unsaved = items.filter((item) => {
    const lines = holdings.sources.filter((s) => s.holdings.some((h) => holdingKey(h) === item.key));
    return lines.length > 0 && lines.every((s) => !savedSource(s)) && !trackedKeys.has(item.key);
  });
  // Statement rows left out so that units aren't counted twice, or by an answer; not one still asked about.
  const defaulted = plans.flatMap((plan) => {
    const chosen = choicesFor(plan.accountId, plan);
    return plan.positions.filter((p) => p.lines.length && !p.misread && !p.heldBy && !included(p, chosen) && !undecided(p, chosen))
      .map((position) => ({ plan, position }));
  });
  // The account's own holdings that it keeps as they are, each with a note to check.
  const keptAsIs = plans.flatMap((plan) => {
    const chosen = choicesFor(plan.accountId, plan);
    return plan.positions.filter((p) => !p.lines.length && !p.misread && p.existing && !p.ask && p.notes.length && included(p, chosen))
      .map((position) => ({ plan, position }));
  });
  const sourceTitle = new Map(holdings.sources.map((s) => [s.label, s.title ?? s.label]));
  const leftOutLines = holdings.leftOut.map((line) => ({ name: line.name, where: sourceTitle.get(line.source) ?? line.source, reason: line.reason }));
  const notIncludedKeys = new Set([
    ...[...trackedKeys].filter((k) => !readyKeys.has(k)),
    ...skipped.map((i) => i.key),
    ...unsaved.map((i) => i.key),
    ...defaulted.flatMap(({ position }) => position.lines.map((l) => holdingKey(l.holding))).filter((k) => !readyKeys.has(k)),
    ...holdings.sources.flatMap((s) => [...(s.zero ?? []), ...(s.misread ?? [])].map(holdingKey)).filter((k) => !readyKeys.has(k)),
  ].filter((k) => !questionKeys.includes(k)));

  // The questions only some imports ask, from the plan as last worked out: an account's holdings
  // already saved for the statement's date first, then each holding the user must decide on.
  const askPlans = ((current ?? prepared)?.plans ?? []).filter((plan) => destinations.includes(plan.accountId));
  /** A position's name, as the Review screen shows it: a fund's without its plan and option. */
  const nameOf = (p: PlannedPosition) => {
    if (!p.lines.length) return FUND_SYMBOL.test(p.existing?.symbol ?? p.asset?.symbol ?? "") ? fundName(p.name) || p.name : p.name;
    const key = holdingKey(p.lines[0].holding);
    return shownName(itemOf.get(key)!, fundOf(key) ?? p.asset);
  };
  const setIn = <T,>(all: ReadonlyMap<string, ReadonlyMap<string, T>>, accountId: string, key: string, value: T | undefined) => {
    const next = new Map(all.get(accountId) ?? []);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    return new Map(all).set(accountId, next);
  };
  const sameAsks: Ask[] = askPlans.filter(replacesSnapshot).map((plan) => {
    const account = accountName(plan.accountId);
    const words = sameDateWords(account, holdings.date);
    // Holdings still waiting for an answer to which fund they are.
    const waitingHere = holdings.sources.filter((s) => accountOf(s) === plan.accountId)
      .flatMap((s) => s.holdings.filter((h) => !choiceOf(holdingKey(h))).map((h) => ({ name: h.name, units: h.units })));
    return {
      id: `same|${plan.accountId}`,
      accountId: plan.accountId,
      words: { ...words, line: "Replacing them with this statement changes:" },
      changes: sameDateChanges(plan, choicesFor(plan.accountId, plan), nameOf, waitingHere),
      target: `${accountLabel(plan.accountId)}'s holdings for ${date}`,
      answer: sameDate.get(plan.accountId),
      set: (answer) => setSameDate((all) => {
        const next = new Map(all);
        if (answer === undefined) next.delete(plan.accountId);
        else next.set(plan.accountId, answer);
        return next;
      }),
    };
  });
  const holdingAsks: Ask[] = askPlans.filter((plan) => !keptSaved.has(plan.accountId)).flatMap((plan) => {
    const chosen = choicesFor(plan.accountId, plan);
    const account = accountName(plan.accountId);
    // A kind of question at a time, in the statement's order, so a source's questions stay together.
    const asks = asked(plan, chosen).sort((a, b) => ASK_ORDER.indexOf(a.ask!.kind) - ASK_ORDER.indexOf(b.ask!.kind));
    return asks.map((position): Ask => {
      const replace = position.ask!.kind === "replace";
      const answer = replace
        ? (chosen.replace?.has(position.key) ? !chosen.replace.get(position.key) : undefined)
        : chosen.keep?.get(position.key);
      const row = position.ask!.kind === "overlap" ? plan.positions.find((p) => p.key === (position.ask as { row: string }).row) ?? position : position;
      return {
        id: `${plan.accountId}|${position.key}`,
        accountId: plan.accountId,
        words: holdingAskWords(plan, position, {
          account, name: nameOf, provider: (p) => (p.asset ? providerName(p.asset as ChosenFund) : undefined),
          // A statement row's name as printed, not its chosen asset's.
          statement: (p) => {
            const item = itemOf.get(holdingKey(p.lines[0].holding))!;
            return shownName(item);
          },
        }),
        target: `${nameOf(row)} in ${accountLabel(plan.accountId)}`,
        answer,
        set: replace
          ? (main) => {
              // Its row's cost and open edit go with it whenever it stops being saved.
              if (main !== false) clearPositionWrites((p, q) => p.accountId === plan.accountId && q.key === position.key);
              setReplaced((all) => setIn(all, plan.accountId, position.key, main === undefined ? undefined : !main));
            }
          : (main) => setKeeps((all) => setIn(all, plan.accountId, position.key, main)),
      };
    });
  });
  // Equal names in one account are told apart by number, as elsewhere.
  const targets0 = holdingAsks.map((a) => ({ name: a.target }));
  holdingAsks.forEach((a, i) => {
    const n = nameNumber(targets0, i, "holding");
    a.target += n;
  });
  const asks = [...sameAsks, ...holdingAsks];
  const openAsks = asks.filter((a) => a.answer === undefined);
  // Only the rare questions are left: the snapshots they decide can be seen already.
  const answeredAll = openKeys.length === 0 && lookingUp.length === 0 && !accountQuestion;
  const questionCount = openKeys.length + (accountQuestion ? 1 : 0) + openAsks.length;
  // Nothing to save: every folio, demat account and PRAN is set to Don't save or goes to an account
  // whose saved holdings are kept.
  const nothing = !accountQuestion &&
    holdings.sources.every((s) => destination(s) === LEFT_OUT || keptSaved.has(accountOf(s) ?? ""));
  const keptPlans = askPlans.filter((plan) => keptSaved.has(plan.accountId));
  const keptWords = (plan: AccountPlan) => `${accountName(plan.accountId)}'s holdings for ${date} are kept`;

  // A kept account that still holds funds this statement saves in another account would count them twice.
  const doubles = keptPlans.flatMap((kept) => {
    const held = new Map(kept.existing.positions.flatMap((p) => [[p.ref, p.assetId], [p.assetId, p.assetId]]));
    const found = plans.flatMap((plan) => {
      const chosen = choicesFor(plan.accountId, plan);
      return plan.positions.filter((p) => p.lines.length && !p.misread && included(p, chosen) &&
        (held.has(p.ref) || (!!p.asset?.assetId && held.has(p.asset.assetId)) || (!!p.existing && held.has(p.existing.assetId))))
        .map((position) => ({ plan, position }));
    });
    if (!found.length) return [];
    const account = accountName(kept.accountId);
    const sources = [...new Set(found.flatMap(({ position }) => position.lines.map((l) => l.source)))];
    const names = [...new Map(found.map(({ position }) => [
      held.get(position.ref) ?? held.get(position.asset?.assetId ?? "") ?? held.get(position.existing?.assetId ?? ""), nameOf(position),
    ])).values()];
    const funds = found.every(({ position }) => position.lines.every((l) => l.holding.kind === "fund"));
    const to = list([...new Set(found.map(({ plan }) => accountName(plan.accountId)))]);
    const text = names.length === 1
      ? `${account} will still hold ${names[0]}. Saving it in ${to} too would count its units twice.`
      : `${account} will still hold ${names.length} of these ${funds ? "funds" : "holdings"} (${list(names)}). Saving them in ${to} too would count their units twice.`;
    const button = sources.length === 1
      ? `Keep the ${(sources[0].title ?? sources[0].label).replace(/\s*\([^)]*\)$/, "")} in ${account}`
      : `Keep these ${sources.length} statement sections in ${account}`;
    return [{ accountId: kept.accountId, account, sources, text, button }];
  });

  // Ids the focus moves to.
  const ids = {
    heading: id("heading"),
    another: id("another"),
    keep: id("keep-reviewing"),
    summary: id("summary"),
    ready: id("ready"),
    questions: id("questions"),
    question: (key: string) => id(`q-${key}`),
    ask: (askId: string) => id(`ask-${sha256(askId)}`),
    askAnswer: (askId: string) => id(`ask-answer-${sha256(askId)}`),
    answerButton: (key: string) => id(`answer-${key}`),
    picker: (key: string) => id(`picker-${key}`),
    changePanel: (rowId: string) => id(`change-panel-${rowId}`),
    row: (row: ReadyRow, item = row.item) => ({ change: id(`change-${row.id}${item.key === row.item.key ? "" : `-${item.key}`}`), cost: id(`cost-${row.id}`), field: id(`cost-field-${row.id}`) }),
    showAll: id("show-all"),
    notCreated: id("not-created"),
  };
  /** The open questions' headings, in the order they're shown: saved holdings for the date, holdings to match, then the others. */
  const openHeadings = () => [
    ...openAsks.filter((a) => sameAsks.includes(a)).map((a) => ids.ask(a.id)),
    ...openKeys.map(ids.question),
    ...openAsks.filter((a) => !sameAsks.includes(a)).map((a) => ids.ask(a.id)),
  ];
  /** Focuses the first account question, opening Save part of it to another account when it's there. */
  const focusAccountQuestion = (force = false, origin?: Element | null) => {
    const source = undecidedSources.find((s) => valueOf(sourceKey(s)) === null);
    if (source) setOpen("part", true);
    focusSoon(source ? sourceKey(source) : investor, force, origin);
  };
  const nothingWords = () =>
    keptPlans.length ? `Nothing will be saved. ${keptPlans.map(keptWords).join(". ")}.` : "Nothing from this statement will be saved.";
  // The accounts the last save couldn't create, while something still goes to them.
  const missingNow = notCreated.filter((n) => holdings.sources.some((s) => accountOf(s) === n.accountId));
  // Whether the review can be saved as it stands: the save button's checks, which Try again shares.
  const canSave = !questionCount && !lookingUp.length && !nothing && !!current && !editor && !renaming && busy === "" &&
    !prepareError && plans.length > 0;

  // Says what the first searches found, once they're all done and the plan is worked out, so the count
  // includes the questions about saved holdings.
  const initial = useRef<readonly string[] | null>(questionKeys);
  useEffect(() => {
    const keys = initial.current;
    if (!keys || !current || keys.some((key) => !searched.current.has(key))) return;
    initial.current = null;
    const found = keys.filter((key) => matched[key]).length;
    const left = questionCount;
    announce(`${found ? `${plural(found, "fund")} found automatically on AMFI. ` : ""}${left ? `${plural(left, "question")} for you.` : "No questions for you."}`);
  });
  // Once AMFI is turned on, the open questions are searched again: says how many it matched.
  const amfiFocus = useRef<Element | null>(null);
  const amfiBatch = useRef<{ keys: string[]; started: boolean; seen: number; origin: Element | null } | null>(null);
  const amfiSeen = useRef(amfi.searches);
  useEffect(() => {
    if (amfiSeen.current !== amfi.searches) {
      amfiSeen.current = amfi.searches;
      const keys = openKeys.filter((key) => itemOf.get(key)?.noun === "fund");
      amfiBatch.current = keys.length ? { keys, started: false, seen: 0, origin: amfiFocus.current } : null;
      amfiFocus.current = null;
      return;
    }
    const batch = amfiBatch.current;
    if (!batch) return;
    const running = batch.keys.some((key) => searches.get(key).auto?.status === "searching");
    if (running) {
      batch.started = true;
      return;
    }
    if (!batch.started && ++batch.seen < 3) return;
    if (!current) return;
    amfiBatch.current = null;
    const found = batch.keys.filter((key) => matched[key]).length;
    const left = questionCount;
    announce(`AMFI added: ${plural(found, "fund")} matched. ${left ? `${plural(left, "question")} ${left === 1 ? "remains" : "remain"}.` : "No questions remain."}`);
    if (accountQuestion) focusAccountQuestion(false, batch.origin);
    else focusSoon(openHeadings()[0] ?? ids.summary, false, batch.origin);
  });

  const afterAnswer = useRef(false);
  const afterAsk = useRef(false);
  const afterChange = useRef<{ key: string; accountId: string } | null>(null);
  useEffect(() => {
    if (!current) return;
    const changed = afterChange.current;
    if (changed) {
      afterChange.current = null;
      const row = rows.find((r) => r.accountId === changed.accountId && r.position.lines.some((l) => holdingKey(l.holding) === changed.key));
      const plan = current.plans.find((p) => p.accountId === changed.accountId);
      const position = plan?.positions.find((p) => p.lines.some((l) => holdingKey(l.holding) === changed.key));
      if (plan && position?.ask && undecided(position, choicesFor(plan.accountId, plan))) {
        // Its Change button doesn't exist until the new question is answered.
        focusSoon(ids.ask(`${plan.accountId}|${position.key}`));
      } else {
        const target = row ?? (plan && position ? toRow(plan, position, choicesFor(plan.accountId, plan)) : undefined);
        focusSoon(target ? ids.row(target, itemOf.get(changed.key)!).change : rows.length ? ids.ready : ids.summary);
      }
    }
    if ((!afterAnswer.current || questionKeys.length) && !afterAsk.current) return;
    if (afterAsk.current && lookingUp.length) {
      afterAsk.current = false;
      return focusSoon(ids.questions);
    }
    if (afterAsk.current && questionKeys.length) {
      // A rare question answered while fund questions are open: on to the next open one.
      afterAsk.current = false;
      return focusSoon(openHeadings()[0] ?? ids.questions);
    }
    afterAnswer.current = false;
    afterAsk.current = false;
    if (questionCount) {
      if (accountQuestion) focusAccountQuestion();
      else focusSoon(openHeadings()[0] ?? ids.summary);
    } else {
      focusSoon(ids.summary);
      announce(nothing ? nothingWords() : "All questions answered. Ready to save.");
    }
  });
  /** A rare question's answer: the focus goes on to the next open question, or to the bar's summary. */
  const answerAsk = (ask: Ask, main: boolean) => {
    if (!current) return;
    ask.set(main);
    afterAsk.current = true;
    // Keeping an account's saved holdings closes the edits of what it would have saved.
    if (ask.id.startsWith("same|") && main && editor) {
      const inAccount = editor.kind === "cost" ? editor.accountId === ask.accountId : editor.rowId.startsWith(`${ask.accountId}|`);
      if (inAccount) closeEditor();
    }
  };
  const reopenAsk = (ask: Ask) => {
    ask.set(undefined);
    focusSoon(ids.ask(ask.id));
  };

  const answer = (key: string, choice: FundChoice) => {
    clearAssetWrites(key, choice);
    setAnswers((all) => ({ ...all, [key]: choice }));
    setHandled((all) => new Set(all).add(key));
    setTouched((all) => new Set(all).add(key));
    searches.settle(key);
    const rest = openKeys.filter((k) => k !== key);
    if (rest.length) {
      focusSoon(ids.question(rest[0]));
    } else {
      afterAnswer.current = true;
    }
  };
  const reopen = (key: string) => {
    if (busyEditor(`answer-${key}`)) return;
    clearAssetWrites(key);
    setAnswers((all) => ({ ...all, [key]: undefined }));
    focusSoon(ids.question(key));
  };

  // One edit at a time: asking for another keeps the open one's draft and goes back to it.
  const editorTarget = (e: Editor) => (e.kind === "cost" ? id(`cost-field-${e.rowId}`) : ids.changePanel(e.rowId));
  const busyEditor = (wanted: string) => {
    if (!editor || editor.rowId + editor.kind + (editor.kind === "change" ? editor.itemKey : "") === wanted) return false;
    setNag(true);
    focusSoon(editorTarget(editor), false, document.activeElement);
    announce("Save or cancel this edit first.");
    return true;
  };
  const closeEditor = (focusId?: string) => {
    if (focusId && editor) setTouched((all) => new Set(all).add(editor.rowId));
    setEditor(null);
    setNag(false);
    if (focusId) focusSoon(focusId, false, document.activeElement);
  };
  const handlers: ReadyHandlers = {
    ids: ids.row,
    label: (row, item) => `${labelOf.get(item.key)!}${row.accountId ? ` in ${accountLabel(row.accountId)}` : ""}`,
    editing: editor?.kind === "cost" ? { rowId: editor.rowId, draft: editor.draft, error: editor.error } : undefined,
    changing: editor?.kind === "change" ? editor.rowId : undefined,
    changingItem: editor?.kind === "change" ? editor.itemKey : undefined,
    nag,
    onChange: (row, item = row.item) => {
      if (busyEditor(row.id + "change" + item.key)) return;
      if (editor) return closeEditor(ids.row(row, item).change);
      setNag(false);
      setEditor({ kind: "change", rowId: row.id, itemKey: item.key, name: item.key === row.item.key ? row.name : item.name });
      focusSoon(ids.changePanel(row.id), false, document.activeElement);
    },
    onCost: (row) => {
      if (busyEditor(row.id + "cost")) return;
      setNag(false);
      setEditor({ kind: "cost", rowId: row.id, accountId: row.accountId, key: row.position.key, name: row.name, draft: row.cost?.from === "typed" ? row.cost.total : "", error: false });
      focusSoon(ids.row(row).field, false, document.activeElement);
    },
    onDraft: (draft) => setEditor((e) => (e?.kind === "cost" ? { ...e, draft, error: false } : e)),
    onSaveCost: () => {
      if (editor?.kind !== "cost") return;
      const amount = parseCost(editor.draft);
      if (!amount) {
        setEditor({ ...editor, error: true });
        return;
      }
      setCosts((all) => new Map(all).set(editor.accountId, new Map(all.get(editor.accountId) ?? []).set(editor.key, amount)));
      announce(`Purchase cost saved for ${editor.name}: ${rupees(amount)}.`);
      closeEditor(id(`cost-${editor.rowId}`));
    },
    onCancelCost: () => editor && closeEditor(id(`cost-${editor.rowId}`)),
    changePanel: (row) => {
      const item = itemOf.get(editor?.kind === "change" ? editor.itemKey : row.item.key)!;
      const holding = row.position.lines.find((l) => holdingKey(l.holding) === item.key)?.holding;
      if (!holding) return null; // A merged row can split before the effect moves this Change.
      const label = item.key === row.item.key ? row.label : handlers.label(row, item);
      return (
        <div id={ids.changePanel(row.id)} data-focus-first="true" tabIndex={-1} className="grid gap-3 rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">On your statement: {item.statementAsset?.name && holding.details?.name
            ? readableName(holding.details.name) : item.name}</p>
          {nag && <p className="text-warning text-sm">Save or cancel this edit first.</p>}
          <Picker
            item={item}
            label={labelOf.get(item.key)!}
            search={searches.get(item.key)}
            searches={searches}
            base={ids.picker(`change-${item.key}`)}
            onUse={(fund) => change(row, item, { fund })}
            onStatementPrice={() => item.statementAsset && change(row, item, { fund: item.statementAsset })}
          >
            <Button type="button" variant="outline" aria-label={`Skip this holding: ${label}`} onClick={() => change(row, item, { leftOut: true })}>
              Skip this holding
            </Button>
            <Button type="button" variant="ghost" aria-label={`Cancel the change to ${label}`} onClick={() => closeEditor(ids.row(row, item).change)}>
              Cancel
            </Button>
          </Picker>
        </div>
      );
    },
  };
  // Keep Change on its holding's shown row after planning settles, or close it if none remains.
  // Only a failed first plan shows every active holding as unplanned; later failures wait for retry.
  useEffect(() => {
    if (editor?.kind !== "change" || (!current && (!prepareError || prepared))) return;
    const shown = [
      ...rows,
      ...defaulted.map(({ plan, position }) => toRow(plan, position, choicesFor(plan.accountId, plan))),
    ].filter((row) => row.position.lines.some((l) => holdingKey(l.holding) === editor.itemKey));
    if (shown.some((row) => row.id === editor.rowId)) return;
    const moved = shown[0];
    if (moved) setEditor({ ...editor, rowId: moved.id });
    else closeEditor();
  });
  const change = (row: ReadyRow, item: FundItem, choice: FundChoice) => {
    clearAssetWrites(item.key, choice);
    setAnswers((all) => ({ ...all, [item.key]: choice }));
    setHandled((all) => new Set(all).add(item.key));
    // The holding's row stays shown, whichever asset it now goes under.
    setTouched((all) => new Set(all).add(item.key));
    searches.settle(item.key);
    afterChange.current = { key: item.key, accountId: row.accountId };
    closeEditor();
    announce(`${item.key === row.item.key ? row.name : item.name}: ${answerWords(item, choice)}.`);
  };

  // Account choices: a change of where something goes clears what only it needed.
  const chooseAccounts = (chosen: Record<string, string>) => {
    const value = (key: string) => (key in chosen ? chosen[key] : valueOf(key));
    // Where each folio, demat account or PRAN goes after these choices: an account, `LEFT_OUT`, or undecided.
    const after = (source: Source) => {
      const own = value(sourceKey(source));
      if (own === null) return undefined;
      return own || value(investor) || undefined;
    };
    setPicks((all) => ({ ...all, ...chosen }));
    // A rename goes with its new account.
    if (renaming && renaming.key in chosen && chosen[renaming.key] !== proposedId(renaming.key)) setRenaming(null);
    const used = new Set(holdings.sources.map(after).filter((to) => to && to !== LEFT_OUT));
    // Answers and typed searches of holdings no longer saved go, and so do the costs and choices of
    // accounts nothing goes to any more. Saving a fund in both accounts stays for when it's saved again.
    const dropped = items.filter((item) => sourcesOf(item.key).every((s) => after(s) === LEFT_OUT)).map((i) => i.key);
    if (dropped.length) {
      setAnswers((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !dropped.includes(k))));
      for (const k of dropped) searches.settle(k);
    }
    const moved = holdings.sources.filter((s) => destination(s) !== after(s));
    const movedRefs = new Set(moved.flatMap((s) => s.holdings.flatMap((h) => {
      const asset = assetOf(h);
      return asset ? [fundRef(asset.symbol, asset.exchangeMic)] : [];
    })));
    clearPositionWrites((plan, p) => moved.some((s) => accountOf(s) === plan.accountId || after(s) === plan.accountId) &&
      (p.removable?.some((s) => moved.includes(s)) || movedRefs.has(p.ref) || p.lines.some((l) => {
        const asset = assetOf(l.holding);
        return moved.includes(l.source) || (asset && movedRefs.has(fundRef(asset.symbol, asset.exchangeMic)));
      })));
    const keepUsed = <T,>(map: ReadonlyMap<string, T>) => new Map([...map].filter(([accountId]) => used.has(accountId)));
    setCosts(keepUsed);
    setKeeps(keepUsed);
    setReplaced(keepUsed);
    setSameDate(keepUsed);
    if (editor) {
      const stillSaved = editor.kind === "cost"
        ? used.has(editor.accountId) && !keptSaved.has(editor.accountId)
        : sourcesOf(editor.itemKey).some((s) => after(s) && after(s) !== LEFT_OUT && !keptSaved.has(after(s)!));
      if (!stillSaved) closeEditor();
    }
  };
  const chooseAccount = (key: string, value: string) => void chooseAccounts({ [key]: value });

  // Rename edits a new account's name in place; its field and Rename button take the focus in turn.
  const renameIds = (key: string) => ({ rename: id(`rename-${key}`), field: id(`rename-field-${key}`) });
  const goToRename = (key: string) => {
    if (key !== investor) setOpen("part", true);
    focusSoon(renameIds(key).field, true);
  };
  const newLine = (key: string, label: string) => (
    <NewAccountLine
      proposed={proposed(key)}
      label={label}
      ids={renameIds(key)}
      editing={renaming?.key === key ? renaming : undefined}
      onRename={() => {
        if (renaming) {
          announce("Save or cancel the new account name first.");
          return goToRename(renaming.key);
        }
        setRenaming({ key, draft: proposed(key).name });
        focusSoon(renameIds(key).field, true);
      }}
      onDraft={(draft) => setRenaming((r) => r && { ...r, draft })}
      onSave={() => {
        if (!renaming) return;
        const problem = nameProblem(renaming.draft);
        if (problem) {
          setRenaming({ ...renaming, error: problem });
          announce(problem);
          focusSoon(renameIds(key).field, true);
          return;
        }
        const name = renaming.draft.trim();
        setRenamed((all) => ({ ...all, [key]: name }));
        setRenaming(null);
        announce(`The new account will be called ${name}.`);
        focusSoon(renameIds(key).rename, true);
      }}
      onCancel={() => {
        setRenaming(null);
        focusSoon(renameIds(key).rename, true);
      }}
    />
  );

  const searchChanges = items.filter((item) => {
    const s = searches.get(item.key);
    return !!s.text.trim() || !!s.typed || !!s.picked;
  }).length;
  const sizes = (map: ReadonlyMap<string, ReadonlySet<string> | ReadonlyMap<string, unknown>>) => [...map.values()].reduce((n, v) => n + v.size, 0);
  const changes = Object.entries(picks).filter(([key, value]) => value !== (accountChoices[key] ?? (key === investor ? null : ""))).length +
    Object.keys(answers).length + sizes(costs) + sizes(keeps) + sizes(replaced) + sameDate.size + alsoSave.size + searchChanges + (editor ? 1 : 0) +
    Object.keys(renamed).length + (renaming ? 1 : 0);

  const remember = () => {
    // A choice in place of an ignored one is remembered even when it's the same as having none.
    // A new account is remembered once it's created.
    const accountsChanged = Object.entries(picks).filter(([key, value]) => !isProposed(value) && (value !== (accountChoices[key] ?? "") || key in ignored));
    const funds = [
      ...Object.entries(matched).filter(([key]) => !(key in answers)).map(([key, fund]) => [key, { fund }] as [string, FundChoice]),
      ...Object.entries(answers).flatMap(([key, choice]) => (choice ? [[key, choice] as [string, FundChoice]] : [])),
    ];
    onRemember({ accounts: accountsChanged, funds });
  };

  const trackedSummary = (): TrackedSummary | undefined => {
    const notSaved = trackedFunds.filter((t) => !t.fund.included);
    if (!notSaved.length) return undefined;
    const differ = notSaved.map((t) => ({ t, c: t.fund.comparison })).find((x) => x.c.kind === "differ");
    return {
      count: notSaved.length,
      accounts: [...new Set(notSaved.map((t) => t.accounts))].join(" and "),
      differ: differ && differ.c.kind === "differ"
        ? { name: differ.t.fund.name, by: units(format(abs(sub(dec(differ.c.theirs.replace(/[^\d.-]/g, "")), dec(differ.c.ours.replace(/[^\d.-]/g, "")))))), accounts: differ.c.accounts }
        : undefined,
    };
  };

  /**
   * Saves each plan's snapshot, first creating its account if it's a new one. A plan whose account
   * isn't created saves nothing, and the others go on. `again` saves what an earlier save left: plans
   * whose account wasn't created, or whose snapshot failed in an account this review created, which
   * it saves into without creating another.
   */
  const runSave = async (again?: Pending) => {
    // An account whose saved holdings are kept isn't saved.
    const run: Pending | null = again ?? (current && {
      plans,
      // The statement's price for each manual-priced asset any account's snapshot lists.
      listed: new Map(plans.flatMap((plan) =>
        pricesToSave(plan, choicesFor(plan.accountId, plan)).filter((p) => p.from === "statement").map((p) => [p.ref, p.price] as const))),
      quotes: current.quotes,
      warnings: rows.flatMap((row) => planWarnings(row).map((warning) => ({ accountId: row.accountId, name: row.name, warning }))),
      tracked: trackedSummary(),
      kept: keptPlans.map((plan) => `${accountName(plan.accountId)}: the holdings already saved for ${date} were kept; nothing changed there.`),
      doubles: doubles.map((d) => d.text),
    });
    // Only what was reviewed and confirmed is saved; a retry goes on with what an earlier save left.
    if (!run || (!again && !canSave)) return;
    if (!again) remember();
    // Firefox keeps the focus on the pressed button while it's disabled; the others drop it.
    const pressed = document.activeElement;
    setBusy("import");
    setError("");
    setNotCreated([]);
    // A retry keeps what was saved, and replaces what it tries again.
    const before = again && result ? result.saved : undefined;
    const retried = new Set(run.plans.map((plan) => created.current.get(plan.accountId)?.id ?? plan.accountId));
    const saved: SavedSnapshots = {
      saved: [...(before?.saved ?? [])],
      failed: (before?.failed ?? []).filter((f) => !retried.has(f.accountId)),
      unremembered: before?.unremembered ?? false,
      unfinished: (before?.unfinished ?? []).filter((f) => !retried.has(f.accountId)),
    };
    const savedPlans = new Set(again && result ? result.savedPlans : []);
    const missing: NotCreated[] = [];
    const left: AccountPlan[] = [];
    const made: Account[] = [];
    const nowRemembered: [string, string][] = [];
    let stopped = false;
    try {
      for (const plan of run.plans) {
        setSaving((all) => ({ ...all, [plan.accountId]: "saving" }));
        const chosen = choicesFor(plan.accountId, plan);
        let accountId = plan.accountId;
        if (isProposed(accountId)) {
          let account = created.current.get(accountId);
          if (!account) {
            const name = accountName(accountId);
            try {
              account = await api.accounts.create(newAccount(name, "HOLDINGS"));
            } catch (e) {
              // Its name stays as shown while other new accounts take theirs.
              tried.current[proposalKey(accountId)] = name;
              missing.push({ accountId, name, error: String(e) });
              left.push(plan);
              setSaving((all) => ({ ...all, [plan.accountId]: "failed" }));
              continue;
            }
            created.current.set(accountId, account);
            made.push(account);
            // The choices that pointed at it are remembered now that it exists.
            for (const key of [investor, ...holdings.sources.map(sourceKey)]) {
              if (valueOf(key) === accountId) nowRemembered.push([key, account.id]);
            }
          }
          accountId = account.id;
        }
        const into: AccountPlan = accountId === plan.accountId ? plan : { ...plan, accountId };
        const { holdings: positions, cash } = snapshotOf(plan, chosen);
        try {
          await api.snapshots.save(accountId, positions, cash, plan.date);
          saved.saved.push({ accountId, date: plan.date, holdings: positions.length });
          savedPlans.add(plan.accountId);
        } catch (e) {
          saved.failed.push({ accountId, error: String(e) });
          if (isProposed(plan.accountId)) left.push(plan);
          setSaving((all) => ({ ...all, [plan.accountId]: "failed" }));
          // A failed host save can already have written average-cost quotes.
          saved.unfinished.push(...(await afterSave(api, into, chosen, run.listed, run.quotes, () => savedAssets(api, accountId, plan.date), false)));
          continue;
        }
        let assetIds: Promise<Map<string, string>> | undefined;
        const savedIds = () => (assetIds ??= savedAssets(api, accountId, plan.date));
        saved.unfinished.push(...(await afterSave(api, into, chosen, run.listed, run.quotes, savedIds)));
        try {
          // The IDs of the assets the save created or found, so that a later import can follow them
          // after their symbol or exchange changes. A record without one goes by remembered choices.
          const unknown = unidentified(plan, chosen);
          const found = unknown.length ? await savedIds() : new Map<string, string>();
          if (unknown.some((ref) => !found.has(ref))) saved.unremembered = true;
          await saveImports(api.storage, accountId, plan.date, importedRefs(plan, chosen, found));
          await saveUnlisted(api.storage, plan.date, unlistedRefs(plan, chosen));
          // Each folio, demat account and PRAN with a record in the account, so a later statement
          // that doesn't list it finds what it added.
          await indexSources(api.storage, accountId, holdings.investor, [
            ...plan.sources,
            ...[...plan.unread, ...plan.reassigned].filter((u) => u.remembered.size > 0 || u.aside?.size).map((u) => u.source),
          ]);
        } catch {
          saved.unremembered = true;
        }
        setSaving((all) => ({ ...all, [plan.accountId]: "saved" }));
      }
    } catch (e) {
      stopped = true;
      setError(`The import stopped: ${String(e)}`);
    } finally {
      // The accounts it created join the page's, and the choices that pointed at them now name them.
      if (made.length) onCreated(made);
      if (nowRemembered.length) {
        onRemember({ accounts: nowRemembered, funds: [] });
        setPicks((all) => ({ ...all, ...Object.fromEntries(nowRemembered) }));
      }
      if (!result && !stopped && !saved.saved.length && !saved.failed.length && missing.length) {
        // Nothing was saved: the review stays as it was, saying which accounts weren't created.
        setNotCreated(missing);
        announce(`Nothing was saved: Wealthfolio didn't create ${missing.length === 1 ? `the account ${missing[0].name}` : `${missing.length} accounts`}.`);
        focusSoon(ids.notCreated, false, pressed);
      } else {
        setResult({
          saved,
          savedPlans,
          tracked: run.tracked,
          conflicts: run.warnings.filter((w) => savedPlans.has(w.accountId)),
          notCreated: missing,
          pending: left.length ? { ...run, plans: left } : undefined,
          kept: run.kept,
          doubles: run.doubles,
        });
        setSaves((n) => n + 1);
      }
      for (const key of [QueryKeys.HOLDINGS, QueryKeys.SNAPSHOTS, QueryKeys.ACCOUNTS, QueryKeys.PORTFOLIO_SUMMARY, QueryKeys.HISTORY_VALUATION]) {
        api.query.invalidateQueries([key]);
      }
      setBusy("");
    }
  };

  const review = (accountId: string) => {
    api.navigation.navigate(`/accounts/${accountId}`).catch(() => api.toast.error("Couldn't open the account."));
  };

  const kind = "cas_type" in statement ? `${KINDS[statement.file_type] ?? statement.file_type} summary statement` : `${KINDS[statement.file_type] ?? statement.file_type} statement`;
  const investorName = statement.investor_info.name?.trim() || statement.investor_info.email?.trim() || "This investor";
  const itemsShown = items.filter((item) => snapshotKeys.has(item.key) || holdings.sources.some((s) => (s.zero ?? []).some((h) => holdingKey(h) === item.key)));
  const editWhat = editor ? (editor.kind === "cost" ? `your purchase-cost edit for ${editor.name}` : `your change to ${editor.name}`) : "";
  const missingCosts = rows.filter((r) => !r.cost && r.accountId);
  /** The bar's disclosure of an account's whole snapshot after saving, shown above the bar. */
  const see = (plan: AccountPlan) => (
    <p key={`see:${plan.accountId}`}>
      <LinkButton
        type="button"
        aria-expanded={!!open[`snapshot:${plan.accountId}`]}
        aria-controls={id(`snapshot-${plan.accountId}`)}
        onClick={() => setOpen(`snapshot:${plan.accountId}`, !open[`snapshot:${plan.accountId}`])}
      >
        See {accountName(plan.accountId)}'s holdings on {date} after saving
      </LinkButton>
    </p>
  );
  const nextQuestion = () => {
    if (accountQuestion) return focusAccountQuestion(true);
    focusSoon(openHeadings()[0] ?? ids.questions, true);
  };

  const header = (
    <ReviewHeader
      ids={{ heading: ids.heading, another: ids.another, keep: ids.keep, discard: id("discard") }}
      title={`Holdings on ${date}`}
      lines={[`${kind} · ${investorName} · ${fileName}`, `Saves what you held on ${date}, not your purchases and sales.`]}
      changes={result ? 0 : changes}
      discard={discard}
      onAnother={() => onAnother()}
      onDiscard={() => {
        setDiscard(true);
        focusSoon(ids.keep, false, document.activeElement);
      }}
      onKeep={() => {
        setDiscard(false);
        focusSoon(ids.another, false, document.activeElement);
      }}
    />
  );

  const status = (
    <p role="status" className="sr-only" style={{ overflowWrap: "anywhere" }}>
      {busy === "import" ? "Saving…" : said}
    </p>
  );

  if (result) {
    return (
      <div className="grid grid-cols-1 gap-6">
        {header}
        {status}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {(result.saved.saved.length > 0 || result.saved.failed.length > 0 || result.notCreated.length > 0 || !result.kept.length) && (
          <HoldingsResult
            key={saves}
            result={result.saved}
            accounts={[...allAccounts, ...created.current.values()]}
            notCreated={result.notCreated}
            retry={result.pending && (() => void runSave(result.pending))}
          />
        )}
        {result.kept.map((line) => <p key={line} className="text-sm" style={{ overflowWrap: "anywhere" }}>{line}</p>)}
        {result.doubles.map((line) => <p key={line} className="text-warning text-sm" style={{ overflowWrap: "anywhere" }}>{line}</p>)}
        {result.conflicts.map((c, i) => <p key={i} className="text-warning text-sm">{accountName(c.accountId)}, {c.name}: {c.warning}</p>)}
        {result.tracked && (
          <p className="text-sm">
            {plural(result.tracked.count, "fund")} already tracked in {result.tracked.accounts} {result.tracked.count === 1 ? "wasn't" : "weren't"} saved
            here too
            {result.tracked.differ ? (
              <>
                ; {result.tracked.differ.name} differs by {result.tracked.differ.by} units there.{" "}
                {result.tracked.differ.accounts.map((account) => (
                  <span key={account.id}>
                    <LinkButton type="button" onClick={() => review(account.id)}>
                      Review its transactions in {account.name}
                    </LinkButton>{" "}
                  </span>
                ))}
              </>
            ) : (
              "."
            )}
          </p>
        )}
      </div>
    );
  }

  const amfiFunds = openKeys.filter((key) => {
    const item = itemOf.get(key)!;
    const auto = searches.get(key).auto;
    return item.noun === "fund" && item.isin && auto?.status === "done" && !auto.amfi;
  }).length;
  const answeredKeys = items.filter((item) => item.key in answers && answers[item.key] && snapshotKeys.has(item.key) && sourcesOf(item.key).some(savingSource)).map((i) => i.key);
  const anyQuestions = questionKeys.length > 0 || answeredKeys.length > 0 || asks.length > 0;
  const openCount = openKeys.length + openAsks.length;
  const answeredCount = answeredKeys.length + asks.length - openAsks.length;
  /** A rare question: its card while it's open, then its answered line. */
  const askView = (ask: Ask) => {
    if (ask.answer !== undefined) {
      return (
        <ul key={ask.id} className="grid">
          <AskAnswered text={ask.words.receipt(ask.answer)} target={ask.target} buttonId={ids.askAnswer(ask.id)} onChange={() => reopenAsk(ask)} />
        </ul>
      );
    }
    const name = (label: string) => `${label}: ${ask.target}`;
    return (
      <AskCard
        key={ask.id}
        headingId={ids.ask(ask.id)}
        title={ask.words.title}
        target={ask.target}
        main={{ label: ask.words.main, name: name(ask.words.main), onClick: () => answerAsk(ask, true) }}
        other={{ label: ask.words.other, name: name(ask.words.other), onClick: () => answerAsk(ask, false) }}
        note={ask.words.note}
        caution={ask.words.caution}
        why={ask.words.why ? { text: ask.words.why, open: !!open[`why:${ask.id}`], onOpenChange: (yes) => setOpen(`why:${ask.id}`, yes) } : undefined}
        disabled={busy !== "" || !current}
      >
        <p>{ask.words.line}</p>
        {ask.changes && (
          <ul className="list-disc ps-4">
            {ask.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
      </AskCard>
    );
  };
  /** The statement's holdings that would have gone to an account whose saved holdings are kept. */
  const keptHoldings = (plan: AccountPlan) =>
    holdings.sources.filter((s) => accountOf(s) === plan.accountId).flatMap((s) => s.holdings.map((h) => {
      const item = itemOf.get(holdingKey(h))!;
      return { key: `${s.id}|${item.key}`, name: shownName(item, fundOf(item.key)), units: unitWords(item, h.units) };
    }));
  /** Keeps the sources a double-count warning names in the account whose saved holdings are kept. */
  const keepInKept = (d: (typeof doubles)[number]) => {
    chooseAccounts(Object.fromEntries(d.sources.map((s) => [sourceKey(s), d.accountId])));
    const left = holdings.sources.some((s) => !d.sources.includes(s) && destination(s) !== LEFT_OUT && !keptSaved.has(accountOf(s) ?? ""));
    if (!left) {
      focusSoon(ids.summary);
      return announce(`Nothing will be saved. ${d.account}'s holdings for ${date} are kept.`);
    }
    focusSoon(ids.ready);
    announce(`${d.sources.length === 1 ? `${d.sources[0].title ?? d.sources[0].label} now goes` : `${plural(d.sources.length, "statement section")} now go`} to ${d.account}, whose holdings for ${date} are kept.`);
  };
  const laterPlans = plans.filter((plan) => plan.existing.later.length > 0);
  const later = (plan: AccountPlan) =>
    `This saves holdings history for ${date}. ${accountName(plan.accountId)}'s current holdings still come from its snapshot of ${longDate(plan.existing.later[plan.existing.later.length - 1])}.`;

  return (
    <div className="space-y-6">
      {header}
      {status}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{plural(itemsShown.length, "holding")}</Badge>
        {lookingUp.length > 0 ? (
          <Badge variant="outline">
            <Spinner /> Looking up {lookingUp.length}…
          </Badge>
        ) : (
          <>
            {keptPlans.map((plan) => (
              <Badge key={plan.accountId} variant="outline" className="max-w-full whitespace-normal" style={{ overflowWrap: "anywhere" }}>
                {accountName(plan.accountId)} kept as saved
              </Badge>
            ))}
            {(readyKeys.size > 0 || !keptPlans.length) && <Badge variant="outline">{readyKeys.size} ready</Badge>}
            {notIncludedKeys.size > 0 && <Badge variant="outline">{notIncludedKeys.size} not included</Badge>}
            {questionCount > 0 && (
              <Button type="button" variant="outline" size="xs" className="border-warning" onClick={nextQuestion}>
                {plural(questionCount, "question")}
              </Button>
            )}
          </>
        )}
      </div>
      {statement.parse_warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>casparser reported warnings</AlertTitle>
          <AlertDescription>
            Check these warnings against the PDF before saving.
            <ul className="list-disc ps-4">
              {statement.parse_warnings.map((warning) => (
                <li key={warning}>{readableName(warning)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <SaveTo
        investorName={investorName}
        investorKey={investor}
        sources={holdings.sources}
        targets={targets}
        proposed={(key) => created.current.has(proposedId(key)) ? undefined : proposed(key)}
        newLine={newLine}
        values={Object.fromEntries([investor, ...holdings.sources.map(sourceKey)].map((key) => [key, valueOf(key)]))}
        ignored={Object.fromEntries(Object.entries(ignored).filter(([key]) => !(key in picks)))}
        remembered={!!usable[investor] && !(investor in picks)}
        open={!!open.part}
        onOpen={(yes) => setOpen("part", yes)}
        onChange={chooseAccount}
        partId={id("save-to")}
      />
      {anyQuestions && (
        <section aria-labelledby={ids.questions} className="grid gap-3">
          <h3 id={ids.questions} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            Questions for you
            {openCount > 0 && ` · ${openCount} of ${openCount + answeredCount} left`}
          </h3>
          {amfiFunds > 0 && amfi.status !== "on" && (
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  {amfi.status === "off" ? "AMFI isn't added" : "AMFI may not be added"}, so {amfiFunds === 1 ? "1 fund was" : `${amfiFunds} funds were`} only
                  searched on Yahoo Finance and {amfiFunds === 1 ? "needs" : "need"} you. Add AMFI to match {amfiFunds === 1 ? "it" : "them"} for you.
                </p>
                {amfi.outcome && <p className="text-warning">{amfi.outcome}</p>}
                <div className="flex flex-wrap gap-2">
                  <WrapButton
                    type="button"
                    variant={openedSettings ? "outline" : "default"}
                    onClick={() => {
                      setOpenedSettings(true);
                      amfi.openSettings();
                    }}
                  >
                    Open Market data settings
                  </WrapButton>
                  {openedSettings && (
                    <WrapButton type="button" onClick={() => { amfiFocus.current = document.activeElement; void amfi.check(); }}>
                      {amfi.checking && <Spinner />}
                      I've added AMFI: check
                    </WrapButton>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          {lookingUp.length > 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner /> Looking up {plural(lookingUp.length, "holding")}…
            </p>
          )}
          {openCount === 0 && answeredCount > 0 && lookingUp.length === 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 rounded-lg border p-3">
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
              <span>{answeredCount === 1 ? "Question answered." : `All ${answeredCount} questions answered.`}</span>
              <Disclosure
                id={id("show-answers")}
                label={open.answers ? "Hide answers" : "Show answers"}
                open={!!open.answers}
                onOpenChange={(yes) => setOpen("answers", yes)}
              >
                <ul className="mt-2 grid gap-2">
                  {sameAsks.map((ask) => (
                    <AskAnswered key={ask.id} text={ask.words.receipt(ask.answer!)} target={ask.target} buttonId={ids.askAnswer(ask.id)} onChange={() => reopenAsk(ask)} />
                  ))}
                  {answeredKeys.map((key) => (
                    <AnsweredLine
                      key={key}
                      item={itemOf.get(key)!}
                      label={labelOf.get(key)!}
                      choice={answers[key]!}
                      buttonId={ids.answerButton(key)}
                      onChange={() => reopen(key)}
                    />
                  ))}
                  {holdingAsks.map((ask) => (
                    <AskAnswered key={ask.id} text={ask.words.receipt(ask.answer!)} target={ask.target} buttonId={ids.askAnswer(ask.id)} onChange={() => reopenAsk(ask)} />
                  ))}
                </ul>
              </Disclosure>
            </div>
          ) : (
            <div className="grid gap-3">
              {sameAsks.map(askView)}
              {items
                .filter((item) => openKeys.includes(item.key) || answeredKeys.includes(item.key))
                .map((item) =>
                  openKeys.includes(item.key) ? (
                    <QuestionCard
                      key={item.key}
                      item={item}
                      label={labelOf.get(item.key)!}
                      units={unitWords(item, sourcesOf(item.key).filter(savingSource).flatMap((s) => s.holdings.filter((h) => holdingKey(h) === item.key))
                        .reduce((total, h) => format(add(dec(total), dec(h.units))), "0"))}
                      search={searches.get(item.key)}
                      searches={searches}
                      base={ids.picker(item.key)}
                      amfiOn={amfi.status === "on"}
                      headingId={ids.question(item.key)}
                      onAnswer={(choice) => answer(item.key, choice)}
                    />
                  ) : (
                    <ul key={item.key} className="grid">
                      <AnsweredLine
                        item={item}
                        label={labelOf.get(item.key)!}
                        choice={answers[item.key]!}
                        buttonId={ids.answerButton(item.key)}
                        onChange={() => reopen(item.key)}
                      />
                    </ul>
                  ),
                )}
              {holdingAsks.map(askView)}
            </div>
          )}
        </section>
      )}
      {keptPlans.map((plan) => (
        <section key={plan.accountId} aria-labelledby={id(`kept-${plan.accountId}`)} className="grid grid-cols-1 gap-2" style={{ overflowWrap: "anywhere" }}>
          <h3 id={id(`kept-${plan.accountId}`)} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            {accountName(plan.accountId)}: nothing will be saved
          </h3>
          <p className="text-success text-sm">Its existing holdings will be kept for {date}.</p>
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <Disclosure
              label="Show this statement's holdings"
              ariaLabel={`Show this statement's holdings for ${accountLabel(plan.accountId)}`}
              open={!!open[`kept:${plan.accountId}`]}
              onOpenChange={(yes) => setOpen(`kept:${plan.accountId}`, yes)}
            >
              <ul className="mt-2 grid grid-cols-1 gap-1">
                {keptHoldings(plan).map((h) => (
                  <li key={h.key}>
                    {h.name} <span className="text-muted-foreground">· {h.units}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        </section>
      ))}
      {rows.length > 0 && (
        <section aria-labelledby={ids.ready} className="grid gap-3">
          <h3 id={ids.ready} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            Ready to save ({rows.length})
          </h3>
          {autoCount > 0 && (
            <p className="text-muted-foreground text-sm">
              {plural(autoCount, "fund")} found automatically on AMFI. Change any that look wrong.
            </p>
          )}
          {laterPlans.map((plan) => (
            <p key={plan.accountId} className="text-warning text-sm">
              {later(plan)}
            </p>
          ))}
          {doubles.map((d) => (
            <div key={d.accountId} className="grid grid-cols-1 gap-2" style={{ overflowWrap: "anywhere" }}>
              <p className="text-warning text-sm">{d.text}</p>
              <div className="flex flex-wrap gap-2">
                <WrapButton type="button" variant="outline" disabled={busy !== ""} aria-label={`${d.button}${nameNumber(accounts, accounts.findIndex((a) => a.id === d.accountId), "account")}`} onClick={() => keepInKept(d)}>
                  {d.button}
                </WrapButton>
              </div>
            </div>
          ))}
          <ReadyTable
            ctx={ctx}
            rows={rows}
            date={holdings.date}
            wide={wide}
            showAll={showAll}
            onShowAll={() => {
              setShowAll(true);
              focusSoon(ids.ready, false, document.activeElement);
            }}
            showAllId={ids.showAll}
            handlers={handlers}
          />
        </section>
      )}
      {keptAsIs.length > 0 && (
        <section aria-labelledby={id("kept-as-is")} className="grid gap-2">
          <h3 id={id("kept-as-is")} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            Kept as they are ({keptAsIs.length})
          </h3>
          <ul className="grid gap-2 text-sm">
            {keptAsIs.map(({ plan, position }) => (
              <li key={`${plan.accountId}|${position.key}`} className="grid grid-cols-1 gap-1">
                <span>
                  <span className="font-medium">{position.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {units(position.existing!.units)} units in {accountName(plan.accountId)}
                  </span>
                </span>
                {position.notes.map((note, i) => (
                  <span key={i} className="text-muted-foreground">
                    {note}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <NotIncluded
        tracked={tracked}
        counted={counted}
        skipped={skipped.map((item) => labelOf.get(item.key)!)}
        unsaved={unsaved.map((item) => labelOf.get(item.key)!)}
        defaulted={defaulted.map(({ plan, position }) => {
          // A row left out can be changed to another asset, as a ready row can.
          const row = toRow(plan, position, choicesFor(plan.accountId, plan));
          const answered = position.ask?.kind === "replace"
            ? [`${accountName(plan.accountId)} keeps ${assetNames(plan.positions.filter((p) => position.replaces?.includes(p.key)))} for now, by your answer above.`]
            : [];
          return {
            key: row.id,
            name: `${row.name}${keptPlans.length || plans.length > 1 ? ` (${accountName(plan.accountId)})` : ""}`,
            notes: [...answered, ...position.notes.filter((note) => !note.endsWith(OVERLAP_NOTE))],
            change: (
              <>
                <LinkButton
                  id={ids.row(row).change}
                  type="button"
                  aria-expanded={handlers.changing === row.id && handlers.changingItem === row.item.key}
                  aria-label={`Change: ${row.label} in ${accountLabel(plan.accountId)}`}
                  onClick={() => handlers.onChange(row)}
                >
                  Change
                </LinkButton>
                <OtherChanges row={row} handlers={handlers} />
              </>
            ),
            panel: handlers.changing === row.id ? handlers.changePanel(row) : undefined,
          };
        })}
        lines={leftOutLines}
        open={open}
        setOpen={setOpen}
        onSaveBoth={(key) => {
          setAlsoSave((all) => new Set(all).add(key));
          focusSoon(ids.ready, false, document.activeElement);
          announce(`${shownName(itemOf.get(key)!, fundOf(key))} will be saved in both accounts.`);
        }}
        onDontSave={(key) => {
          const combined = new Set(plans.flatMap((plan) => plan.positions.filter((p) => p.heldBy &&
            p.lines.some((l) => holdingKey(l.holding) === key)).flatMap((p) => p.lines.map((l) => holdingKey(l.holding)))));
          setAlsoSave((all) => new Set([...all].filter((k) => !combined.has(k))));
          clearPositionWrites((_plan, p) => !!p.heldBy && p.lines.some((l) => holdingKey(l.holding) === key));
          focusSoon(id("not-included-heading"), false, document.activeElement);
        }}
        onReview={(accountId) => review(accountId)}
        partId={id("not-included")}
      />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {missingNow.length > 0 && (
        <div id={ids.notCreated} tabIndex={-1} className="grid gap-2">
          <NotCreatedAlert accounts={missingNow} what={() => "Nothing was saved."} />
          <WrapButton type="button" variant="outline" className="justify-self-start" aria-label="Try again saving holdings" onClick={() => void runSave()} disabled={!canSave}>
            Try again
          </WrapButton>
        </div>
      )}
      {plans.filter((plan) => open[`snapshot:${plan.accountId}`]).map((plan) => (
        <section key={plan.accountId} id={id(`snapshot-${plan.accountId}`)} aria-label={`${accountName(plan.accountId)}'s holdings on ${date} after saving`}>
          <SnapshotTable plan={plan} choices={choicesFor(plan.accountId, plan)} account={accountName(plan.accountId)} />
        </section>
      ))}
      <Footer
        summaryId={ids.summary}
        lines={(() => {
          if (busy === "import") {
            return plans.map((plan) => (
              <p key={plan.accountId}>
                {saving[plan.accountId] === "saved" ? "Saved" : saving[plan.accountId] === "failed" ? "Didn't save" : "Saving"}{" "}
                <span className="font-semibold">{accountName(plan.accountId)}</span>
                {saving[plan.accountId] === "saving" || !saving[plan.accountId] ? "…" : "."}
              </p>
            ));
          }
          if (renaming) return [<p key="r" className="text-warning">Save or cancel the new account name first.</p>];
          if (prepareError && !nothing) return [<p key="x" className="text-destructive">{prepareError}</p>];
          if (editor) return [<p key="e" className="text-warning">Save or cancel {editWhat} first.</p>];
          if (lookingUp.length) return [<p key="l">Looking up {plural(lookingUp.length, "holding")}…</p>];
          if (questionCount) {
            // Only the rare questions left: the snapshots they decide can be seen already.
            return [
              <p key="q">{plural(questionCount, "question")} left before saving.</p>,
              ...(answeredAll && current
                ? plans.flatMap((plan) => [
                    ...(plan.existing.later.length ? [<p key={`later:${plan.accountId}`} className="text-warning">{later(plan)}</p>] : []),
                    see(plan),
                  ])
                : []),
            ];
          }
          if (nothing) {
            return [
              <p key="n">
                {keptPlans.length
                  ? `Nothing will change: you kept the holdings already saved in ${list(keptPlans.map((plan) => accountName(plan.accountId)))} for ${date}.`
                  : "Nothing from this statement will be saved."}
              </p>,
            ];
          }
          if (!current) return [<p key="w" className="text-muted-foreground">Working out what will be saved…</p>];
          const lines = plans.map((plan) => {
            const n = rows.filter((r) => r.accountId === plan.accountId).length;
            const name = <span className="font-semibold">{accountName(plan.accountId)}</span>;
            // What the answers about its holdings do.
            const done = holdingAsks.filter((a) => a.accountId === plan.accountId && a.answer !== undefined).map((a) => a.words.done(a.answer!));
            return (
              <div key={plan.accountId} className="grid grid-cols-1 gap-1">
                <p>
                  {isProposed(plan.accountId) ? (
                    <>
                      Create the Wealthfolio account {name} and save {plural(n, "holding")} on {date}.
                    </>
                  ) : plan.existing.date ? (
                    <>
                      Update {name} to {date} with {plural(n, "holding")} from this statement. Its other holdings and cash stay.
                    </>
                  ) : (
                    <>
                      Save {plural(n, "holding")} in {name} on {date}.
                    </>
                  )}
                </p>
                {done.length > 0 && <p className="text-muted-foreground">{capital(done.join("; "))}.</p>}
                {plan.existing.later.length > 0 && <p className="text-warning">{later(plan)}</p>}
                {see(plan)}
              </div>
            );
          });
          for (const plan of keptPlans) {
            lines.push(
              <p key={`kept:${plan.accountId}`} className="text-muted-foreground">
                {accountName(plan.accountId)}: existing holdings kept for {date}.
              </p>,
            );
          }
          for (const d of doubles) {
            lines.push(
              <p key={`double:${d.accountId}`} className="text-warning">
                {d.text}
              </p>,
            );
          }
          if (missingCosts.length) {
            lines.push(
              <p key="c" className="text-warning">
                Purchase cost missing for {missingCosts.length} ·{" "}
                <LinkButton type="button" onClick={() => focusSoon(ids.row(missingCosts[0]).cost, false, document.activeElement)}>
                  Add costs
                </LinkButton>
              </p>,
            );
          }
          return lines;
        })()}
        action={
          questionCount || lookingUp.length
            ? { label: plans.every((p) => p.existing.date) && plans.length ? "Update holdings" : "Save holdings", disabled: true }
            : nothing
              ? {
                  label: "Finish",
                  disabled: !!editor || !!renaming,
                  onClick: () => {
                    remember();
                    onAnother(`Finished: nothing from ${fileName} was saved.${keptPlans.length ? ` ${keptPlans.map(keptWords).join(". ")}.` : ""}`);
                  },
                }
              : {
                  label: busy === "import" ? "Saving…" : plans.every((p) => p.existing.date) && plans.length ? "Update holdings" : "Save holdings",
                  disabled: !canSave,
                  busy: busy === "import",
                  onClick: () => void runSave(),
                }
        }
        go={
          renaming
            ? { label: "Go to it", onClick: () => goToRename(renaming.key) }
            : (prepareError || (retrying && !editor)) && !nothing
            ? {
                label: "Try again",
                busy: retrying,
                onClick: () => {
                  // With an edit open, the button becomes its Go to it and keeps the focus.
                  retryFrom.current = editor || renaming ? null : document.activeElement;
                  setRetrying(true);
                  cache.current = { reads: new Map(), profileOf: profiles(api) };
                  setGeneration((n) => n + 1);
                },
              }
            : editor
              ? { label: "Go to it", onClick: () => focusSoon(editorTarget(editor), true) }
              : questionCount && !lookingUp.length
                ? { label: questionCount === 1 ? "Go to the question" : "Go to the next question", onClick: nextQuestion }
                : undefined
        }
      />
    </div>
  );
}

/** What a save left to do, with what it was worked out from: Try again saves it. */
interface Pending {
  plans: AccountPlan[];
  listed: ReadonlyMap<string, string>;
  quotes: ReadonlyMap<string, Quote>;
  /** Each plan's rows' warnings, shown once its snapshot is saved. */
  warnings: { accountId: string; name: string; warning: string }[];
  tracked?: TrackedSummary;
  /** Accounts whose holdings saved for the date were kept, and what that still counts twice. */
  kept: string[];
  doubles: string[];
}

interface SaveResult {
  saved: SavedSnapshots;
  /** The plans saved, by their account ID in the review: a new account's proposed ID. */
  savedPlans: ReadonlySet<string>;
  tracked?: TrackedSummary;
  conflicts: { accountId: string; name: string; warning: string }[];
  notCreated: NotCreated[];
  pending?: Pending;
  kept: string[];
  doubles: string[];
}

interface TrackedSummary {
  count: number;
  accounts: string;
  differ?: { name: string; by: string; accounts: { id: string; name: string }[] };
}
