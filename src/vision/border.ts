import type { BorderResult, ImageBuffer, Pt } from '../types.js';
import { convexHull, minAreaRect } from '../geometry.js';
import { binaryMask, close3, connectedComponents, gaussianBlur, grayscale, otsuThreshold } from './filters.js';

const MM_PER_INCH = 25.4;

/** 定位邮票边框：深色底板上的浅色票件 -> 最大连通域凸包的最小面积外接矩形 */

export function detectBorder(img: ImageBuffer): BorderResult {
  const { width, height, data } = img;
  const gray = grayscale(data, width, height);
  const blurred = gaussianBlur(gray, width, height, 1.2);
  const th = otsuThreshold(blurred);
  // 票件亮、底板暗；阈值留容差，避免齿孔阴影把边缘打碎
  const mask = binaryMask(blurred, th - 10);
  // 闭运算把齿孔缺口与票体连成整体（迭代次数随 DPI 缩放，约覆盖 1.2mm）
  const iterations = Math.max(2, Math.round((((img.dpi ?? 300) / 25.4) * 1.2) / 2));
  const closed = close3(mask, width, height, iterations);
  const comps = connectedComponents(closed, width, height, 500);
  if (comps.length === 0) throw new Error('未检测到票件连通域，请确认扫描件为深底浅色票');
  comps.sort((a, b) => b.pixels.length - a.pixels.length);
  const main = comps[0]!;

  // 用连通域外轮廓点做凸包（抽样以控成本）
  const step = Math.max(1, Math.floor(main.pixels.length / 12000));
  const sampled: Pt[] = [];
  for (let i = 0; i < main.pixels.length; i += step) {
    const idx = main.pixels[i]!;
    sampled.push({ x: idx % width, y: Math.floor(idx / width) });
  }
  const hull = convexHull(sampled);
  const rect = minAreaRect(hull);

  const dpi = img.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;

  // 由四角直接确定宽轴/高轴：取最靠左上的角为原点，两条邻边中更接近水平的为宽边
  const corners = [...rect.corners];
  let originIdx = 0;
  for (let i = 1; i < corners.length; i++) {
    if (corners[i]!.x + corners[i]!.y < corners[originIdx]!.x + corners[originIdx]!.y) originIdx = i;
  }
  const o = corners[originIdx]!;
  const next = corners[(originIdx + 1) % 4]!;
  const prev = corners[(originIdx + 3) % 4]!;
  const vNext = { x: next.x - o.x, y: next.y - o.y };
  const vPrev = { x: prev.x - o.x, y: prev.y - o.y };
  const lenNext = Math.hypot(vNext.x, vNext.y);
  const lenPrev = Math.hypot(vPrev.x, vPrev.y);

  // 更接近水平（|cos| 更大）的边作为宽轴
  const nextHorizontal = Math.abs(vNext.x) / lenNext >= Math.abs(vPrev.x) / lenPrev;
  const widthVec = nextHorizontal ? vNext : vPrev;
  const widthPx = nextHorizontal ? lenNext : lenPrev;
  const heightPx = nextHorizontal ? lenPrev : lenNext;

  // 宽轴有向角（图像坐标 y 向下），范围 (-90,90]
  let angleDeg = (Math.atan2(widthVec.y, widthVec.x) * 180) / Math.PI;
  if (angleDeg > 90) angleDeg -= 180;
  if (angleDeg <= -90) angleDeg += 180;

  // 角点按 左上、右上、右下、左下 重排（沿宽轴再沿高轴）
  const ordered = orderCorners(rect.corners, rect.center, angleDeg);

  return {
    centerPx: rect.center,
    angleDeg,
    widthPx,
    heightPx,
    widthMm: widthPx / pxPerMm,
    heightMm: heightPx / pxPerMm,
    cornersPx: ordered,
  };
}

/** 按角度把角点投影到局部宽/高轴，排序为 左上、右上、右下、左下 */
function orderCorners(corners: Pt[], center: Pt, angleDeg: number): Pt[] {
  const a = (angleDeg * Math.PI) / 180;
  const ex = { x: Math.cos(a), y: Math.sin(a) };
  const ey = { x: -Math.sin(a), y: Math.cos(a) };
  const projected = corners.map((c) => {
    const dx = c.x - center.x;
    const dy = c.y - center.y;
    return { c, u: dx * ex.x + dy * ex.y, v: dx * ey.x + dy * ey.y };
  });
  const uMed = median(projected.map((p) => p.u));
  const vMed = median(projected.map((p) => p.v));
  const tl = projected.find((p) => p.u < uMed && p.v < vMed)!;
  const tr = projected.find((p) => p.u >= uMed && p.v < vMed)!;
  const br = projected.find((p) => p.u >= uMed && p.v >= vMed)!;
  const bl = projected.find((p) => p.u < uMed && p.v >= vMed)!;
  return [tl.c, tr.c, br.c, bl.c];
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
