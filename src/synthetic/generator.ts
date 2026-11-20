import { RgbImage } from '../image/primitives.js';
import { EdgeName, HoleKind, WatermarkName } from '../types.js';
import { StampSpec } from '../catalog/specs.js';
import { gaussian, makeRng } from '../util/geometry.js';
import { WATERMARK_TEMPLATES } from '../pipeline/watermark.js';

export interface DefectPlan {
  /** Edge -> list of station indices (0-based along the edge) with defects. */
  torn?: Partial<Record<EdgeName, number[]>>;
  half?: Partial<Record<EdgeName, number[]>>;
  double?: Partial<Record<EdgeName, number[]>>;
  missing?: Partial<Record<EdgeName, number[]>>;
  /** Number of mildew spots on the front (margin area). */
  mildewCount?: number;
}

export interface GeneratedScan {
  image: RgbImage;
  dpi: number;
  groundTruth: ScanGroundTruth;
}

export interface HoleTruth {
  edge: EdgeName;
  stationIndex: number;
  positionMm: number;
  kind: HoleKind;
}

export interface ScanGroundTruth {
  specId: string;
  scanSide: 'front' | 'back';
  dpi: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  offsetPx: { x: number; y: number };
  perforationGauge: number;
  holeSpacingMm: number;
  holeDiameterMm: number;
  designOffsetMm: { x: number; y: number };
  printColorScale: number;
  watermark: WatermarkName;
  holes: HoleTruth[];
  mildew: { xMm: number; yMm: number; radiusMm: number }[];
}

interface StationLayout {
  positions: number[];
  spacingMm: number;
}

const EDGES: EdgeName[] = ['top', 'right', 'bottom', 'left'];

export interface GenerateOptions {
  side: 'front' | 'back';
  dpi: number;
  rotationDeg: number;
  /** Design print offset from stamp centre, mm (positive x = shifted right). */
  designOffsetMm: { x: number; y: number };
  /** Multiplier applied to the print colour (1 = reference). */
  printColorScale: number;
  defects: DefectPlan;
  seed: number;
  /** Background padding around the stamp, mm. */
  paddingMm?: number;
}

/**
 * Render a fully synthetic scanner image from physical specifications.
 * Every measurement is defined in millimetres and rasterised at the
 * requested DPI, so the analysis pipeline can be validated against exact
 * ground truth at multiple scanner resolutions.
 */
