import * as THREE from "three";
import { surfacePointFromWorldXZ } from "../../core/world/worldSurface";

interface Flash {
  el: HTMLDivElement;
  age: number;
  wx: number;
  wy: number;
  wz: number;
}

/**
 * Brief red circle at a world point (hit feedback).
 */
export class HitFlashOverlay {
  private readonly layer: HTMLDivElement;
  private readonly flashes: Flash[] = [];
  private readonly vec = new THREE.Vector3();

  constructor(
    parent: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly applySpherePresentation?: (v: THREE.Vector3) => void
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "hit-flash-overlay";
    this.layer.setAttribute("aria-hidden", "true");
    parent.appendChild(this.layer);
  }

  spawn(x: number, y: number, z: number): void {
    const el = document.createElement("div");
    el.className = "hit-flash";
    this.layer.appendChild(el);
    this.flashes.push({ el, age: 0, wx: x, wy: y, wz: z });
    this.projectToElement(el, x, y, z);
  }

  update(deltaSeconds: number): void {
    const lifetime = 0.28;
    const rect = this.renderer.domElement.getBoundingClientRect();

    for (let i = this.flashes.length - 1; i >= 0; i -= 1) {
      const f = this.flashes[i];
      f.age += deltaSeconds;
      const t = f.age / lifetime;
      if (t >= 1) {
        f.el.remove();
        this.flashes.splice(i, 1);
        continue;
      }
      const scale = 0.65 + 0.55 * Math.sin(t * Math.PI);
      f.el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      f.el.style.opacity = String((1 - t) * (1 - t));
      this.projectToElement(f.el, f.wx, f.wy, f.wz, rect);
    }
  }

  private projectToElement(
    el: HTMLDivElement,
    x: number,
    y: number,
    z: number,
    rect?: DOMRect
  ): void {
    const r = rect ?? this.renderer.domElement.getBoundingClientRect();
    surfacePointFromWorldXZ("sphere", x, y, z, this.vec);
    this.applySpherePresentation?.(this.vec);
    this.vec.project(this.camera);
    const sx = (this.vec.x * 0.5 + 0.5) * r.width + r.left;
    const sy = (-this.vec.y * 0.5 + 0.5) * r.height + r.top;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
  }

  dispose(): void {
    for (const f of this.flashes) f.el.remove();
    this.flashes.length = 0;
    this.layer.remove();
  }
}
