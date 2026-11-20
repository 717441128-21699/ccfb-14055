import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureGroundTruth, Lab, Pt, Side, StampMeta } from '../types.js';
import { clamp } from '../geometry.js';
import { savePng } from '../io.js';
import { Rng, hashSeed } from './rng.js';
import { drawWatermark, WATERMARK_NAMES, type WatermarkId } from './patterns.js';
import { labToRgb } from '../vision/color.js';

/** 扫描测试件合成器：生成带 ground truth 的正/背面 PNG */

export interface AnomalySpec {
  half?: { side: Side; alongMm: number }[];
  double?: { side: Side; alongMm: number }[];
  missed?: { side: Side; alongMm: number }[];
  torn?: { side: Side; alongMm: number }[];
}

export interface FixtureSpec {
  fixtureId: string;
  dpi: number;
  stamp: StampMeta;
  gauges: Partial<Record<Side, number>>;
  rotationDeg?: number;
  designShiftXMm?: number;
  designShiftYMm?: number;
  designMarginMm?: number;
  baseColor?: Lab;
  colorShift?: { dL: number; da: number; db: number };
  watermarkId?: WatermarkId | null;
  anomalies?: AnomalySpec;
  moldSpotCount?: number;
}

interface Hole {
  side: Side;
  alongMm: number;
  /** 相对标准孔位的法向偏移（毫米，正值向票面内） */
  normalOffsetMm: number;
  kind: 'normal' | 'half' | 'double' | 'missed' | 'torn';
}

const MM_PER_INCH = 25.4;

export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

export function buildFixture(spec: FixtureSpec, outDir: string): { front: string; back: string; groundTruth: string } {
  mkdirSync(outDir, { recursive: true });
  const rng = new Rng(hashSeed(spec.fixtureId));
  const dpi = spec.dpi;
  const sw = Math.round(mmToPx(spec.stamp.widthMm, dpi));
  const sh = Math.round(mmToPx(spec.stamp.heightMm, dpi));
  const padPx = Math.round(mmToPx(10, dpi));
  const canvasW = sw + padPx * 2;
  const canvasH = sh + padPx * 2;
  const angle = ((spec.rotationDeg ?? 0) * Math.PI) / 180;

  const holes = layoutHoles(spec);
  const groundTruth: FixtureGroundTruth = {
    fixtureId: spec.fixtureId,
    dpi,
    stamp: spec.stamp,
    gauge: gaugeRecord(spec),
    designShiftXMm: spec.designShiftXMm ?? 0,
    designShiftYMm: spec.designShiftYMm ?? 0,
    designMarginMm: spec.designMarginMm ?? 2.5,
    rotationDeg: spec.rotationDeg ?? 0,
    watermarkId: spec.watermarkId ?? null,
    anomalies: {
      half: spec.anomalies?.half ?? [],
      double: spec.anomalies?.double ?? [],
      missed: spec.anomalies?.missed ?? [],
      torn: spec.anomalies?.torn ?? [],
    },
    moldSpotCount: spec.moldSpotCount ?? 0,
    colorShift: spec.colorShift ?? { dL: 0, da: 0, db: 0 },
  };

  const front = renderLocal(spec, rng, sw, sh, holes, false);
  const back = renderLocal(spec, rng, sw, sh, holes, true);

  const frontCanvas = composeOnBed(front, canvasW, canvasH, sw, sh, padPx, angle, rng, dpi, false);
  const backCanvas = composeOnBed(back, canvasW, canvasH, sw, sh, padPx, angle, rng, dpi, true);

  const frontPath = join(outDir, `${spec.fixtureId}_front.png`);
  const backPath = join(outDir, `${spec.fixtureId}_back.png`);
  const gtPath = join(outDir, `${spec.fixtureId}.truth.json`);
  savePng(frontPath, { width: canvasW, height: canvasH, data: frontCanvas, dpi }, dpi);
  savePng(backPath, { width: canvasW, height: canvasH, data: backCanvas, dpi }, dpi);
  writeJson(gtPath, groundTruth);
  return { front: frontPath, back: backPath, groundTruth: gtPath };
}

function gaugeRecord(spec: FixtureSpec): Record<Side, number> {
  const g = spec.gauges;
  const top = g.top ?? 13;
  const right = g.right ?? top;
  const bottom = g.bottom ?? top;
  const left = g.left ?? right;
  return { top, right, bottom, left };
}

