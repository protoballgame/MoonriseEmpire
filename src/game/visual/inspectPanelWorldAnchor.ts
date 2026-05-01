import * as THREE from "three";
import { resourceFieldCenterWorld } from "../../core/economy/resourceFieldGeometry";
import { structureCenter, type GameState } from "../../core/state/GameState";
import { tuning } from "../../core/runtimeTuning";
import { surfacePointFromWorldXZ } from "../../core/world/worldSurface";
import type { WorldInspectHit } from "../prototype";

const vec = new THREE.Vector3();

/**
 * Positions the inspect HUD card above the inspected world object (screen-projected).
 */
export function positionInspectPanelWorld(
  el: HTMLElement,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  state: GameState,
  hit: WorldInspectHit | null,
  applySpherePresentation?: (v: THREE.Vector3) => void
): void {
  if (!hit) return;

  let wx: number;
  let wy: number;
  let wz: number;

  if (hit.kind === "field") {
    el.classList.remove("inspect-panel--stack-above");
    const f = state.resourceFields.find((x) => x.id === hit.id);
    if (!f || (f.reserve !== null && f.reserve <= 0)) return;
    const c = resourceFieldCenterWorld(f);
    wx = c.x;
    wy = c.y + 1.15;
    wz = c.z;
  } else if (hit.kind === "structure") {
    el.classList.add("inspect-panel--stack-above");
    const s = state.structures.find((x) => x.id === hit.id);
    if (!s || s.hp <= 0) return;
    const c = structureCenter(s);
    wx = c.x;
    /** Share the nameplate anchor; CSS stacks the inspect card above it. */
    wy = c.y + tuning.ui.structureNameplateOffsetY;
    wz = c.z;
  } else {
    el.classList.add("inspect-panel--stack-above");
    const u = state.units.find((x) => x.id === hit.id);
    if (!u || u.hp <= 0) return;
    wx = u.position.x;
    /** Share the nameplate anchor; CSS stacks the inspect card above it. */
    wy = u.position.y + tuning.ui.nameplateOffsetY;
    wz = u.position.z;
  }

  surfacePointFromWorldXZ(state.terrain, wx, wy, wz, vec);
  applySpherePresentation?.(vec);
  vec.project(camera);
  if (Math.abs(vec.x) > 1.02 || Math.abs(vec.y) > 1.02) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "visible";
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (vec.x * 0.5 + 0.5) * rect.width + rect.left;
  const y = (-vec.y * 0.5 + 0.5) * rect.height + rect.top;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}
