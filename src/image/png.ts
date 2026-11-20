import { PNG } from 'pngjs';
import { GrayImage, RgbImage } from './primitives.js';
import { writeFileSync, readFileSync } from 'node:fs';

/** Read the pHYs chunk manually; pngjs parses it only on some code paths. */
function readPhys(buf: Buffer): { x: number; y: number; units: number } | undefined {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'pHYs') {
      return {
        x: buf.readUInt32BE(off + 8),
        y: buf.readUInt32BE(off + 12),
        units: buf[off + 16]!,
      };
    }
    off += 12 + len;
    if (type === 'IDAT') break;
  }
  return undefined;
}

/** Load a PNG into planar RGB + grayscale images. */
export function loadPng(path: string): { rgb: RgbImage; gray: GrayImage; dpi: number } {
  const buf = readFileSync(path);
  const png = PNG.sync.read(buf);
  const rgb = new RgbImage(png.width, png.height);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const si = (y * png.width + x) * 4;
      const di = y * png.width + x;
      rgb.r[di] = png.data[si]!;
      rgb.g[di] = png.data[si + 1]!;
      rgb.b[di] = png.data[si + 2]!;
    }
  }
  // pHYs: x/y are pixels per metre when units === 1; DPI = ppm * 0.0254.
  const phys = readPhys(buf);
  const dpi = phys && phys.units === 1 ? phys.x * 0.0254 : 0;
  return { rgb, gray: rgb.toGray(), dpi: Math.round(dpi * 10) / 10 };
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Build a pHYs chunk (pixels per metre, metres as unit). */
function physChunk(dpi: number): Buffer {
  const ppm = Math.round(dpi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data[8] = 1; // unit = metre
  const type = Buffer.from('pHYs', 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(9, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([len, type, data, crc]);
}

/** Insert a chunk immediately before the first IDAT chunk. */
function insertChunkBeforeIdat(pngBuffer: Buffer, chunk: Buffer): Buffer {
  let off = 8;
  while (off < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(off);
    const type = pngBuffer.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') {
      return Buffer.concat([pngBuffer.subarray(0, off), chunk, pngBuffer.subarray(off)]);
    }
    off += 12 + len;
  }
  return pngBuffer;
}

export function saveGrayPng(path: string, img: GrayImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(img.data[i]!)));
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

export interface PngColor {
  r: number;
  g: number;
  b: number;
}

export function saveRgbPng(
  path: string,
  rgb: RgbImage,
  options: { dpi?: number; annotations?: (ctx: PngDraw) => void } = {},
): void {
  const png = new PNG({ width: rgb.width, height: rgb.height });
  for (let i = 0; i < rgb.r.length; i++) {
    png.data[i * 4] = clamp8(rgb.r[i]!);
    png.data[i * 4 + 1] = clamp8(rgb.g[i]!);
    png.data[i * 4 + 2] = clamp8(rgb.b[i]!);
    png.data[i * 4 + 3] = 255;
  }
  const draw = new PngDraw(png);
  options.annotations?.(draw);
  let buffer = PNG.sync.write(png);
  if (options.dpi) buffer = insertChunkBeforeIdat(buffer, physChunk(options.dpi));
  writeFileSync(path, buffer);
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Minimal drawing helpers for overlaying detection results. */
export class PngDraw {
  constructor(private readonly png: PNG) {}

  private set(x: number, y: number, c: PngColor): void {
    if (x < 0 || y < 0 || x >= this.png.width || y >= this.png.height) return;
    const i = (y * this.png.width + x) * 4;
    this.png.data[i] = c.r;
    this.png.data[i + 1] = c.g;
    this.png.data[i + 2] = c.b;
  }

  line(x0: number, y0: number, x1: number, y1: number, c: PngColor, thickness = 1): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const r = (thickness - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) this.set(Math.round(x + dx), Math.round(y + dy), c);
    }
  }

  rect(x: number, y: number, w: number, h: number, c: PngColor, thickness = 1): void {
    this.line(x, y, x + w, y, c, thickness);
    this.line(x, y + h, x + w, y + h, c, thickness);
    this.line(x, y, x, y + h, c, thickness);
    this.line(x + w, y, x + w, y + h, c, thickness);
  }

  circle(cx: number, cy: number, radius: number, c: PngColor, thickness = 1): void {
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      for (let t = 0; t < thickness; t++) {
        this.set(
          Math.round(cx + Math.cos(a) * (radius - t)),
          Math.round(cy + Math.sin(a) * (radius - t)),
          c,
        );
      }
    }
  }

  cross(cx: number, cy: number, size: number, c: PngColor): void {
    this.line(cx - size, cy, cx + size, cy, c);
    this.line(cx, cy - size, cx, cy + size, c);
  }
}
