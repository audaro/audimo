"""PyInstaller / dev entry point. Mirrors the audimo addon repos' run.py."""

import os

import uvicorn


if __name__ == "__main__":
    port = int(os.environ.get("AUDIMO_STREAMING_PORT", "11471"))
    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )
