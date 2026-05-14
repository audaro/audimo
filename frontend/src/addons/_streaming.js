// ── Core libtorrent streaming server (Stremio-style) ────────────────
//
// The native Audimo app bundles a content-agnostic libtorrent service
// on 127.0.0.1:11471. Any source carrying an info_hash is streamed
// through it directly, bypassing addons — addons just supply pointers
// (infohash, magnet, optional file_idx); core does the peering.
// API shape mirrors Stremio's streaming-server-fork:
//   POST /<infohash>/create
//   GET  /<infohash>/stats.json
//   GET  /<infohash>/<file_idx>

import * as registry from './registry'
import * as client from './client'
import { rewriteAddonHost, _normalizeInfoHash } from './_shared'
import { useStore } from '../store'

// Control-call header helper. On desktop we hit the loopback sidecar
// directly (no auth). On phone we go through /api/torrent on the
// backend, which gates on the regular API key. Resolved lazily per
// call so a re-pair / key rotation takes effect without remounting.
function _streamingFetchHeaders() {
  if (_IS_DESKTOP) return { 'Content-Type': 'application/json' }
  const k = useStore.getState().apiKey || ''
  return {
    'Content-Type': 'application/json',
    ...(k ? { 'X-API-Key': k } : {}),
  }
}

// Append the API key as a query param so HTML5 <audio src="..."> can
// authenticate against the backend proxy (header auth is impossible
// from inside the audio element). Loopback (desktop) needs no auth.
function _streamingUrlWithAuth(url) {
  if (_IS_DESKTOP) return url
  const k = useStore.getState().apiKey || ''
  if (!k) return url
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(k)
}

// Desktop / Tauri shells reach the bundled libtorrent sidecar over
// loopback. Browser-only contexts (phone via LAN, web preview) hit
// the backend-served proxy under /api/torrent that forwards every
// call to the same sidecar — same control surface, same byte
// streaming, but reachable from a phone whose 127.0.0.1 is itself.
const _IS_DESKTOP = typeof window !== 'undefined'
  && !!window.__TAURI_INTERNALS__
export const STREAMING_SERVER_BASE = _IS_DESKTOP
  ? 'http://127.0.0.1:11471'
  : '/api/torrent'
// Audio/video extensions ranked by playability for the "no file_idx
// supplied — pick the best one" fallback. Audio first because Audimo's
// dominant content type is music; video as a fallback for video-track
// addons (e.g. someone installs a Stremio-shaped movie addon).
export const AUDIO_EXTS = [
  '.flac', '.mp3', '.m4a', '.m4b', '.ogg', '.opus', '.aac', '.wav',
]
// Video kept around for the rare audiobook-as-mp4 case, but ranked
// strictly below audio in pickFileIdx — wrongly picking a 105-min
// documentary mp4 when the user clicked a 4-min song is much worse
// than failing the source and letting them pick another.
export const VIDEO_EXTS = ['.mp4', '.mkv', '.webm']
export const PLAYABLE_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]
export const EXT_MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
}

// True if a source SHOULD be played by the bundled streaming server.
// Routes through libtorrent only when no faster path exists:
//
//   * rd_cached sources go to the addon — its /resolve/stream returns
//     the debrid CDN URL synchronously, audio plays in 1-2s instead
//     of the 10-30s of DHT bootstrap + peering libtorrent needs.
//
//   * other addon-side direct URLs (link_type !== "magnet" with a
//     populated link) similarly belong on the addon path — those are
//     pre-resolved already.
//
// Phone / LAN clients no longer fall back to "debrid only" here —
// STREAMING_SERVER_BASE resolves to `/api/torrent` (a backend proxy
// over the same sidecar) when not in Tauri, so torrents stream from
// libtorrent on the user's Mac whether they're sitting at the
// desktop or holding the iPhone.
//
// Everything with an info_hash that isn't rd_cached or already
// debrid-resolved falls through to the core streamer.
export function isCoreStreamableSource(source) {
  if (!source) return false
  const ih = _normalizeInfoHash(source.info_hash || source.infoHash)
  if (!ih) return false
  if (source.rd_cached) return false
  const linkType = (source.link_type || '').toLowerCase()
  if (linkType && linkType !== 'magnet' && source.link) return false
  return true
}

