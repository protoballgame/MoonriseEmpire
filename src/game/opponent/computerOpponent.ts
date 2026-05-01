import type { PlaceableStructureKind } from "../../core/commands/GameCommand";
import { createGameCommand, type GameCommand } from "../../core/commands/GameCommand";
import {
  COMPUTER_MINER_NEAR_HOME_ECONOMY_XZ_RANGE,
  resourcesForPlaceStructure,
  resourcesForTrainKind
} from "../../core/economyConstants";
import { resourceFieldCenterWorld } from "../../core/economy/resourceFieldGeometry";
import type { MilitaryKind } from "../../core/militaryKinds";
import {
  findNearestValidStructurePlacementNearHome,
  findNearestValidStructurePlacementTowardWorldPoint
} from "../../core/placementValidation";
import { tuning } from "../../core/runtimeTuning";
import { isNeutralWorkerContributingToConstruction } from "../../core/sim/constructionAssist";
import {
  isStructureBuilt,
  structureCenter,
  structureProducesKind,
  type GameState,
  type SimStructure,
  type SimUnit
} from "../../core/state/GameState";

let gatherIdleAccumSec = 0;
/** First PvC tick: assign gather to idle miners immediately (opening neutral often sat idle until interval). */
let cpuImmediateIdleGatherPending = true;
let constructionAssistAccumSec = 0;
/** Seconds between CPU attack-move raids with idle military. */
let raidMoveAccumSec = 0;
/** Send one idle fighter toward map center to open fog / contest mid. */
let scoutMilitaryAccumSec = 0;

const CONSTRUCTION_ASSIST_ASSIGN_INTERVAL_SEC = 0.22;
const RAID_ATTACK_MOVE_INTERVAL_SEC = 5.2;
const CPU_ATTACK_WAVE_MIN_IDLE_MILITARY = 3;
const SCOUT_MILITARY_INTERVAL_SEC = 12;
/** If the human is this close to the Core (world XZ), do not strip miners off combat for “economy bubble”. */
const CPU_HOME_THREAT_SUPPRESS_REVERT_RANGE = 38;

const COMPUTER_GATHER_IDLE_INTERVAL_SEC = 1.25;
/** Highest-weight RPS line (F(6) slot in a Fibonacci-weighted shuffle): built first among barracks, ~38% target share. */
let personalityFavored: MilitaryKind = "R";
let trainRng: () => number = Math.random;

const MAX_CPU_MINERS = 9;
const CPU_MINERS_PER_FIELD_SOFT_CAP = 3;
const MAX_HOME_QUEUE = 3;

/** First N R/S/P units skew this hard toward the favored barracks before quota mixing. */
const CPU_FAVORED_RPS_OPENING = 3;
const MAX_BARRACKS_QUEUE = 2;

/** Opening economy: total miners (including starter N); the 7th Neutral pivots to first barracks. */
const CPU_RUSH_TARGET_MINERS = 7;
/** Total Solar Arrays (`power_spire`, including match-seeded) before leaving rush. */
const CPU_RUSH_TARGET_SOLAR = 3;
const CPU_DEFENSE_TOWER_SOFT_CAP = 3;
const CPU_FIRST_TOWER_MIN_MILITARY = 2;
/** After rush, extra solars up to this cap; spacing uses Fibonacci-based delays + jitter. */
const CPU_SOFT_CAP_SOLAR = 8;
/**
 * Only place a Mineral Depository when the farthest ore node is this far from Command Core (world XZ).
 * Near-base mining can unload at the Core; skip the depot tax early.
 */
const DEPOT_MIN_MAX_FIELD_DISTANCE = 18;
/** Forward solar / depot bias toward mid-map riches (world XZ). */
const MAP_CONTEST_XZ = { x: 0, z: 0 } as const;

type BarracksStructureKind = Extract<PlaceableStructureKind, "barracks_r" | "barracks_s" | "barracks_p">;

const BARRACKS_KINDS: BarracksStructureKind[] = ["barracks_r", "barracks_s", "barracks_p"];

/** Rolled per match in `initComputerOpponentPersonality` (4 or 5; capped at 4 if R/S/P barracks were pre-seeded). */
let cpuArmyMinMiners = 7;
/** Sim time (seconds) for Fibonacci solar pacing after the opening rush. */
let cpuEconomyClockSec = 0;
/** Earliest time we may place another Solar Array after rush (fib + random scale). */
let cpuNextSolarEarliestSec = Number.POSITIVE_INFINITY;
/** Next Fibonacci index used for solar spacing (grows after each post-rush solar we place). */
let cpuPostRushSolarFibStep = 4;
/** Set once when opening rush is first satisfied; arms fib pacing. */
let cpuPostRushSolarPacingArmed = false;
/** Shuffled once per match: order to scan when filling missing barracks types. */
let cpuBarracksFillOrder: BarracksStructureKind[] = [...BARRACKS_KINDS];

function favoredBarracksKind(): BarracksStructureKind {
  if (personalityFavored === "R") return "barracks_r";
  if (personalityFavored === "S") return "barracks_s";
  return "barracks_p";
}

