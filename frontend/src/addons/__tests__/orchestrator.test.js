// Tests for the addon SSE event normalizer.
//
// normalizeStreamEvent is the wire-format contract between addons and
// the frontend. Pinning it here means any change to the addon protocol
// (see docs/ADDON_PROTOCOL.md) requires intentional test updates.
//
// Run with: cd frontend && npm test

import { describe, expect, it } from 'vitest'

import { normalizeStreamEvent } from '../orchestrator.js'

const ADDON = { id: 'audimo-indexers', url: 'http://example.com:9005' }

describe('normalizeStreamEvent', () => {
  it('maps `ready` to status:done with mimeType + streamUrl', () => {
    const out = normalizeStreamEvent(
      {
        type: 'ready',
        stream_url: 'https://debrid.example/audio.flac',
        mime_type: 'audio/flac',
        source_label: 'RD',
      },
      ADDON,
    )
    expect(out.status).toBe('done')
    expect(out.streamUrl).toBe('https://debrid.example/audio.flac')
    expect(out.mimeType).toBe('audio/flac')
    expect(out.source).toBe('RD')
  })

  it('treats `cache_hint` like `ready`', () => {
    const out = normalizeStreamEvent(
      {
        type: 'cache_hint',
        stream_url: 'https://x/y.mp3',
        mime_type: 'audio/mpeg',
      },
      ADDON,
    )
    expect(out.status).toBe('done')
    expect(out.streamUrl).toBe('https://x/y.mp3')
  })

  it('absolutizes a relative stream_url against the addon origin', () => {
    const out = normalizeStreamEvent(
      { type: 'ready', stream_url: '/file?path=abc', mime_type: 'audio/mpeg' },
      ADDON,
    )
    expect(out.streamUrl).toBe('http://example.com:9005/file?path=abc')
  })

  it('passes absolute stream_urls through unchanged', () => {
    const out = normalizeStreamEvent(
      { type: 'ready', stream_url: 'https://cdn/x.mp3' },
      ADDON,
    )
    expect(out.streamUrl).toBe('https://cdn/x.mp3')
  })

  it('maps `progress` to status:downloading with pct/message', () => {
    const out = normalizeStreamEvent(
      { type: 'progress', pct: 42, message: 'Checking RD…' },
      ADDON,
    )
    expect(out.status).toBe('downloading')
    expect(out.pct).toBe(42)
    expect(out.message).toBe('Checking RD…')
  })

  it('maps `error` to status:error with message', () => {
    const out = normalizeStreamEvent(
      { type: 'error', code: 'no_audio', message: 'no audio file' },
      ADDON,
    )
    expect(out.status).toBe('error')
    expect(out.message).toBe('no audio file')
  })

  it('treats `unsupported` as an error and surfaces the message', () => {
    const out = normalizeStreamEvent(
      {
        type: 'unsupported',
        code: 'torrent_no_debrid',
        message: 'peer locally',
      },
      ADDON,
    )
    expect(out.status).toBe('error')
    expect(out.message).toBe('peer locally')
    // `code` is preserved for callers that want to fall through to the
    // local streaming sidecar on `torrent_no_debrid`.
    expect(out.code).toBe('torrent_no_debrid')
  })

  it('falls back to `reason` when `message` is absent', () => {
    const out = normalizeStreamEvent({ type: 'error', reason: 'oops' }, ADDON)
    expect(out.message).toBe('oops')
  })

  it('marks `done` events as done', () => {
    const out = normalizeStreamEvent({ type: 'done' }, ADDON)
    expect(out.status).toBe('done')
  })

  it('passes camelCase already-normalized events through, absolutizing relative streamUrl', () => {
    const out = normalizeStreamEvent(
      { status: 'done', streamUrl: '/relative.mp3' },
      ADDON,
    )
    expect(out.streamUrl).toBe('http://example.com:9005/relative.mp3')
  })

  it('returns non-object inputs unchanged', () => {
    expect(normalizeStreamEvent(null, ADDON)).toBe(null)
    expect(normalizeStreamEvent(undefined, ADDON)).toBe(undefined)
    expect(normalizeStreamEvent('not an event', ADDON)).toBe('not an event')
  })

  it('defaults pct to 100 on ready when none supplied', () => {
    const out = normalizeStreamEvent(
      { type: 'ready', stream_url: 'https://x', mime_type: 'audio/mpeg' },
      ADDON,
    )
    expect(out.pct).toBe(100)
  })

  it('preserves passthrough fields the addon set on ready', () => {
    const out = normalizeStreamEvent(
      {
        type: 'ready',
        stream_url: 'https://x',
        mime_type: 'audio/mpeg',
        info_hash: 'ABC123',
        rd_link: 'magnet:?xt=urn:btih:abc',
        addon_local_file: '/var/foo',
      },
      ADDON,
    )
    expect(out.info_hash).toBe('ABC123')
    expect(out.rd_link).toBe('magnet:?xt=urn:btih:abc')
    expect(out.addon_local_file).toBe('/var/foo')
  })

  it('accepts pre-camelCased inputs (streamUrl/mimeType) for backward compat', () => {
    const out = normalizeStreamEvent(
      {
        type: 'ready',
        streamUrl: 'https://x.mp3',
        mimeType: 'audio/mpeg',
      },
      ADDON,
    )
    expect(out.streamUrl).toBe('https://x.mp3')
    expect(out.mimeType).toBe('audio/mpeg')
  })
})
