import type { FixtureSpec } from './generator.js';
import type { Lab } from '../types.js';

/** 演示测试件预设：覆盖常见齿孔度数、水印类型与全部缺陷种类 */

const BASE_RED: Lab = { L: 48, a: 42, b: 32 };
const BASE_BLUE: Lab = { L: 40, a: 18, b: -48 };
const BASE_GREEN: Lab = { L: 52, a: -34, b: 28 };

export const FIXTURE_PRESETS: FixtureSpec[] = [
  {
    fixtureId: 'T1980-1A',
    dpi: 300,
    stamp: { year: 1980, setCode: 'T46', catalogNo: 'T1980-1A', name: '庚申年（红）演示票', widthMm: 26, heightMm: 31 },
    gauges: { top: 11.5, right: 13, bottom: 11.5, left: 13 },
    rotationDeg: 2.4,
    designShiftXMm: 0.35,
    designShiftYMm: -0.2,
    designMarginMm: 2.5,
    baseColor: BASE_RED,
    colorShift: { dL: 0, da: 0, db: 0 },
    watermarkId: 'wavy',
    moldSpotCount: 1,
    anomalies: {
      half: [{ side: 'top', alongMm: 8 }],
      double: [{ side: 'right', alongMm: 12 }],
      missed: [{ side: 'bottom', alongMm: 18 }],
      torn: [{ side: 'left', alongMm: 22 }],
    },
  },
  {
    fixtureId: 'T1981-2B',
    dpi: 600, // 不同扫描仪分辨率，验证自动换算
    stamp: { year: 1981, setCode: 'T58', catalogNo: 'T1981-2B', name: '生肖系列（蓝）演示票', widthMm: 30, heightMm: 25 },
    gauges: { top: 12.5, right: 12.5, bottom: 12.5, left: 12.5 },
    rotationDeg: -1.6,
    designShiftXMm: -0.4,
    designShiftYMm: 0.25,
    baseColor: BASE_BLUE,
    colorShift: { dL: -2.4, da: 0.8, db: -1.6 }, // 偏深偏蓝
    watermarkId: 'star',
    moldSpotCount: 2,
    anomalies: {
      torn: [
        { side: 'top', alongMm: 6 },
        { side: 'top', alongMm: 23 },
      ],
      half: [{ side: 'left', alongMm: 10 }],
    },
  },
  {
    fixtureId: 'T1982-3C',
    dpi: 400,
    stamp: { year: 1982, setCode: 'T70', catalogNo: 'T1982-3C', name: '风光系列（绿）演示票', widthMm: 40, heightMm: 30 },
    gauges: { top: 14, right: 13.5, bottom: 14, left: 13.5 },
    rotationDeg: 0.8,
    designMarginMm: 3.0,
    baseColor: BASE_GREEN,
    colorShift: { dL: 1.2, da: -0.6, db: 2.2 },
    watermarkId: 'crown',
    moldSpotCount: 0,
    anomalies: {
      double: [{ side: 'bottom', alongMm: 14 }],
      missed: [{ side: 'right', alongMm: 8 }],
    },
  },
  {
    fixtureId: 'T1983-4D',
    dpi: 300,
    stamp: { year: 1983, setCode: 'T81', catalogNo: 'T1983-4D', name: '文物系列（红）演示票', widthMm: 25, heightMm: 40 },
    gauges: { top: 10.5, right: 11, bottom: 10.5, left: 11 },
    rotationDeg: 3.2,
    designShiftXMm: 0.15,
    designShiftYMm: 0.1,
    baseColor: BASE_RED,
    colorShift: { dL: 0, da: 0, db: 0 },
    watermarkId: 'character',
    moldSpotCount: 3,
    anomalies: {
      torn: [{ side: 'right', alongMm: 30 }],
      half: [{ side: 'bottom', alongMm: 7 }],
      double: [{ side: 'left', alongMm: 16 }],
      missed: [{ side: 'top', alongMm: 12 }],
    },
  },
];

/** 标准票参考件（无缺陷、无偏移、无刷色偏移），用于建立参考库 */
export function buildReferenceSpec(source: FixtureSpec): FixtureSpec {
  return {
    ...source,
    fixtureId: `REF-${source.fixtureId}`,
    rotationDeg: 0,
    designShiftXMm: 0,
    designShiftYMm: 0,
    colorShift: { dL: 0, da: 0, db: 0 },
    watermarkId: source.watermarkId,
    moldSpotCount: 0,
    anomalies: {},
  };
}
