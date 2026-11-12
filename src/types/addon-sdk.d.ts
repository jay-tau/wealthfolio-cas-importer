import "@wealthfolio/addon-sdk";

// Fields of Wealthfolio 3.13.0's import rows that @wealthfolio/addon-sdk 3.12.0 doesn't declare
// (wealthfolio/wealthfolio#2621). Older hosts ignore them.
declare module "@wealthfolio/addon-sdk" {
  interface ActivityImport {
    /**
     * The row's own ID. A row with one is a duplicate of the activity the add-on imported with the
     * same ID into the same account, whatever its values or comment. Stored as
     * `addon:<add-on id>:<ID>` in the activity's `sourceRecordId`.
     */
    sourceRecordId?: string;
    /** Kept in the activity's metadata under `addons[<add-on id>]`. */
    metadata?: Record<string, unknown>;
  }
}
