/** A row number when names are equal after screen readers collapse their whitespace. */
export function nameNumber(items: readonly { name: string }[], index: number, noun: string) {
  const name = items[index].name.replace(/\s+/g, " ").trim();
  return items.some((other, i) => i !== index && other.name.replace(/\s+/g, " ").trim() === name)
    ? `, ${noun} ${index + 1}` : "";
}
