import type { BorderResult, ImageBuffer, PerforationAnomaly, Pt, Side, SidePerforation } from '../types.js';
import { ALL_SIDES } from '../types.js';
import { clamp, roundToQuarter, sampleBilinear } from '../geometry.js';
import { gaussianBlur, grayscale, smooth1d } from './filters.js';

/** 齿孔检测：正视图中沿四边追踪「底板→票纸」跃变边界，孔位处边界内凹 */

const MM_PER_INCH = 25.4;

interface Valley {
  index: number;
  alongMm: number;
  depthMm: number;
  kind: PerforationAnomaly['kind'] | 'normal';
  /** 双孔分裂配对的瓣间距（毫米），用于与撕坏区分 */
  lobeGapMm?: number;
}

export function analyzePerforations(img: ImageBuffer, border: BorderResult): Record<Side, SidePerforation> {
  const dpi = img.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  // 直接在原图上按边框角点几何采样，避免旋转校正引入的朝向歧义
  const gray = gaussianBlur(grayscale(img.data, img.width, img.height), img.width, img.height, 0.8);

  const result = {} as Record<Side, SidePerforation>;
  for (const side of ALL_SIDES) {
    result[side] = analyzeSide(side, gray, img.width, img.height, border, pxPerMm);
  }
  return result;
}

