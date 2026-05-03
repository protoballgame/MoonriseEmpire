import { tuning } from "./runtimeTuning";
import type { StructureKind } from "./state/GameState";

const BASE_STRUCTURE_VISION_RANGE_PRE_BUFF = 11;
const BASE_STRUCTURE_VIEW_DISTANCE_MULTIPLIER = 1.38;
export const BASE_STRUCTURE_VISION_RANGE = BASE_STRUCTURE_VISION_RANGE_PRE_BUFF * BASE_STRUCTURE_VIEW_DISTANCE_MULTIPLIER;
export const DEFENSE_OBELISK_DAMAGE_MULTIPLIER = 1.62;
const DEFENSE_OBELISK_BASE_VISION_MULTIPLIER = 2.2;
const DEFENSE_OBELISK_FIRE_RANGE_MULTIPLIER = 0.9;

export function structureVisionRange(kind: StructureKind): number {
  if (kind === "defense_obelisk") {
    return tuning.units.N.visionRange * DEFENSE_OBELISK_BASE_VISION_MULTIPLIER;
  }
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
      acquireRange: structureVisionRange(kind),
      fireRange: n.range,
      damage: n.damage,
      cooldownSec: n.cooldown,
      muzzleYOffset: 1.35,
      attackerKeyPrefix: "home-defense"
    };
  }
  if (kind === "defense_obelisk") {
    const vision = structureVisionRange(kind);
    const fireRange =
      tuning.units.N.visionRange * DEFENSE_OBELISK_BASE_VISION_MULTIPLIER * DEFENSE_OBELISK_FIRE_RANGE_MULTIPLIER;
    return {
      acquireRange: vision,
      fireRange,
      damage: n.damage * DEFENSE_OBELISK_DAMAGE_MULTIPLIER,
      cooldownSec: n.cooldown,
      muzzleYOffset: 2.25,
      attackerKeyPrefix: "obelisk-defense"
    };
  }
  return null;
}
