import { describe, expect, it } from "vitest";
import type { GameState, SimStructure, SimUnit } from "../state/GameState";
import {
  FOOTPRINT_UNIT_COLLISION_MARGIN,
  moveGroundUnitTowardPoint,
  slideXZPastStructureFootprints,
  unitXZBlockedByStructures
} from "./structureFootprintMoveSlide";
import { GRID_CELL_SIZE, GRID_ORIGIN_X, GRID_ORIGIN_Z } from "../world/worldGrid";

function minimalState(structures: SimStructure[]): GameState {
  return {
    matchId: "t",
    modeId: "real_time",
    tick: 0,
    tickRateHz: 20,
    players: [],
    turn: { number: 0, phase: "planning", planningDeadlineEpochMs: null },
    units: [],
    structures,
    resourceFields: [],
    selections: {},
    structureSelections: {},
    exploredByPlayerId: {},
    victorPlayerId: null,
    skirmishBoostPassive: null,
    terrain: "sphere"
  } as unknown as GameState;
}

function rockUnit(x: number, z: number): SimUnit {
  return {
    id: "u",
    playerId: "p",
    team: "blue",
    kind: "R",
    hp: 10,
    position: { x, y: 0.5, z },
    moveTarget: null,
    attackMoveTarget: null,
    attackTargetId: null,
    attackStructureTargetId: null,
    gatherTargetFieldId: null,
    resumeGatherFieldId: null,
    moveWaypointQueue: [],
    carriedMinerals: 0,
    depositStructureTargetId: null,
    buildStructureTargetId: null,
    pendingStructurePlacement: null,
    gatherMineralPulseAccumSec: 0,
    speed: 5,
    attackRange: 1,
    visionRange: 10,
    attackDamage: 1,
    attackCooldownSeconds: 1,
    cooldownRemainingSeconds: 0,
    attackClass: "melee",
    damageReceivedFromUnitId: {},
    stuckChasingAttackTargetSec: 0,
    chaseDistToAttackTargetPrev: null
  };
}

