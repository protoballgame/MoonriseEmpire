import { getUnitMaxHp, unitCombatFields } from "./balance";
import { cloneGameState, type GameState } from "./state/GameState";
import { tuning } from "./runtimeTuning";

/** Push current `tuning.units` combat fields onto every living unit (caps HP to new max). Attack orders unchanged. */
export function applyTuningStatsToAllUnits(state: GameState): GameState {
  const next = cloneGameState(state);
  for (const u of next.units) {
    Object.assign(u, unitCombatFields(u.kind));
    u.attackClass = tuning.units[u.kind].attackClass;
    u.visionRange = tuning.units[u.kind].visionRange;
    const maxHp = getUnitMaxHp(u.kind);
    u.hp = Math.min(u.hp, maxHp);
  }
  return next;
}
