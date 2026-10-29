// Runs inside the sandboxed iframe that tests/browser/sandbox.mjs builds. The page posts the
// packaged files as Blobs; this stands in for ctx.assets and drives the real CasParser, then
// mounts the import page on a fake host: an account tracking transactions and two tracking
// holdings, in-memory storage, secrets and snapshots, a fund search, recorded error toasts, and
// an import that stores rows the way Wealthfolio returns them. Snapshot saves write a manual
// asset's average cost as its quote for the day, and profile updates store every field as sent,
// both as Wealthfolio does. Wealthfolio's own checks are left
// to the end-to-end run in the pull request.
import type {
  ActivityCreate,
  ActivityDetails,
  ActivityImport,
  ActivityUpdate,
  AddonAssets,
  AddonContext,
  Quote,
  SnapshotHoldingInput,
  SymbolSearchResult,
} from "@wealthfolio/addon-sdk";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CasError, CasParser } from "../../src/cas/parser";
import { ImportPage } from "../../src/pages/import-page";
import type { DematAccount } from "../../src/cas/types";

interface HostAsset {
  symbol: string;
  exchangeMic: string | null;
  instrumentType?: string;
  name?: string | null;
  notes?: string | null;
  displayCode?: string | null;
  kind?: string;
  quoteCcy?: string;
  providerConfig?: unknown;
  metadata?: unknown;
}

const host = {
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  activities: [] as ActivityDetails[],
  searches: [] as string[],
  pause: "password",
  pending: undefined as Promise<void> | undefined,
  resume: undefined as (() => void) | undefined,
  failHistory: false,
  failDelete: false,
  rejectLine: undefined as number | undefined,
  skipLine: undefined as number | undefined,
  // An invented second folio holding the fund with this ISIN, added to what the parser reads.
  sharedIsin: "",
  // Holdings dropped from a depository statement as if they had been sold.
  soldIsins: [] as string[],
  parseWarnings: [] as string[],
  // The statement has only an NPS account, with these schemes.
  onlyNps: undefined as { scheme: string; units: string }[] | undefined,
  npsPran: "XXXXXXXX9001",
  statementDate: "",
  depositoryAccounts: undefined as DematAccount[] | undefined,
  ambiguousSummary: false,
  // Summary statements print no ISIN for the funds with these.
  summaryWithoutIsin: [] as string[],
  archiveOtherAccount: false,
  reopen: () => {},
  // Asset pricing mode belongs to the asset, independently of any account or snapshot.
  pricingModes: {} as Record<string, string>,
  // Assets a save created or a profile update changed, by ID: what `snapshots.getByDate` and
  // `assets.getProfile` return. Others are funds on XBOM.
  assets: {} as Record<string, HostAsset>,
  // Forced opaque IDs verify that the add-on finds IDs returned by the host after saving.
  assetIds: {} as Record<string, string>,
  // Each asset's quotes, one per day and source.
  quotes: {} as Record<string, Quote[]>,
  failQuoteIds: [] as string[],
  failSearchQueries: [] as string[],
  emptySearchQueries: [] as string[],
  failGetProfileIds: [] as string[],
  failProfileIds: [] as string[],
  failSnapshotAccounts: [] as string[],
  // Each account's snapshots by date, as saved.
  snapshots: {} as Record<string, Record<string, { holdings: SnapshotHoldingInput[]; cash: Record<string, string>; source?: string }>>,
  saves: [] as { accountId: string; date: string }[],
  // What accounts that track transactions hold, by symbol on XBOM.
  held: {} as Record<string, string[]>,
  parsed: 0,
  toasts: [] as string[],
  // Transfers already in a pair, and the pairs the add-on linked.
  linked: [] as string[],
  links: [] as [string, string][],
};
declare global {
  interface Window {
    host: typeof host;
  }
}
window.host = host;

const wait = async (operation: string) => {
  if (host.pause !== operation) return;
  host.pending ??= new Promise<void>((resolve) => {
    host.resume = () => {
      host.pause = "";
      host.pending = undefined;
      host.resume = undefined;
      resolve();
    };
  });
  await host.pending;
};

