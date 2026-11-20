import { GrayImage, RgbImage, boxBlur, connectedComponents, morphologicalOpen, otsuThreshold } from '../image/primitives.js';
import { MM_PER_INCH, Point, angleBetween, clamp, dist, rotatePoint } from '../util/geometry.js';

export interface FrameCorners {
  /** Corners ordered topLeft, topRight, bottomRight, bottomLeft in image space. */
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/**
 * Detected stamp frame: the minimum-area rectangle enclosing the paper
 * (its sides pass through the perforation tooth tips), plus all geometry
 * needed to convert between scanner pixels and stamp-local millimetres.
 */
export class StampFrame {
  readonly corners: FrameCorners;
  readonly center: Point;
  /** Rotation of the stamp relative to scanner axes, radians. */
  readonly angle: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mmPerPixel: number;
  /** Threshold used to build the paper mask (Otsu, includes dark ink areas). */
  readonly grayThreshold: number;
  /** Threshold used by edge rays, separating paper from the scanner bed. */
  readonly edgeThreshold: number;

  constructor(
    corners: FrameCorners,
    center: Point,
    angle: number,
    widthPx: number,
    heightPx: number,
    dpi: number,
    grayThreshold: number,
    edgeThreshold: number,
  ) {
    this.corners = corners;
    this.center = center;
    this.angle = angle;
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    this.mmPerPixel = MM_PER_INCH / dpi;
    this.grayThreshold = grayThreshold;
    this.edgeThreshold = edgeThreshold;
  }

  get widthMm(): number {
    return this.widthPx * this.mmPerPixel;
  }

  get heightMm(): number {
    return this.heightPx * this.mmPerPixel;
  }

  /** Stamp-local mm (centre origin, x right / y down along stamp axes) -> image px. */
  localToImage(xMm: number, yMm: number): Point {
    const x = xMm / this.mmPerPixel;
    const y = yMm / this.mmPerPixel;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return {
      x: this.center.x + x * c - y * s,
      y: this.center.y + x * s + y * c,
    };
  }

  /** Image px -> stamp-local mm. */
  imageToLocal(p: Point): { x: number; y: number } {
    const dx = p.x - this.center.x;
    const dy = p.y - this.center.y;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const x = dx * c + dy * s;
    const y = -dx * s + dy * c;
    return { x: x * this.mmPerPixel, y: y * this.mmPerPixel };
  }

  /**
   * Resample the stamp into an axis-aligned image in stamp geometry.
   * A border of `paddingMm` scanner bed is kept on every side so edge rays
   * can start outside the paper and measure full perforation depth.
   * pxPerMm defaults to the native scanner resolution.
   */
  rectifyGray(img: GrayImage, pxPerMm?: number, paddingMm = 3): GrayImage {
    const ppm = pxPerMm ?? 1 / this.mmPerPixel;
    const w = Math.round((this.widthMm + 2 * paddingMm) * ppm);
    const h = Math.round((this.heightMm + 2 * paddingMm) * ppm);
    const out = new GrayImage(w, h);
    for (let yy = 0; yy < h; yy++) {
      const yMm = -this.heightMm / 2 - paddingMm + (yy + 0.5) / ppm;
      for (let xx = 0; xx < w; xx++) {
        const xMm = -this.widthMm / 2 - paddingMm + (xx + 0.5) / ppm;
        const p = this.localToImage(xMm, yMm);
        out.data[yy * w + xx] = img.sample(p.x, p.y);
      }
    }
    return out;
  }

