import { EdgeName, EdgePerforationResult, PerforationHole, PerforationResult } from '../types.js';
import { RectEdgeRay } from './rectEdge.js';
import { median, roundToStep } from '../util/geometry.js';

interface Notch {
  index: number;
  positionMm: number;
  /** Bite depth inward from the tooth-tip line, mm. */
  depthMm: number;
  widthMm: number;
  /** Irregularity score 0..1 from the profile samples inside the notch. */
  irregularity: number;
}

const EDGE_ORDER: EdgeName[] = ['top', 'right', 'bottom', 'left'];

/**
 * Analyse perforations of one edge from its boundary profile.
 *
 * Gauge convention (Chinese philatelic standard): gauge = number of holes
 * per 20 mm, i.e. 20 / hole-spacing-mm, reported to the nearest 0.25.
 * Torn, half and double punches are excluded from the spacing fit so they
 * cannot bias the result; missing stations are reported but do not break
 * the lattice.
 */
export function analyseEdge(
  edge: EdgeName,
  rays: RectEdgeRay[],
  edgeLengthMm: number,
): EdgePerforationResult {
  const positions = rays.map((r) => r.positionMm);
  const rawDepth = rays.map((r) => r.depthMm);
  // Symmetric Gaussian smoothing along the tangential direction. A symmetric
  // kernel (unlike a causal/leading moving average) does not shift peak phase,
  // so notch centres stay unbiased in both horizontal and vertical edges.
  const depths = gaussianSmooth(rawDepth, 1.1);
  // Physical spacing of consecutive samples (mm), used to scale all windows
  // so detection is resolution independent (300 vs 600 DPI).
  const sampleMm =
    positions.length > 1 ? (positions[positions.length - 1]! - positions[0]!) / (positions.length - 1) : 0.1;

  const notches = findNotches(rays, positions, depths, sampleMm);
  if (notches.length < 3) {
    return {
      edge,
      holes: [],
      edgeLengthMm,
      rawGauge: NaN,
      gaugeRounded: NaN,
      medianSpacingMm: NaN,
      normalCount: 0,
      expectedStationCount: 0,
    };
  }

  const notchDepths = notches.map((n) => n.depthMm);
  const typicalDepth = median(notchDepths);
  const allSpacings = spacings(notches.map((n) => n.positionMm));
  const typicalSpacing = median(allSpacings);

  // First-pass classification (refined after lattice fitting).
  const initialKinds = notches.map((n) =>
    classifyFirstPass(n, typicalDepth, typicalSpacing),
  );

  // Double-punch pairing: adjacent minima much closer than the normal spacing.
  const doubleGroups = findDoubleGroups(notches, typicalSpacing);

  // Lattice fit on holes that can represent a true station centre:
  // normal candidates, or the midpoint of each double group.
  const stationPoints: number[] = [];
  const doubleMembers = new Set<number>();
  for (const group of doubleGroups) {
    for (const idx of group) doubleMembers.add(idx);
    stationPoints.push(mean(group.map((i) => notches[i]!.positionMm)));
  }
  for (let i = 0; i < notches.length; i++) {
    if (doubleMembers.has(i)) continue;
    const kind = initialKinds[i]!;
    if (kind === 'normal') stationPoints.push(notches[i]!.positionMm);
  }
  stationPoints.sort((a, b) => a - b);

  const fit = fitLattice(stationPoints, typicalSpacing);
  const spacingMm = fit.spacingMm;

  // Rebuild the full station lattice over the edge.
  const stations = buildStations(edgeLengthMm, spacingMm, fit.phaseMm);

  // Final classification against the fitted lattice, including missing holes.
  const holes = classifyAgainstLattice({
    edge,
    notches,
    initialKinds,
    doubleGroups,
    typicalDepth,
    spacingMm,
    stations,
    rays,
    depths,
    positions,
  });

  const normalPositions = holes.filter((h) => h.kind === 'normal').map((h) => h.positionMm);
  // Primary estimate is the fitted lattice spacing, which already excludes
  // every defective station and is optimised over a spacing search range.
  // Validate it against single-step normal-hole gaps; use those gaps only if
  // they agree tightly, otherwise keep the lattice value (it is more robust).
  const adjacentGaps = spacings(normalPositions).filter(
    (g) => g < 1.4 * spacingMm && g > 0.7 * spacingMm,
  );
  let robustSpacing = spacingMm;
  if (adjacentGaps.length >= 4) {
    const gapMedian = median(adjacentGaps);
    if (Math.abs(gapMedian - spacingMm) / spacingMm < 0.03) robustSpacing = gapMedian;
  }
  const rawGauge = 20 / robustSpacing;

  return {
    edge,
    holes,
    edgeLengthMm,
    rawGauge,
    gaugeRounded: roundToStep(rawGauge, 0.25),
    medianSpacingMm: robustSpacing,
    normalCount: normalPositions.length,
    expectedStationCount: stations.length,
  };
}

