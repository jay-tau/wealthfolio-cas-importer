import { Spinner } from "@wealthfolio/ui";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { WrapButton } from "./parts";

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
      const top = header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().height : 0;
      root.style.scrollPaddingTop = `${Math.ceil(top) + 8}px`;
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

/**
 * The bar at the bottom of the add-on's frame: what's left before saving or importing, or what will
 * be saved or imported, and the one button.
 */
export function Footer({
  summaryId,
  lines,
  action,
  go,
}: {
  summaryId: string;
  lines: ReactNode[];
  action: { label: string; disabled: boolean; busy?: boolean; onClick?: () => void };
  /** A second button; `busy` keeps it, and its focus, while what it started runs. */
  go?: { label: string; onClick: () => void; busy?: boolean };
}) {
  const bar = useRef<HTMLDivElement>(null);
  useClearOfStickyBars(bar);
  return (
    <div ref={bar} className="bg-background sticky bottom-0 z-10 grid gap-3 border-t py-3">
      <div id={summaryId} tabIndex={-1} className="grid gap-1 text-sm">
        {lines}
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
      </div>
    </div>
  );
}
