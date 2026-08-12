"""
Generates a perceptual hash (pHash) for the image. Actual duplicate/reuse
comparison against previously processed images happens in the Node.js backend
(which owns the database of prior hashes) via Hamming-distance comparison.
This module only produces the fingerprint.
"""
from PIL import Image
import imagehash


def compute_phash(pil_image: Image.Image) -> str:
    hash_value = imagehash.phash(pil_image, hash_size=16)  # 256-bit hash -> 64 hex chars
    return str(hash_value)
