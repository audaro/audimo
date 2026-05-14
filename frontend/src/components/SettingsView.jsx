import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { useStore } from '../store'
import { authFetch, apiUrl, pairMint } from '../api'
import * as desktop from '../desktop'
import * as registry from '../addons/registry'
import * as orchestrator from '../addons/orchestrator'
import { PHONE_ACCESS_ENABLED } from '../featureFlags'
import { KEYBINDINGS } from '../shortcuts'
import useIsMobile from '../hooks/useIsMobile'
import MobileSheet from './MobileSheet'
import Icon from './Icon'
import styles from './SettingsView.module.css'
import { VERSION, CODENAME, RELEASE_DATE } from '../version'

// Settings — design v2 layout. Left nav (sticky, 200px) + content
// pane. Sections track the design verbatim; functional bits the app
// already has (ListenBrainz token, debrid sweep, dead-track scan)
// fold into the closest tab. Tabs without real functionality yet
// (Appearance, parts of General) render explicit "coming soon" or
// readonly stubs rather than fake controls.
//
// Field / Toggle / Select / RangeSlider primitives match the design's
// shapes so future settings drop in without restyling.

const NAV = [
  { id: 'playback',   label: 'Playback' },
  { id: 'library',    label: 'Library & sync' },
  ...(PHONE_ACCESS_ENABLED && desktop.isDesktop()
    ? [{ id: 'phone', label: 'Phone access' }]
    : []),
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy',    label: 'Privacy' },
  // Keyboard shortcuts are meaningless on a touch device — gate the
  // tab so mobile users don't see a section they can't act on. The
  // ⌘K binding still works in the desktop WebView; this only hides
  // the listing UI.
  { id: 'keyboard',   label: 'Keyboard', desktopOnly: true },
  { id: 'advanced',   label: 'Advanced' },
  // Install — phone-only entry. Lets the user mint a long-lived pair
  // URL to drop into their iPhone home screen. Hidden on desktop
  // because the Phone Access tab covers the same flow from there.
  { id: 'install',    label: 'Add to home screen', mobileOnly: true },
  { id: 'about',      label: 'About' },
]

const DEFAULT_MUSIC_ROOT = '~/Music/Audimo'
const DEFAULT_AUDIOBOOK_ROOT = '~/Audiobooks'

