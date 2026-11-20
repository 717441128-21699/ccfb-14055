import { GrayImage, RgbImage } from '../image/primitives.js';
import {
  AnomalyRecord,
  CatalogEntry,
  ColorResult,
  EdgeName,
  GradingResult,
  WatermarkResult,
} from '../types.js';
import { StampFrame, detectFrame } from './frame.js';
import { sampleRectifiedEdge } from './rectEdge.js';
import { analyseEdge, summarizePerforation } from './perforation.js';
import { locateDesignFrame, measureCentering } from './centering.js';
import { analyseColor } from './color.js';
import { matchWatermark } from './watermark.js';
import { detectMildew } from './mildew.js';

const EDGE_NAMES: EdgeName[] = ['top', 'right', 'bottom', 'left'];

export interface AnalyzeOptions {
  sourceFile: string;
  scanSide: 'front' | 'back';
  dpiOverride?: number;
  catalogEntry?: CatalogEntry;
  groundTruth?: unknown;
}

export interface AnalyzeArtifacts {
  result: GradingResult;
  frame: StampFrame;
  rectGray: GrayImage;
  rectRgb: RgbImage;
}

/** Full grading pipeline for one scan. */
export function analyzeScan(
  rgb: RgbImage,
  gray: GrayImage,
  scanDpi: number,
  opts: AnalyzeOptions,
): AnalyzeArtifacts {
  const dpi = opts.dpiOverride ?? scanDpi;
  if (!dpi || dpi < 50) {
    throw new Error(
      `Scan DPI unknown (${scanDpi || 'not embedded'}). Pass --dpi to set the scanner resolution.`,
    );
  }

  const frame = detectFrame(gray, dpi);
  const rectGray = frame.rectifyGray(gray);
  const rectRgb = frame.rectifyRgb(rgb);

  // Perforations: sample each edge on the rotation-free rectified image so
  // pixel position maps directly to physical millimetres, then fit a lattice.
  const edgeEntries = EDGE_NAMES.map((edge) => {
    const rays = sampleRectifiedEdge(rectGray, frame, edge, frame.edgeThreshold);
    const lengthMm =
      edge === 'top' || edge === 'bottom' ? frame.widthMm : frame.heightMm;
    return [edge, analyseEdge(edge, rays, lengthMm)] as const;
  });
  const edges = Object.fromEntries(edgeEntries) as Record<EdgeName, (typeof edgeEntries)[number][1]>;
  const perforation = summarizePerforation(edges);

  // Centering (front only carries a printed design, but the routine is
  // resolution independent and works either way).
  const design = locateDesignFrame(rectGray, frame);
  const centering = measureCentering(rectGray, frame);

  // Colour vs. catalogue reference, front scans only.
  let color: ColorResult | null = null;
  if (opts.scanSide === 'front' && opts.catalogEntry?.reference?.colorRgb) {
    color = analyseColor(rectRgb, frame, design, opts.catalogEntry.reference.colorRgb);
  }

  // Watermark on transmitted-light back scans.
  let watermark: WatermarkResult | null = null;
  if (opts.scanSide === 'back') {
    watermark = matchWatermark(rectGray, frame);
  }

  // Mildew on the front margin.
  const mildewResult =
    opts.scanSide === 'front'
      ? detectMildew(rectRgb, frame, {
          leftMm: design.leftMm,
          rightMm: design.rightMm,
          topMm: design.topMm,
          bottomMm: design.bottomMm,
        })
      : { spots: [], anomalies: [] as AnomalyRecord[] };

  const anomalies: AnomalyRecord[] = [...mildewResult.anomalies];
  for (const edge of EDGE_NAMES) {
    for (const hole of perforation.edges[edge]!.holes) {
      if (hole.kind === 'normal') continue;
      anomalies.push({
        edge,
        kind: hole.kind,
        positionMm: localPositionOf(edge, hole.positionMm, frame),
        detail: hole.note ?? hole.kind,
      });
    }
  }

  const result: GradingResult = {
    sourceFile: opts.sourceFile,
    scanSide: opts.scanSide,
    scanDpi: dpi,
    analyzedAt: new Date().toISOString(),
    dimensions: {
      widthMm: frame.widthMm,
      heightMm: frame.heightMm,
      rotationRad: frame.angle,
      corners: [
        frame.corners.topLeft,
        frame.corners.topRight,
        frame.corners.bottomRight,
        frame.corners.bottomLeft,
      ],
    },
    perforation,
    centering,
    color,
    watermark,
    anomalies,
    groundTruth: opts.groundTruth,
  };
  return { result, frame, rectGray, rectRgb };
}

function localPositionOf(edge: EdgeName, positionMm: number, frame: StampFrame): { x: number; y: number } {
  switch (edge) {
    case 'top':
      return { x: positionMm - frame.widthMm / 2, y: -frame.heightMm / 2 };
    case 'bottom':
      return { x: frame.widthMm / 2 - positionMm, y: frame.heightMm / 2 };
    case 'left':
      return { x: -frame.widthMm / 2, y: frame.heightMm / 2 - positionMm };
    case 'right':
      return { x: frame.widthMm / 2, y: positionMm - frame.heightMm / 2 };
  }
}
