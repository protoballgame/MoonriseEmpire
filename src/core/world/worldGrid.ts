import type { Vec3 } from "../state/GameState";
import { fibonacci } from "../goldenScale";

/** World-space cell size (meters). */
export const GRID_CELL_SIZE = 2.5;

/** Grid index (0,0) corner in world space before cell centers. */
export const GRID_ORIGIN_X = -30;
export const GRID_ORIGIN_Z = -30;
function worldWrapSpan(): number {
  return GROUND_HALF_EXTENT * 2;
}

function wrapAxisCanonical(v: number): number {
  const span = worldWrapSpan();
  const mod = ((v + GROUND_HALF_EXTENT) % span + span) % span;
  return mod - GROUND_HALF_EXTENT;
}

export function footprintCenterWorld(gx: number, gz: number, footW: number, footD: number): Vec3 {
  const x = GRID_ORIGIN_X + (gx + footW * 0.5) * GRID_CELL_SIZE;
  const z = GRID_ORIGIN_Z + (gz + footD * 0.5) * GRID_CELL_SIZE;
  return { x, y: 0.55, z };
}

/** Axis-aligned footprint bounds in world XZ (closed rectangle). */
export function footprintWorldBoundsXZ(
  gx: number,
  gz: number,
  footW: number,
  footD: number
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: GRID_ORIGIN_X + gx * GRID_CELL_SIZE,
    maxX: GRID_ORIGIN_X + (gx + footW) * GRID_CELL_SIZE,
    minZ: GRID_ORIGIN_Z + gz * GRID_CELL_SIZE,
    maxZ: GRID_ORIGIN_Z + (gz + footD) * GRID_CELL_SIZE
  };
}

/**
 * Shortest XZ distance from a point to the footprint rectangle (0 when inside/overlapping the pad).
 */
export function distancePointXZToFootprintEdges(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): number {
  const { minX, maxX, minZ, maxZ } = footprintWorldBoundsXZ(gx, gz, footW, footD);
  const qx = Math.max(minX, Math.min(px, maxX));
  const qz = Math.max(minZ, Math.min(pz, maxZ));
  return Math.hypot(px - qx, pz - qz);
}

/**
 * Distance to the footprint AABB in XZ, testing the nearest chart-wrapped copy (moon sphere topology).
 */
