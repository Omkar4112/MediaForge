"""
HEURISTIC ONLY - explicitly NOT a forensic-grade tampering/manipulation
detector. Real tamper detection (error level analysis done properly, PRNU
sensor noise fingerprinting, learned splice detectors) is out of scope for
this assignment.

What this DOES do, as a simple and explainable proxy:
  - Error Level Analysis (ELA): re-compresses the image at a fixed JPEG
    quality and measures the difference from the original. Regions that were
    edited/pasted after the original compression often show a different
    error level than the rest of the image, which can show up as a high
    standard deviation / patchy pattern in the ELA map.
  - Flags images whose ELA response is unusually high or unusually patchy
    relative to the rest of the image.

Known limitations (documented, not hidden):
  - Very sensitive to re-encoding, resizing, and multiple re-saves - all of
    which are common for photos sent over WhatsApp/mobile uploads and do NOT
    imply tampering.
  - Will not reliably catch tampering that was itself re-compressed afterward.
  - No ground-truth validation was performed against a labelled tampered
    dataset; thresholds are heuristic defaults, not empirically tuned.
This check should only ever push an item to human review, never auto-reject.
"""
import io
import numpy as np
from PIL import Image, ImageChops

ELA_QUALITY = 90
STD_DEV_THRESHOLD = 8.0


def detect_tampering(pil_image: Image.Image) -> dict:
    try:
        rgb_image = pil_image.convert("RGB")
        buffer = io.BytesIO()
        rgb_image.save(buffer, "JPEG", quality=ELA_QUALITY)
        buffer.seek(0)
        recompressed = Image.open(buffer)

        diff = ImageChops.difference(rgb_image, recompressed)
        diff_array = np.asarray(diff, dtype=np.float32)

        std_dev = float(np.std(diff_array))
        mean_diff = float(np.mean(diff_array))

        suspicious = std_dev > STD_DEV_THRESHOLD

        if suspicious:
            status = "warning"
            message = f"Possible metadata or compression tampering detected (ELA std dev: {std_dev:.1f})."
        else:
            status = "pass"
            message = f"No tampering indicators detected (ELA std dev: {std_dev:.1f})."
        score = round(max(0.0, 1.0 - (std_dev / 30.0)), 3)

        return {
            "status": status,
            "score": score,
            "message": message,
            "suspicious": suspicious,
            "heuristic": True,
            "method": "error_level_analysis",
            "elaStdDev": round(std_dev, 3),
            "elaMeanDiff": round(mean_diff, 3),
            "note": (
                "Simple ELA-based heuristic, not a forensic-grade detector. "
                "Re-compression/resizing (e.g. WhatsApp uploads) can trigger false positives. "
                "Treat as a review signal only."
            ),
        }
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never crash the pipeline
        return {
            "status": "warning",
            "score": None,
            "message": f"Tampering heuristic could not complete: {exc}",
            "suspicious": False,
            "heuristic": True,
            "error": f"Tampering heuristic failed to run: {exc}",
        }
