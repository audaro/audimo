// Single source of truth for features that are coded but intentionally
// gated until the surrounding story stabilises. Flipping a flag here
// re-enables the corresponding UI + side effects without re-tracing
// every entry point.
//
// PHONE_ACCESS_ENABLED — covers: FirstRun phone-access onboarding step,
// Settings → Phone Access section, Settings → Connected devices
// section, App.jsx ?pair=<token> redemption, the device-list /
// pair-mint background fetches in SettingsView. The Tauri desktop
// command surface and backend pairing routes are left intact (they're
// invisible to users at this gate state and re-enabling is a one-line
// flip).
export const PHONE_ACCESS_ENABLED = true
