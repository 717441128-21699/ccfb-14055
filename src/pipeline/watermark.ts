import { GrayImage } from '../image/primitives.js';
import { WatermarkName, WatermarkResult } from '../types.js';
import { StampFrame } from './frame.js';
import { clamp, makeRng } from '../util/geometry.js';

/**
 * Watermark templates are rendered at a fixed nominal size (millimetres)
 * and rasterised on demand to match the rectified scan resolution.
 * A template is a soft grayscale map: 1 = paper (thicker, brighter under
 * transmitted light), 0 = watermark thinning (darker).
 */
export interface WatermarkTemplate {
  name: WatermarkName;
  widthMm: number;
  heightMm: number;
  render(pxPerMm: number): GrayImage;
}

function blank(pxPerMm: number, wMm: number, hMm: number): GrayImage {
  return new GrayImage(Math.max(8, Math.round(wMm * pxPerMm)), Math.max(8, Math.round(hMm * pxPerMm)));
}

function setSoft(img: GrayImage, x: number, y: number, value: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return;
  img.data[yi * img.width + xi] = Math.max(img.data[yi * img.width + xi]!, value);
}

function fillDisc(img: GrayImage, cx: number, cy: number, r: number, value: number): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (Math.hypot(x - cx, y - cy) <= r) setSoft(img, x, y, value);
    }
  }
}

function strokeRing(
  img: GrayImage,
  cx: number,
  cy: number,
  r: number,
  thickness: number,
  value: number,
): void {
  for (let y = Math.floor(cy - r - thickness); y <= Math.ceil(cy + r + thickness); y++) {
    for (let x = Math.floor(cx - r - thickness); x <= Math.ceil(cx + r + thickness); x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      if (d <= thickness / 2) setSoft(img, x, y, value);
    }
  }
}

function strokeLine(
  img: GrayImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  value: number,
): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    fillDisc(
      img,
      x0 + (x1 - x0) * t,
      y0 + (y1 - y0) * t,
      thickness / 2,
      value,
    );
  }
}

export const WATERMARK_TEMPLATES: WatermarkTemplate[] = [
  {
    name: 'wreath',
    widthMm: 14,
    heightMm: 16,
    render(ppm) {
      const img = blank(ppm, 14, 16);
      const cx = img.width / 2;
      const cy = img.height / 2;
      strokeRing(img, cx, cy, img.width * 0.36, ppm * 0.55, 1);
      // leaves around the ring
      const leaves = 14;
      for (let i = 0; i < leaves; i++) {
        const a = (i / leaves) * Math.PI * 2;
        const lx = cx + Math.cos(a) * img.width * 0.36;
        const ly = cy + Math.sin(a) * img.width * 0.36;
        fillDisc(img, lx, ly, ppm * 0.42, 1);
      }
      // bow at the bottom
      strokeLine(img, cx - ppm * 1.6, cy + img.width * 0.36, cx, cy + img.width * 0.36 + ppm * 1.4, ppm * 0.5, 1);
      strokeLine(img, cx + ppm * 1.6, cy + img.width * 0.36, cx, cy + img.width * 0.36 + ppm * 1.4, ppm * 0.5, 1);
      return img;
    },
  },
  {
    name: 'star',
    widthMm: 12,
    heightMm: 12,
    render(ppm) {
      const img = blank(ppm, 12, 12);
      const cx = img.width / 2;
      const cy = img.height / 2;
      const outer = img.width * 0.44;
      const inner = outer * 0.42;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[(i + 1) % pts.length]!;
        strokeLine(img, p.x, p.y, q.x, q.y, ppm * 0.6, 1);
      }
      fillDisc(img, cx, cy, ppm * 0.5, 1);
      return img;
    },
  },
  {
    name: 'crown',
    widthMm: 14,
    heightMm: 11,
    render(ppm) {
      const img = blank(ppm, 14, 11);
      const baseY = img.height * 0.72;
      const topY = img.height * 0.22;
      const xs = [0.12, 0.32, 0.5, 0.68, 0.88].map((f) => f * img.width);
      // base band
      strokeLine(img, img.width * 0.1, baseY, img.width * 0.9, baseY, ppm * 0.9, 1);
      // five points
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i]!;
        strokeLine(img, x, baseY, x, i === 2 ? topY * 0.75 : topY, ppm * 0.55, 1);
        fillDisc(img, x, i === 2 ? topY * 0.75 : topY, ppm * 0.55, 1);
      }
      // arches between adjacent points
      for (let i = 0; i < xs.length - 1; i++) {
        const x0 = xs[i]!;
        const x1 = xs[i + 1]!;
        const midX = (x0 + x1) / 2;
        const midY = baseY - (baseY - topY) * 0.45;
        for (let s = 0; s <= 12; s++) {
          const t = s / 12;
          const x = x0 + (x1 - x0) * t;
          const y = (1 - t) ** 2 * baseY + 2 * (1 - t) * t * midY + t ** 2 * baseY;
          void midX;
          fillDisc(img, x, y, ppm * 0.3, 1);
        }
      }
      return img;
    },
  },
  {
    name: 'cloud',
    widthMm: 15,
    heightMm: 10,
    render(ppm) {
      const img = blank(ppm, 15, 10);
      const cy = img.height * 0.62;
      const lobes: [number, number][] = [
        [0.22, 0.2],
        [0.38, 0.28],
        [0.55, 0.24],
        [0.7, 0.3],
        [0.82, 0.2],
      ];
      for (const [fx, fr] of lobes) {
        fillDisc(img, fx * img.width, cy, fr * img.width, 1);
      }
      // flat underside
      strokeLine(img, img.width * 0.14, cy + ppm * 0.6, img.width * 0.88, cy + ppm * 0.6, ppm * 0.8, 1);
      // spiral tail (xiangyun curl)
      const sx = img.width * 0.2;
      const sy = cy - ppm * 1.2;
      for (let a = 0; a < Math.PI * 2.4; a += 0.2) {
        const r = ppm * (1.4 - a / (Math.PI * 3));
        setSoft(img, sx + Math.cos(a) * r, sy + Math.sin(a) * r, 1);
      }
      return img;
    },
  },
];

