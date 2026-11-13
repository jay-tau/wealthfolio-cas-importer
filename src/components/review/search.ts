import type { AddonContext, SymbolSearchResult } from "@wealthfolio/addon-sdk";
import { useEffect, useRef, useState } from "react";
import { isStatementAsset } from "../../cas/holdings";
import { certain, fromAmfi, pricedElsewhere } from "../../lib/amfi";
import type { ChosenFund } from "../../lib/choices";
import { listingName } from "../../lib/fund-label";
import { differs, fundName, fundQuery, planAndOption } from "../../lib/fund-name";
import { instrumentType } from "../../lib/instrument-type";
import { type FundItem, toFund } from "../fund-choices";

/** A search's state: running, failed, or its results as the choices they'd make. */
export type Search =
  | { status: "searching" }
  | { status: "failed"; error: string }
  | {
      status: "done";
      results: ChosenFund[];
      /** A result is AMFI's, or a saved asset priced from AMFI. */
      amfi: boolean;
      /** Wealthfolio already has the fund among them, priced from another source than AMFI. */
      pricedElsewhere: boolean;
    };

/** The search the Review screen runs by itself: the printed ISIN, then the name when that finds nothing. */
export type AutoSearch = Search & {
  /** The name searched, when the ISIN found nothing or none is printed. */
  byName?: string;
};

export interface ItemSearch {
  auto?: AutoSearch;
  /** The latest search typed in, with what was searched. */
  typed?: Search & { text: string };
  /** What the search box holds. */
  text: string;
  /** The result picked and not yet used: "auto:1", "typed:0". */
  picked?: string;
}

const empty: ItemSearch = { text: "" };

/** The statement's plan and option for a fund; shares, bonds and NPS schemes have none. */
export const statementPlan = (item: FundItem) => (item.noun === "fund" ? planAndOption(item.name, item.cut) : undefined);

/**
 * A search result as the holding's choice: its own asset priced from statements is that, however
 * it's found, so it keeps the statement's name and details.
 */
export function choiceFor(item: FundItem, result: SymbolSearchResult): ChosenFund {
  const own = item.statementAsset;
  return own && isStatementAsset(result, own.symbol) && instrumentType(result.quoteType) === instrumentType(own.instrumentType) &&
    (result.currency || "INR") === own.quoteCcy
    ? own
    : toFund(result);
}

/** The results on screen, auto first, as `[id, fund]`; a running or failed search has none. */
export function shown(search: ItemSearch) {
  const list: [string, ChosenFund][] = [];
  if (search.auto?.status === "done") search.auto.results.forEach((fund, i) => list.push([`auto:${i}`, fund]));
  if (search.typed?.status === "done") search.typed.results.forEach((fund, i) => list.push([`typed:${i}`, fund]));
  return list;
}

/** The picked result, if it's still on screen. */
export const pickedFund = (search: ItemSearch) => shown(search).find(([id]) => id === search.picked)?.[1];

/**
 * Searches for the holdings that need a choice, each by itself, and keeps what they found. The
 * Review screen's automatic search for a holding goes by its printed ISIN, and by its name when that
 * finds nothing or none is printed; it can confirm a fund without a click (`certain`). The user's own
 * searches go by what they type. Only the printed ISIN, the name from the statement and what the user
 * types are sent to market-data providers.
 */
