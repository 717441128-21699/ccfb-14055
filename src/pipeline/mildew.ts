import { RgbImage, connectedComponents } from '../image/primitives.js';
import { AnomalyRecord, EdgeName } from '../types.js';
import { StampFrame } from './frame.js';

export interface MildewSpot {
  centerPx: { x: number; y: number };
  radiusPx: number;
  pixels: number;
  meanDarkness: number;
}

/**
 * Detect mildew (foxing) spots on the paper margin of a front scan.
 * Mildew reads as yellow-greenish dark blotches with soft irregular
 * boundaries, distinct from the saturated design ink and from sharp tears.
 */
export function detectMildew(rect: RgbImage, frame: StampFrame, designBounds: {
  leftMm: number;
  rightMm: number;
  topMm: number;
  bottomMm: number;
}): { spots: MildewSpot[]; anomalies: AnomalyRecord[] } {
  const paddingMm = 3;
  const ppm = rect.width / (frame.widthMm + 2 * paddingMm);
  const padPx = Math.round(paddingMm * ppm);
  const mask = new Uint8Array(rect.width * rect.height);
  const designX0 = padPx + (designBounds.leftMm + frame.widthMm / 2) * ppm;
  const designX1 = padPx + (designBounds.rightMm + frame.widthMm / 2) * ppm;
  const designY0 = padPx + (designBounds.topMm + frame.heightMm / 2) * ppm;
  const designY1 = padPx + (designBounds.bottomMm + frame.heightMm / 2) * ppm;

  // Paper tone from a clean strip ~2 mm inside the border, clear of both the
  // perforation band and the printed design frame.
  const paperInset = Math.round(2 * ppm);
  const paperSamples: { r: number; g: number; b: number }[] = [];
  for (let y = padPx + paperInset; y < rect.height - padPx - paperInset; y += 4) {
    for (const x of [padPx + paperInset, rect.width - padPx - paperInset - 1]) {
      paperSamples.push(rect.get(x, y));
    }
  }
  const paper = meanRgb(paperSamples);
  const paperLum = (paper.r + paper.g + paper.b) / 3;
  const darknessThreshold = -10; // foxing is a modest soft darkening

  for (let y = padPx + 1; y < rect.height - padPx - 1; y++) {
    for (let x = padPx + 1; x < rect.width - padPx - 1; x++) {
      const insideDesign = x >= designX0 && x <= designX1 && y >= designY0 && y <= designY1;
      if (insideDesign) continue;
      const px = rect.get(x, y);
      const lum = (px.r + px.g + px.b) / 3;
      const darkness = lum - paperLum;
      if (darkness > darknessThreshold) continue;
      // Foxing is warm yellow-brown: blue clearly below red, green between.
      // This rejects neutral scanner dust and the cool dark perforation bed.
      const warm = px.r - px.b;
      const yellowish = warm >= 12 && px.g >= px.b + 4 && px.r >= px.g - 6;
      // Exclude saturated design ink that bleeds near the frame.
      const notSaturatedInk = warm < 70 && lum > 70;
      if (!yellowish || !notSaturatedInk) continue;
      // Require a soft local gradient to reject single-sensor salt noise.
      const n1 = rect.get(x - 1, y);
      const n2 = rect.get(x, y - 1);
      const nDark =
        (n1.r + n1.g + n1.b) / 3 < paperLum - 5 ||
        (n2.r + n2.g + n2.b) / 3 < paperLum - 5;
      if (!nDark) continue;
      mask[y * rect.width + x] = 1;
    }
  }

  const { components } = connectedComponents(mask, rect.width, rect.height);
  const minPixels = Math.round(Math.PI * (0.25 * ppm) ** 2); // ~0.25 mm radius
  const maxPixels = Math.round(Math.PI * (4 * ppm) ** 2);
  const spots: MildewSpot[] = [];
  const anomalies: AnomalyRecord[] = [];
  for (const c of components) {
    if (c.pixels < minPixels || c.pixels > maxPixels) continue;
    const width = c.maxX - c.minX;
    const height = c.maxY - c.minY;
    if (width > 6 * ppm || height > 6 * ppm) continue;
    let darkSum = 0;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        if (mask[y * rect.width + x]) {
          const px = rect.get(x, y);
          darkSum += (paper.r + paper.g + paper.b) / 3 - (px.r + px.g + px.b) / 3;
        }
      }
    }
    const radiusPx = Math.max(width, height) / 2;
    const spot: MildewSpot = {
      centerPx: { x: c.centroidX, y: c.centroidY },
      radiusPx,
      pixels: c.pixels,
      meanDarkness: darkSum / c.pixels,
    };
    spots.push(spot);
    const localX = (c.centroidX - padPx) / ppm - frame.widthMm / 2;
    const localY = (c.centroidY - padPx) / ppm - frame.heightMm / 2;
    const edge = nearestEdge(localX, localY, frame);
    anomalies.push({
      edge,
      kind: 'mildew',
      positionMm: { x: localX, y: localY },
      detail: `霉斑：直径约 ${(2 * radiusPx / ppm).toFixed(2)}mm，暗度 ${spot.meanDarkness.toFixed(1)}`,
    });
  }
  return { spots, anomalies };
}

function nearestEdge(xMm: number, yMm: number, frame: StampFrame): EdgeName {
  const dl = xMm + frame.widthMm / 2;
  const dr = frame.widthMm / 2 - xMm;
  const dt = yMm + frame.heightMm / 2;
  const db = frame.heightMm / 2 - yMm;
  const m = Math.min(dl, dr, dt, db);
  if (m === dt) return 'top';
  if (m === db) return 'bottom';
  if (m === dl) return 'left';
  return 'right';
}

function meanRgb(values: { r: number; g: number; b: number }[]): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const v of values) {
    r += v.r;
    g += v.g;
    b += v.b;
  }
  return { r: r / values.length, g: g / values.length, b: b / values.length };
}
