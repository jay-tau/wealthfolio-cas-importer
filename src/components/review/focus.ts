import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusDropped } from "../../lib/focus";

/**
 * The Review screen's one status region and its focus moves. `announce` says what changed, read out
 * afresh even when it's the same text. `focusSoon` moves the focus once the element is on screen:
 * always for `force`, else only when the control pressed went away (`focusDropped`) or still holds
 * the focus while its request completes. An element with `data-focus-first` passes the focus to its
 * first radio, button or input.
 */
export function useReviewFocus() {
  const [said, setSaid] = useState("");
  const sayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const announce = (text: string) => {
    setSaid("");
    clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(text), 60);
  };
  useEffect(() => () => clearTimeout(sayTimer.current), []);

  const pendingFocus = useRef<{ id: string; force: boolean; origin?: Element | null; until: number } | null>(null);
  // A render runs the effect below even when nothing else changes, as for Go to the question.
  const [, focusRender] = useState(0);
  const focusSoon = (target: string, force = false, origin?: Element | null) => {
    pendingFocus.current = { id: target, force, origin, until: Date.now() + 5000 };
    focusRender((n) => n + 1);
  };
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    const element = document.getElementById(pending.id);
    if (!element) return;
    pendingFocus.current = null;
    if (!pending.force && !focusDropped() && !(document.hasFocus() && pending.origin === document.activeElement)) return;
    const first = element.dataset.focusFirst ? element.querySelector<HTMLElement>("[role=radio], button, input") : null;
    (first ?? element).focus();
    (first ?? element).scrollIntoView?.({ block: "nearest" });
  });
  return { said, announce, focusSoon };
}
