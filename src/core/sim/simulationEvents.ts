import type { MilitaryKind } from "../militaryKinds";
import type { GameState, StructureKind } from "../state/GameState";
import type { UiFeedbackEvent } from "./uiFeedbackEvents";

/** Emitted by SimulationEngine for UI/VFX. */
export interface DamageDealtEvent {
  type: "damage_dealt";
  targetUnitId?: string;
  targetStructureId?: string;
  attackerUnitId: string;
  amount: number;
  position: { x: number; y: number; z: number };
  attackerPosition: { x: number; y: number; z: number };
  attackClass: "melee" | "ranged";
  /** Unit-vs-unit combat math (for balance / analytics). */
  attackerKind?: MilitaryKind;
  defenderKind?: MilitaryKind;
  /** RPS multiplier applied to `baseDamage` to produce `amount`. */
  rpsMultiplier?: number;
  /** Attacker sheet damage before RPS (same as `amount` when RPS is 1). */
  baseDamage?: number;
  defenderHpBefore?: number;
  defenderHpAfter?: number;
  /** Structure targets (no RPS). */
  targetStructureKind?: StructureKind;
  structureHpBefore?: number;
  structureHpAfter?: number;
}

/** Floating-number feedback for mining / energy node gathering (not stockpile deposit). */
export interface ResourcesGatheredEvent {
  type: "resources_gathered";
  playerId: string;
  unitId: string;
  gatherKind: "mineral";
  amount: number;
  position: { x: number; y: number; z: number };
}

export type SimulationEvent = DamageDealtEvent | ResourcesGatheredEvent;

export interface SimulationTickResult {
  state: GameState;
  events: SimulationEvent[];
  /** Command acknowledgements for modular audio / HUD / world highlights. */
  feedback: UiFeedbackEvent[];
}
