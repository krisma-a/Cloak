// Saves and reads usage records in Firestore (usageEvents/{id}). Thin on purpose: what a record may hold,
// prices and the dashboard sums live in usage.ts (pure, tested). It cannot run under `node --test`
// because it imports ../firebase.

import { addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db, ensureSignedIn } from '../firebase'
import { validateUsageEvent, type UsageEvent, type UsageRow } from './usage.ts'

/** Saves one record. The server adds the time. Throws if the record is not exactly the allowed shape. */
export async function saveUsageEvent(event: UsageEvent): Promise<void> {
  const problem = validateUsageEvent(event)
  if (problem) throw new Error(`Usage record not saved: ${problem}.`)
  await ensureSignedIn()
  await addDoc(collection(db, 'usageEvents'), { ...event, createdAt: serverTimestamp() })
}

/**
 * Live feed of the newest `max` records, newest first. Calls `onRows` now and on every change.
 * Returns a function that stops listening.
 */
export async function watchUsage(
  onRows: (rows: UsageRow[]) => void,
  onError: (message: string) => void,
  max = 2000,
): Promise<() => void> {
  await ensureSignedIn()
  return onSnapshot(
    query(collection(db, 'usageEvents'), orderBy('createdAt', 'desc'), limit(max)),
    { includeMetadataChanges: false },
    (snapshot) => {
      const rows: UsageRow[] = []
      for (const doc of snapshot.docs) {
        // A just-written record has no server time yet; "estimate" gives the local time until it arrives.
        const { createdAt, ...fields } = doc.data({ serverTimestamps: 'estimate' })
        if (validateUsageEvent(fields) !== null) continue // show nothing that is not the fixed shape
        rows.push({ ...(fields as UsageEvent), id: doc.id, createdAt: createdAt instanceof Timestamp ? createdAt.toMillis() : null })
      }
      onRows(rows)
    },
    (error) => onError(error.code ?? 'error'),
  )
}
