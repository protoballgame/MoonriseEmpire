import type { PlaceableStructureKind } from "./commands/GameCommand";
import type { MilitaryKind } from "./militaryKinds";
import { fibonacci, PHI } from "./goldenScale";

/**
 * Placing a new structure — F(9)+F(5): steeper than legacy 33, spread across build/train/gather nerfs.
 * (Barracks, Mineral Depository — full-footprint sites.)
 */
export const STRUCTURE_PLACE_COST_ENERGY = fibonacci(9) + fibonacci(5);
export const STRUCTURE_PLACE_COST_MINERALS = fibonacci(9) + fibonacci(5);

/**
 * Solar Array (`power_spire`) 1×1 — lighter on energy, heavier on minerals than barracks sites.
 */
export const POWER_SPIRE_PLACE_COST_ENERGY = fibonacci(6) + fibonacci(5);
export const POWER_SPIRE_PLACE_COST_MINERALS = fibonacci(8) + fibonacci(5);
export const DEFENSE_OBELISK_PLACE_COST_ENERGY = 27;
export const DEFENSE_OBELISK_PLACE_COST_MINERALS = 27;
export const COMMAND_CORE_PLACE_COST_ENERGY = 400;
export const COMMAND_CORE_PLACE_COST_MINERALS = 400;

export function resourcesForPlaceStructure(kind: PlaceableStructureKind): {
  energy: number;
  minerals: number;
} {
  if (kind === "home") {
    return { energy: COMMAND_CORE_PLACE_COST_ENERGY, minerals: COMMAND_CORE_PLACE_COST_MINERALS };
  }
  if (kind === "power_spire") {
    return { energy: POWER_SPIRE_PLACE_COST_ENERGY, minerals: POWER_SPIRE_PLACE_COST_MINERALS };
  }
  if (kind === "defense_obelisk") {
    return {
      energy: DEFENSE_OBELISK_PLACE_COST_ENERGY,
      minerals: DEFENSE_OBELISK_PLACE_COST_MINERALS
    };
  }
  return { energy: STRUCTURE_PLACE_COST_ENERGY, minerals: STRUCTURE_PLACE_COST_MINERALS };
}

/** Queue one unit from a barracks or Core — F(7), up from F(6). */
export const BARRACKS_TRAIN_COST_ENERGY = fibonacci(7);
export const BARRACKS_TRAIN_COST_MINERALS = fibonacci(7);
/** Neutral miners from Command Core are a bit cheaper than military queues. */
export const NEUTRAL_TRAIN_COST_ENERGY = fibonacci(6) + fibonacci(4);
export const NEUTRAL_TRAIN_COST_MINERALS = fibonacci(6) + fibonacci(4);

export function resourcesForTrainKind(kind: MilitaryKind): { energy: number; minerals: number } {
  return kind === "N"
    ? { energy: NEUTRAL_TRAIN_COST_ENERGY, minerals: NEUTRAL_TRAIN_COST_MINERALS }
    : { energy: BARRACKS_TRAIN_COST_ENERGY, minerals: BARRACKS_TRAIN_COST_MINERALS };
}

/**
 * PvC: XZ world distance from Command Core center. Inside this bubble, CPU miners disengage from combat
 * and take deposit or gather orders; new defensive attack orders are not issued there.
 */
export const COMPUTER_MINER_NEAR_HOME_ECONOMY_XZ_RANGE = fibonacci(8) + fibonacci(3);

/** Seconds to complete one queued unit at a barracks / Command Core. */
export const BARRACKS_TRAIN_TIME_SEC = fibonacci(6);

/**
 * Opening stockpile: F(10) so early mine + array spikes less hard vs train/place costs.
 */
export const STARTING_ENERGY = fibonacci(10);
export const STARTING_MINERALS = fibonacci(10);

/** Structure HP (design targets). */
export const HOME_STRUCTURE_MAX_HP = 500;
export const BARRACKS_STRUCTURE_MAX_HP = 150;
export const GENERATOR_STRUCTURE_MAX_HP = 120;

/** Seconds to finish construction after `place_structure`. */
export const BARRACKS_BUILD_TIME_SEC = fibonacci(5);
export const POWER_SPIRE_BUILD_TIME_SEC = fibonacci(6);
export const MINERAL_DEPOT_BUILD_TIME_SEC = fibonacci(6);
export const DEFENSE_OBELISK_BUILD_TIME_SEC = fibonacci(6);
export const COMMAND_CORE_BUILD_TIME_SEC = 180;

/**
 * Economy knob: multiply minerals mined per pulse by this, divide passive Solar energy/sec by the same value.
 * Keeps a paired trade (more ore income, less passive energy) for playtests — tweak here only.
 */
export const ECONOMY_MINERAL_UP_ENERGY_DOWN = 1.2;

/** φ-scaled Solar baseline before {@link ECONOMY_MINERAL_UP_ENERGY_DOWN}. */
const POWER_SPIRE_ENERGY_PER_SEC_BASE =
  (fibonacci(8) / fibonacci(6) / (PHI * PHI * PHI) / 3.5) * 1.25;

/**
 * Compact 1×1 spires: baseline above, slowed when {@link ECONOMY_MINERAL_UP_ENERGY_DOWN} is above 1.
 */
export const POWER_SPIRE_ENERGY_PER_SEC =
  POWER_SPIRE_ENERGY_PER_SEC_BASE / ECONOMY_MINERAL_UP_ENERGY_DOWN;

/**
 * Mineral nodes: ~⅛ less per pulse than F(3); energy is not mined — build Solar Arrays (`power_spire`).
 * Pulse spacing ~5× F(8)/9 keeps ore income deliberate instead of instant.
 */
export const MINERAL_GATHER_PULSE_INTERVAL_SEC = (fibonacci(8) / 9) * 5;

const MINERAL_GATHER_PER_PULSE_BASE = (fibonacci(3) * 7) / 8;

/**
 * Extra ore per gather pulse (~+24% vs prior). Stacks with {@link ECONOMY_MINERAL_UP_ENERGY_DOWN} but does **not**
 * change Solar passive (unlike bumping `ECONOMY_MINERAL_UP_ENERGY_DOWN` alone).
 */
export const MINERAL_GATHER_THROUGHPUT_MULT = 1.24;

/** Per pulse at the node; scaled by economy knob + throughput mult vs {@link MINERAL_GATHER_PER_PULSE_BASE}. */
export const MINERAL_GATHER_PER_PULSE =
  MINERAL_GATHER_PER_PULSE_BASE * ECONOMY_MINERAL_UP_ENERGY_DOWN * MINERAL_GATHER_THROUGHPUT_MULT;
/** Max pulses processed in one frame (avoids catch-up storms after long frames). */
export const MINERAL_GATHER_MAX_PULSES_PER_TICK = fibonacci(4);

/** XZ distance to node center at which mining applies (miners must stand tight on the node). */
export const RESOURCE_GATHER_RANGE = 0.9;

/** Neutral miners: cart F(5) — fills faster than F(6) so they head to Core/Depot more often per trip cycle. */
export const MINER_CARRY_CAPACITY = fibonacci(5);

/**
 * Unload when this close to the depository **footprint edge** (0 = touching/overlap). Matches build-contact
 * feel so miners can drop at the pad while footprint push keeps them off the interior.
 */
export const MINERAL_DEPOSIT_FOOTPRINT_MAX_DIST = 0.75;
/** Depositing at a Mineral Depository yields φ times the carried ore; Command Core unloads 1:1. */
export const MINERAL_DEPOT_DEPOSIT_MULTIPLIER = PHI;
