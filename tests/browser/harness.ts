// Runs inside the sandboxed iframe that tests/browser/sandbox.mjs builds. The page posts the
// packaged files as Blobs; this stands in for ctx.assets and drives the real CasParser, then
// mounts the import page on a fake host: one account, in-memory storage and secrets, a fund
// search, recorded error toasts, and an import that stores rows the way Wealthfolio
// returns them. Wealthfolio's own checks are left to the end-to-end run in the pull request.
import type { ActivityDetails, ActivityImport, AddonAssets, AddonContext, SymbolSearchResult } from "@wealthfolio/addon-sdk";
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

const fund = (query: string): SymbolSearchResult => ({
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
});

// Adds the invented folio to every read while the test sets host.sharedIsin.
const parse = CasParser.prototype.parse;
CasParser.prototype.parse = async function (this: CasParser, pdf: ArrayBuffer, password: string) {
  const data = await parse.call(this, pdf, password);
  host.parsed++;
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

const api = {
  accounts: {
    getAll: async () => [{ id: "account-1", name: "Mutual funds", currency: "INR", isActive: true, isArchived: false }],
  },
  activities: {
    getAll: async (accountId: string) => {
      if (host.failHistory) throw new Error("History unavailable");
      return host.activities.filter((a) => a.accountId === accountId);
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
  flushSync(() => root.render(createElement(ImportPage, { ctx })));
  parent.postMessage({ result }, "*");
});
parent.postMessage({ ready: true }, "*");
