/**
 * Grayscale image with storage-independent pixel access.
 * All algorithms work on this abstraction so they never depend on PNG details.
 */
export class GrayImage {
  readonly width: number;
  readonly height: number;
  /** Row-major float32 pixels, 0..255. */
  readonly data: Float32Array;

  constructor(width: number, height: number, data?: Float32Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Float32Array(width * height);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.data[y * this.width + x]!;
  }

  set(x: number, y: number, v: number): void {
    if (!this.inBounds(x, y)) return;
    this.data[y * this.width + x] = v;
  }

  /** Bilinear sample at fractional coordinates. */
  sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const a = this.get(x0, y0);
    const b = this.get(x0 + 1, y0);
    const c = this.get(x0, y0 + 1);
    const d = this.get(x0 + 1, y0 + 1);
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  clone(): GrayImage {
    return new GrayImage(this.width, this.height, new Float32Array(this.data));
  }
}

export interface RgbPixel {
  r: number;
  g: number;
  b: number;
}

/** RGB image kept as three planar float channels (handy for colour math). */
export class RgbImage {
  readonly width: number;
  readonly height: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.r = new Float32Array(width * height);
    this.g = new Float32Array(width * height);
    this.b = new Float32Array(width * height);
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): RgbPixel {
    const i = this.idx(x, y);
    return { r: this.r[i]!, g: this.g[i]!, b: this.b[i]! };
  }

  set(x: number, y: number, px: RgbPixel): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = this.idx(x, y);
    this.r[i] = px.r;
    this.g[i] = px.g;
    this.b[i] = px.b;
  }

  toGray(): GrayImage {
    const out = new GrayImage(this.width, this.height);
    for (let i = 0; i < this.r.length; i++) {
      out.data[i] = 0.299 * this.r[i]! + 0.587 * this.g[i]! + 0.114 * this.b[i]!;
    }
    return out;
  }

  sample(x: number, y: number): RgbPixel {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const mix = (ch: Float32Array) => {
      const i00 = y0 * this.width + x0;
      const i10 = y0 * this.width + x0 + 1;
      const i01 = (y0 + 1) * this.width + x0;
      const i11 = (y0 + 1) * this.width + x0 + 1;
      const safe = (i: number) =>
        x0 >= 0 && y0 >= 0 && x0 + 1 < this.width && y0 + 1 < this.height ? ch[i]! : 0;
      return (
        safe(i00) * (1 - tx) * (1 - ty) +
        safe(i10) * tx * (1 - ty) +
        safe(i01) * (1 - tx) * ty +
        safe(i11) * tx * ty
      );
    };
    return { r: mix(this.r), g: mix(this.g), b: mix(this.b) };
  }
}

/** Separable box blur, repeated to approximate a gaussian. */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  if (radius <= 0) return img.clone();
  let src = img;
  const passes = 2;
  for (let p = 0; p < passes; p++) {
    const tmp = new GrayImage(img.width, img.height);
    const out = new GrayImage(img.width, img.height);
    const w = 2 * radius + 1;
    // horizontal
    for (let y = 0; y < img.height; y++) {
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += src.get(x, y);
      for (let x = 0; x < img.width; x++) {
        tmp.data[y * img.width + x] = acc / w;
        acc += src.get(x + radius + 1, y) - src.get(x - radius, y);
      }
    }
    // vertical
    for (let x = 0; x < img.width; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += tmp.get(x, y);
      for (let y = 0; y < img.height; y++) {
        out.data[y * img.width + x] = acc / w;
        acc += tmp.get(x, y + radius + 1) - tmp.get(x, y - radius);
      }
    }
    src = out;
  }
  return src;
}

/** Otsu threshold, returned as a gray level in 0..255. */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Array(256).fill(0) as number[];
  for (let i = 0; i < img.data.length; i++) {
    hist[Math.min(255, Math.max(0, Math.round(img.data[i]!)))]!++;
  }
  const total = img.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
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

/** Binary morphology: erode then dilate (removes thin protrusions/specks). */
export function morphologicalOpen(mask: Uint8Array, width: number, height: number, r = 1): Uint8Array {
  return dilate(erode(mask, width, height, r), width, height, r);
}

export function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && mask[yy * width + xx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

export function erode(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 1;
      for (let dy = -r; dy <= r && v; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height || !mask[yy * width + xx]) {
            v = 0;
            break;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** Connected components (4-connectivity) on a binary mask. Returns label image + component stats. */
export interface Component {
  id: number;
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
}

export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; components: Component[] } {
  const labels = new Int32Array(mask.length);
  const components: Component[] = [];
  let nextId = 1;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = nextId++;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let pixels = 0;
    labels[start] = id;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      pixels++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [i - 1, i + 1, i - width, i + width];
      for (const n of neighbours) {
        if (n < 0 || n >= mask.length) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue; // wrapped row
        if (mask[n] && !labels[n]) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    components.push({
      id,
      pixels,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / pixels,
      centroidY: sumY / pixels,
    });
  }
  return { labels, components };
}
