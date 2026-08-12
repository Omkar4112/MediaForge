"""
Generates small synthetic images in-memory for tests, so tests don't depend
on external sample files. These are deliberately simple (not photorealistic);
they exist to exercise the check logic and thresholds, not to simulate real
field photos.
"""
import io
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def sharp_image_bytes(size=(800, 600)) -> bytes:
    img = Image.new("RGB", size, color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    for i in range(0, size[0], 20):
        draw.line([(i, 0), (i, size[1])], fill=(0, 0, 0), width=2)
    for i in range(0, size[1], 20):
        draw.line([(0, i), (size[0], i)], fill=(0, 0, 0), width=2)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def blurry_image_bytes(size=(800, 600)) -> bytes:
    img = Image.new("RGB", size, color=(200, 200, 200))
    draw = ImageDraw.Draw(img)
    draw.rectangle([100, 100, 300, 300], fill=(50, 50, 50))
    img = img.filter(ImageFilter.GaussianBlur(radius=12))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def dark_image_bytes(size=(800, 600)) -> bytes:
    img = Image.new("RGB", size, color=(5, 5, 5))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def bright_image_bytes(size=(800, 600)) -> bytes:
    img = Image.new("RGB", size, color=(250, 250, 250))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def text_image_bytes(text: str = "MH12AB1234", size=(800, 300)) -> bytes:
    img = Image.new("RGB", size, color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([50, 80, 750, 220], outline=(0, 0, 0), width=4)
    draw.text((100, 120), text, fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def tiny_image_bytes(size=(50, 50)) -> bytes:
    img = Image.new("RGB", size, color=(120, 120, 120))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()
