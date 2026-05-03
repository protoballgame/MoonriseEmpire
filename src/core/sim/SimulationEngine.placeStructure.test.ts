import { describe, expect, it } from "vitest";
import { createGameCommand } from "../commands/GameCommand";
import {
  COMMAND_CORE_BUILD_TIME_SEC,
  COMMAND_CORE_PLACE_COST_ENERGY,
  COMMAND_CORE_PLACE_COST_MINERALS
} from "../economyConstants";
import { canPlaceStructureForPlayer } from "../placementValidation";
import { createEmptyGameState, createMatchState, makeSimUnit, makeStructure, PLAYER_HUMAN, structureCenter } from "../state/GameState";
import { footprintForStructureKind } from "../structureFootprint";
import { advanceExploration, allocateExplorationMaps } from "../world/explorationGrid";
import { SimulationEngine } from "./SimulationEngine";

describe("SimulationEngine place_structure", () => {
  it("lets Neutral builders place a Command Core expansion with explicit cost and build time", () => {
    const state = createMatchState("real_time", { economyBoostPlayerId: null });
    const player = state.players.find((p) => p.id === PLAYER_HUMAN)!;
    player.resources.energy = COMMAND_CORE_PLACE_COST_ENERGY;
    player.resources.minerals = COMMAND_CORE_PLACE_COST_MINERALS;
    advanceExploration(state);
    allocateExplorationMaps(state);
    state.playerExploration[PLAYER_HUMAN]?.fill(1);

    const home = state.structures.find((s) => s.playerId === PLAYER_HUMAN && s.kind === "home")!;
    const homeCenter = structureCenter(home);
    const { footW, footD } = footprintForStructureKind("home");
    let site: { gx: number; gz: number } | null = null;
    for (let r = 4; r <= 10 && !site; r += 1) {
      for (let dx = -r; dx <= r && !site; dx += 1) {
        for (let dz = -r; dz <= r && !site; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const gx = home.gx + dx;
          const gz = home.gz + dz;
          if (canPlaceStructureForPlayer(state, PLAYER_HUMAN, gx, gz, footW, footD, "home")) {
            site = { gx, gz };
          }
        }
      }
    }
    expect(site).not.toBeNull();

    const builder = state.units.find((u) => u.playerId === PLAYER_HUMAN && u.kind === "N")!;
    const beforeHomeCount = state.structures.filter((s) => s.playerId === PLAYER_HUMAN && s.kind === "home").length;
    const engine = new SimulationEngine();
    engine.enqueue(
      createGameCommand(PLAYER_HUMAN, "place_structure", {
        kind: "home",
        gx: site!.gx,
        gz: site!.gz,
        builderUnitId: builder.id
      })
    );

    const next = engine.step(state, 0).state;
    const homes = next.structures.filter((s) => s.playerId === PLAYER_HUMAN && s.kind === "home");
    const placed = homes.find((s) => Math.abs(structureCenter(s).x - homeCenter.x) > 0.01 || s.gx !== home.gx);
    const nextPlayer = next.players.find((p) => p.id === PLAYER_HUMAN)!;

    expect(homes.length).toBe(beforeHomeCount + 1);
    expect(placed?.buildRemainingSec).toBe(COMMAND_CORE_BUILD_TIME_SEC);
    expect(placed?.buildTotalSec).toBe(COMMAND_CORE_BUILD_TIME_SEC);
    expect(nextPlayer.resources.energy).toBe(0);
    expect(nextPlayer.resources.minerals).toBe(0);
  });

  it("returns a miner to its previous mineral field when its build job is complete", () => {
    const state = createEmptyGameState("real_time");
    state.players = [
      {
        id: PLAYER_HUMAN,
        civ: "khemetic",
        resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
      }
    ];
    state.resourceFields = [{ id: "ore-a", kind: "minerals", gx: 6, gz: 6, reserve: 500 }];
    const site = makeStructure(PLAYER_HUMAN, "blue", "power_spire", 10, 10, 1, 1, 100, 0, 5);
    const builder = makeSimUnit(PLAYER_HUMAN, "blue", "N", structureCenter(site));
    builder.buildStructureTargetId = site.id;
    builder.resumeGatherFieldId = "ore-a";
    builder.carriedMinerals = 3;
    state.structures = [site];
    state.units = [builder];

    const next = new SimulationEngine().step(state, 0).state;
    const nextBuilder = next.units[0]!;

    expect(nextBuilder.buildStructureTargetId).toBeNull();
    expect(nextBuilder.gatherTargetFieldId).toBe("ore-a");
    expect(nextBuilder.resumeGatherFieldId).toBeNull();
    expect(nextBuilder.carriedMinerals).toBe(3);
  });

  it("reassigns a Neutral to finish an interrupted building when moved back near the site", () => {
    const state = createEmptyGameState("real_time");
    state.players = [
      {
        id: PLAYER_HUMAN,
        civ: "khemetic",
        resources: { biomass: 0, minerals: 0, energy: 0, obsidian: 0, nexus: 0 }
      }
    ];
    const site = makeStructure(PLAYER_HUMAN, "blue", "power_spire", 10, 10, 1, 1, 100, 5, 5);
    const center = structureCenter(site);
    const builder = makeSimUnit(PLAYER_HUMAN, "blue", "N", center);
    state.structures = [site];
    state.units = [builder];
    state.selections[PLAYER_HUMAN] = [builder.id];

    const engine = new SimulationEngine();
    engine.enqueue(
      createGameCommand(PLAYER_HUMAN, "move_units", {
        target: { x: center.x, y: center.y, z: center.z }
      })
    );

    const next = engine.step(state, 1).state;
    const nextBuilder = next.units[0]!;

    expect(nextBuilder.buildStructureTargetId).toBe(site.id);
    expect(next.structures[0]!.buildRemainingSec).toBeLessThan(site.buildRemainingSec);
  });
});
