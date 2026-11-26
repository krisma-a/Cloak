// Small helpers for matching text that OCR may have misspelled ("whitield" for "Whitfield"). Pure, tested in Node.

/**
 * How many typos a word of this length may have and still count as the same word: none up to 3 letters, 1 for
 * 4–6 letters, 2 for 7 or more. Short words get none, or they would match half the page.
 */
export function typoBudget(length: number): number {
  if (length >= 7) return 2
  if (length >= 4) return 1
  return 0
}

/**
 * Levenshtein distance between `a` and `b` (insert, delete or change one character = 1), or `max + 1` as soon as
 * it is clear the distance is over `max`, so long strings that are far apart stay cheap.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + cost)
      row.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    previous = row
  }
  return previous[b.length] as number
}

/** True when `word` is `target` with at most typoBudget(target.length) typos. Both should already be lower case. */
export function closeEnough(word: string, target: string): boolean {
  const budget = typoBudget(target.length)
  return editDistance(word, target, budget) <= budget
}
