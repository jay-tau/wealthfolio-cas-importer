import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@wealthfolio/ui";
import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";
import { type AmfiStatus, amfiStatus } from "../lib/amfi";
import { useFocusMove } from "../lib/focus";

/** What the Funds and Holdings cards need to know about AMFI. */
export interface Amfi {
  /** As of the latest check; "unknown" until the first one answers. */
  status: AmfiStatus;
  /**
   * Counts the checks that found AMFI on after one found it off or couldn't tell. Each one searches
   * again for the funds that have no choice yet, since their searches can now find AMFI's scheme.
   */
  searches: number;
}

export interface AmfiCheck extends Amfi {
  /** The banner asking to add AMFI: only while AMFI is off, until "Continue without AMFI". */
  shown: boolean;
  /** "I've added AMFI: check" is waiting for its answer. */
  checking: boolean;
  /** Market data settings were opened from the add-on, so the user can say AMFI was added there. */
  settingsOpened: boolean;
  /** What "I've added AMFI: check" found, while it still holds. */
  outcome: string;
  check: () => void;
  dismiss: () => void;
  openSettings: () => void;
  banner: RefCallback<HTMLElement>;
  /** For the control after the banner, which takes the focus when the banner goes away with it. */
  next: RefCallback<HTMLElement>;
}

const OUTCOMES: Record<AmfiStatus, string> = {
  on: "AMFI added. Funds will be matched with it.",
  off: "AMFI isn't added yet.",
  unknown: "Couldn't check whether AMFI is added. Open CAS Importer again to check.",
};

/**
 * Checks whether AMFI is on when the page opens, each time it's opened again, and when the window gets
 * the focus while AMFI isn't on. Wealthfolio keeps the add-on's frame loaded while another page is
 * shown, and doesn't start the add-on again on return: it passes the page its route's location
 * again, so a new `opened` means the page was opened again.
 */
export function useAmfiCheck(api: AddonContext["api"], opened: unknown): AmfiCheck {
  const [state, setState] = useState({ status: "unknown" as AmfiStatus, searches: 0, answered: false });
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<AmfiStatus | null>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  // Answers can arrive out of order; only the latest check's counts.
  const latest = useRef(0);
  // "I've added AMFI: check" was pressed since the latest answer, so the next one says what it found.
  const asked = useRef(false);
  const status = useRef(state.status);
  status.current = state.status;
  const banner = useRef<HTMLElement | null>(null);
  const focus = useFocusMove();

  const check = useCallback(
    async (ask: boolean) => {
      const id = ++latest.current;
      if (ask) {
        asked.current = true;
        setChecking(true);
        // Cleared first, so the same outcome is read out again.
        setOutcome(null);
      }
      let found: AmfiStatus;
      try {
        found = amfiStatus(await api.market.getProviders());
      } catch {
        found = "unknown";
      }
      if (id !== latest.current) return;
      // The banner shows only while AMFI is off, and can go away with the focus in it.
      if (found !== "off" && banner.current?.contains(document.activeElement)) focus.expect("next");
      setState((s) => {
        if (s.answered && s.status === found) return s;
        return { status: found, answered: true, searches: s.answered && s.status !== "on" && found === "on" ? s.searches + 1 : s.searches };
      });
      if (asked.current) {
        asked.current = false;
        setChecking(false);
        setOutcome(found);
      }
    },
    [api],
  );

  useEffect(() => {
    setDismissed(false);
    setOutcome(null);
    void check(false);
  }, [opened]);

  useEffect(() => {
    const onFocus = () => {
      if (status.current !== "on") void check(false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);

  return {
    status: state.status,
    searches: state.searches,
    shown: state.status === "off" && !dismissed,
    checking,
    settingsOpened,
    outcome: outcome === state.status ? OUTCOMES[outcome] : "",
    check: () => void check(true),
    dismiss: () => {
      focus.expect("next");
      setOutcome(null);
      setDismissed(true);
    },
    openSettings: () => {
      setSettingsOpened(true);
      api.navigation.navigate("/settings/market-data").catch(() => api.toast.error("Couldn't open Market data settings."));
    },
    banner: (element) => {
      banner.current = element;
    },
    next: focus.target("next"),
  };
}

/**
 * Asks to add AMFI before a statement is read, while it's off. Add-ons can't turn a provider on, so
 * it opens Wealthfolio's Market data settings, where AMFI is added with Add provider. Once they've
 * been opened, "I've added AMFI: check" checks without waiting for the page to be shown again.
 */
export function AmfiBanner({ amfi }: { amfi: AmfiCheck }) {
  return (
    <>
      {amfi.shown && (
        <Alert ref={amfi.banner} variant="warning">
          <AlertTitle>Add Indian mutual fund data (recommended)</AlertTitle>
          <AlertDescription>
            <p>
              AMFI gives official fund names and daily prices, so most funds are matched for you. Add it in Wealthfolio's
              Market data settings.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant={amfi.settingsOpened ? "outline" : "default"} onClick={amfi.openSettings}>
                Open Market data settings
              </Button>
              {amfi.settingsOpened && (
                <Button type="button" onClick={amfi.check}>
                  {amfi.checking && <Spinner />}
                  I've added AMFI: check
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={amfi.dismiss}>
                Continue without it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {/* Says what the check found, and stays when the banner goes away. Hidden while empty, but
          still read out, so it takes no space. */}
      <p role="status" className={amfi.outcome ? "text-muted-foreground text-sm" : "sr-only"}>
        {amfi.outcome}
      </p>
    </>
  );
}
