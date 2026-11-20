import { describe, it, expect } from 'vitest';
import { roundToStep, median, makeRng } from '../src/util/geometry.js';
import { _internal } from '../src/pipeline/perforation.js';

describe('roundToStep', () => {
  it('rounds to the nearest 0.25 gauge step', () => {
    expect(roundToStep(12.46, 0.25)).toBe(12.5);
    expect(roundToStep(11.48, 0.25)).toBe(11.5);
    expect(roundToStep(14.0, 0.25)).toBe(14.0);
  });
});

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('deterministic RNG', () => {
  it('produces a reproducible sequence for a seed', () => {
    const a = makeRng(123);
    const b = makeRng(123);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
});

describe('lattice fit', () => {
  it('recovers the true spacing from clean station positions', () => {
    const spacing = 1.6;
    const points = Array.from({ length: 12 }, (_, k) => 0.6 + k * spacing);
    const fit = _internal.fitLattice(points, spacing * 0.98);
    // The coarse spacing search has ~0.1% quantisation, far finer than the
    // 0.25-gauge reporting step.
    expect(Math.abs(fit.spacingMm - spacing) / spacing).toBeLessThan(0.002);
  });

  it('stays accurate when one station is missing (gap doubles)', () => {
    const spacing = 1.739;
    const points = [0.7, 2.44, 4.18, 7.66, 9.4, 11.14, 12.88].map((v) => v);
    const fit = _internal.fitLattice(points, spacing);
    expect(fit.spacingMm).toBeCloseTo(spacing, 1);
  });
});
