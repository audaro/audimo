// ──────────────────────────────────────────────────────────────────
// Per-device encryption-at-rest for the addon registry.
//
// Threat model: defend against *casual inspection* of localStorage —
// devtools "Application > Local Storage", screenshots taken with
// devtools open, read-only filesystem grep of the browser's profile
// directory. Anything with full JS execution privileges inside the
// page can still call decryptString() and read the plaintext; that's
// out of scope. OS-level full-disk encryption is the real backstop
// for the on-disk profile case.
//
// The key is AES-GCM 256-bit, marked `extractable: false`, and lives
// in IndexedDB so the browser persists it across page loads but won't
// hand the raw bytes back to JS. Wiping site data evicts the key (and
// the user has to re-add their addons) — that's the same blast
// radius as clearing localStorage today.
// ──────────────────────────────────────────────────────────────────

const DB_NAME = 'tunnel-crypto'
const STORE_NAME = 'keys'
const KEY_ID = 'addon-registry-v1'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

let _keyPromise = null

export function getKey() {
  if (_keyPromise) return _keyPromise
  _keyPromise = (async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('SubtleCrypto unavailable')
    }
    const db = await openDB()
    let key = await idbGet(db, KEY_ID)
    if (!key) {
      key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
      await idbPut(db, KEY_ID, key)
    }
    return key
  })()
  // If the init fails we want the next call to retry (e.g. transient
  // IDB error during incognito init); cache only on success.
  _keyPromise.catch(() => { _keyPromise = null })
  return _keyPromise
}

const _enc = new TextEncoder()
const _dec = new TextDecoder()

function bytesToB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export async function encryptString(plain) {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    _enc.encode(plain),
  )
  return { ct: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv), v: 1 }
}

export async function decryptString(blob) {
  if (!blob || typeof blob !== 'object' || !blob.ct || !blob.iv) return null
  try {
    const key = await getKey()
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(blob.iv) },
      key,
      b64ToBytes(blob.ct),
    )
    return _dec.decode(pt)
  } catch {
    return null
  }
}