function analyzeSide(
  side: Side,
  gray: Float32Array,
  W: number,
  H: number,
  border: BorderResult,
  pxPerMm: number,
): SidePerforation {
  const [tl, tr, br, bl] = border.cornersPx;
  // 用真实角点定义每条边：start->end 沿“从左到右 / 从上到下”，normal 指向票外
  // 边方向 e=(ex,ey)（图像 y 向下）；外法向公式经四件测试件实测标定
  const edgeGeom: Record<Side, { start: Pt; end: Pt; normal: Pt }> = {
    top: { start: tl!, end: tr!, normal: unit({ x: -(tr!.y - tl!.y), y: tr!.x - tl!.x }) },
    right: { start: tr!, end: br!, normal: unit({ x: -(br!.y - tr!.y), y: br!.x - tr!.x }) },
    bottom: { start: bl!, end: br!, normal: unit({ x: br!.y - bl!.y, y: -(br!.x - bl!.x) }) },
    left: { start: tl!, end: bl!, normal: unit({ x: bl!.y - tl!.y, y: -(bl!.x - tl!.x) }) },
  };
  const geom = edgeGeom[side];
  const lengthPx = Math.hypot(geom.end.x - geom.start.x, geom.end.y - geom.start.y);
  const lengthMm = lengthPx / pxPerMm;

  // 端部 8% 角落区域不参与（角齿不完整）
  const trim = 0.08;
  const sampleStepMm = 0.06;
  const samples = Math.floor(lengthMm / sampleStepMm);
  const reachPx = 2.4 * pxPerMm;

  // 1) 边界位置曲线 edgePx：自票外向票内扫描，记录暗->亮跃变点（相对名义边的内凹距离，像素）
  const edgePx: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const start = { x: geom.start.x + (geom.end.x - geom.start.x) * t, y: geom.start.y + (geom.end.y - geom.start.y) * t };
    edgePx.push(traceEdge(gray, W, H, start, geom.normal, reachPx));
  }
  const smoothed = smooth1d(edgePx, Math.max(3, Math.round(0.4 / sampleStepMm)));

  // 2) 牙尖基线（浅内凹）与孔深
  const tipBaseline = percentile(smoothed, 20);
  const depthSignal = smoothed.map((v) => clamp(v - tipBaseline, 0, reachPx));
  const depthStrengths = depthSignal.filter((v) => v > 0.15 * pxPerMm).sort((a, b) => a - b);
  const medianDepthPx = depthStrengths.length ? depthStrengths[Math.floor(depthStrengths.length / 2)]! : 0.5 * pxPerMm;
  const minPeakPx = Math.max(0.18 * pxPerMm, medianDepthPx * 0.45);
  // 最小峰距按较密齿孔（16 度）的 60% 取值，避免把正常相邻孔误并；双孔由分裂逻辑另行处理
  const minDistSamples = Math.max(3, Math.round(((20 / 16) * 0.6) / sampleStepMm));

  const valleys = findPeaks(depthSignal, minPeakPx, minDistSamples, lengthMm, samples, trim, pxPerMm);

  // 宽峰分裂：双孔的两个孔心间有浅谷，把过宽的单峰拆成两个并直接标记为双孔
  const preAnomalies: PerforationAnomaly[] = [];
  splitBroadPeaks(depthSignal, valleys, minPeakPx, minDistSamples, lengthMm, samples, pxPerMm, side, preAnomalies);

  // 3) 撕坏 vs 半孔/双孔：撕坏是宽而深的粗糙缺损。先撤回误分裂为双孔的撕坏配对，再标记半孔
  const medianDepthMm = medianDepthPx / pxPerMm;
  const peakWidths = valleys.map((v) => peakWidth(depthSignal, v.index, minPeakPx));
  const normalPeakWidth = median(peakWidths);
  for (let vi = 0; vi < valleys.length; vi++) {
    const v = valleys[vi]!;
    const widthMm = (peakWidths[vi] ?? 0) * sampleStepMm;
    const isBroad = (peakWidths[vi] ?? 0) > normalPeakWidth * 1.35;
    if (isBroad && v.kind === 'double') {
      // 深度不足的双孔配对实为撕坏缺损（无清晰孔心）
      if (v.depthMm < medianDepthMm * 0.85 && widthMm > 1.3) {
        v.kind = 'torn';
        const partner = valleys.find((q) => q.kind === 'double' && Math.abs(q.alongMm - v.alongMm) < 1.2);
        if (partner) partner.kind = 'torn';
        preAnomalies.splice(0, preAnomalies.length, ...preAnomalies.filter((a) => a.kind !== 'double' || Math.abs(a.alongMm - (v.alongMm - lengthMm / 2)) > 1.2));
      }
      continue;
    }
    if (v.depthMm > medianDepthMm * 1.55 && widthMm > 1.3) {
      v.kind = 'torn';
    }
  }

  // 4) 漏打识别（双孔已在分裂阶段标记）
  const anomalies: PerforationAnomaly[] = [...preAnomalies];
  classifyMissed(valleys, anomalies, side, lengthMm);

  // 5) 半孔（打孔打歪、孔心内移）：孔深显著偏大但孔型窄（未被撕坏/双孔占用）
  for (const v of valleys) {
    if (v.kind !== 'normal') continue;
    if (v.depthMm > medianDepthMm * 1.5 || v.depthMm < medianDepthMm * 0.5) {
      v.kind = 'half';
    }
  }

  // 5.5) 撕坏缺损常被分裂成 double+torn 相邻两瓣，把紧邻 torn 的 double 并入 torn
  const tornValleys = valleys.filter((v) => v.kind === 'torn');
  for (const v of valleys) {
    if (v.kind === 'double' && tornValleys.some((t) => Math.abs(t.alongMm - v.alongMm) < 1.6)) {
      v.kind = 'torn';
    }
  }

  // 6) 正常孔 -> 齿孔度数
  const regular = valleys.filter((v) => v.kind === 'normal');
  const pitchMm = estimatePitch(regular);
  const measuredGauge = pitchMm > 0 ? 20 / pitchMm : 0;
  let spanMm = 0;
  if (regular.length >= 2) spanMm = regular[regular.length - 1]!.alongMm - regular[0]!.alongMm;

  // 异常列表以最终 valley 分类为准重建，保留漏打（漏打无对应 valley）
  const missedOnly = anomalies.filter((a) => a.kind === 'missed');
  anomalies.length = 0;
  for (const a of missedOnly) pushAnomaly(anomalies, a);
  for (const v of valleys) {
    if (v.kind !== 'normal') {
      // 同一双孔的两个瓣峰紧邻，合并为一条双孔记录
      if (v.kind === 'double') {
        const partner = valleys.find((q) => q.kind === 'double' && q !== v && Math.abs(q.alongMm - v.alongMm) < 1.6);
        if (partner && partner.alongMm < v.alongMm) continue; // 只保留靠前的一瓣输出
      }
      pushAnomaly(anomalies, {
        kind: v.kind,
        side,
        alongMm: roundMm(v.alongMm - lengthMm / 2),
        detail: anomalyDetail(v.kind),
      });
    }
  }

  return {
    side,
    measuredGauge: round2(measuredGauge),
    gaugeRounded025: roundToQuarter(measuredGauge),
    holeCount: valleys.length,
    regularHoleCount: regular.length,
    pitchMm: round2(pitchMm),
    holeDiameterMm: round2(clamp(medianDepthMm * 2, 0.5, 1.8)),
    spanMm: roundMm(spanMm),
    anomalies,
  };
}

/**
 * 从边点沿法向双向扫描，自动识别底板（暗）->票纸（亮）跃变，返回孔位相对牙尖基线的内凹深度。
 * 不依赖外法向的符号约定：分别在正、负法向找暗亮跃变，取“外侧为暗、内侧为亮”的一侧。
 */
