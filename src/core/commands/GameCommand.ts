import type { StructureKind, Vec3 } from "../state/GameState";
import type { FormationId } from "../runtimeTuning";

/** Anything the player can `place_structure` today (Neutral Yard is legacy-only / not buildable). */
export type PlaceableStructureKind = Exclude<StructureKind, "barracks_n">;

export type GameCommandType =
  | "select_units"
  | "select_structures"
  | "select_units_and_structures"
  | "move_units"
  | "queue_move_waypoint"
  | "attack_move_units"
  | "attack_unit"
  | "attack_structure"
  | "queue_structure_train"
  | "place_structure"
  | "gather_from_field"
  | "deposit_at_structure"
  | "stop_units"
  | "queue_unit"
  | "set_rally"
  | "advance_age"
  | "noop";

export interface GameCommand {
  playerId: string;
  type: GameCommandType;
  payload?: Record<string, unknown>;
  issuedAtMs: number;
}

/** Typed payloads for the command pipeline (validated in SimulationEngine). */
export interface SelectUnitsPayload {
  unitIds: string[];
}

export interface SelectStructuresPayload {
  structureIds: string[];
}

/** Sets both selections at once (control groups with units + buildings). */
export interface SelectUnitsAndStructuresPayload {
  unitIds?: string[];
  structureIds?: string[];
}

export interface QueueStructureTrainPayload {
  structureId: string;
}

export interface PlaceStructurePayload {
  kind: PlaceableStructureKind;
  /** Minimum corner cell of the footprint (same convention as `SimStructure.gx` / `gz`). */
  gx: number;
  gz: number;
  /** Friendly **N** unit that authorizes placement (required). Omitted → engine uses first selected **N**. */
  builderUnitId?: string;
}

export interface GatherFromFieldPayload {
  fieldId: string;
  unitIds?: string[];
}

export interface DepositAtStructurePayload {
  targetStructureId: string;
  unitIds?: string[];
}

export interface MoveUnitsPayload {
  target: Vec3;
  /** If omitted, uses current selection for `playerId`. */
  unitIds?: string[];
  /** If omitted, engine uses `tuning.formation.active`. */
  formation?: FormationId;
  /**
   * When true, `move_units` does not clear `resumeGatherFieldId` (used when redirecting a gathering miner
   * to construction so they can return to the same node afterward).
   */
  keepResumeGatherIntent?: boolean;
  /** Optional unfinished friendly structure id for construction-assist moves. */
  constructionStructureId?: string;
}

export interface StopUnitsPayload {
  unitIds?: string[];
}

export interface SetRallyPayload {
  target: Vec3;
  /** If omitted, engine uses `structureSelections[playerId]`. */
  structureIds?: string[];
  /** When set, rally snaps to this mineral field and trained N units auto-mine it. */
  mineFieldId?: string;
}

export interface AttackUnitPayload {
  targetUnitId: string;
  unitIds?: string[];
}

export function createGameCommand(
  playerId: string,
  type: GameCommandType,
  payload?: Record<string, unknown>
): GameCommand {
  return { playerId, type, payload, issuedAtMs: Date.now() };
}
