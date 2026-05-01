import type { PlayerState } from "../types";
import type { MilitaryKind } from "../militaryKinds";
import type { PlaceableStructureKind } from "../commands/GameCommand";
import { structureFootprintOverlapsResourceField } from "../economy/fieldOverlap";
import type { SimResourceField } from "../economy/resourceFieldTypes";
import { seedResourceFields } from "../economy/seedResourceFields";
import {
  BARRACKS_STRUCTURE_MAX_HP,
  GENERATOR_STRUCTURE_MAX_HP,
  HOME_STRUCTURE_MAX_HP,
  STARTING_ENERGY,
  STARTING_MINERALS
} from "../economyConstants";
import { getUnitMaxHp, unitCombatFields } from "../balance";
import { tuning } from "../runtimeTuning";
import { footprintForStructureKind } from "../structureFootprint";
import { pickOpposedHomeFootprints } from "../world/matchLayout";
import {
  footprintCenterWorld,
  footprintInWorldBounds,
  footprintsOverlap,
  GRID_CELL_SIZE,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z
} from "../world/worldGrid";
import { sphereCraterBlockedAtFlatXZ, spherePolarCapBlocksFlatXZ } from "../world/sphereTerrain";
import { randomMatchId } from "../randomId";

/**
 * Extra grid cells inflated around each **existing** footprint when checking a new placement.
 * `0` allows edge-aligned bases; the sim still nudges units with a small footprint collision margin.
 */
export const STRUCTURE_FOOTPRINT_PADDING_CELLS = 0;

export type MatchModeId = "real_time" | "turn_based";

/** This shipping build is moon / sphere only (`sphereTerrain.ts` + charted sim XZ). */
export type TerrainId = "sphere";

export type TeamId = "blue" | "red";

export type StructureKind =
  | "home"
  | "barracks_r"
  | "barracks_s"
  | "barracks_p"
  | "barracks_n"
  | "power_spire"
  | "defense_obelisk"
  | "mineral_depot";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ProductionOrder {
  kind: MilitaryKind;
  remainingSec: number;
}

export interface PendingStructurePlacement {
  kind: PlaceableStructureKind;
  gx: number;
  gz: number;
}

export interface SimUnit {
  id: string;
  playerId: string;
  team: TeamId;
  kind: MilitaryKind;
  hp: number;
  position: Vec3;
  moveTarget: Vec3 | null;
  attackMoveTarget: Vec3 | null;
  attackTargetId: string | null;
  attackStructureTargetId: string | null;
  /** When set, unit walks to this neutral field and gathers until depleted, Stop, combat, or a new order. */
  gatherTargetFieldId: string | null;
  /**
   * Neutral miners: after `place_structure` interrupted gathering, restore this field once idle and
   * not needed at a build site.
   */
  resumeGatherFieldId: string | null;
  /** Shift+move waypoints (max 8 segments including current leg — see `queue_move_waypoint`). */
  moveWaypointQueue: Vec3[];
  /** Neutral miners only: ore carried until deposited at Command Core or Mineral Depository. */
  carriedMinerals: number;
  /** When set, **N** units walk here to unload `carriedMinerals`. */
  depositStructureTargetId: string | null;
  /** Neutral miners only: active construction job. Keeps builders from being treated as idle combatants. */
  buildStructureTargetId: string | null;
  /**
   * Neutral miners only: planned construction clicked in unexplored fog. The miner walks to the
   * footprint center, then the sim re-checks real placement blockers and creates/aborts the site.
   */
  pendingStructurePlacement: PendingStructurePlacement | null;
  /**
   * Neutral miners only: seconds accumulated toward the next discrete mineral pulse at the node.
   * Reset while walking into range; avoids per-frame micro-gains and UI spam.
   */
  gatherMineralPulseAccumSec: number;
  speed: number;
  attackRange: number;
  visionRange: number;
  attackDamage: number;
  attackCooldownSeconds: number;
  cooldownRemainingSeconds: number;
  attackClass: "melee" | "ranged";
  /**
   * Cumulative damage taken from each enemy **unit** id (this match). Used when melee is stuck behind
   * friendlies to retarget toward someone who is actually damaging this unit.
   */
  damageReceivedFromUnitId: Record<string, number>;
  /**
   * Seconds spent chasing the current attack target while out of melee range without closing distance.
   */
  stuckChasingAttackTargetSec: number;
  /** Previous XZ distance to current attack target (stuck detection). */
  chaseDistToAttackTargetPrev: number | null;
}