function hasCpuStructure(state: GameState, computerPlayerId: string, kind: PlaceableStructureKind): boolean {
  return state.structures.some(
    (s) =>
      s.playerId === computerPlayerId &&
      s.kind === kind &&
      s.hp > 0
  );
}

function countCpuBarracksSites(state: GameState, computerPlayerId: string): number {
  return state.structures.filter(
    (s) =>
      s.playerId === computerPlayerId &&
      s.hp > 0 &&
      (s.kind === "barracks_r" || s.kind === "barracks_s" || s.kind === "barracks_p")
  ).length;
}

function hasCpuBarracksSiteOfKind(
  state: GameState,
  computerPlayerId: string,
  kind: "barracks_r" | "barracks_s" | "barracks_p"
): boolean {
  return state.structures.some(
    (s) => s.playerId === computerPlayerId && s.hp > 0 && s.kind === kind
  );
}

function cpuRushTargetMiners(_state: GameState, _computerPlayerId: string): number {
  return CPU_RUSH_TARGET_MINERS;
}

function effectiveArmyMinMiners(_state: GameState, _computerPlayerId: string): number {
  return Math.max(cpuArmyMinMiners, CPU_RUSH_TARGET_MINERS);
}

/** Blend farthest known ore from CPU home toward map center so forward buildings contest mid. */
function mineralExpansionAnchorWorld(
  state: GameState,
  computerPlayerId: string
): { x: number; z: number } | null {
  const home = state.structures.find(
    (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return null;
  const hc = structureCenter(home);
  const fields = state.resourceFields.filter(
    (f) => f.kind === "minerals" && (f.reserve === null || f.reserve > 0)
  );
  if (fields.length === 0) return { x: MAP_CONTEST_XZ.x, z: MAP_CONTEST_XZ.z };
  let bestF = fields[0]!;
  let bestD = 0;
  for (const f of fields) {
    const c = resourceFieldCenterWorld(f);
    const d = Math.hypot(c.x - hc.x, c.z - hc.z);
    if (d > bestD) {
      bestD = d;
      bestF = f;
    }
  }
  const fc = resourceFieldCenterWorld(bestF);
  return {
    x: fc.x * 0.52 + MAP_CONTEST_XZ.x * 0.48,
    z: fc.z * 0.52 + MAP_CONTEST_XZ.z * 0.48
  };
}

function shouldBuildDepot(state: GameState, computerPlayerId: string): boolean {
  const home = state.structures.find(
    (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return false;
  const hc = structureCenter(home);
  let maxD = 0;
  for (const f of state.resourceFields) {
    if (f.kind !== "minerals" || (f.reserve !== null && f.reserve <= 0)) continue;
    const c = resourceFieldCenterWorld(f);
    const d = Math.hypot(c.x - hc.x, c.z - hc.z);
    if (d > maxD) maxD = d;
  }
  return maxD >= DEPOT_MIN_MAX_FIELD_DISTANCE;
}

function countCpuMiners(state: GameState, computerPlayerId: string): number {
  return state.units.filter(
    (u) => u.playerId === computerPlayerId && u.kind === "N" && u.hp > 0
  ).length;
}

function countCpuQueuedMiners(state: GameState, computerPlayerId: string): number {
  return state.structures
    .filter((s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0)
    .reduce((sum, s) => sum + s.productionQueue.filter((q) => q.kind === "N").length, 0);
}

function countCpuSolarSites(state: GameState, computerPlayerId: string): number {
  return state.structures.filter(
    (s) => s.playerId === computerPlayerId && s.kind === "power_spire" && s.hp > 0
  ).length;
}

function countCpuMinersAssignedToField(state: GameState, computerPlayerId: string, fieldId: string): number {
  return state.units.filter(
    (u) =>
      u.playerId === computerPlayerId &&
      u.kind === "N" &&
      u.hp > 0 &&
      (u.gatherTargetFieldId === fieldId || u.resumeGatherFieldId === fieldId)
  ).length;
}

function countCpuDefenseTowers(state: GameState, computerPlayerId: string): number {
  return state.structures.filter(
    (s) => s.playerId === computerPlayerId && s.kind === "defense_obelisk" && s.hp > 0
  ).length;
}

function rushEconomyComplete(state: GameState, computerPlayerId: string): boolean {
  return (
    countCpuMiners(state, computerPlayerId) >= cpuRushTargetMiners(state, computerPlayerId) &&
    countCpuSolarSites(state, computerPlayerId) >= CPU_RUSH_TARGET_SOLAR
  );
}

/** Fibonacci F(step) with F(1)=F(2)=1, F(4)=3, F(5)=5, ... */
function fibStepSeconds(step: number): number {
  if (step <= 2) return 1;
  let a = 1;
  let b = 1;
  for (let i = 3; i <= step; i += 1) {
    const c = a + b;
    a = b;
    b = c;
  }
  return b;
}

function advanceCpuSolarFibSchedule(): void {
  const step = Math.min(cpuPostRushSolarFibStep, 12);
  cpuPostRushSolarFibStep += 1;
  const base = fibStepSeconds(step);
  const gapSec = base * (10 + trainRng() * 14);
  cpuNextSolarEarliestSec = cpuEconomyClockSec + gapSec;
}

function initPostRushSolarSchedule(): void {
  cpuPostRushSolarFibStep = 4;
  advanceCpuSolarFibSchedule();
}

function shouldOfferPostRushFibSolar(state: GameState, computerPlayerId: string): boolean {
  if (!rushEconomyComplete(state, computerPlayerId)) return false;
  if (countCpuSolarSites(state, computerPlayerId) >= CPU_SOFT_CAP_SOLAR) return false;
  return cpuEconomyClockSec >= cpuNextSolarEarliestSec;
}

function countCpuMilitaryUnits(state: GameState, computerPlayerId: string): number {
  return state.units.filter(
    (u) => u.playerId === computerPlayerId && u.kind !== "N" && u.hp > 0
  ).length;
}

function shouldBuildDefenseTower(state: GameState, computerPlayerId: string): boolean {
  const towers = countCpuDefenseTowers(state, computerPlayerId);
  if (towers >= CPU_DEFENSE_TOWER_SOFT_CAP) return false;
  const military = countCpuMilitaryUnits(state, computerPlayerId);
  if (military < CPU_FIRST_TOWER_MIN_MILITARY) return false;
  if (enemyThreatNearCpuHome(state, computerPlayerId, CPU_HOME_THREAT_SUPPRESS_REVERT_RANGE + 10)) return true;
  const roll = towers === 0 ? 0.18 : 0.08;
  return trainRng() < roll;
}

/**
 * Opening: get the three Solar Array economy online, then the 7th Neutral pivots into a first barracks.
 * This keeps the CPU from spending the whole opener on miners.
 */
function nextCpuStructureKind(
  state: GameState,
  computerPlayerId: string
): PlaceableStructureKind | null {
  const solarCount = countCpuSolarSites(state, computerPlayerId);
  const miners = countCpuMiners(state, computerPlayerId);
  const rushDone = rushEconomyComplete(state, computerPlayerId);
  const barracksSites = countCpuBarracksSites(state, computerPlayerId);

  if (!rushDone) {
    if (miners >= CPU_RUSH_TARGET_MINERS && solarCount >= CPU_RUSH_TARGET_SOLAR && barracksSites === 0) {
      return favoredBarracksKind();
    }
    if (solarCount < CPU_RUSH_TARGET_SOLAR) {
      return "power_spire";
    }
    return null;
  }

  const fav = favoredBarracksKind();

  if (barracksSites < 2) {
    if (!hasCpuBarracksSiteOfKind(state, computerPlayerId, fav)) {
      return fav;
    }
    for (const k of cpuBarracksFillOrder) {
      if (!hasCpuBarracksSiteOfKind(state, computerPlayerId, k)) {
        return k;
      }
    }
    return fav;
  }

  if (shouldBuildDefenseTower(state, computerPlayerId)) {
    return "defense_obelisk";
  }

  if (shouldOfferPostRushFibSolar(state, computerPlayerId)) {
    return "power_spire";
  }

  if (barracksSites < 3) {
    for (const k of cpuBarracksFillOrder) {
      if (!hasCpuBarracksSiteOfKind(state, computerPlayerId, k)) {
        return k;
      }
    }
  }

  if (shouldBuildDepot(state, computerPlayerId) && !hasCpuStructure(state, computerPlayerId, "mineral_depot")) {
    return "mineral_depot";
  }

  return null;
}

function hashMatchId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed ^ 0x51ed_3291);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function resetComputerOpponentState(): void {
  gatherIdleAccumSec = COMPUTER_GATHER_IDLE_INTERVAL_SEC;
  cpuImmediateIdleGatherPending = true;
  constructionAssistAccumSec = 0;
  raidMoveAccumSec = RAID_ATTACK_MOVE_INTERVAL_SEC * 0.35;
  scoutMilitaryAccumSec = SCOUT_MILITARY_INTERVAL_SEC * 0.15;
  cpuEconomyClockSec = 0;
  cpuNextSolarEarliestSec = Number.POSITIVE_INFINITY;
  cpuPostRushSolarFibStep = 4;
  cpuPostRushSolarPacingArmed = false;
  cpuBarracksFillOrder = [...BARRACKS_KINDS];
}

/**
 * Derive a stable R/P/S training bias for this match from `matchId` (Fibonacci thirds on a random permutation).
 */
export function initComputerOpponentPersonality(matchId: string): void {
  const seed = hashMatchId(matchId);
  trainRng = mulberry32(seed ^ 0x9e37_79b9);
  cpuArmyMinMiners = trainRng() < 0.55 ? 4 : 5;
  cpuBarracksFillOrder = seededShuffle([...BARRACKS_KINDS], seed ^ 0xba5e_c0de);
  const order = seededShuffle(["R", "S", "P"] as const, seed);
  /** Third slot after shuffle — stable “main” line for this match (still Fibonacci-themed opener in build order). */
  personalityFavored = order[2]!;
}

function countMilitaryByKind(state: GameState, pid: string): Record<MilitaryKind, number> {
  const c: Record<MilitaryKind, number> = { R: 0, S: 0, P: 0, N: 0 };
  for (const u of state.units) {
    if (u.playerId !== pid || u.hp <= 0) continue;
    c[u.kind] += 1;
  }
  return c;
}

function findProducerForKind(state: GameState, pid: string, kind: MilitaryKind): SimStructure | null {
  if (kind === "N") {
    return (
      state.structures.find(
        (s) => s.playerId === pid && s.kind === "home" && s.hp > 0 && isStructureBuilt(s)
      ) ?? null
    );
  }
  return (
    state.structures.find((s) => {
      if (s.playerId !== pid || s.hp <= 0 || !isStructureBuilt(s)) return false;
      return structureProducesKind(s) === kind;
    }) ?? null
  );
}

function canQueueProduction(st: SimStructure): boolean {
  if (st.kind === "home") return st.productionQueue.length < MAX_HOME_QUEUE;
  return st.productionQueue.length < MAX_BARRACKS_QUEUE;
}

function militaryTrainStructuresByNeed(state: GameState, pid: string): SimStructure[] {
  if (countCpuMiners(state, pid) < effectiveArmyMinMiners(state, pid)) {
    return [];
  }

  const counts = countMilitaryByKind(state, pid);
  const rpsTotal = counts.R + counts.S + counts.P;

  const totalAll = Math.max(rpsTotal + counts.N, 1);
  const rpsLow = rpsTotal < 10;
  const targetShare = (k: MilitaryKind): number => {
    if (k === "N") return 0;
    if (k === personalityFavored) return rpsLow ? 0.42 : 0.36;
    return rpsLow ? 0.29 : 0.32;
  };
  const need = (k: MilitaryKind): number => {
    const openingBoost =
      rpsTotal < CPU_FAVORED_RPS_OPENING && k === personalityFavored
        ? CPU_FAVORED_RPS_OPENING - rpsTotal
        : 0;
    return targetShare(k) * (totalAll + 5) - counts[k] + openingBoost;
  };

  const kinds: MilitaryKind[] = ["R", "S", "P"];
  kinds.sort((a, b) => need(b) - need(a));

  const picks: SimStructure[] = [];
  const used = new Set<string>();
  for (const k of kinds) {
    const st = findProducerForKind(state, pid, k);
    if (!st || used.has(st.id) || !canQueueProduction(st)) continue;
    used.add(st.id);
    picks.push(st);
  }
  return picks;
}

function pickNearestMinerForConstruction(
  state: GameState,
  playerId: string,
  target: { x: number; z: number },
  excludeIds?: ReadonlySet<string>
): SimUnit | null {
  let best: SimUnit | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const consider = (allowGathering: boolean): void => {
    for (const u of state.units) {
      if (u.playerId !== playerId || u.kind !== "N" || u.hp <= 0) continue;
      if (excludeIds?.has(u.id)) continue;
      if (!allowGathering && u.gatherTargetFieldId) continue;
      if (u.depositStructureTargetId) continue;
      if (u.attackTargetId || u.attackStructureTargetId) continue;
      const d = Math.hypot(u.position.x - target.x, u.position.z - target.z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
  };
  consider(false);
  if (best) return best;
  bestD = Number.POSITIVE_INFINITY;
  best = null;
  consider(true);
  return best;
}

function tryComputerAssignBuildersToUnfinishedStructures(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const usedMiners = new Set<string>();
  for (const s of state.structures) {
    if (s.playerId !== computerPlayerId || s.buildRemainingSec <= 0) continue;
    if (isNeutralWorkerContributingToConstruction(state, s)) continue;
    const c = structureCenter(s);
    const miner = pickNearestMinerForConstruction(state, computerPlayerId, c, usedMiners);
    if (!miner) continue;
    usedMiners.add(miner.id);
    const hadGather = !!miner.gatherTargetFieldId;
    if (hadGather) {
      miner.resumeGatherFieldId = miner.gatherTargetFieldId;
    }
    submit(
      createGameCommand(computerPlayerId, "move_units", {
        target: { x: c.x, y: c.y, z: c.z },
        unitIds: [miner.id],
        keepResumeGatherIntent: hadGather,
        constructionStructureId: s.id
      })
    );
  }
}

function tryQueueMiner(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const pl = state.players.find((p) => p.id === computerPlayerId);
  if (!pl) return;
  const minerCost = resourcesForTrainKind("N");
  if (pl.resources.energy < minerCost.energy || pl.resources.minerals < minerCost.minerals) {
    return;
  }
  const miners = state.units.filter(
    (u) => u.playerId === computerPlayerId && u.kind === "N" && u.hp > 0
  );
  const minersIncludingQueued = miners.length + countCpuQueuedMiners(state, computerPlayerId);
  const barracksSites = countCpuBarracksSites(state, computerPlayerId);
  const openingStructure = nextCpuStructureKind(state, computerPlayerId);
  if (
    openingStructure !== null &&
    (openingStructure === "power_spire" ||
      openingStructure === "barracks_r" ||
      openingStructure === "barracks_s" ||
      openingStructure === "barracks_p")
  ) {
    const placeCost = resourcesForPlaceStructure(openingStructure);
    if (
      barracksSites === 0 &&
      minersIncludingQueued >= CPU_RUSH_TARGET_MINERS &&
      (pl.resources.energy < placeCost.energy || pl.resources.minerals < placeCost.minerals)
    ) {
      return;
    }
    if (
      openingStructure === "power_spire" &&
      countCpuSolarSites(state, computerPlayerId) >= 2 &&
      (pl.resources.energy < placeCost.energy || pl.resources.minerals < placeCost.minerals)
    ) {
      return;
    }
  }
  const military = countCpuMilitaryUnits(state, computerPlayerId);
  const desiredMiners =
    barracksSites === 0
      ? effectiveArmyMinMiners(state, computerPlayerId)
      : military < 6
        ? Math.max(effectiveArmyMinMiners(state, computerPlayerId), 6)
        : MAX_CPU_MINERS;
  if (minersIncludingQueued >= desiredMiners) return;

  const home = state.structures.find(
    (s) =>
      s.playerId === computerPlayerId &&
      s.kind === "home" &&
      s.hp > 0 &&
      isStructureBuilt(s)
  );
  if (!home || home.productionQueue.length >= MAX_HOME_QUEUE) return;

  submit(createGameCommand(computerPlayerId, "queue_structure_train", { structureId: home.id }));
}

function tryComputerGatherIdleMiners(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const idle = state.units.filter(
    (u) =>
      u.playerId === computerPlayerId &&
      u.kind === "N" &&
      u.hp > 0 &&
      u.carriedMinerals === 0 &&
      !u.gatherTargetFieldId &&
      !u.depositStructureTargetId &&
      !u.buildStructureTargetId
  );
  if (idle.length === 0) return;

  const fields = state.resourceFields.filter(
    (f) => f.kind === "minerals" && (f.reserve === null || f.reserve > 0)
  );
  if (fields.length === 0) return;

  const home = state.structures.find(
    (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
  );
  let ax = home ? structureCenter(home).x : idle[0]!.position.x;
  let az = home ? structureCenter(home).z : idle[0]!.position.z;
  if (idle.length > 0) {
    let sx = 0;
    let sz = 0;
    for (const u of idle) {
      sx += u.position.x;
      sz += u.position.z;
    }
    const mx = sx / idle.length;
    const mz = sz / idle.length;
    if (home) {
      const hc = structureCenter(home);
      ax = mx * 0.65 + hc.x * 0.35;
      az = mz * 0.65 + hc.z * 0.35;
    } else {
      ax = mx;
      az = mz;
    }
  }

  const orderedFields = [...fields].sort((a, b) => {
    const ca = resourceFieldCenterWorld(a);
    const cb = resourceFieldCenterWorld(b);
    const da = (ca.x - ax) * (ca.x - ax) + (ca.z - az) * (ca.z - az);
    const db = (cb.x - ax) * (cb.x - ax) + (cb.z - az) * (cb.z - az);
    return da - db || a.id.localeCompare(b.id);
  });

  const pendingByField = new Map<string, string[]>();
  for (const u of idle) {
    const target =
      orderedFields.find((f) => {
        const already =
          countCpuMinersAssignedToField(state, computerPlayerId, f.id) +
          (pendingByField.get(f.id)?.length ?? 0);
        return already < CPU_MINERS_PER_FIELD_SOFT_CAP;
      }) ?? orderedFields[orderedFields.length - 1]!;
    const list = pendingByField.get(target.id) ?? [];
    list.push(u.id);
    pendingByField.set(target.id, list);
  }

  for (const [fieldId, unitIds] of pendingByField) {
    submit(
      createGameCommand(computerPlayerId, "gather_from_field", {
        fieldId,
        unitIds
      })
    );
  }
}

/**
 * If the opening neutral has nothing to mine in vision, march toward the nearest mineral patch
 * so it enters vision and the next gather pass can latch on.
 */
function tryComputerScoutIdleMinersTowardMinerals(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const idle = state.units.filter(
    (u) =>
      u.playerId === computerPlayerId &&
      u.kind === "N" &&
      u.hp > 0 &&
      u.carriedMinerals === 0 &&
      !u.gatherTargetFieldId &&
      !u.depositStructureTargetId &&
      !u.buildStructureTargetId &&
      !u.moveTarget &&
      !u.attackMoveTarget
  );
  if (idle.length === 0) return;

  const fields = state.resourceFields.filter(
    (f) => f.kind === "minerals" && (f.reserve === null || f.reserve > 0)
  );
  if (fields.length === 0) return;

  const blind = idle.filter((u) => {
    const vr = u.visionRange;
    return !fields.some((f) => {
      const c = resourceFieldCenterWorld(f);
      const dx = c.x - u.position.x;
      const dz = c.z - u.position.z;
      return Math.hypot(dx, dz) <= vr;
    });
  });
  if (blind.length === 0) return;

  let bestF = fields[0]!;
  let bestSum = Infinity;
  for (const f of fields) {
    const c = resourceFieldCenterWorld(f);
    let sum = 0;
    for (const u of blind) {
      const dx = c.x - u.position.x;
      const dz = c.z - u.position.z;
      sum += Math.hypot(dx, dz);
    }
    if (sum < bestSum) {
      bestSum = sum;
      bestF = f;
    }
  }
  const target = resourceFieldCenterWorld(bestF);
  submit(
    createGameCommand(computerPlayerId, "move_units", {
      target: { x: target.x, y: target.y, z: target.z },
      unitIds: blind.map((u) => u.id)
    })
  );
}

function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distXZ(
  a: { x: number; z: number },
  b: { x: number; z: number }
): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pickNearestMineralFieldId(state: GameState, ax: number, az: number): string | null {
  const fields = state.resourceFields.filter(
    (f) => f.kind === "minerals" && (f.reserve === null || f.reserve > 0)
  );
  if (fields.length === 0) return null;
  let best = fields[0]!;
  let bestD = Infinity;
  for (const f of fields) {
    const c = resourceFieldCenterWorld(f);
    const d = (c.x - ax) * (c.x - ax) + (c.z - az) * (c.z - az);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best.id;
}

/**
 * Inside `COMPUTER_MINER_NEAR_HOME_ECONOMY_XZ_RANGE` of Core, drop combat and resume economy.
 * Runs immediately before defensive mining so the same tick does not re-issue attack.
 */
function enemyThreatNearCpuHome(state: GameState, computerPlayerId: string, range: number): boolean {
  const home = state.structures.find(
    (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return false;
  const hc = structureCenter(home);
  const team = home.team;
  for (const u of state.units) {
    if (u.hp <= 0 || u.team === team) continue;
    if (distXZ(u.position, hc) <= range) return true;
  }
  for (const s of state.structures) {
    if (s.hp <= 0 || s.team === team) continue;
    if (distXZ(structureCenter(s), hc) <= range) return true;
  }
  return false;
}

function tryComputerRevertMinersNearHomeToEconomy(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  if (enemyThreatNearCpuHome(state, computerPlayerId, CPU_HOME_THREAT_SUPPRESS_REVERT_RANGE)) return;

  const home = state.structures.find(
    (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
  );
  if (!home) return;

  const hc = structureCenter(home);
  const r = COMPUTER_MINER_NEAR_HOME_ECONOMY_XZ_RANGE;

  for (const miner of state.units) {
    if (miner.playerId !== computerPlayerId || miner.kind !== "N" || miner.hp <= 0) continue;
    if (distXZ(miner.position, hc) > r) continue;

    const fighting = miner.attackTargetId || miner.attackStructureTargetId;
    if (!fighting) continue;

    if (miner.carriedMinerals > 0) {
      submit(
        createGameCommand(computerPlayerId, "deposit_at_structure", {
          targetStructureId: home.id,
          unitIds: [miner.id]
        })
      );
    } else {
      const fieldId = pickNearestMineralFieldId(state, miner.position.x, miner.position.z);
      if (fieldId) {
        submit(
          createGameCommand(computerPlayerId, "gather_from_field", {
            fieldId,
            unitIds: [miner.id]
          })
        );
      } else {
        submit(
          createGameCommand(computerPlayerId, "stop_units", {
            unitIds: [miner.id]
          })
        );
      }
    }
  }
}

/**
 * Miners (N) that see an enemy unit or structure attack it, dropping gather/deposit/move for that tick.
 * Runs after other CPU economy orders so it overrides fresh gather/scout assignments.
 */
function tryComputerDefensiveMiners(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const miners = state.units.filter(
    (u) => u.playerId === computerPlayerId && u.kind === "N" && u.hp > 0
  );
  if (miners.length === 0) return;

  for (const miner of miners) {
    if (miner.attackTargetId || miner.attackStructureTargetId) continue;

    const vr = miner.visionRange;
    let best: { kind: "unit" | "structure"; id: string; dist: number } | null = null;

    for (const o of state.units) {
      if (o.hp <= 0 || o.team === miner.team) continue;
      const d = dist3(miner.position, o.position);
      if (d > vr) continue;
      if (!best || d < best.dist) {
        best = { kind: "unit", id: o.id, dist: d };
      }
    }

    for (const s of state.structures) {
      if (s.hp <= 0 || s.team === miner.team) continue;
      const c = structureCenter(s);
      const d = dist3(miner.position, c);
      if (d > vr) continue;
      if (!best || d < best.dist) {
        best = { kind: "structure", id: s.id, dist: d };
      }
    }

    if (!best) continue;

    if (best.kind === "unit") {
      submit(
        createGameCommand(computerPlayerId, "attack_unit", {
          targetUnitId: best.id,
          unitIds: [miner.id]
        })
      );
    } else {
      submit(
        createGameCommand(computerPlayerId, "attack_structure", {
          targetStructureId: best.id,
          unitIds: [miner.id]
        })
      );
    }
  }
}

function pickMinerForCpuPlacement(state: GameState, playerId: string): SimUnit | null {
  let best: SimUnit | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const home = state.structures.find(
    (s) => s.playerId === playerId && s.kind === "home" && s.hp > 0
  );
  const ox = home ? structureCenter(home).x : 0;
  const oz = home ? structureCenter(home).z : 0;
  for (const u of state.units) {
    if (u.playerId !== playerId || u.kind !== "N" || u.hp <= 0) continue;
    const d = Math.hypot(u.position.x - ox, u.position.z - oz);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function tryComputerPlaceStructure(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const pl = state.players.find((p) => p.id === computerPlayerId);
  if (!pl) return;
  const kind = nextCpuStructureKind(state, computerPlayerId);
  if (!kind) return;
  const barracksSites = countCpuBarracksSites(state, computerPlayerId);
  if (
    (kind === "barracks_r" || kind === "barracks_s" || kind === "barracks_p") &&
    barracksSites > 0 &&
    trainRng() < 0.035
  ) {
    return;
  }
  const { energy, minerals } = resourcesForPlaceStructure(kind);
  if (pl.resources.energy < energy || pl.resources.minerals < minerals) return;

  const builder = pickMinerForCpuPlacement(state, computerPlayerId);
  if (!builder) return;

  let site: { gx: number; gz: number } | null = null;
  const solars = countCpuSolarSites(state, computerPlayerId);
  if (kind === "mineral_depot") {
    const anchor = mineralExpansionAnchorWorld(state, computerPlayerId);
    if (anchor) {
      site = findNearestValidStructurePlacementTowardWorldPoint(
        state,
        computerPlayerId,
        kind,
        anchor.x,
        anchor.z,
        26
      );
    }
  } else if (kind === "defense_obelisk") {
    const home = state.structures.find(
      (s) => s.playerId === computerPlayerId && s.kind === "home" && s.hp > 0
    );
    if (home) {
      const hc = structureCenter(home);
      const theta = trainRng() * Math.PI * 2;
      const radius = 8 + trainRng() * 18;
      const target = {
        x: hc.x + Math.cos(theta) * radius,
        z: hc.z + Math.sin(theta) * radius
      };
      site = findNearestValidStructurePlacementTowardWorldPoint(
        state,
        computerPlayerId,
        kind,
        target.x,
        target.z,
        16
      );
    }
  } else if (kind === "power_spire" && solars >= 3) {
    const anchor = mineralExpansionAnchorWorld(state, computerPlayerId);
    if (anchor) {
      site = findNearestValidStructurePlacementTowardWorldPoint(
        state,
        computerPlayerId,
        kind,
        anchor.x,
        anchor.z,
        20
      );
    }
  }
  if (!site) {
    site = findNearestValidStructurePlacementNearHome(state, computerPlayerId, kind);
  }
  if (!site && (kind === "barracks_r" || kind === "barracks_s" || kind === "barracks_p")) {
    const anchor = mineralExpansionAnchorWorld(state, computerPlayerId) ?? MAP_CONTEST_XZ;
    site = findNearestValidStructurePlacementTowardWorldPoint(
      state,
      computerPlayerId,
      kind,
      anchor.x,
      anchor.z,
      36
    );
  }
  if (!site) return;

  submit(
    createGameCommand(computerPlayerId, "place_structure", {
      kind,
      gx: site.gx,
      gz: site.gz,
      builderUnitId: builder.id
    })
  );
  if (kind === "power_spire" && rushEconomyComplete(state, computerPlayerId)) {
    advanceCpuSolarFibSchedule();
  }
}

/** Queue from ready barracks while resources cover the train costs, so surplus economy becomes army variety. */
function tryComputerQueueMilitaryTrain(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string
): void {
  const pl = state.players.find((p) => p.id === computerPlayerId);
  if (!pl) return;
  let budgetEnergy = pl.resources.energy;
  let budgetMinerals = pl.resources.minerals;
  for (const pick of militaryTrainStructuresByNeed(state, computerPlayerId)) {
    const prodKind = structureProducesKind(pick);
    if (!prodKind) continue;
    const trainCost = resourcesForTrainKind(prodKind);
    if (budgetEnergy < trainCost.energy || budgetMinerals < trainCost.minerals) continue;
    budgetEnergy -= trainCost.energy;
    budgetMinerals -= trainCost.minerals;
    submit(createGameCommand(computerPlayerId, "queue_structure_train", { structureId: pick.id }));
  }
}

function pickCpuIdleMilitary(state: GameState, computerPlayerId: string): SimUnit[] {
  return state.units.filter(
    (u) =>
      u.playerId === computerPlayerId &&
      u.kind !== "N" &&
      u.hp > 0 &&
      !u.moveTarget &&
      !u.attackMoveTarget &&
      !u.attackTargetId &&
      !u.attackStructureTargetId
  );
}

/**
 * Push vision toward world center: pick the idle fighter farthest from (0,0) and march it inward.
 */
function tryComputerScoutMilitaryTowardMid(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string,
  deltaSeconds: number
): void {
  scoutMilitaryAccumSec += deltaSeconds;
  if (scoutMilitaryAccumSec < SCOUT_MILITARY_INTERVAL_SEC) return;
  const idle = pickCpuIdleMilitary(state, computerPlayerId);
  if (idle.length === 0) return;
  let best = idle[0]!;
  let bestD = Math.hypot(best.position.x - MAP_CONTEST_XZ.x, best.position.z - MAP_CONTEST_XZ.z);
  for (const u of idle) {
    const d = Math.hypot(u.position.x - MAP_CONTEST_XZ.x, u.position.z - MAP_CONTEST_XZ.z);
    if (d > bestD) {
      bestD = d;
      best = u;
    }
  }
  if (bestD < 12) {
    scoutMilitaryAccumSec = SCOUT_MILITARY_INTERVAL_SEC * 0.35;
    return;
  }
  const scout =
    idle.find((u) => u.kind === "P" && Math.hypot(u.position.x, u.position.z) > 8) ?? best;
  scoutMilitaryAccumSec = 0;
  submit(
    createGameCommand(computerPlayerId, "attack_move_units", {
      target: { x: MAP_CONTEST_XZ.x, y: 0.55, z: MAP_CONTEST_XZ.z },
      unitIds: [scout.id],
      formation: tuning.formation.active
    })
  );
}

/**
 * Periodically march idle R/S/P toward the rival Command Core (or any enemy structure) so the CPU applies pressure.
 */
function tryComputerRaidAttackMove(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string,
  deltaSeconds: number
): void {
  raidMoveAccumSec += deltaSeconds;
  if (raidMoveAccumSec < RAID_ATTACK_MOVE_INTERVAL_SEC) return;

  const rival = state.players.find((p) => p.id !== computerPlayerId);
  if (!rival) return;

  const idleMilitary = pickCpuIdleMilitary(state, computerPlayerId);
  if (idleMilitary.length < CPU_ATTACK_WAVE_MIN_IDLE_MILITARY) return;

  const targetHome = state.structures.find(
    (s) => s.playerId === rival.id && s.kind === "home" && s.hp > 0
  );
  const target = targetHome ?? state.structures.find((s) => s.playerId === rival.id && s.hp > 0);
  if (!target) return;

  raidMoveAccumSec = 0;
  const c = structureCenter(target);
  submit(
    createGameCommand(computerPlayerId, "attack_move_units", {
      target: { x: c.x, y: c.y, z: c.z },
      unitIds: idleMilitary.map((u) => u.id),
      formation: tuning.formation.active
    })
  );
}

/**
 * Runs once per frame **before** `GameMode.update` so queued commands apply on the same tick.
 */
export function tickComputerOpponent(
  state: GameState,
  submit: (cmd: GameCommand) => void,
  computerPlayerId: string,
  deltaSeconds: number
): void {
  if (state.victorPlayerId !== null) return;

  if (rushEconomyComplete(state, computerPlayerId) && !cpuPostRushSolarPacingArmed) {
    initPostRushSolarSchedule();
    cpuPostRushSolarPacingArmed = true;
  }

  constructionAssistAccumSec += deltaSeconds;
  if (constructionAssistAccumSec >= CONSTRUCTION_ASSIST_ASSIGN_INTERVAL_SEC) {
    constructionAssistAccumSec = 0;
    tryComputerAssignBuildersToUnfinishedStructures(state, submit, computerPlayerId);
  }

  if (cpuImmediateIdleGatherPending) {
    cpuImmediateIdleGatherPending = false;
    tryComputerGatherIdleMiners(state, submit, computerPlayerId);
    tryComputerScoutIdleMinersTowardMinerals(state, submit, computerPlayerId);
  }

  gatherIdleAccumSec += deltaSeconds;
  if (gatherIdleAccumSec >= COMPUTER_GATHER_IDLE_INTERVAL_SEC) {
    gatherIdleAccumSec = 0;
    tryComputerGatherIdleMiners(state, submit, computerPlayerId);
    tryComputerScoutIdleMinersTowardMinerals(state, submit, computerPlayerId);
  }

  /**
   * Production and placement are evaluated every frame: each helper submits at most once and returns early
   * when the next action is unaffordable or unavailable, so pacing follows income instead of fixed timers.
   */
  tryComputerPlaceStructure(state, submit, computerPlayerId);
  tryComputerQueueMilitaryTrain(state, submit, computerPlayerId);
  tryQueueMiner(state, submit, computerPlayerId);

  tryComputerRevertMinersNearHomeToEconomy(state, submit, computerPlayerId);
  tryComputerDefensiveMiners(state, submit, computerPlayerId);
  tryComputerRaidAttackMove(state, submit, computerPlayerId, deltaSeconds);
  tryComputerScoutMilitaryTowardMid(state, submit, computerPlayerId, deltaSeconds);

  cpuEconomyClockSec += deltaSeconds;
}

/** Vitest: frozen-state peek at structure priorities (does not advance economy clock or pacing flags). */
export function cpuNextStructureKindForTesting(
  state: GameState,
  computerPlayerId: string
): PlaceableStructureKind | null {
  return nextCpuStructureKind(state, computerPlayerId);
}
