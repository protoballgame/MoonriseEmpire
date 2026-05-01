import { describe, expect, it } from "vitest";
import { fibonacci } from "../goldenScale";
import { createEmptyGameState, makeSimUnit, type SimStructure } from "../state/GameState";
import {
  constructionBuildRateScale,
  countNeutralWorkersContributingToConstruction,
  distancePointXZToStructureFootprint,
  isNeutralWorkerAdvancingConstruction,
  neutralMinerInConstructionAssistRange,
  tryApplyNeutralMinerResumeGather
} from "./constructionAssist";

const site: SimStructure = {
  id: "t",
  playerId: "p",
  team: "blue",
  kind: "power_spire",
  hp: 10,
  maxHp: 10,
  gx: 10,
  gz: 10,
  footW: 1,
  footD: 1,
  buildRemainingSec: 5,
  buildTotalSec: 5,
  productionQueue: [],
  rallyPoint: null,
  rallyMineFieldId: null,
  homeDefenseCooldownRemainingSec: 0
};

describe("constructionBuildRateScale", () => {
  it("sums Fibonacci F(1)..F(n) with a cap", () => {
    expect(constructionBuildRateScale(1)).toBe(fibonacci(1));
    expect(constructionBuildRateScale(2)).toBe(fibonacci(1) + fibonacci(2));
    expect(constructionBuildRateScale(3)).toBe(fibonacci(1) + fibonacci(2) + fibonacci(3));
  });
});

describe("tryApplyNeutralMinerResumeGather", () => {
  it("restores a miner to its previous field after construction even with partial cargo", () => {
    const state = createEmptyGameState("real_time");
    state.resourceFields = [{ id: "ore-a", kind: "minerals", gx: 6, gz: 6, reserve: 500 }];
    state.structures = [{ ...site, buildRemainingSec: 0 }];
    const unit = makeSimUnit("p", "blue", "N", { x: -30 + 10 * 2.5 + 1.25, y: 0.55, z: -30 + 10 * 2.5 + 1.25 });
    unit.resumeGatherFieldId = "ore-a";
    unit.carriedMinerals = 3;
    state.units = [unit];

    tryApplyNeutralMinerResumeGather(state, unit);

    expect(unit.gatherTargetFieldId).toBe("ore-a");
    expect(unit.resumeGatherFieldId).toBeNull();
    expect(unit.carriedMinerals).toBe(3);
  });
});

describe("constructionAssist range", () => {
  it("distance to footprint is 0 inside pad", () => {
    expect(distancePointXZToStructureFootprint(site, -30 + 10 * 2.5 + 1.25, -30 + 10 * 2.5 + 1.25)).toBe(0);
  });

  it("counts as in assist range only when touching the pad edge", () => {
    const minX = -30 + 10 * 2.5;
    const px = minX - 0.5;
    const pz = -30 + 10 * 2.5 + 1.25;
    expect(neutralMinerInConstructionAssistRange(px, pz, site)).toBe(true);
    expect(neutralMinerInConstructionAssistRange(minX - 1.2, pz, site)).toBe(false);
  });

  it("requires an explicit build job, not generic idle proximity", () => {
    const state = createEmptyGameState("real_time");
    state.structures = [{ ...site }];
    const unit = makeSimUnit("p", "blue", "N", { x: -30 + 10 * 2.5 + 1.25, y: 0.55, z: -30 + 10 * 2.5 + 1.25 });
    state.units = [unit];

    expect(countNeutralWorkersContributingToConstruction(state, state.structures[0]!)).toBe(0);
    unit.buildStructureTargetId = site.id;
    expect(isNeutralWorkerAdvancingConstruction(state, unit)).toBe(true);
    expect(countNeutralWorkersContributingToConstruction(state, state.structures[0]!)).toBe(1);
  });
});
