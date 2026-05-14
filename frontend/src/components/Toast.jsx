import { useStore } from '../store'
import styles from './Toast.module.css'

export default function Toast() {
  const toast = useStore(s => s.toast)
  const kind = useStore(s => s.toastKind)
  if (!toast) return null
  const cls = kind === 'error' ? `${styles.toast} ${styles.error}` : styles.toast
  return (
    <div className={cls} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      {toast}
    </div>
  )
}