// Pick a file_idx from a stats.json `files` array.
//
// Precedence:
//   1. Caller-supplied `preferred` (the addon's hint, if any).
//   2. Best title-phrase match: file whose basename contains the
//      track title as a contiguous word-boundary phrase. Mirrors the
//      addon's _score_audio_file so the orchestrator picks the same
//      track the addon would have picked. Critical for multi-track
//      releases where "largest playable" routinely picks the wrong
//      song (e.g. clicking "My Own Summer" on a 14-track album would
//      pick the 255 MB closer track instead of the 89 MB target).
//   3. Largest playable file (legacy heuristic — last resort, may
//      give the wrong song but at least produces audio).
export function pickFileIdx(files, preferred, { title = '', artist = '' } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < files.length) {
    return preferred
  }
  const extOf = (p) => {
    const i = (p || '').lastIndexOf('.')
    return i >= 0 ? p.slice(i).toLowerCase() : ''
  }
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const audio = files.filter(f => AUDIO_EXTS.includes(extOf(f.path)))
  // Audio-only torrents are by far the common case for music. Score
  // among audio files first; never fall back to video unless there
  // are NO audio files anywhere AND no title hint matches anything.
  // A torrent like "Don't Stop Believin' Everyman's Journey (2012)"
  // (a documentary about the song) has only a .mp4 — picking it for
  // a music click means the user gets a 105-min film. Better to
  // return null and let the caller skip to the next source.
  const candidates = audio.length ? audio : []
  if (!candidates.length) return null
  const titleNorm = norm(title)
  const titleWords = titleNorm.split(/\s+/).filter(Boolean)
  const artistWords = norm(artist).split(/\s+/).filter(Boolean)
  let best = null
  let bestScore = 0
  for (const f of candidates) {
    const leaf = (f.path || '').split('/').pop()
    const leafNorm = norm(leaf)
    let score = 0
    if (titleNorm && (' ' + leafNorm + ' ').includes(' ' + titleNorm + ' ')) {
      score += 1000  // contiguous-phrase bonus — strongest signal
    } else if (titleNorm && leafNorm.includes(titleNorm)) {
      score += 500   // substring match (no word boundary)
    }
    const leafWords = new Set(leafNorm.split(/\s+/))
    for (const w of titleWords) if (leafWords.has(w)) score += 10
    for (const w of artistWords) if (leafWords.has(w)) score += 5
    const e = extOf(f.path)
    if (e === '.flac') score += 10
    else if (e === '.m4a' || e === '.aac') score += 5
    if (score > bestScore) { bestScore = score; best = f }
  }
  // Phrase or substring match wins outright.
  if (bestScore >= 500) return best.index
  // No real title signal — fall back to largest audio file. Caller
  // should treat this as best-effort (may be wrong song on multi-
  // track releases).
  const largest = [...candidates].sort((a, b) => (b.size || 0) - (a.size || 0))[0]
  return largest ? largest.index : null
}

