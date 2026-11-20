#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildFixture } from '../fixture/generator.js';
import { FIXTURE_PRESETS, buildReferenceSpec } from '../fixture/presets.js';
import { loadImage } from '../io.js';
import { analyzeColor } from '../vision/colorAnalysis.js';
import { detectBorder } from '../vision/border.js';
import { analyzeScan, loadGroundTruth } from '../pipeline.js';
import { Catalog, type ReferenceEntry } from '../catalog.js';
import { buildCertificate } from '../certificate.js';
import { WATERMARK_NAMES } from '../fixture/patterns.js';
import type { Lab, StampMeta } from '../types.js';

/** 命令行入口 */

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else if (!command) {
      command = tok;
    }
  }
  return { command, flags };
}

function num(flags: Map<string, string>, key: string, fallback?: number): number {
  const v = flags.get(key);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少必需参数 --${key}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 --${key} 不是数字: ${v}`);
  return n;
}

function str(flags: Map<string, string>, key: string, fallback?: string): string {
  const v = flags.get(key);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少必需参数 --${key}`);
  }
  return v;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  switch (command) {
    case 'generate-fixtures':
      return cmdGenerateFixtures(flags, cwd);
    case 'analyze':
      return cmdAnalyze(flags, cwd);
    case 'certificate':
      return cmdCertificate(flags, cwd);
    case 'add-reference':
      return cmdAddReference(flags, cwd);
    case 'demo':
      return cmdDemo(flags, cwd);
    case 'list':
      return cmdList(flags, cwd);
    default:
      printUsage();
      process.exitCode = 1;
  }
}

function cmdGenerateFixtures(flags: Map<string, string>, cwd: string): void {
  const outDir = resolve(cwd, str(flags, 'out', 'data/fixtures'));
  mkdirSync(outDir, { recursive: true });
  for (const spec of FIXTURE_PRESETS) {
    const r = buildFixture(spec, outDir);
    console.log(`✔ 生成 ${spec.fixtureId}（${spec.dpi} DPI，齿孔 ${Object.values(spec.gauges).join('/')}）`);
    console.log(`   正面 ${r.front}`);
    console.log(`   背面 ${r.back}`);
    buildFixture(buildReferenceSpec(spec), outDir);
    console.log(`   标准参考件 REF-${spec.fixtureId}`);
  }
  console.log(`\n共 ${FIXTURE_PRESETS.length} 套测试件（含 ground truth JSON），输出目录：${outDir}`);
}

async function cmdDemo(flags: Map<string, string>, cwd: string): Promise<void> {
  const dataDir = resolve(cwd, str(flags, 'data-dir', 'data'));
  const fixtureDir = join(dataDir, 'fixtures');
  const catalogDir = join(dataDir, 'catalog');
  mkdirSync(fixtureDir, { recursive: true });
  const catalog = new Catalog(catalogDir);

  for (const spec of FIXTURE_PRESETS) {
    const fx = buildFixture(spec, fixtureDir);
    const refSpec = buildReferenceSpec(spec);
    const refFx = buildFixture(refSpec, fixtureDir);

    // 从标准参考件提取 Lab 基准并登记参考库
    const refImg = loadImage(refFx.front);
    const refBorder = detectBorder(refImg);
    const refColor = analyzeColor(refImg, refBorder, { L: 50, a: 0, b: 0 } satisfies Lab);
    const reference: ReferenceEntry = {
      meta: spec.stamp,
      nominalGauge: {
        top: spec.gauges.top ?? 13,
        right: spec.gauges.right ?? spec.gauges.top ?? 13,
        bottom: spec.gauges.bottom ?? spec.gauges.top ?? 13,
        left: spec.gauges.left ?? spec.gauges.right ?? spec.gauges.top ?? 13,
      },
      standardLab: refColor?.meanLab ?? { L: 50, a: 0, b: 0 },
      watermarkId: spec.watermarkId ?? null,
      watermarkName: spec.watermarkId ? WATERMARK_NAMES[spec.watermarkId] : null,
    };
    catalog.saveReference(reference);

    const result = analyzeScan(fx.front, {
      meta: spec.stamp,
      dpiOverride: spec.dpi,
      reference,
      backFile: fx.back,
      backDpiOverride: spec.dpi,
    });
    const resultFile = catalog.archive(result);
    const certDir = join(dataDir, 'certificates');
    mkdirSync(certDir, { recursive: true });
    const certPath = join(certDir, `${spec.stamp.catalogNo}.cert.pdf`);
    await buildCertificate(result, certPath, fx.front);
    catalog.attachCertificate(spec.stamp.catalogNo, certPath);
    console.log(summary(result, resultFile));
  }
}

function cmdAnalyze(flags: Map<string, string>, cwd: string): void {
  const front = resolve(cwd, str(flags, 'front'));
  const back = flags.has('back') ? resolve(cwd, str(flags, 'back')) : undefined;
  const catalogDir = resolve(cwd, str(flags, 'catalog', 'data/catalog'));
  const catalog = new Catalog(catalogDir);
  const catalogNo = str(flags, 'catalog-no');
  const reference = catalog.findReference(catalogNo);
  if (!reference) {
    console.warn(`警告：参考库中无 ${catalogNo}，刷色比对将跳过。先用 add-reference 登记。`);
  }
  const meta: StampMeta = reference
    ? reference.meta
    : {
        year: num(flags, 'year'),
        setCode: str(flags, 'set'),
        catalogNo,
        name: str(flags, 'name', catalogNo),
        widthMm: num(flags, 'width-mm', 0) || 0,
        heightMm: num(flags, 'height-mm', 0) || 0,
      };
  const result = analyzeScan(front, {
    meta,
    dpiOverride: flags.has('dpi') ? num(flags, 'dpi') : undefined,
    reference,
    backFile: back,
    backDpiOverride: flags.has('dpi') ? num(flags, 'dpi') : undefined,
  });
  const file = catalog.archive(result);
  console.log(summary(result, file));
}

