import type { SimulationEvent } from "../sim/simulationEvents";
import type { SimResourceField } from "./resourceFieldTypes";
import type { GameState, SimUnit } from "../state/GameState";
import {
  MINERAL_GATHER_MAX_PULSES_PER_TICK,
  MINERAL_GATHER_PER_PULSE,
  MINERAL_GATHER_PULSE_INTERVAL_SEC,
  MINER_CARRY_CAPACITY,
  RESOURCE_GATHER_RANGE
} from "../economyConstants";
import { moveGroundUnitTowardPoint } from "../sim/structureFootprintMoveSlide";
import { topologyDistanceXZ } from "../world/worldTopology";
import { resourceFieldCenterWorld } from "./resourceFieldGeometry";

function mineralGatherPulseAmount(): number {
  return Math.max(1, Math.round(MINERAL_GATHER_PER_PULSE));
}

/** Shortest chart-wrapped XZ distance on the moon topology. */
function distXZ(
  state: GameState,
  a: { x: number; z: number },
  b: { x: number; z: number }
): number {
  return topologyDistanceXZ(state, a.x, a.z, b.x, b.z);
}

function mineralApproachTarget(
  _unit: SimUnit,
  center: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  return center;
}

/** Another mineral node this miner can “see” (ground XZ), excluding a stale id. */
function findNearestVisibleMineralField(
  unit: SimUnit,
  state: GameState,
  excludeFieldId: string | null
): SimResourceField | null {
  const vr = unit.visionRange;
  let best: SimResourceField | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const f of state.resourceFields) {
    if (f.kind !== "minerals") continue;
    if (excludeFieldId !== null && f.id === excludeFieldId) continue;
    if (f.reserve !== null && f.reserve <= 0) continue;
    const c = resourceFieldCenterWorld(f);
    const d = distXZ(state, unit.position, c);
    if (d > vr) continue;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * If the unit is gathering, move toward the node or extract this tick.
 * @returns `true` if gathering handled this unit (caller should `continue` the unit loop).
 */
export function processGatheringForUnit(
  unit: SimUnit,
  state: GameState,
  deltaSeconds: number,
  deadIds: Set<string>,
  events?: SimulationEvent[]
): boolean {
  if (deadIds.has(unit.id) || unit.hp <= 0) return false;
  if (!unit.gatherTargetFieldId) return false;

  let field = state.resourceFields.find((f) => f.id === unit.gatherTargetFieldId);
  const staleGatherId = unit.gatherTargetFieldId;
  if (!field || (field.reserve !== null && field.reserve <= 0)) {
    unit.gatherMineralPulseAccumSec = 0;
    if (unit.kind === "N") {
      const replacement = findNearestVisibleMineralField(unit, state, staleGatherId);
      if (replacement) {
        unit.gatherTargetFieldId = replacement.id;
        field = replacement;
      } else {
        unit.gatherTargetFieldId = null;
        return false;
      }
    } else {
      unit.gatherTargetFieldId = null;
      return false;
    }
  }

  if (field.kind === "minerals") {
    if (unit.kind !== "N") {
      unit.gatherTargetFieldId = null;
      unit.gatherMineralPulseAccumSec = 0;
      return false;
    }

    const center = resourceFieldCenterWorld(field);
    const distance = distXZ(state, unit.position, center);
    if (distance > RESOURCE_GATHER_RANGE) {
      unit.gatherMineralPulseAccumSec = 0;
      moveGroundUnitTowardPoint(unit, state, mineralApproachTarget(unit, center), unit.speed, deltaSeconds);
      return true;
    }

    if (unit.carriedMinerals >= MINER_CARRY_CAPACITY) {
      return true;
    }

    unit.gatherMineralPulseAccumSec += deltaSeconds;
    let pulseCount = 0;
    let totalThisFrame = 0;

    while (
      pulseCount < MINERAL_GATHER_MAX_PULSES_PER_TICK &&
      unit.gatherMineralPulseAccumSec >= MINERAL_GATHER_PULSE_INTERVAL_SEC &&
      unit.carriedMinerals < MINER_CARRY_CAPACITY
    ) {
      unit.gatherMineralPulseAccumSec -= MINERAL_GATHER_PULSE_INTERVAL_SEC;
      const capSpace = MINER_CARRY_CAPACITY - unit.carriedMinerals;
      const pulseAmt = mineralGatherPulseAmount();
      let chunk = Math.min(pulseAmt, capSpace);
      if (field.reserve !== null) {
        if (field.reserve <= 0) break;
        chunk = Math.min(chunk, field.reserve);
        field.reserve -= chunk;
      }
      if (chunk <= 0) break;
      unit.carriedMinerals += chunk;
      totalThisFrame += chunk;
      pulseCount += 1;
    }

    if (events && totalThisFrame > 0) {
      events.push({
        type: "resources_gathered",
        playerId: unit.playerId,
        unitId: unit.id,
        gatherKind: "mineral",
        amount: totalThisFrame,
        position: { x: unit.position.x, y: unit.position.y + 0.35, z: unit.position.z }
      });
    }

    if (field.reserve !== null && field.reserve <= 0) {
      unit.gatherMineralPulseAccumSec = 0;
      const replacement = findNearestVisibleMineralField(unit, state, field.id);
      if (replacement) {
        unit.gatherTargetFieldId = replacement.id;
        const nc = resourceFieldCenterWorld(replacement);
        if (distXZ(state, unit.position, nc) > RESOURCE_GATHER_RANGE) {
          moveGroundUnitTowardPoint(unit, state, mineralApproachTarget(unit, nc), unit.speed, deltaSeconds);
        }
        return true;
      }
      unit.gatherTargetFieldId = null;
      return false;
    }

    return true;
  }

  /** Energy is only from generators, not world nodes. */
  unit.gatherTargetFieldId = null;
  unit.gatherMineralPulseAccumSec = 0;
  return false;
}

export function removeDepletedResourceFields(state: GameState): void {
  state.resourceFields = state.resourceFields.filter((f) => f.reserve === null || f.reserve > 0);
}
