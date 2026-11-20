// Case types and parsing the tagging model's reply. Pure (no Firebase), so it is unit-tested.

export const CASE_TYPES = ['Investigation', 'Accommodation', 'Termination'] as const
export type CaseType = (typeof CASE_TYPES)[number]

/** First case type named in the model's reply, or null if it didn't pick one. */
export function parseCaseType(reply: string): CaseType | null {
  const hit = reply.match(new RegExp(`\\b(${CASE_TYPES.join('|')})\\b`, 'i'))
  return hit ? (CASE_TYPES.find((t) => t.toLowerCase() === hit[1].toLowerCase()) ?? null) : null
}
