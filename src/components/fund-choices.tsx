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
import { useEffect, useRef, useState } from "react";
import type { CasData, CasScheme } from "../cas/types";
import { type ChosenFund, fundKey } from "../lib/choices";
import { fundName } from "../lib/fund-name";

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

const pickHint = (item: FundItem) =>
  item.noun === "fund"
    ? "Pick one with the statement's fund name, plan and option, or leave this fund out."
    : item.noun === "share"
      ? "Pick one with the statement's company name, or leave this share out."
      : `Pick one with the statement's ${item.noun} name, use the statement's prices, or leave this ${item.noun} out.`;

const describe = (fund: ChosenFund) =>
  [fund.symbol, fund.exchangeMic, fund.instrumentType, fund.quoteCcy, fund.statementPrices && "priced from statements"].filter(Boolean).join(" · ");

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
  /** As printed. */
  name: string;
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
  onChoose,
  onLeaveOut,
}: {
  ctx: AddonContext;
  item: FundItem;
  onChoose: (fund: ChosenFund) => void;
  onLeaveOut: () => void;
}) {
  // Only the printed ISIN, the fund's name from the statement when the ISIN finds nothing or isn't
  // printed, or what the user types is sent to market-data providers.
  const name = fundName(item.name);
  const { isin, noun, statementAsset } = item;
  const [query, setQuery] = useState(isin ?? name);
  const [results, setResults] = useState<SymbolSearchResult[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  // The name searched when the printed ISIN found nothing, or when there's no ISIN.
  const [byName, setByName] = useState("");
  // Answers can arrive out of order; only the latest search's counts.
  const latest = useRef(0);

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
      setPicked(found.length === 1 && !named ? "0" : "");
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

  const result = picked === "" ? undefined : results?.[Number(picked)];
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Search for the ${noun}`}
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
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {results && byName && (
        <p className="text-muted-foreground text-sm">
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
        <p className="text-muted-foreground text-sm">
          Nothing found. Try the {noun}'s name{statementAsset ? ", or use the statement's prices" : ""}.
        </p>
      )}
      {results && results.length > 0 && (
        <RadioGroup value={picked} onValueChange={(value) => setPicked(String(value))} className="grid gap-2">
          {results.map((r, i) => (
            <Label key={`${r.symbol} ${r.exchangeMic} ${i}`} className="flex items-center gap-2 font-normal">
              <RadioGroupItem value={String(i)} />
              <span>
                {r.longName || r.shortName} <span className="text-muted-foreground">({describe(toFund(r))})</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={!result} onClick={() => result && onChoose(toFund(result))}>
          Use this {noun}
        </Button>
        {statementAsset && (
          <Button type="button" variant="outline" onClick={() => onChoose(statementAsset)}>
            Use the statement's prices
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onLeaveOut}>
          Leave this {noun} out
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
  intro = "Confirm the Wealthfolio fund for each scheme. Funds are searched by their printed ISIN, and by name when that finds nothing or no ISIN is printed; the add-on remembers the fund you confirm for each scheme.",
}: {
  ctx: AddonContext;
  items: FundItem[];
  choices: Record<string, FundChoice | undefined>;
  onChange: (key: string, choice: FundChoice | undefined) => void;
  title?: string;
  intro?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{intro}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {items.map((item) => {
          const { key } = item;
          const choice = choices[key];
          return (
            <section key={key} className="grid gap-2">
              <h3 className="font-medium">{item.name}</h3>
              <p className="text-muted-foreground text-sm">
                {item.isin ? `ISIN ${item.isin}` : "No ISIN printed"}
                {item.where && ` · ${item.where}`}
              </p>
              {choice && "fund" in choice ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success-subtle">Confirmed</Badge>
                  <span>
                    {choice.fund.name} <span className="text-muted-foreground">({describe(choice.fund)})</span>
                  </span>
                  <Button type="button" variant="link" size="sm" onClick={() => onChange(key, undefined)}>
                    Change
                  </Button>
                </div>
              ) : choice ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">Left out</Badge>
                  <Button type="button" variant="link" size="sm" onClick={() => onChange(key, undefined)}>
                    Choose a {item.noun}
                  </Button>
                </div>
              ) : (
                <FundSearch
                  ctx={ctx}
                  item={item}
                  onChoose={(fund) => onChange(key, { fund })}
                  onLeaveOut={() => onChange(key, { leftOut: true })}
                />
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