function traceEdge(
  gray: Float32Array,
  W: number,
  H: number,
  edgeStart: Pt,
  outwardNormal: Pt,
  reachPx: number,
): number {
  const steps = Math.ceil(reachPx);
  // 采样 -reach..+reach 的对称剖面（相对名义边点）
  const values: number[] = [];
  const offsets: number[] = [];
  for (let k = -steps; k <= steps; k++) {
    const x = edgeStart.x + outwardNormal.x * k;
    const y = edgeStart.y + outwardNormal.y * k;
    values.push(sampleBilinear(gray, W, H, x, y, 0, 30));
    offsets.push(k);
  }
  const dark = percentile(values, 15);
  const light = percentile(values, 85);
  const threshold = dark + (light - dark) * 0.5;
  // 找暗->亮跃变：跃变前暗（底板）、跃变后亮（票纸）。记录跃变点的有符号偏移
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1]! < threshold && values[i]! >= threshold) {
      const denom = values[i]! - values[i - 1]!;
      const t = denom > 1e-6 ? (threshold - values[i - 1]!) / denom : 0;
      const signedOffset = offsets[i - 1]! + clamp01(t) * (offsets[i]! - offsets[i - 1]!);
      // 孔位处边境内凹，跃变点向票内移动；返回相对名义边的内凹距离（恒正）
      return clamp(Math.abs(signedOffset), 0, reachPx);
    }
  }
  return reachPx * 0.5;
}

