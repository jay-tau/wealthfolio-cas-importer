import { list } from "./asks.ts";
import { plural } from "./plural.ts";

// How the Review screen counts its open questions. The count button, the status line and the bar
// count them all; the questions section counts only its own cards, so where some are under Save to,
// it's named for what it holds and the others say what the count includes.

/** The open questions, by where they're asked. */
export interface OpenQuestions {
  /** An account to choose under Save to, or a bank account to choose again: one question however many. */
  account: boolean;
  /** Payment checks under Save to. */
  checks: number;
  /** Open cards in the questions section. */
  cards: number;
  /** Whether each of those cards asks which fund a holding is. */
  fundsOnly: boolean;
}

export const questionTotal = (q: OpenQuestions) => (q.account ? 1 : 0) + q.checks + q.cards;

/**
 * What the count includes, when it's more than the questions section's cards: "the account choice
 * and 5 fund questions", "the payment check and 2 other questions". Undefined when they're all cards.
 */
export function questionParts(q: OpenQuestions) {
  if (!q.account && !q.checks) return undefined;
  return list([
    ...(q.account ? ["the account choice"] : []),
    ...(q.checks ? [q.checks === 1 ? "the payment check" : `${q.checks} payment checks`] : []),
    ...(q.cards ? [plural(q.cards, q.fundsOnly ? "fund question" : "other question")] : []),
  ]);
}

/**
 * The questions section's heading: "Questions for you" while it has every open question, else what
 * its cards ask, as `questionParts` names them.
 */
export const questionsHeading = (q: OpenQuestions) =>
  (q.account || q.checks) && q.cards ? (q.fundsOnly ? "Fund questions" : "Other questions") : "Questions for you";
