import {
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z,
  GROUND_HALF_EXTENT
} from "./worldGrid";
import { structureCenter, isStructureBuilt, type GameState } from "../state/GameState";
import { resourceFieldCenterWorld } from "../economy/resourceFieldGeometry";
import {
  canonicalizeSphereWorldPoint,
  fillSphereEquivalentWorldPoints,
  sphereGeodesicDistanceWorldXZ
} from "./worldSurface";
import { BASE_STRUCTURE_VISION_RANGE, structureVisionRange } from "../structureStats";

/** Matches client fog: completed buildings grant this sight radius. */
export const EXPLORATION_STRUCTURE_VISION_RANGE = BASE_STRUCTURE_VISION_RANGE;
/** Higher-res exploration grid (must stay in sync with client fog cell size). */
const EXPL_CELL_SIZE = 1.25;

const GX_MIN = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_X) / EXPL_CELL_SIZE);
const GX_MAX = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_X - 1e-6) / EXPL_CELL_SIZE);
const GZ_MIN = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_Z) / EXPL_CELL_SIZE);
const GZ_MAX = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_Z - 1e-6) / EXPL_CELL_SIZE);

export const EXPL_FW = GX_MAX - GX_MIN + 1;
export const EXPL_FH = GZ_MAX - GZ_MIN + 1;
let visibleScratch: Uint8Array | null = null;
const explWrapPaintBuf: { x: number; z: number }[] = Array.from({ length: 8 }, () => ({ x: 0, z: 0 }));

function idx(gx: number, gz: number): number {
  return (gz - GZ_MIN) * EXPL_FW + (gx - GX_MIN);
}

function paintCircle(
  visible: Uint8Array,
  cx: number,
  cz: number,
  radius: number
): void {
  const minGx = Math.max(GX_MIN, Math.floor((cx - radius - GRID_ORIGIN_X) / EXPL_CELL_SIZE));
  const maxGx = Math.min(GX_MAX, Math.floor((cx + radius - GRID_ORIGIN_X) / EXPL_CELL_SIZE));
  const minGz = Math.max(GZ_MIN, Math.floor((cz - radius - GRID_ORIGIN_Z) / EXPL_CELL_SIZE));
  const maxGz = Math.min(GZ_MAX, Math.floor((cz + radius - GRID_ORIGIN_Z) / EXPL_CELL_SIZE));
  for (let gx = minGx; gx <= maxGx; gx += 1) {
    for (let gz = minGz; gz <= maxGz; gz += 1) {
      const wx = GRID_ORIGIN_X + (gx + 0.5) * EXPL_CELL_SIZE;
      const wz = GRID_ORIGIN_Z + (gz + 0.5) * EXPL_CELL_SIZE;
      if (sphereGeodesicDistanceWorldXZ(cx, cz, wx, wz) <= radius) {
        visible[idx(gx, gz)] = 1;
      }
    }
  }
}

export function allocateExplorationMaps(state: GameState): void {
  const n = EXPL_FW * EXPL_FH;
  for (const p of state.players) {
    if (!state.playerExploration[p.id] || state.playerExploration[p.id]!.length !== n) {
      const buf = new Uint8Array(n);
      buf.fill(0);
      state.playerExploration[p.id] = buf;
      continue;
    }
    state.playerExploration[p.id]!.fill(0);
  }
}

/** Merge current vision from units + built structures into each player's persistent exploration. */
export function advanceExploration(state: GameState): void {
  allocateExplorationMaps(state);
  if (!visibleScratch || visibleScratch.length !== EXPL_FW * EXPL_FH) {
    visibleScratch = new Uint8Array(EXPL_FW * EXPL_FH);
  }
  const visible = visibleScratch;

  for (const p of state.players) {
    visible.fill(0);
    const paintWrapped = (cx: number, cz: number, radius: number): void => {
      const n = fillSphereEquivalentWorldPoints(cx, cz, explWrapPaintBuf);
      for (let i = 0; i < n; i += 1) {
        const p0 = explWrapPaintBuf[i];
        paintCircle(visible, p0.x, p0.z, radius);
      }
    };
    for (const u of state.units) {
      if (u.hp <= 0 || u.playerId !== p.id) continue;
      paintWrapped(u.position.x, u.position.z, u.visionRange);
    }
    for (const s of state.structures) {
      if (s.hp <= 0 || s.playerId !== p.id) continue;
      if (!isStructureBuilt(s)) continue;
      const c = structureCenter(s);
      paintWrapped(c.x, c.z, structureVisionRange(s.kind));
    }
    for (const f of state.resourceFields) {
      if (f.kind !== "minerals") continue;
      if (f.homePatchVisionOwnerId !== p.id) continue;
      if (f.reserve !== null && f.reserve <= 0) continue;
      const c = resourceFieldCenterWorld(f);
      paintWrapped(c.x, c.z, EXPLORATION_STRUCTURE_VISION_RANGE);
    }
    const ex = state.playerExploration[p.id]!;
    for (let i = 0; i < ex.length; i += 1) {
      if (visible[i]) ex[i] = 1;
    }
  }
}

export function isWorldExploredForPlayer(state: GameState, playerId: string, wx: number, wz: number): boolean {
  const buf = state.playerExploration[playerId];
  if (!buf || buf.length === 0) return false;
  const canon = canonicalizeSphereWorldPoint(wx, wz);
  wx = canon.x;
  wz = canon.z;
  const gx = Math.floor((wx - GRID_ORIGIN_X) / EXPL_CELL_SIZE);
  const gz = Math.floor((wz - GRID_ORIGIN_Z) / EXPL_CELL_SIZE);
  if (gx < GX_MIN || gx > GX_MAX || gz < GZ_MIN || gz > GZ_MAX) return false;
  return buf[idx(gx, gz)] === 1;
}
