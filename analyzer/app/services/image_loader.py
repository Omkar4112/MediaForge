"""
Shared image loading utilities: decode uploaded bytes once into the formats
each check needs (OpenCV BGR ndarray, grayscale ndarray, PIL Image).
"""
import cv2
import numpy as np
from PIL import Image
import io


class DecodedImage:
    def __init__(self, raw_bytes: bytes):
        self.raw_bytes = raw_bytes
        self.pil_image = Image.open(io.BytesIO(raw_bytes))
        # Force load so later operations don't fail on a lazy/truncated file.
        self.pil_image.load()

        np_array = np.frombuffer(raw_bytes, dtype=np.uint8)
        self.bgr_image = cv2.imdecode(np_array, cv2.IMREAD_COLOR)
        if self.bgr_image is None:
            raise ValueError("Unable to decode image with OpenCV")

        self.gray_image = cv2.cvtColor(self.bgr_image, cv2.COLOR_BGR2GRAY)

    @property
    def width(self) -> int:
        return self.bgr_image.shape[1]

    @property
    def height(self) -> int:
        return self.bgr_image.shape[0]


def load_image(raw_bytes: bytes) -> DecodedImage:
    return DecodedImage(raw_bytes)
