import type { GameState, SimUnit } from "../state/GameState";
import { sphereTerrainBlocksUnitXZ } from "../world/sphereTerrain";
import { topologyDeltaXZ } from "../world/worldTopology";
import {
  buildSurfaceTangentFrame,
  canonicalizeSphereWorldPoint,
  nearestSphereEquivalentWorldPoint,
  projectSurfacePointToWorldXZ,
  sphereGreatCircleEastNorth
} from "../world/worldSurface";
import { SPHERE_MOON_RADIUS } from "../world/sphereTerrain";
import * as THREE from "three";

/**
 * Must match `resolveUnitStructureFootprintPush` in SimulationEngine — expanded AABB for unit vs building.
 */
export const FOOTPRINT_UNIT_COLLISION_MARGIN = 0.02;
const sphereStepNormal = new THREE.Vector3();
const sphereStepEast = new THREE.Vector3();
const sphereStepNorth = new THREE.Vector3();
const sphereStepSurface = new THREE.Vector3();

/** When sliding finds no legal step, search outward for walkable XZ (sphere rim / pinch escape). */
const UNSTICK_RADII = [0.06, 0.1, 0.16, 0.24, 0.34, 0.48, 0.66, 0.9, 1.2, 1.55, 2, 2.5, 3.1, 3.8, 4.6];
const UNSTICK_ANGLE_STEPS = 40;

function snapGroundUnitWorldXZToSphereSurface(pos: { x: number; z: number }): void {
  buildSurfaceTangentFrame("sphere", pos.x, pos.z, sphereStepEast, sphereStepNorth, sphereStepNormal);
  sphereStepSurface.copy(sphereStepNormal).multiplyScalar(SPHERE_MOON_RADIUS);
  const world = projectSurfacePointToWorldXZ("sphere", sphereStepSurface);
  const c = canonicalizeSphereWorldPoint(world.x, world.z);
  pos.x = c.x;
  pos.z = c.z;
}

function spiralFindUnblockedXZ(px: number, pz: number, unit: SimUnit, state: GameState): { x: number; z: number } | null {
  for (const r of UNSTICK_RADII) {
    for (let i = 0; i < UNSTICK_ANGLE_STEPS; i += 1) {
      const a = (i / UNSTICK_ANGLE_STEPS) * Math.PI * 2;
      let nx = px + Math.cos(a) * r;
      let nz = pz + Math.sin(a) * r;
      const c = canonicalizeSphereWorldPoint(nx, nz);
      nx = c.x;
      nz = c.z;
      if (!unitXZBlockedByStructures(nx, nz, unit, state)) return { x: nx, z: nz };
    }
  }
  return null;
}

/**
 * True if this XZ point lies inside a footprint that should block `unit` (same exemptions as footprint push).
 */
export function unitXZBlockedByStructures(px: number, pz: number, unit: SimUnit, state: GameState): boolean {
  void unit;
  if (sphereTerrainBlocksUnitXZ(state, px, pz)) return true;
  // Structures should never stop units. Hidden footprint collision is more damaging to RTS readability
  // than occasional clipping, so placement still uses footprints but movement ignores them entirely.
  return false;
}

/** Relative floor so nearly-pure N/S/E/W moves still try the non-dominant axis as a slide. */
function significantAxisComponent(component: number, stepLen: number): boolean {
  const abs = Math.abs(component);
  if (abs > 1e-10) return true;
  return stepLen > 1e-8 && abs > stepLen * 1e-7;
}

/**
 * Try full (dx,dz), then X-only, then Z-only from `(px,pz)`; null if all would enter blocking geometry.
 */
function tryAxisAlignedSlideStep(
  px: number,
  pz: number,
  dvx: number,
  dvz: number,
  unit: SimUnit,
  state: GameState
): { x: number; z: number } | null {
  const stepLen = Math.hypot(dvx, dvz);
  if (!unitXZBlockedByStructures(px + dvx, pz + dvz, unit, state)) {
    return { x: px + dvx, z: pz + dvz };
  }
  if (significantAxisComponent(dvx, stepLen) && !unitXZBlockedByStructures(px + dvx, pz, unit, state)) {
    return { x: px + dvx, z: pz };
  }
  if (significantAxisComponent(dvz, stepLen) && !unitXZBlockedByStructures(px, pz + dvz, unit, state)) {
    return { x: px, z: pz + dvz };
  }
  return null;
}

/**
 * Axis-aligned obstacle slide: try full step, then X-only, then Z-only.
 * If still blocked (common when marching almost straight into a long wall), try **tangential** motion
 * perpendicular to the intended direction (±90° in XZ) at multiple scales, then **cardinal/diagonal**
 * probes so miners can skirt 1×1 pads (e.g. Solar Array) instead of hugging one face forever.
 */
