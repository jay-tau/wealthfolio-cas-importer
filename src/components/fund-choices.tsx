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
  return {
    symbol: (result.canonicalSymbol || result.symbol).trim().toUpperCase(),
    exchangeMic: result.canonicalExchangeMic || result.exchangeMic,
    // Statements are in rupees; a result without a currency is taken to be one too.
    quoteCcy: result.currency || "INR",
    instrumentType: result.quoteType,
    providerId: result.providerId,
    providerSymbol: result.providerSymbol,
    name: result.longName || result.shortName || result.symbol,
  };
}

const describe = (fund: ChosenFund) =>
  [fund.symbol, fund.exchangeMic, fund.instrumentType, fund.quoteCcy].filter(Boolean).join(" · ");

/** The statement's funds, one entry per fund however many folios hold it. */
export function fundsOf(data: CasData) {
  const funds = new Map<string, CasScheme[]>();
  for (const scheme of data.folios.flatMap((f) => f.schemes)) {
    const key = fundKey(scheme);
    funds.set(key, [...(funds.get(key) ?? []), scheme]);
  }
  return funds;
}

function FundSearch({
  ctx,
  scheme,
  onChoose,
  onLeaveOut,
}: {
  ctx: AddonContext;
  scheme: CasScheme;
  onChoose: (fund: ChosenFund) => void;
  onLeaveOut: () => void;
}) {
  // Only the printed ISIN, the fund's name from the statement when the ISIN finds nothing or isn't
  // printed, or what the user types is sent to market-data providers.
  const name = fundName(scheme.scheme);
  const [query, setQuery] = useState(scheme.isin ?? name);
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
    let named = !scheme.isin && text.trim() === name;
    setByName(named ? name : "");
    try {
      let found = await ctx.api.market.searchTicker(text.trim());
      if (id !== latest.current) return;
      // Yahoo doesn't list every fund under its ISIN.
      if (found.length === 0 && text.trim().toUpperCase() === scheme.isin && name !== "") {
        named = true;
        setByName(name);
        setQuery((typed) => (typed.trim().toUpperCase() === scheme.isin ? name : typed));
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
          aria-label="Search for the fund"
          className="w-72"
          value={query}
          placeholder={scheme.isin ? "ISIN, name or ticker" : "Name or ticker"}
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
          {scheme.isin
            ? results.length
              ? `Nothing found for the ISIN; showing results for "${byName}". Pick the plan and option on the statement.`
              : `Nothing found for the ISIN or for "${byName}". Try another name or a ticker.`
            : results.length
              ? `No ISIN on the statement; showing results for "${byName}". Pick the plan and option on the statement.`
              : `No ISIN on the statement, and nothing found for "${byName}". Try another name or a ticker.`}
        </p>
      )}
      {results?.length === 0 && !byName && (
        <p className="text-muted-foreground text-sm">Nothing found. Try the fund's name.</p>
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
          Use this fund
        </Button>
        <Button type="button" variant="ghost" onClick={onLeaveOut}>
          Leave this fund out
        </Button>
      </div>
    </div>
  );
}

export function FundChoicesCard({
  ctx,
  data,
  choices,
  onChange,
}: {
  ctx: AddonContext;
  data: CasData;
  choices: Record<string, FundChoice | undefined>;
  onChange: (key: string, choice: FundChoice | undefined) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Funds</CardTitle>
        <p className="text-muted-foreground text-sm">
          Confirm the Wealthfolio fund for each scheme. Funds are searched by their printed ISIN, and by name when
          that finds nothing or no ISIN is printed; the add-on remembers the fund you confirm for each scheme.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {[...fundsOf(data)].map(([key, schemes]) => {
          const choice = choices[key];
          const scheme = schemes[0];
          return (
            <section key={key} className="grid gap-2">
              <h3 className="font-medium">{scheme.scheme}</h3>
              <p className="text-muted-foreground text-sm">
                {scheme.isin ? `ISIN ${scheme.isin}` : "No ISIN printed"}
                {schemes.length > 1 && ` · in ${schemes.length} folios`}
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
                    Choose a fund
                  </Button>
                </div>
              ) : (
                <FundSearch
                  ctx={ctx}
                  scheme={scheme}
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