export default function SettingsView() {
  const {
    showToast,
    audioQualityPref, setAudioQualityPref,
    defaultSourceAddonId, setDefaultSourceAddonId,
    addons,
    bumpCacheVersion,
    setView,
    theme, setTheme,
    crossfadeSec, setCrossfadeSec,
    outputDeviceId, setOutputDeviceId,
  } = useStore()

  // Privacy preferences. Loaded once on mount; saving fires a Tauri
  // command that persists state.json. Changes that affect the
  // streaming-sidecar process (any libtorrent toggle) need an app
  // restart to take effect — surfaced via a hint string in the UI.
  const [privacy, setPrivacy] = useState(null)
  useEffect(() => {
    if (!desktop.isDesktop()) return
    let cancelled = false
    desktop.getPrivacy()
      .then(p => { if (!cancelled) setPrivacy(p) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const savePrivacy = async (patch) => {
    if (!privacy) return
    const next = { ...privacy, ...patch }
    setPrivacy(next)
    try {
      await desktop.setPrivacy(next)
      showToast('Privacy settings saved · restart Audimo to apply', 5000)
    } catch (e) {
      showToast(`Could not save privacy: ${e.message || e}`)
    }
  }

  // Output device enumeration. Refreshed on mount + when the user
  // (re)opens the Settings tab. Devices come back with `deviceId`
  // (which we pass to audio.setSinkId) and `label` (which is empty
  // until the user has granted permission to enumerate — Chrome
  // and Safari both hide labels for privacy). The default label is
  // a synthesised "System default" since the empty deviceId is the
  // common case.
  const [outputDevices, setOutputDevices] = useState([])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : null
        if (!md || typeof md.enumerateDevices !== 'function') return
        const all = await md.enumerateDevices()
        if (cancelled) return
        const outs = all
          .filter(d => d.kind === 'audiooutput')
          .map(d => ({
            id: d.deviceId || '',
            // ``label`` is "" until the user grants enumerate
            // permission. The fallback string keeps the option
            // selectable; the user can still pick by position.
            label: d.label || (d.deviceId ? `Output ${d.deviceId.slice(0, 8)}` : 'System default'),
          }))
        setOutputDevices(outs)
      } catch {
        // No support / denied — leave the list empty so the select
        // hides and the saved deviceId continues to apply when the
        // user moves to a browser that does support setSinkId.
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [tab, setTab] = useState('playback')
  const isMobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)

  const sourceAddons = (addons || []).filter(a =>
    a.enabled !== false &&
    Array.isArray(a.manifest?.capabilities) &&
    a.manifest.capabilities.includes('resolve.sources')
  )

  // ── ListenBrainz ────────────────────────────────────────────
  const [lbStatus, setLbStatus] = useState({ enabled: false, username: null })
  const [lbToken, setLbToken] = useState('')
  const [lbSaving, setLbSaving] = useState(false)
  const [lbError, setLbError] = useState('')
  useEffect(() => {
    authFetch('/api/settings/listenbrainz')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setLbStatus(d))
      .catch(() => {})
  }, [])

  // ── Auto-download toggle ────────────────────────────────────
  // When on, the Player fires a /api/cache/{key}/download in the
  // background after a track starts playing, teeing the streamed
  // bytes to disk. Per-user setting; default off so casual sampling
  // doesn't fill the disk.
  const [autoDownload, setAutoDownload] = useState(false)
  useEffect(() => {
    authFetch('/api/settings/auto_download')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setAutoDownload(!!d.enabled))
      .catch(() => {})
  }, [])
  const setAutoDownloadAndPersist = async (next) => {
    setAutoDownload(next)
    try {
      await authFetch('/api/settings/auto_download', {
        method: 'POST',
        body: JSON.stringify({ enabled: next }),
      })
    } catch {}
  }

  // ── AssemblyAI API key (chapter detection) ─────────────────
  const [aaiStatus, setAaiStatus] = useState({ enabled: false })
  const [aaiToken, setAaiToken] = useState('')
  const [aaiSaving, setAaiSaving] = useState(false)
  const [aaiError, setAaiError] = useState('')
  useEffect(() => {
    authFetch('/api/settings/assemblyai')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setAaiStatus(d))
      .catch(() => {})
  }, [])
  const saveAaiToken = async (newToken) => {
    setAaiSaving(true)
    setAaiError('')
    try {
      const r = await authFetch('/api/settings/assemblyai', {
        method: 'POST',
        body: JSON.stringify({ token: newToken }),
      })
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.json())?.detail || '' } catch {}
        throw new Error(detail || `HTTP ${r.status}`)
      }
      const body = await r.json()
      setAaiStatus(body)
      setAaiToken('')
      showToast(body.enabled ? 'AssemblyAI key saved' : 'AssemblyAI key cleared')
    } catch (e) {
      setAaiError(e.message || 'Could not save key')
    } finally {
      setAaiSaving(false)
    }
  }
  const saveLbToken = async (newToken) => {
    setLbSaving(true)
    setLbError('')
    try {
      const r = await authFetch('/api/settings/listenbrainz', {
        method: 'POST',
        body: JSON.stringify({ token: newToken }),
      })
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.json())?.detail || '' } catch {}
        throw new Error(detail || `HTTP ${r.status}`)
      }
      const body = await r.json()
      setLbStatus(body)
      setLbToken('')
      showToast(body.enabled ? `Connected as ${body.username}` : 'ListenBrainz disconnected')
    } catch (e) {
      setLbError(e.message || 'Could not save token')
    } finally {
      setLbSaving(false)
    }
  }

  // ── Debrid sweep + dead-track scan (Advanced tab) ───────────
  const [sweepState, setSweepState] = useState('idle')
  const [sweepResult, setSweepResult] = useState(null)
  // Human-readable bytes — used for the reclaim-disk readout.
  const _fmtBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
    return `${n} B`
  }
  const runReclaimSweep = async () => {
    setSweepState('running'); setSweepResult(null)
    try {
      const r = await orchestrator.sweepCachedToDebrid()
      setSweepResult(r)
      if (r.deleted > 0) {
        const freed = _fmtBytes(r.bytesFreed)
        showToast(`✓ Reclaimed ${r.deleted} file${r.deleted === 1 ? '' : 's'} · freed ${freed}`)
        bumpCacheVersion()
      } else if (r.total === 0) {
        showToast('No tracks to reclaim — nothing in your library has a remote source to fall back on')
      } else {
        showToast(`Checked ${r.total}, none could be safely reclaimed`)
      }
    } catch (e) {
      showToast(`Sweep failed: ${e.message || e}`)
    } finally {
      setSweepState('done')
    }
  }
  const [scanState, setScanState] = useState('idle')
  const [deadEntries, setDeadEntries] = useState([])
  const scanDeadTracks = async () => {
    setScanState('scanning'); setDeadEntries([])
    try {
      const resp = await authFetch('/api/library/dead_tracks')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const body = await resp.json()
      setDeadEntries(body.dead || []); setScanState('done')
    } catch (e) {
      showToast(`Scan failed: ${e.message || e}`); setScanState('idle')
    }
  }
  const pruneDeadTracks = async () => {
    if (deadEntries.length === 0) return
    const ok = await useStore.getState().askConfirm({
      title: `Remove ${deadEntries.length} dead track${deadEntries.length === 1 ? '' : 's'}?`,
      message: 'These library entries point to files that no longer exist on disk.',
      confirmLabel: 'Remove', cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
    let removed = 0
    for (const e of deadEntries) {
      try {
        const r = await authFetch('/api/cache/remove', {
          method: 'DELETE',
          body: JSON.stringify({ key: e.key }),
        })
        if (r.ok) removed += 1
      } catch {}
    }
    showToast(`Removed ${removed} of ${deadEntries.length}`)
    setDeadEntries([]); setScanState('idle'); bumpCacheVersion()
  }

  // ── Folders ─────────────────────────────────────────────────
  const openFolder = async (path) => {
    try {
      const r = await authFetch('/api/library/open_folder', {
        method: 'POST', body: JSON.stringify({ path }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        showToast(j.detail || `Open failed (HTTP ${r.status})`)
      }
    } catch (e) {
      showToast(`Open failed: ${e.message || e}`)
    }
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div className={styles.statLine}>Local · stored at ~/.audimo</div>
        <h1 className={styles.title}>Settings</h1>
      </header>

      <div className={styles.body}>
        {isMobile ? (
          // Mobile: single section visible, dropdown opens a sheet
          // listing every section. Tab strips ate too much vertical
          // space and the wrapping chip variant felt noisy.
          <>
            <button
              type="button"
              className={styles.navDropdown}
              onClick={() => setNavOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={navOpen ? 'true' : 'false'}
            >
              <span className={styles.navDropdownLabel}>
                {(NAV.find(n => n.id === tab) || {}).label || 'Settings'}
              </span>
              <Icon name="chevD" size={16} className={styles.navDropdownChev} />
            </button>
            <MobileSheet
              open={navOpen}
              onClose={() => setNavOpen(false)}
              title="Section"
            >
              <ul className={styles.navSheetList}>
                {NAV
                  .filter(n => !(n.desktopOnly && !desktop.isDesktop()))
            .filter(n => !(n.mobileOnly && desktop.isDesktop()))
                  .map(n => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={`${styles.navSheetRow} ${tab === n.id ? styles.navSheetRowActive : ''}`}
                        onClick={() => { setTab(n.id); setNavOpen(false) }}
                      >
                        <span>{n.label}</span>
                        {tab === n.id && <Icon name="check" size={18} />}
                      </button>
                    </li>
                  ))}
              </ul>
            </MobileSheet>
          </>
        ) : (
          <nav className={styles.nav}>
            {NAV
              .filter(n => !(n.desktopOnly && !desktop.isDesktop()))
            .filter(n => !(n.mobileOnly && desktop.isDesktop()))
              .map(n => (
                <button
                  key={n.id}
                  type="button"
                  className={`${styles.navItem} ${tab === n.id ? styles.navItemActive : ''}`}
                  onClick={() => setTab(n.id)}
                >{n.label}</button>
              ))}
          </nav>
        )}

        <div className={styles.content}>
          {tab === 'playback' && (
            <Section title="Playback" desc="How tracks are decoded, mixed and transitioned. All processing happens locally.">
              <Field
                label="Preferred audio quality"
                hint="Biases the source picker's order — high-quality sources float to the top. Doesn't filter results."
              >
                <Pills
                  value={audioQualityPref}
                  onChange={setAudioQualityPref}
                  options={[
                    { id: 'flac', label: 'FLAC' },
                    { id: '320',  label: '320 kbps' },
                    { id: 'any',  label: 'No preference' },
                  ]}
                />
              </Field>
              <Field
                label="Default playback source"
                hint="When set, clicking a search result skips the source picker and plays directly from this addon. Use the + button on a search row to add a song after listening."
              >
                <Select
                  value={defaultSourceAddonId || ''}
                  onChange={setDefaultSourceAddonId}
                  options={[
                    { id: '', label: 'Show source picker (default)' },
                    ...sourceAddons.map(a => ({
                      id: a.id, label: a.manifest?.name || a.id,
                    })),
                  ]}
                />
              </Field>
              <Field
                label="Crossfade"
                hint="Overlap the last seconds of one music track with the start of the next. Audiobooks and podcasts are never crossfaded."
              >
                <Pills
                  value={String(crossfadeSec)}
                  onChange={(v) => setCrossfadeSec(Number(v))}
                  options={[
                    { id: '0', label: 'Off' },
                    { id: '2', label: '2 s' },
                    { id: '4', label: '4 s' },
                  ]}
                />
              </Field>
              {outputDevices.length > 0 && (
                <Field
                  label="Output device"
                  hint="Route playback to a specific audio device — USB DAC, AirPlay, Bluetooth headphones. Falls back to the OS default when the chosen device disconnects."
                >
                  <Select
                    value={outputDeviceId || ''}
                    onChange={setOutputDeviceId}
                    options={[
                      { id: '', label: 'System default' },
                      ...outputDevices
                        .filter(d => d.id && d.id !== 'default')
                        .map(d => ({ id: d.id, label: d.label })),
                    ]}
                  />
                </Field>
              )}
            </Section>
          )}

          {tab === 'library' && (
            <Section title="Library & sync" desc="Where local files live and how listening data syncs.">
              <Field label="Music folder" hint="Where Audimo saves downloaded music.">
                <PathRow value={DEFAULT_MUSIC_ROOT} onOpen={() => openFolder(DEFAULT_MUSIC_ROOT)} />
              </Field>
              <Field label="Audiobook folder" hint="Where audiobook downloads go.">
                <PathRow value={DEFAULT_AUDIOBOOK_ROOT} onOpen={() => openFolder(DEFAULT_AUDIOBOOK_ROOT)} />
              </Field>
              <Field
                label="ListenBrainz scrobbling"
                hint={lbStatus.enabled ? (
                  <>
                    Listens submit automatically once played past 50% (or 4 minutes).
                    {' '}Connected as <strong>{lbStatus.username}</strong>.
                  </>
                ) : (
                  <>
                    Submit listens to your ListenBrainz account once played past 50% (or 4 minutes).
                    {' '}
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); desktop.openExternalUrl('https://listenbrainz.org/profile') }}
                      className={styles.link}
                    >Get a token →</a>
                  </>
                )}
              >
                {lbStatus.enabled ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => saveLbToken('')}
                    disabled={lbSaving}
                  >{lbSaving ? 'Disconnecting…' : 'Disconnect'}</button>
                ) : (
                  <div className={styles.lbRow}>
                    <input
                      type="password"
                      className={styles.input}
                      value={lbToken}
                      onChange={e => setLbToken(e.target.value)}
                      placeholder="ListenBrainz token"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => saveLbToken(lbToken.trim())}
                      disabled={lbSaving || !lbToken.trim()}
                    >{lbSaving ? 'Verifying…' : 'Connect'}</button>
                    {lbError && <div className={styles.errorText}>{lbError}</div>}
                  </div>
                )}
              </Field>
              <Field
                label="Auto-download to disk"
                hint={
                  <>
                    Save every played track to{' '}
                    <span className={styles.muted}>~/Music/Audimo</span> in the
                    background, so future plays serve from disk and resume
                    works offline. Off by default — single tracks can still
                    be downloaded with the ↓ button on a library row.
                  </>
                }
              >
                <button
                  type="button"
                  className={`${styles.toggleBtn} ${autoDownload ? styles.toggleBtnOn : ''}`}
                  onClick={() => setAutoDownloadAndPersist(!autoDownload)}
                  aria-pressed={autoDownload}
                >
                  <span className={styles.toggleKnob} />
                  <span className={styles.toggleLabel}>{autoDownload ? 'On' : 'Off'}</span>
                </button>
              </Field>
              <Field
                label="AssemblyAI API key"
                hint={aaiStatus.enabled ? (
                  <>
                    Configured. Powers the "Detect chapters" button on
                    downloaded audiobooks — uploads the audio,
                    transcribes it, returns chapter timestamps + titles
                    grounded in actual word positions. Audio leaves
                    your device when you trigger detection.
                    {' '}<a
                      href="#"
                      onClick={(e) => { e.preventDefault(); desktop.openExternalUrl('https://www.assemblyai.com/app/account') }}
                      className={styles.link}
                    >Manage account →</a>
                  </>
                ) : (
                  <>
                    Optional. Enables a "Detect chapters" button on the
                    audiobook detail page. Costs ~$0.27/hr of audio
                    (typical 10hr book = ~$2.70). Free trial includes
                    $50 credit, enough for ~13 typical books. Your
                    key, your quota.
                    {' '}<a
                      href="#"
                      onClick={(e) => { e.preventDefault(); desktop.openExternalUrl('https://www.assemblyai.com/app/account') }}
                      className={styles.link}
                    >Get a key →</a>
                  </>
                )}
              >
                {aaiStatus.enabled ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => saveAaiToken('')}
                    disabled={aaiSaving}
                  >{aaiSaving ? 'Clearing…' : 'Clear key'}</button>
                ) : (
                  <div className={styles.lbRow}>
                    <input
                      type="password"
                      className={styles.input}
                      value={aaiToken}
                      onChange={e => setAaiToken(e.target.value)}
                      placeholder="paste your AssemblyAI API key"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => saveAaiToken(aaiToken.trim())}
                      disabled={aaiSaving || !aaiToken.trim()}
                    >{aaiSaving ? 'Verifying…' : 'Save'}</button>
                    {aaiError && <div className={styles.errorText}>{aaiError}</div>}
                  </div>
                )}
              </Field>
            </Section>
          )}

          {tab === 'phone' && (
            <PhoneAccessSection showToast={showToast} />
          )}

          {tab === 'appearance' && (
            <Section title="Appearance" desc="Density, color, and motion.">
              <Field label="Theme" hint="Light reuses the same accent color, just rebalanced for contrast on light surfaces.">
                <Select
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { id: 'dark', label: 'Dark · ember' },
                    { id: 'light', label: 'Light' },
                  ]}
                />
              </Field>
            </Section>
          )}

          {tab === 'privacy' && (
            <Section
              title="Privacy"
              desc="Controls over peer-to-peer visibility for the libtorrent streaming sidecar. Changes take effect after restarting Audimo."
            >
              {!privacy ? (
                <div className={styles.muted}>Loading…</div>
              ) : (
                <>
                  <Field
                    label="Peer streaming sidecar"
                    hint="The bundled libtorrent sidecar on port 11471 streams torrent sources. Turning it OFF means torrent sources stop working — only debrid CDN / addon-direct streams will play. Recommended if you only use debrid-cached playback."
                  >
                    <Pills
                      value={privacy.privacy_no_streaming ? 'off' : 'on'}
                      onChange={(v) => savePrivacy({ privacy_no_streaming: v === 'off' })}
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                    />
                  </Field>
                  <Field
                    label="DHT announces"
                    hint="When on, the sidecar announces every info-hash you play to the global Mainline DHT — this is how thin-tracker magnets bootstrap. Turning it off keeps your play history out of the global DHT but slows down discovery for magnets without working trackers."
                  >
                    <Pills
                      value={privacy.privacy_no_dht ? 'off' : 'on'}
                      onChange={(v) => savePrivacy({ privacy_no_dht: v === 'off' })}
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                    />
                  </Field>
                  <Field
                    label="Local Service Discovery (LSD)"
                    hint="Broadcasts info-hashes on the local network so other clients on the same LAN can peer with you. Off by default for users on shared networks where they don't want torrent activity visible to roommates."
                  >
                    <Pills
                      value={privacy.privacy_no_lsd ? 'off' : 'on'}
                      onChange={(v) => savePrivacy({ privacy_no_lsd: v === 'off' })}
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                    />
                  </Field>
                  <Field
                    label="Peer Exchange (PEX)"
                    hint="Connected peers share peer lists with each other. Turning off reduces how quickly swarms grow but keeps your peer list strictly from trackers + DHT."
                  >
                    <Pills
                      value={privacy.privacy_no_pex ? 'off' : 'on'}
                      onChange={(v) => savePrivacy({ privacy_no_pex: v === 'off' })}
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                    />
                  </Field>
                </>
              )}
            </Section>
          )}

          {tab === 'keyboard' && (
            <Section title="Keyboard" desc="Global &amp; in-app shortcuts.">
              <ShortcutList />
            </Section>
          )}

          {tab === 'advanced' && (
            <Section title="Advanced" desc="For people who read the source.">
              <Field
                label="Reclaim disk"
                hint={
                  <>
                    Free up space by removing local copies of tracks whose original source can still serve them on demand.
                    Run this manually when you're tight on disk.
                  </>
                }
              >
                {sweepState !== 'running' ? (
                  <button type="button" className={styles.btn} onClick={runReclaimSweep}>
                    Reclaim disk now
                  </button>
                ) : (
                  <span className={styles.muted}>Checking each local track…</span>
                )}
                {sweepState === 'done' && sweepResult && (
                  <div className={styles.muted} style={{ marginTop: 8 }}>
                    Checked {sweepResult.total || 0} · removed {sweepResult.deleted || 0} · kept {sweepResult.kept || 0}
                    {sweepResult.skipped > 0 && ` · skipped ${sweepResult.skipped}`}
                    {sweepResult.bytesFreed > 0 && ` · freed ${_fmtBytes(sweepResult.bytesFreed)}`}
                  </div>
                )}
              </Field>
              <Field
                label="Library cleanup"
                hint='Find library entries whose audio files are gone. "Could not load track" usually means a dead entry.'
              >
                <DeadTracks
                  state={scanState}
                  entries={deadEntries}
                  onScan={scanDeadTracks}
                  onPrune={pruneDeadTracks}
                  onCancel={() => { setScanState('idle'); setDeadEntries([]) }}
                />
              </Field>
              <Field
                label="Duplicate scan"
                hint="Find library rows that look like the same track under different spellings (whitespace, accents, punctuation). Reviews before deleting; the newest of each group is always kept."
              >
                <button
                  type="button"
                  className={styles.btn}
                  onClick={async () => {
                    try {
                      const r = await authFetch('/api/library/duplicates')
                      if (!r.ok) {
                        showToast(`Scan failed: HTTP ${r.status}`, { kind: 'error' })
                        return
                      }
                      const d = await r.json()
                      const groups = d?.groups || []
                      if (groups.length === 0) {
                        showToast('No duplicates found')
                        return
                      }
                      // Build a deletion list: every entry EXCEPT the
                      // newest in each group. Surface a confirm with
                      // a sample so the user knows what's about to go.
                      const toDelete = []
                      for (const g of groups) {
                        for (let i = 1; i < g.length; i++) toDelete.push(g[i])
                      }
                      const sample = toDelete.slice(0, 8).map(r =>
                        `• ${r.title}${r.artist ? ' — ' + r.artist : ''}`
                      ).join('\n')
                      const more = toDelete.length > 8
                        ? `\n…and ${toDelete.length - 8} more`
                        : ''
                      const ok = await useStore.getState().askConfirm({
                        title: `Remove ${toDelete.length} duplicate${toDelete.length === 1 ? '' : 's'}?`,
                        message:
                          `Found ${groups.length} group${groups.length === 1 ? '' : 's'} of duplicates.\n` +
                          `Keeping the most recently added in each group, removing:\n\n${sample}${more}\n\n` +
                          `Local files on disk are preserved — only the library entry is removed.`,
                        confirmLabel: `Remove ${toDelete.length}`,
                        cancelLabel: 'Cancel',
                        danger: true,
                      })
                      if (!ok) return
                      let removed = 0
                      for (const row of toDelete) {
                        try {
                          const rr = await authFetch('/api/cache/remove', {
                            method: 'DELETE',
                            body: JSON.stringify({ key: row.key }),
                          })
                          if (rr.ok) removed++
                        } catch {}
                      }
                      showToast(`Removed ${removed} duplicate${removed === 1 ? '' : 's'}`)
                      bumpCacheVersion()
                    } catch (e) {
                      showToast(`Scan failed: ${e.message || e}`, { kind: 'error' })
                    }
                  }}
                >Scan for duplicates</button>
              </Field>
              <Field
                label="Back up library"
                hint={
                  <>
                    Download a zip of your library, playlists, audiobook
                    progress, podcast subscriptions, and custom images. Encryption
                    keys and addon binaries are excluded — those live in your OS
                    keychain and the addon catalog respectively. Restore by
                    unzipping into <code>~/.audimo</code> on a fresh install.
                  </>
                }
              >
                <a
                  className={styles.btn}
                  href={apiUrl('/api/library/export.zip')}
                  download
                  style={{ textDecoration: 'none' }}
                >Download backup</a>
              </Field>
            </Section>
          )}

          {tab === 'install' && (
            <InstallSection showToast={showToast} />
          )}

          {tab === 'about' && (
            <Section title="About Audimo" desc="Self-hosted music + audiobooks. Plays your local files out of the box. Anything beyond that — sources, lyrics, scrobbling — runs as an addon.">
              <Field label="Version" hint={`Released ${RELEASE_DATE}`}>
                <span className={styles.versionLine}>{VERSION} · {CODENAME}</span>
              </Field>
              <Field label="Updates" hint="Audimo doesn't auto-update — check the release page for new builds.">
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => desktop.openExternalUrl('https://github.com/audaro/audimo/releases')}
                >Check for updates →</button>
              </Field>
              <Field label="Changelog" hint="What landed in this release.">
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => setView('whats-new')}
                >View What's New →</button>
              </Field>
              <Field label="Library" hint="Quick reference numbers from your install.">
                <span className={styles.muted}>
                  {(addons || []).filter(a => a.enabled !== false).length} of {(addons || []).length} addons running
                </span>
              </Field>
              <Field
                label="Privacy"
                hint={
                  <>
                    What leaves your machine and when. Full threat model in{' '}
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); desktop.openExternalUrl('https://github.com/audaro/audimo/blob/main/SECURITY.md') }}
                      className={styles.link}
                    >SECURITY.md →</a>
                  </>
                }
              >
                <div className={styles.muted} style={{ lineHeight: 1.55 }}>
                  <p style={{ margin: '0 0 8px' }}>
                    Audimo runs locally. The only outbound traffic by default is:
                  </p>
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                    <li>
                      <strong>iTunes Search API</strong> — when you search audiobooks
                      or podcasts. Apple sees the query string and your IP.
                    </li>
                    <li>
                      <strong>Deezer API</strong> — when you search artists / albums.
                      Same surface.
                    </li>
                    <li>
                      <strong>Wikipedia</strong> — artist image lookups via the aggregator
                      addon (if installed). One read-only request per artist, cached 24h.
                    </li>
                    <li>
                      <strong>ListenBrainz</strong> — only if you've connected an account.
                      Scrobbles a {'"played"'} record once a track passes 50% / 4 minutes.
                    </li>
                    <li>
                      <strong>RSS feeds you subscribe to</strong> — direct HTTPS to
                      the feed host on refresh.
                    </li>
                    <li>
                      <strong>Addons</strong> — each installed addon runs as a local
                      sidecar and reaches whatever upstream service it's configured for
                      (debrid, indexers, slskd). Audimo core doesn't proxy these.
                    </li>
                    <li>
                      <strong>libtorrent (streaming sidecar)</strong> — DHT / LSD / PEX
                      announces of info-hashes you play. Disable each in{' '}
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); setTab('privacy') }}
                        className={styles.link}
                      >Settings → Privacy</a>.
                    </li>
                  </ul>
                  <p style={{ margin: 0 }}>
                    Audimo has no telemetry, no crash reporter, no analytics. Your
                    library and history never leave this machine.
                  </p>
                </div>
              </Field>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Section + Field primitives ────────────────────────────────
