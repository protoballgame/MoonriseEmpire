/**
 * Moon surface / chart topology
 * ------------------------------
 * **Simulation** uses chart coordinates (world XZ on the arena grid).
 * **Topology** stitches the chart via `canonicalizeSphereWorldPoint` + `fillSphereEquivalentWorldPoints`.
 * **Rendering** maps chart → displaced sphere via `flatXZToSphereSurface*` / `sphereSurfacePointToFlatXZ`.
 */
import * as THREE from "three";
import type { TerrainId } from "../state/GameState";
import {
  flatXZToSphereNormal,
  flatXZToSphereSurfaceDisplaced,
  flatXZToSphereSurfaceInto,
  sphereSurfacePointToFlatXZ,
  SPHERE_MOON_RADIUS
} from "./sphereTerrain";
import { GROUND_HALF_EXTENT } from "./worldGrid";

const WORLD_HALF = GROUND_HALF_EXTENT;
const WORLD_SPAN = WORLD_HALF * 2;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const geodesicScratch0 = new THREE.Vector3();
const geodesicScratch1 = new THREE.Vector3();
const geodesicTangentScratch = new THREE.Vector3();

/** Great-circle distance on the ideal moon sphere between two flat sim XZ points (uses nearest wrap of `to`). */
export function sphereGeodesicDistanceWorldXZ(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const near = nearestSphereEquivalentWorldPoint(toX, toZ, fromX, fromZ);
  flatXZToSphereSurfaceInto(geodesicScratch0, fromX, fromZ);
  flatXZToSphereSurfaceInto(geodesicScratch1, near.x, near.z);
  const r2 = SPHERE_MOON_RADIUS * SPHERE_MOON_RADIUS;
  const c = THREE.MathUtils.clamp(geodesicScratch0.dot(geodesicScratch1) / r2, -1, 1);
  return SPHERE_MOON_RADIUS * Math.acos(c);
}

/** Great-circle steering at `from` toward `to`, in the local East/North tangent frame; `null` if degenerate. */
export function sphereGreatCircleEastNorth(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  east: THREE.Vector3,
  north: THREE.Vector3
): { east: number; north: number; geodesic: number } | null {
  const near = nearestSphereEquivalentWorldPoint(toX, toZ, fromX, fromZ);
  flatXZToSphereSurfaceInto(geodesicScratch0, fromX, fromZ);
  flatXZToSphereSurfaceInto(geodesicScratch1, near.x, near.z);
  const r2 = SPHERE_MOON_RADIUS * SPHERE_MOON_RADIUS;
  const cos = THREE.MathUtils.clamp(geodesicScratch0.dot(geodesicScratch1) / r2, -1, 1);
  const geodesic = SPHERE_MOON_RADIUS * Math.acos(cos);
  geodesicTangentScratch.copy(geodesicScratch1).addScaledVector(geodesicScratch0, -cos);
  if (geodesicTangentScratch.lengthSq() < 1e-14) return null;
  geodesicTangentScratch.normalize();
  return {
    east: geodesicTangentScratch.dot(east),
    north: geodesicTangentScratch.dot(north),
    geodesic
  };
}

export function canonicalizeSphereWorldPoint(x: number, z: number): { x: number; z: number } {
  let cx = x;
  let cz = z;
  while (cz > WORLD_HALF) {
    cz = WORLD_SPAN - cz;
    cx += WORLD_HALF;
  }
  while (cz < -WORLD_HALF) {
    cz = -WORLD_SPAN - cz;
    cx += WORLD_HALF;
  }
  cx = THREE.MathUtils.euclideanModulo(cx + WORLD_HALF, WORLD_SPAN) - WORLD_HALF;
  return { x: cx, z: cz };
}

const SEW_TMP: { x: number; z: number }[] = Array.from({ length: 8 }, () => ({ x: 0, z: 0 }));

/**
 * Writes up to 8 torus-equivalent world XZ points into `out` (reuse slots); returns count.
 * Hot-path friendly: no allocations when `out` is pre-sized (length ≥ 8).
 */
export function fillSphereEquivalentWorldPoints(x: number, z: number, out: { x: number; z: number }[]): number {
  const c = canonicalizeSphereWorldPoint(x, z);
  let n = 0;
  const tryPush = (px: number, pz: number): void => {
    for (let i = 0; i < n; i += 1) {
      const q = out[i];
      if (Math.abs(q.x - px) < 1e-6 && Math.abs(q.z - pz) < 1e-6) return;
    }
    const slot = out[n] ?? (out[n] = { x: 0, z: 0 });
    slot.x = px;
    slot.z = pz;
    n += 1;
  };
  tryPush(c.x, c.z);
  tryPush(c.x - WORLD_SPAN, c.z);
  tryPush(c.x + WORLD_SPAN, c.z);
  tryPush(c.x + WORLD_HALF, WORLD_SPAN - c.z);
  tryPush(c.x + WORLD_HALF, -WORLD_SPAN - c.z);
  tryPush(c.x - WORLD_HALF, WORLD_SPAN - c.z);
  tryPush(c.x - WORLD_HALF, -WORLD_SPAN - c.z);
  return n;
}

