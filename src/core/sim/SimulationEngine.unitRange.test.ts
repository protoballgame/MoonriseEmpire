import { describe, expect, it } from "vitest";
import { createEmptyGameState, makeSimUnit, type GameState } from "../state/GameState";
import { sphereGeodesicDistanceWorldXZ } from "../world/worldSurface";
import { topologyDistanceXZ } from "../world/worldTopology";
import { SimulationEngine } from "./SimulationEngine";

function combatState(): GameState {
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

describe("SimulationEngine unit attack range", () => {
  it("does not let ranged units shoot past spherical line-of-sight distance", () => {
    const state = combatState();
    const attacker = makeSimUnit("p1", "blue", "P", { x: 0, y: 0.55, z: 0 });
    let targetPos: { x: number; z: number } | null = null;

    for (let ax = -48; ax <= 48 && !targetPos; ax += 6) {
      for (let az = -48; az <= 48 && !targetPos; az += 6) {
        attacker.position.x = ax;
        attacker.position.z = az;
        for (let dx = -attacker.attackRange; dx <= attacker.attackRange && !targetPos; dx += 0.25) {
          for (let dz = -attacker.attackRange; dz <= attacker.attackRange; dz += 0.25) {
            const x = ax + dx;
            const z = az + dz;
            const chartDistance = topologyDistanceXZ(state, ax, az, x, z);
            const visibleDistance = sphereGeodesicDistanceWorldXZ(ax, az, x, z);
            if (
              chartDistance <= attacker.attackRange - 0.1 &&
              visibleDistance > attacker.attackRange + 0.1 &&
              visibleDistance <= attacker.visionRange
            ) {
              targetPos = { x, z };
              break;
            }
          }
        }
      }
    }

    expect(targetPos).not.toBeNull();
    const target = makeSimUnit("p2", "red", "N", { x: targetPos!.x, y: 0.55, z: targetPos!.z });
    const targetHp = target.hp;
    attacker.attackTargetId = target.id;
    state.units = [attacker, target];

    const result = new SimulationEngine().step(state, 0);

    expect(result.events.some((ev) => ev.type === "damage_dealt")).toBe(false);
    expect(result.state.units.find((u) => u.id === target.id)?.hp).toBe(targetHp);
  });
});
