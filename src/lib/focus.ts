import { type RefCallback, type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Moves the focus to the control that takes the place of the one the user pressed, which is gone
 * after the change. Call `expect(key)` before the change, and give each control that can take its
 * place `ref={target(key)}`: the first of them shown after that gets the focus. `expect(null)`
 * drops a change that showed none, such as a failed preview.
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
        element.focus();
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
    const active = document.activeElement;
    if ((active && active !== document.body) || !document.hasFocus()) return;
    (hold.origin.isConnected ? hold.origin : hold.fallback?.current)?.focus();
  }, [busy]);
  return {
    hold: (fallback?: RefObject<HTMLElement | null>) => {
      const origin = document.activeElement;
      held.current = origin instanceof HTMLElement && origin !== document.body ? { origin, fallback } : null;
    },
  };
}
