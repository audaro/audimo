// Single source of truth for the build's version label. Imported by
// Sidebar (chrome version chip), Settings → About (version line),
// and WhatsNewView (header + dismiss-key tag). Bump in lockstep with
// the changelog entries in WhatsNewView when shipping a release.
//
// WHATSNEW_VERSION is intentionally a separate constant so the
// "What's new" sidebar card can re-surface after a copy-only update
// without bumping the user-facing app version.

export const VERSION = '0.4'
export const CODENAME = 'Spruce'
export const RELEASE_DATE = 'May 8, 2026'
export const WHATSNEW_VERSION = '0.4'