describe("slideXZPastStructureFootprints", () => {
  it("lets units clip through a 1×1 footprint instead of stalling", () => {
    const wall: SimStructure = {
      id: "w",
      playerId: "e",
      team: "red",
      kind: "power_spire",
      hp: 10,
      maxHp: 10,
      gx: 0,
      gz: 0,
      footW: 1,
      footD: 1,
      buildRemainingSec: 0,
      buildTotalSec: 0,
      productionQueue: [],
      rallyPoint: null,
      rallyMineFieldId: null,
      homeDefenseCooldownRemainingSec: 0
    };
    const state = minimalState([wall]);
    /** South-west of the 1×1 cell (gx=0,gz=0); diagonal +2,+2 lands inside the old padded footprint. */
    const unit = rockUnit(-31, -31);
    const dvx = 2;
    const dvz = 2;
    expect(unitXZBlockedByStructures(unit.position.x + dvx, unit.position.z + dvz, unit, state)).toBe(false);
    const next = slideXZPastStructureFootprints(unit.position.x, unit.position.z, dvx, dvz, unit, state);
    expect(unitXZBlockedByStructures(next.x, next.z, unit, state)).toBe(false);
    expect(next.x).toBe(unit.position.x + dvx);
    expect(next.z).toBe(unit.position.z + dvz);
  });

  it("moves straight through a 1×1 (solar) south face instead of pathing around invisible collision", () => {
    const wall: SimStructure = {
      id: "spire",
      playerId: "e",
      team: "red",
      kind: "power_spire",
      hp: 10,
      maxHp: 10,
      gx: 8,
      gz: 8,
      footW: 1,
      footD: 1,
      buildRemainingSec: 0,
      buildTotalSec: 0,
      productionQueue: [],
      rallyPoint: null,
      rallyMineFieldId: null,
      homeDefenseCooldownRemainingSec: 0
    };
    const state = minimalState([wall]);
    const minZ = GRID_ORIGIN_Z + wall.gz * GRID_CELL_SIZE - FOOTPRINT_UNIT_COLLISION_MARGIN;
    const midX = GRID_ORIGIN_X + (wall.gx + 0.5) * GRID_CELL_SIZE;
    /** Flush south of the padded box so a +Z micro-step would enter the footprint (stuck-at-wall case). */
    const unit = rockUnit(midX, minZ - 0.02);
    const dvx = 0;
    const dvz = 0.35;
    expect(unitXZBlockedByStructures(unit.position.x + dvx, unit.position.z + dvz, unit, state)).toBe(false);
    const goal = { x: midX, y: 0.5, z: minZ + 18 };
    const next = slideXZPastStructureFootprints(unit.position.x, unit.position.z, dvx, dvz, unit, state, goal);
    expect(unitXZBlockedByStructures(next.x, next.z, unit, state)).toBe(false);
    expect(next.x).toBe(unit.position.x + dvx);
    expect(next.z).toBe(unit.position.z + dvz);
  });

  it("moves straight through a 2×2 face instead of freezing against it", () => {
    const gx = 12;
    const gz = 12;
    const wall: SimStructure = {
      id: "b",
      playerId: "e",
      team: "red",
      kind: "barracks_r",
      hp: 10,
      maxHp: 10,
      gx,
      gz,
      footW: 2,
      footD: 2,
      buildRemainingSec: 0,
      buildTotalSec: 0,
      productionQueue: [],
      rallyPoint: null,
      rallyMineFieldId: null,
      homeDefenseCooldownRemainingSec: 0
    };
    const state = minimalState([wall]);
    const midZ = GRID_ORIGIN_Z + (gz + 0.5) * GRID_CELL_SIZE;
    const px = GRID_ORIGIN_X + gx * GRID_CELL_SIZE - 1.2;
    const unit = rockUnit(px, midZ);
    const dvx = 2.2;
    const dvz = 0;
    expect(unitXZBlockedByStructures(unit.position.x + dvx, unit.position.z + dvz, unit, state)).toBe(false);
    const next = slideXZPastStructureFootprints(unit.position.x, unit.position.z, dvx, dvz, unit, state);
    expect(unitXZBlockedByStructures(next.x, next.z, unit, state)).toBe(false);
    expect(next.x).toBe(unit.position.x + dvx);
    expect(next.z).toBe(unit.position.z + dvz);
  });

  it("does not treat wrapped footprint copies as unit blockers in sphere mode", () => {
    const wall: SimStructure = {
      id: "wrap",
      playerId: "e",
      team: "red",
      kind: "power_spire",
      hp: 10,
      maxHp: 10,
      gx: 0,
      gz: 8,
      footW: 1,
      footD: 1,
      buildRemainingSec: 0,
      buildTotalSec: 0,
      productionQueue: [],
      rallyPoint: null,
      rallyMineFieldId: null,
      homeDefenseCooldownRemainingSec: 0
    };
    const state = minimalState([wall]);
    state.terrain = "sphere";
    const wrappedUnit = rockUnit(107.25, GRID_ORIGIN_Z + (wall.gz + 0.5) * GRID_CELL_SIZE);
    expect(unitXZBlockedByStructures(wrappedUnit.position.x, wrappedUnit.position.z, wrappedUnit, state)).toBe(
      false
    );
  });

  it("lets units occupy footprints instead of freezing on invisible collision", () => {
    const home: SimStructure = {
      id: "home",
      playerId: "e",
      team: "red",
      kind: "home",
      hp: 100,
      maxHp: 100,
      gx: 8,
      gz: 8,
      footW: 3,
      footD: 3,
      buildRemainingSec: 0,
      buildTotalSec: 0,
      productionQueue: [],
      rallyPoint: null,
      rallyMineFieldId: null,
      homeDefenseCooldownRemainingSec: 0
    };
    const state = minimalState([home]);
    const unit = rockUnit(
      GRID_ORIGIN_X + (home.gx + 1.5) * GRID_CELL_SIZE,
      GRID_ORIGIN_Z + (home.gz + 1.5) * GRID_CELL_SIZE
    );
    expect(unitXZBlockedByStructures(unit.position.x, unit.position.z, unit, state)).toBe(false);
    unit.moveTarget = { x: unit.position.x + 5, y: 0.5, z: unit.position.z };
    expect(unitXZBlockedByStructures(unit.position.x, unit.position.z, unit, state)).toBe(false);
  });

  it("moves on sphere terrain without stalling near pole-adjacent targets", () => {
    const state = minimalState([]);
    state.terrain = "sphere";
    const unit = rockUnit(0, 54);
    moveGroundUnitTowardPoint(unit, state, { x: 8, y: 0.5, z: 56 }, unit.speed, 0.2);
    expect(Number.isFinite(unit.position.x)).toBe(true);
    expect(Number.isFinite(unit.position.z)).toBe(true);
    expect(Math.hypot(unit.position.x, unit.position.z - 54)).toBeGreaterThan(0.01);
  });

  it("tries a wider escape fan when sphere movement is pinched", () => {
    const state = minimalState([]);
    state.terrain = "sphere";
    const unit = rockUnit(0, 0);
    const next = slideXZPastStructureFootprints(0, 0, 0.28, 0, unit, state, { x: 5, z: 0 });
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.z)).toBe(true);
  });
});