function Section({ title, desc, children }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {desc && <p className={styles.sectionDesc}>{desc}</p>}
      <div className={styles.fields}>{children}</div>
    </section>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <div className={styles.fieldLabel}>{label}</div>
        {hint && <div className={styles.fieldHint}>{hint}</div>}
      </div>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  )
}

function Pills({ value, onChange, options }) {
  return (
    <div className={styles.pills}>
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          className={`${styles.pill} ${value === o.id ? styles.pillActive : ''}`}
          onClick={() => onChange(o.id)}
        >{o.label}</button>
      ))}
    </div>
  )
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      className={styles.select}
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
    >
      {options.map(o => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  )
}

function PathRow({ value, onOpen }) {
  return (
    <div className={styles.inputRow}>
      <input className={styles.input} value={value} readOnly />
      <button type="button" className={styles.btn} onClick={onOpen}>Open</button>
    </div>
  )
}

// ── Phone Access ──────────────────────────────────────────────
// Surfaces the existing pairing + remote-bind plumbing. Desktop-only
// (gated in NAV). The toggle calls into the Tauri shell to mint the
// API key and respawn the backend with 0.0.0.0 binding. Once enabled
// we read reachable URLs (Tailscale + LAN) from the shell, mint a
// short-lived pair token, render it as a QR + copyable URL, and show
// devices that have already redeemed.
function PhoneAccessSection({ showToast }) {
  const [enabled, setEnabled] = useState(null)
  const [busy, setBusy] = useState(false)
  const [net, setNet] = useState(null)
  const [pair, setPair] = useState(null)        // { url, expiresAt }
  const [pairBusy, setPairBusy] = useState(false)
  const [devices, setDevices] = useState([])
  const [qrDataUrl, setQrDataUrl] = useState('')
  // LAN trust — opt-in shortcut: any request from a private IP is
  // auto-authenticated, no pair token needed. Off by default. When
  // on, a phone on the same Wi-Fi can just open the URL and start
  // using the app.
  const [lanTrust, setLanTrust] = useState(null)
  const [lanTrustBusy, setLanTrustBusy] = useState(false)
  // "Save URL for home screen" — a separately-minted, longer-lived
  // pair URL. iOS treats a home-screen PWA as a separate browser
  // instance with its own storage, so the short-lived QR token
  // would already be consumed by the time the user finally taps
  // the icon. This URL gets baked INTO the home-screen bookmark.
  const [homeUrl, setHomeUrl] = useState(null) // { url, expiresAt }
  const [homeBusy, setHomeBusy] = useState(false)
  const tickRef = useRef(null)

  const refreshNet = async () => {
    try { setNet(await desktop.getNetworkInfo()) } catch {}
  }
  const refreshDevices = async () => {
    try {
      const r = await authFetch(apiUrl('/api/devices'))
      if (r.ok) {
        const j = await r.json()
        setDevices(Array.isArray(j.devices) ? j.devices : [])
      }
    } catch {}
  }

  useEffect(() => {
    desktop.getState()
      .then(s => setEnabled(!!s.remote_enabled))
      .catch(() => setEnabled(false))
    refreshNet()
    refreshDevices()
    authFetch(apiUrl('/api/settings/lan_trust'))
      .then(r => r.ok ? r.json() : null)
      .then(d => setLanTrust(!!d?.enabled))
      .catch(() => setLanTrust(false))
  }, [])

  const toggleLanTrust = async () => {
    setLanTrustBusy(true)
    try {
      const r = await authFetch(apiUrl('/api/settings/lan_trust'), {
        method: 'POST',
        body: JSON.stringify({ enabled: !lanTrust }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setLanTrust(!!d.enabled)
    } catch (e) {
      showToast(`Could not update LAN trust: ${e.message || e}`)
    } finally {
      setLanTrustBusy(false)
    }
  }

  // Re-render the pair countdown every second.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!pair) return
    tickRef.current = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tickRef.current)
  }, [pair])

  // Expire local view of the pair link when the TTL runs out.
  useEffect(() => {
    if (!pair) return
    if (now >= pair.expiresAt) {
      setPair(null)
      setQrDataUrl('')
    }
  }, [now, pair])

  const reachableUrl = desktop.pickPhoneUrl(net)

  const toggle = async () => {
    setBusy(true)
    try {
      await desktop.setRemoteEnabled(!enabled)
      setEnabled(!enabled)
      await refreshNet()
      if (enabled) {
        // Just disabled — clear any open pair link.
        setPair(null); setQrDataUrl('')
      }
    } catch (e) {
      showToast(`Phone access toggle failed: ${e.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const generatePairLink = async () => {
    if (!reachableUrl) {
      showToast('No reachable hostname yet — connect to Tailscale or a LAN first.')
      return
    }
    setPairBusy(true)
    try {
      const apiKey = await desktop.getApiKey()
      if (!apiKey) throw new Error('API key missing — toggle remote access off and on again')
      const addons = registry.list()
      const { token, expires_at, ttl_seconds } = await pairMint({
        apiKey,
        addons,
        baseUrl: 'http://127.0.0.1:' + (net?.backend_port || 8000),
      })
      const url = `${reachableUrl}/?pair=${encodeURIComponent(token)}`
      const ttlMs = (ttl_seconds || 90) * 1000
      const expiresAt = (expires_at ? expires_at * 1000 : Date.now() + ttlMs)
      setPair({ url, expiresAt })
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: '#e8b04a', light: '#0000' } })
      setQrDataUrl(dataUrl)
      setNow(Date.now())
      // Devices list updates after the phone redeems — poll a few times.
      let polls = 0
      const poll = setInterval(async () => {
        polls += 1
        await refreshDevices()
        if (polls >= 10) clearInterval(poll)
      }, 3000)
    } catch (e) {
      showToast(`Could not generate pair link: ${e.message || e}`)
    } finally {
      setPairBusy(false)
    }
  }

  // Generate a 7-day pair URL the user can drop into a home-screen
  // bookmark. The PWA standalone WebView opens with empty storage on
  // first launch; App.jsx's existing ?pair=… redemption logic
  // consumes the token and seeds the API key + addons in localStorage
  // on that first run. Subsequent home-screen taps see a normal
  // hydrated session.
  const generateHomeScreenUrl = async () => {
    if (!reachableUrl) {
      showToast('No reachable hostname yet — connect to Tailscale or a LAN first.')
      return
    }
    setHomeBusy(true)
    try {
      const apiKey = await desktop.getApiKey()
      if (!apiKey) throw new Error('API key missing — toggle remote access off and on again')
      const addons = registry.list()
      const { token } = await pairMint({
        apiKey,
        addons,
        baseUrl: 'http://127.0.0.1:' + (net?.backend_port || 8000),
        reusable: true,
      })
      const url = `${reachableUrl}/?pair=${encodeURIComponent(token)}`
      // Reusable tokens don't expire (revocable from Connected
      // devices instead). No countdown to display.
      setHomeUrl({ url, expiresAt: null })
    } catch (e) {
      showToast(`Could not generate home-screen URL: ${e.message || e}`)
    } finally {
      setHomeBusy(false)
    }
  }

  const regenerateKey = async () => {
    if (!confirm('Regenerate the API key? Every paired phone will lose access until you re-pair it.')) return
    try {
      await desktop.regenerateApiKey()
      setPair(null); setQrDataUrl('')
      await refreshDevices()
      showToast('API key regenerated. Re-pair your phones.')
    } catch (e) {
      showToast(`Regenerate failed: ${e.message || e}`)
    }
  }

  const forgetDevice = async (id) => {
    try {
      const r = await authFetch(apiUrl(`/api/devices/${id}`), { method: 'DELETE' })
      if (r.ok) await refreshDevices()
    } catch {}
  }

  const copy = (text) => {
    try {
      navigator.clipboard.writeText(text)
      showToast('Copied')
    } catch {
      showToast('Copy failed')
    }
  }

  const secondsLeft = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0

  return (
    <Section
      title="Phone access"
      desc="Open the same library and addons from your phone's browser. Your desktop must be running and reachable on the same Tailnet (recommended) or LAN."
    >
      <Field
        label="Enable phone access"
        hint="Binds the backend to all network interfaces and mints an API key. Off keeps the backend on loopback only."
      >
        <button
          type="button"
          className={`${styles.toggleBtn} ${enabled ? styles.toggleBtnOn : ''}`}
          onClick={toggle}
          disabled={busy || enabled === null}
          aria-pressed={!!enabled}
        >
          <span className={styles.toggleKnob} />
          <span className={styles.toggleLabel}>{enabled ? 'On' : 'Off'}</span>
        </button>
      </Field>

      {enabled && (
        <>
          <Field
            label="Trust this network (skip pairing)"
            hint="When on, any device on your LAN (RFC1918 / loopback) or Tailnet (100.64.0.0/10) can use the app without a pair token. Convenient at home and via Tailscale; turn off when you don't trust the network (coffee shops, shared Wi-Fi, etc.). Pair tokens still work either way."
          >
            <button
              type="button"
              className={`${styles.toggleBtn} ${lanTrust ? styles.toggleBtnOn : ''}`}
              onClick={toggleLanTrust}
              disabled={lanTrustBusy || lanTrust === null}
              aria-pressed={!!lanTrust}
            >
              <span className={styles.toggleKnob} />
              <span className={styles.toggleLabel}>{lanTrust ? 'On' : 'Off'}</span>
            </button>
          </Field>
          <Field
            label="Reachable at"
            hint="Type any of these into your phone's browser, then scan the QR below to pair."
          >
            {!net ? (
              <span className={styles.muted}>Detecting network…</span>
            ) : reachableUrl ? (
              <div className={styles.inputRow}>
                <input className={styles.input} value={reachableUrl} readOnly />
                <button type="button" className={styles.btn} onClick={() => copy(reachableUrl)}>Copy</button>
              </div>
            ) : (
              <span className={styles.muted}>
                No Tailscale or LAN address detected. Install Tailscale or join a Wi-Fi network so your phone can reach this machine.
              </span>
            )}
            {net && (net.lan_ips?.length > 1 || net.tailscale_ip) && (
              <div className={styles.muted} style={{ marginTop: 6, fontSize: 11 }}>
                Other addresses:{' '}
                {[
                  net.tailscale_hostname && `${net.tailscale_hostname} (Tailscale)`,
                  net.tailscale_ip && `${net.tailscale_ip} (Tailscale IP)`,
                  ...(net.lan_ips || []).map(ip => `${ip} (LAN)`),
                ].filter(Boolean).join(' · ')}
              </div>
            )}
          </Field>

          <Field
            label="Pair a phone"
            hint="Generates a one-shot QR. The link is valid for 5 minutes and works exactly once. If your phone says “Invalid or expired token”, generate a new one."
          >
            {!pair ? (
              <button
                type="button"
                className={styles.btn}
                onClick={generatePairLink}
                disabled={pairBusy || !reachableUrl}
              >{pairBusy ? 'Generating…' : 'Generate pair link'}</button>
            ) : (
              <div>
                {qrDataUrl && (
                  <img
                    src={qrDataUrl}
                    alt="Pair QR"
                    style={{ width: 220, height: 220, background: 'var(--bg)', padding: 8, border: '1px solid var(--line)' }}
                  />
                )}
                <div className={styles.inputRow} style={{ marginTop: 10 }}>
                  <input className={styles.input} value={pair.url} readOnly />
                  <button type="button" className={styles.btn} onClick={() => copy(pair.url)}>Copy</button>
                </div>
                <div className={styles.muted} style={{ marginTop: 6, fontSize: 11 }}>
                  Expires in {secondsLeft}s ·{' '}
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); setPair(null); setQrDataUrl('') }}
                  >Cancel</a>
                </div>
              </div>
            )}
          </Field>

          <Field
            label="Save URL for home screen"
            hint="iOS treats an Add-to-Home-Screen app as a fresh browser — it doesn't share Safari's login. Generate a durable URL, open it in Safari on the phone, then Add to Home Screen. The home-screen icon will always reconnect with this URL; revoke from Connected devices below if you ever need to."
          >
            {!homeUrl ? (
              <button
                type="button"
                className={styles.btn}
                onClick={generateHomeScreenUrl}
                disabled={homeBusy || !reachableUrl}
              >{homeBusy ? 'Generating…' : 'Generate home-screen URL'}</button>
            ) : (
              <div>
                <div className={styles.inputRow}>
                  <input className={styles.input} value={homeUrl.url} readOnly />
                  <button type="button" className={styles.btn} onClick={() => copy(homeUrl.url)}>Copy</button>
                </div>
                <div className={styles.muted} style={{ marginTop: 6, fontSize: 11 }}>
                  Reusable. Revoke from Connected devices below.{' '}
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); setHomeUrl(null) }}
                  >Clear</a>
                </div>
              </div>
            )}
          </Field>

          <Field
            label="Connected devices"
            hint="Phones that have redeemed a pair link on this install. Forgetting a device only removes it from this list — use Regenerate API key below to actually revoke access."
          >
            {devices.length === 0 ? (
              <span className={styles.muted}>None yet. Pair a phone above to see it here.</span>
            ) : (
              <ul className={styles.deadList}>
                {devices.map(d => (
                  <li key={d.id} className={styles.deadItem} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      <span className={styles.deadTitle}>{d.name || 'Device'}</span>
                      {d.paired_at && (
                        <span className={styles.deadArtist}> · paired {new Date(d.paired_at + 'Z').toLocaleString()}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnGhost}`}
                      onClick={() => forgetDevice(d.id)}
                    >Forget</button>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field
            label="Regenerate API key"
            hint="Rotates the shared key. Every paired phone is locked out until you re-pair it. Use this if a device is lost."
          >
            <button type="button" className={styles.btn} onClick={regenerateKey}>Regenerate</button>
          </Field>
        </>
      )}
    </Section>
  )
}

