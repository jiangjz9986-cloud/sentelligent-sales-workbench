const DB_NAME = "sentelligent-bootstrap";
const STORE_NAME = "snapshots";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "account" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function withStore(mode, callback) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = callback(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  }));
}

export function isSnapshotExpired(savedAt, now = Date.now()) {
  if (!savedAt) return true;
  return now - savedAt > TTL_MS;
}

export async function putSnapshot(account, snapshot) {
  const normalizedAccount = String(account ?? "").trim();
  if (!normalizedAccount) return;
  const payload = {
    account: normalizedAccount,
    data: snapshot?.data ?? null,
    summary: snapshot?.summary ?? null,
    savedAt: snapshot?.savedAt ?? Date.now(),
  };
  await withStore("readwrite", (store) => {
    store.put(payload);
  });
}

export async function getSnapshot(account) {
  const normalizedAccount = String(account ?? "").trim();
  if (!normalizedAccount) return null;
  const record = await withStore("readonly", (store) => new Promise((resolve, reject) => {
    const request = store.get(normalizedAccount);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  }));
  if (!record) return null;
  if (isSnapshotExpired(record.savedAt)) {
    return { ...record, expired: true };
  }
  return { ...record, expired: false };
}

export async function clearSnapshot(account) {
  const normalizedAccount = String(account ?? "").trim();
  if (!normalizedAccount) return;
  await withStore("readwrite", (store) => {
    store.delete(normalizedAccount);
  });
}

export async function clearRuntimeCaches() {
  if (typeof caches === "undefined") return;
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => !key.includes("precache"))
    .map((key) => caches.delete(key)));
}
