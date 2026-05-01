import type { GameCommand } from "../commands/GameCommand";
import type { PlaceableStructureKind } from "../commands/GameCommand";
import {
  assignAutoDepositForGatheringMiner,
  processDepositForUnit
} from "../economy/depositTick";
import { runDefaultResourceEconomyWorldTick } from "../economy/economyWorldTick";
import { processGatheringForUnit, removeDepletedResourceFields } from "../economy/gatheringTick";
import { resourceFieldCenterWorld } from "../economy/resourceFieldGeometry";
import {
  canPlaceStructureFootprint,
  canPlaceStructureForPlayer,
  canPlanStructureFootprint,
  isFootprintExploredForPlayer
} from "../placementValidation";
import {
  BARRACKS_TRAIN_TIME_SEC,
  BARRACKS_BUILD_TIME_SEC,
  COMMAND_CORE_BUILD_TIME_SEC,
  DEFENSE_OBELISK_BUILD_TIME_SEC,
  MINERAL_DEPOT_BUILD_TIME_SEC,
  POWER_SPIRE_BUILD_TIME_SEC,
  resourcesForPlaceStructure,
  resourcesForTrainKind
} from "../economyConstants";
import { rpsDamageMultiplier } from "../balance";
import { defensiveStructureStats } from "../structureStats";
import {
  cloneGameState,
  makeSimUnit,
  makeStructure,
  maxHpForPlacedStructure,
  playerTeamForPlayerId,
  spawnPointNearStructure,
  structureCenter,
  structureProducesKind,
  isStructureBuilt,
  winnerWhenCommandCoreDestroyed,
  type GameState,
  type SimStructure,
  type SimUnit,
  type Vec3
} from "../state/GameState";
import { computeFormationSlots, squadCentroid } from "../formations";
import type { FormationId } from "../runtimeTuning";
import { tuning } from "../runtimeTuning";
import type { DamageDealtEvent, SimulationEvent, SimulationTickResult } from "./simulationEvents";
import type { UiFeedbackEvent } from "./uiFeedbackEvents";
import { advanceExploration } from "../world/explorationGrid";
import {
  constructionBuildRateScale,
  countNeutralWorkersContributingToConstruction,
  isNeutralWorkerAdvancingConstruction,
  isNeutralWorkerContributingToConstruction,
  moveDestinationIsUnfinishedFriendlyStructure,
  neutralMinerInConstructionAssistRange,
  neutralMinerArrivedToAssistConstruction,
  tryApplyNeutralMinerResumeGather
} from "./constructionAssist";
import {
  forEachStructureCandidateNearXZ,
  prepareFootprintBlockingIndex
} from "./structureFootprintBlockingIndex";
import {
  FOOTPRINT_UNIT_COLLISION_MARGIN,
  moveGroundUnitTowardPoint
} from "./structureFootprintMoveSlide";
import { footprintForStructureKind } from "../structureFootprint";
import {
  closestXZPointOnFootprintEdgesWrapped,
  distancePointXZToFootprintEdgesWithMarginWrapped,
  footprintCenterWorld,
  GROUND_HALF_EXTENT,
  GRID_CELL_SIZE,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z
} from "../world/worldGrid";
import { sphereGeodesicDistanceWorldXZ } from "../world/worldSurface";
import { topologyDistanceXZ } from "../world/worldTopology";

type HostileTarget =
  | { kind: "unit"; u: SimUnit }
  | { kind: "structure"; s: SimStructure };

function sphericalDistance3(a: Vec3, b: Vec3): number {
  const surfaceDistance = sphereGeodesicDistanceWorldXZ(a.x, a.z, b.x, b.z);
  const dy = a.y - b.y;
  return Math.hypot(surfaceDistance, dy);
}

function asVec3(v: unknown): Vec3 | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.x !== "number" || typeof o.y !== "number" || typeof o.z !== "number") return null;
  return { x: o.x, y: o.y, z: o.z };
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

function parseFormationId(v: unknown): FormationId {
  if (v === "none" || v === "square" || v === "circle" || v === "triangle") return v;
  return tuning.formation.active;
}

function asPlaceableStructureKind(v: unknown): PlaceableStructureKind | null {
  if (
    v === "home" ||
    v === "barracks_r" ||
    v === "barracks_s" ||
    v === "barracks_p" ||
    v === "power_spire" ||
    v === "defense_obelisk" ||
    v === "mineral_depot"
  ) {
    return v;
  }
  return null;
}

/** Grid indices from the client / payload (accepts e.g. `5` or `5.0` from JSON). */
function asGridCoord(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  if (Math.abs(v - r) > 1e-5) return null;
  return r;
}

function hostilePosition(h: HostileTarget): Vec3 {
  return h.kind === "unit" ? h.u.position : structureCenter(h.s);
}

function isActiveMineralHauler(u: SimUnit): boolean {
  return u.kind === "N" && u.carriedMinerals > 0 && u.depositStructureTargetId !== null;
}

function isNeutralMineralPathing(u: SimUnit): boolean {
  return u.kind === "N" && (u.gatherTargetFieldId !== null || u.depositStructureTargetId !== null);
}

export class SimulationEngine {
  private readonly commandQueue: GameCommand[] = [];

  enqueue(command: GameCommand): void {
    this.commandQueue.push(command);
  }

  /** Drop pending commands (e.g. when restarting the match). */
  clearCommandQueue(): void {
    this.commandQueue.length = 0;
  }

  step(state: GameState, deltaSeconds: number): SimulationTickResult {
    const nextState = cloneGameState(state);
    nextState.tick += Math.max(1, Math.floor(deltaSeconds * state.tickRateHz));

    const feedback: UiFeedbackEvent[] = [];
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift();
      if (!command) break;
      this.applyCommand(nextState, command, feedback);
    }

