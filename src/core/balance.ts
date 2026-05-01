import type { MilitaryKind } from "./militaryKinds";
import { tuning } from "./runtimeTuning";

export type { MilitaryKind } from "./militaryKinds";

export interface UnitStats {
  hp: number;
  speed: number;
  range: number;
  visionRange: number;
  damage: number;
  cooldown: number;
}

/** @deprecated Use `tuning.units` — kept for quick reads in docs. */
export function getUnitStatsSnapshot(kind: MilitaryKind): UnitStats {
  const u = tuning.units[kind];
  return {
    hp: u.hp,
    speed: u.speed,
    range: u.range,
    visionRange: u.visionRange,
    damage: u.damage,
    cooldown: u.cooldown
  };
}

export function getUnitMaxHp(kind: MilitaryKind): number {
  return tuning.units[kind].hp;
}

/**
 * Rock–Paper–Scissors military triangle (locked):
 * Rock beats Scissors, loses to Paper · Scissors beats Paper, loses to Rock · Paper beats Rock, loses to Scissors.
 * Same-kind hits use multiplier 1.
 */
export function rpsDamageMultiplier(attacker: MilitaryKind, defender: MilitaryKind): number {
  if (attacker === "N" || defender === "N") return 1;
  if (attacker === defender) return 1;
  const strong =
    (attacker === "R" && defender === "S") ||
    (attacker === "S" && defender === "P") ||
    (attacker === "P" && defender === "R");
  if (strong) return tuning.combat.rpsStrongMultiplier;
  return tuning.combat.rpsWeakMultiplier;
}

export function unitCombatFields(kind: MilitaryKind): {
  speed: number;
  attackRange: number;
  attackDamage: number;
  attackCooldownSeconds: number;
  cooldownRemainingSeconds: number;
} {
  const s = tuning.units[kind];
  return {
    speed: s.speed,
    attackRange: s.range,
    attackDamage: s.damage,
    attackCooldownSeconds: s.cooldown,
    cooldownRemainingSeconds: 0
  };
}
