import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import useIsMobile from '../hooks/useIsMobile'
import MobileSheet from './MobileSheet'
import styles from './ConfirmModal.module.css'

// Promise-based global confirm/prompt dialog. Triggered via
// `useStore.getState().askConfirm({...})` or `askPrompt({...})` —
// see store.js. We render at app root so any code path (including
// non-React helpers like api.js) can request a confirmation without
// coupling to a particular view.
//
// Why not native window.confirm()/prompt()? Tauri's WebView on macOS
// silently no-ops both, so destructive prompts and rename dialogs
// never fired.
export default function ConfirmModal() {
  const dialog = useStore(s => s.confirmDialog)
  const resolveConfirm = useStore(s => s._resolveConfirm)
  const resolvePrompt = useStore(s => s._resolvePrompt)
  const isPrompt = !!(dialog && dialog.input)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!dialog) return
    if (isPrompt) {
      setValue(dialog.input.initial || '')
      // Focus + select on open so the user can immediately overtype.
      // requestAnimationFrame: input doesn't exist until after render.
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      })
    }
  }, [dialog, isPrompt])

  const isMobile = useIsMobile()

  if (!dialog) return null
  const { title, message, confirmLabel, cancelLabel, input, danger } = dialog

  const onCancel = () => {
    if (isPrompt) resolvePrompt(null)
    else resolveConfirm(false)
  }
  const onConfirm = () => {
    if (isPrompt) resolvePrompt(value)
    else resolveConfirm(true)
  }

  // Form body — shared between mobile sheet and desktop dialog so
  // the markup stays in one place. Cancel and confirm get a
  // danger tint and bigger touch targets on mobile via the
  // .sheetBody scope in ConfirmModal.module.css.
  const body = (
    <>
      <div className={styles.title}>{title}</div>
      {message && <div className={styles.message}>{message}</div>}
      {isPrompt && (
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={value}
          placeholder={input.placeholder || ''}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm() }
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          }}
        />
      )}
      <div className={`${styles.actions} ${danger ? styles.actionsDanger : ''}`}>
        <button className={styles.cancel} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className={`${styles.confirm} ${danger ? styles.confirmDanger : ''}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <MobileSheet
        open={true}
        onClose={onCancel}
        title={isPrompt ? 'Edit' : (danger ? 'Confirm' : 'Confirm')}
        tone={danger ? 'danger' : 'default'}
        swipeToDismiss={!danger}
      >
        <div className={styles.sheetBody}>{body}</div>
      </MobileSheet>
    )
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        {body}
      </div>
    </div>
  )
}
