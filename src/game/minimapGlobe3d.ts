import * as THREE from "three";
import { resourceFieldCenterWorld } from "../core/economy/resourceFieldGeometry";
import type { GameState, TeamId } from "../core/state/GameState";
import { footprintCenterWorld } from "../core/world/worldGrid";
import {
  flatXZToSphereSurfaceInto,
  SPHERE_MOON_RADIUS,
  sphereSurfacePointToFlatXZ,
  sphereSurfacePointToFlatXZInto
} from "../core/world/sphereTerrain";

type MinimapFogLike = {
  enabled: boolean;
  atWorld: (wx: number, wz: number) => { explored: boolean; visible: boolean };
};

const tmpSurface = new THREE.Vector3();
const tmpLocal = new THREE.Vector3();
const tmpRay = new THREE.Raycaster();
const tmpPickNdc = new THREE.Vector2();
const tmpVertexDir = new THREE.Vector3();
const tmpInvRot = new THREE.Quaternion();
const tmpLightDir = new THREE.Vector3(0.48, 0.88, 0.32).normalize();
const tmpMiniCamPos = new THREE.Vector3();
const tmpMiniCamUp = new THREE.Vector3();
const MINIMAP_SURFACE_COLOR_INTERVAL_MS = 140;
const minimapVertexFlatXZ = { x: 0, z: 0 };

function simXZToUnitGlobePosition(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  flatXZToSphereSurfaceInto(out, x, z);
  out.normalize().multiplyScalar(1.04);
  return out;
}

function teamColorHex(team: TeamId, local: boolean): number {
  if (local) return 0x7ad0ff;
  if (team === "blue") return 0x6ab8ff;
  return 0xff8866;
}

