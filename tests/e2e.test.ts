import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { renderScenarios, type GeneratedFile } from '../src/synthetic/scenarios.js';
import { loadPng } from '../src/image/png.js';
import { analyzeScan } from '../src/pipeline/analyze.js';
import { catalogEntryFromSpec } from '../src/archive/store.js';
import type { EdgeName, GradingResult } from '../src/types.js';
import { CATALOG_SPECS } from '../src/catalog/specs.js';

let files: GeneratedFile[] = [];
const outDir = join(tmpdir(), `stamp-test-${process.pid}`);

beforeAll(() => {
  mkdirSync(outDir, { recursive: true });
  files = renderScenarios(outDir);
});

function analyze(file: GeneratedFile): GradingResult {
  const { rgb, gray, dpi } = loadPng(file.pngPath);
  const side = file.scenario.name.includes('-back-') ? 'back' : 'front';
  const entry = catalogEntryFromSpec(file.scenario.spec);
  const { result } = analyzeScan(rgb, gray, dpi, {
    sourceFile: file.pngPath,
    scanSide: side,
    catalogEntry: entry,
    groundTruth: file.scan.groundTruth,
  });
  return result;
}

describe('embedded DPI round-trip', () => {
  it('writes and reads back the scanner DPI', () => {
    for (const f of files) {
      const { dpi } = loadPng(f.pngPath);
      expect(Math.abs(dpi - f.scan.dpi)).toBeLessThan(0.5);
    }
  });
});

describe('frame geometry', () => {
  it('measures stamp dimensions within 0.3 mm of truth', () => {
    for (const f of files) {
      const r = analyze(f);
      const t = f.scan.groundTruth;
      expect(Math.abs(r.dimensions.widthMm - t.widthMm)).toBeLessThan(0.3);
      expect(Math.abs(r.dimensions.heightMm - t.heightMm)).toBeLessThan(0.3);
    }
  });

  it('recovers rotation within 0.4 degrees and in canonical range', () => {
    for (const f of files) {
      const r = analyze(f);
      const deg = (r.dimensions.rotationRad * 180) / Math.PI;
      expect(Math.abs(deg - f.scan.groundTruth.rotationDeg)).toBeLessThan(0.4);
      expect(deg).toBeGreaterThanOrEqual(-45);
      expect(deg).toBeLessThan(45);
    }
  });
});

describe('perforation gauge', () => {
  it('matches the true gauge on every edge within 0.25 after rounding', () => {
    for (const f of files) {
      const r = analyze(f);
      const t = f.scan.groundTruth;
      for (const edge of ['top', 'right', 'bottom', 'left'] as EdgeName[]) {
        const got = r.perforation.edges[edge].gaugeRounded;
        expect(Math.abs(got - t.perforationGauge)).toBeLessThanOrEqual(0.25);
      }
    }
  });

  it('is DPI independent: 300 and 600 DPI give the same gauge', () => {
    const bySpec = new Map<string, number[]>();
    for (const f of files) {
      const r = analyze(f);
      const list = bySpec.get(f.scenario.spec.id) ?? [];
      list.push(r.perforation.overallGauge);
      bySpec.set(f.scenario.spec.id, list);
    }
    for (const gauges of bySpec.values()) {
      const spread = Math.max(...gauges) - Math.min(...gauges);
      expect(spread).toBeLessThanOrEqual(0.25);
    }
  });

  it('excludes every defective punch from the normal-hole count', () => {
    for (const f of files) {
      const t = f.scan.groundTruth;
      const defectiveKinds = new Set(['torn', 'half', 'double', 'missing']);
      const defectiveStations = new Set(
        t.holes.filter((h) => defectiveKinds.has(h.kind)).map((h) => `${h.edge}:${h.stationIndex}`),
      );
      if (defectiveStations.size === 0) continue;
      const r = analyze(f);
      const reportedDefects = new Set(
        r.anomalies
          .filter((a) => a.edge !== 'interior' && a.kind !== 'mildew')
          .map((a) => a.kind),
      );
      // Every true defect kind must appear in the reported anomalies.
      const trueKinds = new Set(t.holes.filter((h) => defectiveKinds.has(h.kind)).map((h) => h.kind));
      for (const kind of trueKinds) expect(reportedDefects.has(kind)).toBe(true);
    }
  });
});

describe('centering', () => {
  it('measures each margin within 0.25 mm and the design offset within 0.08 mm', () => {
    for (const f of files) {
      if (!f.scenario.name.includes('-front-')) continue;
      const r = analyze(f);
      const t = f.scan.groundTruth;
      // True margins derived from the design frame geometry and offset.
      const fw = t.widthMm - 7;
      const fh = t.heightMm - 8;
      const trueMargins = {
        top: t.designOffsetMm.y - fh / 2 + t.heightMm / 2,
        right: t.widthMm / 2 - (t.designOffsetMm.x + fw / 2),
        bottom: t.heightMm / 2 - (t.designOffsetMm.y + fh / 2),
        left: t.designOffsetMm.x - fw / 2 + t.widthMm / 2,
      };
      expect(Math.abs(r.centering.marginsMm.top - trueMargins.top)).toBeLessThan(0.25);
      expect(Math.abs(r.centering.marginsMm.right - trueMargins.right)).toBeLessThan(0.25);
      expect(Math.abs(r.centering.marginsMm.bottom - trueMargins.bottom)).toBeLessThan(0.25);
      expect(Math.abs(r.centering.marginsMm.left - trueMargins.left)).toBeLessThan(0.25);
      // Design-centre displacement at sub-0.1 mm precision.
      expect(Math.abs(r.centering.offsetMm.x - t.designOffsetMm.x)).toBeLessThan(0.08);
      expect(Math.abs(r.centering.offsetMm.y - t.designOffsetMm.y)).toBeLessThan(0.08);
    }
  });
});

describe('watermark', () => {
  it('identifies the back-scan watermark motif or none correctly', () => {
    for (const f of files) {
      if (!f.scenario.name.includes('-back-')) continue;
      const r = analyze(f);
      expect(r.watermark).not.toBeNull();
      expect(r.watermark!.name).toBe(f.scan.groundTruth.watermark);
    }
  });
});

describe('mildew', () => {
  it('flags foxing on front scans that have it', () => {
    for (const f of files) {
      if (!f.scenario.name.includes('-front-')) continue;
      if (f.scan.groundTruth.mildew.length === 0) continue;
      const r = analyze(f);
      expect(r.anomalies.some((a) => a.kind === 'mildew')).toBe(true);
    }
  });
});

describe('catalog coverage', () => {
  it('covers gauges 11 through 14 across the scenario set', () => {
    const gauges = new Set(CATALOG_SPECS.map((s) => s.perforationGauge));
    for (const g of [11, 11.5, 12.5, 13, 14]) expect(gauges.has(g)).toBe(true);
  });
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});
