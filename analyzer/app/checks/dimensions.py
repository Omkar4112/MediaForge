"""
Basic image quality/dimension checks: width, height, aspect ratio, file size,
MIME type sanity.
"""

MIN_WIDTH = 480
MIN_HEIGHT = 480
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # keep in sync with backend MAX_FILE_SIZE_BYTES
MIN_ASPECT_RATIO = 0.4
MAX_ASPECT_RATIO = 2.5


def check_dimensions(width: int, height: int, file_size_bytes: int, mime_type: str) -> dict:
    aspect_ratio = round(width / height, 3) if height else 0.0

    issues = []
    if width < MIN_WIDTH or height < MIN_HEIGHT:
        issues.append("resolution_too_low")
    if file_size_bytes > MAX_FILE_SIZE_BYTES:
        issues.append("file_too_large")
    if aspect_ratio and (aspect_ratio < MIN_ASPECT_RATIO or aspect_ratio > MAX_ASPECT_RATIO):
        issues.append("unusual_aspect_ratio")
    if mime_type not in ("image/jpeg", "image/png", "image/webp"):
        issues.append("unsupported_mime_type")

    if "unsupported_mime_type" in issues or "resolution_too_low" in issues:
        status = "fail"
        message = f"Image failed quality check: {', '.join(issues)}"
    elif issues:
        status = "warning"
        message = f"Image has quality warnings: {', '.join(issues)}"
    else:
        status = "pass"
        message = f"Image dimensions are acceptable ({width}x{height}px)"

    score = 1.0 - (0.25 * len(issues))

    return {
        "status": status,
        "score": round(max(0.0, score), 3),
        "message": message,
        "width": width,
        "height": height,
        "aspectRatio": aspect_ratio,
        "fileSizeBytes": file_size_bytes,
        "mimeType": mime_type,
        "issues": issues,
    }
