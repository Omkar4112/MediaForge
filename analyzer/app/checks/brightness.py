"""
Brightness classification using mean pixel intensity of the grayscale image
(0-255 scale). Simple, explainable heuristic - not exposure metering.
"""
import numpy as np

TOO_DARK_THRESHOLD = 50.0
TOO_BRIGHT_THRESHOLD = 220.0


def detect_brightness(gray_image: np.ndarray) -> dict:
    mean_brightness = float(np.mean(gray_image))

    if mean_brightness < TOO_DARK_THRESHOLD:
        classification = "too_dark"
        status = "fail"
        message = f"Image is too dark (brightness: {mean_brightness:.1f}/255)"
    elif mean_brightness > TOO_BRIGHT_THRESHOLD:
        classification = "too_bright"
        status = "fail"
        message = f"Image is overexposed (brightness: {mean_brightness:.1f}/255)"
    else:
        classification = "acceptable"
        status = "pass"
        message = f"Lighting is acceptable (brightness: {mean_brightness:.1f}/255)"

    # Score peaks at the midpoint of the acceptable range and decays toward the edges.
    midpoint = (TOO_DARK_THRESHOLD + TOO_BRIGHT_THRESHOLD) / 2
    half_range = (TOO_BRIGHT_THRESHOLD - TOO_DARK_THRESHOLD) / 2
    score = max(0.0, 1.0 - abs(mean_brightness - midpoint) / (half_range * 1.5))

    # Borderline values just inside the pass range get a "warning" nudge
    # rather than a flat pass, to represent honest uncertainty.
    if status == "pass" and (
        mean_brightness < TOO_DARK_THRESHOLD + 15 or mean_brightness > TOO_BRIGHT_THRESHOLD - 15
    ):
        status = "warning"
        message = f"Lighting is borderline (brightness: {mean_brightness:.1f}/255)"

    return {
        "status": status,
        "score": round(min(1.0, score), 3),
        "message": message,
        "meanBrightness": round(mean_brightness, 2),
        "classification": classification,
    }
