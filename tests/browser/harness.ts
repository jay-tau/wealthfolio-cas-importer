// Runs inside the sandboxed iframe that tests/browser/sandbox.mjs builds. The page posts the
// packaged files as Blobs; this stands in for ctx.assets and drives the real CasParser, then
// mounts the import page on a fake host: accounts tracking transactions or holdings, some of them
// hidden or archived, in-memory storage, secrets and snapshots, a fund search, recorded error toasts, and
// an import that stores rows the way Wealthfolio returns them. Snapshot saves write a manual
// asset's average cost as its quote for the day, and profile updates store every field as sent,
// both as Wealthfolio does. The parser's Workers can be made to stall or stop. Wealthfolio's own
// checks are left to the end-to-end run in the pull request.
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
import type { CasData, CasScheme, DematAccount } from "../../src/cas/types";
// The sandbox can't fetch, so the bundle carries it.
import segregatedStatement from "../fixtures/made-up-cas-segregated.json";

interface HostAsset {
  symbol: string;
  instrumentSymbol?: string | null;
  exchangeMic: string | null;
  instrumentType?: string;
  name?: string | null;
  notes?: string | null;
  displayCode?: string | null;
  kind?: string;
  quoteCcy?: string;
  providerConfig?: unknown;
  metadata?: unknown;
  /** AMFI for a fund with AMFI selected, even if automatic updates are off. */
  providerId?: string;
}

type WorkerFault = "" | "no-ready" | "no-reply" | "stop" | "fatal";

const account = (id: string, name: string, trackingMode: string) => ({ id, name, currency: "INR", isActive: true, isArchived: false, trackingMode });

const host = {
  // Wealthfolio's accounts. The add-on sees a change on its next read.
  accounts: [
    account("account-1", "Mutual funds", "TRANSACTIONS"),
    account("bank-1", "Savings", "TRANSACTIONS"),
    account("unset-1", "Not set", "NOT_SET"),
    account("holdings-1", "Demat", "HOLDINGS"),
    account("holdings-2", "Fund folios", "HOLDINGS"),
    { ...account("archived-1", "Archived funds", "HOLDINGS"), isActive: false },
    { ...account("hidden-1", "Hidden funds", "TRANSACTIONS"), isActive: false },
    { ...account("archived-2", "Old funds", "TRANSACTIONS"), isArchived: true },
    { ...account("hidden-2", "Hidden demat", "HOLDINGS"), isActive: false },
    { ...account("archived-3", "Old demat", "HOLDINGS"), isActive: false, isArchived: true },
  ],
  failAccounts: false,
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  activities: [] as ActivityDetails[],
  searches: [] as string[],
  pause: "password",
  pending: undefined as Promise<void> | undefined,
  resume: undefined as (() => void) | undefined,
  failHistory: false,
  failDelete: false,
  failImport: false,
  rejectLine: undefined as number | undefined,
  skipLine: undefined as number | undefined,
  // An invented second folio holding the fund with this ISIN, added to what the parser reads.
  sharedIsin: "",
  // A detailed statement's folio printed without a PAN.
  noPanFolio: "",
  // An invented fund house merger in the first folio, added to what the parser reads.
  merger: false,
  // Invented gifts: one received in the first folio, and one between two new folios of the same fund house.
  gifts: false,
  // The made-up statement's segregated portfolio and its main fund, in a folio of their own; "later"
  // as a statement starting after the credit would list them.
  segregated: false as boolean | "later",
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
  // Summary statements print these funds' units as "N.A.", which the parser reads as 0.
  summaryMisread: [] as string[],
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
  // AMFI added in Wealthfolio's Settings → Market data. Off until a test adds it, as in a new profile.
  amfi: false,
  failGetProfileIds: [] as string[],
  failProfileIds: [] as string[],
  failSnapshotAccounts: [] as string[],
  // Each account's snapshots by date, as saved.
  snapshots: {} as Record<string, Record<string, { holdings: SnapshotHoldingInput[]; cash: Record<string, string>; source?: string }>>,
  saves: [] as { accountId: string; date: string }[],
  // What accounts that track transactions hold, by symbol on XBOM.
  held: {} as Record<string, string[]>,
  parsed: 0,
  // Workers started, one per parser. While a fault is set, each Worker never gets Python's files,
  // never gets a PDF, stops when given one, or answers it with a fatal Python error.
  workers: 0,
  workerFault: "" as WorkerFault,
  // Sets the fault, with limits short enough for a test on the waits that never end.
  breakWorkers: (_fault: WorkerFault) => {},
  toasts: [] as string[],
  // Transfers already in a pair, and the pairs the add-on linked.
  linked: [] as string[],
  links: [] as [string, string][],
  // Wealthfolio's timezone setting. Rows the add-on imports are stored at UTC midnight, on their day there too.
  timezone: "Asia/Kolkata",
  failSettings: false,
};
declare global {
  interface Window {
    host: typeof host;
  }
}
window.host = host;

