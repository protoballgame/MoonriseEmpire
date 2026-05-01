import { describe, expect, it } from "vitest";
import { POWER_SPIRE_ENERGY_PER_SEC } from "../economyConstants";
import { createMatchOptionsFromClientSetup } from "../match/clientMatch";
import { createMatchState, PLAYER_HUMAN, PLAYER_OPPONENT } from "../state/GameState";
import { runDefaultResourceEconomyWorldTick } from "./economyWorldTick";
import { structurePassiveYieldPerSec } from "./structureResourceYield";

describe("runDefaultResourceEconomyWorldTick", () => {
  it("Command Core grants no passive; seeded Solar Array adds energy", () => {
    const s = createMatchState("real_time", { economyBoostPlayerId: null });
    const h = s.players.find((p) => p.id === PLAYER_HUMAN)!;
    const he0 = h.resources.energy;
    const hm0 = h.resources.minerals;
    const solarCount = s.structures.filter(
      (x) => x.playerId === PLAYER_HUMAN && x.kind === "power_spire" && x.hp > 0
    ).length;
    expect(solarCount).toBe(1);
    runDefaultResourceEconomyWorldTick(s, 1);
    expect(h.resources.minerals).toBe(hm0);
    expect(h.resources.energy - he0).toBeCloseTo(POWER_SPIRE_ENERGY_PER_SEC, 10);
  });

  it("applies opponent seeded Solar Array passive energy (solo bootstrapping)", () => {
    const s = createMatchState("real_time", { economyBoostPlayerId: PLAYER_OPPONENT });
    const opp = s.players.find((p) => p.id === PLAYER_OPPONENT)!;
    const e0 = opp.resources.energy;
    const minerals0 = opp.resources.minerals;
    runDefaultResourceEconomyWorldTick(s, 1);
    const de = opp.resources.energy - e0;
    const dm = opp.resources.minerals - minerals0;
    const oppSolar = s.structures.filter(
      (x) => x.playerId === PLAYER_OPPONENT && x.kind === "power_spire" && x.hp > 0
    ).length;
    expect(oppSolar).toBeGreaterThanOrEqual(1);
    expect(de).toBeCloseTo(POWER_SPIRE_ENERGY_PER_SEC * oppSolar, 8);
    expect(dm).toBe(0);
  });

  it("PvP-style match skips economy boost structures on both seats", () => {
    const s = createMatchState("real_time", { economyBoostPlayerId: null });
    const byPlayer = (pid: string) => s.structures.filter((x) => x.playerId === pid);
    for (const pid of [PLAYER_HUMAN, PLAYER_OPPONENT]) {
      const kinds = byPlayer(pid)
        .map((x) => x.kind)
        .sort()
        .join(",");
      expect(kinds).toBe("home,power_spire");
    }
  });

  it("PvC match options no longer grant free CPU structures or passive yield cheats", () => {
    const opts = createMatchOptionsFromClientSetup({
      localPlayerId: PLAYER_HUMAN,
      kind: "player_vs_computer"
    });
    const s = createMatchState("real_time", opts);
    expect(s.skirmishBoostPassive).toBeNull();
    const oppStructs = s.structures.filter((x) => x.playerId === PLAYER_OPPONENT);
    expect(oppStructs.every((x) => x.kind === "home" || x.kind === "power_spire")).toBe(true);
    expect(oppStructs.filter((x) => x.kind === "power_spire").length).toBe(1);
    const opp = s.players.find((p) => p.id === PLAYER_OPPONENT)!;
    const e0 = opp.resources.energy;
    const m0 = opp.resources.minerals;
    runDefaultResourceEconomyWorldTick(s, 1);
    expect(opp.resources.energy - e0).toBeCloseTo(structurePassiveYieldPerSec("power_spire").energy, 10);
    expect(opp.resources.minerals).toBe(m0);
  });
});
