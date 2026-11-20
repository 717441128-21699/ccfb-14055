import { parseArgs } from 'node:util';
import { resolve, join, basename } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { loadPng, saveRgbPng, PngDraw } from '../image/png.js';
import { renderScenarios, buildScenarios } from '../synthetic/scenarios.js';
import { CATALOG_SPECS } from '../catalog/specs.js';
import { analyzeScan } from '../pipeline/analyze.js';
import { ArchiveStore, catalogEntryFromSpec } from '../archive/store.js';
import { renderCertificate } from '../certificate/pdf.js';
import { CatalogEntry, EdgeName, GradingResult } from '../types.js';
import { fixed } from '../util/geometry.js';

function usage(): string {
  return `邮票扫描鉴定工具 stamp-grader

用法:
  stamp-grader generate --out <目录>
      生成合成测试扫描件（含齿孔/水印/撕坏/霉斑及真值 JSON）
  stamp-grader analyze --file <png> [--side front|back] [--dpi <数值>]
      [--catalog <id>] [--archive <目录>] [--overlay <png>]
      分析单张扫描件，打印测量结果并可写入存档
  stamp-grader certificate --archive-record <json> --out <pdf>
      由存档 JSON 生成评审证书 PDF
  stamp-grader demo --out <目录>
      完整演示：生成全部场景 → 分析 → 按套票/年份存档 → 证书 PDF
`;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      file: { type: 'string' },
      side: { type: 'string' },
      dpi: { type: 'string' },
      catalog: { type: 'string' },
      archive: { type: 'string' },
      overlay: { type: 'string' },
      'archive-record': { type: 'string' },
      font: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = args.positionals[0];
  if (args.values.help || !command) {
    process.stdout.write(usage());
    return args.values.help ? 0 : 1;
  }

  switch (command) {
    case 'generate': {
      const out = resolve(args.values.out ?? 'data/generated');
      const files = renderScenarios(out);
      process.stdout.write(`已生成 ${files.length} 个扫描场景 → ${join(out, 'scans')}\n`);
      for (const f of files) process.stdout.write(`  - ${basename(f.pngPath)} (${f.scan.dpi} DPI)\n`);
      return 0;
    }
    case 'analyze': {
      if (!args.values.file) throw new Error('analyze 需要 --file <png>');
      const out = await runAnalyze(args.values);
      process.stdout.write(formatResult(out.result));
      return 0;
    }
    case 'certificate': {
      if (!args.values['archive-record'] || !args.values.out) {
        throw new Error('certificate 需要 --archive-record <json> --out <pdf>');
      }
      const record = JSON.parse(readFileSync(resolve(args.values['archive-record']), 'utf8'));
      await renderCertificate(record, resolve(args.values.out), { fontPath: args.values.font });
      process.stdout.write(`证书已生成 → ${args.values.out}\n`);
      return 0;
    }
    case 'demo': {
      await runDemo(resolve(args.values.out ?? 'data/demo'), args.values.font);
      return 0;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n${usage()}`);
      return 1;
  }
}

export async function runAnalyze(values: Record<string, string | boolean | undefined>): Promise<{
  result: GradingResult;
  catalogEntry?: CatalogEntry;
  archivePath?: string;
}> {
  const str = (k: string): string | undefined => {
    const v = values[k];
    return typeof v === 'string' ? v : undefined;
  };
  const file = resolve(str('file')!);
  const side = (str('side') as 'front' | 'back' | undefined) ?? (file.includes('back') ? 'back' : 'front');
  const { rgb, gray, dpi: embeddedDpi } = loadPng(file);
  const dpiOverride = str('dpi') ? Number(str('dpi')) : undefined;
  const spec = str('catalog') ? CATALOG_SPECS.find((s) => s.id === str('catalog')) : undefined;
  const catalogEntry = spec ? catalogEntryFromSpec(spec) : undefined;
  const truthPath = file.replace(/\.png$/i, '.truth.json');
  const groundTruth = existsSync(truthPath)
    ? JSON.parse(readFileSync(truthPath, 'utf8'))
    : undefined;

  const { result, frame, rectRgb } = analyzeScan(rgb, gray, embeddedDpi, {
    sourceFile: basename(file),
    scanSide: side,
    dpiOverride,
    catalogEntry,
    groundTruth,
  });

  if (str('overlay')) {
    saveOverlay(resolve(str('overlay')!), rectRgb, result, frame.mmPerPixel);
  }

  let archivePath: string | undefined;
  if (str('archive') && catalogEntry) {
    const store = new ArchiveStore(resolve(str('archive')!));
    const record = store.save(catalogEntry, result);
    archivePath = join(str('archive')!, String(catalogEntry.year), catalogEntry.setCode, catalogEntry.id);
    const pdfPath = join(archivePath, `${result.scanSide}-certificate.pdf`);
    await renderCertificate(record, pdfPath, { fontPath: str('font') });
    record.certificatePdfPath = pdfPath;
  }
  return { result, catalogEntry, archivePath };
}

function saveOverlay(
  path: string,
  rectRgb: import('../image/primitives.js').RgbImage,
  result: GradingResult,
  mmPerPixel: number,
): void {
  mkdirSync(resolve(dirNameOf(path)), { recursive: true });
  saveRgbPng(path, rectRgb, {
    dpi: result.scanDpi,
    annotations: (draw) => {
      const ppm = 1 / mmPerPixel;
      const toPx = (xMm: number, yMm: number) => ({
        x: Math.round((xMm + result.dimensions.widthMm / 2) * ppm),
        y: Math.round((yMm + result.dimensions.heightMm / 2) * ppm),
      });
      const colors: Record<string, { r: number; g: number; b: number }> = {
        normal: { r: 40, g: 160, b: 70 },
        torn: { r: 210, g: 50, b: 40 },
        half: { r: 230, g: 150, b: 30 },
        double: { r: 170, g: 60, b: 200 },
        missing: { r: 60, g: 90, b: 220 },
        mildew: { r: 120, g: 90, b: 30 },
      };
      for (const anomaly of result.anomalies) {
        const p = toPx(anomaly.positionMm.x, anomaly.positionMm.y);
        draw.cross(p.x, p.y, 8, colors[anomaly.kind] ?? colors.normal!);
      }
      for (const edge of ['top', 'right', 'bottom', 'left'] as EdgeName[]) {
        for (const hole of result.perforation.edges[edge].holes) {
          if (hole.kind === 'normal') continue;
          const local = edgeToLocal(edge, hole.positionMm, result);
          const p = toPx(local.x, local.y);
          draw.circle(p.x, p.y, 10, colors[hole.kind] ?? colors.normal!, 2);
        }
      }
    },
  });
}

function edgeToLocal(edge: EdgeName, posMm: number, result: GradingResult): { x: number; y: number } {
  const w = result.dimensions.widthMm;
  const h = result.dimensions.heightMm;
  switch (edge) {
    case 'top':
      return { x: posMm - w / 2, y: -h / 2 };
    case 'bottom':
      return { x: w / 2 - posMm, y: h / 2 };
    case 'left':
      return { x: -w / 2, y: h / 2 - posMm };
    case 'right':
      return { x: w / 2, y: posMm - h / 2 };
  }
}

function dirNameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join('/') || '.';
}

export function formatResult(r: GradingResult): string {
  const lines: string[] = [];
  lines.push(`\n=== ${r.sourceFile}（${r.scanSide === 'front' ? '正面' : '背面'}，${r.scanDpi} DPI）===`);
  lines.push(
    `票幅 ${fixed(r.dimensions.widthMm, 2)}×${fixed(r.dimensions.heightMm, 2)} mm，倾角 ${fixed((r.dimensions.rotationRad * 180) / Math.PI, 2)}°`,
  );
  lines.push('齿孔度数:');
  for (const edge of ['top', 'right', 'bottom', 'left'] as EdgeName[]) {
    const e = r.perforation.edges[edge];
    const label = { top: '上', right: '右', bottom: '下', left: '左' }[edge];
    const bad = e.holes
      .filter((h) => h.kind !== 'normal')
      .map((h) => `${h.kind}@${fixed(h.positionMm, 1)}`)
      .join(', ');
    lines.push(
      `  ${label}边: ${fixed(e.gaugeRounded, 2)} 度 (原始 ${fixed(e.rawGauge, 3)}, 有效孔 ${e.normalCount}${bad ? `; 异常: ${bad}` : ''})`,
    );
  }
  lines.push(`  综合: ${fixed(r.perforation.overallGauge, 2)} 度`);
  const c = r.centering;
  lines.push(
    `居中: 上${fixed(c.marginsMm.top, 3)} 右${fixed(c.marginsMm.right, 3)} 下${fixed(c.marginsMm.bottom, 3)} 左${fixed(c.marginsMm.left, 3)} mm；H ${fixed(c.horizontalPercent, 2)}% / V ${fixed(c.verticalPercent, 2)}%；评级 ${c.grade}`,
  );
  if (r.color) {
    lines.push(`刷色: 实测 ${r.color.meanHex} vs 标准 ${r.color.referenceHex}，ΔE00=${fixed(r.color.deltaE00, 2)}（${r.color.verdict}）`);
  }
  if (r.watermark) {
    const top = r.watermark.candidates[0]!;
    lines.push(
      `水印: ${r.watermark.detected ? r.watermark.name : 'none'}（置信度 ${fixed(top.score * 100, 1)}%，中心 ${fixed(r.watermark.centerMm.x, 2)}, ${fixed(r.watermark.centerMm.y, 2)} mm）`,
    );
  }
  if (r.anomalies.length) {
    lines.push(`异常 ${r.anomalies.length} 项: ${r.anomalies.map((a) => `${a.kind}(${a.edge})`).join('、')}`);
  }
  return lines.join('\n') + '\n';
}

async function runDemo(out: string, font?: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  process.stdout.write('① 生成合成扫描件...\n');
  const generated = renderScenarios(out);
  const store = new ArchiveStore(join(out, 'archive'));
  store.saveCatalog(CATALOG_SPECS.map(catalogEntryFromSpec));

  process.stdout.write(`② 分析 ${generated.length} 个场景并归档...\n`);
  const summary: string[] = [];
  for (const f of generated) {
    const { rgb, gray } = loadPng(f.pngPath);
    const entry = catalogEntryFromSpec(f.scenario.spec);
    const { result } = analyzeScan(rgb, gray, f.scan.dpi, {
      sourceFile: basename(f.pngPath),
      scanSide: f.scenario.name.includes('-back-') ? 'back' : 'front',
      catalogEntry: entry,
      groundTruth: f.scan.groundTruth,
    });
    const dir = join(out, 'archive', String(entry.year), entry.setCode, entry.id);
    mkdirSync(dir, { recursive: true });
    const pdfPath = join(dir, `${result.scanSide}-certificate.pdf`);
    const record = store.save(entry, result, pdfPath);
    await renderCertificate(record, pdfPath, { fontPath: font });
    saveRgbPng(join(dir, `${result.scanSide}-rectified.png`), f.scan.image, { dpi: f.scan.dpi });
    summary.push(formatResult(result));
  }
  process.stdout.write(summary.join(''));
  process.stdout.write(`\n③ 完成。存档根目录: ${join(out, 'archive')}\n`);
  process.stdout.write(`   证书与矫正图位于各 套票/年份/票号 子目录，index.json 为总索引。\n`);
  void buildScenarios;
  void PngDraw;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
