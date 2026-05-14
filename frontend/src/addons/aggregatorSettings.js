// ──────────────────────────────────────────────────────────────────
// Aggregator settings — global filter/sort prefs from a bundle install
// ──────────────────────────────────────────────────────────────────
//
// The hosted audimo-aio configure page lets a user pick global
// filter/sort preferences (FLAC-only, bitrate >= 256, prefer-this-
// rip-source, etc.) that apply across every addon's source results.
// When their bundle lands in the desktop app these preferences are
// persisted here and read by the source-aggregation pipeline.
//
// Why a separate module from `registry`:
//   • registry stores per-addon entries, keyed by addon id. These
//     prefs are global — they apply to the merged result *across*
//     addons. Different concern, different storage.
//   • The shape mirrors what audimo-aio's v2 pipeline accepts
//     server-side, so a future "apply server-side" optimisation
//     (when audimo-aio runs locally as a meta-addon) can use the
//     same JSON without translation.
//
// Storage shape (single key, plain localStorage — these are not
// secrets, they're filter preferences):
//
//   audimo:aggregator_settings = {
//     filters_json:  string  // JSON; see audimo-aio v2 pipeline
//     sort_json:     string  // JSON; ditto
//     merge_sources: string  // "true"/"false" — stringified because
//                            // audimo-aio's _config_from flattens
//                            // every value to string and we want the
//                            // wire shape to be identical at both
//                            // ends
//   }
//
// All three fields are optional and stored verbatim — we don't parse
// them here so a future schema bump on audimo-aio's side doesn't
// require a coordinated frontend change.

const STORAGE_KEY = 'audimo:aggregator_settings'

/**
 * Load the persisted settings. Returns an empty object when nothing
 * is stored yet, so callers don't need a null check.
 * @returns {{filters_json?: string, sort_json?: string, merge_sources?: string}}
 */
export function get() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

/**
 * Persist the settings. Anything other than an object clears the
 * store — that's how a bundle without aggregator_settings leaves
 * the user's prefs in a clean state on next install.
 * @param {object | null | undefined} settings
 */
export function set(settings) {
  try {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    // Only carry the three known keys forward — anything else on the
    // server-side blob is implementation detail of audimo-aio and
    // shouldn't pollute our store.
    const out = {}
    if (typeof settings.filters_json === 'string') out.filters_json = settings.filters_json
    if (typeof settings.sort_json    === 'string') out.sort_json    = settings.sort_json
    if (typeof settings.merge_sources !== 'undefined') {
      // merge_sources is bool-shaped on the wire but reaches us in
      // varied forms — JS true / Python str(True) ("True") / typed
      // "true" / "1" / "yes". Canonicalise here so the orchestrator
      // (and anything else reading get().merge_sources) doesn't have
      // to repeat the check. Older audimo-aio deploys that haven't
      // picked up the wire-format fix still produce a usable value
      // through this path.
      const v = settings.merge_sources
      const truthy = v === true
        || (typeof v === 'string' && ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()))
        || (typeof v === 'number' && v !== 0)
      out.merge_sources = truthy ? 'true' : 'false'
    }
    if (Object.keys(out).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
  } catch {
    // Non-fatal; the settings just don't persist this run. Future
    // bundle installs replace whatever's in storage anyway.
  }
}

/**
 * Wipe persisted settings. Exposed mostly for tests; production
 * code uses `set()` with falsy input which has the same effect.
 */
export function clear() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* no-op */ }
}
