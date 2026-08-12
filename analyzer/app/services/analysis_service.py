"""
Runs all individual checks against a decoded image and assembles the
combined response returned to the Node.js backend.
"""
from app.services.image_loader import DecodedImage
from app.checks.blur import detect_blur
from app.checks.brightness import detect_brightness
from app.checks.duplicate import compute_phash
from app.checks.ocr import extract_text
from app.checks.plate import detect_plate
from app.checks.dimensions import check_dimensions
from app.checks.photo_of_photo import detect_photo_of_photo
from app.checks.tampering import detect_tampering


def run_all_checks(decoded: DecodedImage, file_size_bytes: int, mime_type: str, image_type: str = "generic") -> dict:
    blur_result = detect_blur(decoded.gray_image)
    brightness_result = detect_brightness(decoded.gray_image)
    ocr_result = extract_text(decoded.bgr_image)
    if image_type == "vehicle":
        plate_result = detect_plate(ocr_result.get("text", ""), decoded.bgr_image)
    else:
        plate_result = {
            "status": "not_applicable",
            "message": "Number plate detection is only performed for vehicle images.",
        }
    dimensions_result = check_dimensions(decoded.width, decoded.height, file_size_bytes, mime_type)
    photo_of_photo_result = detect_photo_of_photo(decoded.pil_image, decoded.gray_image)
    tampering_result = detect_tampering(decoded.pil_image)
    phash = compute_phash(decoded.pil_image)

    return {
        "blur": blur_result,
        "brightness": brightness_result,
        "ocr": ocr_result,
        "numberPlate": plate_result,
        "dimensions": dimensions_result,
        "photoOfPhoto": photo_of_photo_result,
        "tampering": tampering_result,
        "phash": phash,
    }
