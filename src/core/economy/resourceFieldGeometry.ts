import { footprintCenterWorld } from "../world/worldGrid";
import type { Vec3 } from "../state/GameState";
import type { SimResourceField } from "./resourceFieldTypes";

/** Single-cell field: footprint 1×1 for centering and gather range checks. */
export function resourceFieldCenterWorld(f: SimResourceField): Vec3 {
  return footprintCenterWorld(f.gx, f.gz, 1, 1);
}
