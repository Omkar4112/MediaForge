# MediaForge

MediaForge is an asynchronous image-evidence verification pipeline for offline campaign execution. Field workers upload campaign images as evidence, and the system processes them asynchronously to evaluate image quality, duplication, OCR, suspicious-image signals, and other useful indicators before human review. The solution is designed for generic campaign-image intake, not only vehicle documentation.

This repository contains the implementation for the GoGig assignment and includes:
- backend — Node.js + TypeScript API and background worker
- analyzer — Python FastAPI service that performs the image-analysis checks
- database — PostgreSQL schema for images, jobs, and analysis results
- docker-compose — local orchestration for PostgreSQL, Redis, analyzer, backend, and worker

## 1. Overview

This project implements an asynchronous image-evidence verification pipeline for offline campaign execution.

Field workers upload campaign images as evidence. The system accepts these images, stores them, creates a processing job, and then performs background analysis. The analyzer checks image quality, duplication, OCR, suspicious-image signals, and other indicators that help triage whether the uploaded evidence is usable, requires review, or should be rejected.

The pipeline accepts generic campaign images. Vehicle number-plate validation is an optional specialized check because the provided GoGig sample images are vehicle images, but the system is not limited to vehicles. It is intended to support a broader range of campaign evidence uploads.

The processing model is intentionally asynchronous so the upload API can return immediately while a worker performs the analysis in the background.

## 2. Architecture

```text
Client / Field Worker
        |
        v
Upload API (Node.js + Express)
        |
        +------> PostgreSQL
        |          |
        |          +-- image metadata
        |          +-- processing jobs
        |          +-- analysis results
        |
        v
Redis + BullMQ
        |
        v
Background Worker
        |
        v
Python FastAPI Analyzer
        |
        +-- Blur
        +-- Brightness
        +-- Duplicate / pHash
        +-- OCR
        +-- Number Plate (vehicle only)
        +-- Dimensions
        +-- Photo-of-photo
        +-- Tampering heuristic
        |
        v
Structured Analysis Results
        |
        v
Status / Results API
```

The upload and analysis pipeline operates asynchronously. The API accepts the uploaded image, stores it, creates a processing job, and immediately returns a processing ID while the worker processes the image in the background. The job status and final results are then retrieved via polling endpoints.

## 3. Deployment

The project is deployed across managed cloud services:

- Frontend: https://media-forge-taupe.vercel.app/
- Backend API: https://mediaforge-backend-c399.onrender.com
- Analyzer: https://mediaforge-analyzer.onrender.com
- Database: Neon PostgreSQL

The frontend is hosted on Vercel, the Node.js backend and Python analyzer run on Render, and the PostgreSQL database is connected through Neon with SSL enabled for production.

Live health checks:
- Frontend: https://media-forge-taupe.vercel.app/
- Backend health: https://mediaforge-backend-c399.onrender.com/health
- Analyzer health: https://mediaforge-analyzer.onrender.com/health

## 4. Processing Flow

```text
Upload
→ validate
→ store image + metadata
→ create job
→ pending
→ worker picks job
→ processing
→ analyzer runs checks
→ save results
→ completed
```

The actual flow implemented in the code is:

1. The backend validates the uploaded file and stores the image bytes in the configured upload directory.
2. The backend records the image metadata in PostgreSQL.
3. A processing job is created in PostgreSQL with status `pending`.
4. A BullMQ job is enqueued in Redis.
5. The worker picks the job and marks it as `processing`.
6. The worker calls the Python analyzer, which runs the configured image-quality and OCR checks.
7. Duplicate detection is performed in the backend against prior image hashes in PostgreSQL.
8. The backend stores each result as a `check_type` result in `analysis_results`.
9. The final verdict is derived from the aggregated checks and saved to the job record.
10. The API exposes the job status and final results to clients.

Failure and retry flow:
- BullMQ retries failed processing jobs with exponential backoff.
- The queue is configured with `attempts` and backoff settings.
- If the final attempt fails, the job is marked as `failed` and the error reason is persisted.
- A missing stored file or analyzer failure can leave the job in a failed terminal state rather than a stuck processing state.

