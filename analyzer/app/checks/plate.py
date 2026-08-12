"""
Attempts to detect and format-validate an Indian vehicle registration number.
Uses a multi-strategy approach:

  Strategy 1 (Fast): Search the raw OCR text that was already extracted
    by the main pipeline OCR pass.

  Strategy 2 (Targeted full-image re-OCR): If strategy 1 finds nothing,
    re-run Tesseract with plate-optimised PSM modes and pre-processing
    (bilateral filter + adaptive threshold + 2x upscale).

  Strategy 3 (CV plate region crop): Use OpenCV to find candidate plate
    regions (rectangles with plate-like aspect ratio) in the image, crop
    each one, run Tesseract on the crop, and search for a plate pattern.

OCR-error normalisation is applied before regex matching to handle common
Tesseract misreads (0↔O, 1↔I, etc.).

This is REGEX-BASED FORMAT VALIDATION ONLY.  Limitations:
  - A regex match means the string looks like a well-formed Indian plate.
    It is NOT proof the vehicle/plate exists, is genuine, or is not tampered.
  - Requires Tesseract to be installed for image-based strategies.
    Falls back gracefully to Strategy 1 only if Tesseract is unavailable.
"""
from __future__ import annotations

import re
from typing import Optional

import cv2
import numpy as np

try:
    import pytesseract
    _TESS_AVAILABLE = True
    import os
    local_tess = r"C:\Users\omkar\Tesseract-OCR\tesseract.exe"
    if os.path.exists(local_tess):
        pytesseract.pytesseract.tesseract_cmd = local_tess
except Exception:  # noqa: BLE001
    _TESS_AVAILABLE = False

# ---------------------------------------------------------------------------
# Format pattern
# ---------------------------------------------------------------------------
_SEG = r"[\s\-]?"
PLATE_REGEX = re.compile(
    r"([A-Z]{2})" + _SEG + r"(\d{1,2})" + _SEG + r"([A-Z]{0,3})" + _SEG + r"(\d{4})"
)

VALID_STATE_CODES = {
    "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP",
    "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP", "MZ",
    "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK", "UP",
    "WB", "AN",
}

# ---------------------------------------------------------------------------
# OCR normalisation: correct common OCR errors on number plates
# ---------------------------------------------------------------------------

def _normalize_ocr(raw: str) -> str:
    cleaned = re.sub(r"[^A-Z0-9\s\-]", "", raw.upper())
    return re.sub(r"\s+", " ", cleaned).strip()


def _ocr_variants(text: str) -> list[str]:
    """Return the original text plus O↔0 and I↔1 swapped variants."""
    variants = [text]
    # O→0, I→1
    v1 = text.translate(str.maketrans("OI", "01"))
    if v1 != text:
        variants.append(v1)
    # 0→O, 1→I
    v2 = text.translate(str.maketrans("01", "OI"))
    if v2 != text:
        variants.append(v2)
    return variants


def _search_for_plate(text: str) -> Optional[re.Match]:
    norm = _normalize_ocr(text)
    for variant in _ocr_variants(norm):
        # Scan all potential matches in the text, not just the first one
        for m in PLATE_REGEX.finditer(variant):
            state_code = m.group(1)
            if state_code in VALID_STATE_CODES:
                return m
    return None


# ---------------------------------------------------------------------------
# Strategy 2: Targeted full-image re-OCR
# ---------------------------------------------------------------------------
_PLATE_PSM_MODES = [6, 7, 8, 13]
_PLATE_CONFIG_BASE = (
    "--oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- --psm "
)


def _preprocess_for_plate(gray: np.ndarray) -> np.ndarray:
    """Upscale + bilateral filter + adaptive threshold for plate OCR."""
    upscaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    filtered = cv2.bilateralFilter(upscaled, 11, 17, 17)
    thresh = cv2.adaptiveThreshold(
        filtered, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        11, 2
    )
    return thresh


def _run_tesseract_multi_psm(image: np.ndarray) -> str:
    """Run Tesseract with multiple PSMs and return all text concatenated."""
    collected: list[str] = []
    for psm in _PLATE_PSM_MODES:
        try:
            config = _PLATE_CONFIG_BASE + str(psm)
            raw = pytesseract.image_to_string(image, config=config)
            if raw.strip():
                collected.append(raw.strip())
        except Exception:  # noqa: BLE001
            break  # Tesseract not available – stop trying
    return " ".join(collected)


def _strategy2_full_image_ocr(bgr_image: np.ndarray) -> Optional[re.Match]:
    gray = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2GRAY)
    processed = _preprocess_for_plate(gray)
    text = _run_tesseract_multi_psm(processed)
    return _search_for_plate(text) if text else None


# ---------------------------------------------------------------------------
# Strategy 3: CV plate-region locator + targeted crop OCR
# ---------------------------------------------------------------------------
_PLATE_ASPECT_MIN = 2.0    # Indian plates are wider than they are tall
_PLATE_ASPECT_MAX = 6.0
_PLATE_AREA_MIN_FRAC = 0.002  # plate must be at least 0.2% of image area