export type MinimapGlobe3dOptions = {
  widthPx: number;
  heightPx: number;
  localPlayerId: string;
  rivalPlayerId: string | null;
  issueRmbAtWorld: (worldX: number, worldZ: number, shiftKey: boolean, ctrlKey: boolean) => void;
  focusCameraOnWorldXZ?: (worldX: number, worldZ: number) => void;
  getCameraBounds?: () => { minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Legacy hook from when the minimap rolled with the main camera. Ignored now: the tactical globe
   * intentionally keeps equator left/right and poles up/down.
   */
  getSphereFrame?: () => { centerX: number; centerZ: number; east: { x: number; y: number; z: number } } | null;
  getMinimapFog?: () => MinimapFogLike;
  mirrorX?: boolean;
  getMoonSpinQuaternion?: () => THREE.Quaternion;
  getViewFrame?: () => {
    position: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
  } | null;
  applyMoonSpinFromScreenDelta?: (dx: number, dy: number) => void;
  resetMoonSpin?: () => void;
};

/**
 * Small Three.js globe for the sphere minimap: grab-drag rotates the moon; click picks surface → world XZ.
 */
export function createMinimapGlobe3d(opts: MinimapGlobe3dOptions): {
  domElement: HTMLElement;
  sync: (state: GameState) => void;
  dispose: () => void;
} {
  const wrap = document.createElement("div");
  wrap.className = "hud-minimap-globe";

  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2);
  const W = Math.round(opts.widthPx * dpr);
  const H = Math.round(opts.heightPx * dpr);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power"
  });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.width = `${opts.widthPx}px`;
  renderer.domElement.style.height = `${opts.heightPx}px`;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  renderer.domElement.style.cursor = "grab";
  renderer.domElement.draggable = false;
  wrap.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, opts.widthPx / Math.max(1, opts.heightPx), 0.08, 20);
  camera.position.set(0, 0.12, 2.42);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xd8d0f0, 0.38));
  const dir = new THREE.DirectionalLight(0xfff0e0, 1.05);
  dir.position.set(0.85, 1.15, 0.95);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x8898ff, 0.22);
  rim.position.set(-1.1, -0.35, -0.85);
  scene.add(rim);

  const rotRoot = new THREE.Group();
  scene.add(rotRoot);

  const moonGeom = new THREE.SphereGeometry(1, 64, 48);
  const moonColors = new Float32Array(moonGeom.attributes.position.count * 3);
  moonGeom.setAttribute("color", new THREE.BufferAttribute(moonColors, 3));
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xc8b8d8,
    roughness: 0.58,
    metalness: 0.12,
    emissive: 0x1a1220,
    emissiveIntensity: 0.22,
    vertexColors: true
  });
  const moon = new THREE.Mesh(moonGeom, moonMat);
  rotRoot.add(moon);

  function makeReferenceLines(): THREE.Group {
    const g = new THREE.Group();
    g.name = "minimapLatitudeLongitude";
    const radius = 1.026;
    const segs = 96;
    const lineMat = (color: number, opacity: number) =>
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: true,
        depthWrite: false
      });

    const addLine = (points: THREE.Vector3[], color: number, opacity: number): void => {
      const pos = new Float32Array(points.length * 3);
      for (let i = 0; i < points.length; i += 1) {
        pos[i * 3] = points[i]!.x;
        pos[i * 3 + 1] = points[i]!.y;
        pos[i * 3 + 2] = points[i]!.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.add(new THREE.Line(geo, lineMat(color, opacity)));
    };

    const equator: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i += 1) {
      const t = (i / segs) * Math.PI * 2;
      equator.push(new THREE.Vector3(Math.cos(t) * radius, 0, Math.sin(t) * radius));
    }
    addLine(equator, 0xb8c8ff, 0.52);

    for (const lat of [-60, -30, 30, 60]) {
      const theta = THREE.MathUtils.degToRad(lat);
      const y = Math.sin(theta) * radius;
      const r = Math.cos(theta) * radius;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i += 1) {
        const t = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r));
      }
      addLine(pts, 0x8798d8, 0.34);
    }

    for (let m = 0; m < 12; m += 1) {
      const lon = (m / 12) * Math.PI * 2;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i += 1) {
        const t = -Math.PI / 2 + (i / segs) * Math.PI;
        pts.push(
          new THREE.Vector3(
            Math.cos(t) * Math.cos(lon) * radius,
            Math.sin(t) * radius,
            Math.cos(t) * Math.sin(lon) * radius
          )
        );
      }
      addLine(pts, 0x7082c4, 0.28);
    }

    g.renderOrder = 8;
    return g;
  }

  const referenceLines = makeReferenceLines();
  rotRoot.add(referenceLines);

  const markers = new THREE.Group();
  rotRoot.add(markers);

  const unitGeo = new THREE.SphereGeometry(0.05, 8, 6);
  const structGeo = new THREE.BoxGeometry(0.1, 0.06, 0.1);
  const fieldMineralGeo = new THREE.SphereGeometry(0.042, 6, 4);
  const fieldEnergyGeo = new THREE.SphereGeometry(0.032, 6, 4);
  const cameraCenterMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 8, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false
    })
  );
  cameraCenterMarker.name = "minimapCameraCenter";
  cameraCenterMarker.renderOrder = 31;
  markers.add(cameraCenterMarker);

  const unitMeshes = new Map<string, THREE.Mesh>();
  const structMeshes = new Map<string, THREE.Mesh>();
  const fieldMeshes = new Map<string, THREE.Mesh>();
  let lastSurfaceColorUpdateMs = -Infinity;
  let lastSurfaceFogOn = false;

  const drag = {
    pointerId: -1,
    active: false,
    /** Which button started the gesture (0 / 1 / 2). */
    pointerButton: -1,
    /** True when this gesture should orbit the globe (LMB or RMB drag). */
    orbit: false,
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    movedSq: 0
  };
  let rmbStart: { x: number; y: number } | null = null;
  const pickSurfaceXZ = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    let ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    if (opts.mirrorX === true) ndcX *= -1;
    tmpPickNdc.set(ndcX, ndcY);
    tmpRay.setFromCamera(tmpPickNdc, camera);
    const hits = tmpRay.intersectObject(moon, false);
    if (hits.length === 0) return null;
    rotRoot.worldToLocal(tmpLocal.copy(hits[0]!.point));
    tmpLocal.normalize().multiplyScalar(SPHERE_MOON_RADIUS);
    return sphereSurfacePointToFlatXZ(tmpLocal);
  };

  const insideEllipse = (clientX: number, clientY: number): boolean => {
    const rect = renderer.domElement.getBoundingClientRect();
    const u = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const v = ((clientY - rect.top) / rect.height - 0.5) * 2;
    return u * u + v * v <= 1.02;
  };

  renderer.domElement.addEventListener("contextmenu", (ev) => ev.preventDefault());
  renderer.domElement.addEventListener("dragstart", (ev) => ev.preventDefault());

  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (!insideEllipse(ev.clientX, ev.clientY)) return;
    ev.preventDefault();
    drag.pointerId = ev.pointerId;
    drag.active = true;
    drag.pointerButton = ev.button;
    drag.orbit = ev.button === 0 || ev.button === 2;
    drag.downX = drag.lastX = ev.clientX;
    drag.downY = drag.lastY = ev.clientY;
    drag.movedSq = 0;
    if (ev.button === 2) rmbStart = { x: ev.clientX, y: ev.clientY };
    renderer.domElement.setPointerCapture(ev.pointerId);
    renderer.domElement.style.cursor = "grabbing";
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
  });

  const onWindowPointerMove = (ev: PointerEvent): void => {
    if (!drag.active || drag.pointerId !== ev.pointerId) return;
    const rawDx = ev.movementX || ev.clientX - drag.lastX;
    const dx = rawDx * (opts.mirrorX === true ? -1 : 1);
    const dy = ev.clientY - drag.lastY;
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    drag.movedSq += dx * dx + dy * dy;
    // Like the main canvas: don’t gate on `ev.buttons` during capture (Windows often clears it mid-drag).
    if (drag.orbit && opts.applyMoonSpinFromScreenDelta && Math.hypot(dx, dy) > 0) {
      opts.applyMoonSpinFromScreenDelta(dx, dy);
    }
  };

  const release = (ev: PointerEvent): void => {
    if (drag.pointerId !== ev.pointerId) return;
    try {
      renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    renderer.domElement.style.cursor = "grab";
    drag.active = false;
    drag.pointerId = -1;
    drag.pointerButton = -1;
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerUp);
  };

  const onWindowPointerUp = (ev: PointerEvent): void => {
    if (drag.pointerId !== ev.pointerId) return;
    if (
      ev.button === 0 &&
      drag.pointerButton === 0 &&
      opts.focusCameraOnWorldXZ &&
      drag.movedSq < 64
    ) {
      const hit = pickSurfaceXZ(ev.clientX, ev.clientY);
      if (hit) opts.focusCameraOnWorldXZ(hit.x, hit.z);
    }
    if (ev.button === 2 && rmbStart) {
      const d = Math.hypot(ev.clientX - rmbStart.x, ev.clientY - rmbStart.y);
      const clickLike = d < 12 && drag.movedSq < 180 && insideEllipse(ev.clientX, ev.clientY);
      if (clickLike) {
        const hit = pickSurfaceXZ(ev.clientX, ev.clientY);
        if (hit) opts.issueRmbAtWorld(hit.x, hit.z, ev.shiftKey, ev.ctrlKey);
      }
      rmbStart = null;
    }
    release(ev);
  };

  renderer.domElement.addEventListener("pointercancel", release);

  renderer.domElement.addEventListener("dblclick", (ev) => {
    if (!opts.focusCameraOnWorldXZ) return;
    if (!insideEllipse(ev.clientX, ev.clientY)) return;
    opts.resetMoonSpin?.();
    const hit = pickSurfaceXZ(ev.clientX, ev.clientY);
    if (hit) opts.focusCameraOnWorldXZ(hit.x, hit.z);
  });

  function pruneMap<K extends string>(map: Map<K, THREE.Mesh>, alive: Set<K>): void {
    for (const [id, mesh] of map) {
      if (!alive.has(id)) {
        markers.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        map.delete(id);
      }
    }
  }

  function syncCameraBoundsMarker(): void {
    const b = opts.getCameraBounds?.();
    if (!b) {
      cameraCenterMarker.visible = false;
      return;
    }

    cameraCenterMarker.visible = true;
    simXZToUnitGlobePosition((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, cameraCenterMarker.position);
    cameraCenterMarker.position.multiplyScalar(1.02);
  }

  function sync(state: GameState): void {
    // Mirror the main moon spin so the minimap visibly moves with the planet/sky while avoiding camera-frame roll.
    const spin = opts.getMoonSpinQuaternion?.();
    if (spin) rotRoot.quaternion.copy(spin);
    else rotRoot.quaternion.identity();

    const viewFrame = opts.getViewFrame?.();
    if (viewFrame) {
      tmpMiniCamPos.set(viewFrame.position.x, viewFrame.position.y, viewFrame.position.z);
      if (tmpMiniCamPos.lengthSq() > 0.000001) {
        tmpMiniCamPos.normalize().multiplyScalar(2.42);
        camera.position.copy(tmpMiniCamPos);
      }
      tmpMiniCamUp.set(viewFrame.up.x, viewFrame.up.y, viewFrame.up.z);
      if (tmpMiniCamUp.lengthSq() > 0.000001) camera.up.copy(tmpMiniCamUp).normalize();
      camera.lookAt(0, 0, 0);
    }

    const fogSrc = opts.getMinimapFog?.();
    const fogOn = fogSrc?.enabled === true;

    const nowMs = performance.now();
    const shouldUpdateSurfaceColors =
      fogOn !== lastSurfaceFogOn ||
      nowMs - lastSurfaceColorUpdateMs >= MINIMAP_SURFACE_COLOR_INTERVAL_MS;
    if (shouldUpdateSurfaceColors) {
      lastSurfaceColorUpdateMs = nowMs;
      lastSurfaceFogOn = fogOn;
      const posAttr = moonGeom.attributes.position as THREE.BufferAttribute;
      const colAttr = moonGeom.attributes.color as THREE.BufferAttribute;
      tmpInvRot.copy(rotRoot.quaternion).invert();
      for (let i = 0; i < posAttr.count; i += 1) {
        tmpVertexDir.fromBufferAttribute(posAttr, i).normalize();
        tmpVertexDir.applyQuaternion(tmpInvRot);
        tmpSurface.copy(tmpVertexDir).multiplyScalar(SPHERE_MOON_RADIUS);
        sphereSurfacePointToFlatXZInto(minimapVertexFlatXZ, tmpSurface);
        let fogMul = 1;
        if (fogOn && fogSrc) {
          const f = fogSrc.atWorld(minimapVertexFlatXZ.x, minimapVertexFlatXZ.z);
          if (!f.explored) fogMul = 0.11;
          else if (!f.visible) fogMul = 0.5;
        }
        const lambert = THREE.MathUtils.clamp(
          0.32 + 0.68 * Math.max(0, tmpVertexDir.dot(tmpLightDir)),
          0.2,
          1
        );
        const c = lambert * fogMul;
        colAttr.setXYZ(i, c, c, c);
      }
      colAttr.needsUpdate = true;
    }

    const aliveU = new Set<string>();
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      aliveU.add(u.id);
      const local = u.playerId === opts.localPlayerId;
      if (fogOn && fogSrc && !local && !fogSrc.atWorld(u.position.x, u.position.z).visible) continue;

      let mesh = unitMeshes.get(u.id);
      if (!mesh) {
        const mat = new THREE.MeshStandardMaterial({
          color: teamColorHex(u.team, local),
          emissive: teamColorHex(u.team, local),
          emissiveIntensity: 0.35,
          roughness: 0.45,
          metalness: 0.2
        });
        mesh = new THREE.Mesh(unitGeo, mat);
        markers.add(mesh);
        unitMeshes.set(u.id, mesh);
      }
      simXZToUnitGlobePosition(u.position.x, u.position.z, mesh.position);
    }
    pruneMap(unitMeshes, aliveU);

    const aliveS = new Set<string>();
    for (const s of state.structures) {
      if (s.hp <= 0) continue;
      aliveS.add(s.id);
      const c = footprintCenterWorld(s.gx, s.gz, s.footW, s.footD);
      const local = s.playerId === opts.localPlayerId;
      const enemy =
        opts.rivalPlayerId !== null ? s.playerId === opts.rivalPlayerId : s.playerId !== opts.localPlayerId;
      if (fogOn && fogSrc && !local && !fogSrc.atWorld(c.x, c.z).explored) continue;

      let mesh = structMeshes.get(s.id);
      if (!mesh) {
        const col = local ? 0x5599ee : enemy ? 0xdd6644 : 0x8899aa;
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.22,
          roughness: 0.5,
          metalness: 0.15
        });
        mesh = new THREE.Mesh(structGeo, mat);
        markers.add(mesh);
        structMeshes.set(s.id, mesh);
      }
      simXZToUnitGlobePosition(c.x, c.z, mesh.position);
      const k = 0.12 + Math.min(0.22, (s.footW + s.footD) * 0.04);
      mesh.scale.setScalar(k);
    }
    pruneMap(structMeshes, aliveS);

    const aliveF = new Set<string>();
    for (const f of state.resourceFields) {
      if (f.reserve !== null && f.reserve <= 0) continue;
      aliveF.add(f.id);
      const c = resourceFieldCenterWorld(f);
      if (fogOn && fogSrc && !fogSrc.atWorld(c.x, c.z).explored) continue;

      let mesh = fieldMeshes.get(f.id);
      if (!mesh) {
        const col = f.kind === "minerals" ? 0xe8b060 : 0x55ddaa;
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.28,
          roughness: 0.55,
          metalness: 0.1
        });
        mesh = new THREE.Mesh(f.kind === "minerals" ? fieldMineralGeo : fieldEnergyGeo, mat);
        markers.add(mesh);
        fieldMeshes.set(f.id, mesh);
      }
      simXZToUnitGlobePosition(c.x, c.z, mesh.position);
    }
    pruneMap(fieldMeshes, aliveF);

    syncCameraBoundsMarker();

    renderer.render(scene, camera);
  }

  function dispose(): void {
    referenceLines.traverse((ch) => {
      if (ch instanceof THREE.Line) {
        ch.geometry.dispose();
        (ch.material as THREE.Material).dispose();
      }
    });
    renderer.dispose();
    moonGeom.dispose();
    moonMat.dispose();
    unitGeo.dispose();
    structGeo.dispose();
    fieldMineralGeo.dispose();
    fieldEnergyGeo.dispose();
    (cameraCenterMarker.geometry as THREE.BufferGeometry).dispose();
    (cameraCenterMarker.material as THREE.Material).dispose();
    for (const m of unitMeshes.values()) (m.material as THREE.Material).dispose();
    for (const m of structMeshes.values()) (m.material as THREE.Material).dispose();
    for (const m of fieldMeshes.values()) (m.material as THREE.Material).dispose();
    unitMeshes.clear();
    structMeshes.clear();
    fieldMeshes.clear();
  }

  return { domElement: wrap, sync, dispose };
}
