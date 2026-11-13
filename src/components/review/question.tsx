import { Button, Input, Label, RadioGroup, RadioGroupItem, Spinner } from "@wealthfolio/ui";
import { type ReactNode, useId } from "react";
import type { ChosenFund } from "../../lib/choices";
import { exchangeOf } from "../../lib/review-format";
import type { FundChoice, FundItem } from "../fund-choices";
import { LinkButton, providerName, ResultLabel, resultName, shareExchange, WrapButton } from "./parts";
import { type AutoSearch, type HoldingSearches, type ItemSearch, pickedFund, type Search, shown, statementPlan } from "./search";

/** What the user calls the holding's kind of choice: a share's is a listing on an exchange. */
export const useWord = (item: FundItem) => (item.noun === "share" ? "listing" : item.noun === "fund" ? "fund" : item.noun);

/** The heading of a holding's question. */
export const questionTitle = (item: FundItem) =>
  item.noun === "share" ? `Where should ${item.name}'s price come from?` : `Which ${item.noun} is this?`;

/** The line under the statement's name on why the holding is asked about, from its automatic search. */
function why(item: FundItem, auto: AutoSearch | undefined, amfiOn: boolean) {
  if (!auto || auto.status !== "done") return undefined;
  const { results } = auto;
  if (item.noun === "share" && !auto.byName && results.length === 2) {
    const exchanges = new Set(results.map((r) => exchangeOf(r.exchangeMic)?.short));
    if (exchanges.has("NSE") && exchanges.has("BSE")) return "Both are the same company on different stock exchanges. Either works.";
  }
  if (!item.isin) {
    return item.noun === "fund"
      ? "The statement prints no ISIN for it, so Yahoo Finance searched its name. AMFI can't search by name."
      : "The statement prints no ISIN for it, so its name was searched.";
  }
  // When the name found nothing too, the line under the results says so.
  if (auto.byName) {
    if (!results.length) return undefined;
    return amfiOn
      ? "AMFI has nothing for the ISIN printed for it, so Yahoo Finance searched its name."
      : "Nothing was found for the ISIN printed for it, so its name was searched.";
  }
  if (!results.length) return undefined;
  if (auto.pricedElsewhere) {
    return "Wealthfolio already has this fund, priced from another source, and using AMFI's result adds a second asset for it. To price the one it has from AMFI instead, edit that asset in Wealthfolio: under Market data, turn on automatic updates if it's priced by hand, then choose AMFI as the preferred provider and map AMFI to the fund's ISIN or scheme code.";
  }
  const providers = new Set(results.map((r) => providerName(r) ?? "another source"));
  const where = providers.size === 1 ? ` on ${[...providers][0]}` : "";
  return results.length === 1 ? `Found${where} by the ISIN printed for it.` : `Several results${where} fit the ISIN printed for it.`;
}

/** The search box's label and hint. */
const fieldWords = (item: FundItem) =>
  item.noun === "fund"
    ? { label: "Search by fund code", hint: "ISIN or AMFI scheme code, on the fund's factsheet or the fund house's website." }
    : item.noun === "NPS scheme"
      ? { label: "Search by name", hint: "The scheme's name as its fund manager gives it." }
      : { label: "Search by ISIN", hint: "The 12-character code on your broker's contract note." };

/** The consequence of using the statement's price, tied to the button that does it. */
export const STATEMENT_PRICE = "With the price on the statement, its price changes only when you import a statement, not with the market.";

/** Ids of a picker's controls, so the Review screen can move the focus to them. */
export const pickerIds = (base: string) => ({
  field: `${base}-field`,
  single: `${base}-single`,
  firstTyped: `${base}-typed-0`,
  use: `${base}-use`,
});

/**
 * A holding's results and search: the automatic search's results, the search box, the results of
 * what was typed, and the buttons. With exactly one result in all, that result has its own button and
 * no radio; with more, they're radio options, none picked.
 */
