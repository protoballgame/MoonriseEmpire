import { GameMode } from "./GameMode";
import type { GameState } from "../state/GameState";
import type { SimulationTickResult } from "../sim/simulationEvents";
import { SimulationEngine } from "../sim/SimulationEngine";

export class TurnBasedMode extends GameMode {
  private accumulatorSeconds = 0;
  private readonly turnResolutionStepSeconds = 1.0;

  constructor(simulation: SimulationEngine) {
    super("turn_based", simulation);
  }

  override resetForNewMatch(): void {
    this.accumulatorSeconds = 0;
  }

  update(state: GameState, deltaSeconds: number): SimulationTickResult {
    this.accumulatorSeconds += deltaSeconds;
    if (this.accumulatorSeconds < this.turnResolutionStepSeconds) {
      return { state, events: [], feedback: [] };
    }

    this.accumulatorSeconds = 0;
    return this.simulation.step(state, this.turnResolutionStepSeconds);
  }
}