export interface SimStructure {
  id: string;
  playerId: string;
  team: TeamId;
  kind: StructureKind;
  hp: number;
  maxHp: number;
  /**
   * Remaining construction time (seconds) before the structure becomes functional.
   * Seeded structures start complete (0).
   */
  buildRemainingSec: number;
  buildTotalSec: number;
  gx: number;
  gz: number;
  footW: number;
  footD: number;
  /** Paid-up orders; front item counts down each tick, then a unit spawns. */
  productionQueue: ProductionOrder[];
  /** Training structures: where new units move after spawning; null uses default idle at exit. */
  rallyPoint: Vec3 | null;
  /** If set, trained **N** units auto-gather this mineral field (rally was placed on the node). */
  rallyMineFieldId: string | null;
  /**
   * Command Core point-defense battery only: seconds until the next ranged volley.
   * Other structure kinds leave this at 0.
   */
  homeDefenseCooldownRemainingSec: number;
}

export interface TurnState {
  number: number;
  phase: "planning" | "resolving";
  planningDeadlineEpochMs: number | null;
}

export interface GameState {
  matchId: string;
  modeId: MatchModeId;
  tick: number;
  tickRateHz: number;
  players: PlayerState[];
  turn: TurnState;
  units: SimUnit[];
  structures: SimStructure[];
  /** Neutral gatherable nodes (energy / minerals). */
  resourceFields: SimResourceField[];
  selections: Record<string, string[]>;
  structureSelections: Record<string, string[]>;
  victorPlayerId: string | null;
  /**
   * PvC only: passive yields from this player's `power_spire` are multiplied by `scale`
   * (keeps train spending from being infinitely outpaced by generators).
   */
  skirmishBoostPassive: { playerId: string; scale: number } | null;
  /**
   * Authoritative explored cells per player (same grid as client fog). Used for structure placement rules.
   */
  playerExploration: Record<string, Uint8Array>;
  /** World presentation + obstacle field; gameplay coordinates stay planar XZ. */
  terrain: TerrainId;
}

/** Default skirmish seat A (northwest Command Core, blue). Not inherently “human” — see `ClientMatchSetup.localPlayerId`. */
export const PLAYER_HUMAN = "p1";
/** Default skirmish seat B (southeast Command Core, red). */
export const PLAYER_OPPONENT = "p2";

/** Options when building the initial `GameState` (passed from `ClientMatchSetup` via `ModeFactory`). */
export interface CreateMatchOptions {
  /**
   * Pre-place the generator + barracks cluster for this player id (vs-AI helper).
   * Omit → legacy default `PLAYER_OPPONENT`. Explicit `null` → skip (fair PvP start).
   */
  economyBoostPlayerId?: string | null;
  /**
   * When set with a non-null economy boost player, that seat's Solar Array passive rate is
   * multiplied by this (use Fibonacci ratios, e.g. F(6)/F(7), for PvC economy vs train cadence).
   */
  skirmishBoostPassiveYieldScale?: number;
  terrain?: TerrainId;
}

/** Skirmish structure boost is opt-in only (`economyBoostPlayerId` set to a seat). Default: symmetric start like PvP. */
export function resolveEconomyBoostPlayerId(options?: CreateMatchOptions): string | null {
  if (options?.economyBoostPlayerId === undefined) return null;
  return options.economyBoostPlayerId;
}

/** In a two-player roster, the winner when a Command Core is destroyed. */
export function winnerWhenCommandCoreDestroyed(state: GameState, destroyedHomeOwnerId: string): string | null {
  if (state.players.length !== 2) return null;
  const hasRemainingCore = state.structures.some(
    (s) =>
      s.playerId === destroyedHomeOwnerId &&
      s.kind === "home" &&
      s.hp > 0 &&
      isStructureBuilt(s)
  );
  if (hasRemainingCore) return null;
  const other = state.players.find((p) => p.id !== destroyedHomeOwnerId);
  return other?.id ?? null;
}

