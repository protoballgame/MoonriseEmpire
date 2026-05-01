import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildSurfaceTangentFrame,
  sphereGeodesicDistanceWorldXZ,
  sphereGreatCircleEastNorth
} from "./worldSurface";
import { SPHERE_MOON_RADIUS } from "./sphereTerrain";

describe("sphere geodesic helpers", () => {
  it("sphereGeodesicDistanceWorldXZ matches chord angle on ideal sphere", () => {
    const a = sphereGeodesicDistanceWorldXZ(0, 0, 10, 5);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(SPHERE_MOON_RADIUS * Math.PI);
  });

  it("sphereGreatCircleEastNorth returns a horizontal unit direction in the tangent frame", () => {
    const east = new THREE.Vector3();
    const north = new THREE.Vector3();
    const normal = new THREE.Vector3();
    buildSurfaceTangentFrame("sphere", 2, -8, east, north, normal);
    const g = sphereGreatCircleEastNorth(2, -8, 22, -6, east, north);
    expect(g).not.toBeNull();
    const h = Math.hypot(g!.east, g!.north);
    expect(h).toBeGreaterThan(0.99);
    expect(h).toBeLessThan(1.01);
  });
});
