import type { Lab, Pt } from '../types.js';
import { Rng } from './rng.js';
import { labToRgb } from '../vision/color.js';
import { clamp } from '../geometry.js';

/** 水印图案：在票幅局部位图上绘制低对比度的压痕图案 */

export const WATERMARK_PATTERNS = ['wavy', 'star', 'crown', 'lozenge', 'character'] as const;
export type WatermarkId = (typeof WATERMARK_PATTERNS)[number];

export const WATERMARK_NAMES: Record<WatermarkId, string> = {
  wavy: '波浪纹水印',
  star: '五角星水印',
  crown: '皇冠纹水印',
  lozenge: '菱格纹水印',
  character: '“水”字水印',
};

interface Canvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function setPx(c: Canvas, x: number, y: number, rgb: { r: number; g: number; b: number }, alpha: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= c.width || yi >= c.height) return;
  const i = (yi * c.width + xi) * 4;
  c.data[i] = clamp(c.data[i]! * (1 - alpha) + rgb.r * alpha, 0, 255);
  c.data[i + 1] = clamp(c.data[i + 1]! * (1 - alpha) + rgb.g * alpha, 0, 255);
  c.data[i + 2] = clamp(c.data[i + 2]! * (1 - alpha) + rgb.b * alpha, 0, 255);
  c.data[i + 3] = 255;
}

function line(c: Canvas, a: Pt, b: Pt, rgb: { r: number; g: number; b: number }, alpha: number, thickness = 1.4): void {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2);
  const half = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    for (let ox = -half; ox <= half; ox += 0.5) setPx(c, x + ox, y, rgb, alpha);
  }
}

function poly(c: Canvas, pts: Pt[], rgb: { r: number; g: number; b: number }, alpha: number): void {
  for (let i = 0; i < pts.length; i++) line(c, pts[i]!, pts[(i + 1) % pts.length]!, rgb, alpha);
}

/** 在票面中心绘制约 sizeMm 大小的水印 */
export function drawWatermark(
  c: Canvas,
  id: WatermarkId,
  cx: number,
  cy: number,
  sizePx: number,
  alpha: number,
  rng: Rng,
): void {
  // 背光下水印压痕处透光略强 -> 略亮于纸面
  const rgb = labToRgb({ L: 88, a: 0, b: 0 } as Lab);
  const s = sizePx;
  switch (id) {
    case 'wavy': {
      for (let row = -2; row <= 2; row++) {
        const y0 = cy + row * s * 0.16;
        let prev: Pt | null = null;
        for (let x = -s / 2; x <= s / 2; x += s * 0.06) {
          const p = { x: cx + x, y: y0 + Math.sin((x / s) * Math.PI * 3) * s * 0.05 };
          if (prev) line(c, prev, p, rgb, alpha);
          prev = p;
        }
      }
      break;
    }
    case 'star': {
      const pts: Pt[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? s * 0.42 : s * 0.18;
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      }
      poly(c, pts, rgb, alpha);
      break;
    }
    case 'crown': {
      const w = s * 0.7;
      const h = s * 0.5;
      const base: Pt[] = [
        { x: cx - w / 2, y: cy + h / 2 },
        { x: cx + w / 2, y: cy + h / 2 },
        { x: cx + w / 2, y: cy },
        { x: cx + w * 0.25, y: cy + h * 0.15 },
        { x: cx, y: cy - h / 2 },
        { x: cx - w * 0.25, y: cy + h * 0.15 },
        { x: cx - w / 2, y: cy },
      ];
      poly(c, base, rgb, alpha);
      line(c, { x: cx - w / 2, y: cy + h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, rgb, alpha * 1.3, 2.2);
      break;
    }
    case 'lozenge': {
      const step = s * 0.16;
      for (let gy = -s / 2; gy < s / 2; gy += step) {
        for (let gx = -s / 2; gx < s / 2; gx += step) {
          const x = cx + gx + rng.range(-0.5, 0.5);
          const y = cy + gy + rng.range(-0.5, 0.5);
          const r = step * 0.42;
          poly(
            c,
            [
              { x, y: y - r },
              { x: x + r, y },
              { x, y: y + r },
              { x: x - r, y },
            ],
            rgb,
            alpha * 0.8,
          );
        }
      }
      break;
    }
    case 'character': {
      // 简笔“水”字：竖钩 + 横撇 + 撇捺
      const w = s * 0.55;
      const h = s * 0.6;
      line(c, { x: cx, y: cy - h / 2 }, { x: cx, y: cy + h / 2 }, rgb, alpha * 1.2, 2);
      line(c, { x: cx - w / 2, y: cy - h * 0.18 }, { x: cx + w / 2, y: cy - h * 0.32 }, rgb, alpha, 1.6);
      line(c, { x: cx, y: cy - h * 0.25 }, { x: cx - w * 0.42, y: cy + h * 0.05 }, rgb, alpha, 1.6);
      line(c, { x: cx, y: cy + h * 0.02 }, { x: cx - w * 0.45, y: cy + h * 0.45 }, rgb, alpha, 1.6);
      line(c, { x: cx, y: cy + h * 0.02 }, { x: cx + w * 0.45, y: cy + h * 0.42 }, rgb, alpha, 1.6);
      break;
    }
  }
}
