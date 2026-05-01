import * as THREE from "three";
import { GRID_CELL_SIZE } from "../../core/world/worldGrid";
import { SPHERE_MOON_RADIUS } from "../../core/world/sphereTerrain";

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildScaleReferenceMeshes(): THREE.Group {
  const g = new THREE.Group();
  g.name = "moonScaleReference";

  const mat1 = new THREE.MeshStandardMaterial({ color: 0x33d6ff, roughness: 0.6, metalness: 0.05 });
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat1);
  m1.name = "ref_1m_cube";
  m1.position.set(SPHERE_MOON_RADIUS + 2.0, 0.5, 0);
  g.add(m1);

  const mat10 = new THREE.MeshStandardMaterial({ color: 0x7dff65, roughness: 0.65, metalness: 0.02 });
  const m10 = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 0.25), mat10);
  m10.name = "ref_10m_bar";
  m10.position.set(SPHERE_MOON_RADIUS + 8.0, 0.125, 2.0);
  g.add(m10);

  const matCell = new THREE.MeshStandardMaterial({ color: 0xffb65a, roughness: 0.7, metalness: 0.02 });
  const cell = new THREE.Mesh(new THREE.BoxGeometry(GRID_CELL_SIZE, 0.1, GRID_CELL_SIZE), matCell);
  cell.name = "ref_grid_cell_2p5m";
  cell.position.set(SPHERE_MOON_RADIUS + 3.6, 0.05, -2.2);
  g.add(cell);

  return g;
}

function cloneMoonForExport(scene: THREE.Scene): THREE.Object3D | null {
  const moon = scene.getObjectByName("moonSphereSurface");
  if (!moon) return null;
  const root = new THREE.Group();
  root.name = "moonReferenceExport";
  root.add(moon.clone(true));
  root.add(buildScaleReferenceMeshes());
  return root;
}

export function installMoonReferenceExporter(scene: THREE.Scene): void {
  const exportNow = async (): Promise<void> => {
    const root = cloneMoonForExport(scene);
    if (!root) return;
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const exporter = new GLTFExporter();
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          downloadBlob("moon-reference.glb", new Blob([result], { type: "model/gltf-binary" }));
        } else {
          downloadBlob("moon-reference.gltf", new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
        }
      },
      () => {
        /* no-op */
      },
      { binary: true, onlyVisible: true, includeCustomExtensions: false }
    );
  };

  (window as unknown as { exportMoonReferenceModel?: () => void }).exportMoonReferenceModel = () => {
    void exportNow();
  };
  window.addEventListener("keydown", (ev) => {
    if (ev.repeat) return;
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyE") {
      ev.preventDefault();
      void exportNow();
    }
  });
}

