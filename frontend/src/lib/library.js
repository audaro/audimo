// ──────────────────────────────────────────────────────────────────
// Pure helpers for projecting cache-list rows into a music-library
// shape (Songs / Albums / Artists). The cache row is the single
// source of truth; these functions just regroup and rank.
//
// All inputs are read-only; outputs are fresh arrays/objects so
// React can compare references cheaply.
// ──────────────────────────────────────────────────────────────────

const VARIOUS = 'Various Artists'
const SINGLES = 'Singles'

// Strip featured-artist segments. Per user spec: "songs with features
// should be under the primary artist." Common forms in the wild:
//   "Eminem feat. Rihanna" → "Eminem"
//   "Drake ft Future"      → "Drake"
//   "Drake (feat. 21 Savage)" → "Drake"
// "&" between two names is preserved — that's a duo (Simon & Garfunkel,
// Drake & Future) and the user wants those treated as one artist.
const FEAT_RE = /\s*[\(\[]?\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]]+[\)\]]?/i

export function extractPrimaryArtist(raw) {
  if (!raw) return ''
  let s = String(raw).trim()
  s = s.replace(FEAT_RE, '').trim()
  // Trailing punctuation cleanup ("Drake -" → "Drake").
  s = s.replace(/[\-,;]\s*$/g, '').trim()
  return s
}

// Canonical key for artist deduplication. Strips decorative Unicode
// (☆LiL PEEP☆ → lil peep), collapses whitespace, lowercases. Two
// variants of the same artist that differ only by decoration / case /
// spacing collapse onto the same bucket.
//
// We keep ASCII letters/digits, plain whitespace, and the few
// punctuation marks that legitimately appear in artist names ("." for
// initials, "'" for "O'Connor", "-" for "Tyler-James"). Everything
// else — stars, hearts, brackets, em-dashes, dotted versions of
// dots — is treated as decoration and dropped.
//
// Letters outside ASCII (Björk, Sigur Rós) are preserved by
// normalising to NFC and only stripping the explicit decoration
// codepoints we know are decorative. We don't strip combining
// diacritics — accented variants of a name are intentional.
const DECORATION_CHARS = '★☆♡♥❤♪♫⚡✦✧✨✯✰✪◇◆●○■□▲△▼▽✿❀❁❃❋'
const DECORATION_RE = new RegExp(`[${DECORATION_CHARS}]`, 'g')

