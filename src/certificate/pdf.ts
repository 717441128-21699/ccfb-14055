import { PDFDocument, PDFFont, PDFPage, PageSizes, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { ArchiveRecord } from '../types.js';
import { fixed } from '../util/geometry.js';

const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
];

const WATERMARK_LABEL: Record<string, string> = {
  none: '无水印',
  wreath: '花环水印',
  star: '五角星水印',
  crown: '皇冠水印',
  cloud: '祥云水印',
};

export interface CertificateOptions {
  fontPath?: string;
  associationName?: string;
}

/** Render a grading certificate PDF (A4, Chinese embedded font). */
export async function renderCertificate(
  record: ArchiveRecord,
  outPath: string,
  options: CertificateOptions = {},
): Promise<void> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await loadChineseFont(doc, options.fontPath);
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage(PageSizes.A4);
  const { width, height } = page.getSize();
  const margin = 46;
  let y = height - margin;

  const ink = rgb(0.12, 0.13, 0.16);
  const muted = rgb(0.38, 0.4, 0.45);
  const accent = rgb(0.55, 0.12, 0.1);
  const line = rgb(0.78, 0.76, 0.7);

  // Header band.
  page.drawRectangle({
    x: 0,
    y: height - 92,
    width,
    height: 92,
    color: rgb(0.96, 0.95, 0.92),
  });
  page.drawText(options.associationName ?? '集邮协会评审委员会', {
    x: margin,
    y: height - 44,
    size: 18,
    font,
    color: accent,
  });
  page.drawText('邮票扫描鉴定评审证书', {
    x: margin,
    y: height - 70,
    size: 13,
    font,
    color: ink,
  });
  const certNo = `证书编号 ${record.entry.setCode}-${record.entry.id}-${record.archivedAt.slice(0, 10).replace(/-/g, '')}`;
  page.drawText(certNo, { x: width - margin - font.widthOfTextAtSize(certNo, 10), y: height - 44, size: 10, font, color: muted });
  y = height - 112;

  const { entry, result } = record;
  y = sectionTitle(page, font, '一、票品信息', margin, y, ink, accent);
  const infoRows: [string, string][] = [
    ['志号', entry.catalogNumber],
    ['套票', entry.title],
    ['面值', entry.denomination],
    ['发行年份', String(entry.year)],
    ['扫描面', result.scanSide === 'front' ? '正面（反射光）' : '背面（透射光）'],
    ['扫描分辨率', `${result.scanDpi} DPI`],
    ['票幅', `${fixed(result.dimensions.widthMm, 2)} mm × ${fixed(result.dimensions.heightMm, 2)} mm`],
    ['扫描倾角', `${fixed((result.dimensions.rotationRad * 180) / Math.PI, 2)}°`],
    ['源文件', entry.id + '-' + result.scanSide + '.png'],
  ];
  y = drawTable(page, font, latin, infoRows, margin, y, width - 2 * margin, ink, line);

  y -= 10;
  y = sectionTitle(page, font, '二、齿孔度数（每 20 毫米孔数，精度 0.25 度）', margin, y, ink, accent);
  const perfRows: [string, string][] = [];
  const edgeLabel: Record<string, string> = { top: '上边', right: '右边', bottom: '下边', left: '左边' };
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const e = result.perforation.edges[edge];
    const excluded = e.holes.filter((h) => h.kind !== 'normal').length;
    perfRows.push([
      edgeLabel[edge]!,
      `${fixed(e.gaugeRounded, 2)} 度（原始 ${fixed(e.rawGauge, 3)}，有效孔 ${e.normalCount} 枚${excluded ? `，剔除异常 ${excluded} 枚` : ''}）`,
    ]);
  }
  perfRows.push(['综合度数', `${fixed(result.perforation.overallGauge, 2)} 度`]);
  y = drawTable(page, font, latin, perfRows, margin, y, width - 2 * margin, ink, line);

  y -= 10;
  y = sectionTitle(page, font, '三、图案居中（白边宽度，毫米）', margin, y, ink, accent);
  const c = result.centering;
  const centerRows: [string, string][] = [
    ['上 / 下白边', `${fixed(c.marginsMm.top, 3)} / ${fixed(c.marginsMm.bottom, 3)} mm`],
    ['左 / 右白边', `${fixed(c.marginsMm.left, 3)} / ${fixed(c.marginsMm.right, 3)} mm`],
    ['水平居中比', `${fixed(c.horizontalPercent, 2)}%（50% 为正中），偏移 ${fixed(c.offsetMm.x, 3)} mm`],
    ['垂直居中比', `${fixed(c.verticalPercent, 2)}%（50% 为正中），偏移 ${fixed(c.offsetMm.y, 3)} mm`],
    ['居中评级', c.grade],
  ];
  y = drawTable(page, font, latin, centerRows, margin, y, width - 2 * margin, ink, line);

  if (result.color) {
    y -= 10;
    y = sectionTitle(page, font, '四、刷色检验（CIEDE2000 色差）', margin, y, ink, accent);
    const colorRows: [string, string][] = [
      ['实测均色 / 标准色', `${result.color.meanHex} / ${result.color.referenceHex}`],
      ['色差 ΔE00', fixed(result.color.deltaE00, 2)],
      ['明度变化 ΔL*', `${fixed(result.color.deltaL, 2)}（${fixed(result.color.lightnessShiftPercent, 1)}%）`],
      ['结论', result.color.verdict],
    ];
    y = drawTable(page, font, latin, colorRows, margin, y, width - 2 * margin, ink, line);
  }

  if (result.watermark) {
    y -= 10;
    y = sectionTitle(page, font, result.color ? '五、水印识别（背面透光）' : '四、水印识别（背面透光）', margin, y, ink, accent);
    const wm = result.watermark;
    const wmRows: [string, string][] = [
      ['识别结果', wm.detected ? WATERMARK_LABEL[wm.name] ?? wm.name : '未检出可靠水印'],
      ['匹配置信度', fixed(wm.score * 100, 1) + '%'],
      [
        '模板比对',
        wm.candidates.map((cand) => `${WATERMARK_LABEL[cand.name] ?? cand.name} ${fixed(cand.score * 100, 1)}%`).join('；'),
      ],
    ];
    y = drawTable(page, font, latin, wmRows, margin, y, width - 2 * margin, ink, line);
  }

  y -= 10;
  const anomalyTitle = result.color || result.watermark ? '六、异常记录' : '四、异常记录';
  y = sectionTitle(page, font, anomalyTitle, margin, y, ink, accent);
  if (result.anomalies.length === 0) {
    page.drawText('未发现齿孔异常或霉斑。', { x: margin, y, size: 10, font, color: muted });
    y -= 16;
  } else {
    const kindLabel: Record<string, string> = {
      torn: '撕坏齿孔',
      half: '半孔/歪打',
      double: '双孔',
      missing: '漏打',
      mildew: '霉斑',
    };
    for (const a of result.anomalies.slice(0, 14)) {
      const txt = `· [${kindLabel[a.kind] ?? a.kind}] ${a.edge === 'interior' ? '票面' : edgeLabel[a.edge]} @(${fixed(a.positionMm.x, 2)}, ${fixed(a.positionMm.y, 2)})mm — ${a.detail}`;
      page.drawText(ellipsize(font, txt, width - 2 * margin, 9.5), {
        x: margin,
        y,
        size: 9.5,
        font,
        color: ink,
      });
      y -= 14;
      if (y < margin + 90) break;
    }
  }

  // Footer.
  page.drawLine({ start: { x: margin, y: margin + 34 }, end: { x: width - margin, y: margin + 34 }, thickness: 0.8, color: line });
  page.drawText(
    `本证书由扫描鉴定系统自动生成，归档时间 ${new Date(record.archivedAt).toLocaleString('zh-CN')}。齿孔异常均已剔除，不参与度数计算。`,
    { x: margin, y: margin + 20, size: 8.5, font, color: muted },
  );
  page.drawText('鉴定结果以本系统对送检扫描件的测量为限，原件真伪需结合实物复核。', {
    x: margin,
    y: margin + 7,
    size: 8.5,
    font,
    color: muted,
  });
  void bold;

  const bytes = await doc.save();
  writeFileSync(outPath, bytes);
}

