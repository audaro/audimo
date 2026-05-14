// Audimo v2 icon set — minimal stroke icons matching the spare
// aesthetic of the design bundle. Pass `name` from the dictionary
// below; `size` defaults to 16, accepts 20 or 24 for larger glyphs.
//
// Stroke + fill come from `currentColor` so a parent's CSS color
// flows through. Defaults live in `.icn` in `index.css`
// (stroke-width: 1.5, no fill).
const PATHS = {
  play: <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/>,
  pause: <g><rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/></g>,
  next: <g><polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none"/><rect x="17" y="4" width="2" height="16" fill="currentColor" stroke="none"/></g>,
  prev: <g><polygon points="19 4 9 12 19 20 19 4" fill="currentColor" stroke="none"/><rect x="5" y="4" width="2" height="16" fill="currentColor" stroke="none"/></g>,
  shuffle: <g><path d="M3 6h4l10 12h4M3 18h4l3-3.5M14 8.5l3-2.5h4M19 3l3 3-3 3M19 15l3 3-3 3"/></g>,
  repeat: <g><path d="M4 9V7a2 2 0 0 1 2-2h12l-3-3M20 15v2a2 2 0 0 1-2 2H6l3 3"/></g>,
  radio: <g><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></g>,
  mic: <g><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></g>,
  search: <g><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></g>,
  plus: <g><path d="M12 5v14M5 12h14"/></g>,
  check: <path d="m4 12 5 5 11-12"/>,
  x: <g><path d="M5 5l14 14M19 5L5 19"/></g>,
  arrow: <g><path d="M5 12h14m-5-5 5 5-5 5"/></g>,
  arrowL: <g><path d="M19 12H5m5-5-5 5 5 5"/></g>,
  arrowR: <g><path d="M5 12h14m-5-5 5 5-5 5"/></g>,
  arrowU: <g><path d="M12 19V5m-5 5 5-5 5 5"/></g>,
  arrowD: <g><path d="M12 5v14m-5-5 5 5 5-5"/></g>,
  chev: <g><path d="m9 6 6 6-6 6"/></g>,
  chevD: <g><path d="m6 9 6 6 6-6"/></g>,
  chevU: <g><path d="m6 15 6-6 6 6"/></g>,
  home: <g><path d="M3 12 12 4l9 8M5 11v9h14v-9"/></g>,
  library: <g><rect x="3" y="4" width="4" height="16"/><rect x="10" y="4" width="4" height="16"/><path d="m18 4 4 14-4 2"/></g>,
  queue: <g><path d="M4 6h16M4 12h11M4 18h11M19 14l4 3-4 3z" fill="currentColor"/></g>,
  list: <g><path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/></g>,
  history: <g><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g>,
  stats: <g><path d="M4 20V8M10 20V4M16 20v-7M22 20H2"/></g>,
  settings: <g><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></g>,
  addon: <g><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 17.5h7M17.5 14v7"/></g>,
  book: <g><path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M4 17h15"/></g>,
  headphones: <g><path d="M3 17v-5a9 9 0 0 1 18 0v5"/><path d="M3 17a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2zM21 17a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z"/></g>,
  note: <g><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 18V5l12-2v13"/></g>,
  heart: <path d="M12 21s-7-4.5-9.5-9C.5 8 4 4 7.5 4c2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3 3.5 0 7 4 5 8-2.5 4.5-9.5 9-9.5 9z"/>,
  pin: <g><path d="M12 2v6l3 5H9z"/><path d="M12 13v9M9 22h6"/></g>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>,
  timer: <g><circle cx="12" cy="13" r="8"/><path d="M12 9v4M9 2h6"/></g>,
  speed: <g><path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 14l4-3"/></g>,
  bookmark: <path d="M6 4h12v18l-6-4-6 4z"/>,
  download: <g><path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 19h16"/></g>,
  upload: <g><path d="M12 20V8m-5 5 5-5 5 5"/><path d="M4 4h16"/></g>,
  drag: <g><circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/></g>,
  expand: <g><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></g>,
  minus: <path d="M5 12h14"/>,
  dot3: <g><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></g>,
  info: <g><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M12 12v4"/></g>,
  sparkle: <g><path d="M12 3v6m0 6v6m-9-9h6m6 0h6M6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3"/></g>,
  pulse: <g><path d="M3 12h4l2-7 4 14 2-7h6"/></g>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>,
  sort: <g><path d="M4 6h16M6 12h12M9 18h6"/></g>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z"/>,
  eye: <g><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></g>,
  out: <g><path d="M14 4h4v4M20 4l-7 7M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></g>,
  edit: <g><path d="M14 4l6 6-11 11H3v-6z"/><path d="M13 5l6 6"/></g>,
  queueAdd: <g><path d="M4 6h12M4 12h8M4 18h8"/><path d="M16 14v6M13 17h6"/></g>,
}

export default function Icon({ name, size = 16, className = '', ...props }) {
  const sizeClass = size === 20 ? 'lg' : size === 24 ? 'xl' : ''
  const cls = `icn ${sizeClass} ${className}`.trim()
  return (
    <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" {...props}>
      {PATHS[name] || null}
    </svg>
  )
}