const fund = (query: string): SymbolSearchResult & { quoteMode?: string } => ({
  symbol: `${query}.BO`,
  canonicalSymbol: query,
  canonicalExchangeMic: "XBOM",
  exchangeMic: "XBOM",
  exchange: "BSE",
  currency: "INR",
  quoteType: "MUTUALFUND",
  shortName: query,
  longName: `Fund ${query}`,
  providerId: "FAKE",
  providerSymbol: `${query}.BO`,
  index: "",
  score: 1,
  typeDisplay: "",
  quoteMode: host.pricingModes[query],
});

// Adds the invented folio to every read while the test sets host.sharedIsin.
const parse = CasParser.prototype.parse;
CasParser.prototype.parse = async function (this: CasParser, pdf: ArrayBuffer, password: string) {
  const data = await parse.call(this, pdf, password);
  data.parse_warnings.push(...host.parseWarnings);
  host.parsed++;
  if (!("folios" in data)) {
    if (host.statementDate) data.statement_period.to = host.statementDate;
    if (host.onlyNps || host.depositoryAccounts) return {
      ...data,
      accounts: host.depositoryAccounts ?? [],
      nps: host.onlyNps ? {
        pran: host.npsPran, nps_sp: "TCRA", value: "100",
        schemes: host.onlyNps.map(({ scheme, units }) => ({
          scheme, fund_manager: "TEST PENSION FUND LIMITED", tier: "I", asset_class: "E", units, nav: "25.5", value: String(Number(units) * 25.5),
        })),
      } : null,
    };
    const sold = (h: { isin: string }) => !host.soldIsins.includes(h.isin);
    const accounts = data.accounts.map((a) => ({ ...a, equities: a.equities.filter(sold), mutual_funds: a.mutual_funds.filter(sold), bonds: a.bonds.filter(sold) }));
    return { ...data, accounts };
  }
  if (data.cas_type === "SUMMARY" && host.summaryWithoutIsin.length) {
    data.folios = data.folios.map((f) => ({
      ...f, schemes: f.schemes.map((s) => (s.isin && host.summaryWithoutIsin.includes(s.isin) ? { ...s, isin: null } : s)),
    }));
  }
  if (host.ambiguousSummary && data.cas_type === "SUMMARY") {
    const [first, second, third, ...rest] = data.folios;
    return { ...data, folios: [{ ...first, schemes: [...first.schemes, ...third.schemes] }, second, ...rest] };
  }
  const [folio] = data.folios;
  const scheme = folio.schemes.find((s) => s.isin === host.sharedIsin);
  return scheme ? { ...data, folios: [...data.folios, { ...folio, folio: "91234568 / 34", schemes: [scheme] }] } : data;
};

const stored = (row: ActivityImport, i: number) =>
  ({
    ...row,
    id: `activity-${host.activities.length + i}`,
    date: `${row.date}T00:00:00+00:00`,
    assetSymbol: row.symbol ?? "",
    status: "POSTED",
    fee: null,
    comment: undefined,
  }) as unknown as ActivityDetails;

const account = (id: string, name: string, trackingMode: string) => ({ id, name, currency: "INR", isActive: true, isArchived: false, trackingMode });

// A saved snapshot the way `snapshots.getByDate` returns it.
const snapshotHoldings = (accountId: string, date: string) => {
  const { holdings, cash } = host.snapshots[accountId][date];
  return [
    ...holdings.map((h) => {
      const a = assetOf(assetId(h));
      const symbol = a.displayCode ?? h.symbol.toUpperCase();
      const quantity = Number(h.quantity);
      return {
        id: `${accountId}-${symbol}`,
        holdingType: "security",
        accountId,
        instrument: {
          id: assetId(h), symbol, name: a.name ?? h.name ?? `Fund ${symbol}`, currency: a.quoteCcy ?? "INR",
          exchangeMic: a.exchangeMic, pricingMode: host.pricingModes[a.symbol] ?? "MARKET",
        },
        quantity,
        localCurrency: h.currency,
        costBasis: { local: h.averageCost ? quantity * Number(h.averageCost) : 0, base: 0 },
      };
    }),
    ...Object.entries(cash).map(([currency, amount]) => ({ id: `CASH-${currency}`, holdingType: "cash", accountId, quantity: Number(amount), localCurrency: currency })),
  ];
};
const latest = (accountId: string) => Object.keys(host.snapshots[accountId] ?? {}).sort().pop();

