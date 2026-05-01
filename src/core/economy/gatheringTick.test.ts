import { describe, expect, it } from "vitest";
import { resourceFieldCenterWorld } from "./resourceFieldGeometry";
import { processGatheringForUnit } from "./gatheringTick";
import { createEmptyGameState, makeSimUnit, type GameState } from "../state/GameState";
import { RESOURCE_GATHER_RANGE } from "../economyConstants";
import { topologyDistanceXZ } from "../world/worldTopology";

describe("processGatheringForUnit", () => {
  it("retargets to another mineral in vision when the current node is depleted", () => {
    const live = { id: "mine-live", kind: "minerals" as const, gx: 6, gz: 6, reserve: 500 };
    const dead = { id: "mine-dead", kind: "minerals" as const, gx: 5, gz: 6, reserve: 0 };
    const c = resourceFieldCenterWorld(live);
    const unit = makeSimUnit("p1", "blue", "N", { x: c.x, y: 0.55, z: c.z });
    unit.gatherTargetFieldId = dead.id;

    const base = createEmptyGameState("real_time");
    const state: GameState = {
      ...base,
      resourceFields: [dead, live],
      units: [unit]
    };

    const deadIds = new Set<string>();
    processGatheringForUnit(unit, state, 0.016, deadIds);
    expect(unit.gatherTargetFieldId).toBe(live.id);
  });

  it("walks a far miner into gather range across the wrapped moon chart", () => {
    const field = { id: "mine-wrap", kind: "minerals" as const, gx: 0, gz: 12, reserve: 500 };
    const center = resourceFieldCenterWorld(field);
    const unit = makeSimUnit("p1", "blue", "N", { x: 29.2, y: 0.55, z: center.z });
    unit.gatherTargetFieldId = field.id;

    const base = createEmptyGameState("real_time");
    const state: GameState = {
      ...base,
      resourceFields: [field],
      units: [unit]
    };

    const deadIds = new Set<string>();
    for (let i = 0; i < 1800; i += 1) {
      processGatheringForUnit(unit, state, 0.05, deadIds);
      if (unit.carriedMinerals > 0) break;
    }

    expect(unit.carriedMinerals).toBeGreaterThan(0);
    expect(topologyDistanceXZ(state, unit.position.x, unit.position.z, center.x, center.z)).toBeLessThanOrEqual(
      RESOURCE_GATHER_RANGE
    );
  });

  it("moves a miner directly toward a distant clicked mineral instead of stalling mid-route", () => {
    const field = { id: "mine-far", kind: "minerals" as const, gx: 20, gz: 15, reserve: 500 };
    const center = resourceFieldCenterWorld(field);
    const unit = makeSimUnit("p1", "blue", "N", { x: -18, y: 0.55, z: -12 });
    unit.gatherTargetFieldId = field.id;

    const base = createEmptyGameState("real_time");
    const state: GameState = {
      ...base,
      resourceFields: [field],
      units: [unit]
    };

    const deadIds = new Set<string>();
    let previousDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 1200; i += 1) {
      processGatheringForUnit(unit, state, 0.05, deadIds);
      const distance = topologyDistanceXZ(state, unit.position.x, unit.position.z, center.x, center.z);
      expect(distance).toBeLessThanOrEqual(previousDistance + 0.08);
      previousDistance = distance;
      if (distance <= RESOURCE_GATHER_RANGE) break;
    }

    expect(previousDistance).toBeLessThanOrEqual(RESOURCE_GATHER_RANGE);
  });
});