function unit(v: Pt): Pt {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function findPeaks(
  signal: number[],
  minPeak: number,
  minDist: number,
  lengthMm: number,
  samples: number,
  trim: number,
  pxPerMm: number,
): Valley[] {
  const candidates: { index: number; strength: number }[] = [];
  const lo = Math.floor(samples * trim);
  const hi = Math.ceil(samples * (1 - trim));
  for (let i = Math.max(2, lo); i < Math.min(signal.length - 2, hi); i++) {
    if (signal[i]! >= signal[i - 1]! && signal[i]! > signal[i + 1]! && signal[i]! > minPeak) {
      candidates.push({ index: i, strength: signal[i]! });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);
  const kept: { index: number; strength: number }[] = [];
  for (const c of candidates) {
    if (kept.every((k) => Math.abs(k.index - c.index) > minDist)) kept.push(c);
  }
  kept.sort((a, b) => a.index - b.index);
  return kept.map((k) => ({
    index: k.index,
    alongMm: (k.index / samples) * lengthMm,
    depthMm: k.strength / pxPerMm,
    kind: 'normal' as const,
  }));
}

/** 峰宽（采样点数），用于撕坏判定 */
function peakWidth(signal: number[], idx: number, minPeak: number): number {
  let l = idx;
  let r = idx;
  while (l > 0 && signal[l]! > minPeak * 0.5) l--;
  while (r < signal.length - 1 && signal[r]! > minPeak * 0.5) r++;
  return r - l;
}

/** 双孔分裂：过宽且内部含浅谷的峰拆为两个独立孔（双孔孔距近、谷较浅） */
function splitBroadPeaks(
  signal: number[],
  valleys: Valley[],
  minPeak: number,
  minDist: number,
  lengthMm: number,
  samples: number,
  pxPerMm: number,
  side: Side,
  preAnomalies: PerforationAnomaly[],
): void {
  const widths = valleys.map((v) => peakWidth(signal, v.index, minPeak));
  const normalWidth = median(widths);
  const additions: Valley[] = [];
  const claimedRanges: [number, number][] = [];
  for (let vi = 0; vi < valleys.length; vi++) {
    const v = valleys[vi]!;
    const w = widths[vi]!;
    if (w < normalWidth * 1.35) continue;
    let l = v.index, r = v.index;
    while (l > 0 && signal[l]! > minPeak * 0.5) l--;
    while (r < signal.length - 1 && signal[r]! > minPeak * 0.5) r++;
    // 同一支撑区只分裂一次，避免双孔被重复拆分
    if (claimedRanges.some(([a, b]) => !(r < a || l > b))) continue;
    // 找支撑区内最强局部极小值（双孔两孔很近时谷较浅，不设深度比例门槛）
    let dipIdx = -1;
    let dipVal = Infinity;
    const scanLo = Math.round(l + minDist * 0.3);
    const scanHi = Math.round(r - minDist * 0.3);
    for (let i = scanLo; i < scanHi; i++) {
      if (signal[i]! < signal[i - 1]! && signal[i]! <= signal[i + 1]! && signal[i]! < dipVal) {
        dipVal = signal[i]!;
        dipIdx = i;
      }
    }
    if (dipIdx < 0) continue;
    let leftPeak = l, rightPeak = r;
    let leftMax = -1, rightMax = -1;
    for (let i = l; i < dipIdx; i++) if (signal[i]! > leftMax) { leftMax = signal[i]!; leftPeak = i; }
    for (let i = dipIdx; i < r; i++) if (signal[i]! > rightMax) { rightMax = signal[i]!; rightPeak = i; }
    // 两个瓣峰都需超过检出阈值；右瓣允许略弱（融合双孔的第二孔常偏浅）
    if (leftMax < minPeak || rightMax < minPeak * 0.8) continue;
    // 真双孔：两瓣都达到正常孔深（清晰圆孔）且瓣距 <1.45mm；撕坏不切孔、峰浅且瓣距 ≥1.5mm
    const lobeGapMm = (rightPeak - leftPeak) / samples * lengthMm;
    const depthFloor = minPeak * 1.6;
    if (leftMax < depthFloor || rightMax < depthFloor) continue;
    if (lobeGapMm > 1.45) continue;
    claimedRanges.push([l, r]);
    v.index = leftPeak;
    v.alongMm = (leftPeak / samples) * lengthMm;
    v.depthMm = leftMax / pxPerMm;
    v.kind = 'double';
    const rightValley: Valley = {
      index: rightPeak,
      alongMm: (rightPeak / samples) * lengthMm,
      depthMm: rightMax / pxPerMm,
      kind: 'double',
      lobeGapMm,
    };
    v.lobeGapMm = lobeGapMm;
    additions.push(rightValley);
    preAnomalies.push({
      kind: 'double',
      side,
      alongMm: roundMm((v.alongMm + rightValley.alongMm) / 2 - lengthMm / 2),
      detail: anomalyDetail('double'),
    });
  }
  valleys.push(...additions);
  valleys.sort((a, b) => a.index - b.index);
}

/** 漏打：相邻正常孔间距显著大于众数孔距；双孔/撕坏邻接的空隙不算漏打 */
function classifyMissed(valleys: Valley[], anomalies: PerforationAnomaly[], side: Side, lengthMm: number): void {
  if (valleys.length < 3) return;
  const spacings: number[] = [];
  for (let i = 1; i < valleys.length; i++) spacings.push(valleys[i]!.alongMm - valleys[i - 1]!.alongMm);
  const med0 = median(spacings);
  const typical = median(spacings.filter((d) => d > med0 * 0.75 && d < med0 * 1.35));
  const med = typical > 0 ? typical : med0;
  for (let i = 1; i < valleys.length; i++) {
    const d = valleys[i]!.alongMm - valleys[i - 1]!.alongMm;
    const adjacentDefect = valleys[i - 1]!.kind !== 'normal' || valleys[i]!.kind !== 'normal';
    if (d > med * 1.55 && !adjacentDefect) {
      pushAnomaly(anomalies, {
        kind: 'missed',
        side,
        alongMm: roundMm((valleys[i - 1]!.alongMm + valleys[i]!.alongMm) / 2 - lengthMm / 2),
        detail: anomalyDetail('missed'),
      });
    }
  }
}

function estimatePitch(regular: Valley[]): number {
  if (regular.length < 2) return 0;
  if (regular.length === 2) return regular[1]!.alongMm - regular[0]!.alongMm;
  const spacings: number[] = [];
  for (let i = 1; i < regular.length; i++) spacings.push(regular[i]!.alongMm - regular[i - 1]!.alongMm);
  const medPitch = median(spacings);
  // 漏打（约 2 倍孔距）与双孔（约半倍孔距）的离群间隔剔除，窗口收紧到 ±30%
  const clean = spacings.filter((d) => d > medPitch * 0.7 && d < medPitch * 1.3);
  if (clean.length >= 3) {
    // 用聚类众数：正常孔距集中在很窄区间，取密度最高的一簇中心，抗相位偏移
    const sorted = [...clean].sort((a, b) => a - b);
    const cluster: number[] = [sorted[Math.floor(sorted.length / 2)]!];
    for (const v of sorted) {
      if (cluster.some((c) => Math.abs(c - v) < medPitch * 0.12)) cluster.push(v);
    }
    return cluster.reduce((a, b) => a + b, 0) / cluster.length;
  }
  return medPitch;
}

function pushAnomaly(anomalies: PerforationAnomaly[], a: PerforationAnomaly): void {
  if (!anomalies.some((x) => x.kind === a.kind && x.side === a.side && Math.abs(x.alongMm - a.alongMm) < 0.8)) {
    anomalies.push(a);
  }
}

function anomalyDetail(kind: PerforationAnomaly['kind']): string {
  switch (kind) {
    case 'half': return '打孔机打歪形成半孔，已排除出度数计算';
    case 'double': return '打孔机重打形成双孔，已排除出度数计算';
    case 'missed': return '漏打孔位，已排除出度数计算';
    case 'torn': return '齿尖撕坏缺损，该位置不参与度数计算';
  }
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[clamp(Math.floor((p / 100) * s.length), 0, s.length - 1)]!;
}
function round2(v: number): number { return Math.round(v * 100) / 100; }
function roundMm(v: number): number { return Math.round(v * 100) / 100; }
function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
