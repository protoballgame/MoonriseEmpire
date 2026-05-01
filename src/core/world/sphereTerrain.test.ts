import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  flatXZToSphereSurface,
  rayIntersectGroundSphere,
  sphereCraterBlockedAtFlatXZ,
  sphereCraterBlockedAtFlatXZForGroundUnit,
  sphereCraterStamps,
  spherePolarCapBlocksFlatXZ,
  spherePlayableZAbsLimit,
  sphereSurfacePointToFlatXZ,
  SPHERE_MOON_RADIUS,
  SPHERE_UNIT_CRATER_RADIUS_INSET
} from "./sphereTerrain";
import { GROUND_HALF_EXTENT } from "./worldGrid";
import {
  canonicalizeSphereWorldPoint,
  nearestSphereEquivalentWorldPoint,
  projectSphereDiskToWorldXZ,
  projectWorldXZToSphereDisk
} from "./worldSurface";

describe("sphereTerrain mapping", () => {
  it("flags flat coordinates in the reserved polar cap", () => {
    const lim = spherePlayableZAbsLimit();
    expect(spherePolarCapBlocksFlatXZ(0, lim + 3)).toBe(true);
    expect(spherePolarCapBlocksFlatXZ(0, -lim - 3)).toBe(true);
    expect(spherePolarCapBlocksFlatXZ(12, 0)).toBe(false);
  });

  it("ground-unit crater collision is slightly inset vs placement (rim walkable)", () => {
    const stamps = sphereCraterStamps();
    expect(stamps.length).toBeGreaterThan(0);
    const c = stamps[0];
    const pz = c.z;
    const mid = c.blockRadius - SPHERE_UNIT_CRATER_RADIUS_INSET * 0.45;
    const px = c.x + mid;
    expect(sphereCraterBlockedAtFlatXZ(px, pz)).toBe(true);
    expect(sphereCraterBlockedAtFlatXZForGroundUnit(px, pz)).toBe(false);
  });

  it("round-trips near origin within tolerance", () => {
    const x = 12.3;
    const z = -8.1;
    const p = flatXZToSphereSurface(x, z);
    expect(Math.abs(p.length() - SPHERE_MOON_RADIUS)).toBeLessThan(0.02);
    const back = sphereSurfacePointToFlatXZ(p);
    expect(Math.abs(back.x - x)).toBeLessThan(0.08);
    expect(Math.abs(back.z - z)).toBeLessThan(0.08);
  });

  it("ray hits ground sphere from outside", () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 200, 0), new THREE.Vector3(0, -1, 0));
    const hit = new THREE.Vector3();
    expect(rayIntersectGroundSphere(ray, hit)).toBe(true);
    expect(Math.abs(hit.length() - SPHERE_MOON_RADIUS)).toBeLessThan(1e-3);
  });

  it("clamped corners stay inside playable extent after inverse map", () => {
    const h = GROUND_HALF_EXTENT * 0.9;
    const p = flatXZToSphereSurface(h, h);
    const b = sphereSurfacePointToFlatXZ(p);
    expect(Math.abs(b.x)).toBeLessThanOrEqual(GROUND_HALF_EXTENT + 1e-3);
    expect(Math.abs(b.z)).toBeLessThanOrEqual(GROUND_HALF_EXTENT + 1e-3);
  });

  it("canonicalizes pole crossings into stable world coordinates", () => {
    const h = GROUND_HALF_EXTENT;
    const south = canonicalizeSphereWorldPoint(8, -h - 6);
    const north = canonicalizeSphereWorldPoint(8, h + 6);
    expect(Math.abs(south.z)).toBeLessThanOrEqual(h + 1e-6);
    expect(Math.abs(north.z)).toBeLessThanOrEqual(h + 1e-6);
  });

  it("picks nearest equivalent sphere point for 360 continuity", () => {
    const a = nearestSphereEquivalentWorldPoint(-GROUND_HALF_EXTENT + 2, 0, GROUND_HALF_EXTENT - 1, 0);
    expect(a.x).toBeGreaterThan(0);
  });

  it("round-trips sphere disk minimap projection", () => {
    const center = { x: 0, z: 0 };
    const p = { x: 14, z: 9 };
    const disk = projectWorldXZToSphereDisk(p.x, p.z, center.x, center.z, 100);
    expect(disk.visible).toBe(true);
    const back = projectSphereDiskToWorldXZ(disk.x, disk.y, center.x, center.z, 100);
    expect(back).not.toBeNull();
    const diskBack = projectWorldXZToSphereDisk(back?.x ?? 0, back?.z ?? 0, center.x, center.z, 100);
    expect(Math.abs(diskBack.x - disk.x)).toBeLessThan(0.5);
    expect(Math.abs(diskBack.y - disk.y)).toBeLessThan(0.5);
  });
});
