import {
  footprintCenterWorld,
  footprintInWorldBounds,
  footprintsOverlap,
  GRID_CELL_SIZE,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z,
  GROUND_HALF_EXTENT
} from "./worldGrid";
import type { TerrainId } from "../state/GameState";

/** 3×3 Command Core footprint. */
const HW = 3;
const HD = 3;

/** Keep cores off the extreme grid edge so starter solar / minerals still fit. */
const MARGIN = 4;

function hashMatchLayoutSeed(matchId: string): number {
  let h = 2166136261;
  for (let i = 0; i < matchId.length; i += 1) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validHomeGridBounds(): { gxMin: number; gxMax: number; gzMin: number; gzMax: number } {
  const gxLo = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_X) / GRID_CELL_SIZE);
  const gxHi = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_X - 1e-6) / GRID_CELL_SIZE);
  const gzLo = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_Z) / GRID_CELL_SIZE);
  const gzHi = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_Z - 1e-6) / GRID_CELL_SIZE);
  let gxMinN = 999;
  let gxMaxN = -999;
  let gzMinN = 999;
  let gzMaxN = -999;
  for (let gx = gxLo; gx <= gxHi; gx += 1) {
    for (let gz = gzLo; gz <= gzHi; gz += 1) {
      if (!footprintInWorldBounds(gx, gz, HW, HD)) continue;
      gxMinN = Math.min(gxMinN, gx);
      gxMaxN = Math.max(gxMaxN, gx);
      gzMinN = Math.min(gzMinN, gz);
      gzMaxN = Math.max(gzMaxN, gz);
    }
  }
  return {
    gxMin: gxMinN + MARGIN,
    gxMax: gxMaxN - MARGIN,
    gzMin: gzMinN + MARGIN,
    gzMax: gzMaxN - MARGIN
  };
}

function nearestHomeFootprint(targetX: number, targetZ: number): { gx: number; gz: number } | null {
  const { gxMin, gxMax, gzMin, gzMax } = validHomeGridBounds();
  let best: { gx: number; gz: number } | null = null;
  let bestD = Infinity;
  for (let gx = gxMin; gx <= gxMax; gx += 1) {
    for (let gz = gzMin; gz <= gzMax; gz += 1) {
      if (!footprintInWorldBounds(gx, gz, HW, HD)) continue;
      const c = footprintCenterWorld(gx, gz, HW, HD);
      const d = (c.x - targetX) ** 2 + (c.z - targetZ) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { gx, gz };
      }
    }
  }
  return best;
}

/**
 * Two Command Core placements with jitter. On the sphere chart:
 * - Both homes sit near the **equator** (world Z ≈ 0) so “north” on the UV stays readable.
 * - **Player 1** (`[0]` → human / blue in `seedStructures`) is always in the **+X** half (eastern chart),
 *   **player 2** in **−X** (western), so you can triangulate off the skybox / minimap.
 */
export function pickOpposedHomeFootprints(
  matchId: string,
  _terrain: TerrainId = "sphere"
): [{ gx: number; gz: number }, { gx: number; gz: number }] {
  const rng = mulberry32(hashMatchLayoutSeed(matchId) ^ 0x9e37_79b9);

  const corner = GROUND_HALF_EXTENT * 0.74;
  const la = nearestHomeFootprint(corner, corner);
  const lb = nearestHomeFootprint(-corner, -corner);
  const legacy: [{ gx: number; gz: number }, { gx: number; gz: number }] =
    la && lb ? [la, lb] : [
      { gx: 2, gz: 29 },
      { gx: 28, gz: 2 }
    ];

  const minCoreSep = GROUND_HALF_EXTENT * 0.95;
  const H = GROUND_HALF_EXTENT;
  /** Keep Command Cores inside the polar gameplay band from `sphereTerrain`. */
  const zMax = H * 0.72;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const zBand = H * (0.04 + rng() * 0.08);
    const t1z = Math.max(-zMax, Math.min(zMax, (rng() - 0.5) * 2 * zBand));
    const t2z = Math.max(-zMax, Math.min(zMax, -t1z + (rng() - 0.5) * H * 0.05));

    const xMag = H * (0.4 + rng() * 0.14);
    const t1x = xMag + (rng() - 0.5) * H * 0.06;
    const t2x = -xMag + (rng() - 0.5) * H * 0.06;

    const a = nearestHomeFootprint(t1x, t1z);
    if (!a) continue;

    const b = nearestHomeFootprint(t2x, t2z);
    if (!b) continue;

    if (a.gx === b.gx && a.gz === b.gz) continue;
    if (footprintsOverlap(a.gx, a.gz, HW, HD, b.gx, b.gz, HW, HD)) continue;

    const c1 = footprintCenterWorld(a.gx, a.gz, HW, HD);
    const c2 = footprintCenterWorld(b.gx, b.gz, HW, HD);
    if (c1.x <= 0 || c2.x >= 0) continue;

    const sep = Math.hypot(c1.x - c2.x, c1.z - c2.z);
    if (sep < minCoreSep) continue;

    return [a, b];
  }

  return legacy;
}
