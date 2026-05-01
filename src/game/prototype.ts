import * as THREE from "three";
import {
  createGameCommand,
  type GameCommand,
  type PlaceableStructureKind
} from "../core/commands/GameCommand";
import { canPlanStructureForPlayer } from "../core/placementValidation";
import { resourceFieldCenterWorld } from "../core/economy/resourceFieldGeometry";
import type { SimResourceField } from "../core/economy/resourceFieldTypes";
import {
  structureCenter,
  structureProducesKind,
  type GameState,
  type SimStructure,
  type SimUnit,
  type StructureKind,
  type TeamId,
  type TerrainId
} from "../core/state/GameState";
import {
  footprintCenterWorld,
  GRID_CELL_SIZE,
  worldToCell
} from "../core/world/worldGrid";
import { topologyDistanceXZ } from "../core/world/worldTopology";
import { FogOfWarGrid } from "./fog/fogOfWarGrid";
import type { MilitaryKind } from "../core/balance";
import {
  clampSpherePlayableWorldXZ,
  rayIntersectGroundSphere,
  SPHERE_THETA_MIN,
  SPHERE_THETA_SPAN,
  SPHERE_MOON_RADIUS
} from "../core/world/sphereTerrain";
import {
  buildSurfaceTangentFrame,
  canonicalizeWorldPoint,
  nearestSphereEquivalentWorldPoint,
  projectSurfacePointToWorldXZ,
  sphereGeodesicDistanceWorldXZ,
  surfaceNormalFromWorldXZ,
  surfacePointFromWorldXZ
} from "../core/world/worldSurface";
import type { FormationId } from "../core/runtimeTuning";
import { isNeutralWorkerAdvancingConstruction } from "../core/sim/constructionAssist";
import { footprintForStructureKind } from "../core/structureFootprint";
import { tuning } from "../core/runtimeTuning";
import { createSphereMoonMesh } from "./visual/sphereMoonVisual";

const RMB_DRAG_THRESHOLD_PX = 8;
/** How many drag pixels correspond to one frame of full WASD pan at 60 Hz (see {@link moveSphereCameraTarget}). */
const RMB_PAN_PIXELS_PER_KEY_FRAME_EQUIV = 8;
const MOON_SPIN_MAX_PITCH_RAD = Math.PI / 4;
const VIEWPORT_PLANET_LOWER_BIAS_METERS = 3.8;
const INITIAL_CAMERA_DISTANCE = 68;
const HOME_OVERVIEW_CAMERA_DISTANCE = 72;
const HOME_OVERVIEW_CAMERA_PHI = 0.04;
const HOME_OVERVIEW_CAMERA_THETA = 0;

function isSceneLitSurfaceMat(
  m: THREE.Material | THREE.Material[]
): m is THREE.MeshStandardMaterial | THREE.MeshLambertMaterial {
  if (Array.isArray(m)) return false;
  return m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshLambertMaterial;
}

function isGlowMat(m: THREE.Material | THREE.Material[]): m is THREE.MeshBasicMaterial {
  return !Array.isArray(m) && m instanceof THREE.MeshBasicMaterial;
}
const LMB_MARQUEE_THRESHOLD_PX = 5;
const LMB_DOUBLE_CLICK_MS = 450;
const LMB_DOUBLE_CLICK_MAX_DIST_PX = 10;

/** Max great-circle distance (m) from click to a mineral patch center to issue gather (tighter than flat XZ slack). */
const GATHER_MINERAL_MAX_SURFACE_METERS = GRID_CELL_SIZE * 0.92;
const WORLD_UNIT_ATTACK_PICK = 3.4;
const WORLD_DEPOT_PICK = 10;
const EDGE_SCROLL_MARGIN_PX = 36;

const FORMATION_CYCLE: FormationId[] = ["square", "circle", "triangle", "none"];

function idsMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  if (set.size !== b.length) return false;
  return b.every((id) => set.has(id));
}

function unitColor(team: TeamId, kind: MilitaryKind): number {
  if (team === "blue") {
    if (kind === "R") return 0x4f97ff;
    if (kind === "P") return 0x58e8ff;
    if (kind === "N") return 0xa8b8c8;
    return 0x6effc1;
  }
  if (kind === "R") return 0xff8a4f;
  if (kind === "P") return 0xff6ea8;
  if (kind === "N") return 0xc8b0a0;
  return 0xffe06e;
}

export type { PlaceableStructureKind };

/** LMB inspect raycast result for HUD (ore, any structure, any unit). */
export type WorldInspectHit =
  | { kind: "field"; id: string }
  | { kind: "structure"; id: string }
  | { kind: "unit"; id: string };

export interface PrototypeViewOptions {
  localPlayerId: string;
  /** `sphere`: low-poly globe + crater impass; sim stays planar XZ. */
  terrain: TerrainId;
  /** Optional custom moon model URL (GLB/GLTF) for sphere visual override. */
  moonModelUrl?: string;
  /** Optional custom moon texture URL for loaded moon model. */
  moonTextureUrl?: string;
  /** Optional scale multiplier for custom moon model. */
  moonModelScale?: number;
  submitCommand: (command: GameCommand) => void;
  /** When set, next left-click on empty ground issues `place_structure` at the snapped cell. */
  getPendingPlaceStructureKind?: () => PlaceableStructureKind | null;
  /** Single LMB (non-marquee): world object under cursor for stats panel. */
  onInspect?: (hit: WorldInspectHit | null) => void;
  /** Optional callback when one-shot mobile command mode is consumed. */
  onMobileCommandConsumed?: () => void;
  /** Touch/mobile helper: when true, the next plain left tap on terrain behaves like RMB. */
  consumeMobileCommandMode?: () => boolean;
  /** When true (e.g. admin panel open), fog is disabled so tuning ranges stay readable. */
  getFogOfWarSuspended?: () => boolean;
  /** Double-tap Home (`H`): snap camera to local Command Core. */
  focusOnLocalHome?: () => void;
}

type RmbTrack = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
};

type LmbTrack = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  marquee: boolean;
  cameraDrag: boolean;
  pointerType: string;
};

/** Cosmetic ranged shot; sim is still hitscan. */
export type ProjectileTraceOpts = {
  radius?: number;
  maxAge?: number;
  color?: number;
  emissive?: number;
  emissiveIntensity?: number;
  startLift?: number;
  endLift?: number;
};

/** Last-known enemy pose for fog-of-war ghosts (client-only). */
type EnemySeenSnapshot = {
  x: number;
  y: number;
  z: number;
  kind: MilitaryKind;
  team: TeamId;
  playerId: string;
  attackClass: "melee" | "ranged";
};

/**
 * View + input only. All gameplay state transitions go through `submitCommand` → SimulationEngine.
 */
export class PrototypeView {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly projVec = new THREE.Vector3();
  /** Rotates moon + gameplay meshes in place; camera stays on its orbit anchor (minimap drag / arc gestures). */
  private readonly moonSpinRoot = new THREE.Group();
  private readonly moonSpinQuat = new THREE.Quaternion();
  private readonly moonSpinTargetQuat = new THREE.Quaternion();
  private readonly moonSpinQuatInv = new THREE.Quaternion();
  private moonSpinYawRad = 0;
  private moonSpinPitchRad = 0;
  private readonly tmpMoonPickRay = new THREE.Ray();
  private readonly tmpCanonMoonDir = new THREE.Vector3();
  private readonly tmpMoonYawQuat = new THREE.Quaternion();
  private readonly tmpMoonPitchQuat = new THREE.Quaternion();
  private readonly tmpCameraRight = new THREE.Vector3();
  private rmbPanHasPrevSample = false;
  private rmbPanPrevClientX = 0;
  private rmbPanPrevClientY = 0;
  private readonly sphereMoonMesh: THREE.Object3D;
  private readonly tmpSpherePos = new THREE.Vector3();
  private readonly tmpSphereN = new THREE.Vector3();
  private readonly tmpSphereNorth = new THREE.Vector3();
  private readonly tmpCameraOffset = new THREE.Vector3();
  private readonly unitUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpQuatSurf = new THREE.Quaternion();
  private readonly tmpQuatRing = new THREE.Quaternion();
  private readonly pointerGroundHit = new THREE.Vector3();
  private readonly pointerGroundTarget = new THREE.Vector3();
  private readonly tmpMinimapFrameNormal = new THREE.Vector3();
  private readonly tmpCameraToUnit = new THREE.Vector3();
  private readonly sphereEastTangent = new THREE.Vector3(1, 0, 0);
  private readonly meshByUnitId = new Map<string, THREE.Group>();
  private readonly meshByStructureId = new Map<string, THREE.Group>();
  private readonly pendingBuildGhostByKey = new Map<string, THREE.Group>();
  private readonly meshByResourceFieldId = new Map<string, THREE.Group>();
  private readonly rangedProjectiles: {
    mesh: THREE.Mesh;
    age: number;
    maxAge: number;
    start: THREE.Vector3;
    end: THREE.Vector3;
  }[] = [];
  /** Ground-plane rings when admin panel is open: cyan = vision, orange = attack. */
  private readonly adminRangeLayer = new THREE.Group();
  private readonly adminRangeByUnitId = new Map<
    string,
    { vision: THREE.Mesh; attack: THREE.Mesh; lastV: number; lastA: number }
  >();
  private readonly options: PrototypeViewOptions;
  private lastSyncedState: GameState | null = null;
  private lastPointerClientX = 0;
  private lastPointerClientY = 0;
  private hasPointerSample = false;
  private placementPreviewMesh: THREE.Mesh | null = null;
  private renderTimeSec = 0;
  /** Command feedback: field id → flash window for normalized fade. */
  private readonly resourceFieldFlash = new Map<string, { untilMs: number; startMs: number }>();
  /** Rally markers: visible while the owning structure is selected (local player). */
  private readonly rallyMarkerByStructureId = new Map<string, THREE.Group>();

  /** Control groups 0–9: units + structures (Ctrl+digit saves current selection). */
  private readonly controlGroups: { unitIds: string[]; structureIds: string[] }[] = Array.from(
    { length: 10 },
    () => ({ unitIds: [], structureIds: [] })
  );
  private readonly lastControlGroupTapMs: number[] = Array.from({ length: 10 }, () => 0);
  private idleNeutralCycleIdx = -1;
  private idleMilitaryCycleIdx = -1;
  private lastIdleNeutralTapMs = 0;
  private lastIdleMilitaryTapMs = 0;

  private readonly fogGrid: FogOfWarGrid;
  private readonly fogRgba: Uint8Array;
  private readonly fogTexture: THREE.DataTexture;
  private readonly fogSphereMesh: THREE.Mesh;
  private fogMatchId: string | null = null;
  private fogComputedForTick = -1;
  private fogComputedForPlayerId: string | null = null;
  private readonly lastSeenEnemy = new Map<string, EnemySeenSnapshot>();
  private readonly ghostMeshByUnitId = new Map<string, THREE.Group>();

  /** Azimuth (rad) around outward surface normal at anchor — horizontal drag spins the globe. */
  private cameraOrbitTheta = -0.75;
  /** 0 = camera along +surface normal (over anchor); approaches π/2 as view tilts toward horizon. */
  private cameraOrbitPhi = 0.9;
  private cameraDistance = INITIAL_CAMERA_DISTANCE;
  private readonly cameraTarget = new THREE.Vector3(0, 0, 0);
  private readonly keys: Record<string, boolean> = {};
  private lastHomeKeyDownMs = 0;

  private rmbTrack: RmbTrack | null = null;
  private rmbPointerId = -1;
  private rmbUsedCameraDrag = false;
  /** RMB began on regolith → canonical spin (same as minimap); otherwise camera pan. */
  private rmbSurfaceSpin = false;
  private rmbSpinArcPrevValid = false;
  private readonly rmbSpinArcPrev = new THREE.Vector3();
  private rmbPointerLockMoveDistance = 0;
  private rmbPointerLockTimer: number | null = null;
  private lmbTrack: LmbTrack | null = null;
  private readonly activeTouchPointers = new Map<number, { x: number; y: number }>();
  private touchPinchPrevDistance: number | null = null;
  /** Same-screen double pick on one unit → select all owned units of that kind (RTS double-click). */
  private lastLmbUnitPickForDouble: {
    unitId: string;
    timeMs: number;
    clientX: number;
    clientY: number;
  } | null = null;
  private readonly marqueeDiv: HTMLDivElement;

  private readonly onRmbCanvasMove: (ev: PointerEvent) => void;
  private readonly onRmbCanvasUp: (ev: PointerEvent) => void;
  private readonly onRmbPointerLockMove: (ev: MouseEvent) => void;
  private readonly onRmbPointerLockMouseUp: (ev: MouseEvent) => void;
  private readonly onLmbWindowMove: (ev: PointerEvent) => void;
  private readonly onLmbWindowUp: (ev: PointerEvent) => void;

  private sphereCameraAnchorXZ(): { x: number; z: number } {
    return canonicalizeWorldPoint("sphere", this.cameraTarget.x, this.cameraTarget.z);
  }

  private setCameraTargetXZ(x: number, z: number): void {
    const c = clampSpherePlayableWorldXZ(x, z);
    this.cameraTarget.set(c.x, 0, c.z);
  }

  private moveSphereCameraTarget(strafe: number, forward: number, distance: number): void {
    const anchor = this.sphereCameraAnchorXZ();
    buildSurfaceTangentFrame(
      "sphere",
      anchor.x,
      anchor.z,
      this.tmpSphereN,
      this.tmpSphereNorth,
      this.pointerGroundHit,
      this.sphereEastTangent
    );
    this.sphereEastTangent.copy(this.tmpSphereN);
    const s = strafe;
    const eastScale = Math.cos(this.cameraOrbitTheta) * s - Math.sin(this.cameraOrbitTheta) * forward;
    const northScale = -Math.sin(this.cameraOrbitTheta) * s - Math.cos(this.cameraOrbitTheta) * forward;
    this.tmpCameraOffset.copy(this.tmpSphereN).multiplyScalar(eastScale);
    this.tmpCameraOffset.addScaledVector(this.tmpSphereNorth, northScale);
    const moveLen = this.tmpCameraOffset.length();
    if (moveLen <= 1e-6) return;
    this.tmpCameraOffset.multiplyScalar(distance / moveLen);
    this.tmpSpherePos.copy(this.pointerGroundHit).multiplyScalar(SPHERE_MOON_RADIUS);
    this.tmpSpherePos.add(this.tmpCameraOffset).normalize().multiplyScalar(SPHERE_MOON_RADIUS);
    const next = projectSurfacePointToWorldXZ("sphere", this.tmpSpherePos);
    const near = nearestSphereEquivalentWorldPoint(next.x, next.z, this.cameraTarget.x, this.cameraTarget.z);
    const c = clampSpherePlayableWorldXZ(near.x, near.z);
    this.cameraTarget.set(c.x, 0, c.z);
  }

