import logging
import os
from fastapi import FastAPI, File, HTTPException, UploadFile, Form
from fastapi.responses import JSONResponse

import pytesseract
# Configure pytesseract binary location:
# - If TESSERACT_CMD env var is set, use that
# - Otherwise, on Windows try the user install path
# - Otherwise leave default (system PATH) so the Docker image's tesseract is used
tesseract_cmd_env = os.environ.get("TESSERACT_CMD")
if tesseract_cmd_env:
    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd_env
else:
    if os.name == 'nt':
        default_win = r"C:\Users\omkar\Tesseract-OCR\tesseract.exe"
        if os.path.exists(default_win):
            pytesseract.pytesseract.tesseract_cmd = default_win

from app.services.image_loader import load_image
from app.services.analysis_service import run_all_checks

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mediaforge-analyzer")

app = FastAPI(title="MediaForge Image Analyzer", version="1.0.0")

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), image_type: str = Form("generic")) -> JSONResponse:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported content type: {file.content_type}")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds maximum allowed size")

    try:
        decoded = load_image(raw_bytes)
    except Exception as exc:
        logger.warning("Failed to decode image: %s", exc)
        raise HTTPException(status_code=400, detail=f"Unable to decode image: {exc}") from exc

    try:
        results = run_all_checks(decoded, len(raw_bytes), file.content_type, image_type)
    except Exception as exc:
        logger.exception("Analysis pipeline failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc

    return JSONResponse(content=results)