window.Worker = class extends Worker {
  constructor(...args: ConstructorParameters<typeof Worker>) {
    super(...args);
    host.workers++;
  }

  postMessage(message: { type: string; id?: number }, options?: StructuredSerializeOptions | Transferable[]) {
    const fault = host.workerFault;
    if ((fault === "no-ready" && message.type === "boot") || (fault === "no-reply" && message.type === "parse")) return;
    // The parser terminates the Worker itself; WebKit drops a terminated Worker's listeners.
    if (fault === "stop" && message.type === "parse") {
      setTimeout(() => this.dispatchEvent(new ErrorEvent("error", { message: "Stopped by the test", cancelable: true })));
      return;
    }
    if (fault === "fatal" && message.type === "parse") {
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, fatal: true } })));
      return;
    }
    super.postMessage(message, options as StructuredSerializeOptions);
  }
};
const limits = { start: CasParser.startTimeoutMs, parse: CasParser.parseTimeoutMs };
host.breakWorkers = (fault) => {
  host.workerFault = fault;
  CasParser.startTimeoutMs = fault === "no-ready" ? 500 : limits.start;
  CasParser.parseTimeoutMs = fault === "no-reply" ? 500 : limits.parse;
};

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

// Made-up results for the plan and option badges, for searches the tests type. Beside the Flexi Cap
// fund, printed as "Direct Plan - Growth": a match spelled another way, a mismatch in both, and names
// without an option, without either, or without a plan. Beside the Small Cap fund, printed with
// either field missing: a result with both, and one with another plan and option.
const planResults = new Map([
  ["Fictiva Flexi Cap", [
    "Fictiva Flexi Cap Fund DIRECT PLAN GROWTH",
    "Fictiva Flexi Cap Fund Reg IDCW",
    "Fictiva Flexi Cap Fund Dir",
    "Fictiva Flexi Cap Fund",
    "Fictiva Flexi Cap Fund Gr",
  ]],
  ["Pretend Small Cap", ["Pretend Small Cap Fund Dir Gr", "Pretend Small Cap Fund - Regular Plan - IDCW Payout"]],
]);

