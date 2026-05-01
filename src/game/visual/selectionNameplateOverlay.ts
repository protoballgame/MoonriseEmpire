import * as THREE from "three";
import { getUnitMaxHp } from "../../core/balance";
import {
  formatStructureProductionLine,
  formatStructureStatusLine,
  formatUnitActivityLine
} from "../../core/selectionCardCopy";
import { isStructureBuilt, structureCenter, structureProducesKind, type GameState } from "../../core/state/GameState";
import { structureDisplayName } from "../../core/structureDisplayNames";
import { tuning } from "../../core/runtimeTuning";
import { unitNameplateLabel } from "../../core/unitDisplayNames";
import { surfacePointFromWorldXZ } from "../../core/world/worldSurface";

/**
 * Screen-space labels for the local player's selected units and structures (name + HP).
 */
export class SelectionNameplateOverlay {
  private readonly layer: HTMLDivElement;
  private readonly labelByUnitId = new Map<string, HTMLDivElement>();
  private readonly labelByStructureId = new Map<string, HTMLDivElement>();
  private readonly vec = new THREE.Vector3();

  constructor(
    parent: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly localPlayerId: string,
    private readonly applySpherePresentation?: (v: THREE.Vector3) => void
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "selection-nameplate-overlay";
    this.layer.setAttribute("aria-hidden", "true");
    parent.appendChild(this.layer);
  }

  syncFromState(state: GameState): void {
    const sel = state.selections[this.localPlayerId] ?? [];
    const selectedUnits = new Set(sel);
    const alive = new Map(state.units.map((u) => [u.id, u]));

    for (const id of [...this.labelByUnitId.keys()]) {
      if (!selectedUnits.has(id) || !alive.has(id)) {
        this.labelByUnitId.get(id)?.remove();
        this.labelByUnitId.delete(id);
      }
    }

    for (const id of sel) {
      const u = alive.get(id);
      if (!u) continue;
      let el = this.labelByUnitId.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "unit-nameplate";
        this.layer.appendChild(el);
        this.labelByUnitId.set(id, el);
      }
      const maxHp = getUnitMaxHp(u.kind);
      const cargo =
        u.kind === "N" && u.carriedMinerals > 0 ? ` · ore ${Math.round(u.carriedMinerals)}` : "";
      const act = formatUnitActivityLine(u, state);
      el.textContent = `${unitNameplateLabel(u.kind)} · HP ${Math.round(u.hp)}/${maxHp}${cargo}\n${act}`;
    }

    const sSel = state.structureSelections[this.localPlayerId] ?? [];
    const selectedStructs = new Set(sSel);
    const structs = new Map(state.structures.map((s) => [s.id, s]));

    for (const id of [...this.labelByStructureId.keys()]) {
      if (!selectedStructs.has(id) || !structs.has(id)) {
        this.labelByStructureId.get(id)?.remove();
        this.labelByStructureId.delete(id);
      }
    }

    for (const id of sSel) {
      const s = structs.get(id);
      if (!s) continue;
      let el = this.labelByStructureId.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "unit-nameplate unit-nameplate--structure";
        this.layer.appendChild(el);
        this.labelByStructureId.set(id, el);
      }
      const prod =
        structureProducesKind(s) !== null && isStructureBuilt(s)
          ? `\n${formatStructureProductionLine(s)}`
          : "";
      el.textContent = `${structureDisplayName(s.kind)} · HP ${Math.round(s.hp)}/${s.maxHp}\n${formatStructureStatusLine(s)}${prod}`;
    }
  }

  updatePositions(state: GameState): void {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const oy = tuning.ui.nameplateOffsetY;
    const soy = tuning.ui.structureNameplateOffsetY;

    for (const [id, el] of this.labelByUnitId) {
      const u = state.units.find((x) => x.id === id);
      if (!u) continue;
      surfacePointFromWorldXZ(state.terrain, u.position.x, u.position.y + oy, u.position.z, this.vec);
      this.applySpherePresentation?.(this.vec);
      this.projectAndPlace(el, w, h, rect);
    }

    for (const [id, el] of this.labelByStructureId) {
      const s = state.structures.find((x) => x.id === id);
      if (!s) continue;
      const c = structureCenter(s);
      surfacePointFromWorldXZ(state.terrain, c.x, c.y + soy, c.z, this.vec);
      this.applySpherePresentation?.(this.vec);
      this.projectAndPlace(el, w, h, rect);
    }
  }

  private projectAndPlace(el: HTMLDivElement, w: number, h: number, rect: DOMRect): void {
    this.vec.project(this.camera);
    if (Math.abs(this.vec.x) > 1.02 || Math.abs(this.vec.y) > 1.02) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    const x = (this.vec.x * 0.5 + 0.5) * w + rect.left;
    const y = (-this.vec.y * 0.5 + 0.5) * h + rect.top;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  dispose(): void {
    for (const el of this.labelByUnitId.values()) el.remove();
    for (const el of this.labelByStructureId.values()) el.remove();
    this.labelByUnitId.clear();
    this.labelByStructureId.clear();
    this.layer.remove();
  }
}