async function loadChineseFont(doc: PDFDocument, explicit?: string): Promise<PDFFont> {
  const candidates = explicit ? [explicit, ...FONT_CANDIDATES] : FONT_CANDIDATES;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return await doc.embedFont(readFileSync(path), { subset: true });
    } catch {
      // try next candidate
    }
  }
  throw new Error('未找到可嵌入的中文字体，请通过 --font 指定 TTF/TTC 字体路径');
}

function sectionTitle(page: PDFPage, font: PDFFont, text: string, x: number, y: number, ink: ReturnType<typeof rgb>, accent: ReturnType<typeof rgb>): number {
  page.drawText(text, { x, y, size: 12, font, color: ink });
  page.drawRectangle({ x, y: y - 5, width: 4, height: 12, color: accent });
  return y - 20;
}

function drawTable(
  page: PDFPage,
  font: PDFFont,
  latin: PDFFont,
  rows: [string, string][],
  x: number,
  startY: number,
  tableWidth: number,
  ink: ReturnType<typeof rgb>,
  line: ReturnType<typeof rgb>,
): number {
  const labelW = tableWidth * 0.28;
  const rowH = 19;
  let y = startY;
  for (const [label, value] of rows) {
    page.drawRectangle({
      x,
      y: y - rowH + 5,
      width: labelW,
      height: rowH - 4,
      color: rgb(0.97, 0.97, 0.96),
    });
    page.drawText(label, { x: x + 6, y, size: 9.5, font, color: ink });
    page.drawText(ellipsize(font, value, tableWidth - labelW - 14, 9.5), {
      x: x + labelW + 6,
      y,
      size: 9.5,
      font: pickFont(latin, font, value),
      color: ink,
    });
    page.drawLine({
      start: { x, y: y - rowH + 4 },
      end: { x: x + tableWidth, y: y - rowH + 4 },
      thickness: 0.5,
      color: line,
    });
    y -= rowH;
  }
  page.drawLine({ start: { x, y: y + 1 }, end: { x, y: startY + 5 }, thickness: 0.5, color: line });
  page.drawLine({ start: { x: x + tableWidth, y: y + 1 }, end: { x: x + tableWidth, y: startY + 5 }, thickness: 0.5, color: line });
  return y - 6;
}

function pickFont(latin: PDFFont, cjk: PDFFont, text: string): PDFFont {
  // Route anything outside WinAnsi (CJK ideographs, full-width punctuation,
  // Chinese dashes etc.) to the embedded Chinese font.
  return /[^\x00-\xFF]/.test(text) ? cjk : latin;
}

function ellipsize(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxWidth) t = t.slice(0, -1);
  return t + '…';
}
