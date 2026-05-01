import { describe, expect, it } from "vitest";
import { defensiveStructureStats } from "../structureStats";
import {
  createEmptyGameState,
  makeSimUnit,
  makeStructure,
  structureCenter,
  type GameState
} from "../state/GameState";
import { SimulationEngine } from "./SimulationEngine";

function structureDefenseState(): GameState {
  const state = createEmptyGameState("real_time");
  state.players = [
    {
      id: "p1",
      civ: "khemetic",
      resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
    },
    {
      id: "p2",
      civ: "yokai",
      resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
    }
  ];
  return state;
}

describe("SimulationEngine structure defense", () => {
  it("limits Defense Turret firing to 90% of center-based line of sight", () => {
    const state = structureDefenseState();
    const turret = makeStructure("p1", "blue", "defense_obelisk", 12, 12, 1, 1, 100);
    const c = structureCenter(turret);
    const stats = defensiveStructureStats("defense_obelisk")!;
    const target = makeSimUnit("p2", "red", "N", {
      x: c.x + stats.fireRange + 0.05,
      y: c.y,
      z: c.z
    });
    const targetHp = target.hp;
    state.structures = [turret];
    state.units = [target];

    const result = new SimulationEngine().step(state, 1);

    expect(result.events.some((ev) => ev.type === "damage_dealt")).toBe(false);
    expect(result.state.units[0]!.hp).toBe(targetHp);
  });
});