  rectifyRgb(img: RgbImage, pxPerMm?: number, paddingMm = 3): RgbImage {
    const ppm = pxPerMm ?? 1 / this.mmPerPixel;
    const w = Math.round((this.widthMm + 2 * paddingMm) * ppm);
    const h = Math.round((this.heightMm + 2 * paddingMm) * ppm);
    const out = new RgbImage(w, h);
    for (let yy = 0; yy < h; yy++) {
      const yMm = -this.heightMm / 2 - paddingMm + (yy + 0.5) / ppm;
      for (let xx = 0; xx < w; xx++) {
        const xMm = -this.widthMm / 2 - paddingMm + (xx + 0.5) / ppm;
        const p = this.localToImage(xMm, yMm);
        const px = img.sample(p.x, p.y);
        const i = yy * w + xx;
        out.r[i] = px.r;
        out.g[i] = px.g;
        out.b[i] = px.b;
      }
    }
    return out;
  }
}

export interface EdgeRay {
  /** Position along the edge from its start corner, mm. */
  positionMm: number;
  /** Paper boundary offset from the nominal corner-to-corner line, mm. Positive = outward. */
  offsetMm: number;
  /** Confidence 0..1 that a real paper/background crossing was found. */
  confidence: number;
}

/** Detect the stamp paper rectangle in a scan. Assumes paper contrasts with the scanner bed. */
export function detectFrame(gray: GrayImage, dpi: number): StampFrame {
  const blurred = boxBlur(gray, 2);
  const maskThreshold = otsuThreshold(blurred);
  // Rays need a paper-vs-bed threshold that ignores dark ink seen through
  // perforations; the bimodal paper/bed threshold serves that purpose.
  const edgeThreshold = bimodalEdgeThreshold(blurred, maskThreshold);
  const threshold = maskThreshold;

  // Paper is normally the lighter class; pick the mask whose largest component
  // occupies a plausible stamp-like share of the image.
  const lightMask = new Uint8Array(gray.data.length);
  const darkMask = new Uint8Array(gray.data.length);
  for (let i = 0; i < gray.data.length; i++) {
    lightMask[i] = blurred.data[i]! > threshold ? 1 : 0;
    darkMask[i] = blurred.data[i]! <= threshold ? 1 : 0;
  }
  const openLight = morphologicalOpen(lightMask, gray.width, gray.height, 2);
  const openDark = morphologicalOpen(darkMask, gray.width, gray.height, 2);
  const lightCC = connectedComponents(openLight, gray.width, gray.height);
  const darkCC = connectedComponents(openDark, gray.width, gray.height);
  // The scanner bed is one component filling the image and touching all four
  // borders. The stamp is a component separated from every border (tooth tips
  // may graze the outermost row, hence a small tolerance). Prefer any true
  // interior component on either polarity; only fall back to area heuristics
  // when nothing is cleanly separated.
  const lightPick = pickInteriorComponent(lightCC.components, gray.width, gray.height);
  const darkPick = pickInteriorComponent(darkCC.components, gray.width, gray.height);
  const lightInterior = lightPick && isInterior(lightPick, gray.width, gray.height);
  const darkInterior = darkPick && isInterior(darkPick, gray.width, gray.height);
  let mask: Uint8Array;
  let componentId: number;
  if (lightInterior || (!darkInterior && (lightPick?.pixels ?? 0) >= (darkPick?.pixels ?? 0))) {
    mask = openLight;
    componentId = lightPick!.id;
  } else if (darkPick) {
    mask = openDark;
    componentId = darkPick.id;
  } else {
    throw new Error('Could not locate a stamp-sized paper region in the scan');
  }

  const { labels } = mask === openLight ? lightCC : darkCC;
  // Subsample mask pixels for cheap angle search.
  const step = Math.max(2, Math.round(Math.min(gray.width, gray.height) / 400));
  const pts: Point[] = [];
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < gray.height; y += step) {
    for (let x = 0; x < gray.width; x += step) {
      if (labels[y * gray.width + x] === componentId) {
        pts.push({ x, y });
        sumX += x;
        sumY += y;
        n++;
      }
    }
  }
  if (n < 50) throw new Error('Stamp region too small to analyse');
  const centroid = { x: sumX / n, y: sumY / n };

  // PCA initial orientation.
  let mu11 = 0;
  let mu20 = 0;
  let mu02 = 0;
  for (const p of pts) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    mu11 += dx * dy;
    mu20 += dx * dx;
    mu02 += dy * dy;
  }
  const pcaAngle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);

  // Refine: minimum-area bbox over angles near the PCA orientation.
  const refined = refineAngle(pts, centroid, pcaAngle);
  // A rectangle is invariant to 90-degree rotations, so for near-square stamps
  // the fit may return an angle near +/-90 deg. Fold into [-45, 45), the
  // canonical small-rotation range a scanner actually produces.
  const angle = normalizeSmallAngle(refined);
  const bbox = rotatedBBox(pts, centroid, angle);
  // Use the bbox geometric centre, not the mask centroid: the centroid drifts
  // when perforations/tears are asymmetric, but the rectangle centre stays at
  // the true stamp midpoint and is the correct origin for margin measurement.
  const origin = bbox.center;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const make = (lx: number, ly: number): Point => ({
    x: origin.x + lx * cos - ly * sin,
    y: origin.y + lx * sin + ly * cos,
  });
  const hw = bbox.width / 2;
  const hh = bbox.height / 2;
  // Normalise so width tracks the longer PCA axis and corners have a stable order.
  const corners: FrameCorners = {
    topLeft: make(-hw, -hh),
    topRight: make(hw, -hh),
    bottomRight: make(hw, hh),
    bottomLeft: make(-hw, hh),
  };
  return new StampFrame(
    corners,
    origin,
    angle,
    bbox.width,
    bbox.height,
    dpi,
    maskThreshold,
    edgeThreshold,
  );
}