function cmdAddReference(flags: Map<string, string>, cwd: string): void {
  const image = resolve(cwd, str(flags, 'image'));
  const catalogDir = resolve(cwd, str(flags, 'catalog', 'data/catalog'));
  const catalog = new Catalog(catalogDir);
  const img = loadImage(image, flags.has('dpi') ? num(flags, 'dpi') : undefined);
  const border = detectBorder(img);
  // 用中性 Lab 作占位参照提取票面主色
  const probe = analyzeColor(img, border, { L: 50, a: 0, b: 0 });
  const entry: ReferenceEntry = {
    meta: {
      year: num(flags, 'year'),
      setCode: str(flags, 'set'),
      catalogNo: str(flags, 'catalog-no'),
      name: str(flags, 'name'),
      widthMm: round2(border.widthMm),
      heightMm: round2(border.heightMm),
    },
    nominalGauge: {
      top: num(flags, 'gauge-top', 13),
      right: num(flags, 'gauge-right', 13),
      bottom: num(flags, 'gauge-bottom', 13),
      left: num(flags, 'gauge-left', 13),
    },
    standardLab: probe?.meanLab ?? { L: 50, a: 0, b: 0 },
    watermarkId: flags.get('watermark') ?? null,
    watermarkName: flags.get('watermark') ? WATERMARK_NAMES[flags.get('watermark') as keyof typeof WATERMARK_NAMES] ?? null : null,
  };
  catalog.saveReference(entry);
  console.log(`✔ 已登记标准票 ${entry.meta.catalogNo}，Lab(${entry.standardLab.L.toFixed(1)}, ${entry.standardLab.a.toFixed(1)}, ${entry.standardLab.b.toFixed(1)})`);
}

async function cmdCertificate(flags: Map<string, string>, cwd: string): Promise<void> {
  const resultFile = resolve(cwd, str(flags, 'result'));
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  const out = resolve(cwd, str(flags, 'out', join(dirname(resultFile), 'certificate.pdf')));
  const image = flags.has('image') ? resolve(cwd, str(flags, 'image')) : undefined;
  await buildCertificate(result, out, image);
  console.log(`✔ 证书已出具：${out}`);
}

function cmdList(flags: Map<string, string>, cwd: string): void {
  const catalog = new Catalog(resolve(cwd, str(flags, 'catalog', 'data/catalog')));
  if (flags.has('year')) {
    console.table(catalog.listByYear(num(flags, 'year')));
  } else if (flags.has('set')) {
    console.table(catalog.listBySet(str(flags, 'set')));
  } else {
    console.log('归档年份：', catalog.listYears().join(', ') || '（空）');
    console.table(catalog.listAll());
  }
}

function summary(r: ReturnType<typeof analyzeScan>, file: string): string {
  const p = r.perforations;
  const lines = [
    `\n===== ${r.meta.catalogNo} ${r.meta.name}（${r.meta.year}）=====`,
    `票幅 ${r.border.widthMm}×${r.border.heightMm} mm，倾角 ${r.border.angleDeg}°，${r.meta.dpi} DPI`,
    `齿孔(0.25度) 上${p.top.gaugeRounded025} 右${p.right.gaugeRounded025} 下${p.bottom.gaugeRounded025} 左${p.left.gaugeRounded025}` +
      `（实测 上${p.top.measuredGauge} 右${p.right.measuredGauge} 下${p.bottom.measuredGauge} 左${p.left.measuredGauge}）`,
    `居中偏移 x=${r.centering.offsetXMm}mm y=${r.centering.offsetYMm}mm，评级 ${r.centering.grade}；白边 上${r.centering.marginsMm.top} 下${r.centering.marginsMm.bottom} 左${r.centering.marginsMm.left} 右${r.centering.marginsMm.right} mm`,
  ];
  if (r.color) lines.push(`刷色 ΔE2000=${r.color.deltaE2000}（${r.color.grade}）`);
  if (r.watermark) lines.push(r.watermark.detected ? `水印 检出「${r.watermark.patternName}」score=${r.watermark.score}` : '水印 未检出');
  lines.push(`缺陷 撕坏${r.defects.tornTeeth.length} 半孔${r.defects.halfHoles.length} 双孔${r.defects.doubleHoles.length} 漏打${r.defects.missedHoles.length} 霉斑${r.defects.moldSpots.length}`);
  lines.push(`归档 ${file}`);
  return lines.join('\n');
}

function printUsage(): void {
  console.log(`邮票扫描鉴定工具

用法:
  stamp-eval generate-fixtures [--out data/fixtures]
      合成测试扫描件（多齿孔度数/水印/撕坏/霉斑/半孔/双孔/漏孔），附 ground truth
  stamp-eval demo [--data-dir data]
      一键演示：造件 -> 分析 -> 按年份套票存档 -> 出证书 PDF
  stamp-eval add-reference --image 标准票.png --catalog-no T1 --year 1980 --set T46 --name 名称
      [--gauge-top 13 ...] [--watermark wavy] [--dpi 300]
  stamp-eval analyze --front 正面.png [--back 背面.png] --catalog-no T1
      [--dpi 300] [--catalog data/catalog] [--year 1980 --set T46 --name 名称]
  stamp-eval certificate --result 分析结果.json [--image 正面.png] [--out 证书.pdf]
  stamp-eval list [--year 1980 | --set T46] [--catalog data/catalog]
`);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

main().catch((err: unknown) => {
  console.error('错误：', err instanceof Error ? err.message : err);
  process.exit(1);
});

export { loadGroundTruth, writeFileSync };
