// Saves and reads the send log in Firestore (users/{uid}/sendLogs/{id}). Thin on purpose: what a record
// may hold, and the CSV, live in sendLog.ts (pure, tested). It cannot run under `node --test`
// because it imports ../firebase.
//
// Only counts and fixed labels are ever written (see sendLog.ts). Every record is checked again right
// before it is saved, and again when it is read back for the CSV.

import { addDoc, collection, getDocs, limit, orderBy, query, serverTimestamp, Timestamp } from 'firebase/firestore'
import { downloadTextFile } from '../download.ts'
import { db, ensureSignedIn } from '../firebase'
import { sendLogsToCsv, validateSendLog, type SendLogRecord, type SendLogRow } from './sendLog.ts'

/** Saves one record. The server adds the time. Throws if the record is not exactly the allowed shape. */
export async function saveSendLog(record: SendLogRecord): Promise<void> {
  const problem = validateSendLog(record)
  if (problem) throw new Error(`Send log not saved: ${problem}.`)
  await addDoc(collection(db, 'users', record.userId, 'sendLogs'), { ...record, createdAt: serverTimestamp() })
}

/** The signed-in user's own logs, newest first. The rules let nobody read anyone else's. */
export async function fetchMySendLogs(max = 1000): Promise<SendLogRow[]> {
  const user = await ensureSignedIn()
  const snapshot = await getDocs(
    query(collection(db, 'users', user.uid, 'sendLogs'), orderBy('createdAt', 'desc'), limit(max)),
  )
  const rows: SendLogRow[] = []
  for (const doc of snapshot.docs) {
    const { createdAt, ...fields } = doc.data()
    if (validateSendLog(fields) !== null) continue // never export anything that is not the fixed shape
    rows.push({
      ...(fields as SendLogRecord),
      id: doc.id,
      createdAt: createdAt instanceof Timestamp ? createdAt.toDate().toISOString() : null,
    })
  }
  return rows
}

/** "Download CSV": saves the signed-in user's send log as a file. Returns how many rows it holds. */
export async function downloadMySendLogsCsv(): Promise<number> {
  const rows = await fetchMySendLogs()
  downloadTextFile(`cloak-send-log-${new Date().toISOString().slice(0, 10)}.csv`, sendLogsToCsv(rows), 'text/csv')
  return rows.length
}
