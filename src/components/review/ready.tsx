import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Input, Label, Table, TableBody, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import { Fragment, type ReactNode } from "react";
import type { PlannedPosition } from "../../cas/holdings";
import type { ChosenFund } from "../../lib/choices";
import { listingName } from "../../lib/fund-label";
import { planAndOption } from "../../lib/fund-name";
import { COST_HINT, rupees, shortDate } from "../../lib/review-format";
import { type FundItem, otherCurrency } from "../fund-choices";
import { CurrencyBadge, LinkButton, PlanBadges, planConflict, sameName, usePricesFrom } from "./parts";
import { statementPlan } from "./search";

/** Where a ready row's purchase cost comes from, as its line says. */
export type CostFrom = "statement" | "wealthfolio" | "face" | "typed";

/** A holding that will be saved: a statement row of an account's snapshot. */
export interface ReadyRow {
  /** `accountId|position key`. */
  id: string;
  accountId: string;
  accountName: string;
  position: PlannedPosition;
  /** The statement's holding, for its name, plan and option and Change. */
  item: FundItem;
  /** Distinct statement holdings combined under the chosen asset. */
  items: FundItem[];
  fund: ChosenFund;
  /** Who chose its asset: found automatically on AMFI, remembered, or chosen in this review. */
  by: "auto" | "before" | "you";
  name: string;
  /** The name in accessible names, numbered when another row has the same one. */
  label: string;
  /** "812.300 units", "40 shares". */
  units: string;
  cost?: { total: string; from: CostFrom };
  /** Notes about the row that aren't choices, such as a price saved with it. */
  notes: string[];
  /** Changed in this review, so it stays shown. */
  touched: boolean;
}

/** The cost editor that's open, and what's typed in it. */
export interface CostEditing {
  rowId: string;
  draft: string;
  error: boolean;
}

export interface ReadyHandlers {
  ids: (row: ReadyRow, item?: FundItem) => { change: string; cost: string; field: string };
  label: (row: ReadyRow, item: FundItem) => string;
  editing?: CostEditing;
  /** The row whose Change is open, by its id. */
  changing?: string;
  changingItem?: string;
  /** "Save or cancel this edit first." beside the open edit. */
  nag: boolean;
  onChange: (row: ReadyRow, item?: FundItem) => void;
  onCost: (row: ReadyRow) => void;
  onDraft: (draft: string) => void;
  onSaveCost: () => void;
  onCancelCost: () => void;
  /** The holding's Change panel, in place. */
  changePanel: (row: ReadyRow) => ReactNode;
}

const BY = { auto: "", before: " · chosen before", you: " · chosen by you" };

/** The plan and option badges of the chosen result: a listing's own, or the statement's for its prices. */
function chosenPlan(row: ReadyRow) {
  if (row.item.noun !== "fund") return undefined;
  if (row.fund.statementPrices) return statementPlan(row.item);
  const name = listingName(row.fund);
  return name ? planAndOption(name) : undefined;
}

