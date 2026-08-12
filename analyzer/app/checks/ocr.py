"""
OCR text extraction using Tesseract. Returns extracted text plus a confidence
estimate derived from Tesseract's per-word confidence scores.
"""
import cv2
import numpy as np
import pytesseract
from pytesseract import Output

# Point to local tesseract if available
import os
local_tess = r"C:\Users\omkar\Tesseract-OCR\tesseract.exe"
if os.path.exists(local_tess):
    pytesseract.pytesseract.tesseract_cmd = local_tess


def extract_text(bgr_image: np.ndarray) -> dict:
    # Strategy 1: Run directly on raw BGR (Tesseract/Leptonica handles lighting/complex gradients best)
    try:
        data = pytesseract.image_to_data(bgr_image, output_type=Output.DICT)
    except pytesseract.TesseractNotFoundError:
        return {
            "status": "warning",
            "score": None,
            "message": "OCR engine (Tesseract) is not available in this environment.",
            "text": "",
            "confidence": None,
            "error": "Tesseract binary not available in this environment",
        }

    words = []
    confidences = []
    for i, word in enumerate(data.get("text", [])):
        word = word.strip()
        conf = data.get("conf", ["-1"])[i]
        try:
            conf_val = float(conf)
        except (TypeError, ValueError):
            conf_val = -1.0
        if word and conf_val >= 0:
            words.append(word)
            confidences.append(conf_val)

    text = " ".join(words).strip()

    # Strategy 2: If no text was found, fallback to upscaled OTSU thresholded image
    if not text:
        try:
            gray = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2GRAY)
            gray = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
            _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            data = pytesseract.image_to_data(thresh, output_type=Output.DICT)
            
            words = []
            confidences = []
            for i, word in enumerate(data.get("text", [])):
                word = word.strip()
                conf = data.get("conf", ["-1"])[i]
                try:
                    conf_val = float(conf)
                except (TypeError, ValueError):
                    conf_val = -1.0
                if word and conf_val >= 0:
                    words.append(word)
                    confidences.append(conf_val)
            text = " ".join(words).strip()
        except Exception:
            pass

    avg_confidence = (sum(confidences) / len(confidences) / 100.0) if confidences else 0.0

    if not text:
        status = "warning"  # no readable text isn't necessarily a bad photo
        message = "No readable text detected in the image."
    elif avg_confidence < 0.4:
        status = "warning"
        message = f"Low OCR confidence ({avg_confidence:.0%}): text may be unreadable."
    else:
        status = "pass"
        message = f"Text extracted successfully ({len(words)} words)."

    return {
        "status": status,
        "score": round(avg_confidence, 3),
        "message": message,
        "text": text,
        "confidence": round(avg_confidence, 3) if confidences else None,
    }