export function summarizePerforation(edges: Record<EdgeName, EdgePerforationResult>): PerforationResult {
  const rounded = EDGE_ORDER.map((e) => edges[e]!.gaugeRounded).filter((v) => !Number.isNaN(v));
  const overallGauge = rounded.length ? roundToStep(median(rounded), 0.25) : NaN;
  return { edges, overallGauge };
}

// ---------------------------------------------------------------------------
// notch detection
// ---------------------------------------------------------------------------

function findNotches(
  rays: RectEdgeRay[],
  positions: number[],
  depths: number[],
  sampleMm: number,
): Notch[] {
  const notches: Notch[] = [];
  // Tooth-tip depth from the lower envelope of the profile (shallowest points).
  const tipDepth = percentile(depths, 15);
  // Window spanning roughly one station (~1.6 mm), resolution independent.
  const stationSamples = Math.max(4, Math.round(1.6 / Math.max(0.02, sampleMm)));
  // Minimum prominence: a real bite is at least ~0.2 mm deeper than the tips.
  const minProminence = 0.18;
  for (let i = 2; i < depths.length - 2; i++) {
    if (rays[i]!.confidence < 0.5) continue;
    const v = depths[i]!;
    // A notch is a local maximum of inward depth.
    if (
      v >= depths[i - 1]! &&
      v >= depths[i + 1]! &&
      v > depths[i - 2]! &&
      v > depths[i + 2]!
    ) {
      // Prominence against the nearest minima (tooth tips) on either side.
      const w = stationSamples;
      const leftMin = minInWindow(depths, i - w, i);
      const rightMin = minInWindow(depths, i, i + w);
      const localTip = Math.max(leftMin, rightMin);
      const depth = v - localTip;
      if (depth < minProminence || v - tipDepth < minProminence) continue;
      const width = measureWidth(depths, positions, i, localTip, v);
      if (width > 4.5) continue; // a tear trough spanning several stations
      const irregularity = measureIrregularity(rays, depths, positions, i, width);
      // Sub-sample peak position by parabolic interpolation over the three
      // samples around the maximum, removing quantisation/smoothing bias that
      // otherwise shrinks the measured station spacing by ~2%.
      const delta = parabolicOffset(depths[i - 1]!, depths[i]!, depths[i + 1]!);
      const stepMm = positions[i + 1]! - positions[i - 1]!;
      notches.push({
        index: i,
        positionMm: positions[i]! + delta * stepMm * 0.5,
        depthMm: depth,
        widthMm: width,
        irregularity,
      });
    }
  }
  // Merge maxima closer than ~0.6 mm (noise double-peak inside one notch).
  const merged: Notch[] = [];
  for (const n of notches) {
    const last = merged[merged.length - 1];
    if (last && n.positionMm - last.positionMm < 0.6) {
      if (n.depthMm > last.depthMm) merged[merged.length - 1] = n;
    } else {
      merged.push(n);
    }
  }
  return merged;
}

function measureWidth(
  depths: number[],
  positions: number[],
  maxIndex: number,
  tipLevel: number,
  floor: number,
): number {
  const half = (tipLevel + floor) / 2;
  let left = maxIndex;
  let right = maxIndex;
  while (left > 0 && depths[left]! > half) left--;
  while (right < depths.length - 1 && depths[right]! > half) right++;
  return Math.max(0.2, positions[right]! - positions[left]!);
}

