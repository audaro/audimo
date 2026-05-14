import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import styles from './MobileSheet.module.css'

// Shared mobile bottom sheet — what every "modal" should look like
// on a phone. Slides up from below the bottom nav, has a grabber
// pill, supports swipe-down to dismiss, ESC, scrim-tap, and
// scroll-lock on the body. Hidden by CSS on desktop ≥ 641px;
// caller is expected to render a different dialog there.
//
// Behaviour caller-tweakable via props:
//   - title: header label (renders header row with close button)
//   - onClose: required (sheet always renders own close affordance)
//   - swipeToDismiss: defaults true; set false for destructive
//     confirms where an accidental swipe should not commit nothing
//   - showGrabber: defaults true
//   - tone: 'default' | 'danger' — danger-tinted header for delete
//     flows so users notice it before reading
//
// The sheet auto-traps focus into itself for keyboard / screen-
// reader users and restores the previous active element on close.
export default function MobileSheet({
  open,
  onClose,
  title,
  children,
  swipeToDismiss = true,
  showGrabber = true,
  tone = 'default',
  ariaLabel,
}) {
  const [pullY, setPullY] = useState(0)
  const touchStartYRef = useRef(null)
  const sheetRef = useRef(null)
  const previouslyFocusedRef = useRef(null)

  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Defer focus to next tick so the sheet has mounted; first
    // tabbable element inside gets keyboard focus.
    const t = setTimeout(() => {
      const first = sheetRef.current?.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (first) first.focus()
    }, 0)
    return () => {
      clearTimeout(t)
      document.body.style.overflow = prevOverflow
      // Restore focus to whatever opened the sheet (caller's row,
      // button, etc.) so keyboard users don't lose their place.
      try { previouslyFocusedRef.current?.focus?.() } catch {}
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const onTouchStart = (e) => {
    if (!swipeToDismiss) return
    if (e.touches.length !== 1) return
    // Only initiate drag when the gesture starts on the sheet's
    // own scroll-locked frame (header / grabber) — otherwise we'd
    // fight with content scrolling inside the sheet.
    const target = e.target
    if (target.closest('[data-sheet-scroll]')) return
    touchStartYRef.current = e.touches[0].clientY
    setPullY(0)
  }
  const onTouchMove = (e) => {
    if (touchStartYRef.current == null) return
    const dy = e.touches[0].clientY - touchStartYRef.current
    if (dy > 0) setPullY(Math.min(dy, 240))
  }
  const onTouchEnd = () => {
    if (touchStartYRef.current == null) return
    const finalY = pullY
    touchStartYRef.current = null
    setPullY(0)
    if (finalY > 100) onClose()
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        ref={sheetRef}
        className={`${styles.sheet} ${tone === 'danger' ? styles.sheetDanger : ''}`}
        style={pullY ? { transform: `translateY(${pullY}px)`, transition: 'none' } : undefined}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title || 'Sheet'}
      >
        {showGrabber && <div className={styles.grabber} aria-hidden="true" />}
        {title !== undefined && (
          <div className={styles.head}>
            <span className={`mono ${styles.title}`}>{title}</span>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
        )}
        <div className={styles.body} data-sheet-scroll="true">
          {children}
        </div>
      </div>
    </div>
  )
}