  /** Wrapped sim coords nearest to camera target (avoids seam pop-in at ±half-span). */
  private wrapSimXZNearCamera(x: number, z: number): { x: number; z: number } {
    const anchor = this.sphereCameraAnchorXZ();
    return nearestSphereEquivalentWorldPoint(x, z, anchor.x, anchor.z);
  }

  private installMoonSurfaceFogMaterial(): void {
    const fogTexelSize = new THREE.Vector2(1 / this.fogGrid.fw, 1 / this.fogGrid.fh);
    this.sphereMoonMesh.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.name !== "moonSphereSurface") return;
      const mat = obj.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) return;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms["sphereFogMap"] = { value: this.fogTexture };
        shader.uniforms["sphereFogTexelSize"] = { value: fogTexelSize };
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            `#include <common>
varying vec3 vSphereFogNormal;`
          )
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
vSphereFogNormal = normalize(position);`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
uniform sampler2D sphereFogMap;
uniform vec2 sphereFogTexelSize;
varying vec3 vSphereFogNormal;
vec2 sphereFogUv(vec2 uv) {
  return vec2(fract(uv.x + 1.0), clamp(1.0 - uv.y, 0.0, 1.0));
}
float sphereFogAlpha(vec3 n) {
  float phi = atan(n.z, n.x);
  float theta = acos(clamp(n.y, -1.0, 1.0));
  vec2 uv01 = vec2(
    fract(phi / (2.0 * ${Math.PI.toFixed(10)}) + 0.5),
    clamp((theta - ${SPHERE_THETA_MIN.toFixed(10)}) / ${SPHERE_THETA_SPAN.toFixed(10)}, 0.0, 1.0)
  );
  return texture2D(sphereFogMap, sphereFogUv(uv01)).a;
}`
          )
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
float sphereFog = sphereFogAlpha(normalize(vSphereFogNormal));
diffuseColor.rgb *= mix(1.0, 0.08, sphereFog);`
          );
      };
      mat.needsUpdate = true;
    });
  }

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, options: PrototypeViewOptions) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.options = options;
    this.fogGrid = new FogOfWarGrid();

    this.onRmbCanvasMove = this.handleRmbCanvasMove.bind(this);
    this.onRmbCanvasUp = this.handleRmbCanvasUp.bind(this);
    this.onRmbPointerLockMove = this.handleRmbPointerLockMove.bind(this);
    this.onRmbPointerLockMouseUp = this.handleRmbPointerLockMouseUp.bind(this);
    this.onLmbWindowMove = this.handleLmbWindowMove.bind(this);
    this.onLmbWindowUp = this.handleLmbWindowUp.bind(this);

    this.marqueeDiv = document.createElement("div");
    this.marqueeDiv.className = "selection-marquee";
    this.marqueeDiv.style.display = "none";
    const host = renderer.domElement.parentElement ?? document.body;
    host.appendChild(this.marqueeDiv);

    this.moonSpinRoot.name = "moonSpinRoot";
    this.scene.add(this.moonSpinRoot);

    this.sphereMoonMesh = createSphereMoonMesh({
      moonModelUrl: options.moonModelUrl,
      moonTextureUrl: options.moonTextureUrl,
      moonModelScale: options.moonModelScale
    });
    this.moonSpinRoot.add(this.sphereMoonMesh);

    const fogCells = this.fogGrid.fw * this.fogGrid.fh;
    this.fogRgba = new Uint8Array(fogCells * 4);
    this.fogTexture = new THREE.DataTexture(
      this.fogRgba,
      this.fogGrid.fw,
      this.fogGrid.fh,
      THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.wrapS = THREE.RepeatWrapping;
    this.fogTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.fogTexture.flipY = false;
    this.fogTexture.needsUpdate = true;
    this.installMoonSurfaceFogMaterial();
    // Keep fog close to the moon, but low-poly/lightweight so drag stays crisp on all browsers/GPUs.
    const fogSphereGeom = new THREE.SphereGeometry(SPHERE_MOON_RADIUS + 0.1, 64, 40);
    const fogSphereMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        // Overlay shell: avoid z-fighting/clipping against detailed custom moon meshes.
        depthTest: false,
        toneMapped: false,
        blending: THREE.NormalBlending,
        side: THREE.FrontSide,
        uniforms: {
          fogMap: { value: this.fogTexture },
          fogTexelSize: {
            value: new THREE.Vector2(1 / this.fogGrid.fw, 1 / this.fogGrid.fh)
          }
        },
        vertexShader: `
          varying vec3 vLocalNormal;
          varying vec3 vWorldPos;
          void main() {
            vLocalNormal = normalize(position);
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D fogMap;
          uniform vec2 fogTexelSize;
          varying vec3 vLocalNormal;
          varying vec3 vWorldPos;
          vec2 sphereFogUv(vec2 uv) {
            return vec2(fract(uv.x + 1.0), clamp(1.0 - uv.y, 0.0, 1.0));
          }
          void main() {
            vec3 wn = normalize(vLocalNormal);
            float phi = atan(wn.z, wn.x);
            float theta = acos(clamp(wn.y, -1.0, 1.0));
            vec2 uv01 = vec2(
              fract(phi / (2.0 * ${Math.PI.toFixed(10)}) + 0.5),
              clamp((theta - ${SPHERE_THETA_MIN.toFixed(10)}) / ${SPHERE_THETA_SPAN.toFixed(10)}, 0.0, 1.0)
            );
            // Single tap for maximum temporal crispness while dragging.
            float sampledA = texture2D(fogMap, sphereFogUv(uv01)).a;
            // depthTest is off so the shell can sit on irregular terrain; that also rasterizes the cap
            // over empty sky. Only blend fog when the view ray is aimed toward the moon (origin).
            vec3 viewTowardFrag = normalize(vWorldPos - cameraPosition);
            vec3 towardPlanet = normalize(-cameraPosition);
            float align = max(0.0, dot(viewTowardFrag, towardPlanet));
            float skyGate = smoothstep(0.1, 0.58, align);
            sampledA *= skyGate;
            gl_FragColor = vec4(0.0, 0.0, 0.0, sampledA);
          }
        `
    });
    this.fogSphereMesh = new THREE.Mesh(fogSphereGeom, fogSphereMat);
    this.fogSphereMesh.name = "fogOfWarOverlaySphere";
    this.fogSphereMesh.renderOrder = 2;
    // Keep mesh constructed for future fog work, but do not attach/render it:
    // this shell is the visible "horizon bubble" artifact over the sky.

    this.adminRangeLayer.name = "adminRangeOverlays";
    this.moonSpinRoot.add(this.adminRangeLayer);

    renderer.domElement.style.userSelect = "none";
    renderer.domElement.style.touchAction = "none";

    renderer.domElement.addEventListener("pointermove", (ev) => {
      this.lastPointerClientX = ev.clientX;
      this.lastPointerClientY = ev.clientY;
      this.hasPointerSample = true;
    });
    renderer.domElement.addEventListener("pointerleave", () => {
      this.hasPointerSample = false;
    });
    window.addEventListener("blur", () => {
      this.hasPointerSample = false;
      this.keys["w"] = false;
      this.keys["a"] = false;
      this.keys["s"] = false;
      this.keys["d"] = false;
      this.keys["arrowup"] = false;
      this.keys["arrowdown"] = false;
      this.keys["arrowleft"] = false;
      this.keys["arrowright"] = false;
    });

    this.attachInput();
    this.updateCameraTransform();
  }

  /**
   * When the runtime admin panel is open, draws every unit’s vision (cyan) and attack (orange) radius on the ground.
   */
  syncAdminRangeOverlays(show: boolean, state: GameState): void {
    this.adminRangeLayer.visible = show;
    if (!show) {
      for (const [, entry] of this.adminRangeByUnitId) {
        this.disposeRingMesh(entry.vision);
        this.disposeRingMesh(entry.attack);
        this.adminRangeLayer.remove(entry.vision);
        this.adminRangeLayer.remove(entry.attack);
      }
      this.adminRangeByUnitId.clear();
      return;
    }

    const alive = new Set(state.units.map((u) => u.id));
    for (const id of [...this.adminRangeByUnitId.keys()]) {
      if (!alive.has(id)) {
        const entry = this.adminRangeByUnitId.get(id)!;
        this.disposeRingMesh(entry.vision);
        this.disposeRingMesh(entry.attack);
        this.adminRangeLayer.remove(entry.vision);
        this.adminRangeLayer.remove(entry.attack);
        this.adminRangeByUnitId.delete(id);
      }
    }

    for (const u of state.units) {
      let entry = this.adminRangeByUnitId.get(u.id);
      if (!entry) {
        entry = {
          vision: this.createRangeRingMesh(0x40d8ff),
          attack: this.createRangeRingMesh(0xff9a3c),
          lastV: -1,
          lastA: -1
        };
        entry.vision.renderOrder = 1;
        entry.attack.renderOrder = 2;
        this.adminRangeLayer.add(entry.vision);
        this.adminRangeLayer.add(entry.attack);
        this.adminRangeByUnitId.set(u.id, entry);
      }
      if (entry.lastV !== u.visionRange) {
        entry.vision.geometry.dispose();
        entry.vision.geometry = new THREE.RingGeometry(u.visionRange * 0.94, u.visionRange, 80);
        entry.lastV = u.visionRange;
      }
      if (entry.lastA !== u.attackRange) {
        entry.attack.geometry.dispose();
        entry.attack.geometry = new THREE.RingGeometry(u.attackRange * 0.9, u.attackRange, 80);
        entry.lastA = u.attackRange;
      }
      this.adminRingOnSphere(entry.vision, u.position.x, 0.04, u.position.z);
      this.adminRingOnSphere(entry.attack, u.position.x, 0.055, u.position.z);
    }
  }

  clearControlGroups(): void {
    for (let i = 0; i < this.controlGroups.length; i += 1) {
      this.controlGroups[i] = { unitIds: [], structureIds: [] };
    }
  }

  syncFromState(state: GameState): void {
    this.lastSyncedState = state;
    const alive = new Set(state.units.map((u) => u.id));

    for (const [id, group] of this.meshByUnitId) {
      if (!alive.has(id)) {
        this.moonSpinRoot.remove(group);
        this.disposeObjectDeep(group);
        this.meshByUnitId.delete(id);
      }
    }

    for (const unit of state.units) {
      let group = this.meshByUnitId.get(unit.id);
      if (!group || this.unitGroupNeedsRebuild(group, unit)) {
        if (group) {
          this.moonSpinRoot.remove(group);
          this.disposeObjectDeep(group);
        }
        group = this.createUnitGroup(unit);
        this.meshByUnitId.set(unit.id, group);
        this.moonSpinRoot.add(group);
      }
      this.placeSimObject(group, unit.position.x, unit.position.y, unit.position.z);
    }

    const selected = new Set(state.selections[this.options.localPlayerId] ?? []);
    const localPid = this.options.localPlayerId;
    for (const unit of state.units) {
      const group = this.meshByUnitId.get(unit.id);
      if (!group) continue;
      const body = group.getObjectByName("unitBody") as THREE.Mesh | undefined;
      if (!body || !isSceneLitSurfaceMat(body.material)) continue;
      const isSelected = selected.has(unit.id);
      const building =
        unit.playerId === localPid &&
        unit.kind === "N" &&
        isNeutralWorkerAdvancingConstruction(state, unit);
      const polishPhase = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 5.2 + unit.id.length);

      let ring = group.getObjectByName("constructionBuildRing") as THREE.Mesh | undefined;
      if (building) {
        if (!ring) {
          ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.88, 0.065, 8, 40),
            new THREE.MeshBasicMaterial({
              color: 0xffcc55,
              transparent: true,
              opacity: 0.85,
              depthWrite: false
            })
          );
          ring.name = "constructionBuildRing";
          ring.rotation.x = Math.PI / 2;
          ring.position.y = 0.06;
          ring.renderOrder = 2;
          group.add(ring);
        }
        ring.visible = true;
        const ph = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 11);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.4 + ph * 0.5;
      } else if (ring) {
        ring.visible = false;
      }

      const baseCol = unitColor(unit.team, unit.kind);
      if (building) {
        body.material.emissive.setHex(0xffaa44);
        body.material.emissiveIntensity = isSelected ? 0.68 + polishPhase * 0.18 : 0.38 + polishPhase * 0.08;
      } else {
        body.material.emissive.setHex(baseCol);
        body.material.emissiveIntensity = isSelected ? 0.5 + polishPhase * 0.18 : 0.14 + polishPhase * 0.06;
      }

      const glow = group.getObjectByName("selectionGlowShell") as THREE.Mesh | undefined;
      if (glow && isGlowMat(glow.material)) {
        glow.visible = isSelected;
        glow.scale.setScalar(1.12 + polishPhase * 0.045);
        glow.material.opacity = isSelected ? 0.16 + polishPhase * 0.1 : 0;
      }
      const accent = group.getObjectByName("unitPolishAccent") as THREE.Mesh | undefined;
      if (accent && isGlowMat(accent.material)) {
        accent.material.opacity = 0.42 + polishPhase * 0.36;
        accent.scale.setScalar(0.86 + polishPhase * 0.18);
      }
    }

    const structAlive = new Set(state.structures.map((s) => s.id));
    for (const [id, grp] of this.meshByStructureId) {
      if (!structAlive.has(id)) {
        this.moonSpinRoot.remove(grp);
        this.disposeObjectDeep(grp);
        this.meshByStructureId.delete(id);
      }
    }
    for (const st of state.structures) {
      let grp = this.meshByStructureId.get(st.id);
      if (!grp || this.structureGroupNeedsRebuild(grp, st)) {
        if (grp) {
          this.moonSpinRoot.remove(grp);
          this.disposeObjectDeep(grp);
        }
        grp = this.createStructureGroup(st);
        this.meshByStructureId.set(st.id, grp);
        this.moonSpinRoot.add(grp);
      }
      const c = structureCenter(st);
      this.placeSimObject(grp, c.x, 0, c.z);

      const body = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
      const isSelectedStructure = (state.structureSelections[this.options.localPlayerId] ?? []).includes(st.id);
      const polishPhase = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 3.8 + st.id.length);
      if (body && isSceneLitSurfaceMat(body.material)) {
        const mat = body.material;
        if (st.buildRemainingSec > 0) {
          const phase = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 12);
          const buildingHex = 0xffdd77;
          mat.emissive.setHex(buildingHex);
          mat.emissiveIntensity = 0.18 + phase * 0.55;
          mat.transparent = true;
          mat.opacity = 0.45 + phase * 0.35;
          mat.depthWrite = false;
        } else {
          const baseHex = body.userData["baseEmissiveHex"] as number | undefined;
          const baseIntensity = body.userData["baseEmissiveIntensity"] as number | undefined;
          if (typeof baseHex === "number") mat.emissive.setHex(baseHex);
          if (typeof baseIntensity === "number") {
            mat.emissiveIntensity = baseIntensity + (isSelectedStructure ? 0.18 + polishPhase * 0.08 : polishPhase * 0.035);
          }
          mat.transparent = false;
          mat.opacity = 1;
          mat.depthWrite = true;
        }
      }
      const glow = grp.getObjectByName("selectionGlowShell") as THREE.Mesh | undefined;
      if (glow && isGlowMat(glow.material)) {
        glow.visible = isSelectedStructure && st.buildRemainingSec <= 0;
        glow.scale.set(1.045 + polishPhase * 0.018, 1.04 + polishPhase * 0.018, 1.045 + polishPhase * 0.018);
        glow.material.opacity = isSelectedStructure ? 0.13 + polishPhase * 0.08 : 0;
      }
      const accent = grp.getObjectByName("structurePolishAccent") as THREE.Mesh | undefined;
      if (accent && isGlowMat(accent.material)) {
        accent.visible = st.buildRemainingSec <= 0;
        accent.material.opacity = 0.28 + polishPhase * 0.34;
        accent.rotation.z += 0.012;
      }
    }

    this.syncPendingBuildGhosts(state);

    const fieldAlive = new Set(state.resourceFields.map((f) => f.id));
    for (const [id, grp] of this.meshByResourceFieldId) {
      if (!fieldAlive.has(id)) {
        this.moonSpinRoot.remove(grp);
        this.disposeObjectDeep(grp);
        this.meshByResourceFieldId.delete(id);
      }
    }
    for (const f of state.resourceFields) {
      let grp = this.meshByResourceFieldId.get(f.id);
      if (!grp || this.resourceFieldGroupNeedsRebuild(grp, f)) {
        if (grp) {
          this.moonSpinRoot.remove(grp);
          this.disposeObjectDeep(grp);
        }
        grp = this.createResourceFieldGroup(f);
        this.meshByResourceFieldId.set(f.id, grp);
        this.moonSpinRoot.add(grp);
      }
      const c = resourceFieldCenterWorld(f);
      this.placeSimObject(grp, c.x, 0, c.z);
    }

    this.applyFogOfWarPresentation(state);

    for (const f of state.resourceFields) {
      const grp = this.meshByResourceFieldId.get(f.id);
      if (grp) this.applyResourceFieldFlashMaterial(f.id, grp);
    }
    this.updateStructurePlacementPreview(state);
    this.syncRallyMarkers(state);
  }

  private fogSuspended(): boolean {
    return this.options.getFogOfWarSuspended?.() === true;
  }

  /** Sim XZ + height → world pose on the moon surface. */
  private placeSimObject(obj: THREE.Object3D, sx: number, sy: number, sz: number): void {
    const w = this.wrapSimXZNearCamera(sx, sz);
    surfacePointFromWorldXZ("sphere", w.x, sy, w.z, this.tmpSpherePos);
    surfaceNormalFromWorldXZ("sphere", w.x, w.z, this.tmpSphereN);
    obj.position.copy(this.tmpSpherePos);
    obj.quaternion.setFromUnitVectors(this.unitUp, this.tmpSphereN);
  }

  private adminRingOnSphere(mesh: THREE.Mesh, sx: number, sy: number, sz: number): void {
    const w = this.wrapSimXZNearCamera(sx, sz);
    surfacePointFromWorldXZ("sphere", w.x, sy, w.z, this.tmpSpherePos);
    surfaceNormalFromWorldXZ("sphere", w.x, w.z, this.tmpSphereN);
    mesh.position.copy(this.tmpSpherePos);
    this.tmpQuatSurf.setFromUnitVectors(this.unitUp, this.tmpSphereN);
    this.tmpQuatRing.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    mesh.quaternion.copy(this.tmpQuatSurf).multiply(this.tmpQuatRing);
  }

  private snapshotEnemy(unit: SimUnit): EnemySeenSnapshot {
    return {
      x: unit.position.x,
      y: unit.position.y,
      z: unit.position.z,
      kind: unit.kind,
      team: unit.team,
      playerId: unit.playerId,
      attackClass: unit.attackClass
    };
  }

  private removeGhostUnit(unitId: string): void {
    const g = this.ghostMeshByUnitId.get(unitId);
    if (!g) return;
    this.moonSpinRoot.remove(g);
    this.disposeObjectDeep(g);
    this.ghostMeshByUnitId.delete(unitId);
  }

  private createGhostUnitGroup(unitId: string, snap: EnemySeenSnapshot): THREE.Group {
    const group = new THREE.Group();
    group.name = `unit-ghost-${unitId}`;
    group.userData["ghostOfUnitId"] = unitId;
    group.frustumCulled = false;

    const geometry =
      snap.kind === "R"
        ? new THREE.BoxGeometry(1.2, 1.2, 1.2)
        : snap.kind === "P"
          ? new THREE.CylinderGeometry(0.55, 0.55, 1.2, 6)
          : snap.kind === "N"
            ? new THREE.DodecahedronGeometry(0.62, 0)
            : new THREE.ConeGeometry(0.65, 1.2, 8);

    const ghostTint = 0x6a7588;
    const material = new THREE.MeshLambertMaterial({
      color: ghostTint,
      emissive: ghostTint,
      emissiveIntensity: 0.08,
      transparent: true,
      opacity: 0.52
    });
    const body = new THREE.Mesh(geometry, material);
    body.name = "unitGhostBody";
    body.castShadow = false;
    group.add(body);

    if (snap.attackClass === "ranged") {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.055, 8, 28),
        new THREE.MeshLambertMaterial({
          color: 0x557788,
          emissive: 0x334455,
          emissiveIntensity: 0.28,
          transparent: true,
          opacity: 0.45
        })
      );
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.52;
      group.add(band);
    }

    group.traverse((o) => {
      o.frustumCulled = false;
      if (o instanceof THREE.Mesh) {
        o.raycast = () => {};
      }
    });
    return group;
  }

  private syncGhostUnit(unitId: string, snap: EnemySeenSnapshot): void {
    let g = this.ghostMeshByUnitId.get(unitId);
    if (!g) {
      g = this.createGhostUnitGroup(unitId, snap);
      this.ghostMeshByUnitId.set(unitId, g);
      this.moonSpinRoot.add(g);
    }
    this.placeSimObject(g, snap.x, snap.y, snap.z);
    g.renderOrder = 4;
    g.visible = true;
  }

  private applyFogOfWarPresentation(state: GameState): void {
    const pid = this.options.localPlayerId;

    if (this.fogSuspended()) {
      this.fogSphereMesh.visible = false;
      this.lastSeenEnemy.clear();
      for (const id of [...this.ghostMeshByUnitId.keys()]) this.removeGhostUnit(id);
      for (const [, group] of this.meshByUnitId) {
        group.visible = true;
        group.renderOrder = 0;
      }
      for (const [, grp] of this.meshByStructureId) {
        grp.visible = true;
        grp.renderOrder = 0;
        this.resetStructureFogMaterial(grp);
      }
      for (const [, grp] of this.meshByResourceFieldId) {
        grp.visible = true;
        grp.renderOrder = 0;
        this.resetResourceFieldFogMaterial(grp);
      }
      return;
    }

    // Temporary diagnostic mode requested by user: keep sky perfectly visible by disabling
    // the global fog shell overlay entirely (units/structures still use fog visibility rules).
    this.fogSphereMesh.visible = false;

    if (state.matchId !== this.fogMatchId) {
      this.fogGrid.reset();
      this.lastSeenEnemy.clear();
      for (const id of [...this.ghostMeshByUnitId.keys()]) this.removeGhostUnit(id);
      this.fogMatchId = state.matchId;
      this.fogComputedForTick = -1;
      this.fogComputedForPlayerId = null;
    }

    const fogNeedsRecompute =
      this.fogComputedForTick !== state.tick || this.fogComputedForPlayerId !== pid;
    if (fogNeedsRecompute) {
      this.fogGrid.recompute(state, pid);
      this.fogGrid.writeToRgba(this.fogRgba);
      this.fogTexture.needsUpdate = true;
      this.fogComputedForTick = state.tick;
      this.fogComputedForPlayerId = pid;
    }

    const alive = new Set(state.units.map((u) => u.id));
    for (const id of [...this.lastSeenEnemy.keys()]) {
      if (!alive.has(id)) {
        this.lastSeenEnemy.delete(id);
        this.removeGhostUnit(id);
      }
    }

    for (const unit of state.units) {
      const group = this.meshByUnitId.get(unit.id);
      if (!group) continue;
      const enemy = unit.playerId !== pid;
      if (!enemy) {
        group.visible = true;
        group.renderOrder = 3;
        this.removeGhostUnit(unit.id);
        continue;
      }

      const inLos = this.fogGrid.isClearAtWorld(unit.position.x, unit.position.z);
      if (inLos) {
        this.lastSeenEnemy.set(unit.id, this.snapshotEnemy(unit));
        group.visible = true;
        this.placeSimObject(group, unit.position.x, unit.position.y, unit.position.z);
        group.renderOrder = 3;
        this.removeGhostUnit(unit.id);
        continue;
      }

      group.visible = false;
      this.placeSimObject(group, unit.position.x, unit.position.y, unit.position.z);

      const snap = this.lastSeenEnemy.get(unit.id);
      const ghostOk =
        snap &&
        this.fogGrid.isExploredAtWorld(snap.x, snap.z) &&
        !this.fogGrid.isClearAtWorld(snap.x, snap.z);
      if (ghostOk) {
        this.syncGhostUnit(unit.id, snap);
      } else {
        this.removeGhostUnit(unit.id);
      }
    }

    for (const st of state.structures) {
      const grp = this.meshByStructureId.get(st.id);
      if (!grp) continue;
      const c = structureCenter(st);
      if (st.playerId === pid) {
        grp.visible = true;
        grp.renderOrder = 3;
        if (st.buildRemainingSec <= 0) this.resetStructureFogMaterial(grp);
        continue;
      }
      if (st.kind === "home" && st.hp > 0) {
        grp.visible = true;
        grp.renderOrder = 3;
        continue;
      }
      const explored = this.fogGrid.isExploredAtWorld(c.x, c.z);
      if (!explored) {
        grp.visible = false;
        continue;
      }
      grp.visible = true;
      grp.renderOrder = 3;
      if (st.buildRemainingSec > 0) continue;
      const clear = this.fogGrid.isClearAtWorld(c.x, c.z);
      this.applyStructureFogDim(grp, !clear);
    }

    for (const f of state.resourceFields) {
      const grp = this.meshByResourceFieldId.get(f.id);
      if (!grp) continue;
      const c = resourceFieldCenterWorld(f);
      const explored = this.fogGrid.isExploredAtWorld(c.x, c.z);
      if (!explored) {
        grp.visible = false;
        continue;
      }
      grp.visible = true;
      grp.renderOrder = 3;
      const clear = this.fogGrid.isClearAtWorld(c.x, c.z);
      this.applyResourceFieldFogDim(grp, !clear);
    }
  }

  private resetStructureFogMaterial(grp: THREE.Group): void {
    const body = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
    if (!body || !isSceneLitSurfaceMat(body.material)) return;
    const mat = body.material;
    if (body.userData["baseColorHex"] === undefined) {
      body.userData["baseColorHex"] = mat.color.getHex();
    }
    mat.color.setHex(body.userData["baseColorHex"] as number);
    const baseEm = body.userData["baseEmissiveHex"] as number | undefined;
    const baseIntensity = body.userData["baseEmissiveIntensity"] as number | undefined;
    if (typeof baseEm === "number") mat.emissive.setHex(baseEm);
    if (typeof baseIntensity === "number") mat.emissiveIntensity = baseIntensity;
    mat.transparent = false;
    mat.opacity = 1;
  }

  private applyStructureFogDim(grp: THREE.Group, dim: boolean): void {
    const body = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
    if (!body || !isSceneLitSurfaceMat(body.material)) return;
    const mat = body.material;
    if (body.userData["baseColorHex"] === undefined) {
      body.userData["baseColorHex"] = mat.color.getHex();
    }
    if (dim) {
      mat.color.setHex(0x4a5568);
      mat.emissive.setHex(0x1a2030);
      mat.emissiveIntensity = 0.08;
      mat.transparent = true;
      mat.opacity = 0.62;
    } else {
      this.resetStructureFogMaterial(grp);
    }
  }

  private resetResourceFieldFogMaterial(grp: THREE.Group): void {
    const mesh = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
    if (!mesh || !isSceneLitSurfaceMat(mesh.material)) return;
    const baseHex = mesh.userData["baseFieldColorHex"] as number | undefined;
    const baseInt = mesh.userData["baseFieldEmissiveIntensity"] as number | undefined;
    if (typeof baseHex === "number") mesh.material.color.setHex(baseHex);
    if (typeof baseInt === "number") mesh.material.emissiveIntensity = baseInt;
    mesh.material.transparent = false;
    mesh.material.opacity = 1;
  }

  private applyResourceFieldFogDim(grp: THREE.Group, dim: boolean): void {
    const mesh = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
    if (!mesh || !isSceneLitSurfaceMat(mesh.material)) return;
    if (dim) {
      mesh.material.color.setHex(0x4a5a72);
      mesh.material.emissive.setHex(0x1a2538);
      mesh.material.emissiveIntensity = 0.12;
      mesh.material.transparent = true;
      mesh.material.opacity = 0.55;
    } else {
      this.resetResourceFieldFogMaterial(grp);
    }
  }

  private createRallyMarkerGroup(team: TeamId): THREE.Group {
    const root = new THREE.Group();
    root.name = "rallyMarker";
    root.frustumCulled = false;

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.075, 1.55, 10),
      new THREE.MeshStandardMaterial({
        color: 0x4a4038,
        metalness: 0.15,
        roughness: 0.82
      })
    );
    pole.position.y = 0.55 + 0.775;
    pole.castShadow = true;
    root.add(pole);

    const flagColor = team === "blue" ? 0x5aa8ff : 0xff9a5c;
    const flag = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.3, 0.035),
      new THREE.MeshStandardMaterial({
        color: flagColor,
        emissive: flagColor,
        emissiveIntensity: 0.42,
        metalness: 0.12,
        roughness: 0.45
      })
    );
    flag.position.set(0.26, 0.55 + 1.38, 0.02);
    flag.rotation.y = 0.35;
    flag.castShadow = true;
    root.add(flag);

    const finial = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0xc8b878,
        metalness: 0.35,
        roughness: 0.45,
        emissive: 0x302010,
        emissiveIntensity: 0.15
      })
    );
    finial.position.y = 0.55 + 1.55 + 0.06;
    root.add(finial);

    root.traverse((o) => {
      o.frustumCulled = false;
    });
    return root;
  }

  private syncRallyMarkers(state: GameState): void {
    const sel = state.structureSelections[this.options.localPlayerId] ?? [];
    const want = new Set<string>();

    for (const sid of sel) {
      const st = state.structures.find((s) => s.id === sid);
      if (!st?.rallyPoint || !structureProducesKind(st)) continue;
      want.add(sid);

      let grp = this.rallyMarkerByStructureId.get(sid);
      if (!grp) {
        grp = this.createRallyMarkerGroup(st.team);
        grp.userData["rallyStructureId"] = sid;
        this.rallyMarkerByStructureId.set(sid, grp);
        this.moonSpinRoot.add(grp);
      }
      grp.visible = true;
      this.placeSimObject(grp, st.rallyPoint.x, st.rallyPoint.y, st.rallyPoint.z);
    }

    for (const [id, grp] of [...this.rallyMarkerByStructureId.entries()]) {
      if (!want.has(id)) {
        this.moonSpinRoot.remove(grp);
        this.disposeObjectDeep(grp);
        this.rallyMarkerByStructureId.delete(id);
      }
    }
  }

  private applyResourceFieldFlashMaterial(fieldId: string, grp: THREE.Group): void {
    const mesh = grp.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;
    if (!mesh || !isSceneLitSurfaceMat(mesh.material)) return;
    const mat = mesh.material;
    const baseHex = mesh.userData["baseFieldColorHex"] as number | undefined;
    const baseInt = mesh.userData["baseFieldEmissiveIntensity"] as number | undefined;
    const flash = this.resourceFieldFlashStrength(fieldId);
    if (flash <= 0) {
      if (typeof baseHex === "number") {
        mat.color.setHex(baseHex);
        mat.emissive.setHex(baseHex);
      }
      if (typeof baseInt === "number") mat.emissiveIntensity = baseInt;
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 22);
    mat.emissive.setHex(0xffffff);
    mat.emissiveIntensity = (baseInt ?? 0.35) + pulse * 1.1 * flash;
    if (typeof baseHex === "number") {
      mat.color.setHex(baseHex);
    }
  }

  private updateStructurePlacementPreview(state: GameState): void {
    const kind = this.options.getPendingPlaceStructureKind?.() ?? null;
    if (!kind) {
      if (this.placementPreviewMesh) this.placementPreviewMesh.visible = false;
      return;
    }
    if (!this.placementPreviewMesh) {
      const geom = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshLambertMaterial({
        transparent: true,
        opacity: 0.5,
        depthWrite: false
      });
      this.placementPreviewMesh = new THREE.Mesh(geom, mat);
      this.placementPreviewMesh.name = "placementPreview";
      this.moonSpinRoot.add(this.placementPreviewMesh);
    }
    const mesh = this.placementPreviewMesh;
    mesh.visible = true;
    const pt = this.pointerEventToGroundAt(this.lastPointerClientX, this.lastPointerClientY);
    if (!pt) {
      mesh.visible = false;
      return;
    }
    const { gx, gz } = worldToCell(pt.x, pt.z);
    const { footW, footD } = footprintForStructureKind(kind as StructureKind);
    const valid = canPlanStructureForPlayer(
      state,
      this.options.localPlayerId,
      gx,
      gz,
      footW,
      footD
    );
    const c = footprintCenterWorld(gx, gz, footW, footD);
    const w = footW * GRID_CELL_SIZE;
    const d = footD * GRID_CELL_SIZE;
    const h = kind === "power_spire" ? 0.52 : kind === "defense_obelisk" ? 2.8 : 1.6;
    mesh.scale.set(w, h, d);
    const wc = this.wrapSimXZNearCamera(c.x, c.z);
    surfaceNormalFromWorldXZ("sphere", wc.x, wc.z, this.tmpSphereN);
    surfacePointFromWorldXZ("sphere", wc.x, h * 0.5, wc.z, mesh.position);
    mesh.quaternion.setFromUnitVectors(this.unitUp, this.tmpSphereN);
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.color.setHex(valid ? 0x52c288 : 0xd05058);
    mat.emissive.setHex(valid ? 0x1a4028 : 0x401018);
    mat.emissiveIntensity = 0.22;
  }

  private resourceFieldGroupNeedsRebuild(group: THREE.Group, f: SimResourceField): boolean {
    return group.userData["fieldKind"] !== f.kind;
  }

  private createResourceFieldGroup(f: SimResourceField): THREE.Group {
    const group = new THREE.Group();
    group.name = `resource-field-${f.id}`;
    group.userData["resourceFieldId"] = f.id;
    group.userData["fieldKind"] = f.kind;
    group.frustumCulled = false;
    const geom = new THREE.OctahedronGeometry(0.85, 0);
    const color = f.kind === "energy" ? 0x44ddff : 0xe8b060;
    const mat = new THREE.MeshLambertMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.42
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = 0.55;
    mesh.userData["resourceFieldId"] = f.id;
    mesh.userData["baseFieldColorHex"] = color;
    mesh.userData["baseFieldEmissiveIntensity"] = 0.35;
    group.add(mesh);
    group.traverse((o) => {
      o.frustumCulled = false;
    });
    return group;
  }

  /** Control groups for the HUD bar (local player). Empty groups render as dim slots. */
  getControlGroupsHudSlots(): { digit: number; count: number; active: boolean }[] {
    const keyboardOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
    const currentUnits = this.lastSyncedState?.selections[this.options.localPlayerId] ?? [];
    const currentStructures = this.lastSyncedState?.structureSelections[this.options.localPlayerId] ?? [];
    return keyboardOrder.map((digit) => {
      const g = this.controlGroups[digit]!;
      const aliveUnits = this.filterAliveOwnedIds(g.unitIds);
      const aliveStructs = this.filterAliveOwnedStructureIds(g.structureIds);
      return {
        digit,
        count: aliveUnits.length + aliveStructs.length,
        active:
          aliveUnits.length + aliveStructs.length > 0 &&
          idsMatch(currentUnits, aliveUnits) &&
          idsMatch(currentStructures, aliveStructs)
      };
    });
  }

  recallControlGroup(digit: number): void {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) return;
    const stored = this.controlGroups[digit];
    if (!stored) return;
    const aliveUnits = this.filterAliveOwnedIds(stored.unitIds);
    const aliveStructs = this.filterAliveOwnedStructureIds(stored.structureIds);
    if (aliveUnits.length + aliveStructs.length === 0) return;
    const now = performance.now();
    const doubleTap = now - this.lastControlGroupTapMs[digit]! < 430;
    this.lastControlGroupTapMs[digit] = now;
    this.options.submitCommand(
      createGameCommand(this.options.localPlayerId, "select_units_and_structures", {
        unitIds: aliveUnits,
        structureIds: aliveStructs
      })
    );
    if (doubleTap) this.focusControlGroup(aliveUnits, aliveStructs);
  }

  /**
   * Ranged hit feedback: glowing sphere travels muzzle → target (hitscan combat, cosmetic flight).
   * Command Core battery uses {@link ProjectileTraceOpts} from the caller for a larger, longer bolt.
   */
  spawnProjectileTrace(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    opts?: ProjectileTraceOpts
  ): void {
    const radius = opts?.radius ?? 0.34;
    const maxAge = opts?.maxAge ?? 0.24;
    const color = opts?.color ?? 0x7ae8ff;
    const emissive = opts?.emissive ?? 0x44c8f0;
    const emissiveIntensity = opts?.emissiveIntensity ?? 1.12;
    const startLift = opts?.startLift ?? 0.52;
    const endLift = opts?.endLift ?? 0.48;

    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const wf = this.wrapSimXZNearCamera(from.x, from.z);
    const wt = this.wrapSimXZNearCamera(to.x, to.z);
    surfacePointFromWorldXZ("sphere", wf.x, from.y + startLift, wf.z, start);
    surfacePointFromWorldXZ("sphere", wt.x, to.y + endLift, wt.z, end);
    const geo = new THREE.SphereGeometry(radius, 12, 12);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity,
      transparent: true,
      opacity: 1,
      roughness: 0.22,
      metalness: 0.28
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    mesh.position.copy(start);
    this.moonSpinRoot.add(mesh);
    this.rangedProjectiles.push({
      mesh,
      age: 0,
      maxAge,
      start,
      end
    });
  }

  updateCamera(deltaSeconds: number): void {
    this.renderTimeSec += deltaSeconds;
    this.pruneExpiredResourceFieldFlashes();
    this.updateCameraInput(deltaSeconds);
    this.updateProjectileTraces(deltaSeconds);
  }

  /** Pluggable feedback: pulse a mineral/energy node (used by `dispatchUiFeedback`). */
  flashResourceField(fieldId: string, durationSec = 0.45): void {
    const now = performance.now();
    const untilMs = now + durationSec * 1000;
    const prev = this.resourceFieldFlash.get(fieldId);
    const startMs = prev && prev.untilMs > now ? prev.startMs : now;
    this.resourceFieldFlash.set(fieldId, { untilMs: Math.max(prev?.untilMs ?? 0, untilMs), startMs });
  }

  private pruneExpiredResourceFieldFlashes(): void {
    const now = performance.now();
    for (const [id, { untilMs }] of this.resourceFieldFlash) {
      if (untilMs <= now) this.resourceFieldFlash.delete(id);
    }
  }

  private resourceFieldFlashStrength(fieldId: string): number {
    const entry = this.resourceFieldFlash.get(fieldId);
    if (!entry) return 0;
    const now = performance.now();
    if (now >= entry.untilMs) return 0;
    const span = Math.max(1, entry.untilMs - entry.startMs);
    return Math.min(1, (entry.untilMs - now) / span);
  }

  private updateProjectileTraces(deltaSeconds: number): void {
    for (let i = this.rangedProjectiles.length - 1; i >= 0; i -= 1) {
      const p = this.rangedProjectiles[i];
      p.age += deltaSeconds;
      const u = Math.min(1, p.age / p.maxAge);
      p.mesh.position.lerpVectors(p.start, p.end, u);
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, 1 - u * 0.85);
      mat.transparent = true;
      if (p.age >= p.maxAge) {
        this.moonSpinRoot.remove(p.mesh);
        p.mesh.geometry.dispose();
        mat.dispose();
        this.rangedProjectiles.splice(i, 1);
      }
    }
  }

  /** Ranged lines (Paper, Neutral) get a ring marker; combat is still hitscan with projectile VFX on hits. */
  private createUnitGroup(unit: SimUnit): THREE.Group {
    const group = new THREE.Group();
    group.name = `unit-${unit.id}`;
    group.userData["unitId"] = unit.id;
    group.userData["kindKey"] = unit.kind;
    group.userData["attackClassKey"] = unit.attackClass;
    group.frustumCulled = false;

    const geometry =
      unit.kind === "R"
        ? new THREE.BoxGeometry(1.2, 1.2, 1.2, 2, 2, 2)
        : unit.kind === "P"
          ? new THREE.CylinderGeometry(0.55, 0.55, 1.2, 10)
          : unit.kind === "N"
            ? new THREE.DodecahedronGeometry(0.62, 0)
            : new THREE.ConeGeometry(0.65, 1.2, 12);

    const material = new THREE.MeshStandardMaterial({
      color: unitColor(unit.team, unit.kind),
      emissive: unitColor(unit.team, unit.kind),
      emissiveIntensity: 0.18,
      roughness: 0.36,
      metalness: 0.12,
      envMapIntensity: 0.4
    });

    const body = new THREE.Mesh(geometry, material);
    body.name = "unitBody";
    body.castShadow = true;
    body.userData["unitId"] = unit.id;
    group.add(body);

    const glowShell = new THREE.Mesh(
      geometry.clone(),
      new THREE.MeshBasicMaterial({
        color: unitColor(unit.team, unit.kind),
        transparent: true,
        opacity: 0,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false
      })
    );
    glowShell.name = "selectionGlowShell";
    glowShell.visible = false;
    glowShell.raycast = () => {};
    glowShell.renderOrder = 3;
    group.add(glowShell);

    const accent = new THREE.Mesh(
      new THREE.SphereGeometry(unit.kind === "N" ? 0.13 : 0.16, 10, 8),
      new THREE.MeshBasicMaterial({
        color: unit.team === "blue" ? 0xc8f4ff : 0xffd0a8,
        transparent: true,
        opacity: 0.58,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false
      })
    );
    accent.name = "unitPolishAccent";
    accent.position.y = unit.kind === "N" ? 0.42 : 0.68;
    accent.raycast = () => {};
    accent.renderOrder = 4;
    group.add(accent);

    if (unit.attackClass === "ranged") {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.055, 10, 32),
        new THREE.MeshStandardMaterial({
          color: 0x66eeff,
          emissive: 0x22aacc,
          emissiveIntensity: 0.52,
          roughness: 0.32,
          metalness: 0.28,
          transparent: true,
          opacity: 0.92,
          envMapIntensity: 0.9
        })
      );
      band.name = "projectileClassMarker";
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.52;
      band.userData["unitId"] = unit.id;
      group.add(band);
    }

    group.traverse((o) => {
      o.frustumCulled = false;
    });
    return group;
  }

  private unitGroupNeedsRebuild(group: THREE.Group, unit: SimUnit): boolean {
    return (
      group.userData["kindKey"] !== unit.kind || group.userData["attackClassKey"] !== unit.attackClass
    );
  }

  private createRangeRingMesh(color: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(0.5, 1, 64);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  private disposeRingMesh(mesh: THREE.Mesh): void {
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material)?.dispose();
  }

  private disposeObjectDeep(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else (m as THREE.Material | undefined)?.dispose();
      }
    });
  }

  private structureGroupNeedsRebuild(group: THREE.Group, st: SimStructure): boolean {
    return (
      group.userData["structureKind"] !== st.kind ||
      group.userData["footW"] !== st.footW ||
      group.userData["footD"] !== st.footD
    );
  }

  private syncPendingBuildGhosts(state: GameState): void {
    const alive = new Set<string>();
    for (const unit of state.units) {
      const pending = unit.pendingStructurePlacement;
      if (!pending || unit.playerId !== this.options.localPlayerId || unit.hp <= 0) continue;
      const { footW, footD } = footprintForStructureKind(pending.kind);
      const key = `${unit.id}:${pending.kind}:${pending.gx}:${pending.gz}`;
      alive.add(key);

      let ghost = this.pendingBuildGhostByKey.get(key);
      if (!ghost) {
        const fake: SimStructure = {
          id: key,
          playerId: unit.playerId,
          team: unit.team,
          kind: pending.kind,
          hp: 1,
          maxHp: 1,
          gx: pending.gx,
          gz: pending.gz,
          footW,
          footD,
          buildRemainingSec: 1,
          buildTotalSec: 1,
          productionQueue: [],
          rallyPoint: null,
          rallyMineFieldId: null,
          homeDefenseCooldownRemainingSec: 0
        };
        ghost = this.createStructureGroup(fake);
        ghost.name = `pending-build-${key}`;
        ghost.userData["pendingBuildGhost"] = true;
        ghost.traverse((obj) => {
          if (obj instanceof THREE.Mesh && isSceneLitSurfaceMat(obj.material)) {
            obj.material.transparent = true;
            obj.material.depthWrite = false;
          }
        });
        this.pendingBuildGhostByKey.set(key, ghost);
        this.moonSpinRoot.add(ghost);
      }

      const c = footprintCenterWorld(pending.gx, pending.gz, footW, footD);
      this.placeSimObject(ghost, c.x, 0, c.z);
      const phase = 0.5 + 0.5 * Math.sin(this.renderTimeSec * 12);
      ghost.visible = true;
      ghost.traverse((obj) => {
        if (obj instanceof THREE.Mesh && isSceneLitSurfaceMat(obj.material)) {
          obj.material.emissive.setHex(0xffdd77);
          obj.material.emissiveIntensity = 0.25 + phase * 0.65;
          obj.material.opacity = 0.24 + phase * 0.42;
        }
      });
    }

    for (const [key, ghost] of this.pendingBuildGhostByKey) {
      if (alive.has(key)) continue;
      this.moonSpinRoot.remove(ghost);
      this.disposeObjectDeep(ghost);
      this.pendingBuildGhostByKey.delete(key);
    }
  }

  private createStructureGroup(st: SimStructure): THREE.Group {
    const group = new THREE.Group();
    group.name = `structure-${st.id}`;
    group.userData["structureId"] = st.id;
    group.userData["structureKind"] = st.kind;
    group.userData["footW"] = st.footW;
    group.userData["footD"] = st.footD;
    group.frustumCulled = false;

    const w = st.footW * GRID_CELL_SIZE;
    const d = st.footD * GRID_CELL_SIZE;
    const h = st.kind === "home" ? 2.4 : st.kind === "power_spire" ? 0.52 : st.kind === "defense_obelisk" ? 2.8 : 1.6;
    let color: number;
    switch (st.kind) {
      case "home":
        color = st.team === "blue" ? 0x3a5e9e : 0x9e5a3a;
        break;
      case "barracks_r":
        color = st.team === "blue" ? 0x4a7aee : 0xee7a4a;
        break;
      case "barracks_s":
        color = st.team === "blue" ? 0x4aeeaa : 0xeea44a;
        break;
      case "barracks_p":
        color = st.team === "blue" ? 0x5ad8ff : 0xff6ab8;
        break;
      case "power_spire":
        color = st.team === "blue" ? 0x7ab0ff : 0xffc266;
        break;
      case "defense_obelisk":
        color = st.team === "blue" ? 0x9b7cff : 0xff6f9f;
        break;
      case "barracks_n":
        color = st.team === "blue" ? 0x9aa8b8 : 0xb898a8;
        break;
      case "mineral_depot":
        color = st.team === "blue" ? 0xc4a882 : 0xc49472;
        break;
      default:
        color = 0x8899aa;
    }

    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: st.kind === "defense_obelisk" ? 0.24 : 0.12,
      roughness: st.kind === "defense_obelisk" ? 0.42 : 0.58,
      metalness: st.kind === "defense_obelisk" ? 0.18 : 0.08,
      envMapIntensity: 0.35
    });
    const geom =
      st.kind === "defense_obelisk"
        ? new THREE.ConeGeometry(Math.min(w, d) * 0.34, h, 4)
        : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = h * 0.5;
    if (st.kind === "defense_obelisk") mesh.rotation.y = Math.PI / 4;
    mesh.userData["structureId"] = st.id;
    mesh.userData["baseEmissiveHex"] = color;
    mesh.userData["baseEmissiveIntensity"] = 0.1;
    group.add(mesh);

    const glowShell = new THREE.Mesh(
      geom.clone(),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false
      })
    );
    glowShell.name = "selectionGlowShell";
    glowShell.position.copy(mesh.position);
    glowShell.rotation.copy(mesh.rotation);
    glowShell.visible = false;
    glowShell.raycast = () => {};
    glowShell.renderOrder = 2;
    group.add(glowShell);

    const accentRing = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.38, Math.min(w, d) * 0.34), Math.max(0.018, Math.min(w, d) * 0.018), 8, 36),
      new THREE.MeshBasicMaterial({
        color: st.team === "blue" ? 0xbbefff : 0xffd6a6,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false
      })
    );
    accentRing.name = "structurePolishAccent";
    accentRing.rotation.x = Math.PI / 2;
    accentRing.position.y = st.kind === "power_spire" ? h + 0.08 : h * 0.64;
    accentRing.raycast = () => {};
    accentRing.renderOrder = 3;
    group.add(accentRing);
    if (st.kind === "defense_obelisk") {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(Math.min(w, d) * 0.18, 16, 12),
        new THREE.MeshBasicMaterial({
          color: st.team === "blue" ? 0xc8b8ff : 0xffbad0,
          transparent: true,
          opacity: 0.92
        })
      );
      core.name = "obeliskCore";
      core.position.y = h * 0.78;
      core.userData["structureId"] = st.id;
      group.add(core);
    }
    group.traverse((o) => {
      o.frustumCulled = false;
    });
    return group;
  }

  private attachInput(): void {
    const canvas = this.renderer.domElement;
    const { localPlayerId, submitCommand } = this.options;

    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

    canvas.addEventListener("pointerdown", (ev) => {
      if (ev.button === 0) {
        if (ev.pointerType === "touch") {
          ev.preventDefault();
          this.activeTouchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
          if (this.activeTouchPointers.size >= 2) {
            this.touchPinchPrevDistance = this.currentTouchPinchDistance();
            this.lmbTrack = null;
            window.removeEventListener("pointermove", this.onLmbWindowMove);
            window.removeEventListener("pointerup", this.onLmbWindowUp);
            window.removeEventListener("pointercancel", this.onLmbWindowUp);
            return;
          }
        }
        this.lmbTrack = {
          startX: ev.clientX,
          startY: ev.clientY,
          lastX: ev.clientX,
          lastY: ev.clientY,
          pointerType: ev.pointerType,
          cameraDrag: false,
          marquee: false
        };
        window.addEventListener("pointermove", this.onLmbWindowMove);
        window.addEventListener("pointerup", this.onLmbWindowUp);
        window.addEventListener("pointercancel", this.onLmbWindowUp);
        return;
      }

      if (ev.button === 2) {
        this.rmbUsedCameraDrag = false;
        this.rmbPanHasPrevSample = false;
        this.rmbSpinArcPrevValid = false;
        this.rmbPointerLockMoveDistance = 0;
        this.rmbSurfaceSpin = this.canonicalMoonDirFromScreen(ev.clientX, ev.clientY, this.tmpCanonMoonDir);
        this.rmbPointerId = ev.pointerId;
        this.rmbTrack = {
          startX: ev.clientX,
          startY: ev.clientY,
          lastX: ev.clientX,
          lastY: ev.clientY
        };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore: very old engines */
        }
        canvas.addEventListener("pointermove", this.onRmbCanvasMove);
        canvas.addEventListener("pointerup", this.onRmbCanvasUp);
        canvas.addEventListener("pointercancel", this.onRmbCanvasUp);
        if (this.rmbSurfaceSpin) {
          document.addEventListener("mousemove", this.onRmbPointerLockMove);
          document.addEventListener("mouseup", this.onRmbPointerLockMouseUp);
          this.rmbPointerLockTimer = window.setTimeout(() => {
            if (!this.rmbTrack || !this.rmbSurfaceSpin) return;
            try {
              canvas.requestPointerLock();
            } catch {
              /* pointer lock is optional; canvas pointer capture still works */
            }
          }, 520);
        }
      }
    });

    window.addEventListener("keydown", (ev) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      const g = this.parseGroupDigit(ev);
      if (g !== null) {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          if (!ev.repeat) {
            const sel = this.lastSyncedState?.selections[localPlayerId] ?? [];
            const structSel = this.lastSyncedState?.structureSelections[localPlayerId] ?? [];
            this.controlGroups[g] = { unitIds: [...sel], structureIds: [...structSel] };
          }
          return;
        }
        if (!ev.altKey && !ev.repeat) {
          ev.preventDefault();
          this.recallControlGroup(g);
          return;
        }
      }

      if (ev.code === "KeyH" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        if (!ev.repeat) {
          const now = performance.now();
          const isDoubleTap = now - this.lastHomeKeyDownMs < 420;
          this.lastHomeKeyDownMs = now;
          const home = this.commandCoreForHomeKey(isDoubleTap);
          if (home) {
            if (isDoubleTap) {
              const c = structureCenter(home);
              this.resetMoonSpin();
              this.focusHomeOverviewOnWorldXZ(c.x, c.z);
            }
            submitCommand(
              createGameCommand(localPlayerId, "select_structures", { structureIds: [home.id] })
            );
          }
        }
        return;
      }
      if (ev.code === "KeyX" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) {
        ev.preventDefault();
        submitCommand(createGameCommand(localPlayerId, "stop_units", {}));
        return;
      }

      const k = ev.key.toLowerCase();
      this.keys[k] = true;
      if (k === "c" && !ev.repeat) {
        const stid = this.lastSyncedState?.structureSelections[localPlayerId]?.[0];
        if (stid) {
          const st = this.lastSyncedState?.structures.find((s) => s.id === stid);
          if (st && structureProducesKind(st)) {
            ev.preventDefault();
            submitCommand(
              createGameCommand(localPlayerId, "queue_structure_train", { structureId: stid })
            );
          }
        }
      }
      if (k === "v" && !ev.repeat) {
        ev.preventDefault();
        const cur = tuning.formation.active;
        const i = FORMATION_CYCLE.indexOf(cur);
        tuning.formation.active = FORMATION_CYCLE[(i + 1 + FORMATION_CYCLE.length) % FORMATION_CYCLE.length];
      }
    });
    window.addEventListener("keyup", (ev) => {
      this.keys[ev.key.toLowerCase()] = false;
    });
    canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this.cameraDistance += ev.deltaY * tuning.camera.wheelZoomFactor;
        this.cameraDistance = THREE.MathUtils.clamp(
          this.cameraDistance,
          tuning.camera.zoomMin,
          tuning.camera.zoomMax
        );
      },
      { passive: false }
    );
  }

  /** 0–9 from main row or numpad; null if not a group key. */
  private parseGroupDigit(ev: KeyboardEvent): number | null {
    if (ev.code.startsWith("Digit")) {
      const d = Number(ev.code.slice(5));
      if (d >= 0 && d <= 9) return d;
    }
    if (ev.code.startsWith("Numpad")) {
      const rest = ev.code.slice(6);
      if (rest === "0") return 0;
      const d = Number(rest);
      if (d >= 1 && d <= 9) return d;
    }
    return null;
  }

  private filterAliveOwnedIds(ids: string[]): string[] {
    const state = this.lastSyncedState;
    if (!state) return [];
    const pid = this.options.localPlayerId;
    const valid = new Set(
      state.units.filter((u) => u.playerId === pid).map((u) => u.id)
    );
    return ids.filter((id) => valid.has(id));
  }

  private filterAliveOwnedStructureIds(ids: string[]): string[] {
    const state = this.lastSyncedState;
    if (!state) return [];
    const pid = this.options.localPlayerId;
    const valid = new Set(
      state.structures.filter((s) => s.playerId === pid && s.hp > 0).map((s) => s.id)
    );
    return ids.filter((id) => valid.has(id));
  }

  private focusControlGroup(unitIds: string[], structureIds: string[]): void {
    const state = this.lastSyncedState;
    if (!state) return;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const id of unitIds) {
      const u = state.units.find((x) => x.id === id && x.hp > 0);
      if (!u) continue;
      sx += u.position.x;
      sz += u.position.z;
      n += 1;
    }
    for (const id of structureIds) {
      const s = state.structures.find((x) => x.id === id && x.hp > 0);
      if (!s) continue;
      const c = structureCenter(s);
      sx += c.x;
      sz += c.z;
      n += 1;
    }
    if (n === 0) return;
    this.focusCameraOnWorldXZ(sx / n, sz / n);
  }

  private commandCoreForHomeKey(preferFarthest: boolean): SimStructure | null {
    const state = this.lastSyncedState;
    if (!state) return null;
    const homes = state.structures.filter(
      (s) => s.playerId === this.options.localPlayerId && s.kind === "home" && s.hp > 0
    );
    if (homes.length === 0) return null;
    if (homes.length === 1) return homes[0]!;
    const anchor = this.sphereCameraAnchorXZ();
    let best = homes[0]!;
    let bestD = topologyDistanceXZ(state, anchor.x, anchor.z, structureCenter(best).x, structureCenter(best).z);
    for (let i = 1; i < homes.length; i += 1) {
      const home = homes[i]!;
      const c = structureCenter(home);
      const d = topologyDistanceXZ(state, anchor.x, anchor.z, c.x, c.z);
      if (preferFarthest ? d > bestD : d < bestD) {
        best = home;
        bestD = d;
      }
    }
    return best;
  }

  private handleLmbWindowMove(ev: PointerEvent): void {
    if (ev.pointerType === "touch") {
      ev.preventDefault();
      this.activeTouchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.activeTouchPointers.size >= 2) {
        const pinch = this.currentTouchPinchDistance();
        if (pinch !== null && this.touchPinchPrevDistance !== null && this.touchPinchPrevDistance > 1) {
          const ratio = pinch / this.touchPinchPrevDistance;
          this.cameraDistance = THREE.MathUtils.clamp(
            this.cameraDistance / ratio,
            tuning.camera.zoomMin,
            tuning.camera.zoomMax
          );
          this.updateCameraTransform();
        }
        this.touchPinchPrevDistance = pinch;
        if (this.lmbTrack) this.lmbTrack.cameraDrag = true;
        return;
      }
    }
    if (!this.lmbTrack || (ev.pointerType !== "touch" && !(ev.buttons & 1))) return;

    const dist = Math.hypot(ev.clientX - this.lmbTrack.startX, ev.clientY - this.lmbTrack.startY);
    if (this.lmbTrack.pointerType === "touch") {
      const dx = ev.clientX - this.lmbTrack.lastX;
      const dy = ev.clientY - this.lmbTrack.lastY;
      this.lmbTrack.lastX = ev.clientX;
      this.lmbTrack.lastY = ev.clientY;
      if (dist > RMB_DRAG_THRESHOLD_PX || this.lmbTrack.cameraDrag) {
        this.lmbTrack.cameraDrag = true;
        if (Math.hypot(dx, dy) > 0.25) {
          this.applyMoonSpinFromScreenDelta(dx, dy);
          this.updateCameraTransform();
        }
      }
      return;
    }
    if (dist > LMB_MARQUEE_THRESHOLD_PX || this.lmbTrack.marquee) {
      this.lmbTrack.marquee = true;
      this.updateMarqueeBox(this.lmbTrack.startX, this.lmbTrack.startY, ev.clientX, ev.clientY);
    }
  }

  private handleLmbWindowUp(ev: PointerEvent): void {
    if (ev.pointerType === "touch") {
      ev.preventDefault();
      this.activeTouchPointers.delete(ev.pointerId);
      if (this.activeTouchPointers.size < 2) this.touchPinchPrevDistance = null;
    }
    if (ev.button !== 0 && ev.type !== "pointercancel") return;
    if (!this.lmbTrack) {
      if (this.activeTouchPointers.size === 0) {
        window.removeEventListener("pointermove", this.onLmbWindowMove);
        window.removeEventListener("pointerup", this.onLmbWindowUp);
        window.removeEventListener("pointercancel", this.onLmbWindowUp);
      }
      return;
    }

    window.removeEventListener("pointermove", this.onLmbWindowMove);
    window.removeEventListener("pointerup", this.onLmbWindowUp);
    window.removeEventListener("pointercancel", this.onLmbWindowUp);

    const { localPlayerId, submitCommand } = this.options;
    const track = this.lmbTrack;
    this.lmbTrack = null;

    this.marqueeDiv.style.display = "none";

    if (track.cameraDrag || ev.type === "pointercancel") {
      this.lastLmbUnitPickForDouble = null;
      this.options.onInspect?.(null);
      return;
    }

    const mobileCommand = !track.marquee && (this.options.consumeMobileCommandMode?.() ?? false);
    if (mobileCommand) {
      const point = this.pointerEventToGroundAt(ev.clientX, ev.clientY);
      if (point) {
        this.issueRmbAtWorld(point.x, point.z, false, false);
      }
      this.options.onMobileCommandConsumed?.();
      this.options.onInspect?.(null);
      return;
    }

    if (track.marquee) {
      this.lastLmbUnitPickForDouble = null;
      const ids = this.unitsInMarqueeClient(track.startX, track.startY, ev.clientX, ev.clientY);
      submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: ids }));
      this.options.onInspect?.(null);
    } else {
      const pickedId = this.pickOwnedUnitIdAt(ev.clientX, ev.clientY);
      if (pickedId) {
        const st = this.lastSyncedState;
        const now = performance.now();
        const prev = this.lastLmbUnitPickForDouble;
        const isDouble =
          prev !== null &&
          prev.unitId === pickedId &&
          now - prev.timeMs <= LMB_DOUBLE_CLICK_MS &&
          Math.hypot(ev.clientX - prev.clientX, ev.clientY - prev.clientY) <=
            LMB_DOUBLE_CLICK_MAX_DIST_PX;
        this.lastLmbUnitPickForDouble = {
          unitId: pickedId,
          timeMs: now,
          clientX: ev.clientX,
          clientY: ev.clientY
        };
        if (isDouble && st) {
          const u = st.units.find((x) => x.id === pickedId);
          if (u && u.playerId === localPlayerId && u.hp > 0) {
            const kind = u.kind;
            const sameTypeIds = st.units
              .filter((x) => x.playerId === localPlayerId && x.hp > 0 && x.kind === kind)
              .map((x) => x.id);
            submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: sameTypeIds }));
          } else {
            submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: [pickedId] }));
          }
        } else {
          submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: [pickedId] }));
        }
      } else {
        this.lastLmbUnitPickForDouble = null;
        const sid = this.pickOwnedStructureIdAt(ev.clientX, ev.clientY);
        if (sid) {
          submitCommand(createGameCommand(localPlayerId, "select_structures", { structureIds: [sid] }));
        } else {
          const placeKind = this.options.getPendingPlaceStructureKind?.() ?? null;
          const point = this.pointerEventToGroundAt(ev.clientX, ev.clientY);
          if (placeKind && point) {
            const st = this.lastSyncedState;
            let builderUnitId: string | null = null;
            if (st) {
              for (const uid of st.selections[localPlayerId] ?? []) {
                const u = st.units.find((x) => x.id === uid);
                if (u && u.playerId === localPlayerId && u.kind === "N" && u.hp > 0) {
                  builderUnitId = uid;
                  break;
                }
              }
              if (!builderUnitId) {
                const anyN = st.units.find(
                  (u) => u.playerId === localPlayerId && u.kind === "N" && u.hp > 0
                );
                builderUnitId = anyN?.id ?? null;
              }
            }
            const { gx, gz } = worldToCell(point.x, point.z);
            const hasMiner = !!st?.units.some(
              (u) => u.playerId === localPlayerId && u.kind === "N" && u.hp > 0
            );
            if (hasMiner) {
              const payload: Record<string, unknown> = { kind: placeKind, gx, gz };
              if (builderUnitId) payload.builderUnitId = builderUnitId;
              submitCommand(createGameCommand(localPlayerId, "place_structure", payload));
            } else {
              submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: [] }));
            }
          } else {
            submitCommand(createGameCommand(localPlayerId, "select_units", { unitIds: [] }));
          }
        }
      }
      this.options.onInspect?.(this.pickInspectTargetAt(ev.clientX, ev.clientY));
    }
  }

  private pickInspectTargetAt(clientX: number, clientY: number): WorldInspectHit | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [
      ...this.meshByUnitId.values(),
      ...this.meshByStructureId.values(),
      ...this.meshByResourceFieldId.values()
    ];
    const hits = this.raycaster.intersectObjects(roots, true);
    const state = this.lastSyncedState;
    if (!state) return null;
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const uid = o.userData["unitId"] as string | undefined;
        if (uid) {
          const u = state.units.find((x) => x.id === uid);
          if (u && u.hp > 0) return { kind: "unit", id: uid };
        }
        const sid = o.userData["structureId"] as string | undefined;
        if (sid) {
          const st = state.structures.find((x) => x.id === sid);
          if (st && st.hp > 0) return { kind: "structure", id: sid };
        }
        const fid = o.userData["resourceFieldId"] as string | undefined;
        if (fid) {
          const f = state.resourceFields.find((x) => x.id === fid);
          if (f && (f.reserve === null || f.reserve > 0)) return { kind: "field", id: fid };
        }
        o = o.parent;
      }
    }
    return null;
  }

  private pickOwnedDepositoryIdAt(clientX: number, clientY: number): string | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [...this.meshByStructureId.values()];
    const hits = this.raycaster.intersectObjects(roots, true);
    const state = this.lastSyncedState;
    if (!state) return null;
    const pid = this.options.localPlayerId;

    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const sid = o.userData["structureId"] as string | undefined;
        if (sid) {
          const st = state.structures.find((x) => x.id === sid);
          if (
            st &&
            st.playerId === pid &&
            st.hp > 0 &&
            st.buildRemainingSec <= 0 &&
            (st.kind === "home" || st.kind === "mineral_depot")
          ) {
            return sid;
          }
        }
        o = o.parent;
      }
    }
    return null;
  }

  private pickOwnedStructureIdAt(clientX: number, clientY: number): string | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [...this.meshByStructureId.values()];
    const hits = this.raycaster.intersectObjects(roots, true);
    const state = this.lastSyncedState;
    if (!state) return null;
    const pid = this.options.localPlayerId;

    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const sid = o.userData["structureId"] as string | undefined;
        if (sid) {
          const st = state.structures.find((x) => x.id === sid);
          if (st && st.playerId === pid && st.hp > 0) return sid;
        }
        o = o.parent;
      }
    }
    return null;
  }

  private pickResourceFieldIdNearWorld(wx: number, wz: number): string | null {
    const state = this.lastSyncedState;
    if (!state) return null;
    let best: { id: string; d: number } | null = null;
    for (const f of state.resourceFields) {
      if (f.kind !== "minerals") continue;
      if (f.reserve !== null && f.reserve <= 0) continue;
      const c = resourceFieldCenterWorld(f);
      const d = sphereGeodesicDistanceWorldXZ(wx, wz, c.x, c.z);
      if (d <= GATHER_MINERAL_MAX_SURFACE_METERS && (best === null || d < best.d)) {
        best = { id: f.id, d };
      }
    }
    return best?.id ?? null;
  }

  private pickOwnedDepositoryNearWorld(wx: number, wz: number): string | null {
    const state = this.lastSyncedState;
    if (!state) return null;
    const pid = this.options.localPlayerId;
    let best: { id: string; d: number } | null = null;
    for (const st of state.structures) {
      if (st.playerId !== pid || st.hp <= 0 || st.buildRemainingSec > 0) continue;
      if (st.kind !== "home" && st.kind !== "mineral_depot") continue;
      const c = structureCenter(st);
      const d = topologyDistanceXZ(state, wx, wz, c.x, c.z);
      if (d <= WORLD_DEPOT_PICK && (best === null || d < best.d)) {
        best = { id: st.id, d };
      }
    }
    return best?.id ?? null;
  }

  private pickAttackTargetNearWorld(
    wx: number,
    wz: number
  ): { kind: "unit"; id: string } | { kind: "structure"; id: string } | null {
    const state = this.lastSyncedState;
    if (!state) return null;
    let best: { kind: "unit" | "structure"; id: string; d: number } | null = null;
    for (const s of state.structures) {
      if (s.hp <= 0) continue;
      const c = structureCenter(s);
      const halfDiag = Math.hypot(s.footW * GRID_CELL_SIZE, s.footD * GRID_CELL_SIZE) * 0.5 + 1.2;
      const d = topologyDistanceXZ(state, wx, wz, c.x, c.z);
      if (d <= halfDiag && (best === null || d < best.d)) {
        best = { kind: "structure", id: s.id, d };
      }
    }
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      const d = topologyDistanceXZ(state, wx, wz, u.position.x, u.position.z);
      if (d <= WORLD_UNIT_ATTACK_PICK && (best === null || d < best.d)) {
        best = { kind: "unit", id: u.id, d };
      }
    }
    return best ? { kind: best.kind, id: best.id } : null;
  }

  /** Like {@link pickAttackTargetNearWorld} but only **enemy** units/structures (rally must not block on your own Core). */
  private pickEnemyAttackTargetNearWorld(
    wx: number,
    wz: number
  ): { kind: "unit"; id: string } | { kind: "structure"; id: string } | null {
    const state = this.lastSyncedState;
    if (!state) return null;
    const pid = this.options.localPlayerId;
    let best: { kind: "unit" | "structure"; id: string; d: number } | null = null;
    for (const s of state.structures) {
      if (s.hp <= 0 || s.playerId === pid) continue;
      const c = structureCenter(s);
      const halfDiag = Math.hypot(s.footW * GRID_CELL_SIZE, s.footD * GRID_CELL_SIZE) * 0.5 + 1.2;
      const d = topologyDistanceXZ(state, wx, wz, c.x, c.z);
      if (d <= halfDiag && (best === null || d < best.d)) {
        best = { kind: "structure", id: s.id, d };
      }
    }
    for (const u of state.units) {
      if (u.hp <= 0 || u.playerId === pid) continue;
      const d = topologyDistanceXZ(state, wx, wz, u.position.x, u.position.z);
      if (d <= WORLD_UNIT_ATTACK_PICK && (best === null || d < best.d)) {
        best = { kind: "unit", id: u.id, d };
      }
    }
    return best ? { kind: best.kind, id: best.id } : null;
  }

  private enemyTargetVisible(target: { kind: "unit"; id: string } | { kind: "structure"; id: string }): boolean {
    if (this.fogSuspended()) return true;
    const st = this.lastSyncedState;
    if (!st) return false;
    if (target.kind === "unit") {
      const u = st.units.find((x) => x.id === target.id);
      if (!u || u.hp <= 0) return false;
      return this.fogGrid.isClearAtWorld(u.position.x, u.position.z);
    }
    const s = st.structures.find((x) => x.id === target.id);
    if (!s || s.hp <= 0) return false;
    const c = structureCenter(s);
    return this.fogGrid.isClearAtWorld(c.x, c.z);
  }

  private updateMarqueeBox(ax: number, ay: number, bx: number, by: number): void {
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    const w = Math.abs(bx - ax);
    const h = Math.abs(by - ay);
    this.marqueeDiv.style.display = "block";
    this.marqueeDiv.style.left = `${left}px`;
    this.marqueeDiv.style.top = `${top}px`;
    this.marqueeDiv.style.width = `${w}px`;
    this.marqueeDiv.style.height = `${h}px`;
  }

  private unitsInMarqueeClient(ax: number, ay: number, bx: number, by: number): string[] {
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const state = this.lastSyncedState;
    if (!state) return [];
    const pid = this.options.localPlayerId;
    const ids: string[] = [];
    for (const u of state.units) {
      if (u.playerId !== pid) continue;
      const scr = this.worldToScreenClient(u.position.x, u.position.y, u.position.z);
      if (!scr.ok) continue;
      if (scr.sx >= minX && scr.sx <= maxX && scr.sy >= minY && scr.sy <= maxY) {
        if (!this.isWorldPointOnVisibleMoonHemisphere(u.position.x, u.position.y, u.position.z)) continue;
        ids.push(u.id);
      }
    }
    return ids;
  }

  private isWorldPointOnVisibleMoonHemisphere(x: number, y: number, z: number): boolean {
    const w = this.wrapSimXZNearCamera(x, z);
    surfacePointFromWorldXZ("sphere", w.x, y, w.z, this.projVec);
    this.projVec.applyQuaternion(this.moonSpinQuat);
    this.tmpCameraToUnit.copy(this.camera.position).sub(this.projVec).normalize();
    return this.projVec.dot(this.tmpCameraToUnit) > 0.04;
  }

  private worldToScreenClient(x: number, y: number, z: number): { sx: number; sy: number; ok: boolean } {
    const w = this.wrapSimXZNearCamera(x, z);
    surfacePointFromWorldXZ("sphere", w.x, y, w.z, this.projVec);
    this.projVec.applyQuaternion(this.moonSpinQuat);
    this.projVec.project(this.camera);
    if (Math.abs(this.projVec.x) > 1.02 || Math.abs(this.projVec.y) > 1.02) {
      return { sx: 0, sy: 0, ok: false };
    }
    const r = this.renderer.domElement.getBoundingClientRect();
    const sx = (this.projVec.x * 0.5 + 0.5) * r.width + r.left;
    const sy = (-this.projVec.y * 0.5 + 0.5) * r.height + r.top;
    return { sx, sy, ok: true };
  }

  private currentTouchPinchDistance(): number | null {
    const points = [...this.activeTouchPointers.values()];
    if (points.length < 2) return null;
    const a = points[0]!;
    const b = points[1]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private handleRmbCanvasMove(ev: PointerEvent): void {
    if (!this.rmbTrack || ev.pointerId !== this.rmbPointerId) return;
    if (this.rmbSurfaceSpin && document.pointerLockElement === this.renderer.domElement) return;

    const sampleDx = ev.clientX - this.rmbTrack.lastX;
    const sampleDy = ev.clientY - this.rmbTrack.lastY;
    this.rmbTrack.lastX = ev.clientX;
    this.rmbTrack.lastY = ev.clientY;

    const distFromStart = Math.hypot(ev.clientX - this.rmbTrack.startX, ev.clientY - this.rmbTrack.startY);
    if (distFromStart <= RMB_DRAG_THRESHOLD_PX && !this.rmbUsedCameraDrag) return;

    if (!this.rmbUsedCameraDrag) {
      this.rmbUsedCameraDrag = true;
      if (this.rmbSurfaceSpin) {
        this.updateCameraTransform();
        return;
      }
    }
    this.rmbUsedCameraDrag = true;

    if (this.rmbSurfaceSpin) {
      if (Math.hypot(sampleDx, sampleDy) > 0.25) {
        this.applyMoonSpinFromScreenDelta(sampleDx, sampleDy);
      }
      this.updateCameraTransform();
      return;
    }

    if (!this.rmbPanHasPrevSample) {
      this.rmbPanPrevClientX = ev.clientX;
      this.rmbPanPrevClientY = ev.clientY;
      this.rmbPanHasPrevSample = true;
      return;
    }
    const dx = ev.clientX - this.rmbPanPrevClientX;
    const dy = ev.clientY - this.rmbPanPrevClientY;
    this.rmbPanPrevClientX = ev.clientX;
    this.rmbPanPrevClientY = ev.clientY;
    const hyp = Math.hypot(dx, dy);
    if (hyp > 0.25) {
      const strafe = dx / hyp;
      const forward = -dy / hyp;
      const distance =
        (tuning.camera.panSpeed / 60) * (hyp / RMB_PAN_PIXELS_PER_KEY_FRAME_EQUIV);
      this.moveSphereCameraTarget(strafe, forward, distance);
    }
    this.updateCameraTransform();
  }

  applyMoonSpinFromScreenDelta(dx: number, dy: number): void {
    const sens = THREE.MathUtils.clamp(tuning.camera.sphereOrbitRadiansPerPixel, 0.0008, 0.008);
    const maxStep = tuning.camera.moonSpinMaxRadiansPerPointerStep * 3.5;
    const yaw = THREE.MathUtils.clamp(dx * sens, -maxStep, maxStep);
    const pitch = THREE.MathUtils.clamp(dy * sens, -maxStep, maxStep);
    this.applyMoonSpinYawPitchDelta(yaw, pitch);
  }

  private handleRmbPointerLockMove(ev: MouseEvent): void {
    if (!this.rmbTrack || !this.rmbSurfaceSpin) return;
    if (document.pointerLockElement !== this.renderer.domElement) return;
    const dx = ev.movementX;
    const dy = ev.movementY;
    const d = Math.hypot(dx, dy);
    if (d <= 0) return;
    this.rmbPointerLockMoveDistance += d;
    if (this.rmbPointerLockMoveDistance <= RMB_DRAG_THRESHOLD_PX && !this.rmbUsedCameraDrag) return;
    if (!this.rmbUsedCameraDrag) {
      this.rmbUsedCameraDrag = true;
      this.updateCameraTransform();
      return;
    }
    this.rmbUsedCameraDrag = true;
    this.applyMoonSpinFromScreenDelta(dx, dy);
    this.updateCameraTransform();
  }

  private handleRmbPointerLockMouseUp(ev: MouseEvent): void {
    if (!this.rmbTrack) return;
    this.finishRmbGesture(ev.clientX, ev.clientY, ev.shiftKey, ev.ctrlKey, ev.type);
  }

  private handleRmbCanvasUp(ev: PointerEvent): void {
    if (!this.rmbTrack || ev.pointerId !== this.rmbPointerId) return;
    this.finishRmbGesture(ev.clientX, ev.clientY, ev.shiftKey, ev.ctrlKey, ev.type, ev.pointerId);
  }

  private finishRmbGesture(
    clientX: number,
    clientY: number,
    shiftKey: boolean,
    ctrlKey: boolean,
    eventType: string,
    pointerId?: number
  ): void {
    const canvas = this.renderer.domElement;
    if (this.rmbPointerLockTimer !== null) {
      window.clearTimeout(this.rmbPointerLockTimer);
      this.rmbPointerLockTimer = null;
    }
    canvas.removeEventListener("pointermove", this.onRmbCanvasMove);
    canvas.removeEventListener("pointerup", this.onRmbCanvasUp);
    canvas.removeEventListener("pointercancel", this.onRmbCanvasUp);
    document.removeEventListener("mousemove", this.onRmbPointerLockMove);
    document.removeEventListener("mouseup", this.onRmbPointerLockMouseUp);
    try {
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }

    this.rmbTrack = null;
    this.rmbPanHasPrevSample = false;
    this.rmbSpinArcPrevValid = false;
    this.rmbSurfaceSpin = false;
    this.rmbPointerLockMoveDistance = 0;
    this.rmbPointerId = -1;

    const wasDrag = this.rmbUsedCameraDrag;
    this.rmbUsedCameraDrag = false;

    if (!wasDrag && eventType !== "pointercancel") {
      const pt = this.pointerEventToGroundAt(clientX, clientY);
      if (pt) {
        this.issueRmbAtWorld(pt.x, pt.z, shiftKey, ctrlKey);
      }
    }
  }

  private pickResourceFieldIdAt(clientX: number, clientY: number): string | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [...this.meshByResourceFieldId.values()];
    const hits = this.raycaster.intersectObjects(roots, true);
    const state = this.lastSyncedState;
    if (!state) return null;
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const fid = o.userData["resourceFieldId"] as string | undefined;
        if (fid) {
          const fld = state.resourceFields.find((x) => x.id === fid);
          if (
            fld &&
            fld.kind === "minerals" &&
            (fld.reserve === null || fld.reserve > 0)
          ) {
            return fid;
          }
        }
        o = o.parent;
      }
    }

    const pt = this.pointerEventToGroundAt(clientX, clientY);
    if (!pt) return null;
    let best: { id: string; d: number } | null = null;
    for (const f of state.resourceFields) {
      if (f.kind !== "minerals") continue;
      if (f.reserve !== null && f.reserve <= 0) continue;
      const c = resourceFieldCenterWorld(f);
      const d = sphereGeodesicDistanceWorldXZ(pt.x, pt.z, c.x, c.z);
      if (d <= GATHER_MINERAL_MAX_SURFACE_METERS && (best === null || d < best.d)) {
        best = { id: f.id, d };
      }
    }
    return best?.id ?? null;
  }

  /**
   * Minimap fog: `explored` = ever revealed, `visible` = current line of sight (same rules as the main view).
   * When fog is suspended (admin panel), both are always true.
   */
  minimapFogAtWorld(wx: number, wz: number): { explored: boolean; visible: boolean } {
    if (this.fogSuspended()) {
      return { explored: true, visible: true };
    }
    return {
      explored: this.fogGrid.isExploredAtWorld(wx, wz),
      visible: this.fogGrid.isClearAtWorld(wx, wz)
    };
  }

  /** False when fog is suspended — minimap should show the full arena. */
  minimapFogOfWarEnabled(): boolean {
    return !this.fogSuspended();
  }

  /** Approximate camera footprint for minimap viewport box. */
  minimapCameraBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const half = THREE.MathUtils.clamp(this.cameraDistance * 0.72, 9, 28);
    const center = this.sphereCameraAnchorXZ();
    return {
      minX: center.x - half,
      maxX: center.x + half,
      minZ: center.z - half,
      maxZ: center.z + half
    };
  }

  /** Shared with the HUD minimap so both views rotate the same globe. */
  getMoonSpinQuaternion(): THREE.Quaternion {
    return this.moonSpinQuat.clone();
  }

  getMinimapViewFrame(): {
    position: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
  } {
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z
      },
      up: {
        x: this.camera.up.x,
        y: this.camera.up.y,
        z: this.camera.up.z
      }
    };
  }

  resetMoonSpin(): void {
    this.moonSpinYawRad = 0;
    this.moonSpinPitchRad = 0;
    this.moonSpinQuat.identity();
    this.moonSpinTargetQuat.identity();
    this.moonSpinRoot.quaternion.identity();
  }

  private writeConstrainedMoonSpinTarget(): void {
    this.tmpMoonYawQuat.setFromAxisAngle(this.unitUp, this.moonSpinYawRad);
    this.tmpCameraRight.set(1, 0, 0);
    this.tmpMoonPitchQuat.setFromAxisAngle(this.tmpCameraRight, this.moonSpinPitchRad);
    // Rebuild from absolute world axes each time; do not let pointer deltas accumulate into roll.
    this.moonSpinTargetQuat.copy(this.tmpMoonPitchQuat).multiply(this.tmpMoonYawQuat).normalize();
  }

  /**
   * Parents the `moonSpaceCosmos` group (gradient sky, stars, toy planets from `setupMoonAtmosphere`)
   * under the moon spin root so minimap / canonical globe spin moves the firmament with the moon.
   */
  attachCosmosToMoonSpin(cosmos: THREE.Object3D): void {
    if (cosmos.parent) cosmos.removeFromParent();
    this.moonSpinRoot.add(cosmos);
  }

  /**
   * Legacy surface-hit adapter. Convert to constrained globe yaw/pitch rather than free arcball roll.
   */
  applyMoonSpinFromCanonicalHits(vPrev: THREE.Vector3, vCurr: THREE.Vector3): void {
    const prevLon = Math.atan2(vPrev.z, vPrev.x);
    const currLon = Math.atan2(vCurr.z, vCurr.x);
    let dLon = currLon - prevLon;
    if (dLon > Math.PI) dLon -= Math.PI * 2;
    else if (dLon < -Math.PI) dLon += Math.PI * 2;
    const dLat = Math.asin(THREE.MathUtils.clamp(vCurr.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(vPrev.y, -1, 1));
    const maxStep = tuning.camera.moonSpinMaxRadiansPerPointerStep * 1.4;
    this.applyMoonSpinYawPitchDelta(
      THREE.MathUtils.clamp(dLon, -maxStep, maxStep),
      THREE.MathUtils.clamp(dLat, -maxStep, maxStep)
    );
  }

  private applyMoonSpinYawPitchDelta(yawDelta: number, pitchDelta: number): void {
    this.moonSpinYawRad = THREE.MathUtils.euclideanModulo(this.moonSpinYawRad + yawDelta, Math.PI * 2);
    this.moonSpinPitchRad = THREE.MathUtils.clamp(
      this.moonSpinPitchRad + pitchDelta,
      -MOON_SPIN_MAX_PITCH_RAD,
      MOON_SPIN_MAX_PITCH_RAD
    );
    this.writeConstrainedMoonSpinTarget();
  }

  /** After `surfacePointFromWorldXZ` / canonical moon point, apply before `project()` to match the spun mesh. */
  applyMoonPresentationToSurfacePoint(v: THREE.Vector3): void {
    v.applyQuaternion(this.moonSpinQuat);
  }

  minimapSphereFrame(): { centerX: number; centerZ: number; east: { x: number; y: number; z: number } } {
    const anchor = this.sphereCameraAnchorXZ();
    buildSurfaceTangentFrame(
      "sphere",
      anchor.x,
      anchor.z,
      this.tmpSphereN,
      this.tmpSphereNorth,
      this.tmpMinimapFrameNormal,
      this.sphereEastTangent
    );
    this.sphereEastTangent.copy(this.tmpSphereN);
    return {
      centerX: anchor.x,
      centerZ: anchor.z,
      east: { x: this.tmpSphereN.x, y: this.tmpSphereN.y, z: this.tmpSphereN.z }
    };
  }

  /** Center the orbit target over a world XZ (e.g. your Command Core at match start). */
  focusCameraOnWorldXZ(x: number, z: number): void {
    this.setCameraTargetXZ(x, z);
    this.updateCameraTransform();
  }

  focusHomeOverviewOnWorldXZ(x: number, z: number): void {
    this.setCameraTargetXZ(x, z);
    this.cameraOrbitTheta = HOME_OVERVIEW_CAMERA_THETA;
    this.cameraOrbitPhi = HOME_OVERVIEW_CAMERA_PHI;
    this.cameraDistance = THREE.MathUtils.clamp(
      HOME_OVERVIEW_CAMERA_DISTANCE,
      tuning.camera.zoomMin,
      tuning.camera.zoomMax
    );
    this.updateCameraTransform();
  }

  selectNextIdleNeutralUnit(focusCamera = false): void {
    this.selectNextIdleUnit("neutral", focusCamera);
  }

  selectNextIdleMilitaryUnit(focusCamera = false): void {
    this.selectNextIdleUnit("military", focusCamera);
  }

  noteIdleShortcutTap(kind: "neutral" | "military"): boolean {
    const now = performance.now();
    if (kind === "neutral") {
      const doubleTap = now - this.lastIdleNeutralTapMs < 430;
      this.lastIdleNeutralTapMs = now;
      return doubleTap;
    }
    const doubleTap = now - this.lastIdleMilitaryTapMs < 430;
    this.lastIdleMilitaryTapMs = now;
    return doubleTap;
  }

  private selectNextIdleUnit(kind: "neutral" | "military", focusCamera: boolean): void {
    const st = this.lastSyncedState;
    if (!st) return;
    const pid = this.options.localPlayerId;
    const candidates = st.units.filter((u) => {
      if (u.playerId !== pid || u.hp <= 0) return false;
      if (kind === "neutral" ? u.kind !== "N" : u.kind === "N") return false;
      return this.isIdleUnit(u);
    });
    if (candidates.length === 0) return;
    const anchor = this.sphereCameraAnchorXZ();
    candidates.sort((a, b) => {
      const da = topologyDistanceXZ(st, anchor.x, anchor.z, a.position.x, a.position.z);
      const db = topologyDistanceXZ(st, anchor.x, anchor.z, b.position.x, b.position.z);
      return da - db || a.id.localeCompare(b.id);
    });
    const sel = st.selections[pid] ?? [];
    const current = sel.find((id) => candidates.some((u) => u.id === id)) ?? null;
    const idx = current ? candidates.findIndex((u) => u.id === current) : -1;
    const nextIdx =
      focusCamera && current
        ? idx
        : current
          ? (idx + 1 + candidates.length) % candidates.length
          : 0;
    if (kind === "neutral") this.idleNeutralCycleIdx = nextIdx;
    else this.idleMilitaryCycleIdx = nextIdx;
    const target = candidates[nextIdx]!;
    this.options.submitCommand(
      createGameCommand(pid, "select_units_and_structures", {
        unitIds: [target.id],
        structureIds: []
      })
    );
    if (focusCamera) this.focusCameraOnWorldXZ(target.position.x, target.position.z);
  }

  private isIdleUnit(u: SimUnit): boolean {
    return (
      u.moveTarget === null &&
      u.attackMoveTarget === null &&
      u.attackTargetId === null &&
      u.attackStructureTargetId === null &&
      u.gatherTargetFieldId === null &&
      u.depositStructureTargetId === null &&
      u.moveWaypointQueue.length === 0
    );
  }

  /**
   * Same command routing as a main-view right-click on open ground at `(worldX, worldZ)` (move, waypoint
   * queue, attack-move, gather, deposit, rally). Used by the HUD minimap.
   *
   * Open ground with unit selection: plain RMB → move; Shift+RMB → queue waypoint (up to 8 segments);
   * Ctrl+RMB → attack-move (Ctrl wins if both modifiers are held).
   */
  issueRmbAtWorld(worldX: number, worldZ: number, shiftKey: boolean, ctrlKey: boolean): void {
    const canonical = canonicalizeWorldPoint("sphere", worldX, worldZ);
    const x = canonical.x;
    const z = canonical.z;
    const { localPlayerId, submitCommand } = this.options;
    const st = this.lastSyncedState;
    if (!st) return;

    const selection = st.selections[localPlayerId] ?? [];
    const structSel = st.structureSelections[localPlayerId] ?? [];
    const selectedHaveExplicitCombatLock = selection.some((id) => {
      const u = st.units.find((uu) => uu.id === id);
      return !!u && (u.attackTargetId !== null || u.attackStructureTargetId !== null);
    });
    const hasMinerSelected =
      selection.length > 0 &&
      selection.some((id) => {
        const u = st.units.find((uu) => uu.id === id);
        return u?.kind === "N";
      });
    /** Deposit shortcut only when a selected miner is carrying ore — otherwise RMB near Core is a no-op move. */
    const hasMinerWithCargo =
      hasMinerSelected &&
      selection.some((id) => {
        const u = st.units.find((uu) => uu.id === id);
        return u?.kind === "N" && u.carriedMinerals > 0;
      });
    const rallyStructsOnly = structSel.length > 0 && selection.length === 0;
    const rallyBlockedByTargetRaw = rallyStructsOnly ? this.pickEnemyAttackTargetNearWorld(x, z) : null;
    const rallyBlockedByTarget =
      rallyBlockedByTargetRaw && this.enemyTargetVisible(rallyBlockedByTargetRaw)
        ? rallyBlockedByTargetRaw
        : null;
    if (rallyStructsOnly && !rallyBlockedByTarget) {
      const fieldIdHint = this.pickResourceFieldIdNearWorld(x, z);
      const fld = fieldIdHint ? st.resourceFields.find((f) => f.id === fieldIdHint) : undefined;
      if (
        fld &&
        fld.kind === "minerals" &&
        (fld.reserve === null || fld.reserve > 0)
      ) {
        const c = resourceFieldCenterWorld(fld);
        submitCommand(
          createGameCommand(localPlayerId, "set_rally", {
            target: { x: c.x, y: c.y, z: c.z },
            structureIds: [...structSel],
            mineFieldId: fld.id
          })
        );
      } else {
        submitCommand(
          createGameCommand(localPlayerId, "set_rally", {
            target: { x, y: 0.55, z },
            structureIds: [...structSel]
          })
        );
      }
      return;
    }

    // If units are already in explicit combat focus, plain RMB should always break out into move.
    const allowRmbDirectAttack = !selectedHaveExplicitCombatLock;
    const atk = selection.length > 0 && allowRmbDirectAttack ? this.pickAttackTargetNearWorld(x, z) : null;
    if (allowRmbDirectAttack) {
      if (atk?.kind === "structure" && this.isEnemyStructure(atk.id) && this.enemyTargetVisible(atk)) {
        submitCommand(
          createGameCommand(localPlayerId, "attack_structure", { targetStructureId: atk.id })
        );
        return;
      }
      if (atk?.kind === "unit" && this.isEnemyUnit(atk.id) && this.enemyTargetVisible(atk)) {
        submitCommand(createGameCommand(localPlayerId, "attack_unit", { targetUnitId: atk.id }));
        return;
      }
    }

    if (atk?.kind === "structure" && hasMinerSelected) {
      const assistSt = st.structures.find((s) => s.id === atk.id);
      if (
        assistSt &&
        assistSt.playerId === localPlayerId &&
        assistSt.hp > 0 &&
        assistSt.buildRemainingSec > 0
      ) {
        const c = structureCenter(assistSt);
        submitCommand(
          createGameCommand(localPlayerId, "move_units", {
            target: { x: c.x, y: c.y, z: c.z },
            formation: tuning.formation.active
          })
        );
        return;
      }
    }

    /** Gather proximity only for Neutral miners — R/S/P would reject gather and block move on ground near nodes. */
    const gatherFieldId = hasMinerSelected ? this.pickResourceFieldIdNearWorld(x, z) : null;
    if (gatherFieldId) {
      submitCommand(createGameCommand(localPlayerId, "gather_from_field", { fieldId: gatherFieldId }));
      return;
    }

    const depositSid = hasMinerWithCargo ? this.pickOwnedDepositoryNearWorld(x, z) : null;
    if (depositSid) {
      submitCommand(
        createGameCommand(localPlayerId, "deposit_at_structure", {
          targetStructureId: depositSid
        })
      );
      return;
    }

    if (selection.length > 0) {
      const target = { x, y: 0.55, z };
      const formation = tuning.formation.active;
      if (ctrlKey) {
        submitCommand(createGameCommand(localPlayerId, "attack_move_units", { target, formation }));
      } else if (shiftKey) {
        submitCommand(createGameCommand(localPlayerId, "queue_move_waypoint", { target, formation }));
      } else {
        submitCommand(createGameCommand(localPlayerId, "move_units", { target, formation }));
      }
    }
  }

  private isEnemyUnit(unitId: string): boolean {
    const u = this.lastSyncedState?.units.find((x) => x.id === unitId);
    return !!u && u.playerId !== this.options.localPlayerId;
  }

  private isEnemyStructure(structureId: string): boolean {
    const s = this.lastSyncedState?.structures.find((x) => x.id === structureId);
    return !!s && s.playerId !== this.options.localPlayerId && s.hp > 0;
  }

  private pickAttackTargetAt(
    clientX: number,
    clientY: number
  ): { kind: "unit"; id: string } | { kind: "structure"; id: string } | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [...this.meshByStructureId.values(), ...this.meshByUnitId.values()];
    const hits = this.raycaster.intersectObjects(roots, true);
    const state = this.lastSyncedState;
    if (!state) return null;

    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const sid = o.userData["structureId"] as string | undefined;
        if (sid) {
          const st = state.structures.find((x) => x.id === sid);
          if (st && st.hp > 0) return { kind: "structure", id: sid };
        }
        const uid = o.userData["unitId"] as string | undefined;
        if (uid && state.units.some((u) => u.id === uid)) {
          return { kind: "unit", id: uid };
        }
        o = o.parent;
      }
    }
    return null;
  }

  private pickAnyUnitIdAt(clientX: number, clientY: number): string | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const roots = [...this.meshByUnitId.values()];
    const hits = this.raycaster.intersectObjects(roots, true);
    if (hits.length === 0) return null;

    let o: THREE.Object3D | null = hits[0].object;
    let unitId: string | undefined;
    while (o) {
      unitId = o.userData["unitId"] as string | undefined;
      if (unitId) break;
      o = o.parent;
    }
    if (!unitId) return null;
    if (!this.lastSyncedState?.units.some((u) => u.id === unitId)) return null;
    return unitId;
  }

  private pickOwnedUnitIdAt(clientX: number, clientY: number): string | null {
    const id = this.pickAnyUnitIdAt(clientX, clientY);
    if (!id || !this.lastSyncedState) return null;
    const unit = this.lastSyncedState.units.find((u) => u.id === id);
    if (!unit || unit.playerId !== this.options.localPlayerId) return null;
    return id;
  }

  private pointerEventToGroundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const target = this.pointerGroundTarget;
    this.moonSpinQuatInv.copy(this.moonSpinQuat).invert();
    this.tmpSpherePos.copy(this.raycaster.ray.origin).applyQuaternion(this.moonSpinQuatInv);
    this.tmpSphereN.copy(this.raycaster.ray.direction).applyQuaternion(this.moonSpinQuatInv).normalize();
    this.tmpMoonPickRay.set(this.tmpSpherePos, this.tmpSphereN);
    if (!rayIntersectGroundSphere(this.tmpMoonPickRay, this.pointerGroundHit)) return null;
    const xz = projectSurfacePointToWorldXZ("sphere", this.pointerGroundHit);
    target.set(xz.x, 0.55, xz.z);
    return target;
  }

  /** Unit direction on the canonical gameplay sphere for the pixel (inverse moon spin + raycast). */
  private canonicalMoonDirFromScreen(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    this.moonSpinQuatInv.copy(this.moonSpinQuat).invert();
    this.tmpSpherePos.copy(this.raycaster.ray.origin).applyQuaternion(this.moonSpinQuatInv);
    this.tmpSphereN.copy(this.raycaster.ray.direction).applyQuaternion(this.moonSpinQuatInv).normalize();
    this.tmpMoonPickRay.set(this.tmpSpherePos, this.tmpSphereN);
    if (!rayIntersectGroundSphere(this.tmpMoonPickRay, out)) return false;
    out.normalize();
    return true;
  }

  private updateCameraInput(deltaSeconds: number): void {
    const panSpeed = tuning.camera.panSpeed * deltaSeconds;
    let strafe = 0;
    let forward = 0;
    if (this.keys["w"] || this.keys["arrowup"]) forward += 1;
    if (this.keys["s"] || this.keys["arrowdown"]) forward -= 1;
    if (this.keys["d"] || this.keys["arrowright"]) strafe += 1;
    if (this.keys["a"] || this.keys["arrowleft"]) strafe -= 1;

    const keyPanActive =
      this.keys["w"] ||
      this.keys["s"] ||
      this.keys["a"] ||
      this.keys["d"] ||
      this.keys["arrowup"] ||
      this.keys["arrowdown"] ||
      this.keys["arrowleft"] ||
      this.keys["arrowright"];

    // Edge scroll alone is useful; with WASD held it adds stray strafe/forward (e.g. S + cursor off-center).
    if (!keyPanActive && this.hasPointerSample) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const px = this.lastPointerClientX;
      const py = this.lastPointerClientY;
      if (px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom) {
        const leftT = THREE.MathUtils.clamp((EDGE_SCROLL_MARGIN_PX - (px - rect.left)) / EDGE_SCROLL_MARGIN_PX, 0, 1);
        const rightT = THREE.MathUtils.clamp((EDGE_SCROLL_MARGIN_PX - (rect.right - px)) / EDGE_SCROLL_MARGIN_PX, 0, 1);
        const topT = THREE.MathUtils.clamp((EDGE_SCROLL_MARGIN_PX - (py - rect.top)) / EDGE_SCROLL_MARGIN_PX, 0, 1);
        const bottomT = THREE.MathUtils.clamp((EDGE_SCROLL_MARGIN_PX - (rect.bottom - py)) / EDGE_SCROLL_MARGIN_PX, 0, 1);
        strafe += rightT - leftT;
        forward += topT - bottomT;
      }
    }

    if (strafe !== 0 || forward !== 0) {
      this.moveSphereCameraTarget(strafe, forward, panSpeed);
    }
    this.cameraOrbitTheta = THREE.MathUtils.euclideanModulo(this.cameraOrbitTheta, Math.PI * 2);
    this.updateCameraTransform();
  }

  private updateCameraTransform(): void {
    this.writeConstrainedMoonSpinTarget();
    const anchor = this.sphereCameraAnchorXZ();
    const cx = anchor.x;
    const cz = anchor.z;
    buildSurfaceTangentFrame(
      "sphere",
      cx,
      cz,
      this.tmpSphereN,
      this.tmpSphereNorth,
      this.pointerGroundHit,
      this.sphereEastTangent
    );
    this.sphereEastTangent.copy(this.tmpSphereN);
    const east = this.tmpSphereN;
    const north = this.tmpSphereNorth;
    const n = this.pointerGroundHit;
    this.tmpSpherePos.copy(n).multiplyScalar(SPHERE_MOON_RADIUS);

    const phi = THREE.MathUtils.clamp(this.cameraOrbitPhi, 0.04, 1.52);
    const theta = this.cameraOrbitTheta;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    this.tmpCameraOffset
      .copy(n)
      .multiplyScalar(cosP)
      .addScaledVector(north, sinP * Math.cos(theta))
      .addScaledVector(east, sinP * Math.sin(theta));
    this.tmpCameraOffset.multiplyScalar(this.cameraDistance);
    this.tmpCameraOffset.addScaledVector(n, 2.25);
    this.camera.position.copy(this.tmpSpherePos).add(this.tmpCameraOffset);
    // Keep the viewport north-up like a physical globe. Using the local surface normal as camera.up
    // rolls the screen frame around the moon, making horizontal drags look diagonal/corkscrewed.
    this.camera.up.copy(this.unitUp);
    // Aim above the moon's centerline so the sphere stays centered left/right while sitting lower
    // in the viewport, leaving visible sky above.
    this.pointerGroundTarget.set(0, VIEWPORT_PLANET_LOWER_BIAS_METERS, 0);
    this.camera.lookAt(this.pointerGroundTarget);
    // Smooth visual spin between pointer events to remove mesh jitter/ghost stepping.
    const spinDot = Math.abs(this.moonSpinQuat.dot(this.moonSpinTargetQuat));
    if (1 - spinDot > 1e-6) {
      this.moonSpinQuat.slerp(this.moonSpinTargetQuat, 0.42);
      this.moonSpinQuat.normalize();
    }
    this.moonSpinRoot.quaternion.copy(this.moonSpinQuat);
  }
}
