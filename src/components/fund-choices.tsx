import type { AddonContext, SymbolSearchResult } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Spinner,
} from "@wealthfolio/ui";
import { Fragment, type ReactNode, type RefCallback, useEffect, useRef, useState } from "react";
import { isStatementAsset, statementSymbol } from "../cas/holdings";
import type { CasData, CasScheme } from "../cas/types";
import { certain, fromAmfi, preselected, pricedElsewhere } from "../lib/amfi";
import { type ChosenFund, fundKey } from "../lib/choices";
import { useFocusMove } from "../lib/focus";
import { codes, listingName, priceSource, unnamed } from "../lib/fund-label";
import { differs, fundName, fundQuery, type PlanAndOption, planAndOption } from "../lib/fund-name";
import { instrumentType } from "../lib/instrument-type";
import { nameNumber } from "../lib/name-number";
import { plural } from "../lib/plural";
import type { Amfi } from "./amfi-banner";

/** Undefined while undecided. */
export type FundChoice = { fund: ChosenFund } | { leftOut: true };

/** The import fields the way Wealthfolio's own import builds them from a search result. */
function toFund(result: SymbolSearchResult): ChosenFund {
  const mode = result as SymbolSearchResult & { pricingMode?: string | null; quoteMode?: string | null };
  return {
    assetId: result.existingAssetId,
    symbol: (result.canonicalSymbol || result.symbol).trim().toUpperCase(),
    exchangeMic: result.canonicalExchangeMic || result.exchangeMic,
    // Statements are in rupees; a result without a currency is taken to be one too.
    quoteCcy: result.currency || "INR",
    instrumentType: result.quoteType,
    providerId: result.providerId,
    providerSymbol: result.providerSymbol,
    name: result.longName || result.shortName || result.symbol,
    manual: (mode.pricingMode ?? mode.quoteMode) === "MANUAL",
  };
}

const pickHint = (item: FundItem) => {
  const name = item.noun === "fund" ? "fund name, plan and option" : item.noun === "share" ? "company name" : `${item.noun} name`;
  return `Pick one with the statement's ${name}, ${item.statementAsset ? "use the statement's prices, " : ""}or leave this ${item.noun} out.`;
};

/** The currency of the statement and its imported activities and snapshot holdings. */
const RUPEES = "INR";

/**
 * Why an asset quoted in another currency than the statement's rupees needs checking, or undefined
 * for one quoted in rupees: Wealthfolio values the units at the chosen listing's price, in its currency.
 */
export const otherCurrency = (quoteCcy: string | undefined, asset = "this asset") =>
  quoteCcy && quoteCcy !== RUPEES
    ? `The statement's prices and amounts are in rupees, but ${asset} is quoted in ${quoteCcy}. Check that it's the right listing.`
    : undefined;

/** A search result's or confirmed fund's currency as a warning badge, with a space before it, unless it's rupees. */
function CurrencyBadge({ fund }: { fund: ChosenFund }) {
  if (!otherCurrency(fund.quoteCcy)) return null;
  return (
    <>
      {" "}
      <Badge variant="warning-subtle">{fund.quoteCcy}</Badge>
    </>
  );
}

/** The plan and option of a fund's name on the statement. Shares, bonds and NPS schemes have none. */
const statementPlan = (item: FundItem) => (item.noun === "fund" ? planAndOption(item.name, item.cut) : undefined);

/**
 * Badges for the plan and option a name gives, with a space before each. Beside a search result or
 * confirmed fund, one that differs from the statement's is a warning; a field missing from either
 * name has no warning.
 */
function PlanBadges({ own, statement }: { own: PlanAndOption; statement?: PlanAndOption }) {
  return (["plan", "option"] as const).map((field) => {
    const value = own[field];
    if (!value) return null;
    return (
      <Fragment key={field}>
        {" "}
        <Badge variant={differs(own, statement, field) ? "warning-subtle" : "secondary"}>{value}</Badge>
      </Fragment>
    );
  });
}

/**
 * A search result's or confirmed fund's name, then badges for the plan and option it gives beside a
 * statement's fund, and its currency unless it's rupees. A listing its provider didn't name shows
 * as one: the statement's name and plan and option would only be a guess.
 */
