import styles from './Monogram.module.css'

// Audimo-wide cover-art fallback. Replaces emoji-glyph fallbacks
// (🎵 / 💿 / 📖 / ☁️) with a monogrammed accent-tan square that fits
// the brutalist palette and conveys identity at a glance.
//
// `text` should be the artist or title — we extract the first letter
// of the first word, optionally combined with the first letter of the
// second word for two-letter monograms when the source has a clear
// two-token shape ("Lil Peep" → LP, "Madonna" → M).
//
// Variants:
//   size   — 'sm' | 'md' | 'lg'  (CSS scales font + radius)
//   shape  — 'square' (default) | 'circle' (used for artist avatars)
export default function Monogram({ text = '', size = 'md', shape = 'square', className = '', style = {} }) {
  const initials = pickInitials(text)
  const cls = [
    styles.mono,
    styles[`size_${size}`] || '',
    shape === 'circle' ? styles.circle : '',
    className,
  ].filter(Boolean).join(' ')
  return (
    <div className={cls} style={style} aria-label={text || 'placeholder'}>
      <span className={styles.letters}>{initials}</span>
    </div>
  )
}

function pickInitials(s) {
  if (!s) return '·'
  const cleaned = String(s).trim().replace(/^the\s+/i, '')
  const tokens = cleaned.split(/[\s\-_]+/).filter(Boolean)
  if (tokens.length === 0) return '·'
  const first = (tokens[0][0] || '').toUpperCase()
  if (tokens.length === 1) return first
  // Two-token names get the second initial too — but only if both are
  // letters (so "Eminem (2008)" stays as "E", not "E2").
  const second = (tokens[1][0] || '')
  if (/[A-Za-z]/.test(second)) return (first + second.toUpperCase())
  return first
}
