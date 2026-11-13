import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Badge, Button, type ButtonProps, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@wealthfolio/ui";
import { Fragment, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { ChosenFund } from "../../lib/choices";
import { listingName, priceSource, unnamed, YAHOO } from "../../lib/fund-label";
import { differs, fundName, type PlanAndOption, planAndOption } from "../../lib/fund-name";
import { exchangeOf } from "../../lib/review-format";
import { type FundItem, otherCurrency } from "../fund-choices";

/**
 * A button whose label wraps instead of running past a narrow window: Wealthfolio's Button keeps
 * its label on one line at a fixed height.
 */
export function WrapButton({ className = "", style, ...props }: ButtonProps) {
  return (
    <Button
      {...props}
      className={`whitespace-normal text-start py-1.5 ${className}`}
      // Wealthfolio's Button doesn't shrink; this one does, to the width it's given, so its label wraps.
      style={{ height: "auto", minHeight: "var(--control-size)", maxWidth: "100%", flexShrink: 1, ...style }}
    />
  );
}

/** A link-styled button for Change, Add cost and the like, which can sit in a line of text. */
export function LinkButton({ className = "", ...props }: ButtonProps) {
  return <Button variant="link" size="sm" {...props} className={`h-auto p-0 whitespace-normal text-start ${className}`} />;
}

/** Badges for a plan and option, with a space before each; one that differs from the statement's warns. */
export function PlanBadges({ own, statement }: { own: PlanAndOption; statement?: PlanAndOption }) {
  return (["plan", "option"] as const).map((field) => {
    const value = own[field];
    if (!value) return null;
    return (
      <Fragment key={field}>
        {" "}
        <Badge className="min-w-fit" variant={differs(own, statement, field) ? "warning-subtle" : "secondary"}>
          {value}
        </Badge>
      </Fragment>
    );
  });
}

/** A currency badge, with a space before it, for an asset quoted in anything but rupees. */
export function CurrencyBadge({ fund }: { fund: Pick<ChosenFund, "quoteCcy"> }) {
  if (!otherCurrency(fund.quoteCcy)) return null;
  return (
    <>
      {" "}
      <Badge className="min-w-fit" variant="warning-subtle">
        {fund.quoteCcy}
      </Badge>
    </>
  );
}

const words = (p: PlanAndOption) => [p.plan, p.option].filter(Boolean).join(" · ");

/**
 * Whether a result's plan and option match the statement's, in words: "Plan and option match your
 * statement", "Different plan: your statement says Direct". Undefined for a share, bond or NPS
 * scheme, and for a fund whose statement name gives neither.
 */
export function matchWords(fund: ChosenFund, statement: PlanAndOption | undefined) {
  if (!statement || (!statement.plan && !statement.option)) return undefined;
  const name = listingName(fund);
  if (!name) return { warn: true, text: "Plan and option unknown" };
  const own = planAndOption(name);
  const fields = (["plan", "option"] as const).filter((field) => statement[field]);
  const different = fields.filter((field) => differs(own, statement, field));
  if (different.length) {
    return { warn: true, text: different.map((field) => `Different ${field}: your statement says ${statement[field]}`).join(". ") };
  }
  const same = fields.filter((field) => own[field] === statement[field]);
  const missing = fields.filter((field) => !own[field]);
  const noun = (list: readonly string[]) => (list.length === 2 ? "Plan and option" : list[0] === "plan" ? "Plan" : "Option");
  if (!missing.length) return { warn: false, text: `${noun(same)} ${same.length === 2 ? "match" : "matches"} your statement` };
  const unread = `its name gives no ${missing.join(" or ")}`;
  return { warn: false, text: same.length ? `${noun(same)} ${same.length === 2 ? "match" : "matches"} your statement; ${unread}` : `Its name gives no ${missing.join(" or ")}` };
}

/**
 * A row's warning when the chosen fund's plan or option isn't the statement's, a deliberate choice:
 * "Statement: Regular · IDCW. Chosen: Direct · IDCW. Different plan." Undefined when they don't differ.
 */
export function planConflict(fund: ChosenFund, statement: PlanAndOption | undefined) {
  if (!statement || fund.statementPrices) return undefined;
  const name = listingName(fund);
  if (!name) return "Chosen listing's plan and option are unknown.";
  const own = planAndOption(name);
  const different = (["plan", "option"] as const).filter((field) => differs(own, statement, field));
  if (!different.length) return undefined;
  return `Statement: ${words(statement)}. Chosen: ${words(own)}. Different ${different.join(" and ")}.`;
}

/** A share listed on an Indian exchange: its results and rows go by the exchange. */
export const shareExchange = (item: Pick<FundItem, "noun">, fund: Pick<ChosenFund, "exchangeMic">) =>
  item.noun === "share" ? exchangeOf(fund.exchangeMic) : undefined;

/** The provider a fund is priced from, by the name Wealthfolio's settings give it. */
export const providerName = (fund: ChosenFund) => (fund.providerId?.trim() ? priceSource({ providerId: fund.providerId }) : undefined);

/** The ticker that tells a listing apart, as its provider has it. */
export const ticker = (fund: ChosenFund) => fund.providerSymbol || fund.symbol;

/**
 * Where a ready row's prices come from: "Prices from AMFI", "Prices from NSE on Yahoo Finance",
 * "Prices from the statement". `manual` is the saved asset's pricing mode, when known.
 */
export function pricesFrom(item: Pick<FundItem, "noun">, fund: ChosenFund, manual = fund.manual) {
  if (fund.statementPrices && manual !== false) return "Prices from the statement";
  if (manual) return "Prices entered by hand";
  const provider = providerName(fund);
  if (!provider) return "Price source unknown";
  const exchange = shareExchange(item, fund);
  return exchange ? `Prices from ${exchange.short} on ${provider}` : `Prices from ${provider}`;
}

/**
 * Whether a chosen fund's name is the statement's, as `fundName` shortens both, whatever their
 * case: otherwise its row also gives the statement's name.
 */
export const sameName = (chosen: string | undefined, printed: string) =>
  !!chosen && fundName(chosen).toUpperCase() === fundName(printed).toUpperCase();

/** The name a holding goes by on the Review screen: its chosen listing's, else the statement's. */
export function shownName(item: FundItem, fund?: ChosenFund) {
  const listed = fund && !fund.statementPrices ? listingName(fund) : undefined;
  const name = listed ?? item.name;
  return item.noun === "fund" ? fundName(name) || name : name;
}

/** The result's name for a choice: its listing name, or what an unnamed listing is called. */
export const resultName = (fund: ChosenFund) => listingName(fund) ?? unnamed(fund);

/** "Unnamed Yahoo listing" without its ticker, which its line under the name gives. */
const unnamedKind = (fund: ChosenFund) => (fund.providerId === YAHOO ? "Unnamed Yahoo listing" : "Unnamed listing");

/**
 * A search result as a choice: its name, or its exchange for a share, with its plan and option
 * badges and currency; under that its provider and ticker, and whether its plan and option match.
 */
export function ResultLabel({ item, fund, statement }: { item: FundItem; fund: ChosenFund; statement?: PlanAndOption }) {
  const exchange = shareExchange(item, fund);
  const name = listingName(fund);
  const currency = otherCurrency(fund.quoteCcy);
  const match = item.noun === "fund" ? matchWords(fund, statement) : undefined;
  // A saved asset priced by hand keeps the provider preferred for automatic updates, which are off.
  const source = fund.statementPrices ? "the statement's prices" : fund.manual ? "Priced by hand" : (providerName(fund) ?? "Unknown source");
  const detail = [exchange ? (name ?? unnamedKind(fund)) : undefined, source, ticker(fund), !name && item.noun === "fund" ? "plan and option unknown" : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="grid gap-0.5">
      <span>
        <span className="font-medium">{exchange ? exchange.long : (name ?? unnamedKind(fund))}</span>
        {!exchange && name && statement && item.noun === "fund" && <PlanBadges own={planAndOption(name)} statement={statement} />}
        <CurrencyBadge fund={fund} />
      </span>
      {/* Spaces keep the lines apart in a radio's name, whatever the CSS. */}{" "}
      <span className="text-muted-foreground text-sm" style={{ overflowWrap: "anywhere" }}>
        {detail}
      </span>{" "}
      {match && match.text !== "Plan and option unknown" && (
        <span className={match.warn ? "text-warning text-sm" : "text-muted-foreground text-sm"}>{match.text}</span>
      )}
      {currency && (
        <>
          {" "}
          <span className="text-warning text-sm">{currency}</span>
        </>
      )}
    </span>
  );
}

/**
 * A disclosure: a link-styled button that shows or hides what it controls, keeping the focus on
 * itself. Controlled, so the Review screen can open it to reveal an edit inside.
 */
export function Disclosure({
  label,
  open,
  onOpenChange,
  children,
  ariaLabel,
  id,
}: {
  label: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  ariaLabel?: string;
  id?: string;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="contents">
      <CollapsibleTrigger
        id={id}
        aria-label={ariaLabel}
        render={<Button variant="link" size="sm" className="h-auto p-0 whitespace-normal text-start" />}
      >
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="basis-full">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Where a confirmed fund's prices come from now: an existing asset keeps its pricing mode and
 * preferred provider, even when it was first chosen to use statement prices. Undefined while read.
 */
export function usePricesFrom(ctx: AddonContext, item: Pick<FundItem, "noun">, fund: ChosenFund) {
  const id = fund.assetId;
  const [read, setRead] = useState<{ id: string; source?: Pick<ChosenFund, "manual" | "providerId" | "exchangeMic"> }>();
  useEffect(() => {
    if (!id) return;
    let current = true;
    ctx.api.assets.getProfile(id).then(
      (asset) => {
        const mode = (asset as typeof asset & { pricingMode?: string | null }).pricingMode ?? asset.quoteMode;
        const preferred = asset.providerConfig?.preferred_provider;
        if (current) setRead({ id, source: {
          manual: mode === "MANUAL" ? true : mode === "MARKET" ? false : undefined,
          providerId: typeof preferred === "string" && preferred.trim() ? preferred.trim() : undefined,
          exchangeMic: asset.instrumentExchangeMic ?? undefined,
        } });
      },
      () => {
        if (current) setRead({ id });
      },
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (!id) return pricesFrom(item, fund);
  if (read?.id !== id) return undefined;
  return pricesFrom(item, {
    ...fund, ...read.source,
    manual: read.source?.manual ?? fund.manual,
    providerId: read.source?.providerId ?? (fund.statementPrices ? undefined : fund.providerId),
  });
}

/** Tailwind's `sm` breakpoint, 40rem: below it, tables become stacked lists. */
const SM = "(min-width: 40rem)";
const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(SM);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
/** Whether the frame is at least `sm` wide. The add-on's frame is its own viewport. */
export const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(SM).matches, () => true);