function ListingName({ fund, plan }: { fund: ChosenFund; plan?: PlanAndOption }) {
  const name = listingName(fund);
  return (
    <>
      {name ?? unnamed(fund)}
      {plan &&
        (name ? (
          <PlanBadges own={planAndOption(name)} statement={plan} />
        ) : (
          <>
            {" "}
            <Badge variant="warning-subtle">Plan and option unknown</Badge>
          </>
        ))}
      <CurrencyBadge fund={fund} />
    </>
  );
}

/**
 * The symbol, exchange, type and currency behind a search result or confirmed fund, behind a
 * disclosure. `of` names whose they are, for screen readers: in a label, not hidden text, so the
 * result's name isn't in the page's text twice.
 */
function Codes({ fund, of }: { fund: ChosenFund; of: string }) {
  return (
    <details className="text-muted-foreground text-sm">
      <summary className="w-fit cursor-pointer" aria-label={`Details of ${of}`}>
        Details
      </summary>
      <p>{codes(fund)}</p>
    </details>
  );
}

/**
 * Whether a chosen fund's name is the statement's, as searched without "Fund", the plan and option,
 * whatever their case: otherwise the fund's row also gives the statement's name.
 */
const sameName = (chosen: string | undefined, printed: string) =>
  !!chosen && fundQuery(chosen).toUpperCase() === fundQuery(printed).toUpperCase();

const capitalized = (text: string) => text.replace(/^./, (first) => first.toUpperCase());

/** The statement's funds, one entry per fund however many folios hold it. */
export function fundsOf(data: CasData) {
  const funds = new Map<string, CasScheme[]>();
  for (const scheme of data.folios.flatMap((f) => f.schemes)) {
    const key = fundKey(scheme);
    funds.set(key, [...(funds.get(key) ?? []), scheme]);
  }
  return funds;
}

/** A fund or share to confirm, however many lines of the statement hold it. */
export interface FundItem {
  key: string;
  isin: string | null;
  /**
   * As printed, without a CDSL folio's leading scheme code or a CDSL demat fund's fund house, and with
   * control characters as spaces (`readableName`).
   */
  name: string;
  /** The name can end partway through a word, as a CDSL demat account cuts a long one short. */
  cut?: boolean;
  noun: "fund" | "share" | "bond" | "NPS scheme";
  /** Where else the statement lists it, e.g. "in 2 folios". */
  where?: string;
  /** The asset priced by hand from statements, offered when no search result fits. */
  statementAsset?: ChosenFund;
  /**
   * A detailed statement's fund: the symbol of its asset that holdings imports price from statements.
   * Detailed imports don't use that asset, so the search doesn't offer it.
   */
  statementSymbol?: string;
}

export const fundItems = (data: CasData): FundItem[] =>
  [...fundsOf(data)].map(([key, schemes]) => ({
    key,
    isin: schemes[0].isin,
    name: schemes[0].scheme,
    noun: "fund",
    where: schemes.length > 1 ? `in ${schemes.length} folios` : undefined,
    statementSymbol: statementSymbol(schemes[0]),
  }));

