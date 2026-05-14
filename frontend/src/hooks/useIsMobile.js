import { useEffect, useState } from 'react'

// Single source of truth for the mobile breakpoint in JS. CSS uses
// `@media (max-width: 640px)` everywhere; this matches it so the
// React branch and the styles agree. Updates on resize so a window
// drag at exactly 640px doesn't desync.
//
// Pass an explicit breakpoint to override (e.g. NowPlaying uses
// 900 because its desktop layout needs more horizontal room).
//
// Testing override: setting `window.__forceMobile = true` and
// dispatching a 'forcemobilechange' event flips every consumer
// to mobile without touching the real viewport. Used by the
// Chrome-MCP mobile-emulation harness so the React branch matches
// the injected CSS. No production code path sets the flag.
function readMatch(breakpoint) {
  if (typeof window === 'undefined') return false
  if (window.__forceMobile === true) return true
  if (window.__forceMobile === false) return false
  return window.matchMedia(`(max-width: ${breakpoint}px)`).matches
}

export default function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => readMatch(breakpoint))
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const apply = () => setIsMobile(readMatch(breakpoint))
    apply()
    mq.addEventListener('change', apply)
    window.addEventListener('forcemobilechange', apply)
    return () => {
      mq.removeEventListener('change', apply)
      window.removeEventListener('forcemobilechange', apply)
    }
  }, [breakpoint])
  return isMobile
}
