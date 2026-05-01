import { GameMode } from "./GameMode";
import type { GameState } from "../state/GameState";
import { SimulationEngine } from "../sim/SimulationEngine";

export class RealTimeMode extends GameMode {
  constructor(simulation: SimulationEngine) {
    super("real_time", simulation);
  }

  update(state: GameState, deltaSeconds: number) {
    return this.simulation.step(state, deltaSeconds);
  }
}
