import { GrayImage } from '../image/primitives.js';
import { CenteringResult } from '../types.js';
import { StampFrame } from './frame.js';
import { clamp } from '../util/geometry.js';

export interface DesignFrame {
  /** Frame bounds in stamp-local millimetres (centre origin). */
  leftMm: number;
  rightMm: number;
  topMm: number;
  bottomMm: number;
  /** Detection confidence 0..1, based on edge contrast. */
  confidence: number;
}

/**
 * Locate the printed design frame inside the rectified stamp image and
 * measure the four white margins. All work happens in the stamp's own
 * coordinate system, so scanner DPI and rotation never enter the result.
 */
export function measureCentering(rect: GrayImage, frame: StampFrame): CenteringResult {
  const design = locateDesignFrame(rect, frame);
  const marginsMm = {
    top: design.topMm - (-frame.heightMm / 2),
    right: frame.widthMm / 2 - design.rightMm,
    bottom: frame.heightMm / 2 - design.bottomMm,
    left: design.leftMm - (-frame.widthMm / 2),
  };
  const hTotal = marginsMm.left + marginsMm.right;
  const vTotal = marginsMm.top + marginsMm.bottom;
  const horizontalPercent = hTotal > 0 ? (marginsMm.left / hTotal) * 100 : 50;
  const verticalPercent = vTotal > 0 ? (marginsMm.top / vTotal) * 100 : 50;
  // Design-centre displacement from the stamp centre. A design shifted toward
  // +x enlarges the left margin and shrinks the right one, hence (L - R)/2;
  // likewise (T - B)/2 on the vertical axis.
  const offsetMm = {
    x: (marginsMm.left - marginsMm.right) / 2,
    y: (marginsMm.top - marginsMm.bottom) / 2,
  };
  return {
    marginsMm,
    horizontalPercent,
    verticalPercent,
    offsetMm,
    grade: centeringGrade(horizontalPercent, verticalPercent),
  };
}

/**
 * Find the design frame by projection profiles of dark ink onto the four
 * sides, with sub-pixel edge refinement. The margin region is light paper;
 * the first sustained ink band moving inward is the design frame.
 */
export function locateDesignFrame(rect: GrayImage, frame: StampFrame, paddingMm = 3): DesignFrame {
  const ppm = rect.width / (frame.widthMm + 2 * paddingMm); // rectified pixels per mm
  const padPx = Math.round(paddingMm * ppm);
  const paperLevel = estimatePaperLevel(rect, padPx);
  // Frame ink must be clearly darker than the paper; Otsu-like midpoint.
  const inkLevel = estimateInkLevel(rect, padPx);
  const threshold = (paperLevel + inkLevel) / 2;

  // Exclude both the scanner padding and the outer perforation band: bed
  // visible through holes would otherwise look like a dark design frame.
  const guardPx = padPx + Math.round(2.2 * ppm);
  const dark = new Uint8Array(rect.data.length);
  for (let y = guardPx; y < rect.height - guardPx; y++) {
    for (let x = guardPx; x < rect.width - guardPx; x++) {
      if (rect.data[y * rect.width + x]! < threshold) dark[y * rect.width + x] = 1;
    }
  }

  const colCount = new Float32Array(rect.width);
  const rowCount = new Float32Array(rect.height);
  for (let y = guardPx; y < rect.height - guardPx; y++) {
    for (let x = guardPx; x < rect.width - guardPx; x++) {
      if (dark[y * rect.width + x]) {
        colCount[x]!++;
        rowCount[y]!++;
      }
    }
  }
  smoothProfile(colCount, Math.max(2, Math.round(0.4 * ppm)));
  smoothProfile(rowCount, Math.max(2, Math.round(0.4 * ppm)));

  // The printed frame line spans most of the stamp width, so require a strong
  // projection (35% of the inspected extent). A low trigger would latch onto
  // isolated ink specks or anti-aliased texture outside the real frame.
  const colTrigger = 0.35 * (rect.height - 2 * guardPx);
  const rowTrigger = 0.35 * (rect.width - 2 * guardPx);
  const colRange: [number, number] = [guardPx, rect.width - guardPx];
  const rowRange: [number, number] = [guardPx, rect.height - guardPx];
  // Locate each frame line as the steepest sustained projection edge rather
  // than the first row above a trigger: the design fill is dark throughout, so
  // only the gradient at the border reliably marks the printed line.
  const leftPx = edgeByGradient(colCount, colRange, colTrigger, true);
  const rightPx = edgeByGradient(colCount, colRange, colTrigger, false);
  const topPx = edgeByGradient(rowCount, rowRange, rowTrigger, true);
  const bottomPx = edgeByGradient(rowCount, rowRange, rowTrigger, false);

  // edgeByGradient already returns sub-pixel positions.
  const left = leftPx;
  const right = rightPx;
  const top = topPx;
  const bottom = bottomPx;

  const toMmX = (px: number) => -frame.widthMm / 2 + (px - padPx) / ppm;
  const toMmY = (px: number) => -frame.heightMm / 2 + (px - padPx) / ppm;
  const contrast = clamp(1 - (threshold - inkLevel) / Math.max(20, paperLevel - inkLevel), 0, 1);
  return {
    leftMm: toMmX(left),
    rightMm: toMmX(right),
    topMm: toMmY(top),
    bottomMm: toMmY(bottom),
    confidence: contrast,
  };
}