export function generateScan(spec: StampSpec, opts: GenerateOptions): GeneratedScan {
  const rng = makeRng(opts.seed);
  const paddingMm = opts.paddingMm ?? 8;
  const ppm = opts.dpi / 25.4; // pixels per millimetre
  const rot = (opts.rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const boundingW = spec.widthMm * cos + spec.heightMm * sin + paddingMm * 2;
  const boundingH = spec.widthMm * sin + spec.heightMm * cos + paddingMm * 2;
  const W = Math.round(boundingW * ppm);
  const H = Math.round(boundingH * ppm);
  const img = new RgbImage(W, H);
  const center = { x: W / 2, y: H / 2 };
  const toImage = (xMm: number, yMm: number) => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return {
      x: center.x + (xMm * c - yMm * s) * ppm,
      y: center.y + (xMm * s + yMm * c) * ppm,
    };
  };

  const spacingMm = 20 / spec.perforationGauge;
  const layouts = buildLayouts(spec, spacingMm);
  const defects = normalizeDefects(opts.defects);
  const holeTruth: HoleTruth[] = [];

  // --- paper mask: stamp rectangle with semicircular perforation bites ---
  const paperMask = new Uint8Array(W * H);
  const r = spec.holeDiameterMm / 2;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const local = invertPoint(px, py, center, rot, ppm);
      if (
        local.x >= -spec.widthMm / 2 &&
        local.x <= spec.widthMm / 2 &&
        local.y >= -spec.heightMm / 2 &&
        local.y <= spec.heightMm / 2
      ) {
        paperMask[py * W + px] = 1;
      }
    }
  }

  for (const edge of EDGES) {
    const layout = layouts[edge]!;
    layout.positions.forEach((pos, stationIndex) => {
      const defectKind = defectAt(defects, edge, stationIndex);
      if (defectKind === 'missing') {
        holeTruth.push({ edge, stationIndex, positionMm: pos, kind: 'missing' });
        return; // uncut paper
      }
      let depthScale = 1;
      let widthScale = 1;
      let positionShift = 0;
      if (defectKind === 'half') {
        // Shallow/skewed punch: a smaller pin still straddling the edge, so a
        // clearly visible but shallow bite remains (~55% of normal depth).
        depthScale = 0.58;
        widthScale = 0.72;
        positionShift = spacingMm * 0.14;
      }
      if (defectKind === 'torn') {
        // Oversized, irregular bite; tearRoughPatch() adds the ragged margin.
        depthScale = 1.35;
        widthScale = 1.3;
      }
      if (defectKind === 'double') {
        // Two smaller punches straddling the station.
        punchBite(paperMask, W, H, center, rot, ppm, spec, edge, pos - spacingMm * 0.3, r * 0.68, r * 0.68);
        punchBite(paperMask, W, H, center, rot, ppm, spec, edge, pos + spacingMm * 0.3, r * 0.68, r * 0.68);
        holeTruth.push({ edge, stationIndex, positionMm: pos, kind: 'double' });
        return;
      }
      punchBite(
        paperMask,
        W,
        H,
        center,
        rot,
        ppm,
        spec,
        edge,
        pos + positionShift,
        r * widthScale,
        r * depthScale,
      );
      holeTruth.push({
        edge,
        stationIndex,
        positionMm: pos + positionShift,
        kind: defectKind ?? 'normal',
      });
    });
  }

  // Torn edges: rough irregular boundary beyond the punched bite.
  for (const edge of EDGES) {
    const tornStations = defects.torn[edge] ?? [];
    for (const station of tornStations) {
      const pos = layouts[edge]!.positions[station];
      if (pos === undefined) continue;
      tearRoughPatch(paperMask, W, H, center, rot, ppm, spec, edge, pos, r, rng);
    }
  }

  // --- base scan: dark scanner bed, lighter paper ---
  const bed = opts.side === 'back' ? 38 : 30;
  for (let i = 0; i < W * H; i++) {
    const n = gaussian(rng, 0, 2.2);
    img.r[i] = clamp8(bed + n);
    img.g[i] = clamp8(bed + n);
    img.b[i] = clamp8(bed + n + 1);
  }

  const paperTone = opts.side === 'back' ? 206 : 226;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (!paperMask[py * W + px]) continue;
      const local = invertPoint(px, py, center, rot, ppm);
      const fibre = gaussian(rng, 0, 3.0) + Math.sin(local.x * 9.2 + local.y * 3.7) * 1.4;
      const shade = paperTone + fibre;
      img.r[py * W + px] = clamp8(shade + 3);
      img.g[py * W + px] = clamp8(shade + 1);
      img.b[py * W + px] = clamp8(shade - 4);
    }
  }

  // --- content ---
  const mildew: ScanGroundTruth['mildew'] = [];
  if (opts.side === 'front') {
    paintDesign(img, paperMask, W, H, center, rot, ppm, spec, opts, rng);
    for (let i = 0; i < (opts.defects.mildewCount ?? 0); i++) {
      const spot = paintMildew(img, paperMask, W, H, center, rot, ppm, spec, rng);
      if (spot) mildew.push(spot);
    }
  } else {
    paintWatermark(img, paperMask, W, H, center, rot, ppm, spec, rng);
  }

  // Mild global lens/vignetting falloff and a faint scanner streak.
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      const nx = px / W - 0.5;
      const ny = py / H - 0.5;
      const vig = -10 * (nx * nx + ny * ny);
      const streak = Math.sin(py / H * Math.PI) * 1.5;
      img.r[i] = clamp8(img.r[i]! + vig + streak);
      img.g[i] = clamp8(img.g[i]! + vig + streak);
      img.b[i] = clamp8(img.b[i]! + vig + streak);
    }
  }

  const groundTruth: ScanGroundTruth = {
    specId: spec.id,
    scanSide: opts.side,
    dpi: opts.dpi,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    rotationDeg: opts.rotationDeg,
    offsetPx: { x: 0, y: 0 },
    perforationGauge: spec.perforationGauge,
    holeSpacingMm: spacingMm,
    holeDiameterMm: spec.holeDiameterMm,
    designOffsetMm: opts.designOffsetMm,
    printColorScale: opts.printColorScale,
    watermark: spec.watermark,
    holes: holeTruth,
    mildew,
  };
  return { image: img, dpi: opts.dpi, groundTruth };
}

