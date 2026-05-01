import type { ClientMatchSetup } from "../core/match/clientMatch";
import { defaultClientMatchSetup } from "../core/match/clientMatch";
import { createGameSession, type GameSession } from "../core/modes/ModeFactory";
import type { GameState, MatchModeId } from "../core/state/GameState";

export interface BootstrapResult {
  modeId: MatchModeId;
  modeName: string;
  session: GameSession;
  /** State after one warmup simulation tick (matches prior bootstrap behavior). */
  initialState: GameState;
}

export function bootstrapGame(
  modeId: MatchModeId = "real_time",
  clientSetup: ClientMatchSetup = defaultClientMatchSetup()
): BootstrapResult {
  const session = createGameSession(modeId, clientSetup);
  let state = session.initialState;
  const warm = session.mode.update(state, 1 / state.tickRateHz);
  state = warm.state;

  return {
    modeId: session.mode.id,
    modeName: session.mode.id === "real_time" ? "Real-Time" : "Turn-Based",
    session,
    initialState: state
  };
}
