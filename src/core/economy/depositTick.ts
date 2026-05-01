import {
  structureCenter,
  type GameState,
  type SimStructure,
  type SimUnit,
  type Vec3,
  isStructureBuilt
} from "../state/GameState";
import {
  MINERAL_DEPOT_DEPOSIT_MULTIPLIER,
  MINER_CARRY_CAPACITY
} from "../economyConstants";
import { moveGroundUnitTowardPoint } from "../sim/structureFootprintMoveSlide";
import { topologyDistanceXZ } from "../world/worldTopology";

function distXZ(state: GameState, a: { x: number; z: number }, b: { x: number; z: number }): number {
  return topologyDistanceXZ(state, a.x, a.z, b.x, b.z);
}

const COMMAND_CORE_UNLOAD_CENTER_RANGE = 1.05;
const MINERAL_DEPOT_UNLOAD_CENTER_RANGE = 0.86;

function resolveDepositStructure(
  state: GameState,
  unit: SimUnit
): SimStructure | null {
  const sid = unit.depositStructureTargetId;
  if (!sid) return null;
  const st = state.structures.find((s) => s.id === sid);
  if (!st || st.hp <= 0 || st.playerId !== unit.playerId) return null;
  if (st.kind !== "home" && st.kind !== "mineral_depot") return null;
  if (!isStructureBuilt(st)) return null;
  return st;
}

function isValidDepositoryTarget(state: GameState, unit: SimUnit, structureId: string): boolean {
  const st = state.structures.find((s) => s.id === structureId);
  return (
    !!st &&
    st.hp > 0 &&
    st.playerId === unit.playerId &&
    (st.kind === "home" || st.kind === "mineral_depot") &&
    isStructureBuilt(st)
  );
}

/** True when close enough to unload: miners must visibly reach the depository, not just graze its far edge. */
function minerInDepositoryUnloadRange(state: GameState, unit: SimUnit, st: SimStructure): boolean {
  const c = structureCenter(st);
  const range = st.kind === "mineral_depot" ? MINERAL_DEPOT_UNLOAD_CENTER_RANGE : COMMAND_CORE_UNLOAD_CENTER_RANGE;
  return distXZ(state, unit.position, c) <= range;
}

/** Nearest Command Core or Mineral Depository for drop-off (stable tie-break by id). */
export function findNearestDepositoryStructureId(
  state: GameState,
  playerId: string,
  from: Vec3
): string | null {
  let bestId: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of state.structures) {
    if (s.playerId !== playerId || s.hp <= 0) continue;
    if (s.kind !== "home" && s.kind !== "mineral_depot") continue;
    if (!isStructureBuilt(s)) continue;
    const d = distXZ(state, from, structureCenter(s));
    const tiePrefer = bestId !== null && s.id.localeCompare(bestId) < 0;
    if (bestId === null || d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && tiePrefer)) {
      bestD = d;
      bestId = s.id;
    }
  }
  return bestId;
}

/**
 * Miners with an active mineral gather order: at full cargo, path to the nearest Core/Depot
 * (or keep a player-picked depository). After unloading they return to the same node until
 * Stop, move, attack, or a new gather target.
 */
export function assignAutoDepositForGatheringMiner(unit: SimUnit, state: GameState): void {
  if (unit.kind !== "N") return;
  if (unit.carriedMinerals < MINER_CARRY_CAPACITY) return;
  if (unit.depositStructureTargetId && isValidDepositoryTarget(state, unit, unit.depositStructureTargetId)) {
    return;
  }
  const sid = findNearestDepositoryStructureId(state, unit.playerId, unit.position);
  if (sid) {
    unit.depositStructureTargetId = sid;
    unit.gatherMineralPulseAccumSec = 0;
  }
}
/**
 * Walk to Command Core / Mineral Depository and unload carried minerals into the player pool.
 * @returns true if deposit logic owned this unit for the tick (caller should continue the unit loop).
 */
export function processDepositForUnit(
  unit: SimUnit,
  state: GameState,
  deltaSeconds: number,
  deadIds: Set<string>
): boolean {
  if (deadIds.has(unit.id) || unit.hp <= 0) return false;
  if (!unit.depositStructureTargetId) return false;
  if (unit.carriedMinerals <= 0) {
    unit.depositStructureTargetId = null;
    return false;
  }

  const st = resolveDepositStructure(state, unit);
  if (!st) {
    unit.depositStructureTargetId = null;
    return false;
  }

  const center = structureCenter(st);
  if (!minerInDepositoryUnloadRange(state, unit, st)) {
    moveGroundUnitTowardPoint(unit, state, center, unit.speed, deltaSeconds);
    return true;
  }

  const player = state.players.find((p) => p.id === unit.playerId);
  if (!player) {
    unit.depositStructureTargetId = null;
    return true;
  }

  const multiplier = st.kind === "mineral_depot" ? MINERAL_DEPOT_DEPOSIT_MULTIPLIER : 1;
  player.resources.minerals += Math.round(unit.carriedMinerals * multiplier);
  unit.carriedMinerals = 0;
  unit.depositStructureTargetId = null;
  return true;
}