/** 按各边齿孔度数排孔，再注入异常孔 */
function layoutHoles(spec: FixtureSpec): Hole[] {
  const holes: Hole[] = [];
  const gt = gaugeRecord(spec);
  const dims: Record<Side, number> = {
    top: spec.stamp.widthMm,
    bottom: spec.stamp.widthMm,
    left: spec.stamp.heightMm,
    right: spec.stamp.heightMm,
  };
  const sides: Side[] = ['top', 'right', 'bottom', 'left'];
  for (const side of sides) {
    const lengthMm = dims[side]!;
    const pitch = 20 / gt[side]!;
    const count = Math.round(lengthMm / pitch);
    const start = (lengthMm - (count - 1) * pitch) / 2;
    for (let i = 0; i < count; i++) {
      holes.push({ side, alongMm: start + i * pitch, normalOffsetMm: 0, kind: 'normal' });
    }
  }
  for (const a of spec.anomalies?.half ?? []) {
    const h = nearestHole(holes, a.side, a.alongMm);
    if (h) { h.kind = 'half'; h.normalOffsetMm = 0.35; }
  }
  for (const a of spec.anomalies?.double ?? []) {
    const h = nearestHole(holes, a.side, a.alongMm);
    if (h) {
      h.kind = 'double';
      holes.push({ side: a.side, alongMm: h.alongMm + 0.45, normalOffsetMm: 0, kind: 'double' });
    }
  }
  for (const a of spec.anomalies?.missed ?? []) {
    const h = nearestHole(holes, a.side, a.alongMm);
    if (h) h.kind = 'missed';
  }
  for (const a of spec.anomalies?.torn ?? []) {
    const h = nearestHole(holes, a.side, a.alongMm);
    if (h) h.kind = 'torn';
  }
  return holes;
}

function nearestHole(holes: Hole[], side: Side, alongMm: number): Hole | undefined {
  let best: Hole | undefined;
  let bestD = Infinity;
  for (const h of holes) {
    if (h.side !== side || h.kind !== 'normal') continue;
    const d = Math.abs(h.alongMm - alongMm);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/** 渲染未旋转的票件局部位图 */
function renderLocal(spec: FixtureSpec, rng: Rng, sw: number, sh: number, holes: Hole[], isBack: boolean): Uint8ClampedArray {
  const dpi = spec.dpi;
  const data = new Uint8ClampedArray(sw * sh * 4);
  const paper = labToRgb({ L: 91, a: 1.5, b: -4 } as Lab);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      data[i] = paper.r;
      data[i + 1] = paper.g;
      data[i + 2] = paper.b;
      data[i + 3] = 255;
    }
  }

  if (!isBack) drawFrontDesign(spec, rng, data, sw, sh, dpi);
  if (isBack && spec.watermarkId) {
    drawWatermark(
      { width: sw, height: sh, data },
      spec.watermarkId,
      sw / 2,
      sh / 2,
      mmToPx(11, dpi),
      0.32,
      rng,
    );
  }

  // 撕坏的齿：先在票边画不规则缺损暗区（不切孔）
  for (const h of holes.filter((x) => x.kind === 'torn')) {
    paintTear(data, sw, sh, h, dpi, rng);
  }

  // 打孔（漏打孔不切；撕坏的孔也不切，表现为牙尖缺损）
  for (const h of holes) {
    if (h.kind === 'missed' || h.kind === 'torn') continue;
    cutHole(data, sw, sh, h, dpi);
  }

  // 正面霉斑
  if (!isBack) {
    for (let i = 0; i < (spec.moldSpotCount ?? 0); i++) paintMold(data, sw, sh, dpi, rng);
  }

  // 纸张颗粒噪声 + 照明渐变
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const grad = 1 + 0.04 * ((x / sw) - 0.5) - 0.03 * ((y / sh) - 0.5);
      const n = rng.gaussian(2.2);
      for (let ch = 0; ch < 3; ch++) {
        data[i + ch] = clamp(data[i + ch]! * grad + n, 0, 255);
      }
    }
  }
  return data;
}