export function sphereEquivalentWorldPoints(x: number, z: number): Array<{ x: number; z: number }> {
  const n = fillSphereEquivalentWorldPoints(x, z, SEW_TMP);
  const r: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n; i += 1) r.push({ x: SEW_TMP[i].x, z: SEW_TMP[i].z });
  return r;
}

export function nearestSphereEquivalentWorldPoint(
  x: number,
  z: number,
  nearX: number,
  nearZ: number
): { x: number; z: number } {
  const n = fillSphereEquivalentWorldPoints(x, z, SEW_TMP);
  let bestX = 0;
  let bestZ = 0;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const p = SEW_TMP[i];
    const dx = p.x - nearX;
    const dz = p.z - nearZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestX = p.x;
      bestZ = p.z;
    }
  }
  return { x: bestX, z: bestZ };
}

export function canonicalizeWorldPoint(_terrain: TerrainId, x: number, z: number): { x: number; z: number } {
  return canonicalizeSphereWorldPoint(x, z);
}

export function surfacePointFromWorldXZ(
  _terrain: TerrainId,
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const c = canonicalizeSphereWorldPoint(x, z);
  out.copy(flatXZToSphereSurfaceDisplaced(c.x, c.z));
  out.addScaledVector(flatXZToSphereNormal(c.x, c.z), y);
  return out;
}

export function surfaceNormalFromWorldXZ(
  _terrain: TerrainId,
  x: number,
  z: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const c = canonicalizeSphereWorldPoint(x, z);
  return out.copy(flatXZToSphereNormal(c.x, c.z));
}

export function projectSurfacePointToWorldXZ(
  _terrain: TerrainId,
  point: THREE.Vector3
): { x: number; z: number } {
  const xz = sphereSurfacePointToFlatXZ(point);
  return canonicalizeSphereWorldPoint(xz.x, xz.z);
}

export function buildSurfaceTangentFrame(
  _terrain: TerrainId,
  x: number,
  z: number,
  eastOut: THREE.Vector3,
  northOut: THREE.Vector3,
  normalOut: THREE.Vector3,
  fallbackEast?: THREE.Vector3
): void {
  surfaceNormalFromWorldXZ("sphere", x, z, normalOut);
  eastOut.copy(WORLD_UP).cross(normalOut);
  if (eastOut.lengthSq() < 1e-8 && fallbackEast) {
    eastOut.copy(fallbackEast).addScaledVector(normalOut, -fallbackEast.dot(normalOut));
  }
  if (eastOut.lengthSq() < 1e-8) {
    eastOut.set(1, 0, 0).addScaledVector(normalOut, -normalOut.x);
  }
  eastOut.normalize();
  if (fallbackEast && eastOut.dot(fallbackEast) < 0) eastOut.negate();
  northOut.crossVectors(eastOut, normalOut).normalize();
}

export function projectWorldXZToSphereDisk(
  pointX: number,
  pointZ: number,
  centerX: number,
  centerZ: number,
  radius: number,
  eastHint?: THREE.Vector3
): { x: number; y: number; visible: boolean } {
  const center = canonicalizeSphereWorldPoint(centerX, centerZ);
  const point = nearestSphereEquivalentWorldPoint(pointX, pointZ, center.x, center.z);
  const centerNormal = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  buildSurfaceTangentFrame("sphere", center.x, center.z, east, north, centerNormal, eastHint);
  const pointNormal = flatXZToSphereNormal(point.x, point.z);
  const front = pointNormal.dot(centerNormal);
  const dx = pointNormal.dot(east);
  const dy = pointNormal.dot(north);
  return {
    x: dx * radius,
    y: -dy * radius,
    visible: front >= 0
  };
}

export function projectSphereDiskToWorldXZ(
  diskX: number,
  diskY: number,
  centerX: number,
  centerZ: number,
  radius: number,
  eastHint?: THREE.Vector3
): { x: number; z: number } | null {
  const nx = diskX / Math.max(radius, 1e-6);
  const ny = -diskY / Math.max(radius, 1e-6);
  const r2 = nx * nx + ny * ny;
  if (r2 > 1) return null;
  const center = canonicalizeSphereWorldPoint(centerX, centerZ);
  const centerNormal = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  buildSurfaceTangentFrame("sphere", center.x, center.z, east, north, centerNormal, eastHint);
  const nz = Math.sqrt(Math.max(0, 1 - r2));
  const surface = new THREE.Vector3()
    .copy(centerNormal)
    .multiplyScalar(nz)
    .addScaledVector(east, nx)
    .addScaledVector(north, ny)
    .normalize()
    .multiplyScalar(SPHERE_MOON_RADIUS);
  const raw = sphereSurfacePointToFlatXZ(surface);
  return nearestSphereEquivalentWorldPoint(raw.x, raw.z, center.x, center.z);
}
