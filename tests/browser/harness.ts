// Runs inside the sandboxed iframe that tests/browser/sandbox.mjs builds. The page posts the
// packaged files as Blobs; this stands in for ctx.assets and drives the real CasParser, then
// mounts the import page on a fake host: an account tracking transactions and two tracking
// holdings, in-memory storage, secrets and snapshots, a fund search, recorded error toasts, and
// an import that stores rows the way Wealthfolio returns them. Wealthfolio's own checks are left
// to the end-to-end run in the pull request.
import type {
  ActivityDetails,
  ActivityImport,
  AddonAssets,
  AddonContext,
  SnapshotHoldingInput,
  SymbolSearchResult,
} from "@wealthfolio/addon-sdk";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CasError, CasParser } from "../../src/cas/parser";
import { ImportPage } from "../../src/pages/import-page";

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
  // An invented second folio holding the fund with this ISIN, added to what the parser reads.
  sharedIsin: "",
  // Holdings dropped from a depository statement as if they had been sold.
  soldIsins: [] as string[],
  parseWarnings: [] as string[],
  onlyNps: false,
  ambiguousSummary: false,
  archiveOtherAccount: false,
  reopen: () => {},
  // Asset pricing mode belongs to the asset, independently of any account or snapshot.
  pricingModes: {} as Record<string, string>,
  // Each account's snapshots by date, as saved.
  snapshots: {} as Record<string, Record<string, { holdings: SnapshotHoldingInput[]; cash: Record<string, string>; source?: string }>>,
  saves: [] as { accountId: string; date: string }[],
  // What accounts that track transactions hold, by symbol on XBOM.
  held: {} as Record<string, string[]>,
  parsed: 0,
  toasts: [] as string[],
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
    if (host.onlyNps) return {
      ...data,
      accounts: [],
      nps: {
        pran: null, nps_sp: null, value: "100",
        schemes: [{ scheme: "Test NPS Scheme", fund_manager: "Test manager", tier: "Tier I", asset_class: "E", units: "1", nav: "100", value: "100" }],
      },
    };
    const sold = (h: { isin: string }) => !host.soldIsins.includes(h.isin);
    const accounts = data.accounts.map((a) => ({ ...a, equities: a.equities.filter(sold), mutual_funds: a.mutual_funds.filter(sold) }));
    return { ...data, accounts };
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
      const symbol = h.symbol.toUpperCase();
      const quantity = Number(h.quantity);
      return {
        id: `${accountId}-${symbol}`,
        holdingType: "security",
        accountId,
        instrument: { id: h.assetId ?? `asset-${symbol}`, symbol, name: h.name ?? `Fund ${symbol}`, currency: "INR", exchangeMic: h.exchangeMic ?? "XBOM", pricingMode: host.pricingModes[symbol] ?? "MARKET" },
        quantity,
        localCurrency: h.currency,
        costBasis: { local: h.averageCost ? quantity * Number(h.averageCost) : 0, base: 0 },
      };
    }),
    ...Object.entries(cash).map(([currency, amount]) => ({ id: `CASH-${currency}`, holdingType: "cash", accountId, quantity: Number(amount), localCurrency: currency })),
  ];
};
const latest = (accountId: string) => Object.keys(host.snapshots[accountId] ?? {}).sort().pop();

const api = {
  accounts: {
    getAll: async (includeArchived = false) => [
      account("account-1", "Mutual funds", "TRANSACTIONS"),
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
      (host.snapshots[accountId] ??= {})[date] = { holdings, cash };
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
      const accepted = rows.filter((r) => r.lineNumber !== host.rejectLine);
      host.activities.push(...accepted.map(stored));
      const total = rows.length;
      const summary = { total, imported: accepted.length, skipped: total - accepted.length, duplicates: 0, assetsCreated: 0, success: true };
      return {
        activities: rows.map((r) => r.lineNumber === host.rejectLine ? { ...r, errors: { symbol: ["The fund could not be created."] } } : r),
        importRunId: "run", summary,
      };
    },
  },
  market: { searchTicker: async (query: string) => {
    host.searches.push(query);
    await wait("market");
    await wait(query);
    if (query === "FAIL") throw new Error("Search unavailable");
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
