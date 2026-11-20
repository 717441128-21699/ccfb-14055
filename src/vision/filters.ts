import { clamp } from '../geometry.js';


/** 灰度、亮度、高斯平滑、Otsu、形态学与连通域 */

export function grayscale(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/** 可分离高斯（sigma 像素，半径自动取 3σ） */
export function gaussianBlur(src: Float32Array, width: number, height: number, sigmaPx: number): Float32Array {
  const r = Math.max(1, Math.round(sigmaPx * 3));
  const kernel: number[] = [];
  let norm = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
    kernel.push(v);
    norm += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] ?? 0) / norm;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = clamp(x + k, 0, width - 1);
        acc += src[y * width + xx]! * kernel[k + r]!;
      }
      tmp[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = clamp(y + k, 0, height - 1);
        acc += tmp[yy * width + x]! * kernel[k + r]!;
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/** Otsu 阈值（输入灰度 0-255） */
export function otsuThreshold(gray: Float32Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[clamp(Math.round(gray[i]!), 0, 255)]!++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export function binaryMask(gray: Float32Array, threshold: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i]! > threshold ? 1 : 0;
  return out;
}

/** 3x3 形态学闭运算（先膨胀后腐蚀），用于把齿孔与票体连为整体 */
export function close3(mask: Uint8Array, width: number, height: number, iterations = 1): Uint8Array {
  let cur = mask;
  const dilate = (src: Uint8Array): Uint8Array => {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && xx < width && yy >= 0 && yy < height && src[yy * width + xx]) { v = 1; break; }
          }
        }
        dst[y * width + x] = v;
      }
    }
    return dst;
  };
  const erode = (src: Uint8Array): Uint8Array => {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 1;
        for (let dy = -1; dy <= 1 && v; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= width || yy < 0 || yy >= height || !src[yy * width + xx]) { v = 0; break; }
          }
        }
        dst[y * width + x] = v;
      }
    }
    return dst;
  };
  for (let i = 0; i < iterations; i++) cur = erode(dilate(cur));
  return cur;
}

export interface Component {
  pixels: number[];
  minX: number; maxX: number; minY: number; maxY: number;
}

/** 4 邻接连通域（返回大于 minSize 的分量） */
export function connectedComponents(mask: Uint8Array, width: number, height: number, minSize = 20): Component[] {
  const labels = new Int32Array(mask.length).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = comps.length;
    const pixels: number[] = [];
    let minX = width, maxX = 0, minY = height, maxY = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      pixels.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neigh = [idx - 1, idx + 1, idx - width, idx + width];
      for (const nb of neigh) {
        if (nb < 0 || nb >= mask.length || labels[nb] !== -1 || !mask[nb]) continue;
        if (nb === idx - 1 && x === 0) continue;
        if (nb === idx + 1 && x === width - 1) continue;
        labels[nb] = id;
        stack.push(nb);
      }
    }
    if (pixels.length >= minSize) comps.push({ pixels, minX, maxX, minY, maxY });
  }
  return comps;
}

/** 移动平均平滑一维信号 */
export function smooth1d(signal: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out: number[] = [];
  for (let i = 0; i < signal.length; i++) {
    let acc = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < signal.length) { acc += signal[j]!; n++; }
    }
    out.push(acc / n);
  }
  return out;
}
