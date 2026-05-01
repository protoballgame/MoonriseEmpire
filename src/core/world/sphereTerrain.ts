import * as THREE from "three";
import type { GameState } from "../state/GameState";
import { GRID_CELL_SIZE, GRID_ORIGIN_X, GRID_ORIGIN_Z, GROUND_HALF_EXTENT } from "./worldGrid";
import { canonicalizeSphereWorldPoint } from "./worldSurface";

/** Visual + picking radius (meters). */
export const SPHERE_MOON_RADIUS = 94;

const H = GROUND_HALF_EXTENT;
export const SPHERE_LAMBDA_MAX = Math.PI;
export const SPHERE_THETA_SPAN = Math.PI;
export const SPHERE_THETA_MIN = 0;

/**
 * Chart **Z** maps to co-latitude on the moon UV; values near ±{@link GROUND_HALF_EXTENT} are the poles.
 * Gameplay treats a band at each pole as impassable / unbuildable so movement and cameras stay stable.
 */
export const SPHERE_PLAYABLE_Z_FRAC = 0.86;

export function spherePlayableZAbsLimit(): number {
  return H * SPHERE_PLAYABLE_Z_FRAC;
}

/** True when flat sim coordinates lie in the reserved polar cap (after chart canonicalize). */
export function spherePolarCapBlocksFlatXZ(x: number, z: number): boolean {
  const c = canonicalizeSphereWorldPoint(x, z);
  const lim = spherePlayableZAbsLimit();
  return Math.abs(c.z) > lim + 1e-6;
}

/** Clamp chart Z into the playable equatorial band (X unchanged). */
export function clampSpherePlayableWorldXZ(x: number, z: number): { x: number; z: number } {
  const c = canonicalizeSphereWorldPoint(x, z);
  const lim = spherePlayableZAbsLimit();
  return { x: c.x, z: THREE.MathUtils.clamp(c.z, -lim, lim) };
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function fbm2(x: number, z: number): number {
  let v = 0;
  let a = 0.5;
  let px = x;
  let pz = z;
  for (let i = 0; i < 5; i += 1) {
    const gx = Math.floor(px);
    const gz = Math.floor(pz);
    const fx = px - gx;
    const fz = pz - gz;
    const u = fx * fx * (3 - 2 * fx);
    const w = fz * fz * (3 - 2 * fz);
    const n00 = hash2(gx, gz);
    const n10 = hash2(gx + 1, gz);
    const n01 = hash2(gx, gz + 1);
    const n11 = hash2(gx + 1, gz + 1);
    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    v += a * (nx0 * (1 - w) + nx1 * w);
    px *= 2.02;
    pz *= 2.02;
    a *= 0.5;
  }
  return v;
}

export type SphereCraterStamp = {
  x: number;
  z: number;
  radius: number;
  depth: number;
  blockRadius: number;
};

function buildCraterStamps(): SphereCraterStamp[] {
  const out: SphereCraterStamp[] = [];

  const overlaps = (x: number, z: number, r: number): boolean =>
    out.some((c) => Math.hypot(c.x - x, c.z - z) < (c.radius + r) * 1.02);
  const step = 14;
  for (let x = -H + step; x <= H - step; x += step) {
    for (let z = -H + step; z <= H - step; z += step) {
      // Reserve only the near-pole cap for dedicated pole landmarks.
      if (Math.abs(z) > H * 0.78) continue;
      const h = hash2(x * 0.17 + 13.2, z * 0.17 - 8.7);
      if (h < 0.73) continue;
      const radius = 2.0 + hash2(x + 1.7, z - 0.4) * 3.6;
      const depth = 0.45 + hash2(x - 2.8, z + 3.1) * 1.7;
      const jitterX = (hash2(x + 9.1, z - 7.2) - 0.5) * step * 0.54;
      const jitterZ = (hash2(x - 6.4, z + 2.7) - 0.5) * step * 0.54;
      const cx = x + jitterX;
      const cz = z + jitterZ;
      if (overlaps(cx, cz, radius)) continue;
      out.push({
        x: cx,
        z: cz,
        radius,
        depth,
        // Keep collision closer to visible crater rim so pads/units don't overlap crater visuals.
        blockRadius: radius * (0.82 + hash2(x + 5.1, z - 3.8) * 0.1)
      });
    }
  }
  // A couple larger landmarks so the moon reads less noise-like.
  if (!overlaps(-H * 0.22, H * 0.18, 8.8))
    out.push({ x: -H * 0.22, z: H * 0.18, radius: 8.8, depth: 2.2, blockRadius: 7.1 });
  if (!overlaps(H * 0.31, -H * 0.27, 7.6))
    out.push({ x: H * 0.31, z: -H * 0.27, radius: 7.6, depth: 1.9, blockRadius: 6.1 });
  return out;
}

const CRATER_STAMPS = buildCraterStamps();

export function sphereCraterStamps(): readonly SphereCraterStamp[] {
  return CRATER_STAMPS;
}

function craterDistance01(x: number, z: number, c: SphereCraterStamp): number {
  return Math.hypot(x - c.x, z - c.z) / Math.max(0.001, c.radius);
}

/**
 * Flat simulation XZ → point on the moon surface (world space, Y-up).
 * Playable square maps to a cap of the sphere.
 */
/** Writes ideal-sphere surface position for flat sim coords (same mapping as {@link flatXZToSphereSurface}). */
export function flatXZToSphereSurfaceInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
  const c = canonicalizeSphereWorldPoint(x, z);
  x = c.x;
  z = c.z;
  const u = (x / H) * SPHERE_LAMBDA_MAX;
  const theta = SPHERE_THETA_MIN + ((z / H + 1) * 0.5) * SPHERE_THETA_SPAN;
  const phi = u;
  const st = Math.sin(theta);
  return out.set(
    SPHERE_MOON_RADIUS * st * Math.cos(phi),
    SPHERE_MOON_RADIUS * Math.cos(theta),
    SPHERE_MOON_RADIUS * st * Math.sin(phi)
  );
}

