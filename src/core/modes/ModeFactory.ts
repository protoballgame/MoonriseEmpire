import type { ClientMatchSetup } from "../match/clientMatch";
import { createMatchOptionsFromClientSetup } from "../match/clientMatch";
import { RealTimeMode } from "./RealTimeMode";
import { TurnBasedMode } from "./TurnBasedMode";
import { createMatchState, type GameState, type MatchModeId } from "../state/GameState";
import { SimulationEngine } from "../sim/SimulationEngine";

export type ActiveGameMode = RealTimeMode | TurnBasedMode;

export interface GameSession {
  mode: ActiveGameMode;
  initialState: GameState;
  /** Same roster + match kind as the current session (URL-derived in the browser). */
  clientSetup: ClientMatchSetup;
  /** New match state (clears command queue, fresh `createMatchState`, one warmup tick). */
  resetMatch: () => GameState;
}

export function createGameSession(modeId: MatchModeId, clientSetup: ClientMatchSetup): GameSession {
  const engine = new SimulationEngine();
  const mode: ActiveGameMode =
    modeId === "turn_based" ? new TurnBasedMode(engine) : new RealTimeMode(engine);
  const matchOpts = createMatchOptionsFromClientSetup(clientSetup);
  const resetMatch = (): GameState => {
    engine.clearCommandQueue();
    mode.resetForNewMatch();
    const s = createMatchState(modeId, matchOpts);
    return mode.update(s, 1 / s.tickRateHz).state;
  };
  return {
    mode,
    clientSetup,
    initialState: createMatchState(modeId, matchOpts),
    resetMatch
  };
}
