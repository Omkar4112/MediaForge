import { CheckStatus } from './analyzerClient.service';

export type OverallStatus = 'usable' | 'review' | 'rejected';

export interface CheckSummary {
  checkType: string;
  status: CheckStatus;
  score: number | null;
}

/**
 * Aggregates individual check outcomes into a single, honest verdict.
 *
 * The verdict is driven primarily by the computed confidence score:
 *   confidence >= 0.65  →  "usable"
 *   confidence >= 0.35  →  "review"
 *   confidence <  0.35  →  "rejected"
 *
 * Guard-rails:
 *   - A single hard-fail (blur, brightness, dimensions) caps the verdict at
 *     "review" — the image may still be useful after human inspection.
 *   - Two or more hard-fails force "rejected" regardless of confidence,
 *     because the image is too technically degraded to salvage.
 *   - Heuristic/uncertain signals (duplicate, photoOfPhoto, tampering, ocr,
 *     numberPlate) never force "rejected" on their own — they can only push
 *     the verdict to "review".
 */
export function computeVerdict(checks: CheckSummary[]): { overallStatus: OverallStatus; confidence: number } {
  const byType = Object.fromEntries(checks.map((c) => [c.checkType, c]));

  const hardFailTypes = ['blur', 'brightness', 'dimensions'];
  const hardFailCount = hardFailTypes.filter((t) => byType[t]?.status === 'fail').length;

  // Content-extraction checks (ocr, numberPlate) with 'warning' status mean
  // "no content found" — that is NOT a quality problem. Exclude them from
  // the score average, penalty, and review-signal detection so they don't
  // deflate confidence or force review/rejection unfairly.
  const contentExtractionTypes = new Set(['ocr', 'numberPlate']);
  const isContentWarning = (c: CheckSummary) =>
    contentExtractionTypes.has(c.checkType) && c.status === 'warning';

  const reviewSignalTypes = ['duplicate', 'photoOfPhoto', 'tampering', 'ocr', 'numberPlate'];
  const hasReviewSignal = reviewSignalTypes.some(
    (t) =>
      (byType[t]?.status === 'warning' || byType[t]?.status === 'fail') &&
      !isContentWarning(byType[t]!)
  );

  // Confidence: average of available numeric scores, penalized by count of
  // non-pass checks. This is an aggregate heuristic confidence, not a
  // calibrated statistical probability - it is meant to rank/triage, not to
  // be interpreted as an exact likelihood.
  const scored = checks.filter((c) => typeof c.score === 'number' && !isContentWarning(c));
  const avgScore = scored.length
    ? scored.reduce((sum, c) => sum + (c.score as number), 0) / scored.length
    : 0.5;

  const nonPassCount = checks.filter(
    (c) => c.status !== 'pass' && c.status !== 'not_applicable' && !isContentWarning(c)
  ).length;
  const penalty = Math.min(0.4, nonPassCount * 0.08);

  const confidence = Math.max(0, Math.min(1, avgScore - penalty));

  // Determine verdict from confidence thresholds + hard-fail guard-rails
  let overallStatus: OverallStatus;
  if (hardFailCount >= 1) {
    // Technical failure -> review (never rejected)
    overallStatus = 'review';
  } else if (hasReviewSignal) {
    // No hard fails, but heuristic warnings → review
    overallStatus = 'review';
  } else {
    // Everything passes
    overallStatus = confidence >= 0.65 ? 'usable' : 'review';
  }

  return { overallStatus, confidence: Number(confidence.toFixed(3)) };
}