type ComponentLike = {
  id: number;
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Threshold between the scanner-bed tone and the paper tone.
 * The two dominant histogram modes are located on either side of the Otsu
 * value; the boundary is their midpoint so a ray crossing a perforation does
 * not confuse dark design ink (seen through the hole) with the bed.
 */
function bimodalEdgeThreshold(img: GrayImage, fallback: number): number {
  const hist = new Array(256).fill(0) as number[];
  for (let i = 0; i < img.data.length; i += 3) {
    hist[Math.min(255, Math.max(0, Math.round(img.data[i]!)))]!++;
  }
  const smooth = (h: number[]) => h.map((_, i) => (h[i - 1] ?? 0) + h[i]! + (h[i + 1] ?? 0));
  const h = smooth(hist);
  let bedPeak = 0;
  let bedVal = 0;
  let paperPeak = 255;
  let paperVal = 0;
  for (let t = 0; t <= fallback; t++) {
    if (h[t]! > bedVal) {
      bedVal = h[t]!;
      bedPeak = t;
    }
  }
  for (let t = fallback; t < 256; t++) {
    if (h[t]! > paperVal) {
      paperVal = h[t]!;
      paperPeak = t;
    }
  }
  if (paperPeak - bedPeak < 25) return fallback;
  return (bedPeak + paperPeak) / 2;
}

/**
 * Largest component that plausibly represents the stamp. Strictly interior
 * components are preferred; when none exist (e.g. a tooth grazes the border),
 * fall back to a component covering a moderate, stamp-like image share rather
 * than the bed component, which occupies nearly the whole frame.
 */
function isInterior(c: ComponentLike, width: number, height: number, margin = 4): boolean {
  return (
    c.minX >= margin &&
    c.minY >= margin &&
    c.maxX <= width - 1 - margin &&
    c.maxY <= height - 1 - margin
  );
}

function pickInteriorComponent(
  components: ComponentLike[],
  width: number,
  height: number,
): ComponentLike | undefined {
  const interior = components.filter((c) => isInterior(c, width, height));
  if (interior.length > 0) {
    return interior.reduce((a, b) => (b.pixels > a.pixels ? b : a));
  }
  const imageArea = width * height;
  const plausible = components.filter(
    (c) => c.pixels < 0.92 * imageArea && c.pixels > 0.01 * imageArea,
  );
  const pool = plausible.length > 0 ? plausible : components;
  return pool.reduce<ComponentLike | undefined>(
    (best, c) => (!best || c.pixels > best.pixels ? c : best),
    undefined,
  );
}

interface BBox {
  width: number;
  height: number;
  /** Geometric centre of the rotated rectangle in image coordinates. */
  center: Point;
}

function rotatedBBox(pts: Point[], center: Point, angle: number): BBox {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const x = dx * c + dy * s;
    const y = -dx * s + dy * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const midLX = (minX + maxX) / 2;
  const midLY = (minY + maxY) / 2;
  // Rotate the local-frame midpoint back into image coordinates.
  return {
    width: maxX - minX,
    height: maxY - minY,
    center: {
      x: center.x + midLX * c - midLY * s,
      y: center.y + midLX * s + midLY * c,
    },
  };
}

function normalizeSmallAngle(a: number): number {
  const deg = (a * 180) / Math.PI;
  // Wrap into (-180, 180], then fold onto [-45, 45).
  let wrapped = ((deg + 180) % 360) - 180;
  while (wrapped >= 45) wrapped -= 90;
  while (wrapped < -45) wrapped += 90;
  return (wrapped * Math.PI) / 180;
}

function refineAngle(pts: Point[], center: Point, pcaAngle: number): number {
  // The rectangle has 90-degree rotational symmetry, so the PCA principal
  // axis is ambiguous by 90 degrees for near-square stamps. Search the full
  // 0..90 range coarsely, then refine around the best quarter-degree cell.
  let bestAngle = pcaAngle;
  let bestArea = Infinity;
  const evaluate = (a: number) => {
    const b = rotatedBBox(pts, center, a);
    return b.width * b.height;
  };
  for (let deg = 0; deg < 90; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const area = evaluate(a);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = a;
    }
  }
  const coarse = bestAngle;
  for (let step = -2; step <= 2; step += 0.1) {
    const a = coarse + (step * Math.PI) / 180;
    const area = evaluate(a);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = a;
    }
  }
  return bestAngle;
}