def _find_plate_candidates(bgr_image: np.ndarray) -> list[np.ndarray]:
    """
    Use edge detection + contour analysis to find rectangle-shaped regions
    with a plate-like aspect ratio.  Returns a list of BGR cropped images
    (best candidates first, capped at 5).
    """
    h, w = bgr_image.shape[:2]
    img_area = h * w
    min_area = img_area * _PLATE_AREA_MIN_FRAC

    gray = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2GRAY)
    # Bilateral filter preserves edges while smoothing noise
    filt = cv2.bilateralFilter(gray, 11, 17, 17)
    edges = cv2.Canny(filt, 30, 200)

    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    # Sort largest first
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:200]

    candidates: list[tuple[float, np.ndarray]] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.018 * peri, True)
        if len(approx) != 4:
            continue
        x, y, cw, ch = cv2.boundingRect(approx)
        if ch == 0:
            continue
        aspect = cw / ch
        if not (_PLATE_ASPECT_MIN <= aspect <= _PLATE_ASPECT_MAX):
            continue
        crop = bgr_image[y : y + ch, x : x + cw]
        if crop.size == 0:
            continue
        candidates.append((area, crop))

    # Return crops sorted by area (largest = most likely full plate)
    candidates.sort(key=lambda t: t[0], reverse=True)
    return [c for _, c in candidates[:5]]


def _strategy3_cv_crop_ocr(bgr_image: np.ndarray) -> Optional[re.Match]:
    crops = _find_plate_candidates(bgr_image)
    for crop in crops:
        gray_crop = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        # Upscale small crops significantly
        target_height = 80
        scale = max(1.0, target_height / gray_crop.shape[0])
        up = cv2.resize(gray_crop, None, fx=scale * 2, fy=scale * 2,
                        interpolation=cv2.INTER_CUBIC)
        processed = _preprocess_for_plate(up)
        text = _run_tesseract_multi_psm(processed)
        if text:
            match = _search_for_plate(text)
            if match:
                return match
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_plate(ocr_text: str, bgr_image: Optional[np.ndarray] = None) -> dict:
    """
    Attempt to find an Indian number plate using three strategies in sequence.

    Args:
        ocr_text:   Text already extracted by the main OCR pass. May be empty.
        bgr_image:  Original BGR image array. Used by strategies 2 and 3.

    Returns a dict with: status, score, message, detected, validFormat,
    normalized (if detected), confidence, note.
    """
    tess_available = _TESS_AVAILABLE
    try:
        if tess_available:
            pytesseract.get_tesseract_version()
    except Exception:  # noqa: BLE001
        tess_available = False

    # ── Strategy 1 ──────────────────────────────────────────────────────────
    match = _search_for_plate(ocr_text) if ocr_text else None

    # ── Strategy 2 ──────────────────────────────────────────────────────────
    if match is None and bgr_image is not None and tess_available:
        try:
            match = _strategy2_full_image_ocr(bgr_image)
        except Exception:  # noqa: BLE001
            pass

    # ── Strategy 3 ──────────────────────────────────────────────────────────
    if match is None and bgr_image is not None and tess_available:
        try:
            match = _strategy3_cv_crop_ocr(bgr_image)
        except Exception:  # noqa: BLE001
            pass

    # ── No plate found ───────────────────────────────────────────────────────
    if match is None:
        if not tess_available:
            return {
                "status": "warning",
                "score": None,
                "message": "Plate OCR unavailable: Tesseract is not installed. "
                           "Install Tesseract OCR to enable number plate detection.",
                "detected": False,
                "validFormat": False,
                "normalized": None,
                "note": "Tesseract not found. Plate detection requires Tesseract.",
            }
        return {
            "status": "warning",
            "score": 0.0,
            "message": "No Indian number plate format detected in the image.",
            "detected": False,
            "validFormat": False,
            "normalized": None,
            "note": "Regex search across OCR output and targeted re-OCR found no plate match. "
                    "This does not confirm a plate is absent.",
        }

    # ── Plate found – validate ───────────────────────────────────────────────
    state_code, rto_code, series, number = match.groups()
    normalized = f"{state_code}{rto_code.zfill(2)}{series}{number}"
    valid_state = state_code in VALID_STATE_CODES
    valid_format = bool(state_code and rto_code and number and len(number) == 4)
    confidence = 0.85 if (valid_format and valid_state) else 0.5
    status = "pass" if (valid_format and valid_state) else "warning"
    validity_label = "valid" if (valid_format and valid_state) else "possibly invalid"

    return {
        "status": status,
        "score": confidence,
        "message": f"Plate detected: {normalized} ({validity_label} format).",
        "detected": True,
        "validFormat": valid_format,
        "validStateCode": valid_state,
        "normalized": normalized,
        "confidence": confidence,
        "note": "Regex format validation only. Does not verify the plate/vehicle is genuine.",
    }
