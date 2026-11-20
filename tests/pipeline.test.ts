import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture, type FixtureSpec } from '../src/fixture/generator.js';
import { FIXTURE_PRESETS } from '../src/fixture/presets.js';
import { analyzeScan, loadGroundTruth } from '../src/pipeline.js';
import { detectBorder } from '../src/vision/border.js';
import { loadImage } from '../src/io.js';
import type { Side } from '../src/types.js';
import type { WatermarkId } from '../src/fixture/patterns.js';

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

function runOn(spec: FixtureSpec, dir: string) {
  const fx = buildFixture(spec, dir);
  const gt = loadGroundTruth(fx.groundTruth);
  const result = analyzeScan(fx.front, {
    meta: spec.stamp,
    dpiOverride: spec.dpi,
    backFile: fx.back,
    backDpiOverride: spec.dpi,
    reference: {
      meta: spec.stamp,
      nominalGauge: gt.gauge,
      standardLab: { L: 50, a: 0, b: 0 },
      watermarkId: spec.watermarkId ?? null,
      watermarkName: null,
    },
  });
  return { gt, result };
}

test('齿孔度数四边均落在 ground truth ±0.25 度内（含 300/400/600 DPI 换算）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-gauge-'));
  try {
    for (const spec of FIXTURE_PRESETS) {
      const { gt, result } = runOn(spec, dir);
      for (const side of SIDES) {
        const measured = result.perforations[side].gaugeRounded025;
        assert.ok(
          Math.abs(measured - gt.gauge[side]) <= 0.25,
          `${spec.fixtureId} ${side}: 测得 ${measured}，标称 ${gt.gauge[side]}，偏差超 0.25`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('居中偏移误差 ≤ 0.1mm，白边测量稳定（亚像素）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-center-'));
  try {
    for (const spec of FIXTURE_PRESETS) {
      const { gt, result } = runOn(spec, dir);
      assert.ok(
        Math.abs(result.centering.offsetXMm - gt.designShiftXMm) <= 0.1,
        `${spec.fixtureId} x 偏移: ${result.centering.offsetXMm} vs ${gt.designShiftXMm}`,
      );
      assert.ok(
        Math.abs(result.centering.offsetYMm - gt.designShiftYMm) <= 0.1,
        `${spec.fixtureId} y 偏移: ${result.centering.offsetYMm} vs ${gt.designShiftYMm}`,
      );
      for (const side of SIDES) {
        assert.ok(result.centering.marginsMm[side] > 0.5, `${spec.fixtureId} ${side} 白边异常`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一票件在 300 与 600 DPI 下毫米级测量一致（分辨率自动换算）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-dpi-'));
  try {
    const base = FIXTURE_PRESETS[0]!;
    const spec300: FixtureSpec = { ...base, fixtureId: 'DPI300' };
    const spec600: FixtureSpec = { ...base, fixtureId: 'DPI600', dpi: 600 };
    const r300 = runOn(spec300, dir).result;
    const r600 = runOn(spec600, dir).result;
    assert.ok(Math.abs(r300.border.widthMm - r600.border.widthMm) < 0.15);
    assert.ok(Math.abs(r300.border.heightMm - r600.border.heightMm) < 0.15);
    for (const side of SIDES) {
      assert.ok(Math.abs(r300.perforations[side].pitchMm - r600.perforations[side].pitchMm) < 0.12);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('半孔/双孔/漏打/撕坏均被识别且不参与度数计算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-anom-'));
  try {
    const spec = FIXTURE_PRESETS[0]!;
    const { result } = runOn(spec, dir);
    const d = result.defects;
    assert.ok(d.halfHoles.length >= 1, '应检出半孔');
    assert.ok(d.doubleHoles.length >= 1, '应检出双孔');
    assert.ok(d.missedHoles.length >= 1, '应检出漏打');
    assert.ok(d.tornTeeth.length >= 1, '应检出撕坏');
    // 异常孔不计入正常孔
    for (const side of SIDES) {
      const p = result.perforations[side];
      assert.ok(p.regularHoleCount <= p.holeCount);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('四种水印图案全部正确识别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-wm-'));
  try {
    for (const spec of FIXTURE_PRESETS) {
      if (!spec.watermarkId) continue;
      const { result } = runOn(spec, dir);
      assert.ok(result.watermark?.detected, `${spec.fixtureId} 水印应检出`);
      assert.equal(result.watermark!.patternId, spec.watermarkId as WatermarkId);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('刷色偏移方向与 ground truth 一致（ΔL/Δa/Δb 符号）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-color-'));
  try {
    const spec = FIXTURE_PRESETS[1]!; // 偏深偏蓝
    const { gt, result } = runOn(spec, dir);
    assert.ok(result.color);
    assert.equal(Math.sign(result.color!.deltaL), Math.sign(gt.colorShift.dL));
    assert.equal(Math.sign(result.color!.deltaB), Math.sign(gt.colorShift.db));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边框定位的票幅误差 ≤ 0.2mm，倾角误差 ≤ 0.3°', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-border-'));
  try {
    for (const spec of FIXTURE_PRESETS) {
      const fx = buildFixture(spec, dir);
      const img = loadImage(fx.front, spec.dpi);
      const b = detectBorder(img);
      assert.ok(Math.abs(b.widthMm - spec.stamp.widthMm) < 0.2, `${spec.fixtureId} 宽`);
      assert.ok(Math.abs(b.heightMm - spec.stamp.heightMm) < 0.2, `${spec.fixtureId} 高`);
      assert.ok(Math.abs(b.angleDeg - (spec.rotationDeg ?? 0)) < 0.3, `${spec.fixtureId} 倾角`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ground truth JSON 与测试件一并写出且可解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-gt-'));
  try {
    const fx = buildFixture(FIXTURE_PRESETS[0]!, dir);
    const gt = JSON.parse(readFileSync(fx.groundTruth, 'utf8'));
    assert.equal(gt.fixtureId, FIXTURE_PRESETS[0]!.fixtureId);
    assert.ok(gt.anomalies);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
