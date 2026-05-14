// audimo-addon-rpc.js — iframe-side shim for addon tab pages
//
// Addons whose manifest declares `ui.tab.page_url` are rendered in a
// sandboxed iframe inside AddonTabView. This shim exposes a small
// `window.audimo` API to the addon's page, implemented over
// postMessage RPC to the parent (the Audimo native app frontend).
//
// Usage in the addon's page HTML:
//   <script src="/audimo-addon-rpc.js"></script>
//   <script type="module">
//     for await (const ev of window.audimo.acquireTrack({
//       title: 'Blue Monday', artist: 'New Order',
//       policy: { prefer: ['audimo-streamers'] },
//     })) {
//       console.log(ev.status, ev.pct, ev.message)
//     }
//   </script>
//
// Note: this file lives in the *core* app's /public so the addon page
// can reference it at a stable URL on the parent's origin. Because the
// page is loaded inside an iframe from the addon's own origin, the
// addon should serve this exact file content at the same path
// (`/audimo-addon-rpc.js` relative to its own URL), OR the addon's
// page can use `parent.audimoRpcShim` to grab a pre-injected version.
// The simplest path: the addon vendors a copy.
(function () {
  if (typeof window === 'undefined' || window.audimo) return

  const pending = new Map()       // rpc_id -> { resolve, reject }
  const eventStreams = new Map()  // rpc_id -> { push, end, error }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
    return 'rpc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
  }

  function send(method, args) {
    const rpc_id = uuid()
    window.parent.postMessage({ __audimo: 1, rpc_id, method, args }, '*')
    return rpc_id
  }

  function call(method, args) {
    return new Promise((resolve, reject) => {
      const rpc_id = send(method, args)
      pending.set(rpc_id, { resolve, reject })
    })
  }

  // Convert a stream-style RPC into an async iterator. Events arrive
  // as { rpc_id, event } messages from the parent; { rpc_id, done }
  // terminates the iterator.
  function callStream(method, args) {
    const rpc_id = send(method, args)
    const queue = []
    let waiters = []
    let ended = false
    let errored = null

    eventStreams.set(rpc_id, {
      push(ev) {
        if (waiters.length) waiters.shift()({ value: ev, done: false })
        else queue.push(ev)
      },
      end() {
        ended = true
        waiters.forEach(w => w({ value: undefined, done: true }))
        waiters = []
        eventStreams.delete(rpc_id)
      },
      error(err) {
        errored = err
        waiters.forEach(w => w(Promise.reject(err)))
        waiters = []
        eventStreams.delete(rpc_id)
      },
    })

    return {
      rpc_id,
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (errored) return Promise.reject(errored)
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise(resolve => waiters.push(resolve))
          },
          return: () => {
            window.parent.postMessage({ __audimo: 1, rpc_id, cancel: true }, '*')
            ended = true
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data
    if (!m || m.__audimo !== 1 || !m.rpc_id) return

    // One-shot reply
    if ('result' in m || 'error' in m) {
      const p = pending.get(m.rpc_id)
      if (!p) return
      pending.delete(m.rpc_id)
      if ('error' in m) p.reject(new Error(m.error || 'rpc error'))
      else p.resolve(m.result)
      return
    }
    // Streamed event
    if ('event' in m) {
      const s = eventStreams.get(m.rpc_id)
      if (s) s.push(m.event)
      return
    }
    if (m.done) {
      const s = eventStreams.get(m.rpc_id)
      if (s) s.end()
    }
  })

  window.audimo = {
    // Non-streaming
    listAddons: () => call('listAddons'),
    getLibraryStatus: ({ title, artist }) => call('getLibraryStatus', { title, artist }),
    cancel: (rpc_id) => {
      window.parent.postMessage({ __audimo: 1, rpc_id, cancel: true }, '*')
    },

    // Streaming: returns an async iterable. for-await-of in the addon.
    acquireTrack: (args) => callStream('acquireTrack', args),
  }

  // Handshake: let the parent know the shim is live so it can
  // optionally surface "addon loaded" telemetry. Fire-and-forget.
  try {
    window.parent.postMessage({ __audimo: 1, ready: true }, '*')
  } catch {}
})()
