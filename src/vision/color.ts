import type { Lab, RGB } from '../types.js';
import { clamp } from '../geometry.js';

/** sRGB / XYZ(D65) / Lab 转换与 CIEDE2000 色差 */

export function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

export function rgbToXyz(rgb: RGB): { x: number; y: number; z: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  // sRGB D65
  return {
    x: (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100,
    y: (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) * 100,
    z: (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) * 100,
  };
}

export function xyzToLab(x: number, y: number, z: number): Lab {
  // D65 参考白点
  const xn = 95.047, yn = 100.0, zn = 108.883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / xn), fy = f(y / yn), fz = f(z / zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function rgbToLab(rgb: RGB): Lab {
  const { x, y, z } = rgbToXyz(rgb);
  return xyzToLab(x, y, z);
}

export function labToXyz(L: number, a: number, b: number): { x: number; y: number; z: number } {
  const xn = 95.047, yn = 100.0, zn = 108.883;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const finv = (f: number) => (f ** 3 > 0.008856 ? f ** 3 : (f - 16 / 116) / 7.787);
  return { x: finv(fx) * xn, y: finv(fy) * yn, z: finv(fz) * zn };
}

export function xyzToRgb(x: number, y: number, z: number): RGB {
  const X = x / 100, Y = y / 100, Z = z / 100;
  let r = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  let g = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
  let bl = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return {
    r: clamp(enc(r) * 255, 0, 255),
    g: clamp(enc(g) * 255, 0, 255),
    b: clamp(enc(bl) * 255, 0, 255),
  };
}

export function labToRgb(lab: Lab): RGB {
  const { x, y, z } = labToXyz(lab.L, lab.a, lab.b);
  return xyzToRgb(x, y, z);
}

export function meanRgb(samples: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const s of samples) { r += s.r; g += s.g; b += s.b; }
  const n = Math.max(1, samples.length);
  return { r: clamp(r / n, 0, 255), g: clamp(g / n, 0, 255), b: clamp(b / n, 0, 255) };
}

/** CIEDE2000，参考 Sharma 2005 公式实现 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const h1p = C1p === 0 ? 0 : hueAngle(b1, a1p);
  const h2p = C2p === 0 ? 0 : hueAngle(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p === 0 || C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const avgLp = (L1 + L2) / 2;
  let avgHp: number;
  if (C1p === 0 || C2p === 0) avgHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) avgHp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) avgHp = (h1p + h2p + 360) / 2;
  else avgHp = (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(deg(avgHp - 30)) +
    0.24 * Math.cos(deg(2 * avgHp)) +
    0.32 * Math.cos(deg(3 * avgHp + 6)) -
    0.20 * Math.cos(deg(4 * avgHp - 63));
  const dTheta = 30 * Math.exp(-(((avgHp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (avgLp - 50) ** 2) / Math.sqrt(20 + (avgLp - 50) ** 2);
  const SC = 1 + 0.045 * avgCp;
  const SH = 1 + 0.015 * avgCp * T;
  const RT = -Math.sin(deg(2 * dTheta)) * RC;
  const kL = 1, kC = 1, kH = 1;
  return Math.sqrt(
    (dLp / (kL * SL)) ** 2 +
      (dCp / (kC * SC)) ** 2 +
      (dHp / (kH * SH)) ** 2 +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
}

function hueAngle(b: number, a: number): number {
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h;
}
function deg(rad: number): number {
  return (rad * Math.PI) / 180;
}

export function colorGrade(dE: number): { grade: ColorResult['grade']; note: string } {
  if (dE < 1) return { grade: '极微', note: '人眼基本不可辨，符合标准刷色' };
  if (dE < 2) return { grade: '轻微', note: '训练有素者可辨，正常批次差异范围' };
  if (dE < 3.5) return { grade: '可辨', note: '一般人可察觉的刷色差异' };
  if (dE < 6) return { grade: '明显', note: '明显偏色，建议复核印次或褪色因素' };
  return { grade: '显著', note: '显著偏色，疑似褪色、变色或非标准印次' };
}

type ColorResult = { grade: '极微' | '轻微' | '可辨' | '明显' | '显著'; note: string };
