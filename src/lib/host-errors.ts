/**
 * Whether Wealthfolio refused an activity write because one it saved has the same key: a create
 * whose idempotency key is taken, or an import that another writer got ahead of after its duplicate
 * check. Wealthfolio says so by the rejected call's `code` since version 3.13.1; its messages are
 * localized, so they aren't read, and an older host's error has no code.
 */
export const isDuplicateActivity = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "DUPLICATE_ACTIVITY";