export function slideXZPastStructureFootprints(
  px: number,
  pz: number,
  dvx: number,
  dvz: number,
  unit: SimUnit,
  state: GameState,
  goalHint?: { x: number; z: number }
): { x: number; z: number } {
  const primary = tryAxisAlignedSlideStep(px, pz, dvx, dvz, unit, state);
  if (primary) return primary;

  const len = Math.hypot(dvx, dvz);
  if (len < 1e-8) return { x: px, z: pz };

  const nx = dvx / len;
  const nz = dvz / len;
  /** Right / left perpendiculars to travel direction in XZ (same speed magnitude). */
  const tangents: { ex: number; ez: number }[] = [
    { ex: -nz, ez: nx },
    { ex: nz, ez: -nx }
  ];

  if (goalHint) {
    const gx = goalHint.x - px;
    const gz = goalHint.z - pz;
    tangents.sort((a, b) => b.ex * gx + b.ez * gz - (a.ex * gx + a.ez * gz));
  }

  // Keep slide speed reasonably high when skimming obstacles; avoid tiny-step crawl.
  const tangentScales = [1.4, 1.2, 1.04, 0.98, 0.92, 0.84, 0.76, 0.68];
  for (const scale of tangentScales) {
    const s = len * scale;
    if (s < 1e-8) continue;
    for (const { ex, ez } of tangents) {
      const esc = tryAxisAlignedSlideStep(px, pz, ex * s, ez * s, unit, state);
      if (esc) return esc;
    }
  }

  /** Last resort: small cardinal/diagonal nudges (helps when tangents graze a second footprint). */
  const probe = Math.max(len, 0.22);
  const probes: { dx: number; dz: number }[] = [
    { dx: probe, dz: 0 },
    { dx: -probe, dz: 0 },
    { dx: 0, dz: probe },
    { dx: 0, dz: -probe },
    { dx: probe * 0.65, dz: probe * 0.65 },
    { dx: probe * 0.65, dz: -probe * 0.65 },
    { dx: -probe * 0.65, dz: probe * 0.65 },
    { dx: -probe * 0.65, dz: -probe * 0.65 }
  ];
  for (const { dx, dz } of probes) {
    const esc = tryAxisAlignedSlideStep(px, pz, dx, dz, unit, state);
    if (esc) return esc;
  }

  const wideProbe = Math.max(len * 1.45, 0.48);
  const angleSteps = 28;
  for (let i = 0; i < angleSteps; i += 1) {
    const a = (Math.PI * 2 * i) / angleSteps;
    const esc = tryAxisAlignedSlideStep(px, pz, Math.cos(a) * wideProbe, Math.sin(a) * wideProbe, unit, state);
    if (esc) return esc;
  }

  if (len > 1e-6) {
    const esc = spiralFindUnblockedXZ(px, pz, unit, state);
    if (esc && (Math.abs(esc.x - px) > 1e-6 || Math.abs(esc.z - pz) > 1e-6)) return esc;
  }

  // Never freeze a unit on invisible/oversized collision. If all steering probes fail,
  // honor the requested step and allow clipping rather than leaving the unit stuck.
  return { x: px + dvx, z: pz + dvz };
}

/**
 * Step `unit` toward `to` with axis-aligned sliding past structure footprints (XZ).
 * Sphere mode: great-circle steering + micro-substeps so long ticks and obstacles stay stable.
 */
export function moveGroundUnitTowardPoint(
  unit: SimUnit,
  state: GameState,
  to: { x: number; y: number; z: number },
  speed: number,
  deltaSeconds: number
): void {
  const travel = speed * deltaSeconds;
  /** Small steps reduce tunneling past crater rims and smooth sliding on the globe. */
  const maxStepDist = 0.22;
  const steps = Math.max(1, Math.ceil(travel / maxStepDist));
  const dt = deltaSeconds / steps;
  for (let i = 0; i < steps; i += 1) {
    moveGroundUnitTowardPointOnce(unit, state, to, speed, dt);
  }
}

function moveGroundUnitTowardPointOnce(
  unit: SimUnit,
  state: GameState,
  to: { x: number; y: number; z: number },
  speed: number,
  deltaSeconds: number
): void {
  const pos = unit.position;
  if (unitXZBlockedByStructures(pos.x, pos.z, unit, state)) {
    const esc = spiralFindUnblockedXZ(pos.x, pos.z, unit, state);
    if (esc) {
      pos.x = esc.x;
      pos.z = esc.z;
      snapGroundUnitWorldXZToSphereSurface(pos);
    }
  }
  let toTarget: { x: number; y: number; z: number };
  buildSurfaceTangentFrame("sphere", pos.x, pos.z, sphereStepEast, sphereStepNorth, sphereStepNormal);
  const gc = sphereGreatCircleEastNorth(pos.x, pos.z, to.x, to.z, sphereStepEast, sphereStepNorth);
  if (gc) {
    toTarget = {
      x: gc.east * gc.geodesic,
      y: to.y - pos.y,
      z: gc.north * gc.geodesic
    };
  } else {
    const xz = topologyDeltaXZ(state, pos.x, pos.z, to.x, to.z);
    toTarget = { x: xz.dx, y: to.y - pos.y, z: xz.dz };
  }
  const len = Math.sqrt(toTarget.x * toTarget.x + toTarget.y * toTarget.y + toTarget.z * toTarget.z);
  if (len < 1e-4) return;
  const inv = 1 / len;
  const dvx = toTarget.x * inv * speed * deltaSeconds;
  const dvz = toTarget.z * inv * speed * deltaSeconds;
  /** Real chart XZ toward the order — not `pos + tangent*geodesic` (that mixes bases and breaks slides from far away). */
  const goalNear = nearestSphereEquivalentWorldPoint(to.x, to.z, pos.x, pos.z);
  const goalHint = { x: goalNear.x, z: goalNear.z };
  const next = slideXZPastStructureFootprints(pos.x, pos.z, dvx, dvz, unit, state, goalHint);
  sphereStepSurface.copy(sphereStepNormal).multiplyScalar(SPHERE_MOON_RADIUS);
  sphereStepSurface.addScaledVector(sphereStepEast, next.x - pos.x);
  sphereStepSurface.addScaledVector(sphereStepNorth, next.z - pos.z);
  sphereStepSurface.normalize().multiplyScalar(SPHERE_MOON_RADIUS);
  const world = projectSurfacePointToWorldXZ("sphere", sphereStepSurface);
  const near = nearestSphereEquivalentWorldPoint(world.x, world.z, next.x, next.z);
  const c = canonicalizeSphereWorldPoint(near.x, near.z);
  pos.x = c.x;
  pos.z = c.z;
  pos.y += toTarget.y * inv * speed * deltaSeconds;
}
