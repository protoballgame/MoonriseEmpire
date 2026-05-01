import type { GameState, TerrainId, Vec3 } from "../state/GameState";
import { nearestSphereEquivalentWorldPoint } from "./worldSurface";

/**
 * Shortest XZ delta on the moon chart (wrap-equivalent `to` chosen nearest to `from`).
 */
export function topologyDeltaXZ(
  _source: GameState | TerrainId,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): { dx: number; dz: number } {
  const near = nearestSphereEquivalentWorldPoint(toX, toZ, fromX, fromZ);
  return { dx: near.x - fromX, dz: near.z - fromZ };
}

export function topologyDistanceXZ(
  source: GameState | TerrainId,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): number {
  const { dx, dz } = topologyDeltaXZ(source, fromX, fromZ, toX, toZ);
  return Math.hypot(dx, dz);
}

export function topologyDistance3(source: GameState | TerrainId, a: Vec3, b: Vec3): number {
  const { dx, dz } = topologyDeltaXZ(source, a.x, a.z, b.x, b.z);
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