// Mirror of the shortcuts table in the player's "?" panel so users
// who want a quick reference don't have to summon the popover.
// Renders the global keyboard shortcuts from the central
// KEYBINDINGS registry. Any addition there shows up here without
// touching this component — no more outdated hand-maintained list.
function ShortcutList() {
  return (
    <div className={styles.shortcuts}>
      {KEYBINDINGS.map(b => (
        <div key={b.id} className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>{b.label}</span>
          <kbd className={styles.kbd}>{b.keyLabel}</kbd>
        </div>
      ))}
    </div>
  )
}

function DeadTracks({ state, entries, onScan, onPrune, onCancel }) {
  if (state === 'idle') {
    return <button type="button" className={styles.btn} onClick={onScan}>Scan for dead tracks</button>
  }
  if (state === 'scanning') {
    return <span className={styles.muted}>Scanning your library…</span>
  }
  // done
  if (entries.length === 0) {
    return <span className={styles.muted}>No dead tracks — every library entry's file is on disk.</span>
  }
  return (
    <div>
      <div className={styles.muted} style={{ marginBottom: 8 }}>
        Found {entries.length} dead track{entries.length === 1 ? '' : 's'}:
      </div>
      <ul className={styles.deadList}>
        {entries.slice(0, 8).map(e => (
          <li key={e.key} className={styles.deadItem}>
            <span className={styles.deadTitle}>{e.track_title || e.filename || 'Unknown'}</span>
            {e.track_artist && <span className={styles.deadArtist}> · {e.track_artist}</span>}
          </li>
        ))}
        {entries.length > 8 && (
          <li className={styles.deadItem} style={{ color: 'var(--fg-soft)' }}>
            …and {entries.length - 8} more
          </li>
        )}
      </ul>
      <div className={styles.deadActions}>
        <button type="button" className={styles.btn} onClick={onPrune}>
          Remove {entries.length}
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Add-to-home-screen onboarding for mobile Safari ────────────
// Lets the user mint their OWN 7-day pair URL from within the
// paired Safari session, then walks them through Share → Add to
// Home Screen. Solves the "fresh session in the home-screen icon"
// problem because the URL embeds a ?pair= token that App.jsx
// auto-redeems on first standalone launch.
function InstallSection({ showToast }) {
  const apiKey = useStore(s => s.apiKey)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(null)

  const generate = async () => {
    if (!apiKey) {
      showToast('No API key in this session — re-pair first.')
      return
    }
    setBusy(true)
    try {
      const addons = registry.list()
      const { token } = await pairMint({
        apiKey,
        addons,
        baseUrl: window.location.origin,
        reusable: true,
      })
      setUrl(`${window.location.origin}/?pair=${encodeURIComponent(token)}`)
    } catch (e) {
      showToast(`Could not generate URL: ${e.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const copy = (text) => {
    try {
      navigator.clipboard.writeText(text)
      showToast('Copied')
    } catch {
      showToast('Copy failed — long-press the URL to select + copy.')
    }
  }

  return (
    <Section
      title="Add to home screen"
      desc="Turn this paired session into a native-feeling iPhone icon. The URL below carries a one-shot pair token so the home-screen app launches already authenticated, with your library + addons synced."
    >
      <Field label="Step 1: generate URL" hint="Durable, reusable. Stays valid until you revoke this device from Connected devices on your Mac.">
        {!url ? (
          <button
            type="button"
            className={styles.btn}
            onClick={generate}
            disabled={busy || !apiKey}
          >{busy ? 'Generating…' : 'Generate URL'}</button>
        ) : (
          <div className={styles.inputRow}>
            <input className={styles.input} value={url} readOnly />
            <button type="button" className={styles.btn} onClick={() => copy(url)}>Copy</button>
          </div>
        )}
      </Field>
      {url && (
        <Field label="Step 2: add to home screen" hint="Paste this URL into Safari's address bar, then Share → Add to Home Screen. Open the icon — first launch will pair the standalone app automatically.">
          <ol style={{ paddingLeft: 18, fontSize: 13, color: 'var(--fg-soft)', lineHeight: 1.7, margin: 0 }}>
            <li>Tap Copy above (or long-press to select).</li>
            <li>Open Safari's address bar, paste the URL, hit go.</li>
            <li>Tap the Share button at the bottom of Safari.</li>
            <li>Scroll down → tap <strong>Add to Home Screen</strong>.</li>
            <li>Name it "Audimo" → Add. Tap the icon to launch.</li>
          </ol>
        </Field>
      )}
    </Section>
  )
}
