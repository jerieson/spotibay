const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Lowercases, maps common leetspeak and drops everything that is not a letter or digit. */
export function normalizeForFilter(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[0134578@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function containsFilteredWord(text: string, words: readonly string[]): boolean {
  const haystack = normalizeForFilter(text);
  return words.some((word) => {
    const needle = normalizeForFilter(word);
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** Replaces every whitespace-separated word that contains a filtered word with asterisks. */
export function maskFilteredWords(text: string, words: readonly string[]): string {
  return text.replace(/\S+/g, (token) =>
    containsFilteredWord(token, words) ? '*'.repeat([...token].length) : token,
  );
}
