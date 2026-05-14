# PyInstaller spec for the Audimo backend sidecar.
#
# Build with:
#   cd backend && source venv/bin/activate && pyinstaller audimo_backend.spec --clean
#
# Output: dist/audimo-backend (single-file binary). Tauri picks this up
# as a sidecar from `src-tauri/binaries/` (Phase 2: TBD wiring once we
# also have an addon binary).
#
# Notes:
#   * Builds onefile so we can drop the binary anywhere with no extra
#     payload directory.
#   * `console=True` keeps stdout/stderr visible to Tauri's process
#     handle for log relay; the desktop shell hides the window itself.

# -*- mode: python ; coding: utf-8 -*-

block_cipher = None


a = Analysis(
    ['run.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # uvicorn picks these by string at runtime — pull them in
        # explicitly so PyInstaller doesn't drop them.
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.loops.uvloop',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.protocols.websockets.wsproto_impl',
        # SQLite + crypto are stdlib / wheels — listed for clarity.
        'sqlite3',
        'cryptography',
        # Podcast feed parsing uses defusedxml (safe XML); PyInstaller
        # doesn't trace string imports inside routers/podcasts.py
        # reliably enough to pull this in without a hint.
        'defusedxml',
        'defusedxml.ElementTree',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # No login flow → these are dead weight.
        'jwt',
        'bcrypt',
        # Don't bundle libtorrent in the backend — it lives in the addon.
        'libtorrent',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='audimo-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
