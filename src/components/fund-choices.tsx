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
import { Fragment, type RefCallback, useEffect, useRef, useState } from "react";
import type { CasData, CasScheme } from "../cas/types";
import { fromAmfi, preselected, pricedElsewhere } from "../lib/amfi";
import { type ChosenFund, fundKey } from "../lib/choices";
import { useFocusMove } from "../lib/focus";
import { fundName, fundQuery, type PlanAndOption, planAndOption } from "../lib/fund-name";
import { nameNumber } from "../lib/name-number";
import { plural } from "../lib/plural";

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

/** A non-rupee currency is a warning badge instead, so it isn't listed twice. */
const describe = (fund: ChosenFund) =>
  [
    fund.symbol,
    fund.exchangeMic,
    fund.instrumentType,
    !otherCurrency(fund.quoteCcy) && fund.quoteCcy,
    fromAmfi(fund) && "AMFI selected",
    fund.statementPrices && "priced from statements",
  ]
    .filter(Boolean)
    .join(" · ");

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
    const differs = !!statement?.[field] && statement[field] !== value;
    return (
      <Fragment key={field}>
        {" "}
        <Badge variant={differs ? "warning-subtle" : "secondary"}>{value}</Badge>
      </Fragment>
    );
  });
}

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
  /** As printed, except a CDSL folio's leading scheme code and a CDSL demat fund's fund house. */
  name: string;
  /** The name can end partway through a word, as a CDSL demat account cuts a long one short. */
  cut?: boolean;
  noun: "fund" | "share" | "bond" | "NPS scheme";
  /** Where else the statement lists it, e.g. "in 2 folios". */
  where?: string;
  /** The asset priced by hand from statements, offered when no search result fits. */
  statementAsset?: ChosenFund;
}

export const fundItems = (data: CasData): FundItem[] =>
  [...fundsOf(data)].map(([key, schemes]) => ({
    key,
    isin: schemes[0].isin,
    name: schemes[0].scheme,
    noun: "fund",
    where: schemes.length > 1 ? `in ${schemes.length} folios` : undefined,
  }));

