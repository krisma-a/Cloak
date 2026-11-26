// What to tell the person when the cloud draft fails. Pure (no Firebase), so a test can run in Node. The SDK reports a
// refused or failed call as an error whose message and fields carry the HTTP status ("[429 ]", "RESOURCE_EXHAUSTED"),
// so this looks for those signs without depending on the SDK's error classes. Nothing here reads or shows any case text.

export type DraftFailure = 'quota' | 'busy' | 'offline' | 'other'

/** Collects the text and status codes an error carries, from the error itself and any details attached to it. */
function signs(error: unknown): { text: string; status: number | null } {
  const parts: string[] = []
  let status: number | null = null
  const read = (value: unknown, depth = 0) => {
    if (depth > 3 || typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    for (const key of ['message', 'code', 'status', 'statusText', 'name']) {
      const field = record[key]
      if (typeof field === 'string') parts.push(field)
      if (typeof field === 'number' && Number.isInteger(field) && field >= 100 && field < 600) status ??= field
    }
    for (const key of ['customErrorData', 'errorDetails', 'cause', 'error']) read(record[key], depth + 1)
  }
  read(error)
  const text = parts.join(' ')
  const inMessage = /\[(\d{3})\b/.exec(text)?.[1] ?? /\bstatus(?: code)?[: ]+(\d{3})\b/i.exec(text)?.[1]
  if (status === null && inMessage) status = Number(inMessage)
  return { text, status }
}

/** Which kind of failure this is: over the quota (429), the service is busy (503 and friends), no connection, or other. */
export function classifyDraftFailure(error: unknown, online = true): DraftFailure {
  const { text, status } = signs(error)
  if (status === 429 || /RESOURCE_EXHAUSTED|too many requests|quota/i.test(text)) return 'quota'
  if (status === 503 || status === 502 || status === 504 || /UNAVAILABLE|overloaded|high demand/i.test(text)) return 'busy'
  if (!online || /failed to fetch|network ?error|network request failed|load failed/i.test(text)) return 'offline'
  return 'other'
}

/** The message for the "Write the draft" screen. Always says the notes are safe, and what to do next. */
export function draftErrorMessage(error: unknown, online = true): string {
  switch (classifyDraftFailure(error, online)) {
    case 'quota':
      return 'Cloak’s free AI allowance is used up for the moment, because everyone testing shares it. Wait about a minute and press “Write the draft” again. If it keeps happening, the daily allowance is spent and comes back after midnight Pacific time. Your notes are safe on this laptop.'
    case 'busy':
      return 'The AI service is busy right now. Wait a moment and press “Write the draft” again. Your notes are safe on this laptop.'
    case 'offline':
      return 'Cloak couldn’t reach the AI service. Check your internet connection and press “Write the draft” again. Your notes are safe on this laptop.'
    default:
      return 'We couldn’t write the draft just now. Your notes are safe on this laptop. Please try again.'
  }
}
