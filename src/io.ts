import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { ImageBuffer } from './types.js';

/** PNG/JPEG 读写；分辨率从 pHYs / JFIF 读取，可被 CLI 覆盖 */

export function loadImage(path: string, dpiOverride?: number): ImageBuffer {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) {
    const png = PNG.sync.read(readFileSync(path));
    // pngjs 的 pHYs 解析结果挂在 phys 上（像素/米）；1 dpi = 1/0.0254 像素/米
    const phys = (png as unknown as { phys?: { x: number; y: number } }).phys;
    const dpiFromPhys = phys && phys.x > 0 ? phys.x * 0.0254 : null;
    return {
      width: png.width,
      height: png.height,
      data: Uint8ClampedArray.from(png.data),
      dpi: dpiOverride ?? dpiFromPhys,
    };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const raw = readFileSync(path);
    const decoded = jpeg.decode(raw, { maxMemoryUsageInMB: 2048 });
    return {
      width: decoded.width,
      height: decoded.height,
      data: Uint8ClampedArray.from(decoded.data),
      dpi: dpiOverride ?? readJfifDpi(raw),
    };
  }
  throw new Error(`不支持的图像格式（仅支持 PNG/JPEG）: ${path}`);
}

export function savePng(path: string, img: ImageBuffer, dpi?: number): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(Buffer.from(img.data.buffer));
  if (dpi && dpi > 0) {
    const ppm = Math.round(dpi / 0.0254);
    (png as unknown as { phys: { x: number; y: number; unit: number } }).phys = { x: ppm, y: ppm, unit: 1 };
  }
  writeFileSync(path, PNG.sync.write(png));
}

/** 解析 JFIF APP0 中的密度（仅在没有 pHYs 等效信息时兜底，本项目测试件均为 PNG） */
function readJfifDpi(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xe0) {
      const len = buf.readUInt16BE(offset + 2);
      if (buf.toString('ascii', offset + 4, offset + 9) === 'JFIF\0') {
        const unit = buf[offset + 11];
        const x = buf.readUInt16BE(offset + 12);
        if (unit === 1) return x; // dpi
        if (unit === 2 && x > 0) return x * 2.54; // dpcm -> dpi
      }
      offset += 2 + len;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd9) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    offset += 2 + segLen;
  }
  return null;
}