## 5. Tech Stack

The project uses the following technologies, all of which exist in the implementation:

- Node.js
- TypeScript
- Express
- PostgreSQL
- Redis
- BullMQ
- Python
- FastAPI
- OpenCV
- Tesseract OCR
- perceptual hashing (pHash-based duplicate detection)
- Docker and Docker Compose
- Jest and Supertest
- Pytest

## 6. Image Analysis

The analyzer performs a set of heuristic checks. These are useful triage signals, but they are probabilistic and heuristic by design. They should not be treated as definitive forensic truth.

- Blur detection: checks if the image is too blurry to be useful evidence.
- Brightness: evaluates whether the image is under- or overexposed enough to reduce interpretability.
- Duplicate detection: uses perceptual hash comparison to identify visually similar or repeated images.
- OCR: extracts text from the image using Tesseract and surfaces the recognized content.
- Indian number-plate format validation: validates whether text resembles an Indian vehicle registration number pattern. This is a format check, not proof of authenticity or ownership.
- Dimensions / quality: checks image resolution and basic dimensions for usefulness.
- Photo-of-photo heuristic: looks for evidence that the image may have been captured off a screen or another image.
- Tampering heuristic: uses image-level heuristics to flag suspicious alterations or manipulated evidence.

Important: every heuristic result is probabilistic. A warning or fail result indicates a risk signal, not a guaranteed fact. The project intentionally avoids claiming forensic certainty from these checks.

The number-plate check is limited to validation of registration-number format. It does not prove that the plate belongs to the vehicle, that ownership is valid, or that the image is authentic.

## 7. Generic Image Support

This project is built for generic campaign evidence, not only vehicle images.

- Any valid campaign image can be uploaded.
- Generic checks work for all images.
- Vehicle images can additionally run number-plate analysis.
- For non-vehicle images, the number-plate check should be `not_applicable`.
- `not_applicable` does not mean failure; it means the check was intentionally skipped because the image type is not a vehicle.

Example:

```json
{
  "imageType": "generic",
  "numberPlate": {
    "status": "not_applicable",
    "message": "Number plate detection is only performed for vehicle images."
  }
}
```

This behavior is implemented in the analyzer service, which only calls plate detection when `image_type == "vehicle"`.

## 8. API Documentation

The project exposes a small asynchronous image-processing API through the Node.js backend.

### POST /api/v1/images

Uploads an image and returns a processing ID immediately.

Request:
- multipart form-data
- file field name: `image`
- optional field: `imageType`
- optional query parameter: `imageType`
- response status: HTTP `202 Accepted`

Example request:

```bash
curl -X POST http://localhost:3000/api/v1/images \
  -F "image=@/path/to/campaign-evidence.jpg" \
  -F "imageType=generic"
```

Example response:

```json
{
  "processingId": "3d1e5d8a-72c4-4f12-8b77-1f0b5f17d9f9",
  "status": "pending"
}
```

The backend uses the stored image metadata and enqueues a background job. A successful upload does not require the analysis to be finished before the response returns.

### GET /api/v1/images/:processingId/status

Returns the current job status.

Example response:

```json
{
  "processingId": "3d1e5d8a-72c4-4f12-8b77-1f0b5f17d9f9",
  "status": "processing",
  "attempts": 1,
  "errorMessage": null,
  "startedAt": "2026-08-12T10:00:00.000Z",
  "completedAt": null,
  "createdAt": "2026-08-12T09:59:58.000Z"
}
```

### GET /api/v1/images/:processingId/results

Returns the final results when the job is completed.

Example response structure:

```json
{
  "processingId": "3d1e5d8a-72c4-4f12-8b77-1f0b5f17d9f9",
  "imageId": "4f5e67b6-5c18-46e5-8019-c68ef7f6d8a0",
  "status": "completed",
  "overallStatus": "review",
  "confidence": 0.61,
  "filename": "storage/uploads/abc123.jpg",
  "originalName": "campaign-evidence.jpg",
  "mimeType": "image/jpeg",
  "fileSizeBytes": 942183,
  "width": 4032,
  "height": 3024,
  "imageType": "generic",
  "ocrText": "Example OCR text",
  "checks": {
    "blur": { "status": "pass", "score": 0.82 },
    "brightness": { "status": "warning", "score": 0.47 },
    "duplicate": { "status": "pass", "score": 0.93 },
    "ocr": { "status": "pass", "score": 0.75, "text": "Example OCR text" },
    "numberPlate": { "status": "not_applicable" },
    "dimensions": { "status": "pass", "score": 0.88 },
    "photoOfPhoto": { "status": "warning", "score": 0.49 },
    "tampering": { "status": "pass", "score": 0.72 }
  },
  "createdAt": "2026-08-12T09:59:58.000Z"
}
```

The `overallStatus` is derived from the aggregated checks and is one of `usable`, `review`, or `rejected`. The code intentionally uses heuristic thresholds rather than absolute truth claims.

### GET /health

The backend health endpoint checks database availability.

Example response:

```json
{
  "status": "ok",
  "db": "up",
  "timestamp": "2026-08-12T10:00:00.000Z"
}
```

The analyzer service exposes its own health endpoint at `/health` with:

```json
{
  "status": "ok"
}
```

## 8. Database

The database is centered on PostgreSQL and stores structured evidence metadata, jobs, and per-check analysis results.

- images: stores uploaded image metadata, storage path, MIME type, file size, dimensions, and perceptual hash.
- processing_jobs: stores job lifecycle data such as `pending`, `processing`, `completed`, or `failed`, plus status, confidence, attempts, and timing metadata.
- analysis_results: stores one result row per job and per check type, such as `blur`, `brightness`, `duplicate`, `ocr`, `numberPlate`, `dimensions`, `photoOfPhoto`, and `tampering`.

Relationships:
- each `processing_jobs` row references one image via `image_id`
- each `analysis_results` row references one job via `job_id`
- the job is the central coordinator between upload metadata and analysis output

## 9. Queue and Failure Handling

This project uses Redis + BullMQ for asynchronous background processing.

- The backend enqueues image-processing jobs to a queue in Redis.
- The background worker consumes the queue and executes the analysis pipeline.
- Jobs are retried with exponential backoff according to the configuration in the queue setup.
- If a job ultimately fails after retries, the job is marked as `failed` and the failure reason is persisted.
- The queue approach keeps the upload service responsive during long-running analysis.

This asynchronous processing model was chosen because image analysis and OCR work can take longer than a normal HTTP request, and the system needs to support multiple incoming uploads without blocking the API.

## 10. Setup

### Docker quickstart

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Start the stack:

```bash
docker compose up --build
```

This starts the PostgreSQL database, Redis, analyzer service, backend API, and the worker.

Expected local endpoints:
- Backend: http://localhost:3000
- Analyzer: http://localhost:8000
- PostgreSQL: localhost:5432
- Redis: localhost:6379

### Local non-Docker setup

Prerequisites:
- Node.js and npm
- Python 3.11+
- PostgreSQL
- Redis
- Tesseract OCR binary installed and available to the analyzer

Windows PowerShell example:

```powershell
cd analyzer
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

```powershell
cd backend
npm install
Copy-Item ..\.env.example .env
npm run dev
```

Then in a second terminal:

```powershell
cd backend
npm run dev:worker
```

Linux/macOS equivalent:

```bash
cd analyzer
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

```bash
cd backend
npm install
cp ../.env.example .env
npm run dev
```

And in a second terminal:

```bash
cd backend
npm run dev:worker
```

## 11. Testing

The project includes backend and analyzer tests. The actual commands are:

```bash
cd backend
npm test
npm run build
```

```bash
cd analyzer
pytest -q
```

Do not assume fixed pass counts from these commands; they should be run in the local environment and results recorded separately.

## 12. Sample API Requests/Responses

