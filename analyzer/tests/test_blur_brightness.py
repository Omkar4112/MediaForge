import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.image_loader import load_image
from tests.fixtures import sharp_image_bytes, blurry_image_bytes, dark_image_bytes, bright_image_bytes


def test_sharp_image_passes_blur_check():
    decoded = load_image(sharp_image_bytes())
    from app.checks.blur import detect_blur
    result = detect_blur(decoded.gray_image)
    assert result["status"] == "pass"
    assert result["laplacianVariance"] > 0


def test_blurry_image_flagged():
    decoded = load_image(blurry_image_bytes())
    from app.checks.blur import detect_blur
    result = detect_blur(decoded.gray_image)
    assert result["status"] in ("warning", "fail")


def test_dark_image_flagged():
    decoded = load_image(dark_image_bytes())
    from app.checks.brightness import detect_brightness
    result = detect_brightness(decoded.gray_image)
    assert result["classification"] == "too_dark"
    assert result["status"] == "fail"


def test_bright_image_flagged():
    decoded = load_image(bright_image_bytes())
    from app.checks.brightness import detect_brightness
    result = detect_brightness(decoded.gray_image)
    assert result["classification"] == "too_bright"
    assert result["status"] == "fail"
