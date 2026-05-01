import { fibonacci } from "../goldenScale";
import { structureCenter, type GameState, type SimStructure, type SimUnit, type Vec3 } from "../state/GameState";
import { topologyDistanceXZ } from "../world/worldTopology";
import { distancePointXZToFootprintEdgesWrapped, GRID_CELL_SIZE } from "../world/worldGrid";

/**
 * Max distance from the footprint pad edge (0 if inside) — “touching / blocked by collision at the pad”
 * still counts as in build range.
 */
export const STRUCTURE_BUILD_CONTACT_MAX_DIST = 0.6;

/** Distance from a world XZ point to the footprint rectangle (0 when inside/overlapping the pad). */
export function distancePointXZToStructureFootprint(s: SimStructure, px: number, pz: number): number {
  return distancePointXZToFootprintEdgesWrapped(px, pz, s.gx, s.gz, s.footW, s.footD);
}

/** True if a neutral worker at `px,pz` is close enough to assist this unfinished site (center bubble or pad contact). */
export function neutralMinerInConstructionAssistRange(
  px: number,
  pz: number,
  s: SimStructure,
  _source: GameState | "sphere" = "sphere"
): boolean {
  if (s.buildRemainingSec <= 0) return false;
  return (
    distancePointXZToFootprintEdgesWrapped(px, pz, s.gx, s.gz, s.footW, s.footD) <=
    STRUCTURE_BUILD_CONTACT_MAX_DIST
  );
}

function neutralWorkerAvailableForConstruction(u: SimUnit, structureId: string): boolean {
  if (u.kind !== "N" || u.hp <= 0) return false;
  if (u.buildStructureTargetId !== structureId) return false;
  if (u.gatherTargetFieldId || u.depositStructureTargetId) return false;
  if (u.attackTargetId || u.attackStructureTargetId) return false;
  if (u.attackMoveTarget) return false;
  return true;
}

/**
 * A friendly **N** with this explicit construction job must stand in range for `buildRemainingSec` to count down.
 */
export function isNeutralWorkerContributingToConstruction(state: GameState, s: SimStructure): boolean {
  if (s.buildRemainingSec <= 0) return false;
  for (const u of state.units) {
    if (u.playerId !== s.playerId) continue;
    if (!neutralWorkerAvailableForConstruction(u, s.id)) continue;
    if (neutralMinerInConstructionAssistRange(u.position.x, u.position.z, s, state)) return true;
  }
  return false;
}

/** How many assigned friendly **N** in range are speeding up this site’s build (for Fibonacci scaling). */
export function countNeutralWorkersContributingToConstruction(state: GameState, s: SimStructure): number {
  if (s.buildRemainingSec <= 0) return 0;
  let n = 0;
  for (const u of state.units) {
    if (u.playerId !== s.playerId) continue;
    if (!neutralWorkerAvailableForConstruction(u, s.id)) continue;
    if (neutralMinerInConstructionAssistRange(u.position.x, u.position.z, s, state)) n += 1;
  }
  return n;
}

/**
 * Build speed multiplier from worker count: Σ F(i) for i = 1 … n (1 → 1, 2 → 2, 3 → 4, 4 → 7, …).
 * Capped so very large swarms do not finish instantly.
 */
export function constructionBuildRateScale(workerCount: number): number {
  const n = Math.max(1, Math.min(workerCount, 10));
  let sum = 0;
  for (let i = 1; i <= n; i += 1) sum += fibonacci(i);
  return sum;
}

/** True if the issued move waypoint is plausibly for this pad (center, on footprint, or near edge). */
export function moveTargetIsNearStructureFootprint(
  mt: Vec3,
  s: SimStructure,
  source: GameState | "sphere" = "sphere"
): boolean {
  const c = structureCenter(s);
  const halfSpan = Math.hypot(s.footW * GRID_CELL_SIZE, s.footD * GRID_CELL_SIZE) * 0.5 + 2.5;
  if (topologyDistanceXZ(source, mt.x, mt.z, c.x, c.z) <= halfSpan) return true;
  return (
    distancePointXZToFootprintEdgesWrapped(mt.x, mt.z, s.gx, s.gz, s.footW, s.footD) <=
    STRUCTURE_BUILD_CONTACT_MAX_DIST + 1.2
  );
}

/** True if `dest` is a plausible move onto a friendly structure still under construction (for resume-gather). */
export function moveDestinationIsUnfinishedFriendlyStructure(
  state: GameState,
  playerId: string,
  dest: Vec3
): boolean {
  for (const s of state.structures) {
    if (s.playerId !== playerId || s.hp <= 0 || s.buildRemainingSec <= 0) continue;
    if (moveTargetIsNearStructureFootprint(dest, s, state)) return true;
  }
  return false;
}

/**
 * Miner was ordered onto a construction site but footprint push blocks reaching the exact waypoint;
 * treat as “arrived” when in build-assist range and the move was toward that unfinished site.
 */
export function neutralMinerArrivedToAssistConstruction(unit: SimUnit, state: GameState): boolean {
  if (unit.kind !== "N" || unit.hp <= 0 || !unit.moveTarget) return false;
  const mt = unit.moveTarget;
  for (const s of state.structures) {
    if (s.playerId !== unit.playerId || s.hp <= 0 || s.buildRemainingSec <= 0) continue;
    if (!moveTargetIsNearStructureFootprint(mt, s, state)) continue;
    if (neutralMinerInConstructionAssistRange(unit.position.x, unit.position.z, s, state)) return true;
  }
  return false;
}

/** True if this miner is assigned to an unfinished friendly structure and is in construction range. */
export function isNeutralWorkerAdvancingConstruction(state: GameState, unit: SimUnit): boolean {
  if (unit.kind !== "N" || unit.hp <= 0 || unit.buildStructureTargetId === null) return false;
  if (unit.gatherTargetFieldId || unit.depositStructureTargetId) return false;
  if (unit.attackTargetId || unit.attackStructureTargetId || unit.attackMoveTarget) return false;
  for (const s of state.structures) {
    if (s.id !== unit.buildStructureTargetId) continue;
    if (s.playerId !== unit.playerId || s.hp <= 0 || s.buildRemainingSec <= 0) continue;
    if (neutralMinerInConstructionAssistRange(unit.position.x, unit.position.z, s, state)) return true;
  }
  return false;
}

/** After building, restore gathering to `resumeGatherFieldId` when the miner is idle. */
export function tryApplyNeutralMinerResumeGather(state: GameState, unit: SimUnit): void {
  if (unit.kind !== "N" || unit.hp <= 0 || unit.resumeGatherFieldId === null) return;
  if (unit.buildStructureTargetId !== null) return;
  if (unit.moveTarget || unit.attackMoveTarget) return;
  if (unit.gatherTargetFieldId || unit.depositStructureTargetId) return;
  if (unit.attackTargetId || unit.attackStructureTargetId) return;
  const fid = unit.resumeGatherFieldId;
  const f = state.resourceFields.find((x) => x.id === fid);
  if (!f || f.kind !== "minerals" || (f.reserve !== null && f.reserve <= 0)) {
    unit.resumeGatherFieldId = null;
    return;
  }
  unit.gatherTargetFieldId = fid;
  unit.gatherMineralPulseAccumSec = 0;
  unit.resumeGatherFieldId = null;
}
