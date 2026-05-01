import * as THREE from "three";
import type { ResourcesGatheredEvent, SimulationEvent } from "../../core/sim/simulationEvents";
import { surfacePointFromWorldXZ } from "../../core/world/worldSurface";
import { DAMAGE_NUMBER_CONFIG, type DamageNumberVisualConfig } from "./damageNumberConfig";

export interface DamageNumberOverlayOptions {
  config?: DamageNumberVisualConfig;
  /** If set, only this player's gather pops are shown (damage numbers unchanged). */
  localPlayerIdForGatherPops?: string;
  /** Rotate canonical moon points to match the main view moon spin (sphere presentation). */
  applySpherePresentation?: (v: THREE.Vector3) => void;
}

interface ActivePop {
  element: HTMLDivElement;
  baseX: number;
  baseY: number;
  baseZ: number;
  age: number;
}

/**
 * Screen-space floating damage text driven by simulation events.
 * Replace `config` or CSS classes later for VFX without touching combat code.
 */
export class DamageNumberOverlay {
  private readonly layer: HTMLDivElement;
  private readonly pops: ActivePop[] = [];
  private readonly vec = new THREE.Vector3();
  private config: DamageNumberVisualConfig;
  private readonly localPlayerIdForGatherPops: string | null;
  private readonly applySpherePresentation?: (v: THREE.Vector3) => void;

  constructor(
    parent: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer,
    configOrOptions?: DamageNumberVisualConfig | DamageNumberOverlayOptions
  ) {
    const opts =
      configOrOptions && "className" in configOrOptions
        ? { config: configOrOptions as DamageNumberVisualConfig }
        : (configOrOptions as DamageNumberOverlayOptions | undefined);
    this.config = opts?.config ?? DAMAGE_NUMBER_CONFIG;
    this.localPlayerIdForGatherPops = opts?.localPlayerIdForGatherPops ?? null;
    this.applySpherePresentation = opts?.applySpherePresentation;
    this.layer = document.createElement("div");
    this.layer.className = "damage-number-overlay";
    this.layer.setAttribute("aria-hidden", "true");
    parent.appendChild(this.layer);
  }

  setConfig(config: Partial<DamageNumberVisualConfig>): void {
    this.config = { ...this.config, ...config };
  }

  processEvents(events: readonly SimulationEvent[]): void {
    for (const ev of events) {
      if (ev.type === "damage_dealt") {
        this.spawn(ev.amount, ev.position.x, ev.position.y, ev.position.z);
      } else if (ev.type === "resources_gathered") {
        this.spawnGather(ev);
      }
    }
  }

  update(deltaSeconds: number): void {
    const { lifetimeSeconds, anchorOffsetY, driftUpPerSecond } = this.config;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    for (let i = this.pops.length - 1; i >= 0; i -= 1) {
      const pop = this.pops[i];
      pop.age += deltaSeconds;
      if (pop.age >= lifetimeSeconds) {
        pop.element.remove();
        this.pops.splice(i, 1);
        continue;
      }

      const rise = anchorOffsetY + pop.age * driftUpPerSecond;
      surfacePointFromWorldXZ("sphere", pop.baseX, pop.baseY + rise, pop.baseZ, this.vec);
      this.applySpherePresentation?.(this.vec);
      this.vec.project(this.camera);

      const x = (this.vec.x * 0.5 + 0.5) * w + rect.left;
      const y = (-this.vec.y * 0.5 + 0.5) * h + rect.top;

      pop.element.style.left = `${x}px`;
      pop.element.style.top = `${y}px`;

      const t = pop.age / lifetimeSeconds;
      const opacity = 1 - t * t;
      pop.element.style.opacity = String(opacity);
    }
  }

  dispose(): void {
    for (const pop of this.pops) pop.element.remove();
    this.pops.length = 0;
    this.layer.remove();
  }

  private spawn(amount: number, x: number, y: number, z: number): void {
    const { className, variantClassName, fractionDigits } = this.config;
    const text =
      fractionDigits > 0
        ? amount.toFixed(fractionDigits)
        : String(Math.round(amount));

    const el = document.createElement("div");
    el.className = `${className} ${variantClassName}`;
    el.textContent = text;

    this.layer.appendChild(el);
    this.pops.push({
      element: el,
      baseX: x,
      baseY: y,
      baseZ: z,
      age: 0
    });
  }

  private spawnGather(ev: ResourcesGatheredEvent): void {
    if (
      this.localPlayerIdForGatherPops !== null &&
      ev.playerId !== this.localPlayerIdForGatherPops
    ) {
      return;
    }
    const { className } = this.config;
    const text = `+${Number.isInteger(ev.amount) ? String(ev.amount) : ev.amount.toFixed(1)}`;
    const kindClass = "damage-number--gather-mineral";

    const el = document.createElement("div");
    el.className = `${className} ${kindClass}`;
    el.textContent = text;

    this.layer.appendChild(el);
    this.pops.push({
      element: el,
      baseX: ev.position.x,
      baseY: ev.position.y,
      baseZ: ev.position.z,
      age: 0
    });
  }
}