/**
 * Remove large-scale illumination gradients (scanner lamp falloff, paper
 * thickness variation) while preserving the local watermark pattern.
 * Returns a zero-mean, locally-standardised image so the watermark signal
 * is comparable across scans regardless of absolute paper brightness.
 */
export function flattenIllumination(img: GrayImage, _blurRadiusPx: number): GrayImage {
  const out = new GrayImage(img.width, img.height);
  // Local mean via a coarse downsample/upsample (cheap large-kernel blur).
  const smallW = Math.max(8, Math.round(img.width / 16));
  const smallH = Math.max(8, Math.round(img.height / 16));
  const small = new GrayImage(smallW, smallH);
  const counts = new Float32Array(smallW * smallH);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(smallW - 1, Math.floor((x / img.width) * smallW));
      const sy = Math.min(smallH - 1, Math.floor((y / img.height) * smallH));
      const i = sy * smallW + sx;
      small.data[i]! += img.data[y * img.width + x]!;
      counts[i]!++;
    }
  }
  for (let i = 0; i < small.data.length; i++) small.data[i]! /= Math.max(1, counts[i]!);
  // Local standard deviation on the same coarse grid (E[X^2] - E[X]^2).
  const sq = new GrayImage(smallW, smallH);
  const sqCounts = new Float32Array(smallW * smallH);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(smallW - 1, Math.floor((x / img.width) * smallW));
      const sy = Math.min(smallH - 1, Math.floor((y / img.height) * smallH));
      const i = sy * smallW + sx;
      sq.data[i]! += img.data[y * img.width + x]! ** 2;
      sqCounts[i]!++;
    }
  }
  const localStd = new GrayImage(smallW, smallH);
  for (let i = 0; i < small.data.length; i++) {
    const mean = small.data[i]!;
    const meanSq = sq.data[i]! / Math.max(1, sqCounts[i]!);
    localStd.data[i] = Math.sqrt(Math.max(1, meanSq - mean * mean));
  }
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = (x / img.width) * (smallW - 1);
      const sy = (y / img.height) * (smallH - 1);
      const bg = small.sample(sx, sy);
      const sd = localStd.sample(sx, sy);
      out.data[y * img.width + x] = (img.data[y * img.width + x]! - bg) / sd;
    }
  }
  return out;
}

/**
 * Windowed correlation of a binary template against the standardised image.
 * The motif is binarised (stroke/fill = +1, background = -1) and a Hann
 * window suppresses the stamp border and scanner bed. Zero-meaning both the
 * template and the image patch inside the window gives a Pearson-style
 * coefficient that works for thin-line motifs and solid filled ones alike.
 */
