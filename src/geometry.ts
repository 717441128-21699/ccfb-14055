import type { Pt } from './types.js';

/** 二维几何工具：凸包、最小面积外接矩形、坐标变换、双线性采样 */

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Andrew 单调链凸包 */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface MinAreaRect {
  center: Pt;
  /** 宽度方向的角度（弧度，图像坐标系 y 向下） */
  angleRad: number;
  width: number;
  height: number;
  corners: Pt[];
}

/** 旋转卡壳（逐边投影 O(n²)，票品轮廓点足够少） */
export function minAreaRect(hull: Pt[]): MinAreaRect {
  let best: MinAreaRect | null = null;
  let bestArea = Infinity;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const p0 = hull[i]!;
    const p1 = hull[(i + 1) % n]!;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ex = dx / len;
    const ey = dy / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = (p.x - p0.x) * ex + (p.y - p0.y) * ey;
      const v = -(p.x - p0.x) * ey + (p.y - p0.y) * ex;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const center = { x: p0.x + cu * ex - cv * ey, y: p0.y + cu * ey + cv * ex };
      const angleRad = Math.atan2(ey, ex);
      const corners = [
        { u: minU, v: minV }, { u: maxU, v: minV }, { u: maxU, v: maxV }, { u: minU, v: maxV },
      ].map(({ u, v }) => ({ x: p0.x + u * ex - v * ey, y: p0.y + u * ey + v * ex }));
      best = { center, angleRad, width: w, height: h, corners };
    }
  }
  return best!;
}

/** 全局坐标 -> 票件局部坐标（原点在票中心，x 沿宽边，y 沿高边，单位像素） */
export function toLocal(p: Pt, center: Pt, angleRad: number): Pt {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const c = Math.cos(-angleRad);
  const s = Math.sin(-angleRad);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function toGlobal(p: Pt, center: Pt, angleRad: number): Pt {
  // toLocal 的严格逆：x = lx*cos(a) - ly*sin(a)，y = lx*sin(a) + ly*cos(a)
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return {
    x: center.x + p.x * c - p.y * s,
    y: center.y + p.x * s + p.y * c,
  };
}

/** 双线性采样，越界返回兜底值 */
export function sampleBilinear(
  data: Uint8ClampedArray | Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
  fallback = 0,
): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return fallback;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const stride = data instanceof Float32Array ? 1 : 4;
  const i00 = (y0 * width + x0) * stride + channel;
  const i10 = (y0 * width + x1) * stride + channel;
  const i01 = (y1 * width + x0) * stride + channel;
  const i11 = (y1 * width + x1) * stride + channel;
  const a = (data[i00] ?? fallback) * (1 - tx) + (data[i10] ?? fallback) * tx;
  const b = (data[i01] ?? fallback) * (1 - ty) + (data[i11] ?? fallback) * ty;
  return a * (1 - ty) + b * ty;
}

/** 把倾斜票件校正重采样为正视图（同样像素尺寸） */
export function unwarp(img: { width: number; height: number; data: Uint8ClampedArray }, rect: { center: Pt; angleRad: number; width: number; height: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const local = { x: x - img.width / 2, y: y - img.height / 2 };
      const g = toGlobal(local, rect.center, rect.angleRad);
      for (let ch = 0; ch < 4; ch++) {
        out[(y * img.width + x) * 4 + ch] = sampleBilinear(img.data, img.width, img.height, g.x, g.y, ch, 255);
      }
    }
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 按 0.25 步长取整 */
export function roundToQuarter(v: number): number {
  return Math.round(v * 4) / 4;
}
