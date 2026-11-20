/** 共享类型定义 */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const ALL_SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

export interface Pt {
  x: number;
  y: number;
}

/** 统一的 8bit RGBA 图像 */
export interface ImageBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** 像素/英寸，来自 PNG pHYs / JFIF，或 CLI 覆盖值 */
  dpi: number | null;
}

export type Lab = { L: number; a: number; b: number };
export type RGB = { r: number; g: number; b: number };

export type AnomalyKind = 'half' | 'double' | 'missed' | 'torn';

export interface PerforationAnomaly {
  kind: AnomalyKind;
  side: Side;
  /** 沿边方向的位置，毫米，相对票中心 */
  alongMm: number;
  /** 法向偏移，毫米（向内为正），漏打无此项 */
  normalOffsetMm?: number;
  detail: string;
}

export interface SidePerforation {
  side: Side;
  /** 实测齿孔度数（孔/2cm，保留两位） */
  measuredGauge: number;
  /** 按 0.25 度取整后的标称度数 */
  gaugeRounded025: number;
  /** 检测到的孔总数 */
  holeCount: number;
  /** 参与度数计算的正常孔数 */
  regularHoleCount: number;
  pitchMm: number;
  holeDiameterMm: number;
  /** 正常孔覆盖的边长（毫米） */
  spanMm: number;
  anomalies: PerforationAnomaly[];
}

export interface BorderResult {
  centerPx: Pt;
  angleDeg: number;
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  cornersPx: Pt[];
}

export interface CenteringResult {
  /** 四边白边宽度（毫米） */
  marginsMm: Record<Side, number>;
  /** 图案中心相对票面中心的偏移（毫米），正 = 向右/向下偏 */
  offsetXMm: number;
  offsetYMm: number;
  grade: '优等' | '良好' | '一般' | '偏斜';
}

export interface ColorResult {
  meanLab: Lab;
  referenceLab: Lab;
  deltaE2000: number;
  deltaL: number;
  deltaA: number;
  deltaB: number;
  grade: '极微' | '轻微' | '可辨' | '明显' | '显著';
  note: string;
}

export interface MoldSpot {
  xMm: number;
  yMm: number;
  areaMm2: number;
}

export interface WatermarkResult {
  detected: boolean;
  patternId: string | null;
  patternName: string | null;
  score: number;
  orientationDeg: number;
  candidates: { patternId: string; score: number }[];
}

export interface StampMeta {
  year: number;
  setCode: string;
  catalogNo: string;
  name: string;
  widthMm: number;
  heightMm: number;
}

export interface AnalysisResult {
  schemaVersion: 1;
  meta: StampMeta & {
    frontFile: string;
    backFile?: string;
    dpi: number;
    analyzedAt: string;
  };
  border: {
    angleDeg: number;
    widthMm: number;
    heightMm: number;
  };
  perforations: Record<Side, SidePerforation>;
  centering: CenteringResult;
  color: ColorResult | null;
  watermark: WatermarkResult | null;
  defects: {
    tornTeeth: PerforationAnomaly[];
    halfHoles: PerforationAnomaly[];
    doubleHoles: PerforationAnomaly[];
    missedHoles: PerforationAnomaly[];
    moldSpots: MoldSpot[];
  };
}

export interface FixtureGroundTruth {
  fixtureId: string;
  dpi: number;
  stamp: StampMeta;
  gauge: Record<Side, number>;
  designShiftXMm: number;
  designShiftYMm: number;
  designMarginMm: number;
  rotationDeg: number;
  watermarkId: string | null;
  anomalies: {
    half: { side: Side; alongMm: number }[];
    double: { side: Side; alongMm: number }[];
    missed: { side: Side; alongMm: number }[];
    torn: { side: Side; alongMm: number }[];
  };
  moldSpotCount: number;
  colorShift: { dL: number; da: number; db: number };
}
