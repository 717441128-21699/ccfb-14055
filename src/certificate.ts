import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PNG } from 'pngjs';
import type { AnalysisResult, Side } from './types.js';
import { ALL_SIDES } from './types.js';

/** 评审证书 PDF（中文） */

// 优先单文件 TrueType（pdf-lib 子集化稳定）；ttc 集合不支持 subset，需特殊处理
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
];

const SIDE_NAME: Record<Side, string> = { top: '上边', right: '右边', bottom: '下边', left: '左边' };

export async function buildCertificate(
  result: AnalysisResult,
  outPath: string,
  frontImagePath?: string,
): Promise<string> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await loadCjkFont(doc);
  const page = doc.addPage([595.28, 841.89]); // A4
  const W = page.getWidth();
  const margin = 48;
  let y = page.getHeight() - 56;

  const draw = (text: string, size: number, opts: { bold?: boolean; gap?: number; color?: [number, number, number] } = {}): void => {
    page.drawText(text, {
      x: margin,
      y,
      size,
      font,
      color: rgb(...(opts.color ?? [0.12, 0.12, 0.14])),
    });
    y -= opts.gap ?? size + 10;
  };

  // 抬头
  draw('邮票评审鉴定证书', 22, { gap: 30, color: [0.35, 0.12, 0.12] });
  draw(`证书编号：${result.meta.year}-${result.meta.setCode}-${result.meta.catalogNo}`, 10, { gap: 16 });
  draw(`出具时间：${new Date(result.meta.analyzedAt).toLocaleString('zh-CN')}`, 10, { gap: 20 });
  drawHorizontalRule(page, margin, y + 8, W - margin * 2);

  // 票品信息
  draw('一、票品信息', 14, { gap: 18 });
  draw(`　套票：${result.meta.setCode}（${result.meta.year} 年）　目录号：${result.meta.catalogNo}　名称：${result.meta.name}`, 10, { gap: 15 });
  draw(`　票面尺寸：${result.border.widthMm.toFixed(2)} × ${result.border.heightMm.toFixed(2)} mm　扫描倾角：${result.border.angleDeg.toFixed(2)}°　扫描分辨率：${result.meta.dpi} DPI`, 10, { gap: 20 });

  // 齿孔
  draw('二、齿孔度数（孔 / 2 厘米，按 0.25 度取整；异常孔已剔除）', 14, { gap: 18 });
  for (const side of ALL_SIDES) {
    const p = result.perforations[side];
    draw(
      `　${SIDE_NAME[side]}：实测 ${p.measuredGauge.toFixed(2)} 度　标称 ${p.gaugeRounded025.toFixed(2)} 度　孔数 ${p.holeCount}（正常 ${p.regularHoleCount}）　孔距 ${p.pitchMm.toFixed(2)} mm　孔径 ${p.holeDiameterMm.toFixed(2)} mm`,
      10,
      { gap: 14 },
    );
  }
  const anomalyLines = formatAnomalies(result);
  draw(anomalyLines, 10, { gap: anomalyLines.includes('\n') ? 14 * anomalyLines.split('\n').length : 18 });

  // 居中
  draw('三、图案居中（白边宽度，精度 0.05 mm）', 14, { gap: 18 });
  const m = result.centering.marginsMm;
  draw(`　上 ${m.top.toFixed(2)} mm　下 ${m.bottom.toFixed(2)} mm　左 ${m.left.toFixed(2)} mm　右 ${m.right.toFixed(2)} mm`, 10, { gap: 14 });
  draw(`　图案偏移：横向 ${signed(result.centering.offsetXMm)} mm（正为偏右）　纵向 ${signed(result.centering.offsetYMm)} mm（正为偏下）　评级：${result.centering.grade}`, 10, { gap: 20 });

  // 刷色
  draw('四、刷色比对（与标准票 Lab 色差 CIEDE2000）', 14, { gap: 18 });
  if (result.color) {
    const c = result.color;
    draw(`　实测 Lab(${c.meanLab.L.toFixed(1)}, ${c.meanLab.a.toFixed(1)}, ${c.meanLab.b.toFixed(1)})　标准 Lab(${c.referenceLab.L.toFixed(1)}, ${c.referenceLab.a.toFixed(1)}, ${c.referenceLab.b.toFixed(1)})`, 10, { gap: 14 });
    draw(`　ΔE2000 = ${c.deltaE2000.toFixed(2)}（ΔL ${signed(c.deltaL)}，Δa ${signed(c.deltaA)}，Δb ${signed(c.deltaB)}）　判定：${c.grade}　${c.note}`, 10, { gap: 20 });
  } else {
    draw('　未提供标准票参考，跳过刷色比对。', 10, { gap: 20 });
  }

  // 水印与瑕疵
  draw('五、背透光水印与瑕疵', 14, { gap: 18 });
  if (result.watermark) {
    const w = result.watermark;
    draw(w.detected ? `　水印：检出「${w.patternName}」（匹配分 ${w.score.toFixed(3)}，朝向 ${w.orientationDeg}°）` : '　水印：未检出可识别水印', 10, { gap: 14 });
  }
  const mold = result.defects.moldSpots;
  draw(mold.length ? `　霉斑：${mold.length} 处，最大面积 ${Math.max(...mold.map((x) => x.areaMm2)).toFixed(2)} mm²` : '　霉斑：未发现', 10, { gap: 14 });
  draw(`　撕坏齿 ${result.defects.tornTeeth.length} 处　半孔 ${result.defects.halfHoles.length} 处　双孔 ${result.defects.doubleHoles.length} 处　漏打 ${result.defects.missedHoles.length} 处`, 10, { gap: 22 });

  // 缩略图
  if (frontImagePath && existsSync(frontImagePath)) {
    try {
      const embedded = await embedPng(doc, frontImagePath, 180);
      if (embedded) {
        page.drawImage(embedded.img, {
          x: W - margin - embedded.width,
          y: y - embedded.height - 10,
          width: embedded.width,
          height: embedded.height,
        });
        y -= embedded.height + 24;
      }
    } catch {
      // 缩略图失败不影响证书出具
    }
  }

  drawHorizontalRule(page, margin, 64, W - margin * 2);
  page.drawText('本证书由邮票扫描鉴定工具自动生成，齿孔度数异常孔位与撕坏齿均未参与度数计算。', {
    x: margin, y: 48, size: 8, font, color: rgb(0.45, 0.45, 0.48),
  });
  page.drawText('集邮协会评审组', { x: W - margin - 90, y: 48, size: 9, font, color: rgb(0.3, 0.3, 0.32) });

  const bytes = await doc.save();
  writeFileSync(outPath, bytes);
  return outPath;
}