export function flatXZToSphereSurface(x: number, z: number): THREE.Vector3 {
  return flatXZToSphereSurfaceInto(new THREE.Vector3(), x, z);
}

/** Surface point including crater displacement (matches rendered moon mesh). */
export function flatXZToSphereSurfaceDisplaced(x: number, z: number): THREE.Vector3 {
  const p = flatXZToSphereSurface(x, z);
  const d = sphereCraterDisplacementMeters(x, z);
  return p.normalize().multiplyScalar(SPHERE_MOON_RADIUS - d);
}

/** Unit outward normal on the moon at flat coords (same point as {@link flatXZToSphereSurface}). */
export function flatXZToSphereNormal(x: number, z: number): THREE.Vector3 {
  // Keep camera/object "up" stable: use smooth sphere normal (not noisy crater micro normal).
  return flatXZToSphereSurface(x, z).normalize();
}

/**
 * World point on the moon (radius ≈ {@link SPHERE_MOON_RADIUS}) → flat sim XZ.
 * Used for ray/sphere picking.
 */
/** Writes flat sim XZ for a surface point; reuses `out` to avoid per-call allocations (e.g. minimap vertex loops). */
export function sphereSurfacePointToFlatXZInto(
  out: { x: number; z: number },
  p: THREE.Vector3
): { x: number; z: number } {
  const R = SPHERE_MOON_RADIUS;
  const yn = THREE.MathUtils.clamp(p.y / R, -1, 1);
  const theta = Math.acos(yn);
  const phi = Math.atan2(p.z, p.x);
  const x = (phi / SPHERE_LAMBDA_MAX) * H;
  const z = (((theta - SPHERE_THETA_MIN) / SPHERE_THETA_SPAN) * 2 - 1) * H;
  const c = canonicalizeSphereWorldPoint(x, z);
  out.x = c.x;
  out.z = c.z;
  return out;
}

export function sphereSurfacePointToFlatXZ(p: THREE.Vector3): { x: number; z: number } {
  return sphereSurfacePointToFlatXZInto({ x: 0, z: 0 }, p);
}

/**
 * Meters subtracted from each stamp's `blockRadius` for **ground unit** center tests only.
 * Shrinks the solid slightly so units can skirt the numerical rim instead of freezing with a move order.
 * Placement / footprints still use {@link sphereCraterBlockedAtFlatXZ} (full radius).
 */
