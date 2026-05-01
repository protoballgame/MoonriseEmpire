import { tuning } from "./runtimeTuning";
import type { StructureKind } from "./state/GameState";

export const BASE_STRUCTURE_VISION_RANGE = 11;
export const DEFENSE_OBELISK_DAMAGE_MULTIPLIER = 1.62;

export function structureVisionRange(kind: StructureKind): number {
  if (kind === "defense_obelisk") return tuning.units.N.visionRange * 2.2;
  return BASE_STRUCTURE_VISION_RANGE;
}

export function defensiveStructureStats(kind: StructureKind): {
  acquireRange: number;
  fireRange: number;
  damage: number;
  cooldownSec: number;
  muzzleYOffset: number;
  attackerKeyPrefix: string;
} | null {
  const n = tuning.units.N;
  if (kind === "home") {
    return {
      acquireRange: n.visionRange,
      fireRange: n.range,
      damage: n.damage,
      cooldownSec: n.cooldown,
      muzzleYOffset: 1.35,
      attackerKeyPrefix: "home-defense"
    };
  }
  if (kind === "defense_obelisk") {
    const vision = structureVisionRange(kind);
    return {
      acquireRange: vision,
      fireRange: vision * 0.9,
      damage: n.damage * DEFENSE_OBELISK_DAMAGE_MULTIPLIER,
      cooldownSec: n.cooldown,
      muzzleYOffset: 2.25,
      attackerKeyPrefix: "obelisk-defense"
    };
  }
  return null;
}