// ---------------------------------------------------------------------------
// layout / defects
// ---------------------------------------------------------------------------

function buildLayouts(spec: StampSpec, spacingMm: number): Record<EdgeName, StationLayout> {
  const make = (lengthMm: number): StationLayout => {
    const count = Math.round(lengthMm / spacingMm) - 1;
    const usedLength = count * spacingMm;
    const start = (lengthMm - usedLength) / 2;
    const positions: number[] = [];
    for (let k = 0; k <= count; k++) positions.push(start + k * spacingMm);
    return { positions, spacingMm };
  };
  return {
    top: make(spec.widthMm),
    bottom: make(spec.widthMm),
    left: make(spec.heightMm),
    right: make(spec.heightMm),
  };
}

function normalizeDefects(d: DefectPlan): Required<DefectPlan> {
  const empty = (): Partial<Record<EdgeName, number[]>> => ({});
  return {
    torn: d.torn ?? empty(),
    half: d.half ?? empty(),
    double: d.double ?? empty(),
    missing: d.missing ?? empty(),
    mildewCount: d.mildewCount ?? 0,
  };
}

function defectAt(d: Required<DefectPlan>, edge: EdgeName, station: number): HoleKind | undefined {
  if ((d.torn[edge] ?? []).includes(station)) return 'torn';
  if ((d.half[edge] ?? []).includes(station)) return 'half';
  if ((d.double[edge] ?? []).includes(station)) return 'double';
  if ((d.missing[edge] ?? []).includes(station)) return 'missing';
  return undefined;
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

function invertPoint(
  px: number,
  py: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
): { x: number; y: number } {
  const dx = (px - center.x) / ppm;
  const dy = (py - center.y) / ppm;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** Edge coordinate (position along edge) -> stamp-local centre-origin mm. */
function edgeLocalPoint(
  spec: StampSpec,
  edge: EdgeName,
  posMm: number,
  outwardMm: number,
): { x: number; y: number } {
  switch (edge) {
    case 'top':
      return { x: posMm - spec.widthMm / 2, y: -spec.heightMm / 2 - outwardMm };
    case 'bottom':
      // Tangential axis runs left -> right like the top edge, with the
      // outward normal pointing toward +y.
      return { x: posMm - spec.widthMm / 2, y: spec.heightMm / 2 + outwardMm };
    case 'left':
      // Tangential axis runs top -> bottom like the right edge, with the
      // outward normal pointing toward -x.
      return { x: -spec.widthMm / 2 - outwardMm, y: posMm - spec.heightMm / 2 };
    case 'right':
      return { x: spec.widthMm / 2 + outwardMm, y: posMm - spec.heightMm / 2 };
  }
}

/**
 * Remove a circular punch straddling the nominal edge, the way a real
 * perforating pin works. The pin centre sits half a radius outside the paper
 * edge so the surviving bite is roughly semicircular, with its deepest point
 * one radius inside the edge. Defective punches shrink or shift the circle.
 */
function punchBite(
  mask: Uint8Array,
  W: number,
  H: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
  spec: StampSpec,
  edge: EdgeName,
  posMm: number,
  radiusMm: number,
  depthMm: number,
): void {
  // Pin centre offset along the outward normal. A normal punch sits ~0.5r
  // outside the edge giving an inward bite of ~r. A shallow half-punch keeps
  // its (smaller) circle centred on the edge, so the bite stays visible.
  const outwardShift = depthMm >= radiusMm * 0.9 ? radiusMm - depthMm : 0;
  const cLocal = edgeLocalPoint(spec, edge, posMm, outwardShift);
  const rPx = radiusMm * ppm;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const local = invertPoint(px + 0.5, py + 0.5, center, rot, ppm);
      const dx = local.x - cLocal.x;
      const dy = local.y - cLocal.y;
      if (dx * dx + dy * dy <= radiusMm * radiusMm) {
        mask[py * W + px] = 0;
      }
    }
  }
}

