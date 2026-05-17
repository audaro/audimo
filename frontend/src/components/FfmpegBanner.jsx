import { useEffect, useState } from 'react'
import { authFetch } from '../api'
import styles from './FfmpegBanner.module.css'

const DISMISS_KEY = 'audimo:ffmpeg-banner-dismissed'

const INSTRUCTIONS = {
  darwin: {
    cmd: 'brew install ffmpeg',
    hint: 'Requires Homebrew (brew.sh).',
    docsUrl: 'https://ffmpeg.org/download.html#build-mac',
  },
  win32: {
    cmd: 'winget install ffmpeg',
    hint: 'Run in PowerShell. Windows 10 1809+ ships winget by default.',
    docsUrl: 'https://ffmpeg.org/download.html#build-windows',
  },
  linux: {
    cmd: 'sudo apt install ffmpeg',
    hint: 'Or your distro\'s equivalent (dnf / pacman / zypper).',
    docsUrl: 'https://ffmpeg.org/download.html#build-linux',
  },
}

export default function FfmpegBanner() {
  const [status, setStatus] = useState(null)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  )
  const [copied, setCopied] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState(null)

  const refresh = () => {
    authFetch('/api/system/ffmpeg-status')
      .then(r => r.ok ? r.json() : null)
      .then(j => setStatus(j))
      .catch(() => {})
  }

  useEffect(() => {
    if (dismissed) return
    let cancelled = false
    authFetch('/api/system/ffmpeg-status')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled) setStatus(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dismissed])

  const autoInstall = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const r = await authFetch('/api/system/install-ffmpeg', { method: 'POST' })
      const j = await r.json()
      if (j.ok) {
        // Re-probe — if winget succeeded, the banner will hide itself
        // on the next render.
        refresh()
      } else {
        setInstallError(j.error || 'Install failed. Try the copy-paste command instead.')
      }
    } catch (e) {
      setInstallError(String(e))
    } finally {
      setInstalling(false)
    }
  }

  if (dismissed || !status || status.installed) return null

  const info = INSTRUCTIONS[status.platform] || INSTRUCTIONS.linux

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className={styles.banner} role="status">
      <div className={styles.text}>
        <strong>ffmpeg not found.</strong> Audiobook transcoding and
        some music format conversions need it. {info.hint}
        {installError && (
          <div className={styles.error}>Auto-install failed: {installError}</div>
        )}
      </div>
      <div className={styles.actions}>
        {status.can_auto_install && (
          <button
            type="button"
            className={styles.btn}
            onClick={autoInstall}
            disabled={installing}
          >
            {installing ? 'Installing…' : 'Install for me'}
          </button>
        )}
        <code className={styles.cmd} onClick={copy} title="Click to copy">
          {info.cmd}
        </code>
        <button type="button" className={styles.btnSecondary} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          className={styles.link}
          href={info.docsUrl}
          target="_blank"
          rel="noreferrer"
        >Download manually</a>
        <button
          type="button"
          className={styles.dismiss}
          onClick={dismiss}
          aria-label="Dismiss"
        >×</button>
      </div>
    </div>
  )
}