function windowedCorrelation(img: GrayImage, tpl: GrayImage, ox: number, oy: number): number {
  const n = tpl.width * tpl.height;
  const sign = new Int8Array(n);
  const wArr = new Float32Array(n);
  let sumW = 0;
  let sumWSign = 0;
  for (let ty = 0; ty < tpl.height; ty++) {
    for (let tx = 0; tx < tpl.width; tx++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (tx + 0.5)) / tpl.width);
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (ty + 0.5)) / tpl.height);
      const w = wx * wy;
      const idx = ty * tpl.width + tx;
      const s = tpl.data[idx]! >= 0.5 ? 1 : -1;
      sign[idx] = s;
      wArr[idx] = w;
      sumW += w;
      sumWSign += w * s;
    }
  }
  const meanT = sumWSign / Math.max(1e-9, sumW);
  // Weighted mean of the image patch.
  let sumWI = 0;
  for (let ty = 0; ty < tpl.height; ty++) {
    for (let tx = 0; tx < tpl.width; tx++) {
      sumWI += wArr[ty * tpl.width + tx]! * img.get(ox + tx, oy + ty);
    }
  }
  const meanI = sumWI / Math.max(1e-9, sumW);
  let cov = 0;
  let varT = 0;
  let varI = 0;
  for (let ty = 0; ty < tpl.height; ty++) {
    for (let tx = 0; tx < tpl.width; tx++) {
      const idx = ty * tpl.width + tx;
      const w = wArr[idx]!;
      const tc = sign[idx]! - meanT;
      const ic = img.get(ox + tx, oy + ty) - meanI;
      cov += w * tc * ic;
      varT += w * tc * tc;
      varI += w * ic * ic;
    }
  }
  const denom = Math.sqrt(Math.max(1e-9, varT) * Math.max(1e-9, varI));
  return clamp(cov / denom, -1, 1);
}

export interface WatermarkMatch {
  name: WatermarkName;
  score: number;
  centerPx: { x: number; y: number };
}

/**
 * Search every watermark template over the stamp interior of a transmitted-
 * light back scan. The rectified image carries 3 mm of padding; all geometry
 * is derived from the frame so the search stays inside the paper.
 */
export function matchWatermark(
  rect: GrayImage,
  frame: StampFrame,
  options: { minScore?: number; rngSeed?: number; paddingMm?: number } = {},
): WatermarkResult {
  const minScore = options.minScore ?? 0.15;
  const minMargin = 1.3; // winner must beat the runner-up by 30% to be trusted
  const paddingMm = options.paddingMm ?? 3;
  const pxPerMm = rect.width / (frame.widthMm + 2 * paddingMm);
  const padPx = Math.round(paddingMm * pxPerMm);
  const flat = flattenIllumination(rect, 0);
  const rng = makeRng(options.rngSeed ?? 42);

  // Keep the search well inside the paper (a further 3 mm in from the border)
  // so perforations and the paper/bed edge never enter a correlation window.
  const insetPx = padPx + Math.round(3 * pxPerMm);
  const candidates: WatermarkMatch[] = [];
  // Multi-scale search: real watermarks vary slightly in printed size.
  const scales = [0.85, 0.95, 1, 1.08, 1.18];
  for (const tpl of WATERMARK_TEMPLATES) {
    let best = -Infinity;
    let bestX = insetPx;
    let bestY = insetPx;
    let bestW = 0;
    let bestH = 0;
    for (const scale of scales) {
      const rendered = tpl.render(pxPerMm * scale);
      const stepPx = Math.max(2, Math.round(1.2 * pxPerMm));
      const minX = insetPx;
      const maxX = rect.width - insetPx - rendered.width;
      const minY = insetPx;
      const maxY = rect.height - insetPx - rendered.height;
      if (maxX < minX || maxY < minY) continue;
      for (let oy = minY; oy <= maxY; oy += stepPx) {
        for (let ox = minX; ox <= maxX; ox += stepPx) {
          const score = windowedCorrelation(flat, rendered, ox, oy);
          if (score > best) {
            best = score;
            bestX = ox;
            bestY = oy;
            bestW = rendered.width;
            bestH = rendered.height;
          }
        }
      }
    }
    best += (rng() - 0.5) * 1e-6;
    candidates.push({
      name: tpl.name,
      score: best,
      centerPx: { x: bestX + bestW / 2, y: bestY + bestH / 2 },
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0]!;
  const runnerUp = candidates[1]?.score ?? 0;
  // Require both a usable absolute correlation and a clear margin over the
  // next motif; an unwatermarked sheet yields low, mutually tied scores.
  const detected = winner.score >= minScore && winner.score >= runnerUp * minMargin;
  const centerMm = detected
    ? {
        x: (winner.centerPx.x - padPx) / pxPerMm - frame.widthMm / 2,
        y: (winner.centerPx.y - padPx) / pxPerMm - frame.heightMm / 2,
      }
    : { x: 0, y: 0 };
  return {
    detected,
    name: detected ? winner.name : 'none',
    score: winner.score,
    centerMm,
    candidates: candidates.map((c) => ({ name: c.name, score: c.score })),
  };
}