export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';

export interface EdgeGeometry {
  edge: EdgeSide;
  start: Point;
  end: Point;
  lengthMm: number;
  /** Unit vector along the edge, start -> end. */
  tangent: Point;
  /** Unit vector pointing out of the stamp. */
  outward: Point;
}

export function edgeGeometry(frame: StampFrame, edge: EdgeSide): EdgeGeometry {
  const c = frame.corners;
  const map: Record<EdgeSide, [Point, Point]> = {
    top: [c.topLeft, c.topRight],
    right: [c.topRight, c.bottomRight],
    bottom: [c.bottomRight, c.bottomLeft],
    left: [c.bottomLeft, c.topLeft],
  };
  const [start, end] = map[edge]!;
  const lenPx = dist(start, end);
  const tangent = { x: (end.x - start.x) / lenPx, y: (end.y - start.y) / lenPx };
  const inwardAngle = angleBetween(start, end);
  // Outward normal = inward normal rotated -90deg.
  const outward = { x: Math.sin(inwardAngle), y: -Math.cos(inwardAngle) };
  return {
    edge,
    start,
    end,
    lengthMm: lenPx * frame.mmPerPixel,
    tangent,
    outward,
  };
}

/**
 * Walk one edge and measure the paper boundary position along outward normals.
 * The nominal line (0 offset) joins the two corners and passes through tooth
 * tips; perforation bites push the boundary to negative offsets.
 */
export function sampleEdgeProfile(
  gray: GrayImage,
  frame: StampFrame,
  edge: EdgeSide,
  sampleStepMm = 0.12,
): EdgeRay[] {
  const geom = edgeGeometry(frame, edge);
  const mmPerPx = frame.mmPerPixel;
  const count = Math.max(20, Math.floor(geom.lengthMm / sampleStepMm));
  const rayInMm = 2.4;
  const rays: EdgeRay[] = [];

  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const positionMm = t * geom.lengthMm;
    const origin = {
      x: geom.start.x + geom.tangent.x * (positionMm / mmPerPx),
      y: geom.start.y + geom.tangent.y * (positionMm / mmPerPx),
    };
    // March from inside the paper outward and find the paper->background crossing.
    let prevPaper = true;
    let crossingOffset = 0;
    let found = false;
    const steps = Math.ceil((2 * rayInMm) / (mmPerPx * 0.9));
    let prevGray = NaN;
    let prevOffset = -rayInMm;
    for (let k = 0; k <= steps; k++) {
      const offsetMm = -rayInMm + (2 * rayInMm * k) / steps;
      // Signed offset along the outward normal; negative offsets sample inside.
      const p = {
        x: origin.x + (geom.outward.x * offsetMm) / mmPerPx,
        y: origin.y + (geom.outward.y * offsetMm) / mmPerPx,
      };
      const g = gray.sample(p.x, p.y);
      const isPaper = g > frame.edgeThreshold;
      if (k > 0 && prevPaper && !isPaper) {
        // Sub-pixel linear interpolation of the threshold crossing.
        const span = prevGray - g;
        const frac = span > 0 ? (prevGray - frame.edgeThreshold) / span : 0.5;
        crossingOffset = prevOffset + frac * (offsetMm - prevOffset);
        found = true;
        break;
      }
      prevPaper = isPaper;
      prevGray = g;
      prevOffset = offsetMm;
    }
    // Corner geometry is unreliable (two edges meet) and must not seed a hole.
    const cornerZone = Math.min(positionMm, geom.lengthMm - positionMm) < 1.5;
    rays.push({
      positionMm,
      offsetMm: clamp(crossingOffset, -rayInMm, rayInMm),
      confidence: found ? (cornerZone ? 0.2 : 1) : 0,
    });
  }
  return rays;
}