export const SPHERE_UNIT_CRATER_RADIUS_INSET = 0.1;
/** Extra inset for structure placement so base layout can be tighter near crater rims. */
export const SPHERE_PLACEMENT_CRATER_RADIUS_INSET = 0.45;

/**
 * True inside procedural crater basins — units/structures cannot use these XZ cells (sphere mode only).
 */
export function sphereCraterBlockedAtFlatXZ(x: number, z: number): boolean {
  const c0 = canonicalizeSphereWorldPoint(x, z);
  x = c0.x;
  z = c0.z;
  for (const c of CRATER_STAMPS) {
    if (Math.hypot(x - c.x, z - c.z) <= c.blockRadius) return true;
  }
  return false;
}

/** Same as {@link sphereCraterBlockedAtFlatXZ} but with a slightly smaller blocking disc for walking units. */
export function sphereCraterBlockedAtFlatXZForGroundUnit(x: number, z: number): boolean {
  const c0 = canonicalizeSphereWorldPoint(x, z);
  x = c0.x;
  z = c0.z;
  for (const c of CRATER_STAMPS) {
    const r = Math.max(0.12, c.blockRadius - SPHERE_UNIT_CRATER_RADIUS_INSET);
    if (Math.hypot(x - c.x, z - c.z) <= r) return true;
  }
  return false;
}

/** Inward displacement along surface normal for the low-poly moon mesh (matches crater basins). */
export function sphereCraterDisplacementMeters(x: number, z: number): number {
  const c0 = canonicalizeSphereWorldPoint(x, z);
  x = c0.x;
  z = c0.z;
  // Keep globe smooth; crater readability comes from placed crater meshes.
  let d = Math.max(0, (fbm2(x * 0.024, z * 0.024) - 0.5) * 0.035);
  for (const c of CRATER_STAMPS) {
    const t = craterDistance01(x, z, c);
    if (t < 1 && c.depth > 1.75) {
      const basin = 1 - t * t;
      d += basin * basin * 0.06;
    }
  }
  return Math.max(0, d);
}

/** Any cell center under the footprint lies in a blocked crater. */
export function sphereTerrainBlocksFootprint(
  _state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  const inset = SPHERE_PLACEMENT_CRATER_RADIUS_INSET;
  for (let i = 0; i < footW; i += 1) {
    for (let j = 0; j < footD; j += 1) {
      const wx = GRID_ORIGIN_X + (gx + i + 0.5) * GRID_CELL_SIZE;
      const wz = GRID_ORIGIN_Z + (gz + j + 0.5) * GRID_CELL_SIZE;
      const c0 = canonicalizeSphereWorldPoint(wx, wz);
      if (spherePolarCapBlocksFlatXZ(c0.x, c0.z)) return true;
      let blocked = false;
      for (const c of CRATER_STAMPS) {
        if (Math.hypot(c0.x - c.x, c0.z - c.z) <= Math.max(0.12, c.blockRadius - inset)) {
          blocked = true;
          break;
        }
      }
      if (blocked) return true;
    }
  }
  return false;
}

export function sphereTerrainBlocksUnitXZ(_state: GameState, px: number, pz: number): boolean {
  void px;
  void pz;
  // Units should not hit invisible terrain masks. Structures/resources still respect crater/polar placement rules.
  return false;
}

/** Ray vs origin-centered ground sphere (ideal radius; matches flat↔sphere mapping). */
export function rayIntersectGroundSphere(ray: THREE.Ray, out: THREE.Vector3): boolean {
  const r = SPHERE_MOON_RADIUS;
  const a = ray.direction.lengthSq();
  const b = 2 * ray.origin.dot(ray.direction);
  const c = ray.origin.lengthSq() - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const s = Math.sqrt(disc);
  let t = (-b - s) / (2 * a);
  if (t < 0) t = (-b + s) / (2 * a);
  if (t < 0) return false;
  out.copy(ray.origin).addScaledVector(ray.direction, t);
  return true;
}

/**
 * Sim plane coords + nominal height → world position on the presented globe (Y = “up” from regolith).
 */
export function simXZYToSphereWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(flatXZToSphereSurfaceDisplaced(x, z));
  out.addScaledVector(flatXZToSphereNormal(x, z), y);
  return out;
}
