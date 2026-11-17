import { Alert, AlertDescription, AlertTitle, Button } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { plural } from "../../lib/plural";
import { LinkButton, WrapButton } from "./parts";

/**
 * The Review screen's heading: what the statement covers, where it's from, and Use another file,
 * which asks before discarding the review's changes, or before leaving an unfinished result.
 */
export function ReviewHeader({
  ids,
  title,
  lines,
  changes,
  unfinished = false,
  discard,
  onAnother,
  onDiscard,
  onKeep,
}: {
  ids: { heading: string; another: string; keep: string; discard: string };
  title: string;
  /** The lines under the heading. */
  lines: ReactNode[];
  /** The review's changes, which Use another file asks before discarding; 0 once it's done. */
  changes: number;
  /** The result has unfinished work or checks, including any available retries. */
  unfinished?: boolean;
  /** Whether the discard question is open. */
  discard: boolean;
  /** Use another file, when there's nothing to discard, or the question's Discard or Leave and choose another file. */
  onAnother: () => void;
  /** Use another file with changes to discard: opens the question. */
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={ids.heading} tabIndex={-1} className="text-xl font-semibold">
          {title}
        </h2>
        <LinkButton id={ids.another} alone type="button" onClick={() => (changes > 0 || unfinished ? onDiscard() : onAnother())}>
          Use another file
        </LinkButton>
      </div>
      {lines.map((line, i) => (
        <p key={i} className="text-muted-foreground text-sm">
          {line}
        </p>
      ))}
      {discard && (
        <Alert variant="warning" role="group" aria-labelledby={ids.discard}>
          <AlertTitle id={ids.discard}>{unfinished ? "Leave this unfinished import and choose another file?" : <>Discard your {plural(changes, "change")} and choose another file?</>}</AlertTitle>
          <AlertDescription>
            {unfinished && <p>Leaving gives up any retries available here and the answers they need. What's already saved stays in Wealthfolio.</p>}
            <div className="flex flex-wrap gap-2">
              <Button id={ids.keep} type="button" onClick={onKeep}>
                {unfinished ? "Stay" : "Keep reviewing"}
              </Button>
              <WrapButton type="button" variant="outline" onClick={onAnother}>
                {unfinished ? "Leave and choose another file" : "Discard and choose another file"}
              </WrapButton>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