export function structureCenter(s: SimStructure): Vec3 {
  return footprintCenterWorld(s.gx, s.gz, s.footW, s.footD);
}

export function structureProducesKind(s: SimStructure): MilitaryKind | null {
  if (s.kind === "home") return "N";
  if (s.kind === "barracks_r") return "R";
  if (s.kind === "barracks_s") return "S";
  if (s.kind === "barracks_p") return "P";
  return null;
}

/** True if the structure has finished construction. */
export function isStructureBuilt(s: SimStructure): boolean {
  return s.buildRemainingSec <= 0;
}

export function playerTeamForPlayerId(playerId: string): TeamId {
  return playerId === PLAYER_OPPONENT ? "red" : "blue";
}

/**
 * True if this footprint overlaps another structure’s grid rect (padding expands existing buildings only).
 * With {@link STRUCTURE_FOOTPRINT_PADDING_CELLS} = 0, edge-aligned bases are allowed; overlap is still rejected.
 */
export function structureFootprintViolatesMinimumClearance(
  state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number,
  paddingCells: number = STRUCTURE_FOOTPRINT_PADDING_CELLS
): boolean {
  const p = paddingCells;
  for (const s of state.structures) {
    if (s.hp <= 0) continue;
    const egx = s.gx - p;
    const egz = s.gz - p;
    const ew = s.footW + 2 * p;
    const ed = s.footD + 2 * p;
    if (footprintsOverlap(gx, gz, footW, footD, egx, egz, ew, ed)) return true;
  }
  return false;
}

export function createEmptyGameState(modeId: MatchModeId): GameState {
  return {
    matchId: randomMatchId(),
    modeId,
    tick: 0,
    tickRateHz: 20,
    players: [],
    turn: {
      number: 1,
      phase: "planning",
      planningDeadlineEpochMs: null
    },
    units: [],
    structures: [],
    resourceFields: [],
    selections: {},
    structureSelections: {},
    victorPlayerId: null,
    skirmishBoostPassive: null,
    playerExploration: {},
    terrain: "sphere"
  };
}

export function createMatchState(modeId: MatchModeId, options?: CreateMatchOptions): GameState {
  const state = createEmptyGameState(modeId);
  state.terrain = options?.terrain ?? "sphere";
  const res = {
    biomass: 0,
    obsidian: 0,
    nexus: 0,
    energy: STARTING_ENERGY,
    minerals: STARTING_MINERALS
  };
  state.players = [
    { id: PLAYER_HUMAN, civ: "khemetic", resources: { ...res } },
    { id: PLAYER_OPPONENT, civ: "yokai", resources: { ...res } }
  ];
  state.selections[PLAYER_HUMAN] = [];
  state.selections[PLAYER_OPPONENT] = [];
  state.structureSelections[PLAYER_HUMAN] = [];
  state.structureSelections[PLAYER_OPPONENT] = [];

  seedStructures(state);
  seedStartingUnits(state);
  seedResourceFields(state);
  const boostFor = resolveEconomyBoostPlayerId(options);
  if (boostFor !== null) {
    seedSkirmishEconomyBoost(state, boostFor);
  }

  const passiveScale = options?.skirmishBoostPassiveYieldScale;
  if (boostFor !== null && passiveScale !== undefined) {
    state.skirmishBoostPassive = { playerId: boostFor, scale: passiveScale };
  }

  return state;
}

export function maxHpForPlacedStructure(kind: StructureKind): number {
  switch (kind) {
    case "home":
      return HOME_STRUCTURE_MAX_HP;
    case "defense_obelisk":
      return tuning.units.N.hp * 4;
    case "power_spire":
      return GENERATOR_STRUCTURE_MAX_HP;
    default:
      return BARRACKS_STRUCTURE_MAX_HP;
  }
}

function sphereFootprintBlocks(gx: number, gz: number, footW: number, footD: number): boolean {
  for (let i = 0; i < footW; i += 1) {
    for (let j = 0; j < footD; j += 1) {
      const x = GRID_ORIGIN_X + (gx + i + 0.5) * GRID_CELL_SIZE;
      const z = GRID_ORIGIN_Z + (gz + j + 0.5) * GRID_CELL_SIZE;
      if (spherePolarCapBlocksFlatXZ(x, z)) return true;
      if (sphereCraterBlockedAtFlatXZ(x, z)) return true;
    }
  }
  return false;
}