    const events: SimulationEvent[] = [];
    this.simulateWorld(nextState, deltaSeconds, events);
    return { state: nextState, events, feedback };
  }

  /**
   * Neutral-line unit that authorizes `place_structure`: explicit `builderUnitId`, else first **N** in
   * selection, else the friendly **N** closest to the footprint center (so placement still works if
   * the build menu was used then selection changed before the map click).
   */
  private resolveStructurePlacementBuilder(
    state: GameState,
    playerId: string,
    payload: Record<string, unknown> | undefined,
    gx: number,
    gz: number,
    footW: number,
    footD: number
  ): string | null {
    const raw = payload?.builderUnitId;
    if (typeof raw === "string") {
      const u = state.units.find(
        (x) => x.id === raw && x.playerId === playerId && x.hp > 0 && x.kind === "N"
      );
      if (u) return raw;
    }
    for (const id of state.selections[playerId] ?? []) {
      const u = state.units.find(
        (x) => x.id === id && x.playerId === playerId && x.hp > 0 && x.kind === "N"
      );
      if (u) return id;
    }
    const c = footprintCenterWorld(gx, gz, footW, footD);
    let bestId: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const u of state.units) {
      if (u.playerId !== playerId || u.kind !== "N" || u.hp <= 0) continue;
      const d = topologyDistanceXZ(state, u.position.x, u.position.z, c.x, c.z);
      if (d < bestD) {
        bestD = d;
        bestId = u.id;
      }
    }
    return bestId;
  }

  private buildTimeForStructureKind(kind: PlaceableStructureKind): number {
    if (kind === "home") return COMMAND_CORE_BUILD_TIME_SEC;
    if (kind === "power_spire") return POWER_SPIRE_BUILD_TIME_SEC;
    if (kind === "defense_obelisk") return DEFENSE_OBELISK_BUILD_TIME_SEC;
    if (kind === "mineral_depot") return MINERAL_DEPOT_BUILD_TIME_SEC;
    return BARRACKS_BUILD_TIME_SEC;
  }

  private clearPendingStructurePlacement(unit: SimUnit): void {
    unit.pendingStructurePlacement = null;
  }

  private clearBuildJob(unit: SimUnit): void {
    unit.buildStructureTargetId = null;
  }

  private placeStructureIfPossible(
    state: GameState,
    playerId: string,
    kind: PlaceableStructureKind,
    gx: number,
    gz: number,
    builderUnit?: SimUnit
  ): SimStructure | null {
    const { footW, footD } = footprintForStructureKind(kind);
    if (!canPlaceStructureFootprint(state, gx, gz, footW, footD)) return null;
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    const placeCost = resourcesForPlaceStructure(kind);
    if (player.resources.energy < placeCost.energy || player.resources.minerals < placeCost.minerals) return null;

    player.resources.energy -= placeCost.energy;
    player.resources.minerals -= placeCost.minerals;
    const team = playerTeamForPlayerId(playerId);
    const hp = maxHpForPlacedStructure(kind);
    const buildRemainingSec = this.buildTimeForStructureKind(kind);
    const placed = makeStructure(playerId, team, kind, gx, gz, footW, footD, hp, buildRemainingSec, buildRemainingSec);
    state.structures.push(placed);

    if (builderUnit) {
      this.clearPendingStructurePlacement(builderUnit);
      if (builderUnit.kind === "N") {
        if (builderUnit.gatherTargetFieldId) {
          builderUnit.resumeGatherFieldId = builderUnit.gatherTargetFieldId;
        }
        builderUnit.gatherTargetFieldId = null;
        builderUnit.gatherMineralPulseAccumSec = 0;
        builderUnit.depositStructureTargetId = null;
      }
      builderUnit.attackMoveTarget = null;
      builderUnit.moveWaypointQueue = [];
      if (placed.buildRemainingSec > 0) {
        const siteC = structureCenter(placed);
        builderUnit.buildStructureTargetId = placed.id;
        builderUnit.moveTarget = { x: siteC.x, y: siteC.y, z: siteC.z };
      } else {
        builderUnit.buildStructureTargetId = null;
        builderUnit.moveTarget = null;
      }
    }
    return placed;
  }

  private queuePendingStructurePlacement(
    state: GameState,
    unit: SimUnit,
    kind: PlaceableStructureKind,
    gx: number,
    gz: number
  ): void {
    const { footW, footD } = footprintForStructureKind(kind);
    const siteC = footprintCenterWorld(gx, gz, footW, footD);
    unit.pendingStructurePlacement = { kind, gx, gz };
    unit.moveTarget = { x: siteC.x, y: siteC.y, z: siteC.z };
    unit.attackMoveTarget = null;
    unit.moveWaypointQueue = [];
    unit.attackTargetId = null;
    unit.attackStructureTargetId = null;
    unit.gatherTargetFieldId = null;
    unit.gatherMineralPulseAccumSec = 0;
    unit.depositStructureTargetId = null;
    unit.buildStructureTargetId = null;
    unit.resumeGatherFieldId = null;
    this.resetMeleeStuckState(unit);
    void state;
  }

  private applyCommand(state: GameState, command: GameCommand, feedback: UiFeedbackEvent[]): void {
    if (state.victorPlayerId !== null) return;

    const pid = command.playerId;

    switch (command.type) {
      case "noop":
        return;
      case "select_units": {
        const raw = command.payload?.unitIds;
        const ids = asStringArray(raw) ?? [];
        const owned = new Set(state.units.filter((u) => u.playerId === pid).map((u) => u.id));
        state.selections[pid] = ids.filter((id) => owned.has(id));
        state.structureSelections[pid] = [];
        return;
      }
      case "select_structures": {
        const raw = command.payload?.structureIds;
        const ids = asStringArray(raw) ?? [];
        const owned = new Set(
          state.structures.filter((s) => s.playerId === pid && s.hp > 0).map((s) => s.id)
        );
        state.structureSelections[pid] = ids.filter((id) => owned.has(id));
        state.selections[pid] = [];
        return;
      }
      case "select_units_and_structures": {
        const rawU = asStringArray(command.payload?.unitIds) ?? [];
        const rawS = asStringArray(command.payload?.structureIds) ?? [];
        const ownedU = new Set(state.units.filter((u) => u.playerId === pid).map((u) => u.id));
        const ownedS = new Set(
          state.structures.filter((s) => s.playerId === pid && s.hp > 0).map((s) => s.id)
        );
        state.selections[pid] = rawU.filter((id) => ownedU.has(id));
        state.structureSelections[pid] = rawS.filter((id) => ownedS.has(id));
        return;
      }
      case "move_units": {
        const target = asVec3(command.payload?.target);
        if (!target) {
          feedback.push({ kind: "move", playerId: pid, status: "rejected", reason: "bad_target" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        const hasUnits = ids.some((id) => {
          const u = state.units.find((x) => x.id === id);
          return !!u && u.playerId === pid;
        });
        if (!hasUnits) {
          feedback.push({ kind: "move", playerId: pid, status: "rejected", reason: "bad_target" });
          return;
        }
        const formation = parseFormationId(command.payload?.formation);
        const keepResumeGatherIntent = command.payload?.keepResumeGatherIntent === true;
        const constructionStructureId =
          typeof command.payload?.constructionStructureId === "string"
            ? command.payload.constructionStructureId
            : null;
        this.assignGroupMoveDestinations(
          state,
          pid,
          ids,
          target,
          formation,
          false,
          keepResumeGatherIntent,
          constructionStructureId
        );
        feedback.push({ kind: "move", playerId: pid, status: "ok" });
        return;
      }
      case "queue_move_waypoint": {
        const target = asVec3(command.payload?.target);
        if (!target) {
          feedback.push({ kind: "move", playerId: pid, status: "rejected", reason: "bad_target" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        const maxSegments = 8;
        let any = false;
        for (const id of ids) {
          const u = state.units.find((x) => x.id === id);
          if (!u || u.playerId !== pid) continue;
          const hasLeg = !!(u.moveTarget || u.attackMoveTarget);
          const pending = (hasLeg ? 1 : 0) + u.moveWaypointQueue.length;
          if (pending >= maxSegments) continue;
          u.attackMoveTarget = null;
          if (!u.moveTarget) {
            u.moveTarget = { x: target.x, y: target.y, z: target.z };
          } else {
            u.moveWaypointQueue.push({ x: target.x, y: target.y, z: target.z });
          }
          this.clearPendingStructurePlacement(u);
          this.clearBuildJob(u);
          any = true;
        }
        feedback.push({
          kind: "move",
          playerId: pid,
          status: any ? "ok" : "rejected",
          reason: any ? undefined : "queue_full"
        });
        return;
      }
      case "attack_move_units": {
        const target = asVec3(command.payload?.target);
        if (!target) {
          feedback.push({ kind: "attack_move", playerId: pid, status: "rejected", reason: "bad_target" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        const hasUnits = ids.some((id) => {
          const u = state.units.find((x) => x.id === id);
          return !!u && u.playerId === pid;
        });
        if (!hasUnits) {
          feedback.push({ kind: "attack_move", playerId: pid, status: "rejected", reason: "bad_target" });
          return;
        }
        const formation = parseFormationId(command.payload?.formation);
        this.assignGroupMoveDestinations(state, pid, ids, target, formation, true, false);
        feedback.push({ kind: "attack_move", playerId: pid, status: "ok" });
        return;
      }
      case "attack_unit": {
        const tid = command.payload?.targetUnitId;
        if (typeof tid !== "string") {
          feedback.push({ kind: "attack_unit", playerId: pid, status: "rejected" });
          return;
        }
        const targetUnit = state.units.find((x) => x.id === tid);
        if (!targetUnit || targetUnit.playerId === pid) {
          feedback.push({ kind: "attack_unit", playerId: pid, status: "rejected" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        let anyAttack = false;
        for (const id of ids) {
          const u = state.units.find((x) => x.id === id);
          if (!u || u.playerId !== pid) continue;
          u.attackTargetId = tid;
          u.attackStructureTargetId = null;
          u.gatherTargetFieldId = null;
          u.gatherMineralPulseAccumSec = 0;
          u.resumeGatherFieldId = null;
          u.moveWaypointQueue = [];
          u.depositStructureTargetId = null;
          u.moveTarget = null;
          u.attackMoveTarget = null;
          this.clearPendingStructurePlacement(u);
          this.clearBuildJob(u);
          this.resetMeleeStuckState(u);
          anyAttack = true;
        }
        feedback.push({ kind: "attack_unit", playerId: pid, status: anyAttack ? "ok" : "rejected" });
        return;
      }
      case "attack_structure": {
        const sid = command.payload?.targetStructureId;
        if (typeof sid !== "string") {
          feedback.push({ kind: "attack_structure", playerId: pid, status: "rejected" });
          return;
        }
        const st = state.structures.find((x) => x.id === sid);
        if (!st || st.playerId === pid) {
          feedback.push({ kind: "attack_structure", playerId: pid, status: "rejected" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        let anyAttack = false;
        for (const id of ids) {
          const u = state.units.find((x) => x.id === id);
          if (!u || u.playerId !== pid) continue;
          u.attackStructureTargetId = sid;
          u.attackTargetId = null;
          u.gatherTargetFieldId = null;
          u.gatherMineralPulseAccumSec = 0;
          u.resumeGatherFieldId = null;
          u.moveWaypointQueue = [];
          u.depositStructureTargetId = null;
          u.moveTarget = null;
          u.attackMoveTarget = null;
          this.clearPendingStructurePlacement(u);
          this.clearBuildJob(u);
          this.resetMeleeStuckState(u);
          anyAttack = true;
        }
        feedback.push({ kind: "attack_structure", playerId: pid, status: anyAttack ? "ok" : "rejected" });
        return;
      }
      case "queue_structure_train": {
        const sid = command.payload?.structureId;
        if (typeof sid !== "string") {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        const st = state.structures.find((x) => x.id === sid);
        if (!st || st.playerId !== pid || st.hp <= 0) {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        if (!isStructureBuilt(st)) {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        const prodKind = structureProducesKind(st);
        if (!prodKind) {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        const player = state.players.find((p) => p.id === pid);
        if (!player) {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        const trainCost = resourcesForTrainKind(prodKind);
        const { energy, minerals } = player.resources;
        if (energy < trainCost.energy || minerals < trainCost.minerals) {
          feedback.push({ kind: "train_unit", playerId: pid, status: "rejected" });
          return;
        }
        player.resources.energy -= trainCost.energy;
        player.resources.minerals -= trainCost.minerals;
        st.productionQueue.push({
          kind: prodKind,
          remainingSec: BARRACKS_TRAIN_TIME_SEC
        });
        feedback.push({ kind: "train_unit", playerId: pid, status: "ok" });
        return;
      }
      case "place_structure": {
        const kind = asPlaceableStructureKind(command.payload?.kind);
        const gx = asGridCoord(command.payload?.gx);
        const gz = asGridCoord(command.payload?.gz);
        if (kind === null || gx === null || gz === null) {
          feedback.push({ kind: "place_structure", playerId: pid, status: "rejected" });
          return;
        }
        const { footW, footD } = footprintForStructureKind(kind);
        const builderId = this.resolveStructurePlacementBuilder(
          state,
          pid,
          command.payload,
          gx,
          gz,
          footW,
          footD
        );
        if (!builderId) {
          feedback.push({ kind: "place_structure", playerId: pid, status: "rejected", structureKind: kind });
          return;
        }
        const builderU = state.units.find((x) => x.id === builderId);
        if (!builderU) {
          feedback.push({ kind: "place_structure", playerId: pid, status: "rejected", structureKind: kind });
          return;
        }
        if (canPlaceStructureForPlayer(state, pid, gx, gz, footW, footD, kind)) {
          const placed = this.placeStructureIfPossible(state, pid, kind, gx, gz, builderU);
          feedback.push({
            kind: "place_structure",
            playerId: pid,
            status: placed ? "ok" : "rejected",
            structureKind: kind
          });
          return;
        }
        const explored = isFootprintExploredForPlayer(state, pid, gx, gz, footW, footD);
        if (!explored && canPlanStructureFootprint(state, gx, gz, footW, footD)) {
          this.queuePendingStructurePlacement(state, builderU, kind, gx, gz);
          feedback.push({ kind: "place_structure", playerId: pid, status: "ok", structureKind: kind });
          return;
        }
        feedback.push({ kind: "place_structure", playerId: pid, status: "rejected", structureKind: kind });
        return;
      }
      case "gather_from_field": {
        const fid = command.payload?.fieldId;
        if (typeof fid !== "string") {
          feedback.push({ kind: "gather", playerId: pid, status: "rejected", reason: "invalid_field" });
          return;
        }
        const fld = state.resourceFields.find((f) => f.id === fid);
        if (!fld || (fld.reserve !== null && fld.reserve <= 0)) {
          feedback.push({
            kind: "gather",
            playerId: pid,
            status: "rejected",
            fieldId: fid,
            reason: "invalid_field"
          });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        if (ids.length === 0) {
          feedback.push({
            kind: "gather",
            playerId: pid,
            status: "rejected",
            fieldId: fid,
            reason: "no_units_selected"
          });
          return;
        }

        const assignGather = (unitIds: string[]): void => {
          for (const id of unitIds) {
            const u = state.units.find((x) => x.id === id);
            if (!u || u.playerId !== pid) continue;
            u.gatherTargetFieldId = fid;
            u.gatherMineralPulseAccumSec = 0;
            u.resumeGatherFieldId = null;
            u.moveWaypointQueue = [];
            u.attackTargetId = null;
            u.attackStructureTargetId = null;
            u.depositStructureTargetId = null;
            u.moveTarget = null;
            u.attackMoveTarget = null;
            this.clearPendingStructurePlacement(u);
            this.clearBuildJob(u);
            this.resetMeleeStuckState(u);
          }
        };

        if (fld.kind === "minerals") {
          const minerIds = ids.filter((id) => {
            const u = state.units.find((x) => x.id === id);
            return !!u && u.playerId === pid && u.kind === "N";
          });
          if (minerIds.length === 0) {
            feedback.push({
              kind: "gather",
              playerId: pid,
              status: "rejected",
              fieldId: fid,
              reason: "no_neutral_units"
            });
            return;
          }
          assignGather(minerIds);
          feedback.push({ kind: "gather", playerId: pid, status: "started", fieldId: fid });
          return;
        }

        feedback.push({
          kind: "gather",
          playerId: pid,
          status: "rejected",
          fieldId: fid,
          reason: "energy_not_mined"
        });
        return;
      }
      case "deposit_at_structure": {
        const sid = command.payload?.targetStructureId;
        if (typeof sid !== "string") {
          feedback.push({ kind: "deposit", playerId: pid, status: "rejected" });
          return;
        }
        const st = state.structures.find((x) => x.id === sid);
        if (!st || st.playerId !== pid || st.hp <= 0) {
          feedback.push({ kind: "deposit", playerId: pid, status: "rejected" });
          return;
        }
        if (st.kind !== "home" && st.kind !== "mineral_depot") {
          feedback.push({ kind: "deposit", playerId: pid, status: "rejected" });
          return;
        }
        if (!isStructureBuilt(st)) {
          feedback.push({ kind: "deposit", playerId: pid, status: "rejected" });
          return;
        }
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        let any = false;
        for (const id of ids) {
          const u = state.units.find((x) => x.id === id);
          if (!u || u.playerId !== pid || u.kind !== "N") continue;
          u.depositStructureTargetId = sid;
          u.gatherMineralPulseAccumSec = 0;
          u.moveWaypointQueue = [];
          u.attackTargetId = null;
          u.attackStructureTargetId = null;
          u.moveTarget = null;
          u.attackMoveTarget = null;
          this.clearPendingStructurePlacement(u);
          this.clearBuildJob(u);
          this.resetMeleeStuckState(u);
          any = true;
        }
        feedback.push({ kind: "deposit", playerId: pid, status: any ? "ok" : "rejected" });
        return;
      }
      case "stop_units": {
        const ids = this.resolveUnitIds(state, pid, command.payload?.unitIds);
        let any = false;
        for (const id of ids) {
          const u = state.units.find((x) => x.id === id);
          if (!u || u.playerId !== pid) continue;
          u.moveTarget = null;
          u.attackMoveTarget = null;
          u.moveWaypointQueue = [];
          u.resumeGatherFieldId = null;
          this.clearPendingStructurePlacement(u);
          this.clearBuildJob(u);
          u.attackTargetId = null;
          u.attackStructureTargetId = null;
          u.gatherTargetFieldId = null;
          u.gatherMineralPulseAccumSec = 0;
          u.depositStructureTargetId = null;
          this.resetMeleeStuckState(u);
          any = true;
        }
        if (any) feedback.push({ kind: "stop", playerId: pid, status: "ok" });
        return;
      }
      case "advance_age":
        state.turn = { ...state.turn, phase: "resolving" };
        return;
      case "queue_unit":
        return;
      case "set_rally": {
        const fromPayload = asStringArray(command.payload?.structureIds);
        const resolved =
          fromPayload && fromPayload.length > 0
            ? fromPayload
            : [...(state.structureSelections[pid] ?? [])];
        if (resolved.length === 0) {
          feedback.push({
            kind: "rally_set",
            playerId: pid,
            status: "rejected",
            reason: "bad_target"
          });
          return;
        }

        const minePayload = command.payload?.mineFieldId;
        const mineFid = typeof minePayload === "string" ? minePayload : null;
        let rally: Vec3;
        let mineFieldIdToStore: string | null = null;

        if (mineFid) {
          const fld = state.resourceFields.find((f) => f.id === mineFid);
          if (
            !fld ||
            fld.kind !== "minerals" ||
            (fld.reserve !== null && fld.reserve <= 0)
          ) {
            feedback.push({
              kind: "rally_set",
              playerId: pid,
              status: "rejected",
              reason: "invalid_mine_field"
            });
            return;
          }
          const c = resourceFieldCenterWorld(fld);
          rally = { x: c.x, y: c.y, z: c.z };
          mineFieldIdToStore = mineFid;
        } else {
          const target = asVec3(command.payload?.target);
          if (!target) {
            feedback.push({
              kind: "rally_set",
              playerId: pid,
              status: "rejected",
              reason: "bad_target"
            });
            return;
          }
          rally = { x: target.x, y: 0.55, z: target.z };
          mineFieldIdToStore = null;
        }

        let any = false;
        for (const sid of resolved) {
          const st = state.structures.find((x) => x.id === sid);
          if (!st || st.playerId !== pid || st.hp <= 0) continue;
          if (structureProducesKind(st) === null) continue;
          st.rallyPoint = { ...rally };
          st.rallyMineFieldId = mineFieldIdToStore;
          any = true;
        }
        feedback.push({
          kind: "rally_set",
          playerId: pid,
          status: any ? "ok" : "rejected",
          reason: any ? undefined : "no_valid_structures",
          mineFieldId: any && mineFieldIdToStore ? mineFieldIdToStore : undefined
        });
        return;
      }
      default:
        return;
    }
  }

  private resolveUnitIds(state: GameState, playerId: string, payloadUnitIds: unknown): string[] {
    const fromPayload = asStringArray(payloadUnitIds);
    if (fromPayload && fromPayload.length > 0) {
      return fromPayload;
    }
    return [...(state.selections[playerId] ?? [])];
  }

  private assignGroupMoveDestinations(
    state: GameState,
    playerId: string,
    ids: string[],
    target: Vec3,
    formation: FormationId,
    attackMove: boolean,
    keepResumeGatherIntent: boolean,
    constructionStructureId: string | null = null
  ): void {
    const units = ids
      .map((id) => state.units.find((u) => u.id === id))
      .filter((u): u is SimUnit => !!u && u.playerId === playerId);
    units.sort((a, b) => a.id.localeCompare(b.id));
    if (units.length === 0) return;

    const centroid = squadCentroid(units.map((u) => u.position));
    const slots = computeFormationSlots(
      formation,
      units.length,
      target,
      centroid,
      tuning.formation.spacing,
      tuning.formation.circleRadiusPerSqrtUnit,
      tuning.formation.triangleApexLead
    );

    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      const dest = slots[i] ?? target;
      let preserveResume = keepResumeGatherIntent;
      if (
        !preserveResume &&
        !attackMove &&
        u.kind === "N" &&
        u.gatherTargetFieldId &&
        moveDestinationIsUnfinishedFriendlyStructure(state, playerId, dest)
      ) {
        u.resumeGatherFieldId = u.gatherTargetFieldId;
        preserveResume = true;
      }
      u.moveTarget = { x: dest.x, y: dest.y, z: dest.z };
      u.attackMoveTarget = attackMove ? { x: dest.x, y: dest.y, z: dest.z } : null;
      u.moveWaypointQueue = [];
      if (!preserveResume) {
        u.resumeGatherFieldId = null;
      }
      u.attackTargetId = null;
      u.attackStructureTargetId = null;
      u.gatherTargetFieldId = null;
      u.gatherMineralPulseAccumSec = 0;
      u.depositStructureTargetId = null;
      this.clearPendingStructurePlacement(u);
      this.clearBuildJob(u);
      if (!attackMove && u.kind === "N" && constructionStructureId) {
        const site = state.structures.find(
          (s) =>
            s.id === constructionStructureId &&
            s.playerId === playerId &&
            s.hp > 0 &&
            s.buildRemainingSec > 0
        );
        if (site) {
          u.buildStructureTargetId = site.id;
        }
      }
      this.resetMeleeStuckState(u);
    }
  }

  private resetMeleeStuckState(u: SimUnit): void {
    u.stuckChasingAttackTargetSec = 0;
    u.chaseDistToAttackTargetPrev = null;
  }

  /**
   * Built defensive structures fire ranged batteries. Command Core keeps its short-range neutral-strength
   * battery; Defense Turrets are dedicated towers with longer sight/range and 1.62x neutral-line damage.
   */
  private simulateStructureDefense(
    state: GameState,
    deltaSeconds: number,
    events: SimulationEvent[],
    deadIds: Set<string>
  ): void {
    for (const defensive of state.structures) {
      const stats = defensiveStructureStats(defensive.kind);
      if (!stats || defensive.hp <= 0 || !isStructureBuilt(defensive)) continue;

      defensive.homeDefenseCooldownRemainingSec = Math.max(
        0,
        (defensive.homeDefenseCooldownRemainingSec ?? 0) - deltaSeconds
      );

      const hc = structureCenter(defensive);
      let best: SimUnit | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const u of state.units) {
        if (u.hp <= 0 || deadIds.has(u.id)) continue;
        if (u.team === defensive.team) continue;
        const d =
          defensive.kind === "defense_obelisk"
            ? sphereGeodesicDistanceWorldXZ(hc.x, hc.z, u.position.x, u.position.z)
            : Math.sqrt(
                distancePointXZToFootprintEdgesWithMarginWrapped(
                  u.position.x,
                  u.position.z,
                  defensive.gx,
                  defensive.gz,
                  defensive.footW,
                  defensive.footD,
                  0
                ) ** 2 + (u.position.y - hc.y) ** 2
              );
        if (d > stats.acquireRange) continue;
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      if (!best || bestD > stats.fireRange + 1e-4) continue;
      if (defensive.homeDefenseCooldownRemainingSec > 0) continue;

      const mult = rpsDamageMultiplier("N", best.kind);
      const damage = stats.damage * mult;
      const hitPos = { ...best.position };
      const defenderHpBefore = best.hp;
      best.hp -= damage;
      const fromKey = `${stats.attackerKeyPrefix}:${defensive.id}`;
      best.damageReceivedFromUnitId[fromKey] = (best.damageReceivedFromUnitId[fromKey] ?? 0) + damage;
      const defenderHpAfter = best.hp;
      if (best.hp <= 0) deadIds.add(best.id);

      defensive.homeDefenseCooldownRemainingSec = stats.cooldownSec;

      const muzzleY = hc.y + stats.muzzleYOffset;
      const ev: DamageDealtEvent = {
        type: "damage_dealt",
        targetUnitId: best.id,
        attackerUnitId: fromKey,
        amount: Math.round(damage * 10) / 10,
        position: { x: hitPos.x, y: hitPos.y, z: hitPos.z },
        attackerPosition: { x: hc.x, y: muzzleY, z: hc.z },
        attackClass: "ranged",
        attackerKind: "N",
        defenderKind: best.kind,
        rpsMultiplier: mult,
        baseDamage: stats.damage,
        defenderHpBefore,
        defenderHpAfter
      };
      events.push(ev);
    }
  }

  private processBuildJobForUnit(unit: SimUnit, state: GameState, deltaSeconds: number): boolean {
    if (unit.kind !== "N" || unit.hp <= 0 || unit.buildStructureTargetId === null) return false;
    const site = state.structures.find((s) => s.id === unit.buildStructureTargetId);
    if (!site || site.playerId !== unit.playerId || site.hp <= 0) {
      this.clearBuildJob(unit);
      return false;
    }
    if (site.buildRemainingSec <= 0) {
      this.clearBuildJob(unit);
      if (unit.moveTarget && moveDestinationIsUnfinishedFriendlyStructure(state, unit.playerId, unit.moveTarget)) {
        unit.moveTarget = null;
        unit.attackMoveTarget = null;
      }
      tryApplyNeutralMinerResumeGather(state, unit);
      return false;
    }

    unit.attackTargetId = null;
    unit.attackStructureTargetId = null;
    unit.attackMoveTarget = null;
    unit.moveWaypointQueue = [];
    unit.gatherTargetFieldId = null;
    unit.gatherMineralPulseAccumSec = 0;
    unit.depositStructureTargetId = null;

    if (neutralMinerInConstructionAssistRange(unit.position.x, unit.position.z, site, state)) {
      unit.moveTarget = null;
      return true;
    }

    const center = structureCenter(site);
    const edge = closestXZPointOnFootprintEdgesWrapped(
      unit.position.x,
      unit.position.z,
      site.gx,
      site.gz,
      site.footW,
      site.footD
    );
    const target = { x: edge.x, y: center.y, z: edge.z };
    unit.moveTarget = target;
    moveGroundUnitTowardPoint(unit, state, target, unit.speed, deltaSeconds);
    return true;
  }

  private simulateWorld(state: GameState, deltaSeconds: number, events: SimulationEvent[]): void {
    if (state.victorPlayerId !== null) return;

    prepareFootprintBlockingIndex(state);

    for (const s of state.structures) {
      if (s.buildRemainingSec > 0) {
        if (isNeutralWorkerContributingToConstruction(state, s)) {
          const workers = countNeutralWorkersContributingToConstruction(state, s);
          const rate = constructionBuildRateScale(workers);
          s.buildRemainingSec = Math.max(0, s.buildRemainingSec - deltaSeconds * rate);
        }
      }
    }

    runDefaultResourceEconomyWorldTick(state, deltaSeconds);

    const deadIds = new Set<string>();

    for (const s of state.structures) {
      if (s.hp <= 0 || s.productionQueue.length === 0) continue;
      if (!isStructureBuilt(s)) continue;
      const head = s.productionQueue[0];
      head.remainingSec -= deltaSeconds;
      if (head.remainingSec <= 0) {
        s.productionQueue.shift();
        const pos = spawnPointNearStructure(s, s.team, state);
        const u = makeSimUnit(s.playerId, s.team, head.kind, pos);
        if (head.kind === "N" && s.rallyMineFieldId) {
          const fld = state.resourceFields.find((f) => f.id === s.rallyMineFieldId);
          if (
            fld &&
            fld.kind === "minerals" &&
            (fld.reserve === null || fld.reserve > 0)
          ) {
            u.gatherTargetFieldId = s.rallyMineFieldId;
            u.gatherMineralPulseAccumSec = 0;
          } else if (s.rallyPoint) {
            u.moveTarget = { x: s.rallyPoint.x, y: s.rallyPoint.y, z: s.rallyPoint.z };
          }
        } else if (s.rallyPoint) {
          u.moveTarget = { x: s.rallyPoint.x, y: s.rallyPoint.y, z: s.rallyPoint.z };
        }
        state.units.push(u);
      }
    }

    for (const unit of state.units) {
      unit.cooldownRemainingSeconds = Math.max(0, unit.cooldownRemainingSeconds - deltaSeconds);
    }

    for (const unit of state.units) {
      if (deadIds.has(unit.id) || unit.hp <= 0) continue;

      tryApplyNeutralMinerResumeGather(state, unit);
      const hasPlainMoveOrder = !!unit.moveTarget && !unit.attackMoveTarget;

      if (this.processBuildJobForUnit(unit, state, deltaSeconds)) {
        continue;
      }

      /**
       * Neutral miners only auto-fight when truly idle. Worker jobs (move, build, gather, haul) keep priority.
       */
      if (
        unit.kind === "N" &&
        !hasPlainMoveOrder &&
        unit.buildStructureTargetId === null &&
        unit.gatherTargetFieldId === null &&
        unit.depositStructureTargetId === null &&
        unit.carriedMinerals <= 0 &&
        !unit.attackTargetId &&
        !unit.attackStructureTargetId
      ) {
        const threat = this.findNearestHostileWithinDistance(
          unit,
          state,
          deadIds,
          unit.visionRange
        );
        if (threat) {
          if (threat.kind === "unit") unit.attackTargetId = threat.u.id;
          else unit.attackStructureTargetId = threat.s.id;
          unit.moveTarget = null;
          unit.attackMoveTarget = null;
          unit.moveWaypointQueue = [];
          this.clearPendingStructurePlacement(unit);
          this.resetMeleeStuckState(unit);
        }
      }

      let focus = this.resolveFocusTarget(unit, state, deadIds);
      if (focus) {
        let pos = hostilePosition(focus);
        let distance = this.attackDistanceUnitToFocus(unit, focus, state);

        if (unit.attackClass === "melee" && focus.kind === "unit" && unit.attackTargetId && distance > unit.attackRange) {
          const prev = unit.chaseDistToAttackTargetPrev;
          if (prev !== null && distance >= prev - 0.04) {
            unit.stuckChasingAttackTargetSec += deltaSeconds;
          } else {
            unit.stuckChasingAttackTargetSec = Math.max(0, unit.stuckChasingAttackTargetSec - deltaSeconds * 0.75);
          }
          unit.chaseDistToAttackTargetPrev = distance;
          if (unit.stuckChasingAttackTargetSec >= 1.15) {
            const alt =
              this.pickNearestDamagerEnemy(unit, state, deadIds) ??
              this.pickClosestOtherHostileInVision(unit, state, deadIds, unit.attackTargetId);
            if (alt && alt.id !== unit.attackTargetId) {
              unit.attackTargetId = alt.id;
              unit.stuckChasingAttackTargetSec = 0;
              unit.chaseDistToAttackTargetPrev = null;
              const f2 = this.resolveFocusTarget(unit, state, deadIds);
              if (f2) {
                focus = f2;
                pos = hostilePosition(focus);
                distance = this.attackDistanceUnitToFocus(unit, f2, state);
              }
            }
          }
        } else {
          unit.stuckChasingAttackTargetSec = 0;
          unit.chaseDistToAttackTargetPrev = null;
        }

        if (distance <= unit.attackRange) {
          unit.stuckChasingAttackTargetSec = 0;
          unit.chaseDistToAttackTargetPrev = null;
          if (unit.cooldownRemainingSeconds <= 0) {
            this.applyStrike(unit, focus, state, events, deadIds);
          }
          continue;
        }
        moveGroundUnitTowardPoint(unit, state, pos, unit.speed, deltaSeconds);
        continue;
      }

      unit.stuckChasingAttackTargetSec = 0;
      unit.chaseDistToAttackTargetPrev = null;

      assignAutoDepositForGatheringMiner(unit, state);

      if (processDepositForUnit(unit, state, deltaSeconds, deadIds)) {
        continue;
      }

      if (processGatheringForUnit(unit, state, deltaSeconds, deadIds, events)) {
        continue;
      }

      /**
       * Auto-engage: idle military (and idle **N** with no gather/deposit job) acquire hostiles in **vision**.
       * Plain `move_units` does not scan (march through without stopping for fights). `attack_move_units`
       * scans while advancing.
       */
      const workerIdleForCombat =
        unit.kind === "N" &&
        !unit.gatherTargetFieldId &&
        !unit.depositStructureTargetId &&
        unit.buildStructureTargetId === null &&
        unit.carriedMinerals === 0;
      const militaryEligible = unit.kind !== "N" || workerIdleForCombat;
      const idle = !unit.moveTarget && !unit.attackMoveTarget;
      const attackMoving = !!unit.attackMoveTarget;
      const shouldAutoAcquire = militaryEligible && (idle || attackMoving);

      if (shouldAutoAcquire) {
        const nearest = this.findNearestHostileWithinDistance(unit, state, deadIds, unit.visionRange);
        if (nearest) {
          const pos = hostilePosition(nearest);
          const distance = this.attackDistanceUnitToFocus(unit, nearest, state);
          if (distance <= unit.attackRange) {
            if (unit.cooldownRemainingSeconds <= 0) {
              this.applyStrike(unit, nearest, state, events, deadIds);
            }
            continue;
          }
          moveGroundUnitTowardPoint(unit, state, pos, unit.speed, deltaSeconds);
          continue;
        }
      }

      if (unit.moveTarget) {
        if (unit.kind === "N" && unit.pendingStructurePlacement) {
          const pending = unit.pendingStructurePlacement;
          const { footW, footD } = footprintForStructureKind(pending.kind);
          const siteC = footprintCenterWorld(pending.gx, pending.gz, footW, footD);
          if (sphereGeodesicDistanceWorldXZ(unit.position.x, unit.position.z, siteC.x, siteC.z) < 0.65) {
            this.placeStructureIfPossible(
              state,
              unit.playerId,
              pending.kind,
              pending.gx,
              pending.gz,
              unit
            );
            this.clearPendingStructurePlacement(unit);
            unit.moveTarget = null;
            unit.attackMoveTarget = null;
            unit.moveWaypointQueue = [];
            continue;
          }
        }
        const dy = unit.moveTarget.y - unit.position.y;
        const len = Math.hypot(
          sphereGeodesicDistanceWorldXZ(
            unit.position.x,
            unit.position.z,
            unit.moveTarget.x,
            unit.moveTarget.z
          ),
          dy
        );
        /**
         * Do not treat “close to waypoint” as arrival for neutral miners ordered onto an unfinished pad: the
         * formation slot can sit outside build-assist range, leaving them idle without counting construction
         * down until the player re-clicks. Keep the move order until `neutralMinerArrivedToAssistConstruction`
         * or sliding reaches assist range.
         */
        const assistConstructionMove =
          unit.kind === "N" &&
          moveDestinationIsUnfinishedFriendlyStructure(state, unit.playerId, unit.moveTarget);
        const arrivedAtWaypoint = len < 0.15;
        const shouldClearMove =
          neutralMinerArrivedToAssistConstruction(unit, state) ||
          (arrivedAtWaypoint && !assistConstructionMove);
        if (shouldClearMove) {
          unit.moveTarget = null;
          unit.attackMoveTarget = null;
          if (unit.moveWaypointQueue.length > 0) {
            const next = unit.moveWaypointQueue.shift()!;
            unit.moveTarget = { x: next.x, y: next.y, z: next.z };
          }
        } else {
          moveGroundUnitTowardPoint(unit, state, unit.moveTarget, unit.speed, deltaSeconds);
        }
      }
    }

    this.simulateStructureDefense(state, deltaSeconds, events, deadIds);

    removeDepletedResourceFields(state);

    this.resolveOverlaps(state.units);
    this.resolveUnitStructureFootprintPush(state);
    this.clearNeutralMoveTargetsWhenAtConstructionSite(state);

    if (deadIds.size > 0) {
      state.units = state.units.filter((u) => !deadIds.has(u.id));
      for (const u of state.units) {
        if (u.attackTargetId && deadIds.has(u.attackTargetId)) {
          u.attackTargetId = null;
        }
      }
      for (const key of Object.keys(state.selections)) {
        state.selections[key] = (state.selections[key] ?? []).filter((id) => !deadIds.has(id));
      }
    }

    const deadStructIds = new Set<string>();
    for (const s of state.structures) {
      if (s.hp <= 0) {
        deadStructIds.add(s.id);
        if (s.kind === "home" && state.victorPlayerId === null) {
          const w = winnerWhenCommandCoreDestroyed(state, s.playerId);
          if (w !== null) state.victorPlayerId = w;
        }
      }
    }
    if (deadStructIds.size > 0) {
      state.structures = state.structures.filter((s) => s.hp > 0);
      for (const u of state.units) {
        if (u.attackStructureTargetId && deadStructIds.has(u.attackStructureTargetId)) {
          u.attackStructureTargetId = null;
        }
      }
      for (const key of Object.keys(state.structureSelections)) {
        state.structureSelections[key] = (state.structureSelections[key] ?? []).filter(
          (id) => !deadStructIds.has(id)
        );
      }
    }

    advanceExploration(state);
  }

  /**
   * Range check for strikes: units vs **structures** use distance to the collision-expanded footprint
   * (plus vertical delta to center), so melee at the pad edge can hit large buildings like the Core.
   */
  private attackDistanceUnitToFocus(unit: SimUnit, focus: HostileTarget, state: GameState): number {
    if (focus.kind === "unit") {
      return sphericalDistance3(unit.position, focus.u.position);
    }
    const s = focus.s;
    const c = structureCenter(s);
    if (unit.attackClass === "ranged") {
      return sphericalDistance3(unit.position, c);
    }
    const xz = distancePointXZToFootprintEdgesWithMarginWrapped(
      unit.position.x,
      unit.position.z,
      s.gx,
      s.gz,
      s.footW,
      s.footD,
      FOOTPRINT_UNIT_COLLISION_MARGIN
    );
    const dy = unit.position.y - c.y;
    return Math.sqrt(xz * xz + dy * dy);
  }

  private resolveFocusTarget(
    unit: SimUnit,
    state: GameState,
    deadIds: Set<string>
  ): HostileTarget | null {
    if (unit.attackStructureTargetId) {
      const s = state.structures.find((x) => x.id === unit.attackStructureTargetId);
      if (s && s.team !== unit.team && s.hp > 0) {
        return { kind: "structure", s };
      }
      unit.attackStructureTargetId = null;
    }
    if (unit.attackTargetId) {
      const t = state.units.find((u) => u.id === unit.attackTargetId);
      if (t && t.team !== unit.team && t.hp > 0 && !deadIds.has(t.id)) {
        return { kind: "unit", u: t };
      }
      unit.attackTargetId = null;
    }
    return null;
  }

  /** Among enemies who have damaged this unit, pick the closest alive one (melee retarget when pathing is blocked). */
  private pickNearestDamagerEnemy(
    unit: SimUnit,
    state: GameState,
    deadIds: Set<string>
  ): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const [aid, dmg] of Object.entries(unit.damageReceivedFromUnitId)) {
      if (dmg <= 0) continue;
      const other = state.units.find(
        (u) => u.id === aid && !deadIds.has(u.id) && u.hp > 0 && u.team !== unit.team
      );
      if (!other) continue;
      const d = sphericalDistance3(unit.position, other.position);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /** Closest hostile in vision other than `excludeId` (fallback when no damage history yet). */
  private pickClosestOtherHostileInVision(
    unit: SimUnit,
    state: GameState,
    deadIds: Set<string>,
    excludeId: string | null
  ): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const o of state.units) {
      if (o.id === unit.id || deadIds.has(o.id) || o.hp <= 0 || o.team === unit.team) continue;
      if (excludeId !== null && o.id === excludeId) continue;
      const d = sphericalDistance3(unit.position, o.position);
      if (d <= unit.visionRange && d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** Nearest enemy unit or structure within `maxDistance` (use `visionRange` for “in sight” acquisition). */
  private findNearestHostileWithinDistance(
    unit: SimUnit,
    state: GameState,
    deadIds: Set<string>,
    maxDistance: number
  ): HostileTarget | null {
    let best: HostileTarget | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const other of state.units) {
      if (other.id === unit.id || deadIds.has(other.id) || other.hp <= 0) continue;
      if (other.team === unit.team) continue;
      const d = sphericalDistance3(unit.position, other.position);
      if (d > maxDistance) continue;
      if (d < bestDist) {
        bestDist = d;
        best = { kind: "unit", u: other };
      }
    }

    for (const s of state.structures) {
      if (s.hp <= 0 || s.team === unit.team) continue;
      const d = sphericalDistance3(unit.position, structureCenter(s));
      if (d > maxDistance) continue;
      if (d < bestDist) {
        bestDist = d;
        best = { kind: "structure", s };
      }
    }

    return best;
  }

  private applyStrike(
    attacker: SimUnit,
    target: HostileTarget,
    state: GameState,
    events: SimulationEvent[],
    deadIds: Set<string>
  ): void {
    let damage: number;
    let hitPos: Vec3;
    let targetUnitId: string | undefined;
    let targetStructureId: string | undefined;

    if (target.kind === "unit") {
      const mult = rpsDamageMultiplier(attacker.kind, target.u.kind);
      damage = attacker.attackDamage * mult;
      hitPos = { ...target.u.position };
      targetUnitId = target.u.id;
      const defenderHpBefore = target.u.hp;
      target.u.hp -= damage;
      target.u.damageReceivedFromUnitId[attacker.id] =
        (target.u.damageReceivedFromUnitId[attacker.id] ?? 0) + damage;
      const defenderHpAfter = target.u.hp;
      if (target.u.hp > 0) {
        this.provokeNearbyDefenders(state, deadIds, target.u, attacker);
      }
      if (target.u.hp <= 0) deadIds.add(target.u.id);

      const ev: DamageDealtEvent = {
        type: "damage_dealt",
        targetUnitId,
        targetStructureId,
        attackerUnitId: attacker.id,
        amount: Math.round(damage * 10) / 10,
        position: { x: hitPos.x, y: hitPos.y, z: hitPos.z },
        attackerPosition: { x: attacker.position.x, y: attacker.position.y, z: attacker.position.z },
        attackClass: attacker.attackClass,
        attackerKind: attacker.kind,
        defenderKind: target.u.kind,
        rpsMultiplier: mult,
        baseDamage: attacker.attackDamage,
        defenderHpBefore,
        defenderHpAfter
      };
      events.push(ev);
    } else {
      damage = attacker.attackDamage;
      hitPos = { ...structureCenter(target.s) };
      targetStructureId = target.s.id;
      const structureHpBefore = target.s.hp;
      target.s.hp -= damage;
      const structureHpAfter = target.s.hp;

      const ev: DamageDealtEvent = {
        type: "damage_dealt",
        targetUnitId,
        targetStructureId,
        attackerUnitId: attacker.id,
        amount: Math.round(damage * 10) / 10,
        position: { x: hitPos.x, y: hitPos.y, z: hitPos.z },
        attackerPosition: { x: attacker.position.x, y: attacker.position.y, z: attacker.position.z },
        attackClass: attacker.attackClass,
        attackerKind: attacker.kind,
        targetStructureKind: target.s.kind,
        structureHpBefore,
        structureHpAfter
      };
      events.push(ev);
    }
    attacker.cooldownRemainingSeconds = attacker.attackCooldownSeconds;
  }

  /**
   * When combat starts near workers, nearby friendlies should defend instead of continuing gather/deposit.
   * This keeps local fights from being one-sided while still requiring line-of-sight proximity.
   */
  private provokeNearbyDefenders(
    state: GameState,
    deadIds: Set<string>,
    victim: SimUnit,
    attacker: SimUnit
  ): void {
    for (const ally of state.units) {
      if (ally.hp <= 0 || deadIds.has(ally.id)) continue;
      if (ally.playerId !== victim.playerId) continue;
      if (ally.id === attacker.id) continue;
      // Respect explicit plain move commands: player intent to disengage should win.
      if (ally.moveTarget && !ally.attackMoveTarget) continue;
      if (
        ally.kind === "N" &&
        (ally.buildStructureTargetId !== null ||
          ally.gatherTargetFieldId !== null ||
          ally.depositStructureTargetId !== null ||
          ally.carriedMinerals > 0)
      ) {
        continue;
      }
      const isVictim = ally.id === victim.id;
      if (!isVictim && sphericalDistance3(ally.position, attacker.position) > ally.visionRange) continue;

      ally.attackTargetId = attacker.id;
      ally.attackStructureTargetId = null;
      ally.gatherTargetFieldId = null;
      ally.gatherMineralPulseAccumSec = 0;
      ally.depositStructureTargetId = null;
      ally.moveTarget = null;
      ally.attackMoveTarget = null;
      this.resetMeleeStuckState(ally);
    }
  }

  private resolveOverlaps(units: SimUnit[]): void {
    const defaultMinD = tuning.collision.minCenterDistance;
    const passes = tuning.collision.resolvePasses;
    const push = tuning.collision.pushFactor;
    for (let p = 0; p < passes; p += 1) {
      for (let i = 0; i < units.length; i += 1) {
        const a = units[i];
        if (a.hp <= 0) continue;
        for (let j = i + 1; j < units.length; j += 1) {
          const b = units[j];
          if (b.hp <= 0) continue;
          if (isActiveMineralHauler(a) || isActiveMineralHauler(b)) continue;
          const dx = b.position.x - a.position.x;
          const dz = b.position.z - a.position.z;
          const dist = Math.hypot(dx, dz);
          const neutralPair = a.kind === "N" && b.kind === "N";
          const workerPair = neutralPair || a.kind === "N" || b.kind === "N";
          const minD = neutralPair ? 0.72 : workerPair ? 1.05 : defaultMinD;
          if (dist >= minD) continue;
          const overlap = (minD - dist) * (neutralPair ? push * 0.42 : push);
          const exactOverlap = dist < 1e-5;
          const seed = exactOverlap ? i * 92821 + j * 68917 + p * 193 : 0;
          const angle = exactOverlap ? seed : 0;
          const nx = exactOverlap ? Math.cos(angle) : dx / dist;
          const nz = exactOverlap ? Math.sin(angle) : dz / dist;
          a.position.x -= nx * overlap * 0.5;
          a.position.z -= nz * overlap * 0.5;
          b.position.x += nx * overlap * 0.5;
          b.position.z += nz * overlap * 0.5;
        }
      }
    }
  }

  /**
   * After footprint push, miners “blocked” at the pad edge still have a move order; drop it so they count as
   * idle for construction on the next tick.
   */
  private clearNeutralMoveTargetsWhenAtConstructionSite(state: GameState): void {
    for (const unit of state.units) {
      if (unit.hp <= 0 || unit.kind !== "N" || !unit.moveTarget) continue;
      if (neutralMinerArrivedToAssistConstruction(unit, state)) {
        unit.moveTarget = null;
        unit.attackMoveTarget = null;
      }
    }
  }

  /**
   * Keep unit centers outside building footprints when easy, but use a tiny margin so visible
   * buildings do not behave like large invisible walls.
   */
  private resolveUnitStructureFootprintPush(state: GameState): void {
    const margin = FOOTPRINT_UNIT_COLLISION_MARGIN;
    const wrapSpan = GROUND_HALF_EXTENT * 2;
    for (const unit of state.units) {
      if (unit.hp <= 0) continue;
      // Active orders should never be cancelled by footprint ejection jitter; pathing may clip if needed.
      // Economy-owned gather/deposit motion does not set `moveTarget`, but it is still active pathing.
      if (unit.moveTarget || unit.attackMoveTarget || isNeutralMineralPathing(unit)) continue;
      if (unit.kind === "N" && isNeutralWorkerAdvancingConstruction(state, unit)) continue;
      let { x: px, z: pz } = unit.position;
      // Multi-pass ejection prevents units from remaining embedded when pushed into adjacent footprints.
      for (let pass = 0; pass < 3; pass += 1) {
        let moved = false;
        forEachStructureCandidateNearXZ(state, px, pz, (s) => {
          if (s.hp <= 0) return;
          if (unit.kind === "N" && s.playerId === unit.playerId && s.buildRemainingSec > 0) return;
          const baseMinX = GRID_ORIGIN_X + s.gx * GRID_CELL_SIZE - margin;
          const baseMaxX = GRID_ORIGIN_X + (s.gx + s.footW) * GRID_CELL_SIZE + margin;
          const baseMinZ = GRID_ORIGIN_Z + s.gz * GRID_CELL_SIZE - margin;
          const baseMaxZ = GRID_ORIGIN_Z + (s.gz + s.footD) * GRID_CELL_SIZE + margin;
          const centerX = (baseMinX + baseMaxX) * 0.5;
          const centerZ = (baseMinZ + baseMaxZ) * 0.5;
          const kxBase = Math.round((px - centerX) / wrapSpan);
          const kzBase = Math.round((pz - centerZ) / wrapSpan);
          let bestPush:
            | { minX: number; maxX: number; minZ: number; maxZ: number; m: number }
            | null = null;
          for (let ox = -1; ox <= 1; ox += 1) {
            for (let oz = -1; oz <= 1; oz += 1) {
              const sx = (kxBase + ox) * wrapSpan;
              const sz = (kzBase + oz) * wrapSpan;
              const minX = baseMinX + sx;
              const maxX = baseMaxX + sx;
              const minZ = baseMinZ + sz;
              const maxZ = baseMaxZ + sz;
              if (px < minX || px > maxX || pz < minZ || pz > maxZ) continue;
              const dL = px - minX;
              const dR = maxX - px;
              const dDn = pz - minZ;
              const dUp = maxZ - pz;
              const m = Math.min(dL, dR, dDn, dUp);
              if (!bestPush || m < bestPush.m) {
                bestPush = { minX, maxX, minZ, maxZ, m };
              }
            }
          }
          if (!bestPush) return;
          const dL = px - bestPush.minX;
          const dR = bestPush.maxX - px;
          const dDn = pz - bestPush.minZ;
          const dUp = bestPush.maxZ - pz;
          const m = Math.min(dL, dR, dDn, dUp);
          /** Corner-stable ejection: float `===` ties flip axis each tick; use tolerance + fixed priority. */
          const tieEps = 0.02;
          const pushOut = 0.1;
          if (dL <= m + tieEps) px = bestPush.minX - pushOut;
          else if (dR <= m + tieEps) px = bestPush.maxX + pushOut;
          else if (dDn <= m + tieEps) pz = bestPush.minZ - pushOut;
          else pz = bestPush.maxZ + pushOut;
          moved = true;
        });
        if (!moved) break;
      }
      unit.position.x = px;
      unit.position.z = pz;
    }
  }

}
