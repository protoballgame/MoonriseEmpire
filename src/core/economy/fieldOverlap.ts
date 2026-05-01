import { footprintsOverlap } from "../world/worldGrid";
import type { GameState } from "../state/GameState";

/** True if a building footprint would overlap any resource field cell (1×1). */
export function structureFootprintOverlapsResourceField(
  state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  for (const f of state.resourceFields) {
    if (footprintsOverlap(gx, gz, footW, footD, f.gx, f.gz, 1, 1)) return true;
  }
  return false;
}
