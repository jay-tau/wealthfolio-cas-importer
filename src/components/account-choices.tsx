import type { Account } from "@wealthfolio/addon-sdk";
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@wealthfolio/ui";
import type { AccountLabel } from "../lib/account-labels";
import { LinkButton } from "./review/parts";

/**
 * A remembered account that can't be chosen now: its name, unless Wealthfolio no longer lists it,
 * and whether it's hidden or archived there. `why` gives a reason that can follow "which …" or the
 * account's state. Without either reason, it tracks the wrong thing. With `under`, a folio's different
 * choices under its fund house's names: each choice as the screen names it, with the name. `ids` are
 * the accounts its line names.
 */
export interface Ignored {
  ids?: string[];
  name?: string;
  state?: string;
  why?: string;
  under?: { name: string; choice: string }[];
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Why a remembered account is ignored. `mode` finishes "which …" for one that tracks the wrong
 * thing, unless the account's own `why` says something else.
 */
export function ChooseAgain({ ignored, mode }: { ignored: Ignored | undefined; mode: string }) {
  if (!ignored) return null;
  if (ignored.under) {
    const choices = list(ignored.under.map(({ name, choice }) => `${choice} for ${name}`));
    return <p className="text-muted-foreground w-full text-sm">Chosen before under this fund house's names: {choices}, so choose again.</p>;
  }
  const reason = [ignored.state && `is ${ignored.state} in Wealthfolio`, ignored.why].filter(Boolean).join(" and ");
  const account =
    ignored.name === undefined
      ? "an account that's no longer available"
      : `${ignored.name}, which ${reason || mode}`;
  return <p className="text-muted-foreground w-full text-sm">Chosen before: {account}, so choose again.</p>;
}

/**
 * Under Save to's heading when the Review screen names a numbered account, in Save to's lists or
 * elsewhere (`named`, by ID): where the number comes from, and how to do without it. Said once, with
 * the first such label as its example, the lists' first. Its `id` describes the selects when they
 * list one.
 */
export function NumberedNote({
  id,
  accounts,
  named,
  labels,
}: {
  id: string;
  accounts: Account[];
  named: readonly string[];
  labels: ReadonlyMap<string, AccountLabel>;
}) {
  const example = [...accounts.map((a) => a.id), ...named].map((a) => labels.get(a)).find((l) => l?.numbered);
  if (!example) return null;
  return (
    <p id={id} className="text-muted-foreground text-sm">
      A number after a name, as in {example.text}, is the account's place among the accounts of that name in Wealthfolio under
      Settings → Accounts, counting hidden and archived ones. Giving them different names in Wealthfolio tells them apart.
    </p>
  );
}

/** Whether Save to's lists number an account, so its note describes the selects. */
export const numbers = (accounts: Account[], labels: ReadonlyMap<string, AccountLabel>) => accounts.some((a) => labels.get(a.id)?.numbered);

const SAME_AS_PAN = "same-as-pan";
/**
 * Wealthfolio's CSS gives every span and div overflow-wrap: break-word, which still sizes a select or its list to fit
 * a long account name without spaces, past a narrow card or window. There's no class for anywhere.
 */
const WRAP_ANYWHERE = { overflowWrap: "anywhere" } as const;

/** An account the add-on proposes, created when the import is saved: its select value and name. */
export interface Proposed {
  id: string;
  name: string;
}
/** How a select lists a proposed account, and names it in Same as above. */
export const newLabel = (proposed: Proposed) => `New: ${proposed.name}`;

export function AccountSelect({
  id,
  accounts,
  labels,
  proposed,
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
  /** How the screen names each account: an account another one shares its name with is told apart. */
  labels: ReadonlyMap<string, AccountLabel>;
  /** A new account to offer after the existing ones. */
  proposed?: Proposed;
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
    ...accounts.map((a) => ({ value: a.id, label: labels.get(a.id)?.option ?? `${a.name} (${a.currency})` })),
    ...(proposed ? [{ value: proposed.id, label: newLabel(proposed) }] : []),
    ...(leaveOutFirst ? [] : out),
  ];
  return (
    <Select
      items={items}
      value={value === null ? null : value || (inherit ? SAME_AS_PAN : null)}
      onValueChange={(next) => onChange(next === SAME_AS_PAN || next === null ? "" : next)}
    >
      {/* As wide as its choice, from 18rem (or the card's width, if narrower) to the card's width, wrapping past that.
          The add-on defines no utilities, so only classes in Wealthfolio's apply: there's none for the minimum, and cn keeps both
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

/** An open Rename: the name as typed, and what's wrong with it once Save was pressed. */
export interface Renaming {
  key: string;
  draft: string;
  error?: string;
}

/**
 * Under a select showing a proposed account: what it is, and Rename, which edits its name in place.
 * `ids.rename` takes the focus back after Save or Cancel; `ids.field` gets it when Rename opens.
 */
export function NewAccountLine({
  proposed,
  label,
  created,
  ids,
  editing,
  onRename,
  onDraft,
  onSave,
  onCancel,
}: {
  proposed: Proposed;
  /** What the account is for, for screen readers: "A. Investor's holdings". */
  label: string;
  /** What creates it: saving the holdings, or importing transactions into it. */
  created: "save" | "import";
  ids: { rename: string; field: string };
  editing?: Renaming;
  onRename: () => void;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!editing) {
    return (
      <p className="text-muted-foreground w-full text-sm">
        New · Wealthfolio account, created when you {created} ·{" "}
        <LinkButton id={ids.rename} type="button" aria-label={`Rename the new account ${proposed.name}: ${label}`} onClick={onRename}>
          Rename
        </LinkButton>
      </p>
    );
  }
  const errorId = `${ids.field}-error`;
  return (
    <div className="grid w-full gap-1.5">
      <Label htmlFor={ids.field} className="font-medium">
        Name of the new account<span className="sr-only">: {label}</span>
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={ids.field}
          className="w-72 max-w-full"
          autoComplete="off"
          spellCheck={false}
          value={editing.draft}
          aria-invalid={editing.error ? true : undefined}
          aria-describedby={editing.error ? errorId : undefined}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            // The focus moves to Rename, which the key's keypress would then press.
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            if (event.key === "Enter") onSave();
            else onCancel();
          }}
        />
        <Button type="button" size="sm" onClick={onSave}>
          Save name<span className="sr-only">: {label}</span>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel<span className="sr-only"> renaming: {label}</span>
        </Button>
      </div>
      {editing.error && (
        <p id={errorId} className="text-destructive text-sm">
          {editing.error}
        </p>
      )}
    </div>
  );
}