function seedStructures(state: GameState): void {
  const [a, b] = pickOpposedHomeFootprints(state.matchId, state.terrain);
  type Hemi = "east" | "west";
  const homeIsValidAt = (
    gx: number,
    gz: number,
    avoid: { gx: number; gz: number } | undefined,
    hemi: Hemi | null
  ): boolean => {
    if (!footprintInWorldBounds(gx, gz, 3, 3)) return false;
    if (sphereFootprintBlocks(gx, gz, 3, 3)) return false;
    if (avoid && footprintsOverlap(gx, gz, 3, 3, avoid.gx, avoid.gz, 3, 3)) return false;
    if (hemi) {
      const cx = footprintCenterWorld(gx, gz, 3, 3).x;
      if (hemi === "east" && cx <= 2) return false;
      if (hemi === "west" && cx >= -2) return false;
    }
    return true;
  };
  const pickSafe = (
    gx: number,
    gz: number,
    avoid: { gx: number; gz: number } | undefined,
    hemi: Hemi | null
  ): { gx: number; gz: number } => {
    if (homeIsValidAt(gx, gz, avoid, hemi)) return { gx, gz };

    // First pass: expanding ring search around requested placement.
    for (let r = 1; r <= 26; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (homeIsValidAt(nx, nz, avoid, hemi)) return { gx: nx, gz: nz };
        }
      }
    }

    // Fallback: global nearest valid footprint in world bounds.
    let best: { gx: number; gz: number; d2: number } | null = null;
    for (let nx = -80; nx <= 80; nx += 1) {
      for (let nz = -80; nz <= 80; nz += 1) {
        if (!homeIsValidAt(nx, nz, avoid, hemi)) continue;
        const d2 = (nx - gx) * (nx - gx) + (nz - gz) * (nz - gz);
        if (!best || d2 < best.d2) best = { gx: nx, gz: nz, d2 };
      }
    }
    if (best) return { gx: best.gx, gz: best.gz };
    return { gx, gz };
  };
  const aa = pickSafe(a.gx, a.gz, undefined, "east");
  const bb = pickSafe(b.gx, b.gz, aa, "west");
  state.structures.push(
    makeStructure(PLAYER_HUMAN, "blue", "home", aa.gx, aa.gz, 3, 3, HOME_STRUCTURE_MAX_HP),
    makeStructure(PLAYER_OPPONENT, "red", "home", bb.gx, bb.gz, 3, 3, HOME_STRUCTURE_MAX_HP)
  );
}

/** One neutral-line (N) miner per player beside their Command Core. */
function seedStartingUnits(state: GameState): void {
  for (const pl of state.players) {
    const home = state.structures.find((s) => s.playerId === pl.id && s.kind === "home");
    if (!home) continue;
    const team = playerTeamForPlayerId(pl.id);
    state.units.push(makeSimUnit(pl.id, team, "N", spawnPointNearStructure(home, team, state)));
  }
}

/**
 * Pre-build generator + barracks cluster for **one** player (vs-computer bootstrap; skipped in PvP).
 */
function seedSkirmishEconomyBoost(state: GameState, forPlayerId: string): void {
  const team = playerTeamForPlayerId(forPlayerId);
  const home = state.structures.find((s) => s.playerId === forPlayerId && s.kind === "home" && s.hp > 0);
  if (!home) return;
  const hgx = home.gx;
  const hgz = home.gz;
  const candidates: { kind: StructureKind; dx: number; dz: number }[] = [
    { kind: "power_spire", dx: 6, dz: 2 },
    { kind: "barracks_r", dx: 2, dz: 6 },
    { kind: "barracks_s", dx: -2, dz: 4 },
    { kind: "barracks_p", dx: -4, dz: 6 }
  ];
  for (const c of candidates) {
    const gx = hgx + c.dx;
    const gz = hgz + c.dz;
    const { footW, footD } = footprintForStructureKind(c.kind);
    if (!footprintInWorldBounds(gx, gz, footW, footD)) continue;
    if (sphereFootprintBlocks(gx, gz, footW, footD)) continue;
    if (structureFootprintViolatesMinimumClearance(state, gx, gz, footW, footD)) continue;
    if (structureFootprintOverlapsResourceField(state, gx, gz, footW, footD)) continue;
    state.structures.push(
      makeStructure(forPlayerId, team, c.kind, gx, gz, footW, footD, maxHpForPlacedStructure(c.kind))
    );
  }
}

