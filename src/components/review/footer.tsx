import { Spinner } from "@wealthfolio/ui";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { focusDropped } from "../../lib/focus";
import { plural } from "../../lib/plural";
import { LinkButton, useWide, WrapButton } from "./parts";

/**
 * Keeps what's scrolled into view, such as the focus or a result being clicked, clear of the page's
 * sticky header and this sticky bar, which would otherwise cover it at the frame's top or bottom
 * (WCAG 2.4.11). The frame's own document scrolls, so its root gets the bars' heights as scroll
 * padding while the bar is shown, kept up to date as they change size.
 */
function useClearOfStickyBars(bar: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector("header");
    const update = () => {
      root.style.scrollPaddingTop = `${Math.ceil(headerHeight()) + 8}px`;
      root.style.scrollPaddingBottom = `${Math.ceil(bar.current?.getBoundingClientRect().height ?? 0) + 8}px`;
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (bar.current) observer?.observe(bar.current);
    if (header) observer?.observe(header);
    return () => {
      observer?.disconnect();
      root.style.scrollPaddingTop = "";
      root.style.scrollPaddingBottom = "";
    };
  }, []);
}

/** The height of the page's sticky header, which covers the frame's top, or 0. */
function headerHeight() {
  const header = document.querySelector("header");
  return header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().height : 0;
}

/**
 * Fits the opened details into what's left of the frame below the page's sticky header once the rest
 * of the bar, its brief and buttons, has its room: at most 40% of the frame, and two lines at least.
 * Taller details scroll inside, so the brief and the buttons stay in view in a short frame or at a
 * high zoom. Returns whether they scroll: keyboard users can then focus them to scroll (WCAG 2.1.1).
 * Fitted after each render, and as the bar, the header or the frame resize.
 */
function useFittedDetails(bar: RefObject<HTMLElement | null>, details: RefObject<HTMLElement | null>, open: boolean) {
  const [scrolls, setScrolls] = useState(false);
  const fit = () => {
    const element = details.current;
    if (!element || element.hidden || typeof window === "undefined") return setScrolls(false);
    const rest = (bar.current?.getBoundingClientRect().height ?? 0) - element.getBoundingClientRect().height;
    const room = window.innerHeight - headerHeight() - rest - 8;
    element.style.maxHeight = `${Math.round(Math.max(40, Math.min(window.innerHeight * 0.4, room)))}px`;
    setScrolls(element.scrollHeight > element.clientHeight);
  };
  useLayoutEffect(fit);
  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    const header = document.querySelector("header");
    if (bar.current) observer?.observe(bar.current);
    if (header) observer?.observe(header);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [open]);
  return scrolls;
}

/**
 * The bar's lines in a narrow frame: `brief` says what's left or what will be saved, and `more`, the
 * rest, folds behind Details. `warnings` counts the folded lines that warn, said on Details.
 */
export interface Narrow {
  brief: ReactNode;
  more: ReactNode[];
  warnings: number;
}

/**
 * The bar at the bottom of the add-on's frame: what's left before saving or importing, or what will
 * be saved or imported, and the one button. Below the `sm` width, given `narrow`, it shows only its
 * brief line and the buttons with Details, so it covers little of a narrow window (#238).
 */
export function Footer({
  summaryId,
  lines,
  narrow,
  action,
  go,
}: {
  summaryId: string;
  lines: ReactNode[];
  narrow?: Narrow;
  action: { label: string; disabled: boolean; busy?: boolean; onClick?: () => void };
  /** A second button; `busy` keeps it, and its focus, while what it started runs. */
  go?: { label: string; onClick: () => void; busy?: boolean };
}) {
  const bar = useRef<HTMLDivElement>(null);
  useClearOfStickyBars(bar);
  const wide = useWide();
  const wasWide = useRef(wide);
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = focused.current;
    if (element && !element.isConnected) {
      focused.current = null;
      // Switching layouts moves the links and removes Details; keep their focus in the bar.
      if (wasWide.current !== wide && focusDropped()) document.getElementById(summaryId)?.focus();
    }
    wasWide.current = wide;
  });
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  const fold = !wide && narrow?.more.length ? narrow : undefined;
  const scrolls = useFittedDetails(bar, details, open && !!fold);
  const detailsId = `${summaryId}-details`;
  return (
    <div
      ref={bar}
      onFocusCapture={(event) => { focused.current = event.target; }}
      onBlurCapture={() => { focused.current = null; }}
      className={`bg-background sticky bottom-0 z-10 grid border-t ${fold ? "gap-2 py-2" : "gap-3 py-3"}`}
    >
      {/* A long account or holding name with no spaces wraps rather than running past a narrow frame. */}
      <div className="grid grid-cols-1 gap-1 text-sm" style={{ overflowWrap: "anywhere" }}>
        <div id={summaryId} tabIndex={-1} className="grid grid-cols-1 gap-1">
          {fold ? fold.brief : lines}
        </div>
        {fold && (
          // Shown above the buttons, so Hide details stays where Details was; fitted to the frame.
          <div
            ref={details}
            id={detailsId}
            hidden={!open}
            className="focus-visible:outline-ring grid grid-cols-1 gap-1 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid"
            {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": "Details" } : {})}
          >
            {fold.more}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WrapButton type="button" disabled={action.disabled} onClick={action.onClick}>
          {action.busy && <Spinner />}
          {action.label}
        </WrapButton>
        {go && (
          <WrapButton type="button" variant="outline" aria-disabled={go.busy || undefined} onClick={() => !go.busy && go.onClick()}>
            {go.busy && <Spinner />}
            {go.label}
          </WrapButton>
        )}
        {/* In the buttons' row, which is as tall as Wealthfolio's touch targets anyway, at its end. */}
        {fold && (
          <LinkButton type="button" className="ms-auto" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            {open ? (
              "Hide details"
            ) : (
              <>
                Details
                {fold.warnings > 0 && <span className="text-warning"> · {plural(fold.warnings, "warning")}</span>}
              </>
            )}
          </LinkButton>
        )}
      </div>
    </div>
  );
}
