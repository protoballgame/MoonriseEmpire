import { describe, expect, it } from "vitest";
import { MINERAL_DEPOT_DEPOSIT_MULTIPLIER, RESOURCE_GATHER_RANGE } from "../economyConstants";
import { createEmptyGameState, makeSimUnit, makeStructure, structureCenter, type GameState } from "../state/GameState";
import { assignAutoDepositForGatheringMiner, processDepositForUnit } from "./depositTick";
import { processGatheringForUnit } from "./gatheringTick";
import { resourceFieldCenterWorld } from "./resourceFieldGeometry";
import { topologyDistanceXZ } from "../world/worldTopology";

function stateWithDepository(kind: "home" | "mineral_depot"): GameState {
  const state = createEmptyGameState("real_time");
  state.players = [
    {
      id: "p1",
      civ: "khemetic",
      resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
    }
  ];
  const st = makeStructure("p1", "blue", kind, 10, 10, kind === "home" ? 3 : 2, kind === "home" ? 3 : 2, 100);
  const c = structureCenter(st);
  const unit = makeSimUnit("p1", "blue", "N", { x: c.x, y: 0.55, z: c.z });
  unit.carriedMinerals = 5;
  unit.depositStructureTargetId = st.id;
  state.structures = [st];
  state.units = [unit];
  return state;
}

describe("processDepositForUnit", () => {
  it("unloads carried minerals at the Command Core one-to-one", () => {
    const state = stateWithDepository("home");
    const unit = state.units[0]!;

    expect(processDepositForUnit(unit, state, 0.05, new Set())).toBe(true);
    expect(state.players[0]!.resources.minerals).toBe(5);
    expect(unit.carriedMinerals).toBe(0);
    expect(unit.depositStructureTargetId).toBeNull();
  });

  it("boosts minerals unloaded at a Mineral Depository", () => {
    const state = stateWithDepository("mineral_depot");
    const unit = state.units[0]!;

    expect(processDepositForUnit(unit, state, 0.05, new Set())).toBe(true);
    expect(state.players[0]!.resources.minerals).toBe(Math.round(5 * MINERAL_DEPOT_DEPOSIT_MULTIPLIER));
    expect(unit.carriedMinerals).toBe(0);
  });

  it("sends full miners to the nearest Core or Depository even without an active gather target", () => {
    const state = stateWithDepository("home");
    const home = state.structures[0]!;
    const depot = makeStructure("p1", "blue", "mineral_depot", 16, 10, 2, 2, 100);
    state.structures.push(depot);
    const unit = state.units[0]!;
    const dc = structureCenter(depot);
    unit.position.x = dc.x + 0.4;
    unit.position.z = dc.z;
    unit.carriedMinerals = 5;
    unit.gatherTargetFieldId = null;
    unit.depositStructureTargetId = null;

    assignAutoDepositForGatheringMiner(unit, state);

    expect(unit.depositStructureTargetId).toBe(depot.id);
    expect(unit.depositStructureTargetId).not.toBe(home.id);
  });

  it("runs a visible gather and return loop without instant edge unloading", () => {
    const state = stateWithDepository("home");
    const home = state.structures[0]!;
    const field = { id: "near-ore", kind: "minerals" as const, gx: 13, gz: 10, reserve: 500 };
    const fc = resourceFieldCenterWorld(field);
    const unit = state.units[0]!;
    unit.position.x = fc.x;
    unit.position.z = fc.z;
    unit.gatherTargetFieldId = field.id;
    unit.depositStructureTargetId = null;
    unit.carriedMinerals = 0;
    state.resourceFields = [field];

    const deadIds = new Set<string>();
    let movedAwayFromField = false;
    for (let i = 0; i < 1200; i += 1) {
      if (topologyDistanceXZ(state, unit.position.x, unit.position.z, fc.x, fc.z) > RESOURCE_GATHER_RANGE + 0.25) {
        movedAwayFromField = true;
      }
      assignAutoDepositForGatheringMiner(unit, state);
      if (processDepositForUnit(unit, state, 0.05, deadIds)) continue;
      processGatheringForUnit(unit, state, 0.05, deadIds);
      if (state.players[0]!.resources.minerals > 0) break;
    }

    expect(state.players[0]!.resources.minerals).toBeGreaterThan(0);
    expect(movedAwayFromField).toBe(true);
    expect(unit.carriedMinerals).toBe(0);
    expect(unit.gatherTargetFieldId).toBe(field.id);
    expect(unit.depositStructureTargetId).toBeNull();
    expect(home.hp).toBeGreaterThan(0);
  });
});
