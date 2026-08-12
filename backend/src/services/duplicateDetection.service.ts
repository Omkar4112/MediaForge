import { env } from '../config/env';
import * as imageRepository from '../repositories/image.repository';
import { CheckStatus } from './analyzerClient.service';

export interface DuplicateCheckResult {
  status: CheckStatus;
  isDuplicate: boolean;
  closestMatchImageId: string | null;
  hammingDistance: number | null;
  similarity: number | null;
}

function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) {
    // Different hash lengths shouldn't happen for same algorithm/bit-depth,
    // but guard defensively by comparing the overlapping prefix only.
    const len = Math.min(hashA.length, hashB.length);
    hashA = hashA.slice(0, len);
    hashB = hashB.slice(0, len);
  }
  const a = BigInt(`0x${hashA}`);
  const b = BigInt(`0x${hashB}`);
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/**
 * Compares the newly computed perceptual hash against recently processed images.
 * This is a heuristic similarity check, not cryptographic equality - small edits,
 * recompression, or crops can still produce a "duplicate" match, and conversely
 * a very similar but legitimately different photo could occasionally be flagged.
 */
export async function checkDuplicate(imageId: string, phash: string | null): Promise<DuplicateCheckResult> {
  if (!phash) {
    return {
      status: 'warning',
      isDuplicate: false,
      closestMatchImageId: null,
      hammingDistance: null,
      similarity: null,
    };
  }

  const candidates = await imageRepository.findRecentImagesWithHash(imageId);

  let bestMatch: { imageId: string; distance: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.phash) continue;
    const distance = hammingDistance(phash, candidate.phash);
    if (bestMatch === null || distance < bestMatch.distance) {
      bestMatch = { imageId: candidate.id, distance };
    }
  }

  if (!bestMatch) {
    return {
      status: 'pass',
      isDuplicate: false,
      closestMatchImageId: null,
      hammingDistance: null,
      similarity: null,
    };
  }

  const hashBits = phash.length * 4; // hex chars -> bits
  const similarity = Math.max(0, 1 - bestMatch.distance / hashBits);
  const isDuplicate = bestMatch.distance <= env.duplicate.hammingThreshold;

  return {
    status: isDuplicate ? 'warning' : 'pass',
    isDuplicate,
    closestMatchImageId: bestMatch.imageId,
    hammingDistance: bestMatch.distance,
    similarity: Number(similarity.toFixed(3)),
  };
}