// Stream a torrent source via the bundled :11471 server. Async
// generator yielding the same `{status, streamUrl, mimeType, pct,
// message}` shape addon-backed resolve.stream emits.
export async function* streamFromCoreServer(source, { signal, track } = {}) {
  const ih = _normalizeInfoHash(source.info_hash || source.infoHash)
  if (!ih) {
    yield { status: 'error', message: 'invalid info_hash' }
    return
  }
  const fileIdxHint = Number.isInteger(source.file_idx) ? source.file_idx
                    : Number.isInteger(source.fileIdx) ? source.fileIdx
                    : null

  // Race a synchronous "is this on debrid right now?" check against
  // libtorrent peering. If the user has a debrid backend configured
  // AND it has the torrent cached (most popular content does), the
  // check returns a CDN URL in 1-2s — instant playback. libtorrent
  // keeps doing its thing in parallel as a fallback for when debrid
  // hasn't seen the file. Whichever produces a playable URL first
  // wins.
  let debridResult = null   // mutated by the check; checked each loop
  const sourceAddonId = source.addon_id
  if (sourceAddonId) {
    const addon = registry.list().find(a => a.id === sourceAddonId)
    if (addon) {
      client.jsonCall(addon, '/debrid_cache_check', {
        info_hash: ih,
        title: track?.title || '',
        artist: track?.artist || '',
      }, { timeoutMs: 10_000 })
        .then(r => { if (r?.cached && r.url) debridResult = r })
        .catch(() => {})
    }
  }

  // Kick off engine creation; magnet/sources optional but help DHT
  // bootstrap when the infohash isn't well-known. `peers` (when the
  // addon provides addon-verified live peers from a tracker scrape)
  // lets libtorrent skip DHT entirely on the hot path.
  // Magnet sources arrive from the addon under `link` (canonical) or
  // `magnet` (legacy); fall through to a bare magnet so libtorrent
  // can still seed itself with the addon's tracker list. Without
  // this, the .magnet field was always null for the indexers
  // addon's results and the engine had nothing but the infohash to
  // start from.
  const magnetUri =
    source.magnet
    || ((source.link || '').toString().startsWith('magnet:') ? source.link : null)
  const peerList = Array.isArray(source.peers) ? source.peers : []
  const trackerList = source.trackers || source.sources || []
  console.log('[streamFromCoreServer]', { ih, magnet: !!magnetUri, peers: peerList.length, trackers: trackerList.length })
  try {
    await fetch(`${STREAMING_SERVER_BASE}/${ih}/create`, {
      method: 'POST',
      headers: _streamingFetchHeaders(),
      body: JSON.stringify({
        magnet: magnetUri,
        sources: trackerList,
        peers: peerList,
      }),
      signal,
    })
  } catch (e) {
    yield { status: 'error', message: `streaming server unreachable: ${e.message}` }
    return
  }

  // Surface the handoff count so the user (and us, debugging) can
  // tell at a glance whether the addon delivered live peers.
  yield {
    status: 'downloading',
    pct: 0,
    message: peerList.length
      ? `Connecting to ${peerList.length} peer${peerList.length === 1 ? '' : 's'}…`
      : 'Connecting to peers…',
  }

  // Poll stats.json until we have metadata + a head buffer, then yield
  // the playback URL. The HTML5 player will start streaming the
  // file immediately and the streaming server keeps fetching pieces
  // in background as the user listens.
  const statsUrl = `${STREAMING_SERVER_BASE}/${ih}/stats.json`
  // 3 min — matches the streaming server's background metadata-fetch
  // loop. Thin-tracker magnets on a freshly-bootstrapped DHT can take
  // 60-120s; 90s wasn't enough.
  const deadline = Date.now() + 180_000
  let chosenIdx = null
  let chosenName = ''
  let mime = 'application/octet-stream'
  while (Date.now() < deadline) {
    if (signal?.aborted) { yield { status: 'error', message: 'cancelled' }; return }
    // Debrid won the race? Cut over to its CDN URL — instant play,
    // no waiting on libtorrent. The libtorrent engine keeps running
    // in the background; idle reaper will tear it down.
    //
    // Debrid CDN URLs (Real-Debrid especially) come back with
    // Content-Type: application/force-download + Content-Disposition:
    // attachment, which HTML5 audio elements refuse to play inline.
    // Route through the backend's /api/audio/proxy which strips those
    // headers and re-serves with a proper audio mime type.
    if (debridResult) {
      const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
      const proxyBase = isDesktop ? 'http://127.0.0.1:8000' : (window.location.origin || '')
      const proxied = `${proxyBase}/api/audio/proxy?url=${encodeURIComponent(debridResult.url)}`
      yield {
        status: 'done',
        streamUrl: proxied,
        mimeType: debridResult.mime_type || 'audio/mpeg',
        source: debridResult.label || 'Real-Debrid',
        info_hash: ih,
        file_idx: fileIdxHint != null ? fileIdxHint : 0,
      }
      return
    }
    let stats
    try {
      const r = await fetch(statsUrl, { signal, headers: _streamingFetchHeaders() })
      stats = await r.json()
    } catch (e) {
      yield { status: 'error', message: `streaming server: ${e.message}` }
      return
    }
    const peers = stats.num_peers || 0
    if (!stats.has_metadata) {
      yield {
        status: 'downloading',
        pct: 0,
        message: peers
          ? `Searching DHT… (${peers} peer${peers === 1 ? '' : 's'})`
          : 'Searching DHT…',
      }
      await new Promise(r => setTimeout(r, 500))
      continue
    }
    if (chosenIdx === null) {
      chosenIdx = pickFileIdx(stats.files, fileIdxHint, {
        title: track?.title || '',
        artist: track?.artist || '',
      })
      if (chosenIdx === null) {
        yield {
          status: 'error',
          message: 'No audio file in this torrent (likely a video or non-music release) — try another source',
        }
        return
      }
      const file = stats.files[chosenIdx]
      chosenName = (file.path || '').split('/').pop()
      const dot = chosenName.lastIndexOf('.')
      mime = EXT_MIME[dot >= 0 ? chosenName.slice(dot).toLowerCase() : ''] || mime
      // Tell the streaming server which file we picked — lets it start
      // prioritizing that file's pieces immediately. Without this,
      // libtorrent's sequential_download starts at piece 0 of the
      // torrent (often a different track on multi-file albums) and the
      // first piece of the file we want only gets fetched once the
      // audio element issues its first GET range, ~1-3s later. Fire-
      // and-forget; the GET handler also runs prioritization as a
      // safety net so a failed /select doesn't break playback.
      fetch(`${STREAMING_SERVER_BASE}/${ih}/select`, {
        method: 'POST',
        headers: _streamingFetchHeaders(),
        body: JSON.stringify({ file_idx: chosenIdx }),
        signal,
      }).catch(() => {})
    }
    // Hand off as soon as metadata is ready. The streaming server's
    // GET handler does its own piece-deadline + wait-for-piece work,
    // so we don't need to pre-buffer here. Player's media element
    // shows the buffer fill from its first byte-range request onward.
    // _streamingUrlWithAuth appends ?key=<apiKey> on phone so the
    // <audio> element can authenticate against /api/torrent without
    // a header (HTML5 audio src can't carry one).
    const streamUrl = _streamingUrlWithAuth(rewriteAddonHost(`${STREAMING_SERVER_BASE}/${ih}/${chosenIdx}`))
    // Echo the resolved infohash + file_idx back so SourcePicker can
    // bake them into the cache row's source_payload. The addon's
    // source object may have been missing file_idx (only apibay
    // verifies + stamps today; other indexers leave it null) and the
    // backend's bundled-streaming-server save flow needs both.
    //
    // `source` is a STRING label by convention (the rest of the app
    // renders it directly: "Torrent", "Real-Debrid", etc.). Don't
    // shove the source object into that field — it crashes anything
    // that does `<span>{entry.source}</span>`.
    yield {
      status: 'done',
      streamUrl,
      mimeType: mime,
      info_hash: ih,
      file_idx: chosenIdx,
      source: 'Torrent',
    }
    return
  }
  yield { status: 'error', message: 'timed out waiting for torrent metadata' }
}
