import type { StructureKind } from "./state/GameState";

/** Grid footprint for structures (axis-aligned, `gx`/`gz` = minimum corner). */
export function footprintForStructureKind(kind: StructureKind): { footW: number; footD: number } {
  switch (kind) {
    case "home":
      return { footW: 3, footD: 3 };
    case "power_spire":
      /** Compact solar tile: 1×1 (¼ the ground area of a 2×2 site). */
      return { footW: 1, footD: 1 };
    case "defense_obelisk":
      /** Defensive tower: tall but skinny, so it fits into compact base gaps. */
      return { footW: 1, footD: 1 };
    default:
      return { footW: 2, footD: 2 };
  }
}
