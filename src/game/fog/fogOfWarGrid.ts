import { resourceFieldCenterWorld } from "../../core/economy/resourceFieldGeometry";
import { isStructureBuilt, structureCenter, type GameState } from "../../core/state/GameState";
import {
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z,
  GROUND_HALF_EXTENT
} from "../../core/world/worldGrid";
import {
  canonicalizeSphereWorldPoint,
  fillSphereEquivalentWorldPoints,
  sphereGeodesicDistanceWorldXZ
} from "../../core/world/worldSurface";
import { BASE_STRUCTURE_VISION_RANGE, structureVisionRange } from "../../core/structureStats";

/** Sight radius granted by completed friendly buildings (matches exploration rules). */
export const FOG_STRUCTURE_VISION_RANGE = BASE_STRUCTURE_VISION_RANGE;
/** Higher-res fog sampling grid for smoother sphere/minimap presentation. */
export const FOG_CELL_SIZE = 0.45;

/** Grid bounds covering the play plane (aligned to `GRID_CELL_SIZE`). */
export const FOG_GX_MIN = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_X) / FOG_CELL_SIZE);
export const FOG_GX_MAX = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_X - 1e-6) / FOG_CELL_SIZE);
export const FOG_GZ_MIN = Math.floor((-GROUND_HALF_EXTENT - GRID_ORIGIN_Z) / FOG_CELL_SIZE);
export const FOG_GZ_MAX = Math.floor((GROUND_HALF_EXTENT - GRID_ORIGIN_Z - 1e-6) / FOG_CELL_SIZE);

const fogWrapPaintBuf: { x: number; z: number }[] = Array.from({ length: 8 }, () => ({ x: 0, z: 0 }));

export class FogOfWarGrid {
  readonly fw: number;
  readonly fh: number;
  /** Once seen, stays true for the match. */
  readonly explored: Uint8Array;
  private readonly visible: Uint8Array;

  constructor() {
    this.fw = FOG_GX_MAX - FOG_GX_MIN + 1;
    this.fh = FOG_GZ_MAX - FOG_GZ_MIN + 1;
    this.explored = new Uint8Array(this.fw * this.fh);
    this.visible = new Uint8Array(this.fw * this.fh);
  }

  reset(): void {
    this.explored.fill(0);
    this.visible.fill(0);
  }

  private idx(gx: number, gz: number): number {
    return (gz - FOG_GZ_MIN) * this.fw + (gx - FOG_GX_MIN);
  }

  private paintCircle(cx: number, cz: number, radius: number): void {
    const minGx = Math.max(FOG_GX_MIN, Math.floor((cx - radius - GRID_ORIGIN_X) / FOG_CELL_SIZE));
    const maxGx = Math.min(FOG_GX_MAX, Math.floor((cx + radius - GRID_ORIGIN_X) / FOG_CELL_SIZE));
    const minGz = Math.max(FOG_GZ_MIN, Math.floor((cz - radius - GRID_ORIGIN_Z) / FOG_CELL_SIZE));
    const maxGz = Math.min(FOG_GZ_MAX, Math.floor((cz + radius - GRID_ORIGIN_Z) / FOG_CELL_SIZE));
    for (let gx = minGx; gx <= maxGx; gx += 1) {
      for (let gz = minGz; gz <= maxGz; gz += 1) {
        const wx = GRID_ORIGIN_X + (gx + 0.5) * FOG_CELL_SIZE;
        const wz = GRID_ORIGIN_Z + (gz + 0.5) * FOG_CELL_SIZE;
        if (sphereGeodesicDistanceWorldXZ(cx, cz, wx, wz) <= radius) {
          this.visible[this.idx(gx, gz)] = 1;
        }
      }
    }
  }

