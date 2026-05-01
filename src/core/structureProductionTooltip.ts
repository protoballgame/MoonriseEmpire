import type { StructureKind } from "./state/GameState";

/**
 * Short copy for the HUD when a structure is selected: what it produces and RPS matchup.
 */
export function structureProductionTooltip(kind: StructureKind): string {
  switch (kind) {
    case "home":
      return "Command Core — trains Neutral miners, accepts mineral drop-offs, and auto-defends. You stay alive while at least one completed Core remains.";
    case "barracks_r":
      return "Rock melee — strong vs Scissors, weak vs Paper.";
    case "barracks_s":
      return "Scissors melee — strong vs Paper, weak vs Rock.";
    case "barracks_p":
      return "Paper ranged — strong vs Rock, weak vs Scissors.";
    case "barracks_n":
      return "Legacy yard (not buildable). Train miners from your Command Core.";
    case "power_spire":
      return "Solar Array — passive energy/sec. Does not train units.";
    case "defense_obelisk":
      return "Defense Turret — tall ranged tower with 2.2x Neutral vision, 90% vision fire range, 1.62x Neutral damage, and 4x Neutral HP. Does not train units.";
    case "mineral_depot":
      return "Miner drop-off. Neutral miners unload here for a boosted mineral payout. Does not train units.";
  }
}