function FundSearch({
  ctx,
  item,
  label,
  searchRef,
  onChoose,
  onLeaveOut,
  onNoAmfi,
}: {
  ctx: AddonContext;
  item: FundItem;
  label: string;
  searchRef: RefCallback<HTMLInputElement>;
  onChoose: (fund: ChosenFund) => void;
  onLeaveOut: () => void;
  /** Called with true while the fund's own search finds no AMFI result, and with false after. */
  onNoAmfi: (noAmfi: boolean) => void;
}) {
  const { isin, noun, statementAsset } = item;
  // Only the printed ISIN, the fund's name from the statement when the ISIN finds nothing or isn't
  // printed, or what the user types is sent to market-data providers. A fund's name is searched
  // shorter, without a final "Fund" or the plan and option.
  const name = noun === "fund" ? fundQuery(item.name) : fundName(item.name);
  // Every section repeats these controls, so hidden text after each one's visible text tells screen
  // readers which fund it's for. Browsers read a space before hidden text, so it starts with a word.
  const forItem = <span className="sr-only"> for {label}</span>;
  const plan = statementPlan(item);
  const [query, setQuery] = useState(isin ?? name);
  const [results, setResults] = useState<SymbolSearchResult[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  // The name searched when the printed ISIN found nothing, or when there's no ISIN.
  const [byName, setByName] = useState("");
  // The results are for the printed ISIN, or for the name of a fund printed without one.
  const [own, setOwn] = useState(false);
  // Answers can arrive out of order; only the latest search's counts.
  const latest = useRef(0);
  // Every section searches by itself when a statement is read, and reading each of those out would
  // drown the page: a section's outcome is read out once the focus has been in its search.
  const [live, setLive] = useState(false);

  const search = async (text: string) => {
    if (!text.trim()) return;
    const id = ++latest.current;
    setResults(null);
    setPicked("");
    setSearching(true);
    setError("");
    // The shorter name can match several plans and options of the fund, so the user picks one
    // even when there's a single result.
    let named = !isin && text.trim() === name;
    setByName(named ? name : "");
    setOwn(named || (!!isin && text.trim().toUpperCase() === isin));
    try {
      let found = await ctx.api.market.searchTicker(text.trim());
      if (id !== latest.current) return;
      // Yahoo doesn't list every fund under its ISIN.
      if (found.length === 0 && text.trim().toUpperCase() === isin && name !== "") {
        named = true;
        setByName(name);
        setQuery((typed) => (typed.trim().toUpperCase() === isin ? name : typed));
        found = await ctx.api.market.searchTicker(name);
        if (id !== latest.current) return;
      }
      setResults(found);
      setPicked(String(preselected(found, named) ?? ""));
    } catch (e) {
      if (id === latest.current) setError(`The search failed: ${String(e)}`);
    } finally {
      if (id === latest.current) setSearching(false);
    }
  };

  // Search the printed ISIN, or the fund's name when there's none, once, when the fund is first shown.
  useEffect(() => {
    void search(query);
  }, []);

  // The printed ISIN, or the name of a fund printed without one, finds no AMFI result: AMFI may not
  // be added in Wealthfolio. Other search terms say nothing about AMFI.
  const noAmfi = !!results && own && noun === "fund" && !results.some(fromAmfi);
  useEffect(() => {
    if (!noAmfi) return;
    onNoAmfi(true);
    return () => onNoAmfi(false);
  }, [noAmfi]);

  const result = picked === "" ? undefined : results?.[Number(picked)];
  return (
    <div className="grid gap-3">
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
      {results && results.length > 0 && (
        <RadioGroup
          aria-label={`Search results for ${label}`}
          value={picked}
          onValueChange={(value) => setPicked(String(value))}
          className="grid gap-2"
        >
          {results.map((r, i) => {
            const fund = toFund(r);
            const currency = otherCurrency(fund.quoteCcy);
            return (
              <Label key={`${r.symbol} ${r.exchangeMic} ${i}`} className="flex items-center gap-2 font-normal">
                <RadioGroupItem value={String(i)} />
                <span>
                  {r.longName || r.shortName}
                  {plan && <PlanBadges own={planAndOption(r.longName || r.shortName || "")} statement={plan} />}
                  <CurrencyBadge fund={fund} />{" "}
                  <span className="text-muted-foreground">({describe(fund)})</span>
                  {currency && <span className="text-muted-foreground block">{currency}</span>}
                </span>
              </Label>
            );
          })}
        </RadioGroup>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={!result} onClick={() => result && onChoose(toFund(result))}>
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

export function FundChoicesCard({
  ctx,
  items,
  choices,
  onChange,
  title = "Funds",
  intro = "Check that each fund found matches the statement's name, plan and option, then choose Use this fund. This is only needed the first time: the add-on remembers each fund you confirm.",
}: {
  ctx: AddonContext;
  items: FundItem[];
  choices: Record<string, FundChoice | undefined>;
  onChange: (key: string, choice: FundChoice | undefined) => void;
  title?: string;
  intro?: string;
}) {
  // The open fund searches that find no AMFI result.
  const [noAmfi, setNoAmfi] = useState<readonly string[]>([]);
  // Each choice replaces the control pressed with another in the fund's section, which takes the focus.
  const focus = useFocusMove();
  const choose = (key: string, choice: FundChoice | undefined) => {
    focus.expect(key);
    onChange(key, choice);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{intro}</p>
        {noAmfi.length > 0 && (
          <p className="text-muted-foreground text-sm">
            We recommend AMFI for daily fund prices. Before confirming, add it in Settings → Market data if it isn't on.
            In each fund's search box, enter its ISIN or AMFI scheme code and press Search.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {items.map((item, i) => {
          const { key } = item;
          const label = `${item.name.trim()}${nameNumber(items, i, item.noun)}`;
          const choice = choices[key];
          const plan = statementPlan(item);
          const currency = choice && "fund" in choice ? otherCurrency(choice.fund.quoteCcy) : undefined;
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
              {choice && "fund" in choice ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="success-subtle">Confirmed</Badge>
                    <span>
                      {choice.fund.name}
                      {plan && <PlanBadges own={planAndOption(choice.fund.name)} statement={plan} />}
                      <CurrencyBadge fund={choice.fund} />{" "}
                      <span className="text-muted-foreground">({describe(choice.fund)})</span>
                    </span>
                    <Button ref={focus.target(key)} type="button" variant="link" size="sm" onClick={() => choose(key, undefined)}>
                      Change<span className="sr-only"> the {item.noun} for {label}</span>
                    </Button>
                  </div>
                  {currency && <p className="text-muted-foreground text-sm">{currency}</p>}
                </>
              ) : choice ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">Left out</Badge>
                  <Button ref={focus.target(key)} type="button" variant="link" size="sm" onClick={() => choose(key, undefined)}>
                    Choose a {item.noun}
                    <span className="sr-only"> for {label}</span>
                  </Button>
                </div>
              ) : (
                <FundSearch
                  ctx={ctx}
                  item={item}
                  label={label}
                  searchRef={focus.target(key)}
                  onChoose={(fund) => choose(key, { fund })}
                  onLeaveOut={() => choose(key, { leftOut: true })}
                  onNoAmfi={(missing) =>
                    setNoAmfi((keys) => (missing ? [...keys.filter((k) => k !== key), key] : keys.filter((k) => k !== key)))
                  }
                />
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