function FundSearch({
  ctx,
  item,
  label,
  auto,
  searchRef,
  searchAgain,
  onChoose,
  onMatch,
  onLeaveOut,
  onNoAmfi,
  onChecking,
}: {
  ctx: AddonContext;
  item: FundItem;
  label: string;
  /** The search for the printed ISIN, as the fund is shown or searched again, confirms the result that's certainly the fund. */
  auto: boolean;
  searchRef: RefCallback<HTMLInputElement>;
  /** A change searches again as when the fund was first shown. */
  searchAgain: number;
  onChoose: (fund: ChosenFund) => void;
  /** Confirms the result that's certainly the fund, without a click. */
  onMatch: (fund: ChosenFund) => void;
  onLeaveOut: () => void;
  /** Called with true while the fund's own search finds no AMFI result, and with false after. */
  onNoAmfi: (noAmfi: boolean) => void;
  /** Called with true while the search that can confirm the fund without a click runs, and with false after. */
  onChecking: (checking: boolean) => void;
}) {
  const { isin, noun, statementAsset, statementSymbol } = item;
  // A holding's own asset priced from statements is the statement's prices however it's picked, so
  // the fund kept for detailed imports stays beside it.
  const choiceOf = (result: SymbolSearchResult) =>
    statementAsset && isStatementAsset(result, statementAsset.symbol) &&
    instrumentType(result.quoteType) === instrumentType(statementAsset.instrumentType) &&
    (result.currency || RUPEES) === statementAsset.quoteCcy
      ? statementAsset
      : toFund(result);
  // Only the printed ISIN, the fund's name from the statement when the ISIN finds nothing or isn't
  // printed, or what the user types is sent to market-data providers. A fund's name is searched
  // shorter, without a final "Fund" or the plan and option.
  const name = noun === "fund" ? fundQuery(item.name) : fundName(item.name);
  // Every section repeats these controls, so hidden text after each one's visible text tells screen
  // readers which fund it's for. Browsers read a space before hidden text, so it starts with a word.
  const forItem = <span className="sr-only"> for {label}</span>;
  const plan = statementPlan(item);
  const first = isin ?? name;
  const [query, setQuery] = useState(first);
  const [results, setResults] = useState<SymbolSearchResult[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  // The name searched when the printed ISIN found nothing, or when there's no ISIN.
  const [byName, setByName] = useState("");
  // The results are for the printed ISIN, or for the name of a fund printed without one.
  const [own, setOwn] = useState(false);
  // The search found the asset holdings imports price from statements, which a detailed import doesn't offer.
  const [withheld, setWithheld] = useState(false);
  // Answers can arrive out of order; only the latest search's counts.
  const latest = useRef(0);
  // Every section searches by itself when a statement is read, and reading each of those out would
  // drown the page: a section's outcome is read out once the focus has been in its search.
  const [live, setLive] = useState(false);
  // The focus has been in the fund's section: its search no longer confirms it and takes the section
  // away from the user.
  const touched = useRef(false);
  // Answers that arrive after the fund is confirmed or left out confirm nothing.
  const mounted = useRef(true);

  const search = async (text: string, automatic = false) => {
    if (!text.trim()) return;
    const id = ++latest.current;
    setResults(null);
    setPicked("");
    setSearching(true);
    setError("");
    setWithheld(false);
    let left = false;
    const offered = (found: SymbolSearchResult[]) => {
      const kept = statementSymbol ? found.filter((r) => !isStatementAsset(r, statementSymbol)) : found;
      left ||= kept.length < found.length;
      return kept;
    };
    // The shorter name can match several plans and options of the fund, so the user picks one
    // even when there's a single result.
    let named = !isin && text.trim() === name;
    setByName(named ? name : "");
    setOwn(named || (!!isin && text.trim().toUpperCase() === isin));
    try {
      let found = offered(await ctx.api.market.searchTicker(text.trim()));
      if (id !== latest.current) return;
      // Yahoo doesn't list every fund under its ISIN.
      if (found.length === 0 && text.trim().toUpperCase() === isin && name !== "") {
        named = true;
        setByName(name);
        setQuery((typed) => (typed.trim().toUpperCase() === isin ? name : typed));
        found = offered(await ctx.api.market.searchTicker(name));
        if (id !== latest.current) return;
      }
      setResults(found);
      setWithheld(left);
      setPicked(String(preselected(found, named) ?? ""));
      // AMFI's scheme for the printed ISIN is confirmed without a click, when nothing contradicts it.
      const match = automatic && !named && !left && !touched.current
        ? certain(found, (r) => {
          // As the result's badges show it: a listing its provider didn't name has a warning instead.
          const shown = listingName(choiceOf(r));
          return !!shown && !(["plan", "option"] as const).some((field) => differs(planAndOption(shown), plan, field));
        })
        : undefined;
      if (match !== undefined && mounted.current) onMatch(choiceOf(found[match]));
    } catch (e) {
      if (id === latest.current) setError(`The search failed: ${String(e)}`);
    } finally {
      if (id === latest.current) {
        setSearching(false);
        if (mounted.current) onChecking(false);
      }
    }
  };

  // Search the printed ISIN, or the fund's name when there's none, when the fund is first shown, and
  // again when `searchAgain` changes, in place of what the search box holds. Such a search for a
  // fund's printed ISIN can confirm it without a click, unless the focus has been in its section.
  const searched = useRef<number | null>(null);
  useEffect(() => {
    // Register before requesting: a fast answer must wait for the other funds' searches too.
    // AMFI lists only mutual funds, so it never confirms a share, bond or NPS scheme.
    const automatic = auto && !!isin && noun === "fund" && !touched.current;
    onChecking(automatic);
    if (searched.current !== searchAgain) {
      if (searched.current !== null) setQuery(first);
      searched.current = searchAgain;
      void search(first, automatic);
    }
    return () => onChecking(false);
  }, [searchAgain]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The printed ISIN, or the name of a fund printed without one, finds no AMFI result: AMFI may not
  // be added in Wealthfolio. Other search terms say nothing about AMFI.
  const noAmfi = !!results && own && noun === "fund" && !results.some(fromAmfi);
  useEffect(() => {
    if (!noAmfi) return;
    onNoAmfi(true);
    return () => onNoAmfi(false);
  }, [noAmfi]);

  const funds = results?.map(choiceOf);
  const names = funds?.map((fund) => ({ name: listingName(fund) ?? unnamed(fund) })) ?? [];
  const result = picked === "" ? undefined : results?.[Number(picked)];
  return (
    <div
      className="grid gap-3"
      onFocus={() => {
        touched.current = true;
      }}
    >
      <div onFocus={() => setLive(true)}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={searchRef}
            aria-label={`Search for ${label}`}
            className="w-72"
            value={query}
            placeholder={isin ? "ISIN, name or ticker" : "Name or ticker"}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search(query);
            }}
          />
          <Button type="button" variant="outline" disabled={!query.trim()} onClick={() => void search(query)}>
            {searching && <Spinner />}
            Search
            {forItem}
          </Button>
        </div>
        {/* The search's progress and outcome, read out as they change. Its notes keep their space
            with a top margin, so the region takes none while it holds only hidden text. */}
        <div aria-live={live ? "polite" : "off"} aria-atomic="true">
          {searching && <span className="sr-only">Searching…</span>}
          {!!results?.length && <span className="sr-only">{plural(results.length, "result")}.</span>}
          {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
          {results && byName && (
            <p className="text-muted-foreground mt-3 text-sm">
              {isin
                ? results.length
                  ? `Nothing found for the ISIN; showing results for "${byName}". These results can be other ${noun}s. ${pickHint(item)}`
                  : `Nothing found for the ISIN or for "${byName}". Try another name or a ticker${statementAsset ? ", or use the statement's prices" : ""}.`
                : results.length
                  ? `No ISIN on the statement; showing results for "${byName}". These results can be other ${noun}s. ${pickHint(item)}`
                  : `No ISIN on the statement, and nothing found for "${byName}". Try another name or a ticker${statementAsset ? ", or use the statement's prices" : ""}.`}
            </p>
          )}
          {results?.length === 0 && !byName && (
            <p className="text-muted-foreground mt-3 text-sm">
              Nothing found. Try the {noun}'s name{statementAsset ? ", or use the statement's prices" : ""}.
            </p>
          )}
          {results && withheld && (
            <p className="text-muted-foreground mt-3 text-sm">
              The asset that holdings imports price from statements for this {noun} isn't listed: detailed imports don't
              use the statement's prices.
            </p>
          )}
        </div>
      </div>
      {results?.some(fromAmfi) && results.some(pricedElsewhere) && (
        <p className="text-muted-foreground text-sm">
          Wealthfolio already has this fund, priced from another source, and picking AMFI's result adds a second asset
          for it. To price the one it has from AMFI instead, edit that asset in Wealthfolio. Under Market data, turn on
          automatic updates if it's priced by hand, then choose AMFI as the preferred provider and map AMFI to the
          fund's ISIN or scheme code.
        </p>
      )}
      {funds && funds.length > 0 && (
        <RadioGroup
          aria-label={`Search results for ${label}`}
          value={picked}
          onValueChange={(value) => setPicked(String(value))}
          className="grid gap-2"
        >
          {funds.map((fund, i) => {
            const currency = otherCurrency(fund.quoteCcy);
            const source = priceSource(fund);
            const number = nameNumber(names, i, "listing");
            return (
              <div key={`${fund.symbol} ${fund.exchangeMic} ${i}`} className="grid gap-1">
                <Label className="flex items-start gap-2 leading-snug font-normal">
                  <RadioGroupItem value={String(i)} className="mt-0.5" />
                  <span>
                    <ListingName fund={fund} plan={plan} />
                    {/* Spaces keep the lines apart in the radio's name, whatever the CSS. */}{" "}
                    <span className="text-muted-foreground block">{source}</span>
                    {currency && (
                      <>
                        {" "}
                        <span className="text-muted-foreground block">{currency}</span>
                      </>
                    )}
                    {number && <span className="sr-only">{number}</span>}
                  </span>
                </Label>
                <div className="ms-6">
                  <Codes fund={fund} of={`${listingName(fund) ?? unnamed(fund)}${number}, ${source}, for ${label}`} />
                </div>
              </div>
            );
          })}
        </RadioGroup>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={!result} onClick={() => result && onChoose(choiceOf(result))}>
          Use this {noun}
          {forItem}
        </Button>
        {statementAsset && (
          <Button type="button" variant="outline" onClick={() => onChoose(statementAsset)}>
            Use the statement's prices
            {forItem}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onLeaveOut}>
          Leave this {noun} out
          {forItem}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where a confirmed fund's prices come from, or undefined while that's read. A remembered choice
 * doesn't keep its saved asset's pricing mode, which can change in Wealthfolio, so it's read again;
 * if that fails, the choice's provider says.
 */
function useSource(ctx: AddonContext, fund: ChosenFund) {
  const id = fund.manual === undefined && !fund.statementPrices ? fund.assetId : undefined;
  const [read, setRead] = useState<{ id: string; manual?: boolean }>();
  useEffect(() => {
    if (!id) return;
    let current = true;
    ctx.api.assets.getProfile(id).then(
      (asset) => {
        const mode = (asset as typeof asset & { pricingMode?: string | null }).pricingMode ?? asset.quoteMode;
        if (current) setRead({ id, manual: mode === "MANUAL" });
      },
      () => {
        if (current) setRead({ id });
      },
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (!id) return priceSource(fund);
  return read?.id === id ? priceSource({ ...fund, manual: read.manual }) : undefined;
}

/** A confirmed fund: its name and badges, `children` (its Change button), then where its prices come from. */
function ConfirmedFund({
  ctx,
  fund,
  plan,
  of,
  note,
  children,
}: {
  ctx: AddonContext;
  fund: ChosenFund;
  plan?: PlanAndOption;
  /** Whose details these are, for screen readers. */
  of: string;
  /** A line under its name, such as the statement's name when the fund's own is another. */
  note?: string;
  children: ReactNode;
}) {
  const source = useSource(ctx, fund);
  const currency = otherCurrency(fund.quoteCcy);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success-subtle">Confirmed</Badge>
        <span>
          <ListingName fund={fund} plan={plan} />
        </span>
        {children}
      </div>
      {note && <p className="text-muted-foreground text-sm">{note}</p>}
      {/* Keeps its line while the pricing mode is read, so nothing below it moves. */}
      <p className="text-muted-foreground text-sm">{source ?? "\u00a0"}</p>
      {currency && <p className="text-muted-foreground text-sm">{currency}</p>}
      <Codes fund={fund} of={of} />
    </div>
  );
}

export function FundChoicesCard({
  ctx,
  items,
  choices,
  amfi,
  onChange,
  title = "Funds",
  intro = "Check that each fund found matches the statement's name, plan and option, then choose Use this fund. This is only needed the first time: the add-on remembers each fund you confirm.",
}: {
  ctx: AddonContext;
  items: FundItem[];
  choices: Record<string, FundChoice | undefined>;
  /**
   * Whether AMFI is on. The page's banner says when it's off, so the card's note is only for when
   * Wealthfolio doesn't say. Once it's turned on, the funds without a choice are searched again.
   */
  amfi: Amfi;
  onChange: (key: string, choice: FundChoice | undefined) => void;
  title?: string;
  intro?: string;
}) {
  // The open fund searches that find no AMFI result.
  const [noAmfi, setNoAmfi] = useState<readonly string[]>([]);
  // The funds chosen for, changed or left out since the statement was read, which are never
  // confirmed without a click again; those confirmed without one; and the searches that still can.
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [matched, setMatched] = useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = useState<readonly string[]>([]);
  // Each choice replaces the control pressed with another for the same fund, which takes the focus.
  const focus = useFocusMove();
  const choose = (key: string, choice: FundChoice | undefined) => {
    focus.expect(key);
    setHandled((keys) => new Set(keys).add(key));
    onChange(key, choice);
  };
  const match = (key: string, fund: ChosenFund) => {
    setMatched((keys) => new Set(keys).add(key));
    onChange(key, { fund });
  };
  const listed = (keys: readonly string[], key: string, on: boolean) => (on ? [...keys.filter((k) => k !== key), key] : keys.filter((k) => k !== key));

  const funds = items.map((item, i) => {
    const stored = choices[item.key];
    // A remembered statement-price choice can predate a corrected statement name, which imports use (`planSnapshots`).
    const choice = stored && "fund" in stored && stored.fund.statementPrices ? { fund: { ...stored.fund, name: item.name } } : stored;
    return { item, label: `${item.name.trim()}${nameNumber(items, i, item.noun)}`, choice };
  });
  // Said once every search that can confirm a fund without a click is done, so screen readers hear it once.
  const count = funds.filter(({ item, choice }) => matched.has(item.key) && !handled.has(item.key) && choice && "fund" in choice).length;
  const summary = checking.length > 0 || count === 0
    ? ""
    : count === 1
      ? "1 fund matched from AMFI by its ISIN. Change it if it looks wrong."
      : `${count} funds matched from AMFI by their ISIN. Change any that look wrong.`;
  // Funds that need a choice come first, each in a section of its own. The others follow, a row each.
  // A fund moves between the two as it's chosen, changed or left out, so the others stay where they are.
  const open = funds.filter(({ choice }) => !choice);
  const decided = funds.filter(({ choice }) => choice);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{intro}</p>
        {noAmfi.length > 0 && amfi.status === "unknown" && (
          <p className="text-muted-foreground text-sm">
            We recommend AMFI for daily fund prices. Before confirming, add it in Settings → Market data if it isn't on.
            In each fund's search box, enter its ISIN or AMFI scheme code and press Search.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Out of the layout while empty. */}
        <p aria-live="polite" aria-atomic="true" className={summary ? "text-muted-foreground text-sm" : "sr-only"}>
          {summary}
        </p>
        {open.map(({ item, label }) => {
          const { key } = item;
          const plan = statementPlan(item);
          return (
            <section key={key} className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{item.name}</h3>
                {plan && <PlanBadges own={plan} />}
              </div>
              <p className="text-muted-foreground text-sm">
                {item.isin ? `ISIN ${item.isin}` : "No ISIN printed"}
                {item.where && ` · ${item.where}`}
              </p>
              <FundSearch
                ctx={ctx}
                item={item}
                label={label}
                auto={!handled.has(key)}
                searchRef={focus.target(key)}
                searchAgain={item.noun === "fund" ? amfi.searches : 0}
                onChoose={(fund) => choose(key, { fund })}
                onMatch={(fund) => match(key, fund)}
                onLeaveOut={() => choose(key, { leftOut: true })}
                onNoAmfi={(missing) => setNoAmfi((keys) => listed(keys, key, missing))}
                onChecking={(running) => setChecking((keys) => listed(keys, key, running))}
              />
            </section>
          );
        })}
        {decided.length > 0 && (
          <ul className="grid gap-3">
            {decided.map(({ item, label, choice }) => {
              const { key } = item;
              const plan = statementPlan(item);
              if (!choice || !("fund" in choice)) {
                return (
                  <li key={key} className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Left out</Badge>
                      <span>
                        {item.name}
                        {plan && <PlanBadges own={plan} />}
                      </span>
                      <Button ref={focus.target(key)} type="button" variant="link" size="sm" onClick={() => choose(key, undefined)}>
                        Choose a {item.noun}
                        <span className="sr-only"> for {label}</span>
                      </Button>
                    </div>
                    {item.where && <p className="text-muted-foreground text-sm">{capitalized(item.where)}</p>}
                  </li>
                );
              }
              const { fund } = choice;
              // The statement's name when the chosen fund's is another, and where the statement lists it.
              const note = capitalized(
                [!sameName(listingName(fund), item.name) && `On the statement: ${item.name}`, item.where].filter(Boolean).join(" · "),
              );
              return (
                <li key={key}>
                  <ConfirmedFund ctx={ctx} fund={fund} plan={plan} note={note} of={`the ${item.noun} confirmed for ${label}`}>
                    <Button ref={focus.target(key)} type="button" variant="link" size="sm" onClick={() => choose(key, undefined)}>
                      Change<span className="sr-only"> the {item.noun} for {label}</span>
                    </Button>
                  </ConfirmedFund>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
