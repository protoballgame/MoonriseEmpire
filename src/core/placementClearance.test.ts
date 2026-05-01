import { describe, expect, it } from "vitest";
import { HOME_STRUCTURE_MAX_HP } from "./economyConstants";
import { createMatchOptionsFromClientSetup } from "./match/clientMatch";
import { canPlaceStructureFootprint } from "./placementValidation";
import { createMatchState, makeStructure, type GameState } from "./state/GameState";

function minimalHomeOnlyState(): GameState {
  return {
    matchId: "clearance-t",
    modeId: "real_time",
    tick: 0,
    tickRateHz: 20,
    players: [],
    turn: { number: 1, phase: "planning", planningDeadlineEpochMs: null },
    units: [],
    structures: [
      makeStructure("p1", "blue", "home", 10, 10, 3, 3, HOME_STRUCTURE_MAX_HP, 0, 0)
    ],
    resourceFields: [],
    selections: {},
    structureSelections: {},
    victorPlayerId: null,
    skirmishBoostPassive: null,
    playerExploration: {}
  } as unknown as GameState;
}

describe("structureFootprintViolatesMinimumClearance (via canPlaceStructureFootprint)", () => {
  it("keeps seeded starter Solar Arrays legal", () => {
    const opts = createMatchOptionsFromClientSetup({
      localPlayerId: "p1",
      kind: "player_vs_computer"
    });
    const s = createMatchState("real_time", opts);
    expect(s.structures.filter((x) => x.kind === "power_spire").length).toBeGreaterThanOrEqual(2);
  });

  it("allows a 1×1 flush against the Core edge but rejects overlapping the Core interior", () => {
    const s = minimalHomeOnlyState();
    const home = s.structures[0]!;
    const touchGx = home.gx + home.footW;
    expect(canPlaceStructureFootprint(s, touchGx, home.gz, 1, 1)).toBe(true);
    expect(canPlaceStructureFootprint(s, home.gx, home.gz, 1, 1)).toBe(false);
  });
});
