import { type ReactNode, useId } from "react";
import { Disclosure, LinkButton, WrapButton } from "./parts";

/** One of a question's two answers: its visible label, and the accessible name that says what it acts on. */
export interface Answer {
  label: string;
  /** Starts with `label`, then names what it acts on: "Keep 512.300 units: Fictiva Liquid Fund in CDSL Demat". */
  name: string;
  onClick: () => void;
}

/**
 * A question that only some imports ask, as one card: a plain heading, at most one line of evidence,
 * its two answers, and "Why am I asked?" where the reason isn't obvious. Nothing is chosen until a
 * click answers it, so both answers have the same weight, the safe one first: a filled button would
 * look already chosen.
 */
export function AskCard({
  headingId,
  title,
  target,
  level = 4,
  children,
  main,
  other,
  note,
  caution,
  why,
  disabled,
}: {
  headingId: string;
  title: string;
  /** Names the holding, account or transaction, including its number when names repeat. */
  target: string;
  /** h4, or h5 inside a group of questions under one heading. */
  level?: 4 | 5;
  /** The evidence: one line, or for a saved snapshot, what replacing it changes. */
  children: ReactNode;
  /** The safe answer, first. */
  main: Answer;
  other: Answer;
  /** What the main answer leaves, tied to its button. */
  note?: string;
  /** What the other answer also removes, tied to its button. */
  caution?: string;
  why?: { text: string; open: boolean; onOpenChange: (open: boolean) => void };
  disabled?: boolean;
}) {
  const own = useId();
  const Heading = level === 5 ? "h5" : "h4";
  return (
    <section aria-labelledby={headingId} className="border-warning grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4" style={{ overflowWrap: "anywhere" }}>
      <Heading id={headingId} tabIndex={-1} className="font-semibold">
        {title}
      </Heading>
      <div className="text-muted-foreground grid grid-cols-1 gap-1 text-sm">{children}</div>
      <div className="flex flex-wrap items-center gap-2">
        <WrapButton type="button" variant="outline" disabled={disabled} aria-label={main.name} aria-describedby={note ? `${own}-note` : undefined} onClick={main.onClick}>
          {main.label}
        </WrapButton>
        <WrapButton type="button" variant="outline" disabled={disabled} aria-label={other.name} aria-describedby={caution ? `${own}-caution` : undefined} onClick={other.onClick}>
          {other.label}
        </WrapButton>
        {why && (
          <Disclosure alone label="Why am I asked?" ariaLabel={`Why am I asked? ${title}: ${target}`} open={why.open} onOpenChange={why.onOpenChange}>
            <p className="text-muted-foreground mt-1 border-s-2 ps-3 text-sm">{why.text}</p>
          </Disclosure>
        )}
      </div>
      {note && (
        <p id={`${own}-note`} className="text-muted-foreground text-xs">
          {note}
        </p>
      )}
      {caution && (
        <p id={`${own}-caution`} className="text-muted-foreground text-xs">
          {caution}
        </p>
      )}
    </section>
  );
}

/**
 * An answered question, as one line with Change answer, like a fund question's. The line names the
 * question, so Change answer's name is the line, or `name`: the line with a number when two answered
 * lines read the same.
 */
export function AskAnswered({ text, name, buttonId, warn, onChange }: { text: string; name?: string; buttonId: string; warn?: boolean; onChange: () => void }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span aria-hidden="true" className="text-success">
        ✓
      </span>
      <span className={`min-w-0 flex-1 ${warn ? "text-warning" : ""}`}>{text}</span>
      <LinkButton id={buttonId} type="button" aria-label={`Change answer: ${name ?? text}`} onClick={onChange}>
        Change answer
      </LinkButton>
    </li>
  );
}
