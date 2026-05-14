import styles from './EmptyState.module.css'

// Shared empty-state shape across the rebuilt screens. Pattern:
//   • h2 title (one short noun phrase)
//   • optional body paragraph (1-2 sentences explaining the state)
//   • optional CTA button (action prop) + optional secondary
//
// Replaces the per-file mix of bare <p>s, emoji icons, and ad-hoc
// styles that drifted between Library / Queue / History / etc.
//
//    <EmptyState
//      title="No playlists yet"
//      body="Create one to organize your saved tracks."
//      action={{ label: 'New playlist', onClick: () => setCreating(true) }}
//    />
export default function EmptyState({ title, body, action, secondary, compact = false }) {
  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>
      {title && <h2 className={styles.title}>{title}</h2>}
      {body && <p className={styles.body}>{body}</p>}
      {(action || secondary) && (
        <div className={styles.actions}>
          {action && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={action.onClick}
            >{action.label}</button>
          )}
          {secondary && (
            <button
              type="button"
              className={styles.btn}
              onClick={secondary.onClick}
            >{secondary.label}</button>
          )}
        </div>
      )}
    </div>
  )
}
