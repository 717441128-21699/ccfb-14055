import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { AnalysisResult, FixtureGroundTruth, Lab, StampMeta } from './types.js';
import { loadImage } from './io.js';
import { detectBorder } from './vision/border.js';
import { analyzePerforations } from './vision/perforation.js';
import { analyzeCentering } from './vision/centering.js';
import { analyzeColor, detectMold } from './vision/colorAnalysis.js';
import { analyzeWatermark } from './vision/watermark.js';
import type { WatermarkId } from './fixture/patterns.js';
import type { ReferenceEntry } from './catalog.js';

/** 分析流水线：扫描件 -> 完整 AnalysisResult */

export interface AnalyzeOptions {
  meta: StampMeta;
  dpiOverride?: number;
  reference?: ReferenceEntry;
  backFile?: string;
  backDpiOverride?: number;
}

export function analyzeScan(frontPath: string, opts: AnalyzeOptions): AnalysisResult {
  const img = loadImage(frontPath, opts.dpiOverride);
  if (!img.dpi) {
    throw new Error('图像缺少分辨率信息，请用 --dpi 显式指定扫描仪分辨率');
  }
  const border = detectBorder(img);
  const perforations = analyzePerforations(img, border);
  const centering = analyzeCentering(img, border);
  const color = analyzeColor(img, border, opts.reference?.standardLab ?? null);
  const moldSpots = detectMold(img, border);

  let watermark = null;
  if (opts.backFile) {
    const back = loadImage(opts.backFile, opts.backDpiOverride ?? opts.dpiOverride);
    const backBorder = detectBorder(back);
    watermark = analyzeWatermark(back, backBorder, (opts.reference?.watermarkId ?? null) as WatermarkId | null);
  }

  const allAnomalies = Object.values(perforations).flatMap((p) => p.anomalies);
  const pick = (kind: AnalysisResult['defects']['tornTeeth'][number]['kind']) =>
    allAnomalies.filter((a) => a.kind === kind);

  return {
    schemaVersion: 1,
    meta: {
      ...opts.meta,
      frontFile: basename(frontPath),
      backFile: opts.backFile ? basename(opts.backFile) : undefined,
      dpi: img.dpi,
      analyzedAt: new Date().toISOString(),
    },
    border: {
      angleDeg: Math.round(border.angleDeg * 100) / 100,
      widthMm: Math.round(border.widthMm * 100) / 100,
      heightMm: Math.round(border.heightMm * 100) / 100,
    },
    perforations,
    centering,
    color,
    watermark,
    defects: {
      tornTeeth: pick('torn'),
      halfHoles: pick('half'),
      doubleHoles: pick('double'),
      missedHoles: pick('missed'),
      moldSpots,
    },
  };
}

export function loadGroundTruth(path: string): FixtureGroundTruth {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureGroundTruth;
}

export function lab(l: number, a: number, b: number): Lab {
  return { L: l, a, b };
}
