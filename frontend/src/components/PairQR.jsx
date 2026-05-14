import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import * as registry from '../addons/registry'
import { pairMint } from '../api'

// Renders a QR code that mobile can scan to pair with this desktop.
// Mints a single-use 90s token via /api/pair/mint, encodes
// `${baseUrl}/?pair=<token>` into the QR. The mobile App.jsx redeems
// on mount.
//
// Both the FirstRun wizard and Settings → Phone Access embed this.
export default function PairQR({ apiKey, baseUrl }) {
  const [token, setToken] = useState(null)
  const [expiresAt, setExpiresAt] = useState(0)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const canvasRef = useRef(null)

  const pairUrl = token && baseUrl ? `${baseUrl}/?pair=${token}` : null

  const mint = async () => {
    if (!apiKey || !baseUrl) return
    setError('')
    try {
      // Mint over loopback — WKWebView's ATS blocks plain-HTTP fetches
      // to the Tailscale hostname. The QR still encodes the Tailscale
      // baseUrl so the phone connects there.
      const { token: t, expires_at } = await pairMint({
        apiKey,
        addons: registry.list(),
      })
      setToken(t)
      setExpiresAt(expires_at * 1000)
    } catch (e) {
      setError(String(e?.message || e))
    }
  }

  useEffect(() => {
    if (apiKey && baseUrl) mint()
    // Re-mint when the inputs change (e.g. user regenerates API key).
  }, [apiKey, baseUrl])

  useEffect(() => {
    if (!pairUrl || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, pairUrl, { width: 220, margin: 1 }, () => {})
  }, [pairUrl])

  useEffect(() => {
    if (!expiresAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  if (!apiKey || !baseUrl) return null

  const secondsLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ background: '#fff', padding: 16, borderRadius: 12 }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: 220, height: 220 }} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>
        {secondsLeft > 0
          ? <>Expires in {secondsLeft}s</>
          : <>
              Code expired —{' '}
              <button
                onClick={mint}
                style={{ background: 'none', border: 'none', color: 'var(--accent, #0a84ff)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
              >
                refresh
              </button>
            </>}
      </div>
      {error && <div style={{ color: 'tomato', fontSize: 12 }}>{error}</div>}
    </div>
  )
}