// Wealthfolio stores provider equity labels, including MUTUALFUND and ETF, as EQUITY.
const instrumentType = (type: string | undefined) => /^(EQUITY|STOCK|ETF|MUTUALFUND|MUTUAL FUND|INDEX|ECNQUOTE)$/.test(type ?? "") ? "EQUITY" : type;
const assetId = (h: SnapshotHoldingInput) => h.assetId ?? Object.entries(host.assets).find(([, a]) =>
  a.symbol === h.symbol.toUpperCase() && a.exchangeMic === (h.exchangeMic ?? null) && (!h.instrumentType || instrumentType(a.instrumentType) === instrumentType(h.instrumentType)),
)?.[0] ?? host.assetIds[h.symbol.toUpperCase()] ?? `asset-${h.symbol.toUpperCase()}`;
const assetOf = (id: string): HostAsset => host.assets[id] ?? { symbol: id.replace(/^asset-/, "").toUpperCase(), exchangeMic: "XBOM" };

// Wealthfolio keeps assets after their last holding is removed; materialize implicit fixture assets.
const knownAssets = () => {
  for (const symbol of Object.values(host.held).flat()) {
    const id = `asset-${symbol}`;
    host.assets[id] ??= { symbol, exchangeMic: "XBOM", instrumentType: "EQUITY", name: `Fund ${symbol}` };
  }
  for (const h of Object.values(host.snapshots).flatMap((dates) => Object.values(dates).flatMap((s) => s.holdings))) {
    const id = assetId(h);
    host.assets[id] ??= { symbol: h.symbol.toUpperCase(), exchangeMic: h.exchangeMic ?? "XBOM", instrumentType: instrumentType(h.instrumentType) ?? "EQUITY", name: h.name ?? `Fund ${h.symbol.toUpperCase()}`, quoteCcy: h.quoteCcy };
  }
  return new Map(Object.entries(host.assets));
};
// Wealthfolio's `quote_id`. The snapshot save's own ID goes through `update_quote`, which replaces it with this one.
const manualId = (id: string, day: string) => `${id}_${day}_MANUAL`;

// One quote per asset, day and source, as Wealthfolio's quote store keeps them.
function saveQuote(quote: Quote) {
  const day = quote.timestamp.slice(0, 10);
  const before = (host.quotes[quote.assetId] ?? []).find((q) => q.timestamp.slice(0, 10) === day && q.dataSource === quote.dataSource);
  const quotes = (host.quotes[quote.assetId] ??= []).filter((q) => q.timestamp.slice(0, 10) !== day || q.dataSource !== quote.dataSource);
  host.quotes[quote.assetId] = [...quotes, { ...quote, id: before?.id ?? quote.id }];
}

