import type { StructureKind } from "./state/GameState";

export function structureDisplayName(kind: StructureKind): string {
  switch (kind) {
    case "home":
      return "Command Core";
    case "barracks_r":
      return "Rock Foundry";
    case "barracks_s":
      return "Scissors Hall";
    case "barracks_p":
      return "Paper Range";
    case "barracks_n":
      return "Neutral Yard";
    case "power_spire":
      return "Solar Array";
    case "defense_obelisk":
      return "Defense Turret";
    case "mineral_depot":
      return "Mineral Depository";
  }
}
