import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import { Fragment, type ReactNode } from "react";
import type { FundGroup } from "../../cas/review";
import type { ChosenFund } from "../../lib/choices";
import { listingName } from "../../lib/fund-label";
import { planAndOption } from "../../lib/fund-name";
import { type FundItem, otherCurrency } from "../fund-choices";
import { CurrencyBadge, LinkButton, PlanBadges, planConflict, sameName, usePricesFrom } from "./parts";
import { statementPlan } from "./search";

/** A fund with transactions to import, in one account: one row however many folios go to it. */
export interface FundRow {
  /** The fund group's key, `accountId|fundRef`. */
  id: string;
  group: FundGroup;
  /** Whose funds and which account, for grouping: "A. Investor → Mutual funds". */
  groupTitle: string;
  /** The statement's fund, for its name, plan and option and Change. */
  item: FundItem;
  /** Distinct statement funds confirmed as this asset in this account. */
  items: FundItem[];
  fund: ChosenFund;
  /** Who chose its asset: found automatically on AMFI, remembered, or chosen in this review. */
  by: "auto" | "before" | "you";
  name: string;
  /** The name in accessible names, numbered when another row has the same one. */
  label: string;
  /** "1,204.500"; undefined when Wealthfolio's portfolio engine is needed to count them. */
  unitsAfter?: string;
  /** The units won't match the statement's after importing, and why, which keeps the row shown. */
  note?: string;
  /** Changed in this review, so it stays shown. */
  touched: boolean;
}

export interface FundRowHandlers {
  ids: (row: FundRow, item?: FundItem) => { change: string };
  label: (row: FundRow, item: FundItem) => string;
  /** The row whose Change is open, by its id, and for which of its statement funds. */
  changing?: string;
  changingItem?: string;
  /** "Save or cancel this edit first." beside the open edit. */
  nag: boolean;
  onChange: (row: FundRow, item?: FundItem) => void;
  /** The fund's Change panel, in place. */
  changePanel: (row: FundRow) => ReactNode;
}

const BY = { auto: "", before: " · chosen before", you: " · chosen by you" };

function chosenPlan(row: FundRow) {
  const name = listingName(row.fund);
  return name ? planAndOption(name) : undefined;
}

function Source({ ctx, row, handlers }: { ctx: AddonContext; row: FundRow; handlers: FundRowHandlers }) {
  const source = usePricesFrom(ctx, row.item, row.fund);
  return (
    <span className="text-muted-foreground text-sm">
      {source ?? "Prices from…"}
      {BY[row.by]} ·{" "}
      <LinkButton
        id={handlers.ids(row).change}
        type="button"
        aria-expanded={handlers.changing === row.id && handlers.changingItem === row.item.key}
        aria-label={`Change: ${row.label}`}
        onClick={() => handlers.onChange(row)}
      >
        Change
      </LinkButton>
    </span>
  );
}

/** Every plan and option printed for the row's statement funds that differs from the chosen listing's. */
export const fundPlanWarnings = (row: Pick<FundRow, "fund" | "items">) =>
  [...new Set(row.items.map((item) => planConflict(row.fund, statementPlan(item))).filter((w): w is string => !!w))];

function RowHead({ ctx, row, handlers }: { ctx: AddonContext; row: FundRow; handlers: FundRowHandlers }) {
  const listed = listingName(row.fund);
  const own = chosenPlan(row);
  const currency = otherCurrency(row.fund.quoteCcy);
  return (
    <div className="grid gap-1">
      <span>
        <span className="font-semibold">{row.name}</span>
        {own && <PlanBadges own={own} statement={statementPlan(row.item)} />}
        <CurrencyBadge fund={row.fund} />
      </span>
      {!sameName(listed ?? row.name, row.item.name) && <span className="text-muted-foreground text-sm">On your statement: {row.item.name}</span>}
      {fundPlanWarnings(row).map((warning) => (
        <span key={warning} className="text-warning text-sm">
          {warning}
        </span>
      ))}
      {currency && <span className="text-warning text-sm">{currency}</span>}
      {row.note && <span className="text-warning text-sm">{row.note}</span>}
      <Source ctx={ctx} row={row} handlers={handlers} />
      {row.items
        .filter((item) => item.key !== row.item.key)
        .map((item) => (
          <span key={item.key} className="text-muted-foreground text-sm">
            On your statement: {item.name} ·{" "}
            <LinkButton
              id={handlers.ids(row, item).change}
              type="button"
              aria-expanded={handlers.changing === row.id && handlers.changingItem === item.key}
              aria-label={`Change: ${handlers.label(row, item)}`}
              onClick={() => handlers.onChange(row, item)}
            >
              Change
            </LinkButton>
          </span>
        ))}
      {handlers.nag && handlers.changing === row.id && <span className="text-warning text-sm">Save or cancel this edit first.</span>}
    </div>
  );
}