async function loadCjkFont(doc: PDFDocument) {
  for (const f of FONT_CANDIDATES) {
    if (!existsSync(f)) continue;
    try {
      const bytes = readFileSync(f);
      const isTtc = f.toLowerCase().endsWith('.ttc');
      // ttc 字体集合不支持 pdf-lib 子集化，关闭 subset；单文件 ttf/otf 正常子集化
      return await doc.embedFont(bytes, isTtc ? { subset: false, customName: 'CJK' } : { subset: true, customName: 'CJK' });
    } catch {
      // 尝试下一个候选
    }
  }
  console.warn('警告：未找到中文字体（Deng.ttf/simhei.ttf/msyh.ttc 等），证书中文可能无法渲染');
  return doc.embedFont(StandardFonts.Helvetica);
}

async function embedPng(doc: PDFDocument, path: string, maxWidth: number) {
  const png = PNG.sync.read(readFileSync(path));
  const scale = Math.min(1, maxWidth / png.width);
  const img = await doc.embedPng(readFileSync(path));
  return { img, width: png.width * scale, height: png.height * scale };
}

function formatAnomalies(result: AnalysisResult): string {
  const lines: string[] = [];
  for (const side of ALL_SIDES) {
    const list = result.perforations[side].anomalies;
    for (const a of list) {
      const kindName = { half: '半孔', double: '双孔', missed: '漏打', torn: '撕坏' }[a.kind];
      lines.push(`　${SIDE_NAME[side]} ${kindName}：沿边位置 ${signed(a.alongMm)} mm — ${a.detail}`);
    }
  }
  return lines.length ? lines.join('\n') : '　四边孔型规整，未发现半孔、双孔、漏打或撕坏。';
}

function drawHorizontalRule(page: Awaited<ReturnType<PDFDocument['addPage']>>, x: number, y: number, width: number): void {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.8, color: rgb(0.6, 0.5, 0.45) });
}

function signed(v: number): string {
  return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}

export { join as pathJoin };