// AMFI's scheme for a fund's ISIN or scheme code, the way Wealthfolio 3.12.0 lists it: no exchange,
// the scheme code as its symbol.
// shortcut: synthetic codes cover these fixtures; use an explicit map if a fixture collides.
const amfiCode = (isin: string) => String(100000 + (parseInt(isin.slice(3), 36) % 900000));
const amfiScheme = (code: string): SymbolSearchResult & { quoteMode?: string } => ({
  ...fund(code),
  symbol: code,
  canonicalSymbol: code,
  canonicalExchangeMic: undefined,
  exchangeMic: undefined,
  exchange: "AMFI",
  providerId: "AMFI",
  providerSymbol: code,
  dataSource: "AMFI",
  score: 0,
  longName: `Scheme ${code}`,
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
  if (data.cas_type === "SUMMARY" && host.summaryMisread.length) {
    data.folios = data.folios.map((f) => ({
      ...f, schemes: f.schemes.map((s) => (s.isin && host.summaryMisread.includes(s.isin) ? { ...s, close: "0" } : s)),
    }));
  }
  if (host.ambiguousSummary && data.cas_type === "SUMMARY") {
    const [first, second, third, ...rest] = data.folios;
    return { ...data, folios: [{ ...first, schemes: [...first.schemes, ...third.schemes] }, second, ...rest] };
  }
  if (host.noPanFolio) data.folios = data.folios.map((f) => (f.folio === host.noPanFolio ? { ...f, PAN: null } : f));
  if (host.merger) data.folios[0].schemes.push(...mergedSchemes());
  if (host.gifts) {
    const [first] = data.folios;
    const [received, given, taken] = giftedSchemes();
    data.folios = [
      { ...first, schemes: [...first.schemes, received] },
      ...data.folios.slice(1),
      { ...first, folio: "92345678", schemes: [given] },
      { ...first, folio: "93456789", schemes: [taken] },
    ];
  }
  if (host.segregated) {
    const [folio] = structuredClone(segregatedStatement as CasData).folios;
    if (host.segregated === "later") {
      const segregated = folio.schemes[1];
      segregated.transactions = segregated.transactions.filter((row) => row.type !== "SEGREGATION");
      segregated.open = "3067.481";
    }
    data.folios = [...data.folios, folio];
  }
  const [folio] = data.folios;
  const scheme = folio.schemes.find((s) => s.isin === host.sharedIsin);
  return scheme ? { ...data, folios: [...data.folios, { ...folio, folio: "91234568 / 34", schemes: [scheme] }] } : data;
};

/** A fund bought once and merged into another, in casparser's form. */
function mergedSchemes() {
  const row = (date: string, type: string, amount: string | null, units: string | null, nav: string | null, balance: string | null) =>
    ({ date, description: type, amount, units, nav, balance, type, dividend_rate: null, gift_folio: null }) as const;
  const scheme = (code: string, name: string, isin: string, close: string, transactions: ReturnType<typeof row>[]) => ({
    scheme: name, advisor: "DIRECT", rta_code: code, rta: "CAMS", type: "EQUITY", isin, amfi: null, nominees: [],
    open: "0", close, close_calculated: close, valuation: { date: "2025-03-31", nav: "21", cost: null, value: "0" }, transactions,
  });
  return [
    scheme("FOFDG", "Fictiva Old Fund - Direct Plan - Growth", "INFZ90K01OF7", "0.000", [
      row("2024-05-10", "PURCHASE", "1000.00", "99.995", "10.0000", "99.995"),
      row("2024-05-10", "STAMP_DUTY_TAX", "0.05", null, null, null),
      row("2024-08-01", "SWITCH_OUT_MERGER", "-1399.93", "-99.995", "14.0000", "0.000"),
    ]),
    scheme("FNFDG", "Fictiva New Fund - Direct Plan - Growth", "INFZ90K01NF5", "69.996", [
      row("2024-08-01", "SWITCH_IN_MERGER", "1399.93", "69.996", "20.0000", "69.996"),
    ]),
  ] as unknown as CasScheme[];
}

/** Gifts in casparser's form: one from a folio the statement doesn't include, and both sides of another. */
function giftedSchemes() {
  const row = (date: string, type: string, amount: string, units: string, nav: string, balance: string, description = type, gift_folio: string | null = null) =>
    ({ date, description, amount, units, nav, balance, type, dividend_rate: null, gift_folio }) as const;
  const scheme = (code: string, name: string, isin: string, close: string, transactions: ReturnType<typeof row>[]) => ({
    scheme: name, advisor: "DIRECT", rta_code: code, rta: "CAMS", type: "EQUITY", isin, amfi: null, nominees: [],
    open: "0", close, close_calculated: close, valuation: { date: "2025-03-31", nav: "26", cost: null, value: "0" }, transactions,
  });
  return [
    scheme("FGFDG", "Fictiva Gifted Fund - Direct Plan - Growth", "INFZ90K01GF3", "10.000", [
      row("2024-06-04", "GIFT_IN", "250.00", "10.000", "25.0000", "10.000", "Gifting of units - From Folio No.70000001", "70000001"),
    ]),
    scheme("FSFDG", "Fictiva Shared Fund - Direct Plan - Growth", "INFZ90K01SF6", "30.000", [
      row("2024-05-10", "PURCHASE", "1000.00", "50.000", "20.0000", "50.000"),
      row("2024-06-03", "GIFT_OUT", "-500.00", "-20.000", "25.0000", "30.000", "Gifting of units-TO Folio No: 93456789", "93456789"),
    ]),
    scheme("FSFDG", "Fictiva Shared Fund - Direct Plan - Growth", "INFZ90K01SF6", "20.000", [
      row("2024-06-03", "GIFT_IN", "500.00", "20.000", "25.0000", "20.000", "Gifting of units - From Folio No.92345678", "92345678"),
    ]),
  ] as unknown as CasScheme[];
}

const stored = (row: ActivityImport, i: number) =>
  ({
    ...row,
    id: `activity-${host.activities.length + i}`,
    date: `${row.date}T00:00:00+00:00`,
    // Wealthfolio finds or creates the row's asset by its symbol and exchange.
    assetId: row.symbol ? assetId({ symbol: row.symbol, exchangeMic: row.exchangeMic, instrumentType: row.instrumentType } as SnapshotHoldingInput) : "",
    assetSymbol: row.symbol ?? "",
    status: "POSTED",
    fee: null,
    comment: undefined,
  }) as unknown as ActivityDetails;

// Archived funds once a test archives it, when it tracks transactions: no holdings, and only its
// calculated snapshots count.
const archivedOther = (accountId: string) => accountId === "archived-1" && host.accounts.some((a) => a.id === accountId && a.isArchived);

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
const assetOf = (id: string): HostAsset => host.assets[id] ?? { symbol: id.replace(/^asset-/, "").toUpperCase(), exchangeMic: "XBOM", instrumentType: "EQUITY" };

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
    // Copies, so a later change doesn't reach what the add-on read.
    getAll: async (includeArchived = false) => {
      if (host.failAccounts) throw new Error("Accounts unavailable");
      return host.accounts.filter((a) => includeArchived || !a.isArchived).map((a) => ({ ...a }));
    },
  },
  portfolio: {
    getHoldings: async (accountId: string) => {
      await wait("holdings");
      if (archivedOther(accountId)) return [];
      const date = latest(accountId);
      if (date) return snapshotHoldings(accountId, date);
      return (host.held[accountId] ?? []).map((symbol) => ({
        holdingType: "security",
        instrument: { id: `asset-${symbol}`, symbol: host.assets[`asset-${symbol}`]?.displayCode ?? symbol, exchangeMic: "XBOM", quoteMode: host.pricingModes[symbol] ?? "MARKET" },
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
          source: archivedOther(accountId) ? "MANUAL_ENTRY" : "CALCULATED",
        })),
      ],
    getByDate: async (accountId: string, date: string) => {
      const holdings = !archivedOther(accountId);
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
          host.assets[id] = { symbol, exchangeMic: h.exchangeMic ?? null, instrumentType: instrumentType(h.instrumentType), name: h.name, displayCode: symbol, kind: "INVESTMENT", quoteCcy: h.quoteCcy ?? "INR", providerId: h.providerId };
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
      // An activity's asset exists too, whether or not a holding lists it.
      const a = knownAssets().get(id) ?? (host.activities.some((x) => x.assetId === id) ? assetOf(id) : undefined);
      if (!a) throw new Error("Asset not found");
      return { id, ...a, instrumentSymbol: a.instrumentSymbol !== undefined ? a.instrumentSymbol : a.symbol, instrumentExchangeMic: a.exchangeMic, quoteMode: host.pricingModes[a.symbol] ?? "MARKET", kind: a.kind ?? "INVESTMENT", quoteCcy: a.quoteCcy ?? "INR" };
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
      await wait("history");
      if (host.failHistory) throw new Error("History unavailable");
      return host.activities.filter((a) => accountId === undefined || a.accountId === accountId);
    },
    checkImport: async (rows: ActivityImport[]) => {
      await wait("check");
      // Like Wealthfolio, a trade in a new fund with no exchange needs pricing by hand: so is one
      // from AMFI, whose import creates the fund.
      const known = (symbol: string) => [...knownAssets().values()].some((a) => a.symbol === symbol.toUpperCase() && a.exchangeMic === null);
      return rows.map((row) => row.symbol && !row.exchangeMic && row.quoteMode !== "MANUAL" && !known(row.symbol)
        ? { ...row, isValid: false, errors: { symbol: [`Could not find '${row.symbol}' in market data. Please search for the correct ticker symbol.`] } }
        : { ...row, isValid: true });
    },
    import: async (rows: ActivityImport[]) => {
      await wait("import");
      if (host.failImport) throw new Error("Import unavailable");
      const skipped = (r: ActivityImport) => r.lineNumber === host.skipLine && !r.forceImport;
      const accepted = rows.filter((r) => r.lineNumber !== host.rejectLine && !skipped(r));
      // The import creates a new fund with no exchange as it is.
      for (const r of accepted) {
        if (r.symbol && !r.exchangeMic) {
          host.assets[`asset-${r.symbol.toUpperCase()}`] ??= { symbol: r.symbol.toUpperCase(), exchangeMic: null, instrumentType: instrumentType(r.instrumentType), name: r.symbolName, quoteCcy: r.quoteCcy, providerId: r.providerId };
        }
      }
      const added = accepted.map(stored);
      // Like Wealthfolio's import, link a fund's transfer in with the first unused transfer out of the
      // same day, symbol and value in another account, and group them. Cash transfers' links are `linked`.
      const value = (a: ActivityDetails) => `${a.date}|${a.currency}|${a.assetSymbol}|${Number(a.quantity) * Number(a.unitPrice)}`;
      const outs = added.filter((a) => a.activityType === "TRANSFER_OUT" && a.assetSymbol);
      for (const into of added.filter((a) => a.activityType === "TRANSFER_IN" && a.assetSymbol)) {
        const out = outs.find((o) => !(o as { sourceGroupId?: string }).sourceGroupId && o.accountId !== into.accountId && value(o) === value(into));
        if (out) for (const leg of [into, out]) Object.assign(leg, { sourceGroupId: `link-${into.id}` });
      }
      host.activities.push(...added);
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
    const named = planResults.get(query);
    if (named) {
      return named.map((longName, i) => ({ ...fund(`${query.replace(/\W/g, "").toUpperCase()}${i + 1}`), longName }));
    }
    // A made-up bank's ADR in New York, quoted in dollars, then its share in Mumbai, in rupees.
    if (query === "Democorp Bank") {
      return [
        { ...fund("DMCB"), symbol: "DMCB", canonicalExchangeMic: "XNYS", exchangeMic: "XNYS", exchange: "NYSE", currency: "USD", quoteType: "EQUITY", longName: "Democorp Bank ADR", providerSymbol: "DMCB" },
        { ...fund("DEMOCORPBK"), symbol: "DEMOCORPBK.NS", canonicalExchangeMic: "XNSE", exchangeMic: "XNSE", exchange: "NSE", quoteType: "EQUITY", longName: "Democorp Bank Ltd", providerSymbol: "DEMOCORPBK.NS" },
      ];
    }
    if (host.emptySearchQueries.includes(query)) return [];
    // AMFI finds a fund's exact ISIN or scheme code, listed after Yahoo's results.
    const amfi = host.amfi && /^(INF\w{9}|\d{6})$/.test(query) ? [amfiScheme(/^\d/.test(query) ? query : amfiCode(query))] : [];
    // Existing assets are returned even when no account currently holds them.
    const existing = [...knownAssets()].filter(([, a]) =>
      [a.symbol, a.displayCode, a.name].some((s) => s?.toUpperCase().includes(query.toUpperCase())) ||
      amfi.some((r) => a.symbol === r.symbol && a.exchangeMic === null && instrumentType(a.instrumentType) === "EQUITY"),
    ).map(([id, a]) => ({
      ...fund(a.symbol), symbol: a.displayCode ?? a.symbol, canonicalSymbol: a.symbol,
      canonicalExchangeMic: a.exchangeMic ?? undefined, exchangeMic: a.exchangeMic ?? undefined,
      quoteType: instrumentType(a.instrumentType) ?? "OTHER", currency: a.quoteCcy ?? "INR", longName: a.name ?? a.symbol,
      quoteMode: host.pricingModes[a.symbol] ?? "MARKET", isExisting: true, existingAssetId: id, providerId: a.providerId, providerSymbol: undefined,
    }));
    // Replace a provider result with its existing asset, keeping Yahoo's other listing for an ISIN.
    if (existing.length) {
      const schemes = amfi.filter((r) => !existing.some((e) => e.canonicalSymbol === r.symbol && !e.exchangeMic));
      return [...existing, ...(amfi.length && /^INF/.test(query) && existing.some((e) => !e.exchangeMic) ? [fund(query)] : []), ...schemes];
    }
    // Like Yahoo, no NPS schemes and few Indian bonds. One bond is listed under its ISIN.
    if (query === "INEZ93A08016") return [{ ...fund(query), canonicalExchangeMic: undefined, exchangeMic: undefined, quoteType: "BOND", longName: "Democorp Infra 7.60% 2033" }];
    if (/^INE\w{4}0[78]\d{3}$/.test(query) || /\b(NCD|BD)\b/.test(query) || query.startsWith("NPS TRUST")) return [];
    // Like Yahoo with some funds, the Corporate Bond fund is listed under neither its ISIN nor its
    // full scheme name.
    if (query === "INFZ91T01CB6" || query.includes(" - ")) return amfi;
    if (query === "Testbridge Corporate Bond Fund") return [fund("0P0000TBCB")];
    // The Overnight fund has no ISIN on the statement.
    if (query === "Testbridge Overnight Fund") return [fund("0P0000TONF")];
    return query === "MULTI" ? [fund("A"), fund("B")] : [fund(query), ...amfi];
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
  settings: {
    get: async () => {
      if (host.failSettings) throw new Error("Settings unavailable");
      return { timezone: host.timezone };
    },
  },
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