const api = {
  accounts: {
    getAll: async (includeArchived = false) => [
      account("account-1", "Mutual funds", "TRANSACTIONS"),
      account("bank-1", "Savings", "TRANSACTIONS"),
      account("unset-1", "Not set", "NOT_SET"),
      account("holdings-1", "Demat", "HOLDINGS"),
      account("holdings-2", "Fund folios", "HOLDINGS"),
      { ...account("archived-1", "Archived funds", host.archiveOtherAccount ? "TRANSACTIONS" : "HOLDINGS"), isActive: false, isArchived: host.archiveOtherAccount },
    ].filter((a) => includeArchived || !a.isArchived),
  },
  portfolio: {
    getHoldings: async (accountId: string) => {
      if (accountId === "archived-1" && host.archiveOtherAccount) return [];
      const date = latest(accountId);
      if (date) return snapshotHoldings(accountId, date);
      return (host.held[accountId] ?? []).map((symbol) => ({
        holdingType: "security",
        instrument: { id: `asset-${symbol}`, symbol, exchangeMic: "XBOM", quoteMode: host.pricingModes[symbol] ?? "MARKET" },
        quantity: 10,
      }));
    },
  },
  snapshots: {
    getAll: async (accountId: string) =>
      [
        ...Object.entries(host.snapshots[accountId] ?? {}).map(([date, snapshot]) => ({ id: `${accountId}-${date}`, snapshotDate: date, source: snapshot.source ?? "MANUAL_ENTRY" })),
        ...["2025-03-15", "2099-12-31"].map((date) => ({
          id: `${accountId}-${date}`, snapshotDate: date,
          source: accountId === "archived-1" && host.archiveOtherAccount ? "MANUAL_ENTRY" : "CALCULATED",
        })),
      ],
    getByDate: async (accountId: string, date: string) => {
      const holdings = !(accountId === "archived-1" && host.archiveOtherAccount);
      const snapshot = host.snapshots[accountId]?.[date];
      const source = snapshot?.source ?? (snapshot || !holdings ? "MANUAL_ENTRY" : "CALCULATED");
      if (!snapshot || holdings === (source === "CALCULATED")) return [];
      return snapshotHoldings(accountId, date);
    },
    save: async (accountId: string, holdings: SnapshotHoldingInput[], cash: Record<string, string>, date: string) => {
      await wait("snapshot");
      host.saves.push({ accountId, date });
      for (const h of holdings) {
        const id = assetId(h);
        const symbol = h.symbol.toUpperCase();
        if (!h.assetId && !host.assets[id]) {
          host.assets[id] = { symbol, exchangeMic: h.exchangeMic ?? null, instrumentType: instrumentType(h.instrumentType), name: h.name, displayCode: symbol, kind: "INVESTMENT", quoteCcy: h.quoteCcy ?? "INR" };
        }
        if (h.dataSource === "MANUAL") host.pricingModes[symbol] = "MANUAL";
        if (host.pricingModes[symbol] === "MANUAL" && h.averageCost && Number(h.averageCost) !== 0) {
          const price = Number(h.averageCost);
          saveQuote({
            id: manualId(id, date), assetId: id, timestamp: `${date}T12:00:00Z`, createdAt: "",
            open: price, high: price, low: price, close: price, adjclose: price, volume: 0, currency: h.currency, dataSource: "MANUAL",
          });
        }
      }
      if (host.failSnapshotAccounts.includes(accountId)) throw new Error("Snapshot storage unavailable after writing quotes");
      (host.snapshots[accountId] ??= {})[date] = { holdings, cash };
    },
  },
  quotes: {
    update: async (id: string, quote: Quote) => {
      if (host.failQuoteIds.includes(id)) throw new Error("Quotes unavailable");
      const canonicalId = quote.dataSource === "MANUAL" ? manualId(id, quote.timestamp.slice(0, 10)) : quote.id;
      // Wealthfolio deletes the supplied ID before changing it to the canonical MANUAL ID.
      if (quote.id !== canonicalId) {
        for (const assetId of Object.keys(host.quotes)) host.quotes[assetId] = host.quotes[assetId].filter((q) => q.id !== quote.id);
      }
      saveQuote({ ...quote, id: canonicalId, assetId: id });
    },
    getHistory: async (id: string) => {
      const priority = (q: Quote) => q.dataSource === "MANUAL" ? 1 : q.dataSource === "BROKER" ? 3 : 2;
      const best = new Map<string, Quote>();
      for (const q of host.quotes[id] ?? []) {
        const day = q.timestamp.slice(0, 10);
        const old = best.get(day);
        if (!old || priority(q) < priority(old) || (priority(q) === priority(old) && q.timestamp > old.timestamp)) best.set(day, q);
      }
      return [...best.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },
  },
  assets: {
    getProfile: async (id: string) => {
      if (host.failGetProfileIds.includes(id)) throw new Error("Profile unavailable");
      const a = knownAssets().get(id);
      if (!a) throw new Error("Asset not found");
      return { id, ...a, instrumentSymbol: a.symbol, instrumentExchangeMic: a.exchangeMic, quoteMode: host.pricingModes[a.symbol] ?? "MARKET", kind: a.kind ?? "INVESTMENT", quoteCcy: a.quoteCcy ?? "INR" };
    },
    // Like Wealthfolio, fields left out are cleared and the pricing mode goes back to market.
    updateProfile: async (payload: { id: string; name?: string | null; displayCode?: string | null; notes: string; kind?: string; quoteMode?: string; quoteCcy?: string; instrumentExchangeMic?: string | null; providerConfig?: unknown; metadata?: unknown }) => {
      if (typeof payload.notes !== "string") throw new Error("missing field `notes`");
      if (host.failProfileIds.includes(payload.id)) throw new Error("Profile unavailable");
      const a = assetOf(payload.id);
      // The service refreshes a market equity's currency from its venue when the MIC is omitted.
      const refreshCcy = payload.quoteMode === "MARKET" && !payload.quoteCcy && !payload.instrumentExchangeMic && a.exchangeMic && a.instrumentType === "EQUITY";
      host.assets[payload.id] = {
        ...a, name: payload.name ?? null, displayCode: payload.displayCode ?? null, notes: payload.notes,
        kind: payload.kind ?? a.kind, providerConfig: payload.providerConfig ?? null, metadata: payload.metadata ?? a.metadata,
        quoteCcy: payload.quoteCcy ?? (refreshCcy ? (a.exchangeMic === "XLON" ? "GBP" : "INR") : a.quoteCcy),
      };
      host.pricingModes[a.symbol] = payload.quoteMode ?? "MARKET";
      return host.assets[payload.id];
    },
  },
  activities: {
    getAll: async (accountId?: string) => {
      if (host.failHistory) throw new Error("History unavailable");
      return host.activities.filter((a) => accountId === undefined || a.accountId === accountId);
    },
    checkImport: async (rows: ActivityImport[]) => {
      await wait("check");
      return rows.map((row) => ({ ...row, isValid: true }));
    },
    import: async (rows: ActivityImport[]) => {
      await wait("import");
      const skipped = (r: ActivityImport) => r.lineNumber === host.skipLine && !r.forceImport;
      const accepted = rows.filter((r) => r.lineNumber !== host.rejectLine && !skipped(r));
      host.activities.push(...accepted.map(stored));
      const total = rows.length;
      const summary = { total, imported: accepted.length, skipped: total - accepted.length, duplicates: rows.filter(skipped).length, assetsCreated: 0, success: true };
      return {
        activities: rows.map((r) => r.lineNumber === host.rejectLine
          ? { ...r, errors: { symbol: ["The fund could not be created."] } }
          : skipped(r) ? { ...r, duplicateOfId: "earlier-trade" } : r),
        importRunId: "run", summary,
      };
    },
    create: async (activity: ActivityCreate) => {
      const row = stored({ ...activity, date: String(activity.activityDate), symbol: "" } as unknown as ActivityImport, 0);
      host.activities.push(row);
      return row;
    },
    // Only what the add-on changes.
    update: async (activity: ActivityUpdate) => {
      const row = host.activities.find((a) => a.id === activity.id)!;
      Object.assign(row, { activityType: activity.activityType, comment: activity.comment ?? undefined });
      return row;
    },
    getTransferPair: async (id: string) => (host.linked.includes(id) ? {} : null),
    linkTransfer: async (a: string, b: string) => {
      host.links.push([a, b]);
      host.linked.push(a, b);
      return [];
    },
  },
  market: { searchTicker: async (query: string) => {
    host.searches.push(query);
    await wait("market");
    await wait(query);
    if (query === "FAIL" || host.failSearchQueries.includes(query)) throw new Error("Search unavailable");
    if (host.emptySearchQueries.includes(query)) return [];
    // Existing assets are returned even when no account currently holds them.
    const existing = [...knownAssets()].filter(([, a]) =>
      [a.symbol, a.displayCode, a.name].some((s) => s?.toUpperCase().includes(query.toUpperCase())),
    ).map(([id, a]) => ({
      ...fund(a.symbol), symbol: a.displayCode ?? a.symbol, canonicalSymbol: a.symbol,
      canonicalExchangeMic: a.exchangeMic ?? undefined, exchangeMic: a.exchangeMic ?? undefined,
      quoteType: instrumentType(a.instrumentType) ?? "OTHER", currency: a.quoteCcy ?? "INR", longName: a.name ?? a.symbol,
      quoteMode: host.pricingModes[a.symbol] ?? "MARKET", isExisting: true, existingAssetId: id,
    }));
    if (existing.length) return existing;
    // Like Yahoo, no NPS schemes and few Indian bonds. One bond is listed under its ISIN.
    if (query === "INEZ93A08016") return [{ ...fund(query), canonicalExchangeMic: undefined, exchangeMic: undefined, quoteType: "BOND", longName: "Democorp Infra 7.60% 2033" }];
    if (/^INE\w{4}0[78]\d{3}$/.test(query) || /\b(NCD|BD)\b/.test(query) || query.startsWith("NPS TRUST")) return [];
    // Like Yahoo with some funds, the Corporate Bond fund is listed under neither its ISIN nor its
    // full scheme name.
    if (query === "INFZ91T01CB6" || query.includes(" - ")) return [];
    if (query === "Testbridge Corporate Bond Fund") return [fund("0P0000TBCB")];
    // The Overnight fund has no ISIN on the statement.
    if (query === "Testbridge Overnight Fund") return [fund("0P0000TONF")];
    return query === "MULTI" ? [fund("A"), fund("B")] : [fund(query)];
  } },
  storage: {
    get: async (key: string) => {
      await wait("storage");
      return host.storage.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      await wait("set");
      await wait(`set:${value}`);
      host.storage.set(key, value);
    },
    delete: async (key: string) => {
      await wait("delete");
      if (host.failDelete) throw new Error("Storage unavailable");
      host.storage.delete(key);
    },
  },
  secrets: {
    get: async (key: string) => {
      await wait("password");
      return host.secrets.get(key) ?? null;
    },
    set: async (key: string, value: string) => void host.secrets.set(key, value),
    delete: async (key: string) => void host.secrets.delete(key),
  },
  toast: { success() {}, error: (message: string) => void host.toasts.push(message), warning() {}, info() {} },
  logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
  query: { invalidateQueries() {}, refetchQueries() {} },
};

window.addEventListener("message", async ({ data }) => {
  const assets = {
    getBlob: async (path: string) => data.files[path] ?? Promise.reject(new Error(`Not packaged: ${path}`)),
  } as unknown as AddonAssets;
  const result: Record<string, unknown> = {};
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    maxGap = Math.max(maxGap, performance.now() - last);
    last = performance.now();
  }, 20);
  const start = performance.now();
  const parser = new CasParser(assets);
  try {
    try {
      await parser.parse(await data.pdf.arrayBuffer(), "WRONGPASS1");
      result.wrongPassword = "parsed";
    } catch (error) {
      result.wrongPassword = error instanceof CasError ? error.kind : String(error);
    }
    result.startMs = Math.round(performance.now() - start);
    const parseStart = performance.now();
    result.data = await parser.parse(await data.pdf.arrayBuffer(), data.password);
    result.parseMs = Math.round(performance.now() - parseStart);
  } catch (error) {
    result.error = String(error);
  }
  clearInterval(timer);
  result.maxFrameGapMs = Math.round(maxGap);
  parser.dispose();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const ctx = { assets, api } as unknown as AddonContext;
  let opens = 0;
  host.reopen = () => flushSync(() => root.render(createElement(ImportPage, { ctx, key: opens++ })));
  host.reopen();
  parent.postMessage({ result }, "*");
});
parent.postMessage({ ready: true }, "*");
