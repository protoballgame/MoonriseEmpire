import type * as THREE from "three";
import type { GameState } from "../core/state/GameState";
import { fibonacci } from "../core/goldenScale";
import { createMinimapGlobe3d } from "./minimapGlobe3d";

/** Slightly larger minimap to match the expanded arena (+F(6) px). */
const CSS_W = 228 + fibonacci(6);
const CSS_H = 228 + fibonacci(6);

export interface MinimapFogSource {
  enabled: boolean;
  atWorld: (wx: number, wz: number) => { explored: boolean; visible: boolean };
}

/** Tactical moon globe: drag to rotate, click to focus camera, RMB to command. */
export function createHudMinimap(opts: {
  getState: () => GameState;
  localPlayerId: string;
  rivalPlayerId: string | null;
  issueRmbAtWorld: (worldX: number, worldZ: number, shiftKey: boolean, ctrlKey: boolean) => void;
  focusCameraOnWorldXZ?: (worldX: number, worldZ: number) => void;
  getCameraBounds?: () => { minX: number; maxX: number; minZ: number; maxZ: number };
  getSphereFrame?: () => { centerX: number; centerZ: number; east: { x: number; y: number; z: number } } | null;
  mirrorX?: boolean;
  getMinimapFog?: () => MinimapFogSource;
  getMoonSpinQuaternion?: () => THREE.Quaternion;
  getViewFrame?: () => {
    position: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
  };
  applyMoonSpinFromScreenDelta?: (dx: number, dy: number) => void;
  resetMoonSpin?: () => void;
}): { element: HTMLElement; draw: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "hud-minimap";
  const title = document.createElement("div");
  title.className = "hud-minimap-title";
  title.textContent = "Moon";
  const globe = createMinimapGlobe3d({
    widthPx: CSS_W,
    heightPx: CSS_H,
    localPlayerId: opts.localPlayerId,
    rivalPlayerId: opts.rivalPlayerId,
    issueRmbAtWorld: opts.issueRmbAtWorld,
    focusCameraOnWorldXZ: opts.focusCameraOnWorldXZ,
    getCameraBounds: opts.getCameraBounds,
    getSphereFrame: opts.getSphereFrame,
    getMinimapFog: opts.getMinimapFog,
    mirrorX: opts.mirrorX === true,
    getMoonSpinQuaternion: opts.getMoonSpinQuaternion,
    getViewFrame: opts.getViewFrame,
    applyMoonSpinFromScreenDelta: opts.applyMoonSpinFromScreenDelta,
    resetMoonSpin: opts.resetMoonSpin
  });
  wrap.appendChild(title);
  wrap.appendChild(globe.domElement);
  return {
    element: wrap,
    draw: () => {
      globe.sync(opts.getState());
    }
  };
}