function drawFrontDesign(spec: FixtureSpec, rng: Rng, data: Uint8ClampedArray, sw: number, sh: number, dpi: number): void {
  const margin = mmToPx(spec.designMarginMm ?? 2.5, dpi);
  const sx = mmToPx(spec.designShiftXMm ?? 0, dpi);
  const sy = mmToPx(spec.designShiftYMm ?? 0, dpi);
  const x0 = margin + sx;
  const y0 = margin + sy;
  const x1 = sw - margin + sx;
  const y1 = sh - margin + sy;

  const base: Lab = spec.baseColor ?? { L: 48, a: 42, b: 32 };
  const shift = spec.colorShift ?? { dL: 0, da: 0, db: 0 };
  const shifted = { L: base.L + shift.dL, a: base.a + shift.da, b: base.b + shift.db };
  const fill = labToRgb(shifted);
  const dark = labToRgb({ L: 22, a: 10, b: 8 });
  const light = labToRgb({ L: 82, a: -6, b: -10 });

  for (let y = Math.max(0, Math.round(y0)); y < Math.min(sh, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(sw, Math.round(x1)); x++) {
      const i = (y * sw + x) * 4;
      data[i] = fill.r;
      data[i + 1] = fill.g;
      data[i + 2] = fill.b;
    }
  }

  // 内框线（双线）
  const frame = Math.max(2, Math.round(mmToPx(0.35, dpi)));
  const inset = Math.round(mmToPx(0.9, dpi));
  drawRect(data, sw, sh, Math.round(x0 + inset), Math.round(y0 + inset), Math.round(x1 - inset), Math.round(y1 - inset), frame, dark);
  drawRect(data, sw, sh, Math.round(x0 + inset * 2.2), Math.round(y0 + inset * 2.2), Math.round(x1 - inset * 2.2), Math.round(y1 - inset * 2.2), Math.max(1, frame - 1), light);

  // 中央徽记：同心圆 + 星形，模拟主图案
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = Math.min(x1 - x0, y1 - y0) * 0.26;
  fillCircle(data, sw, sh, cx, cy, r, dark);
  fillCircle(data, sw, sh, cx, cy, r * 0.72, fill);
  const pts: Pt[] = [];
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 === 0 ? r * 0.55 : r * 0.24;
    const ang = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push({ x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) });
  }
  fillPolygon(data, sw, sh, pts, light);

  // 面值数字色块（左上、右下），制造稳定的深色采样区
  const box = Math.round(mmToPx(3.2, dpi));
  fillRect(data, sw, sh, Math.round(x0 + inset * 2.4), Math.round(y0 + inset * 2.4), box, box, dark);
  fillRect(data, sw, sh, Math.round(x1 - inset * 2.4 - box), Math.round(y1 - inset * 2.4 - box), box, box, dark);

  // 底部铭记条
  const bandH = Math.round(mmToPx(1.6, dpi));
  fillRect(data, sw, sh, Math.round(x0 + inset * 3), Math.round(y1 - inset * 3.4 - bandH), Math.round(x1 - x0 - inset * 6), bandH, dark);
  void rng;
}

function cutHole(data: Uint8ClampedArray, sw: number, sh: number, h: Hole, dpi: number): void {
  const radius = mmToPx(0.5, dpi); // 直径 1mm 的标准齿孔
  const { cx, cy } = holeCenter(h, sw, sh, dpi);
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= radius) {
        const i = (y * sw + x) * 4;
        // 扫描仪底板深色 + 孔壁渐变
        const shade = clamp(28 + (d / radius) * 22, 0, 60);
        data[i] = shade;
        data[i + 1] = shade;
        data[i + 2] = shade + 2;
      }
    }
  }
}

function holeCenter(h: Hole, sw: number, sh: number, dpi: number): { cx: number; cy: number } {
  const off = mmToPx(h.normalOffsetMm, dpi);
  switch (h.side) {
    case 'top': return { cx: mmToPx(h.alongMm, dpi), cy: off };
    case 'bottom': return { cx: mmToPx(h.alongMm, dpi), cy: sh - off };
    case 'left': return { cx: off, cy: mmToPx(h.alongMm, dpi) };
    case 'right': return { cx: sw - off, cy: mmToPx(h.alongMm, dpi) };
  }
}

