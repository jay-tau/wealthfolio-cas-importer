/** A count and its noun, singular only for one: "1 folio", "0 folios", "2 activities". */
export const plural = (count: number, noun: string, nouns = `${noun}s`) => `${count} ${count === 1 ? noun : nouns}`;

/**
 * Every one of a count of two or more, as in "both" or "all 3". Set `start` to capitalize it at the
 * beginning of a sentence.
 */
export const bothOrAll = (count: number, start = false) => {
  const words = count === 2 ? "both" : `all ${count}`;
  return start ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : words;
};

/** Say "the fund", "both funds" or "all 3 funds" with a noun that takes an "s" plural. */
export const every = (count: number, noun: string) => (count === 1 ? `the ${noun}` : `${bothOrAll(count)} ${noun}s`);
