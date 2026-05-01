import type { PlaceableStructureKind } from "./commands/GameCommand";
import { structureFootprintOverlapsResourceField } from "./economy/fieldOverlap";
import { resourceFieldCenterWorld } from "./economy/resourceFieldGeometry";
import type { SimResourceField } from "./economy/resourceFieldTypes";
import {
  isStructureBuilt,
  structureCenter,
  structureFootprintViolatesMinimumClearance,
  type GameState,
  type StructureKind
} from "./state/GameState";
import { footprintForStructureKind } from "./structureFootprint";
import { EXPLORATION_STRUCTURE_VISION_RANGE, isWorldExploredForPlayer } from "./world/explorationGrid";
import { sphereTerrainBlocksFootprint } from "./world/sphereTerrain";
import { topologyDistanceXZ } from "./world/worldTopology";
import { footprintCenterWorld, footprintInWorldBounds, GRID_CELL_SIZE, GRID_ORIGIN_X, GRID_ORIGIN_Z } from "./world/worldGrid";

/** Nearest non-depleted mineral patch to the Command Core (typical “main” node for that base). */
export function nearestMineralFieldToPlayerHome(
  state: GameState,
  playerId: string
): SimResourceField | null {
  const home = state.structures.find(
    (s) => s.playerId === playerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return null;
  const hc = structureCenter(home);
  let best: SimResourceField | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const f of state.resourceFields) {
    if (f.kind !== "minerals") continue;
    if (f.reserve !== null && f.reserve <= 0) continue;
    const c = resourceFieldCenterWorld(f);
    const d = topologyDistanceXZ(state, c.x, c.z, hc.x, hc.z);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function distancePointXZToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-8) return Math.hypot(apx, apz);
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cz = az + t * abz;
  return Math.hypot(px - cx, pz - cz);
}

/**
 * Solar footprints must not sit in the lane between Core and the nearest mineral node (blocks miner traffic).
 */
export function powerSpireObstructsHomeToPrimaryMineralLane(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  const home = state.structures.find(
    (s) => s.playerId === playerId && s.kind === "home" && s.hp > 0 && isStructureBuilt(s)
  );
  if (!home) return false;
  const field = nearestMineralFieldToPlayerHome(state, playerId);
  if (!field) return false;
  const hc = structureCenter(home);
  const fc = resourceFieldCenterWorld(field);
  const segLen = topologyDistanceXZ(state, fc.x, fc.z, hc.x, hc.z);
  /** Too short: core is basically on the patch — no meaningful corridor. */
  if (segLen < 6) return false;
  const pc = footprintCenterWorld(gx, gz, footW, footD);
  const dLane = distancePointXZToSegment(pc.x, pc.z, hc.x, hc.z, fc.x, fc.z);
  /** Half-width of “keep clear” tube (meters) so 1×1 spires cannot plug the lane. */
  const corridorHalfWidth = 3.25;
  return dLane < corridorHalfWidth;
}

/** True if a 2×2 (or given) building footprint can be placed on the grid. */
export function canPlaceStructureFootprint(
  state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  if (!footprintInWorldBounds(gx, gz, footW, footD)) return false;
  if (structureFootprintViolatesMinimumClearance(state, gx, gz, footW, footD)) return false;
  if (structureFootprintOverlapsResourceField(state, gx, gz, footW, footD)) return false;
  if (sphereTerrainBlocksFootprint(state, gx, gz, footW, footD)) return false;
  return true;
}

/** Terrain/bounds-only check for queued fog build orders; hidden structures/resources are checked on arrival. */
export function canPlanStructureFootprint(
  state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  if (!footprintInWorldBounds(gx, gz, footW, footD)) return false;
  if (sphereTerrainBlocksFootprint(state, gx, gz, footW, footD)) return false;
  return true;
}

/** Placement visibility gate: footprint center has been explored by this player. */
export function isFootprintExploredForPlayer(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  const c = footprintCenterWorld(gx, gz, footW, footD);
  return isWorldExploredForPlayer(state, playerId, c.x, c.z);
}

/** A living friendly **N** (neutral-line miner) must see the footprint center (build “scout” rule). */
export function friendlyMinerSeesFootprintCenter(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  const c = footprintCenterWorld(gx, gz, footW, footD);
  for (const u of state.units) {
    if (u.playerId !== playerId || u.hp <= 0 || u.kind !== "N") continue;
    const d = topologyDistanceXZ(state, u.position.x, u.position.z, c.x, c.z);
    if (d <= u.visionRange) return true;
  }
  return false;
}

/**
 * True if every cell center of the footprint lies within the Command Core’s completed sight radius.
 * Lets you expand near the core without a miner present (miners often leave to gather).
 */
export function footprintWithinCommandCoreVision(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  const home = state.structures.find(
    (s) =>
      s.playerId === playerId && s.kind === "home" && s.hp > 0 && isStructureBuilt(s)
  );
  if (!home) return false;
  const hc = structureCenter(home);
  const r = EXPLORATION_STRUCTURE_VISION_RANGE;
  for (let i = 0; i < footW; i += 1) {
    for (let j = 0; j < footD; j += 1) {
      const wx = GRID_ORIGIN_X + (gx + i + 0.5) * GRID_CELL_SIZE;
      const wz = GRID_ORIGIN_Z + (gz + j + 0.5) * GRID_CELL_SIZE;
      if (topologyDistanceXZ(state, wx, wz, hc.x, hc.z) > r + 0.05) return false;
    }
  }
  return true;
}