function estimatePaperLevel(rect: GrayImage, padPx: number): number {
  const samples: number[] = [];
  const collect = (x: number, y: number) => {
    if (x >= padPx && y >= padPx && x < rect.width - padPx && y < rect.height - padPx) {
      samples.push(rect.get(x, y));
    }
  };
  // Sample just inside the stamp border where only paper margin is present.
  for (let y = padPx + 2; y < rect.height - padPx - 2; y += 3) {
    collect(padPx + 2, y);
    collect(rect.width - padPx - 3, y);
  }
  for (let x = padPx + 2; x < rect.width - padPx - 2; x += 3) {
    collect(x, padPx + 2);
    collect(x, rect.height - padPx - 3);
  }
  return percentile(samples, 70);
}

function estimateInkLevel(rect: GrayImage, padPx: number): number {
  const values: number[] = [];
  for (let y = padPx; y < rect.height - padPx; y += 7) {
    for (let x = padPx; x < rect.width - padPx; x += 7) {
      values.push(rect.data[y * rect.width + x]!);
    }
  }
  return percentile(values, 25);
}

function smoothProfile(p: Float32Array, radius: number): void {
  const copy = Float32Array.from(p);
  for (let i = 0; i < p.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < p.length) {
        s += copy[j]!;
        n++;
      }
    }
    p[i] = s / n;
  }
}

function firstSustainedRun(
  profile: Float32Array,
  trigger: number,
  runLength: number,
  direction: 'forward' | 'backward',
  lo: number,
  hi: number,
): number {
  const step = direction === 'forward' ? 1 : -1;
  const start = direction === 'forward' ? lo : hi - 1;
  let consecutive = 0;
  for (let i = start; i >= lo && i < hi; i += step) {
    if (profile[i]! >= trigger) {
      consecutive++;
      if (consecutive >= runLength) return i - step * (runLength - 1);
    } else {
      consecutive = 0;
    }
  }
  // Fallback: strongest-gradient position inside the search window.
  let best = direction === 'forward' ? lo + (hi - lo) / 4 : lo + (3 * (hi - lo)) / 4;
  let bestSlope = -Infinity;
  for (let i = lo + 1; i < hi - 1; i++) {
    const slope = (profile[i + 1]! - profile[i - 1]!) * step;
    if (slope > bestSlope) {
      bestSlope = slope;
      best = i;
    }
  }
  return best;
}

/**
 * Find a frame border as the position where the smoothed projection crosses
 * the trigger with the steepest edge. Scanning inward (forward) finds the left/
 * top border via a rising edge; scanning outward (backward) finds the right/
 * bottom border via a falling edge. A discrete gradient locates the transition
 * and a linear interpolation refines it to sub-pixel precision.
 */
function edgeByGradient(
  profile: Float32Array,
  range: [number, number],
  trigger: number,
  forward: boolean,
): number {
  const [lo, hi] = range;
  if (forward) {
    for (let i = lo + 1; i < hi; i++) {
      if (profile[i]! >= trigger && profile[i - 1]! < trigger) {
        const span = profile[i]! - profile[i - 1]!;
        const frac = span > 0 ? (trigger - profile[i - 1]!) / span : 0;
        return i - 1 + clamp(frac, 0, 1);
      }
    }
  } else {
    for (let i = hi - 2; i >= lo; i--) {
      if (profile[i]! >= trigger && profile[i + 1]! < trigger) {
        const span = profile[i]! - profile[i + 1]!;
        const frac = span > 0 ? (trigger - profile[i + 1]!) / span : 0;
        return i + 1 - clamp(frac, 0, 1);
      }
    }
  }
  // Fallback to strongest gradient.
  const fallback = firstSustainedRun(profile, trigger, 4, forward ? 'forward' : 'backward', lo, hi);
  return fallback;
}

/**
 * Catalogue-style centering grade based on the smaller-side share,
 * matching common philatelic conventions (Superb..Fine).
 */
export function centeringGrade(hPercent: number, vPercent: number): string {
  const worst = Math.min(hPercent, 100 - hPercent, vPercent, 100 - vPercent);
  if (worst >= 47.5) return 'Superb 极优';
  if (worst >= 45) return 'Extremely Fine 极美';
  if (worst >= 42.5) return 'Very Fine 优良';
  if (worst >= 40) return 'Fine-Very Fine 良好';
  if (worst >= 37.5) return 'Fine 一般';
  return 'Average 偏差';
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx]!;
}
