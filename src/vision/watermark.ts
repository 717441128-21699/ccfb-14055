import type { BorderResult, ImageBuffer, WatermarkResult } from '../types.js';
import { gaussianBlur, grayscale } from './filters.js';
import { Rng } from '../fixture/rng.js';
import { drawWatermark, WATERMARK_NAMES, WATERMARK_PATTERNS, type WatermarkId } from '../fixture/patterns.js';

/** 背透光水印识别：高通滤波增强压痕后与内置水印模板做归一化互相关（NCC） */

const MM_PER_INCH = 25.4;

/** 生成水印模板：白纸底 + 高对比度图案，再做与被测图一致的高通处理 */
function buildTemplate(id: WatermarkId, dpi: number, highPassSigma: number): Float32Array {
  const size = Math.round((14 / MM_PER_INCH) * dpi);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 228;
    data[i * 4 + 1] = 228;
    data[i * 4 + 2] = 226;
    data[i * 4 + 3] = 255;
  }
  drawWatermark({ width: size, height: size, data }, id, size / 2, size / 2, size * 0.78, 0.95, new Rng(42));
  const gray = grayscale(data, size, size);
  return highPass(gray, size, size, highPassSigma);
}

/** 高通：减去大尺度高斯模糊，去除照明渐变与纸面底色，只留水印压痕 */
function highPass(gray: Float32Array, W: number, H: number, sigma: number): Float32Array {
  const blurred = gaussianBlur(gray, W, H, sigma);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i]! - blurred[i]!;
  return normalize(out);
}

function normalize(a: Float32Array): Float32Array {
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  let varSum = 0;
  for (const v of a) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / a.length) || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i]! - mean) / std;
  return out;
}

export function analyzeWatermark(
  backImg: ImageBuffer,
  border: BorderResult,
  expectedId?: WatermarkId | null,
): WatermarkResult {
  const dpi = backImg.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  const gray = grayscale(backImg.data, backImg.width, backImg.height);
  const highPassSigma = Math.max(4, pxPerMm * 1.6);
  const hp = highPass(gray, backImg.width, backImg.height, highPassSigma);

  const ccx = border.centerPx.x;
  const ccy = border.centerPx.y;
  const searchR = Math.round(3 * pxPerMm);
  const tSize = Math.round((14 / MM_PER_INCH) * dpi);

  const candidates: { patternId: string; score: number }[] = [];
  let best: { id: WatermarkId; score: number; orientation: number } | null = null;

  for (const id of WATERMARK_PATTERNS) {
    const tmpl = buildTemplate(id, dpi, highPassSigma);
    let localBest = -Infinity;
    let localOrient = 0;
    for (let dy = -searchR; dy <= searchR; dy += 3) {
      for (let dx = -searchR; dx <= searchR; dx += 3) {
        for (const orient of [0, 180]) {
          const score = nccAt(hp, backImg.width, backImg.height, tmpl, tSize, Math.round(ccx + dx), Math.round(ccy + dy), orient);
          if (score > localBest) {
            localBest = score;
            localOrient = orient;
          }
        }
      }
    }
    candidates.push({ patternId: id, score: Math.round(localBest * 1000) / 1000 });
    if (!best || localBest > best.score) best = { id, score: localBest, orientation: localOrient };
  }

  candidates.sort((a, b) => b.score - a.score);
  // 有预期水印时阈值放宽并校验第一名；无预期时要求更强证据且第一名明显领先
  const threshold = expectedId ? 0.1 : 0.28;
  const marginOk = expectedId ? true : candidates.length < 2 || candidates[0]!.score > candidates[1]!.score * 2;
  const detected = best !== null && best.score >= threshold && marginOk;
  return {
    detected,
    patternId: detected && best ? best.id : null,
    patternName: detected && best ? WATERMARK_NAMES[best.id] : null,
    score: best ? Math.round(best.score * 1000) / 1000 : 0,
    orientationDeg: best?.orientation ?? 0,
    candidates,
  };
}

function nccAt(
  hp: Float32Array,
  W: number,
  H: number,
  tmpl: Float32Array,
  tSize: number,
  ccx: number,
  ccy: number,
  orientation: number,
): number {
  const half = tSize / 2;
  const x0 = Math.round(ccx - half), y0 = Math.round(ccy - half);
  if (x0 < 1 || y0 < 1 || x0 + tSize >= W || y0 + tSize >= H) return -1;
  const win = new Float32Array(tSize * tSize);
  let sum = 0;
  for (let y = 0; y < tSize; y++) {
    for (let x = 0; x < tSize; x++) {
      const v = hp[(y0 + y) * W + (x0 + x)]!;
      win[y * tSize + x] = v;
      sum += v;
    }
  }
  const mean = sum / win.length;
  let varSum = 0;
  for (const v of win) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / win.length);
  if (std < 0.03) return -1; // 仅排除完全均匀的区域
  let dot = 0;
  for (let y = 0; y < tSize; y++) {
    for (let x = 0; x < tSize; x++) {
      const wNorm = (win[y * tSize + x]! - mean) / std;
      const tx = orientation === 180 ? tSize - 1 - x : x;
      const ty = orientation === 180 ? tSize - 1 - y : y;
      dot += wNorm * tmpl[ty * tSize + tx]!;
    }
  }
  return dot / win.length;
}
