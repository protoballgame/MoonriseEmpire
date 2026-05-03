import { describe, expect, it, beforeEach } from "vitest";
import { createMatchOptionsFromClientSetup } from "../../core/match/clientMatch";
import {
  createMatchState,
  makeSimUnit,
  makeStructure,
  PLAYER_OPPONENT,
  playerTeamForPlayerId,
  structureCenter,
  type SimUnit
} from "../../core/state/GameState";
import {
  cpuNextStructureKindForTesting,
  initComputerOpponentPersonality,
  resetComputerOpponentState,
  tickComputerOpponent
} from "./computerOpponent";

describe("CPU economy / build rush", () => {
  beforeEach(() => {
    resetComputerOpponentState();
    initComputerOpponentPersonality("cpu-econ-test-match");
  });

  function pvcState() {
    const opts = createMatchOptionsFromClientSetup({
      localPlayerId: "p1",
      kind: "player_vs_computer"
    });
    return createMatchState("real_time", opts);
  }

  function duplicateOpponentSolar(s: ReturnType<typeof pvcState>): void {
    const sol = s.structures.find(
      (x) => x.playerId === PLAYER_OPPONENT && x.kind === "power_spire"
    )!;
    s.structures.push({
      ...sol,
      id: crypto.randomUUID(),
      gx: sol.gx + 6,
      gz: sol.gz
    });
  }

  function addOpponentMiners(s: ReturnType<typeof pvcState>, count: number): void {
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    const pos = { ...s.units.find((u) => u.playerId === PLAYER_OPPONENT)!.position };
    for (let i = 0; i < count; i += 1) {
      s.units.push(makeSimUnit(PLAYER_OPPONENT, team, "N", pos));
    }
  }

  function addOpponentMilitary(s: ReturnType<typeof pvcState>, kinds: SimUnit["kind"][]): void {
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    const pos = { ...s.units.find((u) => u.playerId === PLAYER_OPPONENT)!.position };
    for (const kind of kinds) {
      s.units.push(makeSimUnit(PLAYER_OPPONENT, team, kind, pos));
    }
  }

  function isBarracksKind(kind: string | null): kind is "barracks_r" | "barracks_s" | "barracks_p" {
    return kind === "barracks_r" || kind === "barracks_s" || kind === "barracks_p";
  }

  it("rush builds toward the second Solar Array while on one starter array", () => {
    const s = pvcState();
    expect(cpuNextStructureKindForTesting(s, PLAYER_OPPONENT)).toBe("power_spire");
  });

  it("with two solars and miners below rush target, still wants the third Solar Array", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 4);
    expect(cpuNextStructureKindForTesting(s, PLAYER_OPPONENT)).toBe("power_spire");
  });

  it("with seven miners and two solars, finishes the third Solar Array before barracks", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    expect(cpuNextStructureKindForTesting(s, PLAYER_OPPONENT)).toBe("power_spire");
  });

  it("with seven miners and three solars, chooses a barracks line (7th Neutral pivots)", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    const kind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    expect(kind === "barracks_r" || kind === "barracks_s" || kind === "barracks_p").toBe(true);
  });

  it("prioritizes a second barracks type even if duplicate barracks already exist", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    const firstKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    if (!isBarracksKind(firstKind)) {
      throw new Error(`Expected opening barracks, got ${String(firstKind)}`);
    }

    const home = s.structures.find((st) => st.playerId === PLAYER_OPPONENT && st.kind === "home")!;
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    s.structures.push(
      makeStructure(PLAYER_OPPONENT, team, firstKind, home.gx + 5, home.gz + 5, 2, 2, 100),
      makeStructure(PLAYER_OPPONENT, team, firstKind, home.gx + 8, home.gz + 5, 2, 2, 100)
    );

    const nextKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    expect(isBarracksKind(nextKind)).toBe(true);
    expect(nextKind).not.toBe(firstKind);
  });

  it("pauses soldier production at the five-soldier wave until a second barracks type is placed", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    const firstKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    if (!isBarracksKind(firstKind)) {
      throw new Error(`Expected opening barracks, got ${String(firstKind)}`);
    }

    const home = s.structures.find((st) => st.playerId === PLAYER_OPPONENT && st.kind === "home")!;
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    s.structures.push(makeStructure(PLAYER_OPPONENT, team, firstKind, home.gx + 5, home.gz + 5, 2, 2, 100));
    addOpponentMilitary(s, ["R", "R", "R", "R", "R"]);
    const pl = s.players.find((p) => p.id === PLAYER_OPPONENT)!;
    pl.resources.energy = 999;
    pl.resources.minerals = 999;

    const commands: { type: string; payload?: Record<string, unknown> }[] = [];
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);

    const nextKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    expect(isBarracksKind(nextKind)).toBe(true);
    expect(nextKind).not.toBe(firstKind);

    commands.length = 0;
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 1 / 60);
    expect(commands.some((cmd) => cmd.type === "queue_structure_train")).toBe(false);
  });

  it("does not schedule the random post-rush solar before the second barracks type", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    const firstKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    if (!isBarracksKind(firstKind)) {
      throw new Error(`Expected opening barracks, got ${String(firstKind)}`);
    }

    const home = s.structures.find((st) => st.playerId === PLAYER_OPPONENT && st.kind === "home")!;
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    s.structures.push(makeStructure(PLAYER_OPPONENT, team, firstKind, home.gx + 5, home.gz + 5, 2, 2, 100));

    tickComputerOpponent(s, () => undefined, PLAYER_OPPONENT, 240);

    const nextKind = cpuNextStructureKindForTesting(s, PLAYER_OPPONENT);
    expect(isBarracksKind(nextKind)).toBe(true);
    expect(nextKind).not.toBe(firstKind);
  });

  it("does not queue extra miners while waiting for the first barracks", () => {
    const s = pvcState();
    duplicateOpponentSolar(s);
    duplicateOpponentSolar(s);
    addOpponentMiners(s, 6);
    const pl = s.players.find((p) => p.id === PLAYER_OPPONENT)!;
    pl.resources.energy = 0;
    pl.resources.minerals = 0;
    const commands: { type: string }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type }), PLAYER_OPPONENT, 1 / 60);

    expect(commands.some((cmd) => cmd.type === "queue_structure_train")).toBe(false);
  });

  it("sends the opening CPU attack as a one-soldier probe", () => {
    const s = pvcState();
    addOpponentMilitary(s, ["R"]);
    const commands: { type: string; payload?: Record<string, unknown> }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 13);

    const attackMove = commands.find((cmd) => cmd.type === "attack_move_units");
    expect(attackMove?.payload?.["unitIds"]).toHaveLength(1);
  });

  it("ramps CPU attack waves through the Fibonacci pattern", () => {
    const s = pvcState();
    addOpponentMilitary(s, ["R", "S", "P", "R", "S", "P", "R", "S"]);
    const commands: { type: string; payload?: Record<string, unknown> }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);

    const waveSizes = commands
      .filter((cmd) => cmd.type === "attack_move_units")
      .map((cmd) => (cmd.payload?.["unitIds"] as string[]).length);
    expect(waveSizes).toEqual([1, 2, 3, 5]);
  });

  it("waits for enough idle soldiers before sending the next Fibonacci wave", () => {
    const s = pvcState();
    addOpponentMilitary(s, ["R"]);
    const commands: { type: string; payload?: Record<string, unknown> }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    expect(commands.find((cmd) => cmd.type === "attack_move_units")?.payload?.["unitIds"]).toHaveLength(1);

    commands.length = 0;
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    expect(commands.some((cmd) => cmd.type === "attack_move_units")).toBe(false);
  });

  it("requires mixed unit types once Fibonacci waves reach five soldiers", () => {
    const s = pvcState();
    addOpponentMilitary(s, ["R", "R", "R", "R", "R"]);
    const commands: { type: string; payload?: Record<string, unknown> }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    commands.length = 0;
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);
    expect(commands.some((cmd) => cmd.type === "attack_move_units")).toBe(false);

    addOpponentMilitary(s, ["S"]);
    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 9);

    const attackMove = commands.find((cmd) => cmd.type === "attack_move_units");
    expect(attackMove?.payload?.["unitIds"]).toHaveLength(5);
    const target = attackMove?.payload?.["target"] as { x: number; z: number };
    const humanHome = s.structures.find((st) => st.playerId === "p1" && st.kind === "home")!;
    const homeCenter = structureCenter(humanHome);
    expect(Math.hypot(target.x - homeCenter.x, target.z - homeCenter.z)).toBeGreaterThan(1);
  });

  it("queues multiple soldier types when extra resources and barracks are available", () => {
    const s = pvcState();
    addOpponentMiners(s, 6);
    const home = s.structures.find((st) => st.playerId === PLAYER_OPPONENT && st.kind === "home")!;
    const team = playerTeamForPlayerId(PLAYER_OPPONENT);
    const barracks = [
      makeStructure(PLAYER_OPPONENT, team, "barracks_r", home.gx + 5, home.gz + 5, 2, 2, 100),
      makeStructure(PLAYER_OPPONENT, team, "barracks_s", home.gx + 8, home.gz + 5, 2, 2, 100),
      makeStructure(PLAYER_OPPONENT, team, "barracks_p", home.gx + 11, home.gz + 5, 2, 2, 100)
    ];
    s.structures.push(...barracks);
    const pl = s.players.find((p) => p.id === PLAYER_OPPONENT)!;
    pl.resources.energy = 999;
    pl.resources.minerals = 999;
    const commands: { type: string; payload?: Record<string, unknown> }[] = [];

    tickComputerOpponent(s, (cmd) => commands.push({ type: cmd.type, payload: cmd.payload }), PLAYER_OPPONENT, 1 / 60);

    const queuedIds = commands
      .filter((cmd) => cmd.type === "queue_structure_train")
      .map((cmd) => cmd.payload?.["structureId"]);
    expect(new Set(queuedIds).size).toBeGreaterThanOrEqual(2);
  });
});
