import { type RefCallback, type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Whether the focus is still where the control the user pressed left it as it went away or was
 * disabled: on the page's <body>, with this frame focused. Move the focus only then. A focus the
 * user moved meanwhile stays where it is, in this frame or outside it: focusing an element in the
 * add-on's frame would take the focus back from Wealthfolio's own pages, in all three engines.
 */
export function focusDropped() {
  const active = document.activeElement;
  return (!active || active === document.body) && document.hasFocus();
}

/**
 * Moves the focus to the control that takes the place of the one the user pressed, which is gone
 * after the change. Call `expect(key)` before the change, and give each control that can take its
 * place `ref={target(key)}`: the first of them shown after that gets the focus, unless the user
 * moved it meanwhile (see `focusDropped`). `expect(null)` drops a change that showed none, such as
 * a failed preview.
 */
export function useFocusMove() {
  const next = useRef<string | null>(null);
  return {
    expect: (key: string | null) => {
      next.current = key;
    },
    target: (key: string): RefCallback<HTMLElement> => (element) => {
      if (element && next.current === key) {
        next.current = null;
        if (focusDropped()) element.focus();
      }
    },
  };
}

/**
 * Gives the focus back to the control that started a busy action. Disabling the fieldset around
 * the focused control drops the focus to the page's <body>, and enabling it again doesn't bring it
 * back. Call `hold()` as the action starts, from the control's event, before anything is disabled.
 * Once `busy` is false again, a focus still on <body> goes back to that control, or to `fallback`
 * if the action removed it. A focus the user moved meanwhile stays where it is, in this frame or
 * outside it, and so does a focus that wasn't on a control as the action started.
 */
export function useFocusReturn(busy: boolean) {
  const held = useRef<{ origin: HTMLElement; fallback?: RefObject<HTMLElement | null> } | null>(null);
  // As the fieldset is enabled again, before WebKit or the user can move the focus.
  useLayoutEffect(() => {
    const hold = held.current;
    if (busy || !hold) return;
    held.current = null;
    if (!focusDropped()) return;
    (hold.origin.isConnected ? hold.origin : hold.fallback?.current)?.focus();
  }, [busy]);
  return {
    hold: (fallback?: RefObject<HTMLElement | null>) => {
      const origin = document.activeElement;
      held.current = origin instanceof HTMLElement && origin !== document.body ? { origin, fallback } : null;
    },
  };
}