export function canonicalArtistKey(name) {
  if (!name) return ''
  return String(name)
    .normalize('NFC')
    .replace(DECORATION_RE, '')
    // Collapse any run of whitespace to a single space.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Among several casings/spellings that bucket onto the same canonical
// key, pick the one a user would recognise. Prefer the variant with
// the fewest decorative characters — given a tie, the one used most
// often. Falls back to the bucket key (already canonical).
function pickArtistDisplay(namesWithCounts, canonKey) {
  let best = null
  let bestScore = -Infinity
  for (const [name, count] of namesWithCounts) {
    // Lower decoration count = better. Higher use count = better.
    const decoration = (name.match(DECORATION_RE) || []).length
    const score = -decoration * 1000 + count
    if (score > bestScore) {
      bestScore = score
      best = name
    }
  }
  return best || canonKey
}

// Cache row → minimal track shape the library views consume.
// `primaryArtist` is the field used for grouping; `artist` keeps
// the original string for display.
// Map a mime type / filename to a human-readable quality label that
// drives the design's "Quality" column and the "Lossless" filter
// chip. The categorization is intentionally coarse — we only need
// LOSSLESS vs. LOSSY for filter logic; the label itself is
// informational.
function qualityFor(mime, filename) {
  const m = (mime || '').toLowerCase()
  const fn = (filename || '').toLowerCase()
  if (m.includes('flac') || fn.endsWith('.flac')) return 'FLAC'
  if (m.includes('wav')  || fn.endsWith('.wav'))  return 'WAV'
  if (m.includes('alac') || fn.endsWith('.m4a') && m.includes('alac')) return 'ALAC'
  if (m.includes('mpeg') || fn.endsWith('.mp3'))  return 'MP3'
  if (m.includes('aac')  || m.includes('mp4')  || fn.endsWith('.m4a') || fn.endsWith('.aac')) return 'AAC'
  if (m.includes('ogg')  || fn.endsWith('.ogg') || fn.endsWith('.opus')) return 'OGG'
  return ''
}

const LOSSLESS_QUALITIES = new Set(['FLAC', 'WAV', 'ALAC'])
export function isLossless(track) { return LOSSLESS_QUALITIES.has(track.quality) }

export function normalizeTrack(entry) {
  const artist = entry.track_artist || ''
  return {
    key: entry.key,
    type: entry.type,
    title: entry.track_title || entry.filename || 'Unknown',
    artist,
    primaryArtist: extractPrimaryArtist(artist) || 'Unknown Artist',
    album: entry.track_album || '',
    cover: entry.albumCover || '',
    source: entry.source || '',
    addonId: entry.addon_id || '',
    category: entry.category || '',
    mimeType: entry.mime_type || '',
    quality: qualityFor(entry.mime_type, entry.filename),
    // Unix epoch seconds; null for pre-history rows.
    addedAt: entry.added_at || null,
    // Path to the on-disk copy when one exists. Empty string =
    // streamed-only (no local copy yet); the per-row Download
    // button shows up only when this is empty.
    localFile: entry.local_file || '',
  }
}

// ─── Grouping ──────────────────────────────────────────────────────

function albumKey(album, artist) {
  // Albums are keyed on (lowercased album name, lowercased primary
  // artist). Two artists with an album of the same name don't collide.
  return `${(album || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`
}

// Group tracks → albums. For each album, the album-level artist is:
//   • The single primaryArtist if all tracks agree.
//   • "Various Artists" otherwise.
// Tracks without an album name go into a per-artist "Singles" bucket
// (#9). Previously they were silently dropped, which left them
// invisible in the Albums tab even though the user clearly has them.
export function groupByAlbum(tracks) {
  const buckets = new Map()
  // Singles: keyed on canonical artist so "☆LiL PEEP☆" + "Lil Peep"
  // share one bucket. A second pass at the end converts each
  // Singles bucket to a synthetic album.
  const singles = new Map()
  for (const t of tracks) {
    if (!t.album) {
      const k = canonicalArtistKey(t.primaryArtist) || 'unknown'
      if (!singles.has(k)) {
        singles.set(k, { names: new Map(), tracks: [], cover: '' })
      }
      const b = singles.get(k)
      b.names.set(t.primaryArtist, (b.names.get(t.primaryArtist) || 0) + 1)
      b.tracks.push(t)
      if (!b.cover && t.cover) b.cover = t.cover
      continue
    }
    // First pass: bucket by album name only so we can detect
    // multi-artist albums after the fact. Track artist variants per
    // album so the displayed artist matches groupByArtist's choice
    // (cleanest form, not first-seen).
    const k = (t.album || '').toLowerCase().trim()
    if (!buckets.has(k)) {
      buckets.set(k, {
        key: k,
        album: t.album,
        artistKeys: new Set(),
        artistNames: new Map(),
        tracks: [],
        cover: '',
      })
    }
    const b = buckets.get(k)
    b.artistKeys.add(canonicalArtistKey(t.primaryArtist) || 'unknown')
    b.artistNames.set(t.primaryArtist, (b.artistNames.get(t.primaryArtist) || 0) + 1)
    b.tracks.push(t)
    if (!b.cover && t.cover) b.cover = t.cover
  }
  const out = []
  for (const b of buckets.values()) {
    // Single-artist (after canonical merge) → pick cleanest variant.
    // Multi-artist → "Various Artists".
    const artist = b.artistKeys.size === 1
      ? pickArtistDisplay(b.artistNames.entries(), [...b.artistKeys][0])
      : VARIOUS
    out.push({
      key: albumKey(b.album, artist),
      album: b.album,
      artist,
      tracks: b.tracks,
      cover: b.cover,
      trackCount: b.tracks.length,
      isSingles: false,
    })
  }
  // Per-artist Singles buckets, surfaced as synthetic albums named
  // "Singles". Skipped if the artist already has 0 albumless tracks.
  for (const [canonKey, b] of singles.entries()) {
    if (b.tracks.length === 0) continue
    const artist = pickArtistDisplay(b.names.entries(), canonKey)
    out.push({
      key: albumKey(SINGLES, artist),
      album: SINGLES,
      artist,
      tracks: b.tracks,
      cover: b.cover,
      trackCount: b.tracks.length,
      isSingles: true,
    })
  }
  // Default order: alphabetical by album name. Track count ranking
  // is now an explicit sort mode in LibraryView; the implicit "most
  // tracks first" was confusing ("Collide With The Sky" / "Views"
  // floated to the top for no obvious reason).
  out.sort((a, b) => a.album.localeCompare(b.album))
  return out
}

// Group tracks → artists. The artist's albums are derived by
// re-running groupByAlbum on just that artist's tracks, so the
// "Various Artists" rule applies consistently. Bucket key is
// canonicalArtistKey (decoration-stripped, whitespace-collapsed,
// lowercased) so "☆LiL PEEP☆" + "Lil Peep" + "lil peep" merge into
// one row, and we pick the cleanest variant for display.
export function groupByArtist(tracks) {
  const buckets = new Map()
  for (const t of tracks) {
    const name = t.primaryArtist
    const key = canonicalArtistKey(name) || 'unknown'
    if (!buckets.has(key)) {
      buckets.set(key, { key, names: new Map(), tracks: [], covers: [] })
    }
    const b = buckets.get(key)
    b.names.set(name, (b.names.get(name) || 0) + 1)
    b.tracks.push(t)
    if (t.cover && b.covers.length < 4) b.covers.push(t.cover)
  }
  const out = []
  for (const b of buckets.values()) {
    const albums = groupByAlbum(b.tracks)
    // Pick the variant a user would recognise — fewest decorative
    // characters, ties broken by usage count.
    const display = pickArtistDisplay(b.names.entries(), b.key)
    out.push({
      key: b.key,
      name: display,
      tracks: b.tracks,
      albums,
      trackCount: b.tracks.length,
      albumCount: albums.length,
      covers: b.covers,
    })
  }
  // Default order: alphabetical by name. Same rationale as
  // groupByAlbum — implicit popularity ranking was surprising.
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// ─── Fuzzy search ──────────────────────────────────────────────────
// Lightweight: substring match (anywhere) gets a high score; a
// subsequence match (chars appear in order, possibly with gaps)
// gets a lower one. Higher score = better. 0 = no match.

function scoreOne(query, text) {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = (text || '').toLowerCase()
  if (!t) return 0
  const idx = t.indexOf(q)
  if (idx === 0) return 100  // prefix match
  if (idx > 0) return 80     // substring
  // Subsequence — every char of q appears in t in order.
  let i = 0
  for (const c of t) {
    if (c === q[i]) i++
    if (i === q.length) return 30
  }
  return 0
}

// Returns the best score across the row's title/artist/album. Also
// scores against the canonical artist key so a search for "lil peep"
// matches "☆LiL PEEP☆".
export function trackScore(query, t) {
  if (!query) return 1
  return Math.max(
    scoreOne(query, t.title),
    scoreOne(query, t.primaryArtist),
    scoreOne(query, t.artist),
    scoreOne(query, t.album),
    scoreOne(query, canonicalArtistKey(t.primaryArtist || t.artist)),
  )
}

export function filterTracksFuzzy(query, tracks) {
  const q = (query || '').trim()
  if (!q) return tracks
  const ranked = []
  for (const t of tracks) {
    const s = trackScore(q, t)
    if (s > 0) ranked.push([s, t])
  }
  ranked.sort((a, b) => b[0] - a[0])
  return ranked.map(r => r[1])
}
