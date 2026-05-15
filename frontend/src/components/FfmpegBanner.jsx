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

  useEffect(() => {
    if (dismissed) return
    let cancelled = false
    authFetch('/api/system/ffmpeg-status')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled) setStatus(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dismissed])

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
      </div>
      <div className={styles.actions}>
        <code className={styles.cmd} onClick={copy} title="Click to copy">
          {info.cmd}
        </code>
        <button type="button" className={styles.btn} onClick={copy}>
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
