import type { Account } from "@wealthfolio/addon-sdk";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@wealthfolio/ui";

/**
 * A remembered account that can't be chosen now: its name, unless Wealthfolio no longer lists it,
 * and whether it's hidden or archived there. Without either state, it tracks the wrong thing.
 */
export interface Ignored {
  name?: string;
  state?: string;
}

/** Why a remembered account is ignored. `mode` finishes "which …" for one that tracks the wrong thing. */
export function ChooseAgain({ ignored, mode }: { ignored: Ignored | undefined; mode: string }) {
  if (!ignored) return null;
  const account =
    ignored.name === undefined
      ? "an account that's no longer available"
      : `${ignored.name}, which ${ignored.state ? `is ${ignored.state} in Wealthfolio` : mode}`;
  return <p className="text-muted-foreground w-full text-sm">Chosen before: {account}, so choose again.</p>;
}

const SAME_AS_PAN = "same-as-pan";
/**
 * Wealthfolio's CSS gives every span and div overflow-wrap: break-word, which still sizes a select or its list to fit
 * a long account name without spaces, past a narrow card or window. There's no class for anywhere.
 */
const WRAP_ANYWHERE = { overflowWrap: "anywhere" } as const;

export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  inherit,
  leaveOut,
  leaveOutLabel = "Leave out",
  leaveOutFirst = false,
  describedBy,
}: {
  id: string;
  accounts: Account[];
  /** Empty inherits when `inherit` is given; null shows that nothing is chosen yet. */
  value: string | null | undefined;
  onChange: (accountId: string) => void;
  /** Offer "the PAN's account", which is the empty choice. */
  inherit?: string;
  /** Offer leaving it out, with this value. */
  leaveOut?: string;
  leaveOutLabel?: string;
  /** List leaving it out before the accounts. */
  leaveOutFirst?: boolean;
  /** The id of a line that says what the choice does. */
  describedBy?: string;
}) {
  const out = leaveOut ? [{ value: leaveOut, label: leaveOutLabel }] : [];
  const items = [
    ...(inherit ? [{ value: SAME_AS_PAN, label: inherit }] : []),
    ...(leaveOutFirst ? out : []),
    ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` })),
    ...(leaveOutFirst ? [] : out),
  ];
  return (
    <Select
      items={items}
      value={value === null ? null : value || (inherit ? SAME_AS_PAN : null)}
      onValueChange={(next) => onChange(next === SAME_AS_PAN || next === null ? "" : next)}
    >
      {/* As wide as its choice, from 18rem (or the card's width, if narrower) to the card's width, wrapping past that.
          The add-on has no CSS, so only classes in Wealthfolio's apply: there's none for the minimum, and cn keeps both
          h-auto and h-input-height, whose rule comes later, hence the style. `line-clamp-none` isn't there either, but
          it makes cn drop the value's one-line clamp and flex classes. */}
      <SelectTrigger
        id={id}
        aria-describedby={describedBy}
        className="w-fit min-h-input-height py-1.5 whitespace-normal text-start *:data-[slot=select-value]:line-clamp-none"
        style={{ minWidth: "min(18rem, 100%)", height: "auto" }}
      >
        <SelectValue placeholder="Choose an account" style={WRAP_ANYWHERE} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <span style={WRAP_ANYWHERE}>{item.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
