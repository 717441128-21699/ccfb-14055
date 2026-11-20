import { describe, it, expect } from 'vitest';
import { rgbToLab, ciede2000 } from '../src/pipeline/color.js';

describe('CIEDE2000 colour difference', () => {
  it('is zero for identical colours', () => {
    const lab = rgbToLab(120, 80, 200);
    expect(ciede2000(lab, { ...lab })).toBeLessThan(1e-9);
  });

  it('is symmetric', () => {
    const a = rgbToLab(200, 60, 40);
    const b = rgbToLab(90, 120, 170);
    expect(ciede2000(a, b)).toBeCloseTo(ciede2000(b, a), 10);
  });

  it('orders a near match above a far match', () => {
    const ref = rgbToLab(96, 122, 168);
    const near = rgbToLab(96, 123, 165);
    const far = rgbToLab(200, 200, 60);
    expect(ciede2000(ref, near)).toBeLessThan(ciede2000(ref, far));
  });

  it('matches the published Sharma CIEDE2000 worked example', () => {
    // Sharma, Wu & Dalal (2005) test pair, Table I case #1.
    const lab1 = { l: 50, a: 2.6772, b: -79.7751 };
    const lab2 = { l: 50, a: 0, b: -82.7485 };
    expect(ciede2000(lab1, lab2)).toBeCloseTo(2.0425, 2);
  });
});
