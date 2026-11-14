/**
 * One line at the top of the Review screen while searching keeps failing: the latest search was
 * rejected. Always in the page, so the line is read out when it appears.
 */
export function SearchDown({ down }: { down: boolean }) {
  return (
    <p role="status" className={down ? "text-warning text-sm" : "sr-only"}>
      {down ? "Searching isn't working right now. Funds already matched aren't affected." : ""}
    </p>
  );
}
