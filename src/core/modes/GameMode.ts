import type { GameCommand } from "../commands/GameCommand";
import type { GameState, MatchModeId } from "../state/GameState";
import type { SimulationTickResult } from "../sim/simulationEvents";
import { SimulationEngine } from "../sim/SimulationEngine";

export abstract class GameMode {
  readonly id: MatchModeId;
  protected readonly simulation: SimulationEngine;

  constructor(id: MatchModeId, simulation: SimulationEngine) {
    this.id = id;
    this.simulation = simulation;
  }

  abstract update(state: GameState, deltaSeconds: number): SimulationTickResult;

  submitCommand(command: GameCommand): void {
    this.simulation.enqueue(command);
  }

  /** Clear mode-local pacing when starting a fresh match (turn-based accumulator, etc.). */
  resetForNewMatch(): void {}
}
