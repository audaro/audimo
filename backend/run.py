"""
PyInstaller / standalone launcher for the Audimo backend.

`uvicorn main:app` works in dev because uvicorn discovers the FastAPI
instance by import string. Frozen builds don't have that luxury — they
need an actual `__main__` that calls `uvicorn.run(...)`. This module
is that entrypoint.

Behavior is the same as the dev command:

    uvicorn main:app --host 127.0.0.1 --port 8000

with the host/port overridable via env so the desktop shell can pick a
free port at runtime if 8000 is taken.
"""

import os

import uvicorn

from main import app


def main() -> None:
    host = os.getenv("AUDIMO_BACKEND_HOST", "127.0.0.1")
    port = int(os.getenv("AUDIMO_BACKEND_PORT", "8000"))
    # access_log=False: in remote mode the user is on a public IP and
    # the per-request access log would write any path-segmented
    # secrets (addon URL config segments, query strings) to disk
    # forever. Application logs (errors, startup) stay on stderr.
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