export function distancePointXZToFootprintEdgesWrapped(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): number {
  const b = footprintWorldBoundsXZ(gx, gz, footW, footD);
  const centerX = (b.minX + b.maxX) * 0.5;
  const centerZ = (b.minZ + b.maxZ) * 0.5;
  const span = worldWrapSpan();
  const kx = Math.round((px - centerX) / span);
  const kz = Math.round((pz - centerZ) / span);
  let best = Number.POSITIVE_INFINITY;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oz = -1; oz <= 1; oz += 1) {
      const sx = (kx + ox) * span;
      const sz = (kz + oz) * span;
      const qx = Math.max(b.minX + sx, Math.min(px, b.maxX + sx));
      const qz = Math.max(b.minZ + sz, Math.min(pz, b.maxZ + sz));
      const d = Math.hypot(px - qx, pz - qz);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Distance to the footprint AABB expanded by `margin` (same convention as unit–building collision).
 * Use for melee reach vs large pads when units are kept just outside the expanded box.
 */
export function distancePointXZToFootprintEdgesWithMargin(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number,
  margin: number
): number {
  const minX = GRID_ORIGIN_X + gx * GRID_CELL_SIZE - margin;
  const maxX = GRID_ORIGIN_X + (gx + footW) * GRID_CELL_SIZE + margin;
  const minZ = GRID_ORIGIN_Z + gz * GRID_CELL_SIZE - margin;
  const maxZ = GRID_ORIGIN_Z + (gz + footD) * GRID_CELL_SIZE + margin;
  const qx = Math.max(minX, Math.min(px, maxX));
  const qz = Math.max(minZ, Math.min(pz, maxZ));
  return Math.hypot(px - qx, pz - qz);
}

export function distancePointXZToFootprintEdgesWithMarginWrapped(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number,
  margin: number
): number {
  const minX = GRID_ORIGIN_X + gx * GRID_CELL_SIZE - margin;
  const maxX = GRID_ORIGIN_X + (gx + footW) * GRID_CELL_SIZE + margin;
  const minZ = GRID_ORIGIN_Z + gz * GRID_CELL_SIZE - margin;
  const maxZ = GRID_ORIGIN_Z + (gz + footD) * GRID_CELL_SIZE + margin;
  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const span = worldWrapSpan();
  const kx = Math.round((px - centerX) / span);
  const kz = Math.round((pz - centerZ) / span);
  let best = Number.POSITIVE_INFINITY;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oz = -1; oz <= 1; oz += 1) {
      const sx = (kx + ox) * span;
      const sz = (kz + oz) * span;
      const qx = Math.max(minX + sx, Math.min(px, maxX + sx));
      const qz = Math.max(minZ + sz, Math.min(pz, maxZ + sz));
      const d = Math.hypot(px - qx, pz - qz);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Closest point on the footprint rectangle to `(px,pz)` in XZ (may be an edge or corner). */
export function closestXZPointOnFootprintEdges(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): { x: number; z: number } {
  const { minX, maxX, minZ, maxZ } = footprintWorldBoundsXZ(gx, gz, footW, footD);
  return {
    x: Math.max(minX, Math.min(px, maxX)),
    z: Math.max(minZ, Math.min(pz, maxZ))
  };
}

export function closestXZPointOnFootprintEdgesWrapped(
  px: number,
  pz: number,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): { x: number; z: number } {
  const b = footprintWorldBoundsXZ(gx, gz, footW, footD);
  const centerX = (b.minX + b.maxX) * 0.5;
  const centerZ = (b.minZ + b.maxZ) * 0.5;
  const span = worldWrapSpan();
  const kx = Math.round((px - centerX) / span);
  const kz = Math.round((pz - centerZ) / span);
  let bestQx = px;
  let bestQz = pz;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oz = -1; oz <= 1; oz += 1) {
      const sx = (kx + ox) * span;
      const sz = (kz + oz) * span;
      const qx = Math.max(b.minX + sx, Math.min(px, b.maxX + sx));
      const qz = Math.max(b.minZ + sz, Math.min(pz, b.maxZ + sz));
      const dx = px - qx;
      const dz = pz - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestQx = qx;
        bestQz = qz;
      }
    }
  }
  return {
    x: wrapAxisCanonical(bestQx),
    z: wrapAxisCanonical(bestQz)
  };
}

export function worldToCell(x: number, z: number): { gx: number; gz: number } {
  const gx = Math.floor((x - GRID_ORIGIN_X) / GRID_CELL_SIZE);
  const gz = Math.floor((z - GRID_ORIGIN_Z) / GRID_CELL_SIZE);
  return { gx, gz };
}

/** Divisions for THREE.GridHelper: cells across the ground plane span. */
export function gridHelperDivisionsForSpan(span: number): number {
  return Math.max(1, Math.round(span / GRID_CELL_SIZE));
}

/**
 * Playable XZ half-extent (meters). Arena span is `2 * GROUND_HALF_EXTENT`.
 * Base was 60; +F(6) expands the world one Fibonacci step for slightly larger skirmishes.
 */
export const GROUND_HALF_EXTENT = 60 + fibonacci(6);

/** Full width/depth of the ground plane (for `PlaneGeometry`, fog plane, minimap). */
export const WORLD_PLAY_SPAN_METERS = 2 * GROUND_HALF_EXTENT;

/** True if the axis-aligned footprint (grid cells) lies fully inside the playable ground. */
export function footprintInWorldBounds(gx: number, gz: number, footW: number, footD: number): boolean {
  const minX = GRID_ORIGIN_X + gx * GRID_CELL_SIZE;
  const maxX = GRID_ORIGIN_X + (gx + footW) * GRID_CELL_SIZE;
  const minZ = GRID_ORIGIN_Z + gz * GRID_CELL_SIZE;
  const maxZ = GRID_ORIGIN_Z + (gz + footD) * GRID_CELL_SIZE;
  return (
    minX >= -GROUND_HALF_EXTENT &&
    maxX <= GROUND_HALF_EXTENT &&
    minZ >= -GROUND_HALF_EXTENT &&
    maxZ <= GROUND_HALF_EXTENT
  );
}

export function footprintsOverlap(
  gx: number,
  gz: number,
  w: number,
  d: number,
  gx2: number,
  gz2: number,
  w2: number,
  d2: number
): boolean {
  return !(gx + w <= gx2 || gx2 + w2 <= gx || gz + d <= gz2 || gz2 + d2 <= gz);
}
