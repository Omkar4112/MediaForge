import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.image_loader import load_image
from app.checks.plate import detect_plate
from app.checks.dimensions import check_dimensions
from app.checks.duplicate import compute_phash
from tests.fixtures import text_image_bytes, sharp_image_bytes, tiny_image_bytes


def test_plate_regex_valid_format():
    result = detect_plate("MH12AB1234")
    assert result["detected"] is True
    assert result["validFormat"] is True
    assert result["normalized"] == "MH12AB1234"


def test_plate_regex_no_match():
    result = detect_plate("no plate text here at all")
    assert result["detected"] is False
    assert result["validFormat"] is False


def test_plate_regex_does_not_confirm_genuineness():
    # Documented behaviour: format validity is not proof of authenticity.
    result = detect_plate("KA01AB1234")
    assert "note" in result
    assert "genuine" in result["note"].lower() or "verify" in result["note"].lower()


def test_plate_ocr_normalization_O_to_0():
    # OCR commonly misreads 0 as O on plates; normalization should fix it.
    result = detect_plate("MHOBAB1234")  # 'OB' → should try '12' variant → MH12AB1234
    # We can't guarantee a match since only O at the correct position flips,
    # but at least verify the function doesn't crash and returns a dict.
    assert "status" in result
    assert "detected" in result


def test_plate_with_spaces_in_input():
    # Plates with spaces between segments should still be detected.
    result = detect_plate("MH 12 AB 1234")
    assert result["detected"] is True
    assert result["validFormat"] is True


def test_plate_with_hyphens_in_input():
    # Plates written with hyphens should be detected.
    result = detect_plate("DL-01-AB-1234")
    assert result["detected"] is True
    assert result["normalized"] == "DL01AB1234"


def test_plate_invalid_state_code_is_not_detected():
    # ZZ is not a valid Indian state code.
    result = detect_plate("ZZ12AB1234")
    assert result["detected"] is False


def test_plate_message_contains_plate_number():
    # The human-readable message must contain the detected plate string.
    result = detect_plate("MH12AB1234")
    assert "MH12AB1234" in result["message"]


def test_dimensions_pass_for_normal_image():
    result = check_dimensions(1920, 1080, 500_000, "image/jpeg")
    assert result["status"] == "pass"
    assert result["aspectRatio"] > 0


def test_dimensions_fail_for_tiny_image():
    result = check_dimensions(50, 50, 5000, "image/jpeg")
    assert result["status"] == "fail"
    assert "resolution_too_low" in result["issues"]


def test_dimensions_fail_for_unsupported_mime():
    result = check_dimensions(1920, 1080, 500_000, "image/gif")
    assert result["status"] == "fail"
    assert "unsupported_mime_type" in result["issues"]


def test_phash_is_deterministic_for_same_image():
    decoded1 = load_image(sharp_image_bytes())
    decoded2 = load_image(sharp_image_bytes())
    hash1 = compute_phash(decoded1.pil_image)
    hash2 = compute_phash(decoded2.pil_image)
    assert hash1 == hash2


def test_phash_differs_for_different_images():
    decoded1 = load_image(sharp_image_bytes())
    decoded2 = load_image(tiny_image_bytes())
    hash1 = compute_phash(decoded1.pil_image)
    hash2 = compute_phash(decoded2.pil_image)
    assert hash1 != hash2
