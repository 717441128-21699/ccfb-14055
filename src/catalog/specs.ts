import { WatermarkName } from '../types.js';

/** Physical specification of one stamp design in the synthetic catalogue. */
export interface StampSpec {
  id: string;
  setCode: string;
  setName: string;
  year: number;
  catalogNumber: string;
  denomination: string;
  title: string;
  widthMm: number;
  heightMm: number;
  /** Target perforation gauge (holes per 20 mm). */
  perforationGauge: number;
  /** Hole diameter of the punch, mm. */
  holeDiameterMm: number;
  baseColor: { r: number; g: number; b: number };
  accentColor: { r: number; g: number; b: number };
  watermark: WatermarkName;
}

/**
 * Two sets across different years, spanning the common gauges 11..14 and
 * all four watermark motifs plus one unwatermarked stamp.
 */
export const CATALOG_SPECS: StampSpec[] = [
  {
    id: 'T46-1',
    setCode: 'T46',
    setName: '庚申年生肖套票',
    year: 1980,
    catalogNumber: 'T46(1-1)',
    denomination: '8分',
    title: '金猴',
    widthMm: 26,
    heightMm: 31,
    perforationGauge: 11.5,
    holeDiameterMm: 1.05,
    baseColor: { r: 198, g: 62, b: 48 },
    accentColor: { r: 232, g: 178, b: 72 },
    watermark: 'wreath',
  },
  {
    id: 'T28-1',
    setCode: 'T28',
    setName: '奔马套票',
    year: 1978,
    catalogNumber: 'T28(10-1)',
    denomination: '4分',
    title: '奔马·一',
    widthMm: 30,
    heightMm: 25,
    perforationGauge: 12.5,
    holeDiameterMm: 0.98,
    baseColor: { r: 74, g: 96, b: 142 },
    accentColor: { r: 42, g: 48, b: 66 },
    watermark: 'star',
  },
  {
    id: 'T28-2',
    setCode: 'T28',
    setName: '奔马套票',
    year: 1978,
    catalogNumber: 'T28(10-2)',
    denomination: '8分',
    title: '奔马·二',
    widthMm: 30,
    heightMm: 25,
    perforationGauge: 12.5,
    holeDiameterMm: 0.98,
    baseColor: { r: 96, g: 122, b: 168 },
    accentColor: { r: 42, g: 48, b: 66 },
    watermark: 'star',
  },
  {
    id: 'J8-1',
    setCode: 'J8',
    setName: '第四个五年计划套票',
    year: 1975,
    catalogNumber: 'J8(16-1)',
    denomination: '8分',
    title: '农田',
    widthMm: 28,
    heightMm: 28,
    perforationGauge: 13,
    holeDiameterMm: 0.92,
    baseColor: { r: 86, g: 132, b: 84 },
    accentColor: { r: 214, g: 196, b: 122 },
    watermark: 'crown',
  },
  {
    id: 'R14-1',
    setCode: 'R14',
    setName: '普通邮票·革命圣地图',
    year: 1969,
    catalogNumber: '普14(11-1)',
    denomination: '1分',
    title: '韶山',
    widthMm: 27,
    heightMm: 32,
    perforationGauge: 14,
    holeDiameterMm: 0.82,
    baseColor: { r: 156, g: 78, b: 96 },
    accentColor: { r: 92, g: 52, b: 60 },
    watermark: 'cloud',
  },
  {
    id: 'R14-2',
    setCode: 'R14',
    setName: '普通邮票·革命圣地图',
    year: 1969,
    catalogNumber: '普14(11-2)',
    denomination: '2分',
    title: '遵义',
    widthMm: 27,
    heightMm: 32,
    perforationGauge: 11,
    holeDiameterMm: 1.1,
    baseColor: { r: 178, g: 112, b: 64 },
    accentColor: { r: 92, g: 52, b: 60 },
    watermark: 'none',
  },
];
