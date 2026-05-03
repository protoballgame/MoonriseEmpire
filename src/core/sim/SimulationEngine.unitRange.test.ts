import { describe, expect, it } from "vitest";
import { createEmptyGameState, makeSimUnit, makeStructure, structureCenter, type GameState } from "../state/GameState";
import { closestXZPointOnFootprintEdgesWrapped } from "../world/worldGrid";
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
  it("lets Neutral units attack Rock units from a visible ranged standoff", () => {
    const state = combatState();
    const attacker = makeSimUnit("p1", "blue", "N", { x: 0, y: 0.55, z: 0 });
    let targetPos: { x: number; z: number } | null = null;

    for (let ax = -58; ax <= 58 && !targetPos; ax += 2) {
      for (let az = -58; az <= 58 && !targetPos; az += 2) {
        attacker.position.x = ax;
        attacker.position.z = az;
        for (let dx = -6; dx <= 6 && !targetPos; dx += 0.1) {
          for (let dz = -6; dz <= 6; dz += 0.1) {
            const x = ax + dx;
            const z = az + dz;
            if (x < -60 || x > 60 || z < -60 || z > 60) continue;
            const chartDistance = topologyDistanceXZ(state, ax, az, x, z);
            const visibleDistance = sphereGeodesicDistanceWorldXZ(ax, az, x, z);
            if (
              chartDistance > 1.7 &&
              visibleDistance > 2.55 &&
              visibleDistance < attacker.attackRange - 0.05
            ) {
              targetPos = { x, z };
              break;
            }
          }
        }
      }
    }

    expect(targetPos).not.toBeNull();
    const target = makeSimUnit("p2", "red", "R", { x: targetPos!.x, y: 0.55, z: targetPos!.z });
    const targetHp = target.hp;
    const attackerPos = { ...attacker.position };
    attacker.attackTargetId = target.id;
    state.units = [attacker, target];

    const result = new SimulationEngine().step(state, 0);

    expect(result.events.some((ev) => ev.type === "damage_dealt")).toBe(true);
    expect(result.state.units.find((u) => u.id === target.id)?.hp).toBeLessThan(targetHp);
    expect(result.state.units.find((u) => u.id === attacker.id)?.position).toEqual(attackerPos);
  });

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

  it("lets ranged units attack structures from footprint edge range instead of crowding the center", () => {
    const state = combatState();
    const attacker = makeSimUnit("p1", "blue", "P", { x: 0, y: 0.55, z: 0 });
    const target = makeStructure("p2", "red", "home", 10, 10, 4, 4, 500);
    const center = structureCenter(target);
    let attackerPos: { x: number; z: number } | null = null;

    for (let x = -58; x <= 58 && !attackerPos; x += 0.25) {
      for (let z = -58; z <= 58; z += 0.25) {
        const edge = closestXZPointOnFootprintEdgesWrapped(x, z, target.gx, target.gz, target.footW, target.footD);
        const edgeDistance = sphereGeodesicDistanceWorldXZ(x, z, edge.x, edge.z);
        const centerDistance = sphereGeodesicDistanceWorldXZ(x, z, center.x, center.z);
        if (edgeDistance < attacker.attackRange - 0.1 && centerDistance > attacker.attackRange + 1) {
          attackerPos = { x, z };
          break;
        }
      }
    }

    expect(attackerPos).not.toBeNull();
    attacker.position.x = attackerPos!.x;
    attacker.position.z = attackerPos!.z;
    const beforePos = { ...attacker.position };
    attacker.attackStructureTargetId = target.id;
    state.units = [attacker];
    state.structures = [target];

    const result = new SimulationEngine().step(state, 0);

    expect(result.events.some((ev) => ev.type === "damage_dealt")).toBe(true);
    expect(result.state.structures.find((s) => s.id === target.id)?.hp).toBeLessThan(target.hp);
    expect(result.state.units.find((u) => u.id === attacker.id)?.position).toEqual(beforePos);
  });

  it("chases structure combat targets toward the nearest footprint edge instead of the center", () => {
    const state = combatState();
    const attacker = makeSimUnit("p1", "blue", "P", { x: 0, y: 0.55, z: 0 });
    attacker.speed = 12;
    const target = makeStructure("p2", "red", "home", 12, 12, 4, 4, 500);
    const center = structureCenter(target);
    let attackerPos: { x: number; z: number } | null = null;

    for (let x = -58; x <= 58 && !attackerPos; x += 0.25) {
      for (let z = -58; z <= 58; z += 0.25) {
        const edge = closestXZPointOnFootprintEdgesWrapped(x, z, target.gx, target.gz, target.footW, target.footD);
        const edgeDistance = sphereGeodesicDistanceWorldXZ(x, z, edge.x, edge.z);
        if (
          Math.abs(edge.z - z) < 0.03 &&
          Math.abs(center.z - z) > 1.2 &&
          edgeDistance > attacker.attackRange + 1.2 &&
          edgeDistance < attacker.attackRange + 2.8
        ) {
          attackerPos = { x, z };
          break;
        }
      }
    }

    expect(attackerPos).not.toBeNull();
    attacker.position.x = attackerPos!.x;
    attacker.position.z = attackerPos!.z;
    const beforeZ = attacker.position.z;
    attacker.attackStructureTargetId = target.id;
    state.units = [attacker];
    state.structures = [target];

    const result = new SimulationEngine().step(state, 0.12);
    const moved = result.state.units.find((u) => u.id === attacker.id)!;

    expect(Math.abs(moved.position.z - beforeZ)).toBeLessThan(0.08);
  });
});
