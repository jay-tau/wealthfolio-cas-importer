/** A count and its noun, singular only for one: "1 folio", "0 folios", "2 activities". */
export const plural = (count: number, noun: string, nouns = `${noun}s`) => `${count} ${count === 1 ? noun : nouns}`;