function Source({ ctx, row, handlers }: { ctx: AddonContext; row: ReadyRow; handlers: ReadyHandlers }) {
  const source = usePricesFrom(ctx, row.item, row.fund);
  const ids = handlers.ids(row);
  return (
    <span className="text-muted-foreground text-sm">
      {/* Keeps its place while the pricing mode is read. */}
      {source ?? "Prices from…"}
      {BY[row.by]} ·{" "}
      <LinkButton
        id={ids.change}
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

/** A combined row still lets each of its other statement holdings choose a different asset. */
export function OtherChanges({ row, handlers }: { row: ReadyRow; handlers: ReadyHandlers }) {
  return row.items.filter((item) => item.key !== row.item.key).map((item) => (
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
  ));
}

function CostLine({ row, handlers }: { row: ReadyRow; handlers: ReadyHandlers }) {
  const ids = handlers.ids(row);
  const editing = handlers.editing?.rowId === row.id ? handlers.editing : undefined;
  if (editing) {
    const errorId = `${ids.field}-error`;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={ids.field} className="font-medium">
          Total purchase cost of these {row.units} (₹)
          <span className="sr-only">, {row.label}</span>
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={ids.field}
            className="w-40 tabular-nums"
            inputMode="decimal"
            value={editing.draft}
            aria-invalid={editing.error || undefined}
            aria-describedby={editing.error ? errorId : undefined}
            onChange={(event) => handlers.onDraft(event.target.value)}
            onKeyDown={(event) => {
              // The focus moves to the cost's button, which the key's keypress would then press.
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              if (event.key === "Enter") handlers.onSaveCost();
              else handlers.onCancelCost();
            }}
          />
          <Button type="button" size="sm" onClick={handlers.onSaveCost}>
            Save<span className="sr-only"> purchase cost: {row.label}</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={handlers.onCancelCost}>
            Cancel<span className="sr-only"> purchase cost: {row.label}</span>
          </Button>
        </div>
        {editing.error && (
          <p id={errorId} className="text-destructive text-sm">
            {COST_HINT}
          </p>
        )}
        {handlers.nag && <p className="text-warning text-sm">Save or cancel this edit first.</p>}
      </div>
    );
  }
  const { cost } = row;
  if (!cost && !row.accountId) {
    // Not in a snapshot that's worked out, so there's no cost to add to yet.
    return <span className="text-warning text-sm">Purchase cost missing: gains will look too high.</span>;
  }
  if (!cost) {
    return (
      <span className="text-warning text-sm">
        Purchase cost missing: gains will look too high ·{" "}
        <LinkButton id={ids.cost} type="button" aria-label={`Add cost: ${row.label}`} onClick={() => handlers.onCost(row)}>
          Add cost
        </LinkButton>
      </span>
    );
  }
  const from = { statement: "from your statement", wealthfolio: "from your earlier holdings", face: "from the face value", typed: "added by you" }[cost.from];
  return (
    <span className="text-muted-foreground text-sm">
      Purchase cost {rupees(cost.total)}, {from}
      {cost.from !== "statement" && (
        <>
          {" "}·{" "}
          <LinkButton id={ids.cost} type="button" aria-label={`Edit: purchase cost of ${row.label}`} onClick={() => handlers.onCost(row)}>
            Edit
          </LinkButton>
        </>
      )}
    </span>
  );
}

/** Every printed plan that differs from the listing chosen for a combined position. */
export function planWarnings(row: ReadyRow) {
  return [...new Set([
    planConflict(row.fund, statementPlan(row.item)),
    ...row.position.lines.flatMap(({ holding }) => holding.kind === "fund"
      ? [planConflict(row.fund, planAndOption(holding.name, holding.cut))] : []),
  ].filter((warning): warning is string => !!warning))];
}

/** The row's name, badges, warnings, price source and cost: its header cell, or the top of its card. */
function RowHead({ ctx, row, handlers }: { ctx: AddonContext; row: ReadyRow; handlers: ReadyHandlers }) {
  const statement = statementPlan(row.item);
  const own = chosenPlan(row);

  const currency = otherCurrency(row.fund.quoteCcy);
  const listed = row.fund.statementPrices ? undefined : listingName(row.fund);
  return (
    // A long name with no spaces wraps in the stacked list; break-word, unlike anywhere, leaves the
    // table's column widths as they are.
    <div className="grid gap-1" style={{ overflowWrap: "break-word" }}>
      <span>
        <span className="font-semibold">{row.name}</span>
        {own && <PlanBadges own={own} statement={statement} />}
        <CurrencyBadge fund={row.fund} />
      </span>
      {!sameName(listed ?? row.name, row.item.name) && <span className="text-muted-foreground text-sm">On your statement: {row.item.name}</span>}
      {planWarnings(row).map((warning) => <span key={warning} className="text-warning text-sm">{warning}</span>)}
      {currency && <span className="text-warning text-sm">{currency}</span>}
      <Source ctx={ctx} row={row} handlers={handlers} />
      <OtherChanges row={row} handlers={handlers} />
      {handlers.nag && handlers.changing === row.id && <span className="text-warning text-sm">Save or cancel this edit first.</span>}
      <CostLine row={row} handlers={handlers} />
      {row.notes.map((note, i) => (
        <span key={i} className="text-muted-foreground text-xs">
          {note}
        </span>
      ))}
    </div>
  );
}

const missingCost = (row: ReadyRow) => !row.cost;

/**
 * Every holding that will be saved, with its source, units, value and purchase cost: a table from the
 * `sm` width, a stacked list below it. Grouped by account when they go to more than one. With more than
 * five rows, only the first three, rows with a missing cost and rows just changed show until Show all.
 */
export function ReadyTable({
  ctx,
  rows,
  date,
  wide,
  showAll,
  onShowAll,
  showAllId,
  handlers,
}: {
  ctx: AddonContext;
  rows: ReadyRow[];
  date: string;
  wide: boolean;
  showAll: boolean;
  onShowAll: () => void;
  showAllId: string;
  handlers: ReadyHandlers;
}) {
  const accounts = [...new Set(rows.map((r) => r.accountId))];
  const grouped = accounts.length > 1;
  const open = (row: ReadyRow) => handlers.editing?.rowId === row.id || handlers.changing === row.id;
  const visible = showAll || rows.length <= 5
    ? rows
    : rows.filter((row, i) => i < 3 || missingCost(row) || row.touched || open(row));
  const more = rows.length - visible.length;
  const groups = grouped
    ? accounts.filter((id) => visible.some((r) => r.accountId === id)).map((id) => ({ id, title: `To ${rows.find((r) => r.accountId === id)!.accountName}`, rows: visible.filter((r) => r.accountId === id) }))
    : [{ id: "", title: "", rows: visible }];
  const value = `Value on ${shortDate(date)}`;
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
          <Fragment key={group.id}>
            {group.title && <p className="text-muted-foreground text-sm font-medium">{group.title}</p>}
            <ul className="grid gap-3" aria-label={group.title || "Holdings ready to save"}>
              {group.rows.map((row) => (
                <li key={row.id} className="grid gap-1 rounded-md border p-3">
                  <RowHead ctx={ctx} row={row} handlers={handlers} />
                  <span className="text-muted-foreground text-sm">
                    Units: <span className="text-foreground tabular-nums">{row.units}</span> · {value}:{" "}
                    <span className="text-foreground tabular-nums">{row.position.value ? rupees(row.position.value) : ""}</span>
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
            <TableHead>Fund or share</TableHead>
            <TableHead className="text-end">Units</TableHead>
            <TableHead className="text-end">{value}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <Fragment key={group.id}>
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
                    <td className="p-2 text-end align-top tabular-nums whitespace-nowrap">{row.units.replace(/ (units|shares|bonds)$/, "")}</td>
                    <td className="p-2 text-end align-top tabular-nums whitespace-nowrap">{row.position.value ? rupees(row.position.value) : ""}</td>
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
