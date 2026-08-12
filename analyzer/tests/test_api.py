import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
from app.main import app
from tests.fixtures import sharp_image_bytes, tiny_image_bytes

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_analyze_returns_all_checks():
    files = {"file": ("test.jpg", sharp_image_bytes(), "image/jpeg")}
    response = client.post("/analyze", files=files)
    assert response.status_code == 200
    body = response.json()
    for key in ["blur", "brightness", "ocr", "numberPlate", "dimensions", "photoOfPhoto", "tampering", "phash"]:
        assert key in body


def test_analyze_rejects_unsupported_content_type():
    files = {"file": ("test.gif", tiny_image_bytes(), "image/gif")}
    response = client.post("/analyze", files=files)
    assert response.status_code == 400


def test_analyze_rejects_empty_file():
    files = {"file": ("empty.jpg", b"", "image/jpeg")}
    response = client.post("/analyze", files=files)
    assert response.status_code == 400


def test_analyze_rejects_corrupt_image():
    files = {"file": ("corrupt.jpg", b"not a real jpeg file", "image/jpeg")}
    response = client.post("/analyze", files=files)
    assert response.status_code == 400


def test_analyze_non_vehicle_image():
    files = {"file": ("test.jpg", sharp_image_bytes(), "image/jpeg")}
    response = client.post("/analyze", files=files, data={"image_type": "shop_branding"})
    assert response.status_code == 200
    body = response.json()
    assert body["numberPlate"]["status"] == "not_applicable"
