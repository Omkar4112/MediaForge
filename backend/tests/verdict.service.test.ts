import { computeVerdict } from '../src/services/verdict.service';

describe('computeVerdict', () => {
  it('returns "usable" when all checks pass', () => {
    const { overallStatus, confidence } = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
      { checkType: 'duplicate', status: 'pass', score: 1 },
      { checkType: 'ocr', status: 'pass', score: 0.8 },
      { checkType: 'numberPlate', status: 'pass', score: 0.85 },
      { checkType: 'dimensions', status: 'pass', score: 1 },
      { checkType: 'photoOfPhoto', status: 'pass', score: 1 },
      { checkType: 'tampering', status: 'pass', score: 1 },
    ]);
    expect(overallStatus).toBe('usable');
    expect(confidence).toBeGreaterThan(0.8);
  });

  it('returns "review" when a single hard-fail check (blur) fails', () => {
    const { overallStatus } = computeVerdict([
      { checkType: 'blur', status: 'fail', score: 0.1 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
    ]);
    expect(overallStatus).toBe('review');
  });

  it('returns "rejected" when two or more hard-fail checks fail', () => {
    const { overallStatus } = computeVerdict([
      { checkType: 'blur', status: 'fail', score: 0.1 },
      { checkType: 'brightness', status: 'fail', score: 0.1 },
    ]);
    expect(overallStatus).toBe('rejected');
  });

  it('returns "review" when duplicate is flagged but no hard fail', () => {
    const { overallStatus } = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
      { checkType: 'duplicate', status: 'warning', score: 0.97 },
    ]);
    expect(overallStatus).toBe('review');
  });

  it('lowers confidence as more checks are non-pass', () => {
    const highConfidence = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
    ]).confidence;
    const lowerConfidence = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'duplicate', status: 'warning', score: 0.97 },
      { checkType: 'tampering', status: 'warning', score: 0.95 },
    ]).confidence;
    expect(lowerConfidence).toBeLessThan(highConfidence);
  });

  it('does not penalize confidence or alter verdict for "not_applicable" status', () => {
    const verdictWithNotApplicable = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
      { checkType: 'duplicate', status: 'pass', score: 1 },
      { checkType: 'ocr', status: 'pass', score: 0.8 },
      { checkType: 'numberPlate', status: 'not_applicable', score: null },
      { checkType: 'dimensions', status: 'pass', score: 1 },
      { checkType: 'photoOfPhoto', status: 'pass', score: 1 },
      { checkType: 'tampering', status: 'pass', score: 1 },
    ]);

    expect(verdictWithNotApplicable.overallStatus).toBe('usable');
    expect(verdictWithNotApplicable.confidence).toBeGreaterThan(0.85);
  });

  it('does not force review for a generic image with only OCR/numberPlate content warnings', () => {
    // Generic image: OCR finds no text (warning), numberPlate is not_applicable.
    // All quality checks pass. Should be "usable", not "review".
    const { overallStatus, confidence } = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
      { checkType: 'duplicate', status: 'pass', score: 1 },
      { checkType: 'ocr', status: 'warning', score: 0.0 },
      { checkType: 'numberPlate', status: 'not_applicable', score: null },
      { checkType: 'dimensions', status: 'pass', score: 1 },
      { checkType: 'photoOfPhoto', status: 'pass', score: 1 },
      { checkType: 'tampering', status: 'pass', score: 1 },
    ]);
    expect(overallStatus).toBe('usable');
    expect(confidence).toBeGreaterThan(0.8);
  });

  it('still flags review when OCR has a real failure (not a content warning)', () => {
    const { overallStatus } = computeVerdict([
      { checkType: 'blur', status: 'pass', score: 0.9 },
      { checkType: 'brightness', status: 'pass', score: 0.9 },
      { checkType: 'ocr', status: 'fail', score: 0.1 },
    ]);
    expect(overallStatus).toBe('review');
  });
});
