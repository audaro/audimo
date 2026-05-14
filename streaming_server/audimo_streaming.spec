# PyInstaller spec for the bundled tunnel streaming server.
#
# Build with:
#   cd streaming_server && source .venv/bin/activate && pyinstaller audimo_streaming.spec --clean
#
# Prerequisites for the build machine:
#   * `.venv/` populated from requirements.txt (fastapi, uvicorn).
#   * libtorrent importable. On macOS the easy path is to point
#     PYTHONPATH at Homebrew's site-packages before invoking PyInstaller:
#       export PYTHONPATH=/opt/homebrew/Cellar/libtorrent-rasterbar/$(ls /opt/homebrew/Cellar/libtorrent-rasterbar | tail -1)/lib/python3.X/site-packages
#     PyInstaller picks up the compiled .so via collect_all('libtorrent')
#     below.
#
# Output: dist/audimo-streaming (single-file binary), to be copied to
# frontend/src-tauri/binaries/ for Tauri bundling.

# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all

block_cipher = None

lt_datas, lt_binaries, lt_hiddenimports = collect_all('libtorrent')

# Pre-warmed libtorrent session state. Snapshot from a healthy
# audimo-streaming process; bundling it cuts first-launch DHT
# bootstrap from 30-90s (cold) to a few seconds (warm). Optional —
# build still succeeds without seed_session.dat present.
#
# Strip the persistent DHT node-id before shipping: every install
# loading the same node-id would have thousands of DHT peers claim
# the same routing slot, degrading BEP-5 routing for everyone.
# libtorrent generates a fresh per-install id on first run when the
# field is absent. The routing-table `nodes` list is the valuable
# part and is left intact — it's all public DHT-peer addresses,
# nothing personal.
import os as _os
import tempfile as _tempfile
seed_datas = []
if _os.path.isfile('seed_session.dat'):
    try:
        import libtorrent as _lt
        with open('seed_session.dat', 'rb') as _f:
            _e = _lt.bdecode(_f.read())
        if isinstance(_e, dict) and isinstance(_e.get(b'dht state'), dict):
            _e[b'dht state'].pop(b'node-id', None)
        # Write the stripped seed under its expected basename inside
        # a fresh temp dir so PyInstaller bundles it as
        # seed_session.dat (its `datas` copy uses the source basename).
        _strip_dir = _tempfile.mkdtemp(prefix='audimo_seed_')
        _strip_path = _os.path.join(_strip_dir, 'seed_session.dat')
        with open(_strip_path, 'wb') as _f:
            _f.write(_lt.bencode(_e))
        seed_datas.append((_strip_path, '.'))
    except Exception as _err:
        print(f"[spec] failed to strip node-id from seed: {_err!r}; "
              f"falling back to raw seed")
        seed_datas.append(('seed_session.dat', '.'))

a = Analysis(
    ['run.py'],
    pathex=['.'],
    binaries=lt_binaries,
    datas=lt_datas + seed_datas,
    hiddenimports=[
        *lt_hiddenimports,
        'server',
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
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
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
    name='audimo-streaming',
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