function tearRoughPatch(
  mask: Uint8Array,
  W: number,
  H: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
  spec: StampSpec,
  edge: EdgeName,
  posMm: number,
  r: number,
  rng: () => number,
): void {
  const cLocal = edgeLocalPoint(spec, edge, posMm, 0);
  const span = r * 1.7;
  // Outward unit vector in stamp-local coordinates.
  const outward =
    edge === 'top'
      ? { x: 0, y: -1 }
      : edge === 'bottom'
        ? { x: 0, y: 1 }
        : edge === 'left'
          ? { x: -1, y: 0 }
          : { x: 1, y: 0 };
  const tangentAxis = edge === 'top' || edge === 'bottom' ? 'x' : 'y';
  // Precompute a jagged tear boundary along the tangent so it is spatially
  // coherent (not independent per-pixel noise). Sampling every ~0.2 mm gives
  // a rough, fibrous edge clearly distinct from a smooth punched hole.
  const segMm = 0.2;
  const spanCount = Math.ceil(span / segMm);
  const jagProfile: number[] = [];
  for (let k = -spanCount; k <= spanCount; k++) {
    const t = k * segMm;
    const envelope = 1 - Math.abs(t) / (span * 1.1); // deepest at the tear centre
    const roughness =
      Math.abs(Math.sin(t * 19.7)) * r * 0.5 +
      Math.abs(Math.sin(t * 41.3 + 2.1)) * r * 0.35 +
      rng() * r * 0.7;
    // Tear bites 1.6r..2.6r inward at its centre, tapering to nothing at the ends.
    jagProfile.push(Math.max(0, envelope) * (r * 1.5 + roughness));
  }
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const local = invertPoint(px + 0.5, py + 0.5, center, rot, ppm);
      const tangent = (tangentAxis === 'x' ? local.x : local.y) - (tangentAxis === 'x' ? cLocal.x : cLocal.y);
      if (Math.abs(tangent) > span) continue;
      const segIdx = Math.round(tangent / segMm) + spanCount;
      const inwardDepth = jagProfile[Math.max(0, Math.min(jagProfile.length - 1, segIdx))]!;
      const normalCoord = tangentAxis === 'x' ? local.y - cLocal.y : local.x - cLocal.x;
      // Remove paper where it lies inside the jagged tear boundary.
      const inside =
        outward.y !== 0
          ? -outward.y * normalCoord < inwardDepth
          : -outward.x * normalCoord < inwardDepth;
      if (inside) mask[py * W + px] = 0;
    }
  }
}

function rotateLocal(
  local: { x: number; y: number },
  center: { x: number; y: number },
  rot: number,
  ppm: number,
): { x: number; y: number } {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return {
    x: center.x + (local.x * c - local.y * s) * ppm,
    y: center.y + (local.x * s + local.y * c) * ppm,
  };
}

// ---------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------

function paintDesign(
  img: RgbImage,
  mask: Uint8Array,
  W: number,
  H: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
  spec: StampSpec,
  opts: GenerateOptions,
  rng: () => number,
): void {
  const frameW = spec.widthMm - 7;
  const frameH = spec.heightMm - 8;
  const ox = opts.designOffsetMm.x;
  const oy = opts.designOffsetMm.y;
  const scale = opts.printColorScale;
  const ink = (base: { r: number; g: number; b: number }) => ({
    r: clamp8(base.r * scale + gaussian(rng, 0, 2)),
    g: clamp8(base.g * scale + gaussian(rng, 0, 2)),
    b: clamp8(base.b * scale + gaussian(rng, 0, 2)),
  });
  const base = ink(spec.baseColor);
  const accent = ink(spec.accentColor);
  const frameLine = ink({ r: 40, g: 36, b: 34 });

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (!mask[py * W + px]) continue;
      const local = invertPoint(px + 0.5, py + 0.5, center, rot, ppm);
      const x = local.x - ox;
      const y = local.y - oy;
      const inFrame = Math.abs(x) <= frameW / 2 && Math.abs(y) <= frameH / 2;
      const onBorder =
        inFrame &&
        (Math.abs(Math.abs(x) - frameW / 2) < 0.18 || Math.abs(Math.abs(y) - frameH / 2) < 0.18);
      if (onBorder) {
        img.r[py * W + px] = frameLine.r;
        img.g[py * W + px] = frameLine.g;
        img.b[py * W + px] = frameLine.b;
        continue;
      }
      if (!inFrame) continue;
      // Stylised motif: central medallion + diagonal accents + denomination band.
      const med = Math.hypot(x * 1.15, y);
      const inMedallion = med < Math.min(frameW, frameH) * 0.32;
      const band = y > frameH * 0.28 && y < frameH * 0.44;
      const diagonal = Math.abs(y - 0.55 * x) < 0.5 || Math.abs(y + 0.55 * x) < 0.5;
      let chosen = inMedallion || band ? accent : base;
      if (diagonal && !inMedallion) chosen = accent;
      const texture = gaussian(rng, 0, 2.6);
      img.r[py * W + px] = clamp8(chosen.r + texture);
      img.g[py * W + px] = clamp8(chosen.g + texture);
      img.b[py * W + px] = clamp8(chosen.b + texture);
    }
  }
}

