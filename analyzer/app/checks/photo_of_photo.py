"""
HEURISTIC ONLY. Attempts to flag two distinct patterns:
  1. "Photo of a photo" - a field worker re-photographing a printed/screen photo
     instead of the real scene (often shows a moire pattern, screen bezel edges,
     or a picture-frame-like rectangular border).
  2. "Screenshot" - a re-saved screen capture rather than a camera photo
     (often has no camera EXIF metadata and/or UI-like flat colour regions).

This is NOT a trained classifier. It combines a few weak, explainable signals:
  - Presence/absence of camera EXIF metadata (screenshots and re-saved images
    frequently strip this).
  - A strong rectangular border/frame detected via edge + contour analysis
    (suggestive of a photographed frame or bezel).
  - Very low colour variety combined with large flat regions (common in UI
    screenshots, uncommon in real-world outdoor field photos).

Each signal alone is weak and can misfire (e.g. a genuinely plain, flat-colour
scene, or a camera that strips EXIF by default). The heuristic is deliberately
conservative: it only flags "suspicious" when multiple signals agree, and the
result should route to human review, not automatic rejection.
"""
import cv2
import numpy as np
from PIL import Image


def _has_camera_exif(pil_image: Image.Image) -> bool:
    try:
        exif = pil_image.getexif()
        if not exif:
            return False
        # Tag 271 = Make, 272 = Model - present when a camera/phone wrote EXIF.
        return bool(exif.get(271) or exif.get(272))
    except Exception:
        return False


def _has_frame_border(gray_image: np.ndarray) -> bool:
    edges = cv2.Canny(gray_image, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray_image.shape[:2]
    image_area = h * w

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.5:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4:
            return True
    return False


def _flat_region_ratio(gray_image: np.ndarray) -> float:
    # Fraction of pixels whose local neighbourhood has near-zero gradient -
    # a proxy for large flat/UI-like areas typical of screenshots.
    grad_x = cv2.Sobel(gray_image, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray_image, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(grad_x, grad_y)
    flat_pixels = np.sum(magnitude < 2.0)
    return float(flat_pixels) / float(magnitude.size)


def detect_photo_of_photo(pil_image: Image.Image, gray_image: np.ndarray) -> dict:
    has_exif = _has_camera_exif(pil_image)
    has_frame = _has_frame_border(gray_image)
    flat_ratio = _flat_region_ratio(gray_image)
    likely_screenshot_texture = flat_ratio > 0.55

    signals_triggered = sum([not has_exif, has_frame, likely_screenshot_texture])

    if signals_triggered >= 2:
        status = "warning"
        suspicious = True
        message = f"Possible screen capture or photo-of-photo detected ({signals_triggered}/3 signals triggered)."
    else:
        status = "pass"
        suspicious = False
        message = "No screen-capture or re-photography indicators detected."

    return {
        "status": status,
        "score": round(1.0 - (signals_triggered / 3.0), 3),
        "message": message,
        "suspicious": suspicious,
        "heuristic": True,
        "signals": {
            "hasCameraExif": has_exif,
            "hasRectangularFrameBorder": has_frame,
            "flatRegionRatio": round(flat_ratio, 3),
        },
        "note": "Heuristic based on EXIF presence, frame/border detection, and flat-region ratio. Not a trained classifier; treat as a review signal, not proof.",
    }
