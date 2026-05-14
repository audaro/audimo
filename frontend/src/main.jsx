import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Last-resort diagnostics: surface any uncaught error/promise rejection
// + heartbeat the JS engine, since the in-app debug instrumentation
// has been silently missing useEffect entries in release builds.
const dbg = (tag, msg) => {
  try {
    fetch('http://127.0.0.1:8000/api/_debug_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, msg: String(msg).slice(0, 400) }),
    }).catch(() => {})
  } catch {}
}
dbg('main.boot', `t=${Date.now()} ua=${navigator.userAgent.slice(0, 80)}`)
window.addEventListener('error', (e) => dbg('main.error', `${e.message} at ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => dbg('main.reject', String(e.reason).slice(0, 300)))
setTimeout(() => dbg('main.tick', 'after 2s'), 2000)
setTimeout(() => dbg('main.tick', 'after 8s'), 8000)

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
