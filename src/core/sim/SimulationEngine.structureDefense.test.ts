import { describe, expect, it } from "vitest";
import { defensiveStructureStats } from "../structureStats";
import {
  createEmptyGameState,
  makeSimUnit,
  makeStructure,
  structureCenter,
  type GameState
} from "../state/GameState";
import { sphereGeodesicDistanceWorldXZ } from "../world/worldSurface";
import { topologyDistanceXZ } from "../world/worldTopology";
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
  it("limits Defense Turret firing to visible spherical line of sight", () => {
    const state = structureDefenseState();
    const turret = makeStructure("p1", "blue", "defense_obelisk", 12, 12, 1, 1, 100);
    const c = structureCenter(turret);
    const stats = defensiveStructureStats("defense_obelisk")!;
    let targetPos: { x: number; z: number } | null = null;
    for (let dx = -stats.fireRange; dx <= stats.fireRange && !targetPos; dx += 0.25) {
      for (let dz = -stats.fireRange; dz <= stats.fireRange; dz += 0.25) {
        const x = c.x + dx;
        const z = c.z + dz;
        const chartDistance = topologyDistanceXZ(state, c.x, c.z, x, z);
        const visibleDistance = sphereGeodesicDistanceWorldXZ(c.x, c.z, x, z);
        if (chartDistance <= stats.fireRange - 0.1 && visibleDistance > stats.fireRange + 0.1) {
          targetPos = { x, z };
          break;
        }
      }
    }
    expect(targetPos).not.toBeNull();
    const target = makeSimUnit("p2", "red", "N", {
      x: targetPos!.x,
      y: c.y,
      z: targetPos!.z
    });
    const targetHp = target.hp;
    state.structures = [turret];
    state.units = [target];

    const result = new SimulationEngine().step(state, 1);

    expect(result.events.some((ev) => ev.type === "damage_dealt")).toBe(false);
    expect(result.state.units[0]!.hp).toBe(targetHp);
  });
});