const before = (row: FundRow) => (row.group.before ? `${row.group.before} imported before` : "");

/**
 * Every fund with transactions to import, with its price source, new transactions and units after
 * the import: a table from the `sm` width, a stacked list below it. Grouped by whose funds go to which
 * account when there's more than one. With more than five rows, only the first three,
 * rows whose units won't match and rows just changed show until Show all.
 */
export function FundsReadyTable({
  ctx,
  rows,
  wide,
  showAll,
  onShowAll,
  showAllId,
  handlers,
}: {
  ctx: AddonContext;
  rows: FundRow[];
  wide: boolean;
  showAll: boolean;
  onShowAll: () => void;
  showAllId: string;
  handlers: FundRowHandlers;
}) {
  const titles = [...new Set(rows.map((r) => r.groupTitle))];
  const grouped = titles.length > 1;
  const open = (row: FundRow) => handlers.changing === row.id;
  const visible = showAll || rows.length <= 5 ? rows : rows.filter((row, i) => i < 3 || row.note || row.touched || open(row));
  const more = rows.length - visible.length;
  const groups = grouped
    ? titles.map((title) => ({ title, rows: visible.filter((r) => r.groupTitle === title) }))
    : [{ title: "", rows: visible }];
  const showAllLine = more > 0 && (
    <span className="text-sm">
      <LinkButton id={showAllId} type="button" onClick={onShowAll}>
        Show all {rows.length}
      </LinkButton>{" "}
      <span className="text-muted-foreground">({more} more, nothing to check)</span>
    </span>
  );
  if (!wide) {
    return (
      <div className="grid gap-3 sm:hidden">
        {groups.map((group) => (
          <Fragment key={group.title}>
            {group.title && <p className="text-muted-foreground text-sm font-medium">{group.title}</p>}
            <ul className="grid gap-3" aria-label={group.title || "Funds ready to import"}>
              {group.rows.map((row) => (
                <li key={row.id} className="grid gap-1 rounded-md border p-3">
                  <RowHead ctx={ctx} row={row} handlers={handlers} />
                  <span className="text-muted-foreground text-sm">
                    New transactions: <span className="text-foreground tabular-nums">{row.group.sent}</span>
                    {row.group.before > 0 && ` (${before(row)})`} · Units after import:{" "}
                    <span className="text-foreground tabular-nums">{row.unitsAfter ?? "unknown"}</span>
                  </span>
                  {handlers.changing === row.id && handlers.changePanel(row)}
                </li>
              ))}
            </ul>
          </Fragment>
        ))}
        {showAllLine}
      </div>
    );
  }
  return (
    <div className="hidden sm:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fund</TableHead>
            <TableHead className="text-end">New transactions</TableHead>
            <TableHead className="text-end">Units after import</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <Fragment key={group.title}>
              {group.title && (
                <TableRow>
                  <th colSpan={3} scope="colgroup" className="text-muted-foreground p-2 text-start text-sm font-medium">
                    {group.title}
                  </th>
                </TableRow>
              )}
              {group.rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow>
                    <th scope="row" className="p-2 text-start align-top font-normal">
                      <RowHead ctx={ctx} row={row} handlers={handlers} />
                    </th>
                    <td className="p-2 text-end align-top tabular-nums">
                      {row.group.sent}
                      {row.group.before > 0 && <span className="text-muted-foreground block text-xs">{before(row)}</span>}
                    </td>
                    <td className="p-2 text-end align-top tabular-nums whitespace-nowrap">{row.unitsAfter ?? "Unknown"}</td>
                  </TableRow>
                  {handlers.changing === row.id && (
                    <TableRow>
                      <td colSpan={3} className="p-2">
                        {handlers.changePanel(row)}
                      </td>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
          {showAllLine && (
            <TableRow>
              <td colSpan={3} className="p-2">
                {showAllLine}
              </td>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
