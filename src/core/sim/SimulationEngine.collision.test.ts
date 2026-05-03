import { describe, expect, it } from "vitest";
import { createEmptyGameState, makeSimUnit, makeStructure, structureCenter, type GameState } from "../state/GameState";
import { SimulationEngine } from "./SimulationEngine";

function collisionState(): GameState {
  const state = createEmptyGameState("real_time");
  state.players = [
    {
      id: "p1",
      civ: "khemetic",
      resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
    }
  ];
  state.structures = [makeStructure("p1", "blue", "home", 20, 20, 3, 3, 500)];
  return state;
}

function distanceXZ(a: { position: { x: number; z: number } }, b: { position: { x: number; z: number } }): number {
  return Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
}

describe("SimulationEngine unit collision", () => {
  it("still spreads idle Neutral units apart", () => {
    const state = collisionState();
    const a = makeSimUnit("p1", "blue", "N", { x: -4, y: 0.55, z: 0 });
    const b = makeSimUnit("p1", "blue", "N", { x: -4.05, y: 0.55, z: 0 });
    state.units = [a, b];

    const next = new SimulationEngine().step(state, 0).state;
    const d = distanceXZ(next.units[0]!, next.units[1]!);

    expect(d).toBeGreaterThan(0.05);
  });

  it("lets mineral haulers pass through unit crowds while delivering", () => {
    const state = collisionState();
    const hauler = makeSimUnit("p1", "blue", "N", { x: -4, y: 0.55, z: 0 });
    const blocker = makeSimUnit("p1", "blue", "N", { x: -4.05, y: 0.55, z: 0 });
    hauler.carriedMinerals = 5;
    hauler.depositStructureTargetId = state.structures[0]!.id;
    state.units = [hauler, blocker];

    const next = new SimulationEngine().step(state, 0).state;
    const d = distanceXZ(next.units[0]!, next.units[1]!);

    expect(d).toBeLessThanOrEqual(0.051);
  });

  it("does not apply idle footprint ejection to active mineral gather pathing", () => {
    const state = collisionState();
    const home = state.structures[0]!;
    const c = structureCenter(home);
    const field = { id: "ore", kind: "minerals" as const, gx: 6, gz: 6, reserve: 500 };
    const unit = makeSimUnit("p1", "blue", "N", { x: c.x, y: 0.55, z: c.z });
    const start = { x: unit.position.x, z: unit.position.z };
    unit.gatherTargetFieldId = field.id;
    state.resourceFields = [field];
    state.units = [unit];

    const next = new SimulationEngine().step(state, 0).state;
    const movedByCleanup = Math.hypot(next.units[0]!.position.x - start.x, next.units[0]!.position.z - start.z);

    expect(movedByCleanup).toBeLessThan(0.001);
  });

  it("does not shove units away from their building combat standoff", () => {
    const state = collisionState();
    const enemy = makeStructure("p2", "red", "home", 28, 20, 4, 4, 500);
    state.structures.push(enemy);
    const a = makeSimUnit("p1", "blue", "P", { x: 8, y: 0.55, z: 0 });
    const b = makeSimUnit("p1", "blue", "P", { x: 8.03, y: 0.55, z: 0 });
    a.attackStructureTargetId = enemy.id;
    b.attackStructureTargetId = enemy.id;
    state.units = [a, b];

    const next = new SimulationEngine().step(state, 0).state;

    expect(distanceXZ(next.units[0]!, next.units[1]!)).toBeLessThan(0.051);
  });

  it("dampens overlap shove for active unit combat", () => {
    const state = collisionState();
    const a = makeSimUnit("p1", "blue", "R", { x: -4, y: 0.55, z: 0 });
    const b = makeSimUnit("p2", "red", "S", { x: -4.05, y: 0.55, z: 0 });
    a.attackTargetId = b.id;
    b.attackTargetId = a.id;
    state.units = [a, b];

    const next = new SimulationEngine().step(state, 0).state;

    expect(distanceXZ(next.units[0]!, next.units[1]!)).toBeLessThan(0.4);
  });
});
