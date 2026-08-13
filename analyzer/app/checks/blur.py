"""
Blur detection using the variance of the Laplacian.

Higher variance == sharper edges == less blurry. This is a well-known,
cheap heuristic (not a learned model). Thresholds below were picked as
reasonable defaults for phone-camera field photos and can be tuned per
deployment/dataset.
"""
import cv2
import numpy as np

FAIL_THRESHOLD = 60.0     # below this: essentially unusable, likely unreadable
WARNING_THRESHOLD = 120.0  # below this: soft/blurry, may still be usable


def detect_blur(gray_image: np.ndarray) -> dict:
    laplacian = cv2.Laplacian(gray_image, cv2.CV_64F)
    laplacian_variance = float(laplacian.var())
    max_abs_laplacian = float(np.max(np.abs(laplacian))) if laplacian.size > 0 else 0.0

    if laplacian_variance < FAIL_THRESHOLD:
        # If variance is low but there are very sharp edges, classify as warning instead of fail
        if max_abs_laplacian > 150.0:
            status = "warning"
            message = f"Image has low edge density but sharp details (variance: {laplacian_variance:.1f})"
        else:
            status = "fail"
            message = f"Image is too blurry to be usable (variance: {laplacian_variance:.1f})"
    elif laplacian_variance < WARNING_THRESHOLD:
        status = "warning"
        message = f"Image is slightly blurry (variance: {laplacian_variance:.1f})"
    else:
        status = "pass"
        message = f"Image sharpness is acceptable (variance: {laplacian_variance:.1f})"

    # Normalize into a 0-1 "score" for aggregation purposes. This is a
    # bounded rescaling of the raw variance, not a calibrated probability.
    score = min(1.0, laplacian_variance / 400.0)

    return {
        "status": status,
        "score": round(score, 3),
        "message": message,
        "laplacianVariance": round(laplacian_variance, 2),
        "method": "laplacian_variance",
    }