  /**
   * Rebuilds current visibility from friendly units + completed friendly structures, then merges into `explored`.
   */
  recompute(state: GameState, localPlayerId: string): void {
    this.visible.fill(0);
    const paintWrapped = (cx: number, cz: number, radius: number): void => {
      const n = fillSphereEquivalentWorldPoints(cx, cz, fogWrapPaintBuf);
      for (let i = 0; i < n; i += 1) {
        const p = fogWrapPaintBuf[i];
        this.paintCircle(p.x, p.z, radius);
      }
    };
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      if (u.playerId !== localPlayerId) continue;
      paintWrapped(u.position.x, u.position.z, u.visionRange);
    }
    for (const s of state.structures) {
      if (s.hp <= 0 || s.playerId !== localPlayerId) continue;
      if (!isStructureBuilt(s)) continue;
      const c = structureCenter(s);
      paintWrapped(c.x, c.z, structureVisionRange(s.kind));
    }
    for (const f of state.resourceFields) {
      if (f.kind !== "minerals") continue;
      if (f.homePatchVisionOwnerId !== localPlayerId) continue;
      if (f.reserve !== null && f.reserve <= 0) continue;
      const c = resourceFieldCenterWorld(f);
      paintWrapped(c.x, c.z, FOG_STRUCTURE_VISION_RANGE);
    }
    for (let i = 0; i < this.visible.length; i += 1) {
      if (this.visible[i]) this.explored[i] = 1;
    }
  }

  private cellIndexAtWorld(x: number, z: number): number {
    const c = canonicalizeSphereWorldPoint(x, z);
    x = c.x;
    z = c.z;
    const gx = Math.floor((x - GRID_ORIGIN_X) / FOG_CELL_SIZE);
    const gz = Math.floor((z - GRID_ORIGIN_Z) / FOG_CELL_SIZE);
    if (gx < FOG_GX_MIN || gx > FOG_GX_MAX || gz < FOG_GZ_MIN || gz > FOG_GZ_MAX) return -1;
    return this.idx(gx, gz);
  }

  isClearAtWorld(x: number, z: number): boolean {
    const i = this.cellIndexAtWorld(x, z);
    return i >= 0 && this.visible[i] === 1;
  }

  isExploredAtWorld(x: number, z: number): boolean {
    const i = this.cellIndexAtWorld(x, z);
    return i >= 0 && this.explored[i] === 1;
  }

  /**
   * RGBA for a horizontal plane mesh. Normal blending: dst * (1 - alpha) with black RGB → darken.
   * Visible (in LOS): fully transparent so terrain/units read at full brightness.
   * Explored: ~50% darken. Unexplored: near-opaque black shroud.
   *
   * Row order matches `PlaneGeometry(120,120)` with `rotation.x = -π/2`: texture v=0 sits at world +Z
   * (high gz), v=1 at world −Z (low gz). Logical grid index `idx(gx,gz)` is gz-fastest in memory, so we
   * must map gz → texture row as `(FOG_GZ_MAX - gz)` when filling the GPU buffer (`flipY=false`).
   */
  writeToRgba(out: Uint8Array): void {
    const exploredDimA = 170; // stronger explored dim on sphere
    const shroudA = 255;
    for (let gz = FOG_GZ_MIN; gz <= FOG_GZ_MAX; gz += 1) {
      const texRow = FOG_GZ_MAX - gz;
      for (let gx = FOG_GX_MIN; gx <= FOG_GX_MAX; gx += 1) {
        const i = this.idx(gx, gz);
        const o = (texRow * this.fw + (gx - FOG_GX_MIN)) * 4;
        if (!this.explored[i]) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = shroudA;
        } else if (!this.visible[i]) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = exploredDimA;
        } else {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = 0;
        }
      }
      if (this.fw >= 2) {
        const rowStart = texRow * this.fw * 4;
        const rowEnd = rowStart + (this.fw - 1) * 4;
        const seamAlpha = Math.min(out[rowStart + 3], out[rowEnd + 3]);
        out[rowStart] = 0;
        out[rowStart + 1] = 0;
        out[rowStart + 2] = 0;
        out[rowStart + 3] = seamAlpha;
        out[rowEnd] = 0;
        out[rowEnd + 1] = 0;
        out[rowEnd + 2] = 0;
        out[rowEnd + 3] = seamAlpha;
      }
    }
  }
}
