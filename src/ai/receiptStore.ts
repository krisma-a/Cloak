// The browser's receipt store: IndexedDB and nothing else. Receipts are never written to
// localStorage, sessionStorage, Firestore or the console. Pure logic is in receiptLog.ts.

import { type LocalReceipt, newestFirst, type ReceiptStore } from './receiptLog.ts'

const DB_NAME = 'cloak-receipts'
const STORE = 'receipts'

let opening: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'))
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
  })
  // If opening failed, try again next time instead of keeping the failure.
  opening.catch(() => {
    opening = undefined
  })
  return opening
}

/** Runs one request in its own transaction and resolves when the transaction has committed. */
async function run<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = make(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB request failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted'))
  })
}

export const indexedReceiptStore: ReceiptStore = {
  async put(receipt: LocalReceipt): Promise<void> {
    await run('readwrite', (store) => store.put(receipt))
  },
  async list(): Promise<LocalReceipt[]> {
    const all = (await run('readonly', (store) => store.getAll())) as LocalReceipt[]
    return newestFirst(all)
  },
}

/** Deletes every receipt on this device. The user's choice; nothing calls it automatically. */
export async function clearReceipts(): Promise<void> {
  await run('readwrite', (store) => store.clear())
}
