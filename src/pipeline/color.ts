import { RgbImage } from '../image/primitives.js';
import { ColorResult } from '../types.js';
import { StampFrame } from './frame.js';
import { DesignFrame } from './centering.js';

export interface Lab {
  l: number;
  a: number;
  b: number;
}

/** sRGB (0..255, D65) -> CIE Lab. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  // sRGB D65 linear -> XYZ.
  const [rl, gl, bl] = lin;
  const x = 0.4124564 * rl! + 0.3575761 * gl! + 0.1804375 * bl!;
  const y = 0.2126729 * rl! + 0.7151522 * gl! + 0.072175 * bl!;
  const z = 0.0193339 * rl! + 0.119192 * gl! + 0.9503041 * bl!;
  // D65 reference white.
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 16 / 116);
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 colour difference (Sharma et al. formulation). */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { l: L1, a: a1, b: b1 } = lab1;
  const { l: L2, a: a2, b: b2 } = lab2;
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 180 / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(deg(hbarp - 30)) +
    0.24 * Math.cos(deg(2 * hbarp)) +
    0.32 * Math.cos(deg(3 * hbarp + 6)) -
    0.2 * Math.cos(deg(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(deg(2 * dTheta)) * RC;

  return Math.sqrt(
    (dLp / (kL * SL)) ** 2 +
      (dCp / (kC * SC)) ** 2 +
      (dHp / (kH * SH)) ** 2 +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
}

function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return h >= 0 ? h : h + 360;
}

function deg(radish: number): number {
  return (radish * Math.PI) / 180;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Representative shade of the printed design for comparison against a known
 * catalogue reference colour. Philatelic "刷色" grading asks how the stamp's
 * version of the reference ink differs, so we measure pixels that lie in the
 * reference colour's neighbourhood (Lab distance below a gate), then average
 * them robustly. A large accent/medallion in a different hue cannot hijack the
 * measurement; isolated mildew or dust is outvoted inside the gate.
 */
export function meanDesignColor(
  rect: RgbImage,
  frame: StampFrame,
  design: DesignFrame,
  reference: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  const paddingMm = 3;
  const ppm = rect.width / (frame.widthMm + 2 * paddingMm);
  const padPx = Math.round(paddingMm * ppm);
  const x0 = Math.max(padPx + 1, padPx + Math.round((design.leftMm + frame.widthMm / 2) * ppm));
  const x1 = Math.min(rect.width - padPx - 2, padPx + Math.round((design.rightMm + frame.widthMm / 2) * ppm));
  const y0 = Math.max(padPx + 1, padPx + Math.round((design.topMm + frame.heightMm / 2) * ppm));
  const y1 = Math.min(rect.height - padPx - 2, padPx + Math.round((design.bottomMm + frame.heightMm / 2) * ppm));
  const refLab = rgbToLab(reference.r, reference.g, reference.b);
  const gate = 22; // Lab distance gate around the reference ink
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.round(ppm / 4));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = y * rect.width + x;
      const r = rect.r[i]!;
      const g = rect.g[i]!;
      const b = rect.b[i]!;
      const dLab = ciede2000(refLab, rgbToLab(r, g, b));
      if (dLab <= gate) {
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
  }
  // If the gate is too tight for a badly faded stamp, fall back to the modal bin.
  if (rs.length < 50) return modalColor(rect, x0, x1, y0, y1, step);
  return { r: medianOf(rs), g: medianOf(gs), b: medianOf(bs) };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function modalColor(
  rect: RgbImage,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  step: number,
): { r: number; g: number; b: number } {
  const bin = 12;
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = y * rect.width + x;
      const r = rect.r[i]!;
      const g = rect.g[i]!;
      const b = rect.b[i]!;
      const key = (Math.round(r / bin) << 16) | (Math.round(g / bin) << 8) | Math.round(b / bin);
      const cur = bins.get(key);
      if (cur) {
        cur.r += r;
        cur.g += g;
        cur.b += b;
        cur.n++;
      } else {
        bins.set(key, { r, g, b, n: 1 });
      }
    }
  }
  let best: { r: number; g: number; b: number; n: number } | undefined;
  for (const v of bins.values()) if (!best || v.n > best.n) best = v;
  if (!best) return { r: 0, g: 0, b: 0 };
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
}

export function analyseColor(
  rect: RgbImage,
  frame: StampFrame,
  design: DesignFrame,
  reference: { r: number; g: number; b: number },
): ColorResult {
  const sample = meanDesignColor(rect, frame, design, reference);
  const labSample = rgbToLab(sample.r, sample.g, sample.b);
  const labRef = rgbToLab(reference.r, reference.g, reference.b);
  const deltaE00 = ciede2000(labRef, labSample);
  const deltaL = labSample.l - labRef.l;
  const lightnessShiftPercent = labRef.l > 0 ? (deltaL / labRef.l) * 100 : 0;
  return {
    meanRgb: { r: sample.r, g: sample.g, b: sample.b },
    meanHex: rgbToHex(sample.r, sample.g, sample.b),
    referenceRgb: { ...reference },
    referenceHex: rgbToHex(reference.r, reference.g, reference.b),
    deltaE00,
    deltaL,
    lightnessShiftPercent,
    verdict: colorVerdict(deltaE00, lightnessShiftPercent),
  };
}

export function colorVerdict(deltaE: number, lightnessShiftPercent: number): string {
  const direction =
    Math.abs(lightnessShiftPercent) < 1
      ? '刷色一致'
      : lightnessShiftPercent > 0
        ? '偏浅'
        : '偏深';
  if (deltaE < 2) return `刷色正常（${direction}，色差 ΔE00=${deltaE.toFixed(2)}）`;
  if (deltaE < 5) return `刷色轻微差异（${direction}，ΔE00=${deltaE.toFixed(2)}）`;
  if (deltaE < 10) return `刷色明显差异（${direction}，ΔE00=${deltaE.toFixed(2)}）`;
  return `刷色严重偏差（${direction}，ΔE00=${deltaE.toFixed(2)}）`;
}
