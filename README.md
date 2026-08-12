# MediaForge

Small, focused service that ingests field-worker photos, runs an
asynchronous image-verification pipeline, and returns a triage verdict
(`usable` / `review` / `rejected`) plus per-check details.

This repository contains two primary services:
- `backend` — Node.js + TypeScript API and worker (Express, BullMQ)
- `analyzer` — Python FastAPI service that runs OpenCV / Tesseract checks

Quick summary
- UI: http://localhost:3000/
- Upload API: `POST /api/v1/images` (multipart-form, field `image`)
- Status: `GET /api/v1/images/:processingId/status`
- Results: `GET /api/v1/images/:processingId/results`
- Analyzer: http://localhost:8000 (health: `/health`)

Prerequisites
- Docker & Docker Compose (recommended) or Node 20+, Python 3.11+, Postgres, Redis, Tesseract installed locally for non-Docker runs.

Quickstart (recommended: Docker)

1. Copy the example env and start everything:

```bash
cp .env.example .env
docker compose up --build
```

Services started by compose:
- `postgres` (5432), `redis` (6379), `analyzer` (8000), `backend` (3000), `worker`.

Open the web UI in your browser:

http://localhost:3000/

API examples

Upload an image (creates an async job):

```bash
curl -X POST http://localhost:3000/api/v1/images \
  -F "image=@/full/path/to/sample.jpg" \
  -F "imageType=vehicle"
# returns 202 with JSON: { "processingId": "...", "status": "pending" }
```

Poll status and fetch results:

```bash
curl http://localhost:3000/api/v1/images/<processingId>/status
curl http://localhost:3000/api/v1/images/<processingId>/results
```

Health endpoints

```bash
curl http://localhost:3000/health
curl http://localhost:8000/health
```

Running locally (no Docker)

1. Analyzer (requires Tesseract binary available on PATH or set `TESSERACT_CMD`):

```bash
cd analyzer
python -m venv .venv
source .venv/bin/activate   # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

2. Backend

```bash
cd backend
npm install
cp ../.env.example .env
npm run dev        # starts API on port 3000 (dev mode)
npm run dev:worker # start the worker in a separate terminal
```

Notes & troubleshooting
- If `GET /` shows a Not Found JSON, ensure the backend image includes `backend/public` (the compose image copies it) and that the backend container was rebuilt after changes. See `backend/Dockerfile` which copies `backend/public` into the image.
- If you run analyzer locally, install a Tesseract binary (`apt install tesseract-ocr` or `brew install tesseract`) or set `TESSERACT_CMD` to the absolute binary path.
- If TypeScript/ts-node reports TS6046 about `moduleResolution`, set `moduleResolution` and `module` to compatible values in `backend/tsconfig.json` (example uses `node16` + `Node16`).
- Ports: avoid other services binding to `3000` or `8000`. On Windows you can use `netstat -ano | findstr :3000` to find blockers.

What the analyzer returns (high level)
- Per-check results for: blur, brightness, duplicate (pHash), ocr, numberPlate (vehicle only), dimensions, photoOfPhoto, tampering.
- `overallStatus` is `usable`/`review`/`rejected` and a confidence score (aggregate). The number plate check is regex/format validation only — not a claim of vehicle authenticity.

Where to look in this repo
- Backend app entry: [backend/src/app.ts](backend/src/app.ts)
- Backend Dockerfile: [backend/Dockerfile](backend/Dockerfile)
- Analyzer FastAPI entry: [analyzer/app/main.py](analyzer/app/main.py)

If you want a publicly shareable URL
- I can open a tunnel (localtunnel/ngrok) from `localhost:3000` and give you a public link — tell me if you want that and I will create it.

Support / Tests
- Backend tests: `cd backend && npm test`
- Analyzer tests: `cd analyzer && pytest -q`

Contact
Open an issue or tell me what to run next — I can upload a sample image and paste the job result URL here.
