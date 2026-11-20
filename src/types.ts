/**
 * Shared domain types for the stamp grading pipeline.
 *
 * Coordinate conventions:
 *  - image coordinates are in pixels, x to the right, y downward.
 *  - stamp-local coordinates are millimetres relative to the stamp's
 *    geometric centre, x right, y down, with axes aligned to the
 *    stamp border (after de-rotation).
 */

export type EdgeName = 'top' | 'right' | 'bottom' | 'left';

export type HoleKind =
  | 'normal'
  | 'torn' // 撕坏: notch mangled by a tear, must not enter the gauge
  | 'half' // 半孔: shallow / off-centre punch from a misaligned perforator
  | 'double' // 双孔: two punches where one was intended
  | 'missing'; // 漏打: expected punch absent, paper uncut at that station

/** One perforation notch observed along one stamp edge. */
export interface PerforationHole {
  edge: EdgeName;
  /** Centre position of the notch along the edge, mm from the edge origin. */
  positionMm: number;
  /** Depth of the notch into the paper, mm (normal holes ~ hole radius). */
  depthMm: number;
  /** Notch opening width along the edge, mm. */
  widthMm: number;
  kind: HoleKind;
  /** When this notch is a double punch, index of its paired notch. */
  pairedIndex?: number;
  /** Free-text reason for any non-normal classification. */
  note?: string;
}

export interface EdgePerforationResult {
  edge: EdgeName;
  holes: PerforationHole[];
  /** Straight edge length between corners, mm. */
  edgeLengthMm: number;
  /** Raw gauge computed from median normal-hole spacing, holes per 20 mm. */
  rawGauge: number;
  /** Gauge rounded to the nearest 0.25 increment. */
  gaugeRounded: number;
  /** Spacing (mm) underlying the gauge value. */
  medianSpacingMm: number;
  /** How many normal holes actually contributed. */
  normalCount: number;
  /** Expected number of perforation stations along this edge. */
  expectedStationCount: number;
}

export interface PerforationResult {
  edges: Record<EdgeName, EdgePerforationResult>;
  /** Overall catalogue gauge: median of the four rounded edge gauges. */
  overallGauge: number;
}

export interface CenteringResult {
  /** Margins between the design frame and the four stamp edges, mm. */
  marginsMm: { top: number; right: number; bottom: number; left: number };
  /**
   * Horizontal centering ratio: left / (left + right) as a percentage.
   * 50 means perfectly centred.
   */
  horizontalPercent: number;
  /** Vertical centering ratio: top / (top + bottom), percentage. */
  verticalPercent: number;
  /** Absolute offset of the design centre from the stamp centre, mm. */
  offsetMm: { x: number; y: number };
  /** Catalogue-style centering grade (F/VF/XF etc.). */
  grade: string;
}

export interface ColorResult {
  /** Mean colour of the stamp design area, sRGB 0-255. */
  meanRgb: { r: number; g: number; b: number };
  meanHex: string;
  /** Mean colour of the reference design. */
  referenceRgb: { r: number; g: number; b: number };
  referenceHex: string;
  /** CIEDE2000 colour difference vs. the reference. */
  deltaE00: number;
  /** Simple lightness difference delta L* (positive = lighter). */
  deltaL: number;
  /** Relative mean-lightness shift, percent (positive = lighter print). */
  lightnessShiftPercent: number;
  verdict: string;
}

export type WatermarkName = 'none' | 'wreath' | 'star' | 'crown' | 'cloud';

export interface WatermarkResult {
  detected: boolean;
  /** Best matching template name; 'none' when correlation is too weak. */
  name: WatermarkName;
  /** Normalised cross-correlation score 0..1 of the best match. */
  score: number;
  /** Position of the match centre in stamp-local mm. */
  centerMm: { x: number; y: number };
  candidates: { name: WatermarkName; score: number }[];
}

export interface StampDimensions {
  widthMm: number;
  heightMm: number;
  /** Rotation of the stamp relative to the scanner axes, radians. */
  rotationRad: number;
  corners: { x: number; y: number }[];
}

export interface AnomalyRecord {
  edge: EdgeName | 'interior';
  kind: HoleKind | 'mildew';
  positionMm: { x: number; y: number };
  detail: string;
}

export interface GradingResult {
  sourceFile: string;
  scanSide: 'front' | 'back';
  scanDpi: number;
  analyzedAt: string;
  dimensions: StampDimensions;
  perforation: PerforationResult;
  centering: CenteringResult;
  color: ColorResult | null;
  watermark: WatermarkResult | null;
  anomalies: AnomalyRecord[];
  /** Ground-truth block, only present for synthetic scans. */
  groundTruth?: unknown;
}

export interface CatalogEntry {
  id: string;
  setCode: string;
  year: number;
  catalogNumber: string;
  denomination: string;
  title: string;
  reference?: {
    colorRgb: { r: number; g: number; b: number };
    watermark: WatermarkName;
  };
}

export interface ArchiveRecord {
  entry: CatalogEntry;
  result: GradingResult;
  archivedAt: string;
  certificatePdfPath?: string;
}
