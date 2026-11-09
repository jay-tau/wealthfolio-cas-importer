import { type RefCallback, useRef } from "react";

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
