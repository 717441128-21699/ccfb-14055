import type { BorderResult, CenteringResult, ImageBuffer, Pt, Side } from '../types.js';
import { sampleBilinear } from '../geometry.js';
import { gaussianBlur, grayscale } from './filters.js';

/** 居中测量：从四条票边中点沿内法线扫描，定位图案边界，亚像素计算白边（毫米） */

const MM_PER_INCH = 25.4;

export function analyzeCentering(img: ImageBuffer, border: BorderResult): CenteringResult {
  const dpi = img.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  const gray = gaussianBlur(grayscale(img.data, img.width, img.height), img.width, img.height, 1.0);
  const W = img.width, H = img.height;
  const [tl, tr, br, bl] = border.cornersPx;

  // 四边中点与内法线。外法向与 perforation 模块同一套约定，内法线 = 外法向取反
  const outward: Record<Side, Pt> = {
    top: unit({ x: tr!.y - tl!.y, y: -(tr!.x - tl!.x) }),
    right: unit({ x: br!.y - tr!.y, y: -(br!.x - tr!.x) }),
    bottom: unit({ x: -(br!.y - bl!.y), y: br!.x - bl!.x }),
    left: unit({ x: -(bl!.y - tl!.y), y: bl!.x - tl!.x }),
  };
  const sideLen: Record<Side, number> = {
    top: border.heightPx / 2, bottom: border.heightPx / 2,
    left: border.widthPx / 2, right: border.widthPx / 2,
  };
  const sideMid: Record<Side, Pt> = {
    top: midpoint(tl!, tr!), bottom: midpoint(bl!, br!),
    left: midpoint(tl!, bl!), right: midpoint(tr!, br!),
  };

  const marginsPx = {} as Record<Side, number>;
  (Object.keys(sideMid) as Side[]).forEach((side) => {
    const mid = sideMid[side]!;
    const inward = scale(outward[side]!, -1);
    const halfLen = sideLen[side]!;
    // 从票边向票内扫描亮度剖面，白纸边亮、图案区暗，取最大梯度为图案边界
    const band = Math.max(2, Math.round(0.8 * pxPerMm));
    const prof: number[] = [];
    // 从票边内 0.8mm 处起扫，跳过底板->纸边过渡，剖面起点即在白纸边上
    const startInset = Math.round(0.8 * pxPerMm);
    const steps = Math.round(halfLen * 0.95) - startInset;
    for (let k = 0; k <= steps; k++) {
      const d = startInset + k;
      const cx = mid.x + inward.x * d;
      const cy = mid.y + inward.y * d;
      let acc = 0, n = 0;
      // 沿边方向取窄带平均，抑制噪声
      const edgeDir = perpendicular(inward);
      for (let t = -band; t <= band; t += 2) {
        const v = sampleBilinear(gray, W, H, cx + edgeDir.x * t, cy + edgeDir.y * t, 0, 255);
        acc += v; n++;
      }
      prof.push(acc / Math.max(1, n));
    }
    // 剖面起点已在纸面内，直接找纸边->图案的亮暗下降沿，白边 = 起点内缩 + 下降沿位置
    const paperLevel = percentile(prof.slice(0, Math.max(3, Math.round(steps * 0.15))), 60);
    const designLevel = percentile(prof.slice(Math.round(steps * 0.55), Math.round(steps * 0.9)), 50);
    const edgeOffset = findDesignEdge(prof, paperLevel, designLevel);
    marginsPx[side] = Math.max(0, startInset + edgeOffset);
  });

  const marginsMm: Record<Side, number> = {
    top: round5(marginsPx.top / pxPerMm),
    bottom: round5(marginsPx.bottom / pxPerMm),
    left: round5(marginsPx.left / pxPerMm),
    right: round5(marginsPx.right / pxPerMm),
  };
  // 偏移：左边白边大 = 图案偏右；上边白边大 = 图案偏下
  const offsetXMm = round5((marginsMm.left - marginsMm.right) / 2);
  const offsetYMm = round5((marginsMm.top - marginsMm.bottom) / 2);

  return { marginsMm, offsetXMm, offsetYMm, grade: centeringGrade(marginsMm) };
}

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function unit(v: Pt): Pt {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}
function scale(v: Pt, s: number): Pt {
  return { x: v.x * s, y: v.y * s };
}
function perpendicular(v: Pt): Pt {
  return { x: -v.y, y: v.x };
}

/** 剖面起点已在纸面内，定位纸边->图案的亮暗下降沿（亚像素） */
function findDesignEdge(prof: number[], paperLevel: number, designLevel: number): number {
  const threshold = paperLevel - (paperLevel - designLevel) * 0.45;
  for (let i = 1; i < prof.length; i++) {
    if (prof[i - 1]! >= threshold && prof[i]! < threshold) {
      const denom = prof[i - 1]! - prof[i]!;
      const sub = denom > 1e-6 ? (prof[i - 1]! - threshold) / denom : 0;
      return i - 1 + Math.max(0, Math.min(1, sub));
    }
  }
  return maxGradientIndex(prof);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor((p / 100) * s.length)))]!;
}

/** 最大梯度位置 + 线性亚像素插值（兜底） */
function maxGradientIndex(prof: number[]): number {
  let best = 1;
  let bestMag = -1;
  for (let i = 2; i < prof.length - 2; i++) {
    const mag = Math.abs(prof[i + 1]! - prof[i - 1]!);
    if (mag > bestMag) { bestMag = mag; best = i; }
  }
  const g0 = prof[best]! - prof[best - 1]!;
  const g1 = prof[best + 1]! - prof[best]!;
  const denom = g0 - g1;
  const sub = Math.abs(denom) > 1e-6 ? clamp01(g0 / denom) - 0.5 : 0;
  return Math.max(0, best + sub);
}

function centeringGrade(m: Record<Side, number>): CenteringResult['grade'] {
  const hMin = Math.min(m.left, m.right);
  const hMax = Math.max(m.left, m.right);
  const vMin = Math.min(m.top, m.bottom);
  const vMax = Math.max(m.top, m.bottom);
  const hRatio = hMin / Math.max(0.01, hMax);
  const vRatio = vMin / Math.max(0.01, vMax);
  const r = Math.min(hRatio, vRatio);
  if (r >= 0.9) return '优等';
  if (r >= 0.75) return '良好';
  if (r >= 0.55) return '一般';
  return '偏斜';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function round5(v: number): number {
  return Math.round(v * 1000) / 1000;
}
