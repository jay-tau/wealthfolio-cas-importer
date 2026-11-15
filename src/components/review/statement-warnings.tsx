import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui";
import type { WarningLine } from "../../lib/parse-warnings";

/**
 * What casparser couldn't read cleanly, above Save to: each warning in the Review screen's words,
 * with what to do. An unrecognised one keeps casparser's text, selected whole with one click so it
 * can be copied and reported.
 */
export function StatementWarnings({ lines, before }: { lines: WarningLine[]; before: "importing" | "saving" }) {
  if (!lines.length) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>{`Check these against the PDF before ${before}`}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc ps-4">
          {lines.map((line) => (
            <li key={`${line.text}\n${line.message ?? ""}`}>
              {line.text}
              {line.message && (
                <>
                  {" "}
                  <code className="select-all">{line.message}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
