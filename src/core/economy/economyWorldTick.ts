import type { GameState } from "../state/GameState";
import { structurePassiveYieldPerSec } from "./structureResourceYield";
import { isStructureBuilt } from "../state/GameState";

/**
 * Passive income from completed **Solar Array** structures only.
 * Command Core grants no free resources — minerals come from mining; energy from arrays (or future sources).
 */
export function runDefaultResourceEconomyWorldTick(state: GameState, deltaSeconds: number): void {
  for (const s of state.structures) {
    if (s.hp <= 0) continue;
    if (!isStructureBuilt(s)) continue;
    const y = structurePassiveYieldPerSec(s.kind);
    if (y.energy <= 0 && y.minerals <= 0) continue;
    const owner = state.players.find((p) => p.id === s.playerId);
    if (!owner) continue;
    const passiveScale =
      state.skirmishBoostPassive && s.playerId === state.skirmishBoostPassive.playerId
        ? state.skirmishBoostPassive.scale
        : 1;
    owner.resources.energy += deltaSeconds * y.energy * passiveScale;
    owner.resources.minerals += deltaSeconds * y.minerals * passiveScale;
  }
}