function measureIrregularity(
  rays: RectEdgeRay[],
  depths: number[],
  positions: number[],
  maxIndex: number,
  widthMm: number,
): number {
  const halfWidthSamples = Math.max(2, Math.round(widthMm / 2 / (positions[1]! - positions[0]!)));
  const lo = Math.max(1, maxIndex - halfWidthSamples);
  const hi = Math.min(depths.length - 2, maxIndex + halfWidthSamples);
  let bumps = 0;
  let checked = 0;
  for (let i = lo; i < hi; i++) {
    if (rays[i]!.confidence < 0.5) continue;
    checked++;
    const d1 = depths[i]! - depths[i - 1]!;
    const d2 = depths[i + 1]! - depths[i]!;
    if (d1 * d2 < 0) bumps++; // local wiggle inside the notch
  }
  return checked ? bumps / checked : 0;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

function classifyFirstPass(n: Notch, typicalDepth: number, typicalSpacing: number): PerforationHole['kind'] {
  if (n.irregularity > 0.45 || n.depthMm > 1.45 * typicalDepth || n.widthMm > 1.7 * typicalSpacing * 0.9) {
    return 'torn';
  }
  if (n.depthMm < 0.78 * typicalDepth) return 'half';
  return 'normal';
}

function findDoubleGroups(notches: Notch[], typicalSpacing: number): number[][] {
  const groups: number[][] = [];
  let i = 0;
  while (i < notches.length - 1) {
    const gap = notches[i + 1]!.positionMm - notches[i]!.positionMm;
    if (gap < 0.72 * typicalSpacing) {
      const group = [i, i + 1];
      // Occasionally a triple mispunch; keep extending while gaps stay tiny.
      while (
        group[group.length - 1]! < notches.length - 1 &&
        notches[group[group.length - 1]! + 1]!.positionMm -
          notches[group[group.length - 1]!]!.positionMm <
          0.72 * typicalSpacing
      ) {
        group.push(group[group.length - 1]! + 1);
      }
      groups.push(group);
      i = group[group.length - 1]! + 1;
    } else {
      i++;
    }
  }
  return groups;
}

interface LatticeFit {
  spacingMm: number;
  phaseMm: number;
  rmsMm: number;
}

/**
 * Fit positions = phase + k * spacing with integer k.
 * Search spacing around the robust median so a few bad stations cannot
 * pull the fit; phase comes from the median residual (breakdown point 50%).
 * Points are expected sorted ascending.
 */
function fitLattice(points: number[], seedSpacing: number): LatticeFit {
  if (points.length < 2) return { spacingMm: seedSpacing, phaseMm: points[0] ?? 0, rmsMm: 0 };
  const anchor = points[0]!;
  let best: LatticeFit = { spacingMm: seedSpacing, phaseMm: 0, rmsMm: Infinity };
  const trials = 41;
  for (let t = 0; t < trials; t++) {
    const spacing = seedSpacing * (0.9 + (0.2 * t) / (trials - 1));
    // Integer station index of each point relative to the anchor station.
    const residuals = points.map((p) => {
      const k = Math.round((p - anchor) / spacing);
      return p - k * spacing;
    });
    const phase = median(residuals);
    const rms = Math.sqrt(mean(residuals.map((r) => (r - phase) ** 2)));
    if (rms < best.rmsMm) best = { spacingMm: spacing, phaseMm: phase, rmsMm: rms };
  }
  const ks = points.map((p) => Math.round((p - best.phaseMm) / best.spacingMm));
  const phaseResiduals = points.map((p, i) => p - ks[i]! * best.spacingMm);
  best.phaseMm = median(phaseResiduals);
  best.rmsMm = Math.sqrt(mean(phaseResiduals.map((r) => (r - best.phaseMm) ** 2)));
  return best;
}

function buildStations(edgeLengthMm: number, spacingMm: number, phaseMm: number): number[] {
  const stations: number[] = [];
  const firstK = Math.ceil((spacingMm * 0.4 - phaseMm) / spacingMm);
  const lastK = Math.floor((edgeLengthMm - spacingMm * 0.4 - phaseMm) / spacingMm);
  for (let k = firstK; k <= lastK; k++) {
    const pos = phaseMm + k * spacingMm;
    if (pos > 0.5 && pos < edgeLengthMm - 0.5) stations.push(pos);
  }
  return stations;
}

function classifyAgainstLattice(args: {
  edge: EdgeName;
  notches: Notch[];
  initialKinds: PerforationHole['kind'][];
  doubleGroups: number[][];
  typicalDepth: number;
  spacingMm: number;
  stations: number[];
  rays: RectEdgeRay[];
  depths: number[];
  positions: number[];
}): PerforationHole[] {
  const {
    edge,
    notches,
    initialKinds,
    doubleGroups,
    typicalDepth,
    spacingMm,
    stations,
    depths,
    positions,
  } = args;

  const holes: PerforationHole[] = [];
  const usedNotches = new Set<number>();

  // Double groups first: emit each member, linked to its siblings.
  for (const group of doubleGroups) {
    const baseIndex = holes.length;
    group.forEach((notchIdx, j) => {
      usedNotches.add(notchIdx);
      const n = notches[notchIdx]!;
      holes.push({
        edge,
        positionMm: n.positionMm,
        depthMm: n.depthMm,
        widthMm: n.widthMm,
        kind: 'double',
        pairedIndex: j === 0 ? baseIndex + 1 : baseIndex,
        note: `双孔：与相邻 ${group.length - 1} 个冲头共用一个孔位`,
      });
    });
  }

  // Remaining notches: match to the nearest lattice station.
  for (let i = 0; i < notches.length; i++) {
    if (usedNotches.has(i)) continue;
    const n = notches[i]!;
    const nearest = nearestStation(n.positionMm, stations);
    const drift = Math.abs(n.positionMm - nearest);
    let kind = initialKinds[i]!;
    // A normal-looking notch sitting far off its station means a skewed punch.
    if (kind === 'normal' && drift > 0.38 * spacingMm) kind = 'half';
    const note =
      kind === 'torn'
        ? '撕坏齿孔：边缘破损，未计入度数'
        : kind === 'half'
          ? `半孔/歪打：孔深仅 ${n.depthMm.toFixed(2)}mm，未计入度数`
          : undefined;
    holes.push({
      edge,
      positionMm: n.positionMm,
      depthMm: n.depthMm,
      widthMm: n.widthMm,
      kind,
      note,
    });
  }

  // Stations with no matched notch: distinguish a truly missing punch (no bite
  // at all) from a shallow half-punch (a small but real bite), so the two
  // defects are never conflated.
  const baselineDepth = percentile(depths, 15); // tooth-tip baseline
  for (const station of stations) {
    const nearestNotch = nearestNotchAt(station, notches, spacingMm);
    if (nearestNotch !== undefined) continue;
    const profileDepth = sampleProfileAt(station, positions, depths);
    const biteDepth = profileDepth - baselineDepth;
    if (biteDepth < 0.18 * typicalDepth) {
      holes.push({
        edge,
        positionMm: station,
        depthMm: Math.max(0, biteDepth),
        widthMm: 0,
        kind: 'missing',
        note: '漏打：该孔位未见冲切痕迹',
      });
    } else if (biteDepth < 0.78 * typicalDepth) {
      holes.push({
        edge,
        positionMm: station,
        depthMm: Math.max(0, biteDepth),
        widthMm: 0,
        kind: 'half',
        note: `半孔/浅打：孔深仅 ${Math.max(0, biteDepth).toFixed(2)}mm，未计入度数`,
      });
    }
  }

  holes.sort((a, b) => a.positionMm - b.positionMm);
  return holes;
}

function nearestStation(pos: number, stations: number[]): number {
  let best = stations[0] ?? pos;
  let bestD = Infinity;
  for (const s of stations) {
    const d = Math.abs(s - pos);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function nearestNotchAt(station: number, notches: Notch[], spacingMm: number): number | undefined {
  let best: number | undefined;
  let bestD = 0.45 * spacingMm;
  for (let i = 0; i < notches.length; i++) {
    const d = Math.abs(notches[i]!.positionMm - station);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function sampleProfileAt(posMm: number, positions: number[], offsets: number[]): number {
  if (posMm <= positions[0]!) return offsets[0]!;
  if (posMm >= positions[positions.length - 1]!) return offsets[offsets.length - 1]!;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i]! >= posMm) {
      const t = (posMm - positions[i - 1]!) / (positions[i]! - positions[i - 1]!);
      return offsets[i - 1]! * (1 - t) + offsets[i]! * t;
    }
  }
  return offsets[offsets.length - 1]!;
}

// ---------------------------------------------------------------------------
// small stats helpers (kept local to stay independent of edge policies)
// ---------------------------------------------------------------------------

function movingAverage(values: number[], window: number): number[] {
  const half = (window - 1) / 2;
  return values.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) {
        s += values[j]!;
        n++;
      }
    }
    return s / n;
  });
}

/** Zero-phase Gaussian smoothing; symmetric so peak locations do not shift. */
function gaussianSmooth(values: number[], sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel: number[] = [];
  let norm = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    norm += w;
  }
  return values.map((_, i) => {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < values.length) s += values[j]! * kernel[k + radius]!;
    }
    return s / norm;
  });
}

function spacings(positions: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < positions.length; i++) out.push(positions[i]! - positions[i - 1]!);
  return out;
}

function minInWindow(values: number[], lo: number, hi: number): number {
  let m = Infinity;
  for (let i = Math.max(0, lo); i <= Math.min(values.length - 1, hi); i++) {
    if (values[i]! < m) m = values[i]!;
  }
  return m;
}

/**
 * Fractional offset (in sample units, range -0.5..0.5) of the true peak
 * relative to the centre sample, from a parabola fit through three values.
 */
function parabolicOffset(left: number, centre: number, right: number): number {
  const denom = left - 2 * centre + right;
  if (Math.abs(denom) < 1e-9) return 0;
  const delta = 0.5 * (left - right) / denom;
  return Math.max(-0.5, Math.min(0.5, delta));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function mean(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

// Re-exported for tests that want to check fit stability directly.
export const _internal = { fitLattice };
