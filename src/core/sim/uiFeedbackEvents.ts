import type { PlaceableStructureKind } from "../commands/GameCommand";

/**
 * Client-facing feedback emitted when commands are applied (or rejected).
 * Keep this stable: swap `dispatchUiFeedback` / sound packs / visuals without touching the sim rules.
 */
export type UiFeedbackEvent =
  | {
      kind: "gather";
      playerId: string;
      status: "started" | "rejected";
      fieldId?: string;
      reason?: "invalid_field" | "no_neutral_units" | "no_units_selected" | "energy_not_mined";
    }
  | { kind: "move"; playerId: string; status: "ok" | "rejected"; reason?: "bad_target" | "queue_full" }
  | { kind: "attack_move"; playerId: string; status: "ok" | "rejected"; reason?: "bad_target" }
  | { kind: "attack_unit"; playerId: string; status: "ok" | "rejected" }
  | { kind: "attack_structure"; playerId: string; status: "ok" | "rejected" }
  | { kind: "deposit"; playerId: string; status: "ok" | "rejected" }
  | {
      kind: "place_structure";
      playerId: string;
      status: "ok" | "rejected";
      structureKind?: PlaceableStructureKind;
    }
  | { kind: "train_unit"; playerId: string; status: "ok" | "rejected" }
  | {
      kind: "rally_set";
      playerId: string;
      status: "ok" | "rejected";
      reason?: "bad_target" | "no_valid_structures" | "invalid_mine_field";
      /** Present when rally was placed on an ore node (for field flash). */
      mineFieldId?: string;
    }
  | { kind: "stop"; playerId: string; status: "ok" };
