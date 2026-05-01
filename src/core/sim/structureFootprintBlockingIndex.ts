import type { GameState, SimStructure } from "../state/GameState";
import { footprintWorldBoundsXZ, GROUND_HALF_EXTENT, GRID_ORIGIN_X, GRID_ORIGIN_Z } from "../world/worldGrid";
import { fillSphereEquivalentWorldPoints } from "../world/worldSurface";

/** Must match `FOOTPRINT_UNIT_COLLISION_MARGIN` in structureFootprintMoveSlide. */
const BLOCK_MARGIN = 0.3;

const BUCKET = 18;
const WORLD_EXT =
  Math.max(GROUND_HALF_EXTENT, Math.abs(GRID_ORIGIN_X), Math.abs(GRID_ORIGIN_Z)) + 40;
const GRID_ORIGIN = -WORLD_EXT;
const NX = Math.max(8, Math.ceil((2 * WORLD_EXT) / BUCKET) + 1);
const NZ = NX;
const CELL_COUNT = NX * NZ;

let cachedTick = -1;
let cachedStructuresRef: SimStructure[] | null = null;
let cachedTerrain: GameState["terrain"] | null = null;

const grid: number[][] = Array.from({ length: CELL_COUNT }, () => []);
const eqCenterBuf: { x: number; z: number }[] = Array.from({ length: 8 }, () => ({ x: 0, z: 0 }));
const queryEqBuf: { x: number; z: number }[] = Array.from({ length: 8 }, () => ({ x: 0, z: 0 }));
let visitGen = 1;
let visitStamp: Uint32Array = new Uint32Array(256);

function toIx(px: number): number {
  return Math.min(NX - 1, Math.max(0, Math.floor((px - GRID_ORIGIN) / BUCKET)));
}
function toIz(pz: number): number {
  return Math.min(NZ - 1, Math.max(0, Math.floor((pz - GRID_ORIGIN) / BUCKET)));
}

function insertAabbIndex(si: number, minX: number, maxX: number, minZ: number, maxZ: number): void {
  const ix0 = toIx(minX);
  const ix1 = toIx(maxX);
  const iz0 = toIz(minZ);
  const iz1 = toIz(maxZ);
  for (let ix = ix0; ix <= ix1; ix += 1) {
    const row = ix * NZ;
    for (let iz = iz0; iz <= iz1; iz += 1) {
      grid[row + iz].push(si);
    }
  }
}

function rebuild(state: GameState): void {
  for (let i = 0; i < CELL_COUNT; i += 1) grid[i].length = 0;
  const structures = state.structures;
  for (let si = 0; si < structures.length; si += 1) {
    const s = structures[si];
    if (s.hp <= 0) continue;
    const b0 = footprintWorldBoundsXZ(s.gx, s.gz, s.footW, s.footD);
    const minX0 = b0.minX - BLOCK_MARGIN;
    const maxX0 = b0.maxX + BLOCK_MARGIN;
    const minZ0 = b0.minZ - BLOCK_MARGIN;
    const maxZ0 = b0.maxZ + BLOCK_MARGIN;
    const c0x = (minX0 + maxX0) * 0.5;
    const c0z = (minZ0 + maxZ0) * 0.5;
    const n = fillSphereEquivalentWorldPoints(c0x, c0z, eqCenterBuf);
    for (let k = 0; k < n; k += 1) {
      const dx = eqCenterBuf[k].x - c0x;
      const dz = eqCenterBuf[k].z - c0z;
      insertAabbIndex(si, minX0 + dx, maxX0 + dx, minZ0 + dz, maxZ0 + dz);
    }
  }
}

function ensureVisit(len: number): void {
  if (visitStamp.length < len) {
    visitStamp = new Uint32Array(Math.max(len, visitStamp.length * 2));
  }
}

/**
 * Call once per sim tick before unit movement / footprint push so blocking queries stay coherent.
 */
export function prepareFootprintBlockingIndex(state: GameState): void {
  if (cachedTick === state.tick && cachedStructuresRef === state.structures && cachedTerrain === state.terrain) {
    return;
  }
  cachedTick = state.tick;
  cachedStructuresRef = state.structures;
  cachedTerrain = state.terrain;
  rebuild(state);
}

/**
 * Invokes `fn` for each structure index that might block at `(px,pz)` (torus-aware on sphere).
 * If `fn` returns `true`, iteration stops.
 */
export function forEachStructureCandidateNearXZ(
  state: GameState,
  px: number,
  pz: number,
  fn: (s: SimStructure) => boolean | void
): void {
  prepareFootprintBlockingIndex(state);
  const structures = state.structures;
  if (structures.length === 0) return;

  ensureVisit(structures.length);
  const myGen = visitGen;
  visitGen += 1;
  if (visitGen > 0x7ffffff0) {
    visitStamp.fill(0);
    visitGen = 1;
  }

  const nPts = fillSphereEquivalentWorldPoints(px, pz, queryEqBuf);
  for (let p = 0; p < nPts; p += 1) {
    const qx = queryEqBuf[p].x;
    const qz = queryEqBuf[p].z;
    const ix = toIx(qx);
    const iz = toIz(qz);
    for (let ox = -1; ox <= 1; ox += 1) {
      const iix = ix + ox;
      if (iix < 0 || iix >= NX) continue;
      const row = iix * NZ;
      for (let oz = -1; oz <= 1; oz += 1) {
        const iiz = iz + oz;
        if (iiz < 0 || iiz >= NZ) continue;
        const cell = grid[row + iiz];
        for (let c = 0; c < cell.length; c += 1) {
          const si = cell[c];
          if (visitStamp[si] === myGen) continue;
          visitStamp[si] = myGen;
          if (fn(structures[si])) return;
        }
      }
    }
  }
}