function paintTear(data: Uint8ClampedArray, sw: number, sh: number, h: Hole, dpi: number, rng: Rng): void {
  const { cx, cy } = holeCenter({ ...h, normalOffsetMm: 0 }, sw, sh, dpi);
  const r = mmToPx(1.1, dpi);
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
      const nx = (x - cx) / r;
      const ny = (y - cy) / r;
      const irregular = 0.75 + 0.35 * Math.sin(5 * nx + 2) * Math.cos(4 * ny) + rng.range(-0.12, 0.12);
      if (nx * nx + ny * ny <= irregular * irregular) {
        const i = (y * sw + x) * 4;
        const shade = rng.range(24, 48);
        data[i] = shade;
        data[i + 1] = shade - 4;
        data[i + 2] = shade - 8;
      }
    }
  }
}

function paintMold(data: Uint8ClampedArray, sw: number, sh: number, dpi: number, rng: Rng): void {
  const cx = rng.range(sw * 0.18, sw * 0.82);
  const cy = rng.range(sh * 0.18, sh * 0.82);
  const r = mmToPx(rng.range(0.6, 1.6), dpi);
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d <= 1) {
        const i = (y * sw + x) * 4;
        const alpha = (1 - d) * 0.55;
        // 霉斑：褐绿色
        data[i] = clamp(data[i]! * (1 - alpha) + 96 * alpha, 0, 255);
        data[i + 1] = clamp(data[i + 1]! * (1 - alpha) + 78 * alpha, 0, 255);
        data[i + 2] = clamp(data[i + 2]! * (1 - alpha) + 42 * alpha, 0, 255);
      }
    }
  }
}

function composeOnBed(
  local: Uint8ClampedArray,
  canvasW: number,
  canvasH: number,
  sw: number,
  sh: number,
  pad: number,
  angle: number,
  rng: Rng,
  dpi: number,
  isBack: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(canvasW * canvasH * 4);
  const bed = isBack ? { r: 26, g: 26, b: 30 } : { r: 40, g: 40, b: 44 };
  for (let i = 0; i < canvasW * canvasH; i++) {
    const n = rng.gaussian(1.6);
    out[i * 4] = clamp(bed.r + n, 0, 255);
    out[i * 4 + 1] = clamp(bed.g + n, 0, 255);
    out[i * 4 + 2] = clamp(bed.b + n, 0, 255);
    out[i * 4 + 3] = 255;
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ccx = canvasW / 2;
  const ccy = canvasH / 2;
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const dx = x - ccx;
      const dy = y - ccy;
      // 逆旋转到票件局部
      const lx = dx * cos + dy * sin + sw / 2;
      const ly = -dx * sin + dy * cos + sh / 2;
      if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) continue;
      const x0 = Math.floor(lx), y0 = Math.floor(ly);
      const tx = lx - x0, ty = ly - y0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const oi = (y * canvasW + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const a = local[(y0 * sw + x0) * 4 + ch]! * (1 - tx) + local[(y0 * sw + x1) * 4 + ch]! * tx;
        const b = local[(y1 * sw + x0) * 4 + ch]! * (1 - tx) + local[(y1 * sw + x1) * 4 + ch]! * tx;
        out[oi + ch] = clamp(a * (1 - ty) + b * ty, 0, 255);
      }
    }
  }
  void pad;
  void dpi;
  return out;
}

function fillRect(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, rw: number, rh: number, rgb: { r: number; g: number; b: number }): void {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 4;
      data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b;
    }
  }
}

function drawRect(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, t: number, rgb: { r: number; g: number; b: number }): void {
  fillRect(data, w, h, x0, y0, x1 - x0, t, rgb);
  fillRect(data, w, h, x0, y1 - t, x1 - x0, t, rgb);
  fillRect(data, w, h, x0, y0, t, y1 - y0, rgb);
  fillRect(data, w, h, x1 - t, y0, t, y1 - y0, rgb);
}

function fillCircle(data: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r: number, rgb: { r: number; g: number; b: number }): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r && x >= 0 && y >= 0 && x < w && y < h) {
        const i = (y * w + x) * 4;
        data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b;
      }
    }
  }
}

function fillPolygon(data: Uint8ClampedArray, w: number, h: number, pts: Pt[], rgb: { r: number; g: number; b: number }): void {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]!); x < xs[i + 1]!; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = (y * w + x) * 4;
        data[idx] = rgb.r; data[idx + 1] = rgb.g; data[idx + 2] = rgb.b;
      }
    }
  }
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

export { WATERMARK_NAMES };