function paintMildew(
  img: RgbImage,
  mask: Uint8Array,
  W: number,
  H: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
  spec: StampSpec,
  rng: () => number,
): { xMm: number; yMm: number; radiusMm: number } | null {
  const radiusMm = 0.5 + rng() * 1.1;
  // Keep spots in the paper margin band, inset far enough to clear the
  // perforation holes (~2 mm) but still outside the printed design frame.
  const horizontal = rng() > 0.5;
  const along = (rng() - 0.5) * (horizontal ? spec.widthMm : spec.heightMm) * 0.6;
  const side = rng() > 0.5 ? 1 : -1;
  const inset = 2.8 + rng() * 1.2;
  const local = horizontal
    ? { x: along, y: side * (spec.heightMm / 2 - inset) }
    : { x: side * (spec.widthMm / 2 - inset), y: along };
  const cImg = rotateLocal(local, center, rot, ppm);
  const rPx = radiusMm * ppm;
  for (let py = Math.floor(cImg.y - rPx); py <= Math.ceil(cImg.y + rPx); py++) {
    for (let px = Math.floor(cImg.x - rPx); px <= Math.ceil(cImg.x + rPx); px++) {
      if (px < 0 || py < 0 || px >= W || py >= H || !mask[py * W + px]) continue;
      const d = Math.hypot(px - cImg.x, py - cImg.y) / rPx;
      if (d > 1) continue;
      const strength = (1 - d) * (0.7 + rng() * 0.3);
      const i = py * W + px;
      // Yellow-brown foxing: red held, green moderately down, blue strongly down.
      img.r[i] = clamp8(img.r[i]! - 26 * strength);
      img.g[i] = clamp8(img.g[i]! - 34 * strength);
      img.b[i] = clamp8(img.b[i]! - 58 * strength);
    }
  }
  return { xMm: local.x, yMm: local.y, radiusMm };
}

function paintWatermark(
  img: RgbImage,
  mask: Uint8Array,
  W: number,
  H: number,
  center: { x: number; y: number },
  rot: number,
  ppm: number,
  spec: StampSpec,
  rng: () => number,
): void {
  if (spec.watermark === 'none') return;
  const tpl = WATERMARK_TEMPLATES.find((t) => t.name === spec.watermark);
  if (!tpl) return;
  const pattern = tpl.render(ppm);
  const startX = Math.round((W - pattern.width) / 2);
  const startY = Math.round((H - pattern.height) / 2);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (!mask[py * W + px]) continue;
      const tx = px - startX;
      const ty = py - startY;
      if (tx < 0 || ty < 0 || tx >= pattern.width || ty >= pattern.height) continue;
      const v = pattern.data[ty * pattern.width + tx]!;
      if (v <= 0) continue;
      // Thinner paper transmits more light: watermark appears brighter.
      const lift = v * (20 + gaussian(rng, 0, 1.2));
      const i = py * W + px;
      img.r[i] = clamp8(img.r[i]! + lift);
      img.g[i] = clamp8(img.g[i]! + lift);
      img.b[i] = clamp8(img.b[i]! + lift * 0.96);
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
