# Backend tests

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

Tests reroute the DB and API-key file to per-test temp paths via the
fixtures in [`conftest.py`](conftest.py), so they never touch
`~/.audimo/`.

Frontend orchestrator tests live in
[`frontend/src/addons/__tests__/`](../../frontend/src/addons/__tests__)
and run with `cd frontend && npm test`.