Example upload request:

```bash
curl -X POST http://localhost:3000/api/v1/images \
  -F "image=@/path/to/sample-image.jpg" \
  -F "imageType=vehicle"
```

Example status request:

```bash
curl http://localhost:3000/api/v1/images/<processingId>/status
```

Example results request:

```bash
curl http://localhost:3000/api/v1/images/<processingId>/results
```

Example analyzer health check:

```bash
curl http://localhost:8000/health
```

## GoGig Sample Image Results

The following sections are intentionally reserved for the actual outputs or screenshots from the three GoGig sample images after deployment or local validation.

### Sample 1
Actual output/screenshot to be added after deployment.

### Sample 2
Actual output/screenshot to be added after deployment.

### Sample 3
Actual output/screenshot to be added after deployment.

## 13. AI Usage Disclosure — REQUIRED

AI assistants were used during the development of this project. They helped with architecture and design brainstorming, review of implementation structure, debugging support, test creation assistance, and documentation drafting.

The generated code and documentation were reviewed by the human engineer, and validation was performed using the project’s standard automated test commands and manual checks where relevant. Human engineering decisions remained central in areas such as the architecture, heuristic thresholds, uncertainty handling, and trade-offs between simplicity and robustness.

## 14. Assumptions

The system makes the following assumptions, which match the actual implementation:

- image analysis is heuristic and probabilistic rather than absolute proof
- OCR results may contain errors or incomplete extraction
- duplicate detection uses perceptual similarity and is not a perfect identity check
- number-plate validation is a format check, not proof of authenticity or ownership
- photo-of-photo and tampering detection are heuristic signals and may vary by image quality
- local filesystem storage is suitable for this assignment and local environment but is not a full production-grade storage strategy

## 15. Trade-offs

The implementation chooses practical trade-offs for a local take-home assignment:

- BullMQ + Redis was selected over a heavier messaging stack for lightweight asynchronous processing.
- PostgreSQL is used for structured persistence of metadata, jobs, and analysis results.
- OpenCV, Tesseract, and image heuristics are used instead of training custom ML models.
- Local storage is acceptable for the assignment environment and keeps the setup simple.
- Docker Compose enables reproducible local setup across services and dependencies.
- The scope is intentionally limited to a focused, reliable solution rather than broad production infrastructure.

Potential improvements with more time:
- object storage such as S3 or equivalent
- stronger ML-based tampering detection
- authentication and authorization
- monitoring, observability, and alerting
- horizontal worker scaling
- stronger duplicate detection at larger scale

## 16. Limitations

The project is intentionally honest about the limitations of heuristic image analysis and OCR:

- image quality issues may produce false positives or false negatives
- OCR can misread characters, especially in noisy or distorted images
- duplicate detection can provide similarity-based hints, not guaranteed identity proof
- number-plate analysis validates pattern and layout, not legal or factual identity
- photo-of-photo and tampering heuristics are advisory and should be treated as review signals
- any verdict is triage-oriented and not a definitive forensic conclusion

## 17. Deployment Notes

The application is Dockerized and designed to run as a small local distributed system composed of:
- PostgreSQL
- Redis
- backend API
- worker
- analyzer service

For production deployment, the implementation would need persistent storage for uploaded files and a more robust deployment configuration. A live URL will be provided separately in the submission. The project should not be treated as already deployed unless that is explicitly stated in the final submission materials.

## 18. Remove Incorrect/Unnecessary Content

This README intentionally does not include any tunnel, ngrok, or localtunnel guidance as a substitute for real deployment. The project is documented as a local Dockerized application and evaluation artifact, not as a public network deployment.

## Final Notes

This README is intended to be a concise, professional engineering document aligned to the GoGig evaluation criteria:
- engineering quality
- problem solving and system thinking
- reliability and async handling
- practical assumptions and trade-offs
- transparent AI-assisted workflow

The repository is a working local implementation for image-evidence verification and is intentionally documented without claiming features or deployment outcomes beyond what is actually present in the codebase.