export function makeStructure(
  playerId: string,
  team: TeamId,
  kind: StructureKind,
  gx: number,
  gz: number,
  footW: number,
  footD: number,
  maxHp: number,
  buildRemainingSec = 0,
  buildTotalSec = 0
): SimStructure {
  return {
    id: randomMatchId(),
    playerId,
    team,
    kind,
    hp: maxHp,
    maxHp,
    buildRemainingSec,
    buildTotalSec,
    gx,
    gz,
    footW,
    footD,
    productionQueue: [],
    rallyPoint: null,
    rallyMineFieldId: null,
    homeDefenseCooldownRemainingSec: 0
  };
}

export function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      resources: { ...p.resources }
    })),
    units: state.units.map((u) => ({
      ...u,
      position: { ...u.position },
      moveTarget: u.moveTarget ? { ...u.moveTarget } : null,
      attackMoveTarget: u.attackMoveTarget ? { ...u.attackMoveTarget } : null,
      moveWaypointQueue: u.moveWaypointQueue.map((p) => ({ ...p })),
      carriedMinerals: u.carriedMinerals,
      depositStructureTargetId: u.depositStructureTargetId,
      buildStructureTargetId: u.buildStructureTargetId,
      pendingStructurePlacement: u.pendingStructurePlacement
        ? { ...u.pendingStructurePlacement }
        : null,
      damageReceivedFromUnitId: { ...u.damageReceivedFromUnitId },
      stuckChasingAttackTargetSec: u.stuckChasingAttackTargetSec,
      chaseDistToAttackTargetPrev: u.chaseDistToAttackTargetPrev
    })),
    structures: state.structures.map((s) => ({
      ...s,
      productionQueue: s.productionQueue.map((q) => ({ ...q })),
      rallyPoint: s.rallyPoint ? { ...s.rallyPoint } : null,
      rallyMineFieldId: s.rallyMineFieldId,
      homeDefenseCooldownRemainingSec: s.homeDefenseCooldownRemainingSec ?? 0
    })),
    resourceFields: state.resourceFields.map((f) => ({ ...f })),
    selections: Object.fromEntries(Object.entries(state.selections).map(([k, v]) => [k, [...v]])),
    structureSelections: Object.fromEntries(
      Object.entries(state.structureSelections).map(([k, v]) => [k, [...v]])
    ),
    turn: { ...state.turn },
    skirmishBoostPassive: state.skirmishBoostPassive
      ? { ...state.skirmishBoostPassive }
      : null,
    playerExploration: Object.fromEntries(
      Object.entries(state.playerExploration).map(([k, buf]) => [k, new Uint8Array(buf)])
    )
  };
}

export function makeSimUnit(playerId: string, team: TeamId, kind: MilitaryKind, position: Vec3): SimUnit {
  const combat = unitCombatFields(kind);
  return {
    id: randomMatchId(),
    playerId,
    team,
    kind,
    hp: getUnitMaxHp(kind),
    position: { ...position },
    moveTarget: null,
    attackMoveTarget: null,
    attackTargetId: null,
    attackStructureTargetId: null,
    gatherTargetFieldId: null,
    resumeGatherFieldId: null,
    moveWaypointQueue: [],
    carriedMinerals: 0,
    depositStructureTargetId: null,
    buildStructureTargetId: null,
    pendingStructurePlacement: null,
    gatherMineralPulseAccumSec: 0,
    damageReceivedFromUnitId: {},
    stuckChasingAttackTargetSec: 0,
    chaseDistToAttackTargetPrev: null,
    attackClass: tuning.units[kind].attackClass,
    visionRange: tuning.units[kind].visionRange,
    ...combat
  };
}

export function spawnPointNearStructure(s: SimStructure, _team: TeamId, _state?: GameState): Vec3 {
  const c = structureCenter(s);
  return { x: c.x, y: 0.55, z: c.z };
}
