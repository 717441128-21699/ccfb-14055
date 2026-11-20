import type { BorderResult, ColorResult, ImageBuffer, Lab, MoldSpot, RGB } from '../types.js';
import { unwarp } from '../geometry.js';
import { colorGrade, deltaE2000, meanRgb, rgbToLab } from './color.js';
import { connectedComponents, gaussianBlur, grayscale } from './filters.js';

/** 刷色分析（票幅内采样，与标准票 Lab 基准做 ΔE2000）与霉斑检测 */

const MM_PER_INCH = 25.4;

export function analyzeColor(img: ImageBuffer, border: BorderResult, reference: Lab | null): ColorResult | null {
  if (!reference) return null;
  const dpi = img.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  const angleRad = (border.angleDeg * Math.PI) / 180;
  const data = unwarp(
    { width: img.width, height: img.height, data: img.data },
    { center: border.centerPx, angleRad, width: border.widthPx, height: border.heightPx },
  );

  const samples = collectInteriorSamples(data, img.width, img.height, border, pxPerMm);
  if (samples.length < 50) return null;
  const mean = meanRgb(samples);
  const lab = rgbToLab(mean);
  const dE = deltaE2000(lab, reference);
  const { grade, note } = colorGrade(dE);
  return {
    meanLab: roundLab(lab),
    referenceLab: roundLab(reference),
    deltaE2000: Math.round(dE * 100) / 100,
    deltaL: Math.round((lab.L - reference.L) * 100) / 100,
    deltaA: Math.round((lab.a - reference.a) * 100) / 100,
    deltaB: Math.round((lab.b - reference.b) * 100) / 100,
    grade,
    note,
  };
}

/** 只在图案内部采样：排除白纸边、齿孔黑区与霉斑褐绿色 */
function collectInteriorSamples(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  border: BorderResult,
  pxPerMm: number,
): RGB[] {
  const cx = W / 2, cy = H / 2;
  const hw = border.widthPx / 2, hh = border.heightPx / 2;
  const inset = 3.2 * pxPerMm;
  const x0 = cx - hw + inset, x1 = cx + hw - inset;
  const y0 = cy - hh + inset, y1 = cy + hh - inset;
  const stride = Math.max(2, Math.round(0.4 * pxPerMm));
  const out: RGB[] = [];
  for (let y = Math.round(y0); y < y1; y += stride) {
    for (let x = Math.round(x0); x < x1; x += stride) {
      const i = (y * W + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      if (isHoleDark(r, g, b)) continue;
      if (isPaperWhite(r, g, b)) continue;
      out.push({ r, g, b });
    }
  }
  return out;
}

function isHoleDark(r: number, g: number, b: number): boolean {
  return r < 70 && g < 70 && b < 75;
}
function isPaperWhite(r: number, g: number, b: number): boolean {
  return r > 200 && g > 198 && b > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 18;
}

/** 霉斑检测：相对环形邻域底色的黄褐偏移 + 连通域。霉斑是局部软斑，均匀图案与邻域一致，不会触发 */
export function detectMold(img: ImageBuffer, border: BorderResult): MoldSpot[] {
  const dpi = img.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  const { width: W, height: H, data } = img;
  const gray = gaussianBlur(grayscale(data, W, H), W, H, 1.0);
  // 邻域底色：半径约 2.5mm 的中值模糊（用两次不同尺度高斯近似，取较平滑者作参考）
  const baseSigma = Math.max(5, pxPerMm * 2.2);
  const baseR = gaussianBlur(channelMap(data, W, H, 0), W, H, baseSigma);
  const baseG = gaussianBlur(channelMap(data, W, H, 1), W, H, baseSigma);
  const baseB = gaussianBlur(channelMap(data, W, H, 2), W, H, baseSigma);
  const mask = new Uint8Array(W * H);

  const [tl, tr, br, bl] = border.cornersPx;
  const minX = Math.min(tl!.x, tr!.x, br!.x, bl!.x);
  const maxX = Math.max(tl!.x, tr!.x, br!.x, bl!.x);
  const minY = Math.min(tl!.y, tr!.y, br!.y, bl!.y);
  const maxY = Math.max(tl!.y, tr!.y, br!.y, bl!.y);

  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(H, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x < Math.min(W, Math.ceil(maxX)); x++) {
      if (!pointInConvex(x, y, border.cornersPx)) continue;
      const idx = y * W + x;
      const i = idx * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      if (isHoleDark(r, g, b)) continue;
      // 相对邻域底色：霉斑使 B 通道下降最明显、R 相对保留，产生黄褐偏移
      const dR = r - baseR[idx]!;
      const dB = b - baseB[idx]!;
      const yellowShift = dR - dB;
      const greenish = g - baseG[idx]!;
      if (yellowShift > 22 && dB < -6 && greenish > -12 && gray[idx]! < 200) {
        mask[idx] = 1;
      }
    }
  }
  // 霉斑是近圆形软斑（长宽比接近 1，软边缘导致填充率偏低）；框线/图案边缘是细长条，用长宽比剔除
  const minAreaPx = Math.max(110, Math.round(1.5 * pxPerMm * pxPerMm));
  const allComps = connectedComponents(mask, W, H, minAreaPx);
  const areaPerPx = 1 / (pxPerMm * pxPerMm);
  const minAreaMm2 = 3;
  const comps = allComps
    .filter((c) => {
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      return Math.min(w, h) / Math.max(w, h) > 0.55;
    })
    .filter((c) => c.pixels.length * areaPerPx >= minAreaMm2);
  return comps.map((c) => {
    const mx = (c.minX + c.maxX) / 2;
    const my = (c.minY + c.maxY) / 2;
    return {
      xMm: Math.round(((mx - border.centerPx.x) / pxPerMm) * 100) / 100,
      yMm: Math.round(((my - border.centerPx.y) / pxPerMm) * 100) / 100,
      areaMm2: Math.round(c.pixels.length * areaPerPx * 100) / 100,
    };
  });
}

/** 提取单通道为浮点图，供高斯模糊做局部底色估计 */
function channelMap(data: Uint8ClampedArray, W: number, H: number, channel: number): Float32Array {
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = data[i * 4 + channel] ?? 0;
  return out;
}

/** 点是否在凸四边形内（叉积同侧判定） */
function pointInConvex(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function roundLab(lab: Lab): Lab {
  return {
    L: Math.round(lab.L * 100) / 100,
    a: Math.round(lab.a * 100) / 100,
    b: Math.round(lab.b * 100) / 100,
  };
}