export function useHoldingSearches(
  ctx: AddonContext,
  items: FundItem[],
  {
    wanted,
    handled,
    amfiSearches,
    onMatch,
    onTyped,
  }: {
    /** The holdings whose automatic search should run: those that need a choice, and those whose Change is open. */
    wanted: readonly string[];
    /** Holdings answered, changed or skipped in this review: never confirmed without a click. */
    handled: ReadonlySet<string>;
    /** Bumped when AMFI is turned on: the holdings that need a choice are searched again. */
    amfiSearches: number;
    onMatch: (key: string, fund: ChosenFund) => void;
    /** Called when a typed search is done: how many results it found, the holding's results in all, or why it failed. */
    onTyped?: (key: string, outcome: { text: string; found: number; total: number; origin: Element | null } | { text: string; error: string; origin: Element | null }) => void;
  },
) {
  const [searches, setSearches] = useState<Record<string, ItemSearch>>({});
  const current = useRef(searches);
  current.current = searches;
  // Answers can arrive out of order; only each holding's latest search of each kind counts.
  const latest = useRef(new Map<string, number>());
  const interacted = useRef(new Set<string>());
  const mounted = useRef(true);
  const handledRef = useRef(handled);
  handledRef.current = handled;
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  const onTypedRef = useRef(onTyped);
  onTypedRef.current = onTyped;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = (key: string, change: (s: ItemSearch) => ItemSearch) =>
    setSearches((all) => ({ ...all, [key]: change(all[key] ?? empty) }));

  const done = (item: FundItem, found: SymbolSearchResult[]): Search => ({
    status: "done",
    results: found.map((r) => choiceFor(item, r)),
    amfi: found.some(fromAmfi),
    pricedElsewhere: found.some(fromAmfi) && found.some(pricedElsewhere),
  });

  const runAuto = async (item: FundItem) => {
    const { key, isin, noun } = item;
    const id = (latest.current.get(`auto:${key}`) ?? 0) + 1;
    latest.current.set(`auto:${key}`, id);
    const stale = () => !mounted.current || latest.current.get(`auto:${key}`) !== id;
    update(key, (s) => ({ ...s, auto: { status: "searching" }, picked: s.picked?.startsWith("auto:") ? undefined : s.picked }));
    // A fund's name is searched shorter, without a final "Fund" or the plan and option.
    const name = noun === "fund" ? fundQuery(item.name) : fundName(item.name);
    try {
      let byName = isin ? undefined : name;
      let found = await ctx.api.market.searchTicker(isin ?? name);
      if (stale()) return;
      // Yahoo doesn't list every fund under its ISIN.
      if (found.length === 0 && isin && name) {
        byName = name;
        found = await ctx.api.market.searchTicker(name);
        if (stale()) return;
      }
      const search = done(item, found);
      update(key, (s) => ({ ...s, auto: { ...search, byName } }));
      // AMFI's scheme for the printed ISIN is confirmed without a click when nothing contradicts it,
      // unless the holding was answered or changed, or the user has started on it.
      const own = current.current[key];
      if (noun !== "fund" || !isin || byName || handledRef.current.has(key) || interacted.current.has(key) || own?.text.trim() || own?.typed || own?.picked) return;
      const plan = statementPlan(item);
      const match = certain(found, (r) => {
        // As the result shows it: a listing its provider didn't name has its plan and option unknown.
        const shownName = listingName(choiceFor(item, r));
        return !!shownName && !(["plan", "option"] as const).some((field) => differs(planAndOption(shownName), plan, field));
      });
      if (match !== undefined) onMatchRef.current(key, choiceFor(item, found[match]));
    } catch (e) {
      if (!stale()) update(key, (s) => ({ ...s, auto: { status: "failed", error: String(e) } }));
    }
  };

  const runTyped = async (item: FundItem) => {
    const { key } = item;
    const origin = document.activeElement;
    const text = (current.current[key]?.text ?? "").trim();
    if (!text) return;
    const id = (latest.current.get(`typed:${key}`) ?? 0) + 1;
    latest.current.set(`typed:${key}`, id);
    // Starting a search clears a pending selection.
    update(key, (s) => ({ ...s, typed: { status: "searching", text }, picked: undefined }));
    try {
      const found = await ctx.api.market.searchTicker(text);
      if (!mounted.current || latest.current.get(`typed:${key}`) !== id) return;
      update(key, (s) => ({ ...s, typed: { ...done(item, found), text } }));
      const auto = current.current[key]?.auto;
      onTypedRef.current?.(key, { text, origin, found: found.length, total: found.length + (auto?.status === "done" ? auto.results.length : 0) });
    } catch (e) {
      if (mounted.current && latest.current.get(`typed:${key}`) === id) {
        update(key, (s) => ({ ...s, typed: { status: "failed", error: String(e), text } }));
        onTypedRef.current?.(key, { text, origin, error: String(e) });
      }
    }
  };

  // Each wanted holding is searched once by itself; Change answer and Change search again only if
  // the holding has no automatic search yet.
  const byKey = new Map(items.map((item) => [item.key, item]));
  const wantedKey = wanted.join("\n");
  useEffect(() => {
    for (const key of wanted) {
      const item = byKey.get(key);
      if (item && !current.current[key]?.auto) void runAuto(item);
    }
  }, [wantedKey]);
  // Once AMFI is on, the holdings that need a choice are searched again, and its schemes can confirm them.
  const amfiSeen = useRef(amfiSearches);
  useEffect(() => {
    if (amfiSeen.current === amfiSearches) return;
    amfiSeen.current = amfiSearches;
    for (const key of wanted) {
      const item = byKey.get(key);
      if (item?.noun === "fund") void runAuto(item);
    }
  }, [amfiSearches]);

  return {
    get: (key: string) => searches[key] ?? empty,
    retry: (item: FundItem) => void runAuto(item),
    search: (item: FundItem) => void runTyped(item),
    setText: (key: string, text: string) => update(key, (s) => ({ ...s, text })),
    pick: (key: string, id: string | undefined) => update(key, (s) => ({ ...s, picked: id })),
    /** Keeps an automatic match from removing a question the user has entered. */
    interact: (key: string) => { interacted.current.add(key); },
    /** Forgets the typed search and invalidates a response still on its way. */
    settle: (key: string) => {
      latest.current.set(`typed:${key}`, (latest.current.get(`typed:${key}`) ?? 0) + 1);
      update(key, (s) => ({ ...s, typed: undefined, text: "", picked: undefined }));
    },
  };
}

export type HoldingSearches = ReturnType<typeof useHoldingSearches>;
