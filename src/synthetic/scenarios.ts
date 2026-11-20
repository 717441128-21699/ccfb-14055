import { CATALOG_SPECS, StampSpec } from '../catalog/specs.js';
import { generateScan, GeneratedScan } from '../synthetic/generator.js';
import { DefectPlan } from '../synthetic/generator.js';
import { saveRgbPng } from '../image/png.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { EdgeName } from '../types.js';

export interface Scenario {
  name: string;
  spec: StampSpec;
  dpi: number;
  rotationDeg: number;
  designOffsetMm: { x: number; y: number };
  printColorScale: number;
  defects: DefectPlan;
  seed: number;
}

/**
 * A fixed, reproducible scenario matrix covering:
 *  - gauges 11 / 11.5 / 12.5 / 13 / 14
 *  - all four watermark motifs plus an unwatermarked back
 *  - torn, half, double and missing punches on different edges
 *  - mildew foxing, design offsets, light/dark print shades
 *  - two scanner resolutions (300 / 600 DPI)
 */
export function buildScenarios(): Scenario[] {
  const specs = Object.fromEntries(CATALOG_SPECS.map((s) => [s.id, s])) as Record<string, StampSpec>;
  return [
    {
      name: 'T46-1-front-300dpi',
      spec: specs['T46-1']!,
      dpi: 300,
      rotationDeg: 2.4,
      designOffsetMm: { x: 0.32, y: -0.24 },
      printColorScale: 0.92, // slightly darker print
      defects: {
        torn: { top: [4] },
        half: { right: [6] },
        double: { bottom: [3] },
        missing: { left: [7] },
        mildewCount: 2,
      },
      seed: 101,
    },
    {
      name: 'T46-1-back-300dpi',
      spec: specs['T46-1']!,
      dpi: 300,
      rotationDeg: 2.4,
      designOffsetMm: { x: 0, y: 0 },
      printColorScale: 1,
      defects: {},
      seed: 102,
    },
    {
      name: 'T28-1-front-600dpi',
      spec: specs['T28-1']!,
      dpi: 600,
      rotationDeg: -3.1,
      designOffsetMm: { x: -0.18, y: 0.4 },
      printColorScale: 1.08, // lighter print
      defects: {
        half: { top: [2, 9] },
        torn: { left: [5] },
        mildewCount: 1,
      },
      seed: 201,
    },
    {
      name: 'T28-2-front-300dpi',
      spec: specs['T28-2']!,
      dpi: 300,
      rotationDeg: 1.2,
      designOffsetMm: { x: 0.05, y: 0.05 },
      printColorScale: 1,
      defects: { double: { right: [4], bottom: [8] }, missing: { top: [5] } },
      seed: 202,
    },
    {
      name: 'T28-2-back-600dpi',
      spec: specs['T28-2']!,
      dpi: 600,
      rotationDeg: 1.2,
      designOffsetMm: { x: 0, y: 0 },
      printColorScale: 1,
      defects: {},
      seed: 203,
    },
    {
      name: 'J8-1-front-300dpi',
      spec: specs['J8-1']!,
      dpi: 300,
      rotationDeg: 0.6,
      designOffsetMm: { x: 0.45, y: 0.15 },
      printColorScale: 0.97,
      defects: { torn: { bottom: [6] }, missing: { right: [3] }, mildewCount: 3 },
      seed: 301,
    },
    {
      name: 'J8-1-back-300dpi',
      spec: specs['J8-1']!,
      dpi: 300,
      rotationDeg: 0.6,
      designOffsetMm: { x: 0, y: 0 },
      printColorScale: 1,
      defects: {},
      seed: 302,
    },
    {
      name: 'R14-1-front-300dpi',
      spec: specs['R14-1']!,
      dpi: 300,
      rotationDeg: -1.8,
      designOffsetMm: { x: -0.3, y: -0.35 },
      printColorScale: 1.05,
      defects: { half: { left: [4, 10] }, double: { top: [7] } },
      seed: 401,
    },
    {
      name: 'R14-1-back-300dpi',
      spec: specs['R14-1']!,
      dpi: 300,
      rotationDeg: -1.8,
      designOffsetMm: { x: 0, y: 0 },
      printColorScale: 1,
      defects: {},
      seed: 402,
    },
    {
      name: 'R14-2-front-600dpi',
      spec: specs['R14-2']!,
      dpi: 600,
      rotationDeg: 4.0,
      designOffsetMm: { x: 0.12, y: -0.22 },
      printColorScale: 0.9,
      defects: {
        torn: { right: [3] },
        half: { bottom: [5] },
        missing: { left: [8] },
        double: { top: [2] },
        mildewCount: 2,
      },
      seed: 501,
    },
    {
      name: 'R14-2-back-600dpi',
      spec: specs['R14-2']!,
      dpi: 600,
      rotationDeg: 4.0,
      designOffsetMm: { x: 0, y: 0 },
      printColorScale: 1,
      defects: {},
      seed: 502,
    },
  ];
}

export interface GeneratedFile {
  scenario: Scenario;
  pngPath: string;
  truthPath: string;
  scan: GeneratedScan;
}

/** Render every scenario into <outDir>/scans/<name>.png plus ground-truth JSON. */
export function renderScenarios(outDir: string): GeneratedFile[] {
  const scansDir = join(outDir, 'scans');
  mkdirSync(scansDir, { recursive: true });
  const files: GeneratedFile[] = [];
  for (const scenario of buildScenarios()) {
    const scan = generateScan(scenario.spec, {
      side: scenario.name.includes('-back-') ? 'back' : 'front',
      dpi: scenario.dpi,
      rotationDeg: scenario.rotationDeg,
      designOffsetMm: scenario.designOffsetMm,
      printColorScale: scenario.printColorScale,
      defects: scenario.defects,
      seed: scenario.seed,
    });
    const pngPath = join(scansDir, `${scenario.name}.png`);
    saveRgbPng(pngPath, scan.image, { dpi: scan.dpi });
    const truthPath = join(scansDir, `${scenario.name}.truth.json`);
    writeFileSync(truthPath, JSON.stringify(scan.groundTruth, null, 2), 'utf8');
    files.push({ scenario, pngPath, truthPath, scan });
  }
  return files;
}

export function edgeDefectSummary(defects: DefectPlan): { edge: EdgeName; kinds: string[] }[] {
  const out: { edge: EdgeName; kinds: string[] }[] = [];
  for (const edge of ['top', 'right', 'bottom', 'left'] as EdgeName[]) {
    const kinds: string[] = [];
    if (defects.torn?.[edge]?.length) kinds.push(`撕坏×${defects.torn[edge]!.length}`);
    if (defects.half?.[edge]?.length) kinds.push(`半孔×${defects.half[edge]!.length}`);
    if (defects.double?.[edge]?.length) kinds.push(`双孔×${defects.double[edge]!.length}`);
    if (defects.missing?.[edge]?.length) kinds.push(`漏打×${defects.missing[edge]!.length}`);
    if (kinds.length) out.push({ edge, kinds });
  }
  return out;
}
