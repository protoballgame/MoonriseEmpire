import type { StructureKind } from "../state/GameState";
import { POWER_SPIRE_ENERGY_PER_SEC } from "../economyConstants";

export interface StructureYieldPerSecond {
  energy: number;
  minerals: number;
}

/** Passive generation from completed structures (per second). */
export function structurePassiveYieldPerSec(kind: StructureKind): StructureYieldPerSecond {
  switch (kind) {
    case "power_spire":
      return { energy: POWER_SPIRE_ENERGY_PER_SEC, minerals: 0 };
    case "defense_obelisk":
      return { energy: 0, minerals: 0 };
    default:
      return { energy: 0, minerals: 0 };
  }
}