export function Picker({
  item,
  label,
  search,
  searches,
  base,
  onUse,
  onStatementPrice,
  children,
}: {
  item: FundItem;
  /** The holding's name in accessible names. */
  label: string;
  search: ItemSearch;
  searches: HoldingSearches;
  /** Prefix of the ids of its controls (`pickerIds`). */
  base: string;
  onUse: (fund: ChosenFund) => void;
  onStatementPrice?: () => void;
  /** More buttons after the statement's price, such as Skip or Cancel. */
  children?: ReactNode;
}) {
  const ids = pickerIds(base);
  const own = useId();
  const plan = statementPlan(item);
  const word = useWord(item);
  const { auto, typed } = search;
  const list = shown(search);
  const single = list.length === 1 ? list[0] : undefined;
  const picked = pickedFund(search);
  const field = fieldWords(item);
  const typedNone = typed?.status === "done" && typed.results.length === 0;
  const typedFailed = typed?.status === "failed";
  const statementWords = item.statementAsset ? ", or use the price on the statement" : "";
  const singleButton = (fund: ChosenFund, typedOne: boolean) => (
    <WrapButton
      id={ids.single}
      type="button"
      className="shrink-0"
      aria-label={`Use this ${word}: ${resultName(fund)}, for ${label}`}
      onClick={() => onUse(fund)}
      data-typed={typedOne || undefined}
    >
      Use this {word}
    </WrapButton>
  );
  const options = (group: "auto" | "typed", results: ChosenFund[], legend: string) =>
    results.length > 0 && (
      <RadioGroup
        aria-label={legend}
        value={search.picked?.startsWith(`${group}:`) ? search.picked : ""}
        onValueChange={(value) => searches.pick(item.key, String(value))}
        className="grid gap-2"
      >
        {results.map((fund, i) => (
          <Label key={`${group}:${i}`} className="flex items-start gap-3 rounded-md border p-3 font-normal leading-snug">
            <RadioGroupItem id={group === "typed" && i === 0 ? ids.firstTyped : undefined} value={`${group}:${i}`} className="mt-0.5" />
            <ResultLabel item={item} fund={fund} statement={plan} />
          </Label>
        ))}
      </RadioGroup>
    );
  const card = (fund: ChosenFund, typedOne: boolean) => (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
      {/* At least 12rem wide: in a narrow frame the button goes below it. */}
      <span style={{ flex: "1 1 12rem", minWidth: 0 }}>
        <ResultLabel item={item} fund={fund} statement={plan} />
      </span>
      {singleButton(fund, typedOne)}
    </div>
  );
  return (
    <div className="grid gap-3">
      {auto?.status === "searching" && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner /> Searching…
        </p>
      )}
      {auto?.status === "failed" && (
        <p className="text-destructive flex flex-wrap items-center gap-2 text-sm">
          The search didn't work: {auto.error}
          <Button type="button" variant="outline" size="sm" onClick={() => searches.retry(item)}>
            Try again<span className="sr-only">: {label}</span>
          </Button>
        </p>
      )}
      {auto?.status === "done" && auto.results.length === 0 && (
        <p className="text-warning text-sm">
          Nothing found for {item.isin && auto.byName ? "the ISIN printed for it or its name" : item.isin ? "the ISIN printed for it" : "its name"}.
          {" "}Search by its {item.noun === "fund" ? "fund code" : item.noun === "NPS scheme" ? "name" : "ISIN"} below{statementWords}.
        </p>
      )}
      {auto?.status === "done" &&
        (single?.[0].startsWith("auto:") ? card(single[1], false) : options("auto", auto.results, `Results for ${label}`))}
      <div className="grid gap-1.5">
        <Label htmlFor={ids.field} className="font-medium">
          {field.label}
          <span className="sr-only"> for {label}</span>
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={ids.field}
            className="w-48"
            value={search.text}
            aria-describedby={`${own}-hint${typedNone || typedFailed ? ` ${own}-error` : ""}`}
            aria-invalid={typedNone || typedFailed || undefined}
            onChange={(event) => searches.setText(item.key, event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              searches.search(item);
            }}
          />
          <Button type="button" variant="outline" disabled={!search.text.trim()} onClick={() => searches.search(item)}>
            {typed?.status === "searching" && <Spinner />}
            Search<span className="sr-only"> for {label}</span>
          </Button>
        </div>
        {(typedNone || typedFailed) && (
          <p id={`${own}-error`} className="text-destructive text-sm">
            {typedFailed ? `The search didn't work: ${(typed as Search & { status: "failed" }).error}` : `Nothing found for “${typed!.text}”. Check the code.`}
          </p>
        )}
        <p id={`${own}-hint`} className="text-muted-foreground text-xs">
          {field.hint}
        </p>
      </div>
      {typed?.status === "done" && typed.results.length > 0 && (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-sm">
            {typed.results.length === 1 ? "1 result" : `${typed.results.length} results`} for “{typed.text}”:
          </p>
          {single?.[0].startsWith("typed:") ? card(single[1], true) : options("typed", typed.results, `Results for “${typed.text}”`)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!single && list.length > 0 && (
          <WrapButton id={ids.use} type="button" disabled={!picked} aria-label={`Use this ${word} for ${label}`} onClick={() => picked && onUse(picked)}>
            Use this {word}
          </WrapButton>
        )}
        {onStatementPrice && item.statementAsset && (
          <WrapButton
            type="button"
            variant="outline"
            aria-label={`${list.length ? "None of these: use" : "Use"} the price on the statement for ${label}`}
            aria-describedby={`${own}-statement`}
            onClick={onStatementPrice}
          >
            {list.length ? "None of these: use the price on the statement" : "Use the price on the statement"}
          </WrapButton>
        )}
        {children}
      </div>
      {onStatementPrice && item.statementAsset && (
        <p id={`${own}-statement`} className="text-muted-foreground text-xs">
          {STATEMENT_PRICE}
        </p>
      )}
    </div>
  );
}

/** What an answer did, for its line: "price from NSE", "skipped". */
export function answerWords(item: FundItem, choice: FundChoice) {
  if (!("fund" in choice)) return "skipped";
  const { fund } = choice;
  if (fund.statementPrices) return "priced from the statement";
  const exchange = shareExchange(item, fund);
  if (exchange) return `price from ${exchange.short}`;
  const provider = providerName(fund);
  return `${resultName(fund)}${provider ? ` (${provider})` : ""}`;
}

/** A holding with no confirmed asset, as one card: what the statement says, why it's asked, and the choices. */
export function QuestionCard({
  item,
  label,
  units,
  search,
  searches,
  base,
  amfiOn,
  headingId,
  onAnswer,
}: {
  item: FundItem;
  label: string;
  /** The statement's units, already grouped, with their noun: "1,000.000 units", "40 shares". */
  units: string;
  search: ItemSearch;
  searches: HoldingSearches;
  base: string;
  amfiOn: boolean;
  headingId: string;
  onAnswer: (choice: FundChoice) => void;
}) {
  const plan = statementPlan(item);
  const reason = why(item, search.auto, amfiOn);
  return (
    <section aria-labelledby={headingId} onFocus={() => searches.interact(item.key)} className="border-warning grid gap-3 rounded-lg border p-4">
      <h4 id={headingId} tabIndex={-1} className="font-semibold">
        {questionTitle(item)}
      </h4>
      <p>
        On your statement: <span className="font-semibold">{item.name}</span>
        <span className="text-muted-foreground">
          {plan?.plan && ` · ${plan.plan} plan`}
          {plan?.option && ` · ${plan.option}`} · {units}
          {item.where && ` · ${item.where}`}
        </span>
      </p>
      {reason && <p className="text-muted-foreground text-sm">{reason}</p>}
      <Picker
        item={item}
        label={label}
        search={search}
        searches={searches}
        base={base}
        onUse={(fund) => onAnswer({ fund })}
        onStatementPrice={() => item.statementAsset && onAnswer({ fund: item.statementAsset })}
      >
        <WrapButton type="button" variant="outline" aria-label={`Skip this holding: ${label}`} onClick={() => onAnswer({ leftOut: true })}>
          Skip this holding
        </WrapButton>
      </Picker>
    </section>
  );
}

/** An answered question, as one line with Change answer. */
export function AnsweredLine({ item, label, choice, buttonId, onChange }: {
  item: FundItem;
  label: string;
  choice: FundChoice;
  buttonId: string;
  onChange: () => void;
}) {
  const text = `${label}: ${answerWords(item, choice)}`;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span aria-hidden="true" className="text-success">
        ✓
      </span>
      <span className="min-w-0 flex-1">{text}</span>
      <LinkButton id={buttonId} type="button" aria-label={`Change answer: ${text}`} onClick={onChange}>
        Change answer
      </LinkButton>
    </li>
  );
}
