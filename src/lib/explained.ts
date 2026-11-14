/**
 * An error whose message says, in the user's words, why something couldn't be worked out and what to
 * do about it. The Review screen shows it under its own sentence; any other error's message is only
 * logged, since it's worded for the code.
 */
export class Explained extends Error {}

/** The line a failure adds under the screen's own sentence: an `Explained` error's message, if any. */
export const explanation = (error: unknown) => (error instanceof Explained ? error.message : "");
