import { GrayImage } from '../image/primitives.js';
import { StampFrame } from './frame.js';
import { EdgeName } from '../types.js';

export interface RectEdgeRay {
  /** Position along the edge from its start corner, mm. */
  positionMm: number;
  /**
   * Bite depth inward from the tooth-tip baseline, mm.
   * 0 on a tooth tip, ~hole radius at a perforation floor.
   */
  depthMm: number;
  confidence: number;
}

/**
 * Measure one edge on the axis-aligned rectified image. Two passes:
 *  1. Find the paper boundary coordinate of every row/column.
 *  2. Take a low percentile of those coordinates as the tooth-tip baseline
 *     (the minimum-area frame bbox can sit anywhere between tip and root),
 *     then report each boundary as a bite depth relative to that baseline.
 */
export function sampleRectifiedEdge(
  rect: GrayImage,
  frame: StampFrame,
  edge: EdgeName,
  edgeThreshold: number,
  _sampleStepMm = 0.1,
  paddingMm = 3,
): RectEdgeRay[] {
  const ppm = rect.width / (frame.widthMm + 2 * paddingMm);
  const widthMm = frame.widthMm;
  const heightMm = frame.heightMm;
  const horizontal = edge === 'top' || edge === 'bottom';
  const lengthMm = horizontal ? widthMm : heightMm;
  const padPx = Math.round(paddingMm * ppm);
  const cornerGuardMm = 1.2;
  const searchPx = Math.round(2.4 * ppm);

  // Sample every integer pixel along the edge. Pixel-quantised sampling (as
  // opposed to a fixed mm step) keeps tangential spacing uniform in both
  // orientations, which matters for sub-pixel notch localisation.
  const start = padPx;
  const span = horizontal ? rect.width - 2 * padPx : rect.height - 2 * padPx;
  const raw: { positionMm: number; index: number; inCorner: boolean }[] = [];
  for (let p = 0; p <= span; p++) {
    const positionMm = p / ppm;
    const inCorner = Math.min(positionMm, lengthMm - positionMm) < cornerGuardMm;
    const index = horizontal
      ? scanAxis(rect, start + p, edge, edgeThreshold, padPx, searchPx, true)
      : scanAxis(rect, start + p, edge, edgeThreshold, padPx, searchPx, false);
    raw.push({ positionMm, index, inCorner });
  }

  // Tooth-tip baseline: shallowest reliable boundary, using a low percentile
  // so isolated noise cannot pull it outward.
  const valid = raw.filter((r) => r.index >= 0 && !r.inCorner).map((r) => r.index);
  if (valid.length < 10) {
    return raw.map((r) => ({
      positionMm: r.positionMm,
      depthMm: 0,
      confidence: 0,
    }));
  }
  const baseline = percentile(valid, 10);

  return raw.map((r) => ({
    positionMm: r.positionMm,
    depthMm: r.index >= 0 ? Math.max(0, r.index - baseline) / ppm : 0,
    confidence: r.index >= 0 ? (r.inCorner ? 0.2 : 1) : 0,
  }));
}

/**
 * Scan from the outer padding edge inward; return the sub-pixel step index
 * (0 at the outermost pixel) where gray first crosses the paper threshold.
 */
function scanAxis(
  rect: GrayImage,
  fixed: number,
  edge: EdgeName,
  threshold: number,
  padPx: number,
  searchPx: number,
  vertical: boolean,
): number {
  const topOrLeft = edge === 'top' || edge === 'left';
  const dir = topOrLeft ? 1 : -1;
  const maxSpan = vertical ? rect.height : rect.width;
  const start = topOrLeft ? 0 : maxSpan - 1;
  const maxI = padPx + searchPx;
  const at = (i: number): number => {
    const p = start + dir * i;
    if (p < 0 || p >= maxSpan) return -1;
    return vertical ? rect.data[p * rect.width + fixed]! : rect.data[fixed * rect.width + p]!;
  };
  for (let i = 0; i <= maxI; i++) {
    const g = at(i);
    if (g < 0) break;
    if (g >= threshold) {
      const prev = i > 0 ? at(i - 1) : g;
      const frac = g - prev > 0 ? (threshold - prev) / (g - prev) : 0.5;
      return i - 1 + Math.max(0, Math.min(1, frac));
    }
  }
  return -1;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}