/**
 * Footprint legal + explored-at-center.
 * Keeps terrain/resource/overlap checks but removes miner/core lane/scout restrictions for freer base layouts.
 */
export function canPlaceStructureForPlayer(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number,
  _placementKind?: StructureKind | null
): boolean {
  if (!canPlaceStructureFootprint(state, gx, gz, footW, footD)) return false;
  if (!isFootprintExploredForPlayer(state, playerId, gx, gz, footW, footD)) return false;
  return true;
}

export function canPlanStructureForPlayer(
  state: GameState,
  playerId: string,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  if (isFootprintExploredForPlayer(state, playerId, gx, gz, footW, footD)) {
    return canPlaceStructureFootprint(state, gx, gz, footW, footD);
  }
  return canPlanStructureFootprint(state, gx, gz, footW, footD);
}

/**
 * Minimum XZ distance (m) from Command Core **center** to **this** structure’s footprint center so large
 * pads (2×2) sit slightly off the Core. 1×1 spires can sit closer still.
 * CPU search prefers the closest legal site that still clears this bar; if none do, falls back to any legal.
 */
export function minFootprintCenterDistanceFromHomeForCpuSpacing(kind: PlaceableStructureKind): number {
  if (kind === "power_spire" || kind === "defense_obelisk") return GRID_CELL_SIZE * 1.65;
  /** ~2.1 cells — keeps CPU pads off the Core center while allowing tight rings for dense bases. */
  return GRID_CELL_SIZE * 2.1;
}

/**
 * Brute-force a padding (grid cells) around the Command Core for a legal `kind` placement.
 * Prefers the **closest** site to the Core that still meets {@link minFootprintCenterDistanceFromHomeForCpuSpacing};
 * if every valid cell is tighter than that (early exploration), uses the closest valid overall.
 */
export function findNearestValidStructurePlacementNearHome(
  state: GameState,
  playerId: string,
  kind: PlaceableStructureKind,
  padCells = 18
): { gx: number; gz: number } | null {
  const home = state.structures.find(
    (s) => s.playerId === playerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return null;
  const { footW, footD } = footprintForStructureKind(kind);
  const hc = structureCenter(home);
  const minD = minFootprintCenterDistanceFromHomeForCpuSpacing(kind);
  /** Best among placements with d >= minD (tightest such = smallest d). */
  let spaced: { gx: number; gz: number; d: number } | null = null;
  /** Closest legal regardless of spacing (fallback). */
  let any: { gx: number; gz: number; d: number } | null = null;
  const gxMin = home.gx - padCells;
  const gxMax = home.gx + home.footW + padCells;
  const gzMin = home.gz - padCells;
  const gzMax = home.gz + home.footD + padCells;
  for (let gx = gxMin; gx <= gxMax; gx += 1) {
    for (let gz = gzMin; gz <= gzMax; gz += 1) {
      if (!canPlaceStructureForPlayer(state, playerId, gx, gz, footW, footD, kind)) continue;
      const c = footprintCenterWorld(gx, gz, footW, footD);
      const d = topologyDistanceXZ(state, c.x, c.z, hc.x, hc.z);
      if (!any || d < any.d) any = { gx, gz, d };
      if (d < minD) continue;
      if (!spaced || d < spaced.d) spaced = { gx, gz, d };
    }
  }
  const pick = spaced ?? any;
  return pick ? { gx: pick.gx, gz: pick.gz } : null;
}

/**
 * CPU / expansion: legal site **closest to a world anchor** (e.g. mid-map minerals), still respecting
 * {@link minFootprintCenterDistanceFromHomeForCpuSpacing} when possible. Scans a grid box around the
 * midpoint between Core and anchor.
 */
export function findNearestValidStructurePlacementTowardWorldPoint(
  state: GameState,
  playerId: string,
  kind: PlaceableStructureKind,
  targetX: number,
  targetZ: number,
  padCells: number
): { gx: number; gz: number } | null {
  const home = state.structures.find(
    (s) => s.playerId === playerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return null;
  const { footW, footD } = footprintForStructureKind(kind);
  const hc = structureCenter(home);
  const minD = minFootprintCenterDistanceFromHomeForCpuSpacing(kind);
  const midX = hc.x * 0.42 + targetX * 0.58;
  const midZ = hc.z * 0.42 + targetZ * 0.58;
  const anchorGx = Math.floor((midX - GRID_ORIGIN_X) / GRID_CELL_SIZE);
  const anchorGz = Math.floor((midZ - GRID_ORIGIN_Z) / GRID_CELL_SIZE);

  let spaced: { gx: number; gz: number; ta: number } | null = null;
  let any: { gx: number; gz: number; ta: number } | null = null;

  for (let gx = anchorGx - padCells; gx <= anchorGx + padCells; gx += 1) {
    for (let gz = anchorGz - padCells; gz <= anchorGz + padCells; gz += 1) {
      if (!canPlaceStructureForPlayer(state, playerId, gx, gz, footW, footD, kind)) continue;
      const c = footprintCenterWorld(gx, gz, footW, footD);
      const ta = Math.hypot(c.x - targetX, c.z - targetZ);
      const dHome = topologyDistanceXZ(state, c.x, c.z, hc.x, hc.z);
      if (!any || ta < any.ta) any = { gx, gz, ta };
      if (dHome < minD) continue;
      if (!spaced || ta < spaced.ta) spaced = { gx, gz, ta };
    }
  }
  const pick = spaced ?? any;
  return pick ? { gx: pick.gx, gz: pick.gz } : null;
}
