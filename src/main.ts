import * as THREE from "three";
import {
  otherSkirmishPlayerId,
  parseClientMatchSetupFromLocationSearch
} from "./core/match/clientMatch";
import { bootstrapGame } from "./game/bootstrap";
import {
  initComputerOpponentPersonality,
  resetComputerOpponentState,
  tickComputerOpponent
} from "./game/opponent/computerOpponent";
import { mountRuntimeTuningPanel } from "./game/adminPanel";
import type { PlaceableStructureKind } from "./core/commands/GameCommand";
import { createHudMinimap } from "./game/hudMinimap";
import { PrototypeView, type WorldInspectHit } from "./game/prototype";
import { DamageNumberOverlay } from "./game/visual/damageNumberOverlay";
import { HitFlashOverlay } from "./game/visual/hitFlashOverlay";
import { SelectionNameplateOverlay } from "./game/visual/selectionNameplateOverlay";
import { MOON_SUN_DIRECTION_WORLD, setupMoonAtmosphere } from "./game/visual/moonEnvironment";
import { MoonPresentationComposer } from "./game/visual/moonPresentationComposer";
import { installMoonReferenceExporter } from "./game/visual/exportMoonReference";
import { createGameCommand, type GameCommand } from "./core/commands/GameCommand";
import {
  MATCH_ANALYTICS_SCHEMA_VERSION,
  MatchAnalyticsRecorder,
  resolveAnalyticsActor
} from "./core/analytics/matchAnalytics";
import {
  COMMAND_CORE_PLACE_COST_ENERGY,
  COMMAND_CORE_PLACE_COST_MINERALS,
  DEFENSE_OBELISK_PLACE_COST_ENERGY,
  DEFENSE_OBELISK_PLACE_COST_MINERALS,
  POWER_SPIRE_PLACE_COST_ENERGY,
  POWER_SPIRE_PLACE_COST_MINERALS,
  STRUCTURE_PLACE_COST_ENERGY,
  STRUCTURE_PLACE_COST_MINERALS,
  resourcesForPlaceStructure,
  resourcesForTrainKind
} from "./core/economyConstants";
import type { UiFeedbackEvent } from "./core/sim/uiFeedbackEvents";
import type { SimulationEvent, SimulationTickResult } from "./core/sim/simulationEvents";
import {
  formatStructurePassiveLine,
  formatStructureProductionLine,
  formatStructureStatusLine,
  formatStructureTrainSummary,
  formatUnitActivityLine,
  formatUnitSelectionCardBody
} from "./core/selectionCardCopy";
import {
  isStructureBuilt,
  structureCenter,
  structureProducesKind,
  type GameState,
  type SimUnit
} from "./core/state/GameState";
import { structureProductionTooltip } from "./core/structureProductionTooltip";
import { structureDisplayName } from "./core/structureDisplayNames";
import { tuning } from "./core/runtimeTuning";
import { getUnitMaxHp } from "./core/balance";
import { unitNameplateLabel } from "./core/unitDisplayNames";
import { dispatchUiFeedback } from "./game/feedback/dispatchUiFeedback";
import { createWebAudioFeedbackSounds } from "./game/feedback/webAudioFeedbackSounds";
import { connectMatchAuthorityWs } from "./game/net/matchAuthorityClient";
import { reviveGameStateFromNetwork } from "./game/net/gameStateFromNetwork";
import { resolveMatchWebSocketUrl } from "./game/net/resolveMatchWebSocketUrl";

const POP_CAP_PLACEHOLDER = 200;

function defaultMoonTextureUrl(): string {
  return new URL("./moon/moontexture.jpg?v=4", window.location.href).toString();
}

/** Full seconds shown (5…1), then {@link MATCH_BEGIN_FLASH_SEC} of "BEGIN!". */
const MATCH_COUNTDOWN_SECONDS = 5;
const MATCH_BEGIN_FLASH_SEC = 0.9;
const MAX_NET_INBOX_PACKETS = 240;

function readSkipMatchCountdownFromSearch(search: string): boolean {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return q.get("skipCountdown") === "1" || q.get("skipCountdown") === "true";
}

const PLACE_SPECS: { id: string; kind: PlaceableStructureKind; hotkey: string; code: string }[] = [
  { id: "hudBuildCommandCore", kind: "home", hotkey: "C", code: "KeyC" },
  { id: "hudBuildBarracksR", kind: "barracks_r", hotkey: "R", code: "KeyR" },
  { id: "hudBuildBarracksS", kind: "barracks_s", hotkey: "X", code: "KeyX" },
  { id: "hudBuildBarracksP", kind: "barracks_p", hotkey: "P", code: "KeyP" },
  { id: "hudBuildMineralDepot", kind: "mineral_depot", hotkey: "F", code: "KeyF" },
  { id: "hudBuildPowerSpire", kind: "power_spire", hotkey: "E", code: "KeyE" },
  { id: "hudBuildDefenseObelisk", kind: "defense_obelisk", hotkey: "T", code: "KeyT" }
];

function createHUD(): HTMLDivElement {
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="hud-shortcut-note">Double Tap H to reset view back to Home</div>
    <header class="hud-command-header">
      <div class="hud-command-brand">
        <span class="hud-command-title">LUNAR COMMAND</span>
        <span class="hud-command-sub">SECTOR OPS // RTS-NET</span>
      </div>
      <div class="hud-command-status" aria-hidden="true">
        <span class="hud-command-led"></span>
        <span class="hud-command-led hud-command-led--dim"></span>
        <span class="hud-command-led"></span>
      </div>
    </header>
    <div class="hud-metrics" aria-live="polite">
      <div class="hud-resources">
        <span class="hud-res hud-res--energy"><abbr title="Energy">Energy</abbr> <span id="hudEnergy">0</span></span>
        <span class="hud-res hud-res--minerals"><span id="hudMinerals">0</span> <abbr title="Minerals">Minerals</abbr></span>
      </div>
      <div class="hud-pop">
        <span class="hud-pop-yours" id="hudPopYours">0</span>
        <span class="hud-pop-sep">/</span>
        <span class="hud-pop-cap" id="hudPopCap">${POP_CAP_PLACEHOLDER}</span>
        <span class="hud-pop-label">pop</span>
      </div>
      <div class="hud-pop hud-pop--enemy">
        <span class="hud-pop-enemy" id="hudPopEnemy">0</span>
        <span class="hud-pop-label">enemy</span>
      </div>
    </div>
    <div class="hud-pertinent" id="hudPertinent">
      <span id="hudOutcome" class="hud-outcome" hidden></span>
      <span id="hudSelected">Units 0</span>
      <span class="hud-dot" aria-hidden="true">·</span>
      <span id="hudFormation">Form square</span>
    </div>
    <div class="hud-command-action" id="hudCommandAction"></div>
    <div class="hud-idle-cycle" role="group" aria-label="Idle unit cycle">
      <button type="button" class="hud-idle-btn" id="hudIdleNeutralBtn" title="Select next idle Neutral (,). Double-tap , to focus camera.">
        <span class="hud-idle-btn__main">
          <span class="hud-idle-btn__label">IDLE N</span>
          <span class="hud-idle-btn__count" id="hudIdleNeutralCount" aria-live="polite">0</span>
        </span>
        <span class="hud-idle-btn__key">,</span>
      </button>
      <button type="button" class="hud-idle-btn hud-idle-btn--army" id="hudIdleMilitaryBtn" title="Select next idle military (.). Double-tap . to focus camera.">
        <span class="hud-idle-btn__main">
          <span class="hud-idle-btn__label">IDLE ARMY</span>
          <span class="hud-idle-btn__count" id="hudIdleMilitaryCount" aria-live="polite">0</span>
        </span>
        <span class="hud-idle-btn__key">.</span>
      </button>
    </div>
    <div id="hudBuildMenu" class="hud-build-menu" hidden>
    <div class="hud-build-head">Base</div>
    <div class="hud-build-grid" role="toolbar" aria-label="Place Command Core">
      <button type="button" class="hud-build-slot" id="hudBuildCommandCore" title="Command Core expansion (${COMMAND_CORE_PLACE_COST_ENERGY} En + ${COMMAND_CORE_PLACE_COST_MINERALS} Min). Select a Neutral (N), then click map. Builds in 180 seconds.">
        <span class="hud-build-hotkey">C</span><span class="hud-build-name">Core</span><span class="hud-build-cost">${COMMAND_CORE_PLACE_COST_ENERGY} / ${COMMAND_CORE_PLACE_COST_MINERALS}</span>
      </button>
    </div>
    <div class="hud-build-head hud-build-head--sub">Barracks</div>
    <div class="hud-build-grid" role="toolbar" aria-label="Place barracks">
      <button type="button" class="hud-build-slot" id="hudBuildBarracksR" title="Rock barracks (${STRUCTURE_PLACE_COST_ENERGY} En + ${STRUCTURE_PLACE_COST_MINERALS} Min). Select a Neutral (N), then click map. Esc cancels.">
        <span class="hud-build-hotkey">R</span><span class="hud-build-name">Rock</span><span class="hud-build-cost">${STRUCTURE_PLACE_COST_ENERGY} / ${STRUCTURE_PLACE_COST_MINERALS}</span>
      </button>
      <button type="button" class="hud-build-slot" id="hudBuildBarracksS" title="Scissors barracks (${STRUCTURE_PLACE_COST_ENERGY} En + ${STRUCTURE_PLACE_COST_MINERALS} Min). Select a Neutral (N), then click map. Esc cancels.">
        <span class="hud-build-hotkey">X</span><span class="hud-build-name">Scissors</span><span class="hud-build-cost">${STRUCTURE_PLACE_COST_ENERGY} / ${STRUCTURE_PLACE_COST_MINERALS}</span>
      </button>
      <button type="button" class="hud-build-slot" id="hudBuildBarracksP" title="Paper barracks (${STRUCTURE_PLACE_COST_ENERGY} En + ${STRUCTURE_PLACE_COST_MINERALS} Min). Select a Neutral (N), then click map. Esc cancels.">
        <span class="hud-build-hotkey">P</span><span class="hud-build-name">Paper</span><span class="hud-build-cost">${STRUCTURE_PLACE_COST_ENERGY} / ${STRUCTURE_PLACE_COST_MINERALS}</span>
      </button>
    </div>
    <div class="hud-build-head hud-build-head--sub">Depot, Solar &amp; Defense</div>
    <div class="hud-build-grid" role="toolbar" aria-label="Place depot, Solar Array, and Defense Turret">
      <button type="button" class="hud-build-slot" id="hudBuildMineralDepot" title="Mineral Depository — Neutral unload point (${STRUCTURE_PLACE_COST_ENERGY} En + ${STRUCTURE_PLACE_COST_MINERALS} Min). Select N first.">
        <span class="hud-build-hotkey">F</span><span class="hud-build-name">Depot</span><span class="hud-build-cost">${STRUCTURE_PLACE_COST_ENERGY} / ${STRUCTURE_PLACE_COST_MINERALS}</span>
      </button>
      <button type="button" class="hud-build-slot" id="hudBuildPowerSpire" title="Solar tile (1×1) — small passive energy; stack several for real output (${POWER_SPIRE_PLACE_COST_ENERGY} En + ${POWER_SPIRE_PLACE_COST_MINERALS} Min). Select N first.">
        <span class="hud-build-hotkey">E</span><span class="hud-build-name">Solar</span><span class="hud-build-cost">${POWER_SPIRE_PLACE_COST_ENERGY} / ${POWER_SPIRE_PLACE_COST_MINERALS}</span>
      </button>
      <button type="button" class="hud-build-slot" id="hudBuildDefenseObelisk" title="Defense Turret (1×1) — ranged tower with 2x Neutral vision, 1.62x Neutral damage, and 4x Neutral HP (${DEFENSE_OBELISK_PLACE_COST_ENERGY} En + ${DEFENSE_OBELISK_PLACE_COST_MINERALS} Min). Select N first.">
        <span class="hud-build-hotkey">T</span><span class="hud-build-name">Turret</span><span class="hud-build-cost">${DEFENSE_OBELISK_PLACE_COST_ENERGY} / ${DEFENSE_OBELISK_PLACE_COST_MINERALS}</span>
      </button>
    </div>
    </div>
  `;
  return hud;
}

function isIdleUnitForHud(u: SimUnit): boolean {
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

/** Counts idle locals by kind — keep in sync with PrototypeView idle cycling filters. */
function countLocalIdleUnits(state: GameState, pid: string, kind: "neutral" | "military"): number {
  let n = 0;
  for (const u of state.units) {
    if (u.playerId !== pid || u.hp <= 0) continue;
    if (kind === "neutral") {
      if (u.kind !== "N") continue;
    } else if (u.kind === "N") {
      continue;
    }
    if (!isIdleUnitForHud(u)) continue;
    n++;
  }
  return n;
}

function populationCounts(
  state: GameState,
  localPlayerId: string,
  rivalPlayerId: string | null
): { yours: number; enemy: number } {
  let yours = 0;
  let enemy = 0;
  for (const u of state.units) {
    if (u.playerId === localPlayerId) yours += 1;
    else if (rivalPlayerId !== null && u.playerId === rivalPlayerId) enemy += 1;
    else if (rivalPlayerId === null && u.playerId !== localPlayerId) enemy += 1;
  }
  return { yours, enemy };
}

function inspectSideLabel(playerId: string, localPlayerId: string, rivalPlayerId: string | null): string {
  if (playerId === localPlayerId) return "Yours";
  if (rivalPlayerId !== null && playerId === rivalPlayerId) return "Opponent";
  return playerId;
}

function runGame(appEl: HTMLElement): void {
  // Jam build ships real-time only. Turn mode exists in code, but PvP authority and CPU opponent
  // are tuned for real-time; forcing this avoids mismatched server/client simulations.
  const selectedMode = "real_time";
  const query = new URLSearchParams(window.location.search);
  const clientSetup = parseClientMatchSetupFromLocationSearch(window.location.search);
  const boot = bootstrapGame(selectedMode, clientSetup);
  const localPlayerId = boot.session.clientSetup.localPlayerId;
  const rivalPlayerId = otherSkirmishPlayerId(localPlayerId);
  const matchAnalytics = new MatchAnalyticsRecorder();
  const pvpWsUrl =
    clientSetup.kind === "player_vs_player" ? resolveMatchWebSocketUrl(window.location.search) : null;
  const useAuthoritativeNet = pvpWsUrl !== null;
  if (clientSetup.kind === "player_vs_player" && !useAuthoritativeNet) {
    appEl.innerHTML = `
      <div class="match-start-overlay" style="display:flex">
        <div class="match-start-count match-start-count--net-message" style="font-size:18px; max-width: 760px; line-height:1.5; text-align:center;">
          PvP requires an authoritative match server URL.<br/>
          Open via launcher and use its generated join link, or add <code>?matchWs=ws://host:8788</code> (or <code>wss://</code> on HTTPS).
        </div>
      </div>
    `;
    return;
  }

  const hudCluster = document.createElement("div");
  hudCluster.className = "hud-cluster moonrise-build-bank";
  const hudRoot = createHUD();
  const hudBuildMenuEl = hudRoot.querySelector<HTMLElement>("#hudBuildMenu");
  if (hudBuildMenuEl) {
    hudBuildMenuEl.remove();
    hudBuildMenuEl.classList.add("hud-build-menu--detached");
  }
  const topStatsPanel = document.createElement("div");
  topStatsPanel.className = "hud-top-stats moonrise-console-strip";
  topStatsPanel.appendChild(hudRoot);
  appEl.appendChild(topStatsPanel);
  if (hudBuildMenuEl) hudCluster.appendChild(hudBuildMenuEl);
  const placeBuildSlotEls = PLACE_SPECS.map((spec) =>
    (hudBuildMenuEl ?? hudRoot).querySelector<HTMLButtonElement>(`#${spec.id}`)
  );

  const unitPanel = document.createElement("aside");
  unitPanel.id = "hudUnitPanel";
  unitPanel.className = "hud-unit-panel moonrise-subpanel";
  unitPanel.innerHTML = `
    <div class="hud-building-kicker" id="hudUnitKicker">Command readout</div>
    <div class="hud-building-title" id="hudUnitTitle">No Selection</div>
    <div class="hud-unit-body" id="hudUnitBody">Double Tap H to go back to Command Center.</div>
  `;
  hudCluster.appendChild(unitPanel);

  const buildingPanel = document.createElement("aside");
  buildingPanel.id = "hudBuildingPanel";
  buildingPanel.className = "hud-building-panel moonrise-subpanel";
  buildingPanel.hidden = true;
  buildingPanel.innerHTML = `
    <div class="hud-building-kicker">Selected site</div>
    <div class="hud-building-title" id="hudBuildingTitle">—</div>
    <p class="hud-building-tip" id="hudBuildingTip"></p>
    <div class="hud-building-status" id="hudBuildingStatus"></div>
    <div class="hud-building-hp" id="hudBuildingHp"></div>
    <div class="hud-building-meta" id="hudBuildingMeta"></div>
    <div class="hud-building-queue" id="hudBuildingQueue"></div>
    <button type="button" class="hud-building-train" id="hudBuildingTrain"></button>
  `;
  hudCluster.appendChild(buildingPanel);
  appEl.appendChild(hudCluster);

  let inspectHit: WorldInspectHit | null = null;

  const matchEndOverlay = document.createElement("div");
  matchEndOverlay.className = "match-end-overlay";
  matchEndOverlay.hidden = true;
  matchEndOverlay.innerHTML = `
    <div class="match-end-card" role="dialog" aria-modal="true" aria-labelledby="matchEndTitle">
      <div class="match-end-title" id="matchEndTitle">VICTORY</div>
      <div class="match-end-actions">
        <button type="button" class="match-end-export" title="Download JSON (commands, combat / RPS, economy events) for analysis">Export match log</button>
        <button type="button" class="match-end-restart">Restart</button>
      </div>
    </div>
  `;
  appEl.appendChild(matchEndOverlay);

  const skipMatchCountdown = readSkipMatchCountdownFromSearch(window.location.search);
  const matchStartOverlay = document.createElement("div");
  matchStartOverlay.className = "match-start-overlay";
  matchStartOverlay.id = "matchStartOverlay";
  const skipCountdownForSession = skipMatchCountdown && !useAuthoritativeNet;
  matchStartOverlay.hidden = skipCountdownForSession;
  matchStartOverlay.innerHTML = `
    <div class="match-start-panel">
      <div class="match-start-count" id="matchStartCount" aria-live="assertive">5</div>
      <button type="button" class="match-start-menu" id="matchStartMenu" hidden>Back to Main Menu</button>
    </div>
  `;
  appEl.appendChild(matchStartOverlay);
  const matchStartCountEl = matchStartOverlay.querySelector<HTMLElement>("#matchStartCount");
  const matchStartMenuBtn = matchStartOverlay.querySelector<HTMLButtonElement>("#matchStartMenu");
  matchStartMenuBtn?.addEventListener("click", () => {
    const path = window.location.pathname || "/";
    history.replaceState(null, "", path);
    window.location.reload();
  });
  if (useAuthoritativeNet) {
    if (matchStartCountEl) {
      matchStartCountEl.classList.add("match-start-count--net-message");
      matchStartCountEl.textContent = "Connecting to match server…";
    }
  }

  let matchLive = skipCountdownForSession;
  let mobileCommandMode = false;
  const mobileCommandBtn = document.createElement("button");
  mobileCommandBtn.type = "button";
  mobileCommandBtn.className = "mobile-command-btn";
  mobileCommandBtn.textContent = "Command";
  mobileCommandBtn.title = "Mobile: tap Command, then tap the moon/minimap destination to move, gather, attack, or set rally.";
  mobileCommandBtn.addEventListener("click", () => {
    mobileCommandMode = !mobileCommandMode;
    mobileCommandBtn.classList.toggle("mobile-command-btn--armed", mobileCommandMode);
    mobileCommandBtn.textContent = mobileCommandMode ? "Tap Target" : "Command";
  });
  hudRoot.querySelector<HTMLElement>("#hudCommandAction")?.appendChild(mobileCommandBtn);
  /** Set when the render loop starts so load/setup time does not eat the countdown. */
  let matchStartAtMs = 0;

  const inspectPanelEl = document.createElement("aside");
  inspectPanelEl.id = "inspectPanel";
  inspectPanelEl.className = "inspect-panel";
  inspectPanelEl.setAttribute("aria-label", "Inspect");
  inspectPanelEl.hidden = true;
  inspectPanelEl.innerHTML = `
    <button type="button" class="inspect-panel-toggle" id="inspectToggle" aria-label="Minimize inspect panel" aria-expanded="true">
      <span aria-hidden="true"></span>
    </button>
    <div class="inspect-panel-content">
      <div class="inspect-panel-kicker">Inspect</div>
      <div class="inspect-panel-title" id="inspectTitle"></div>
      <div class="inspect-panel-hp" id="inspectHp" hidden></div>
      <div class="inspect-panel-body" id="inspectBody"></div>
    </div>
  `;
  appEl.appendChild(inspectPanelEl);
  let inspectPanelCollapsed = false;
  const inspectToggle = inspectPanelEl.querySelector<HTMLButtonElement>("#inspectToggle");
  function setInspectPanelCollapsed(collapsed: boolean): void {
    inspectPanelCollapsed = collapsed;
    inspectPanelEl.classList.toggle("inspect-panel--collapsed", collapsed);
    inspectToggle?.setAttribute("aria-expanded", String(!collapsed));
    inspectToggle?.setAttribute("aria-label", collapsed ? "Open inspect panel" : "Minimize inspect panel");
  }
  inspectToggle?.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
  });
  inspectToggle?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setInspectPanelCollapsed(!inspectPanelCollapsed);
  });

  let pendingPlaceKind: PlaceableStructureKind | null = null;

  function syncBuildPlacementButtons(): void {
    for (let i = 0; i < PLACE_SPECS.length; i += 1) {
      const kind = PLACE_SPECS[i]!.kind;
      placeBuildSlotEls[i]?.classList.toggle("hud-build-slot--active", pendingPlaceKind === kind);
    }
  }

  function togglePlaceKind(kind: PlaceableStructureKind): void {
    pendingPlaceKind = pendingPlaceKind === kind ? null : kind;
    syncBuildPlacementButtons();
  }

  function resetPlacementMode(): void {
    pendingPlaceKind = null;
    syncBuildPlacementButtons();
  }

  for (let i = 0; i < PLACE_SPECS.length; i += 1) {
    const kind = PLACE_SPECS[i]!.kind;
    placeBuildSlotEls[i]?.addEventListener("click", () => togglePlaceKind(kind));
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Escape" || ev.repeat) return;
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    resetPlacementMode();
  });

  const controlDock = document.createElement("div");
  controlDock.id = "controlGroupsDock";
  controlDock.className = "control-groups-dock moonrise-switch-bank";
  controlDock.setAttribute("aria-label", "Control groups");
  appEl.appendChild(controlDock);
  let controlDockSignature = "";

  const missionHelpPanel = document.createElement("aside");
  missionHelpPanel.className = "mission-help-panel mission-help-panel--collapsed";
  missionHelpPanel.setAttribute("aria-label", "Mission notes");
  missionHelpPanel.innerHTML = `
    <button type="button" class="mission-help-toggle" aria-expanded="false">
      <span class="mission-help-kicker">Mission notes</span>
      <span class="mission-help-action">Show</span>
    </button>
    <p class="mission-help-copy">
      Select a Neutral (N) miner to open the build menu — only they can place new structures.
      Minerals from N on ore nodes; energy from Solar Arrays. Train N from Core (C). Stop with X.
      Double-tap , or . to focus idle units. Ctrl+1–9 saves the current selection (units and buildings);
      number keys recall. Sites can be placed on explored ground with much freer layout spacing.
      Idle N next to a site finishes construction.
    </p>
  `;
  const rightHudStack = document.createElement("div");
  rightHudStack.className = "right-hud-stack moonrise-right-console";
  rightHudStack.appendChild(missionHelpPanel);
  const missionHelpToggle = missionHelpPanel.querySelector<HTMLButtonElement>(".mission-help-toggle");
  const missionHelpAction = missionHelpPanel.querySelector<HTMLElement>(".mission-help-action");
  missionHelpToggle?.addEventListener("click", () => {
    const collapsed = missionHelpPanel.classList.toggle("mission-help-panel--collapsed");
    missionHelpToggle.setAttribute("aria-expanded", String(!collapsed));
    if (missionHelpAction) missionHelpAction.textContent = collapsed ? "Show" : "Hide";
  });

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance"
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = false;
  appEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  setupMoonAtmosphere(scene, renderer, { voidOnly: false });

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1800);
  camera.position.set(12, 14, 20);
  camera.lookAt(0, 0, 0);
  scene.add(camera);

  installMoonReferenceExporter(scene);
  const showMoonDebugBanner = query.get("moonDebug") === "1";
  const moonDebugBanner = document.createElement("div");
  moonDebugBanner.style.position = "fixed";
  moonDebugBanner.style.top = "10px";
  moonDebugBanner.style.right = "10px";
  moonDebugBanner.style.zIndex = "1200";
  moonDebugBanner.style.padding = "6px 9px";
  moonDebugBanner.style.borderRadius = "6px";
  moonDebugBanner.style.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  moonDebugBanner.style.color = "#d6e8ff";
  moonDebugBanner.style.background = "rgba(6, 12, 22, 0.78)";
  moonDebugBanner.style.border = "1px solid rgba(120, 165, 230, 0.35)";
  moonDebugBanner.style.pointerEvents = "none";
  moonDebugBanner.textContent = "Moon: loading...";
  if (showMoonDebugBanner) appEl.appendChild(moonDebugBanner);

  const lightA = new THREE.DirectionalLight(0xfff2dc, 1.18);
  scene.add(lightA);
  scene.add(lightA.target);
  lightA.position.copy(MOON_SUN_DIRECTION_WORLD).multiplyScalar(220);
  lightA.target.position.set(0, 0, 0);
  lightA.castShadow = false;

  const lightB = new THREE.AmbientLight(0xe8e0f8, 1.04);
  scene.add(lightB);

  const hemi = new THREE.HemisphereLight(0xd8e8ff, 0xb8a8c8, 0.48);
  scene.add(hemi);

  const cameraFill = new THREE.PointLight(0xfff4ff, 1.05, 0, 1.25);
  cameraFill.castShadow = false;
  cameraFill.position.set(0, 0, 0);
  camera.add(cameraFill);

  let adminPanelOpen = false;

  let gameState = boot.initialState;

  type NetTickPacket = {
    state: GameState;
    events: SimulationEvent[];
    feedback: UiFeedbackEvent[];
    roomReady: boolean;
    seats?: { p1?: boolean; p2?: boolean };
  };
  const netInbox: NetTickPacket[] = [];
  let netAuthority: ReturnType<typeof connectMatchAuthorityWs> | null = null;
  let netAnalyticsStarted = false;
  let netFatalError: string | null = null;
  let netRoomReady = !useAuthoritativeNet;
  let netSeatStatus: { p1?: boolean; p2?: boolean } = {};

  function beginMatchAnalytics(state: GameState): void {
    matchAnalytics.begin({
      schemaVersion: MATCH_ANALYTICS_SCHEMA_VERSION,
      matchId: state.matchId,
      modeId: state.modeId,
      matchKind: boot.session.clientSetup.kind,
      localPlayerId,
      rivalPlayerId,
      sessionStartedAtMs: Date.now(),
      tickRateHz: state.tickRateHz
    });
  }

  function exportMatchAnalyticsLog(): void {
    const mid = gameState.matchId.replace(/[^a-z0-9-]/gi, "").slice(0, 16);
    const v = gameState.victorPlayerId;
    const suffix =
      v === localPlayerId ? "win" : v !== null && v !== localPlayerId ? "lose" : "ongoing";
    matchAnalytics.downloadJson(`webrts-analytics-${mid}-${suffix}-${Date.now()}`);
  }

  function submitCommandWithLog(cmd: GameCommand): void {
    if (!matchLive) return;
    matchAnalytics.recordCommand(
      cmd,
      resolveAnalyticsActor(cmd.playerId, localPlayerId, rivalPlayerId),
      gameState.tick
    );
    if (useAuthoritativeNet && netAuthority) {
      netAuthority.sendGameCommand(cmd.type, cmd.payload);
    } else {
      boot.session.mode.submitCommand(cmd);
    }
  }

  let view!: PrototypeView;

  function focusCameraOnLocalHome(state: GameState): void {
    const home = state.structures.find(
      (s) => s.playerId === localPlayerId && s.kind === "home" && s.hp > 0
    );
    if (home) {
      const hc = structureCenter(home);
      view.resetMoonSpin();
      view.focusHomeOverviewOnWorldXZ(hc.x, hc.z);
    }
  }

  const moonPresentation = new MoonPresentationComposer(renderer, scene, camera);
  moonPresentation.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());

  view = new PrototypeView(scene, camera, renderer, {
    localPlayerId,
    terrain: clientSetup.terrain ?? "sphere",
    moonTextureUrl: defaultMoonTextureUrl(),
    submitCommand: submitCommandWithLog,
    getPendingPlaceStructureKind: () => pendingPlaceKind,
    getFogOfWarSuspended: () => adminPanelOpen,
    onInspect: (h) => {
      inspectHit = h;
    },
    consumeMobileCommandMode: () => {
      if (!mobileCommandMode) return false;
      mobileCommandMode = false;
      return true;
    },
    onMobileCommandConsumed: () => {
      mobileCommandBtn.classList.remove("mobile-command-btn--armed");
      mobileCommandBtn.textContent = "Command";
    },
    focusOnLocalHome: () => focusCameraOnLocalHome(gameState)
  });

  const moonSpaceCosmos = scene.getObjectByName("moonSpaceCosmos");
  if (moonSpaceCosmos) {
    view.attachCosmosToMoonSpin(moonSpaceCosmos);
  }

  const feedbackSounds = createWebAudioFeedbackSounds();

  const moonPresentationVec = (v: THREE.Vector3) => view.applyMoonPresentationToSurfacePoint(v);
  const damageOverlay = new DamageNumberOverlay(appEl, camera, renderer, {
    localPlayerIdForGatherPops: localPlayerId,
    applySpherePresentation: moonPresentationVec
  });
  const hitFlashOverlay = new HitFlashOverlay(appEl, camera, renderer, moonPresentationVec);

  resetComputerOpponentState();
  if (clientSetup.kind === "player_vs_computer") {
    initComputerOpponentPersonality(gameState.matchId);
  }
  if (!useAuthoritativeNet) {
    beginMatchAnalytics(gameState);
    view.syncFromState(gameState);
    focusCameraOnLocalHome(gameState);
  }

  const nameplateOverlay = new SelectionNameplateOverlay(
    appEl,
    camera,
    renderer,
    localPlayerId,
    moonPresentationVec
  );
  if (!useAuthoritativeNet) {
    nameplateOverlay.syncFromState(gameState);
  }

  if (useAuthoritativeNet && pvpWsUrl) {
    const seat = localPlayerId === "p2" ? "p2" : "p1";
    const room = query.get("room")?.trim() || undefined;
    netAuthority = connectMatchAuthorityWs({
      url: pvpWsUrl,
      seat,
      room,
      onCommandsReady: () => {},
      onPush: (packet) => {
        netInbox.push({
          state: packet.state != null ? reviveGameStateFromNetwork(packet.state) : gameState,
          events: (packet.events as SimulationEvent[]) ?? [],
          feedback: (packet.feedback as UiFeedbackEvent[]) ?? [],
          roomReady: packet.roomReady === true,
          seats: packet.seats
        });
        if (netInbox.length > MAX_NET_INBOX_PACKETS) {
          netInbox.splice(0, netInbox.length - MAX_NET_INBOX_PACKETS);
        }
      },
      onError: (reason) => {
        netFatalError = reason;
      }
    });
  }

  const hudMinimap = createHudMinimap({
    getState: () => gameState,
    localPlayerId,
    rivalPlayerId,
    issueRmbAtWorld: (x, z, shift, ctrl) => view.issueRmbAtWorld(x, z, shift, ctrl),
    focusCameraOnWorldXZ: (x, z) => view.focusCameraOnWorldXZ(x, z),
    getCameraBounds: () => view.minimapCameraBounds(),
    getSphereFrame: () => view.minimapSphereFrame(),
    mirrorX: false,
    getMinimapFog: () => ({
      enabled: view.minimapFogOfWarEnabled(),
      atWorld: (wx, wz) => view.minimapFogAtWorld(wx, wz)
    }),
    getMoonSpinQuaternion: () => view.getMoonSpinQuaternion(),
    getViewFrame: () => view.getMinimapViewFrame(),
    applyMoonSpinFromScreenDelta: (dx, dy) => view.applyMoonSpinFromScreenDelta(dx, dy),
    resetMoonSpin: () => view.resetMoonSpin()
  });
  const minimapPopulation = document.createElement("div");
  minimapPopulation.className = "hud-minimap-population";
  const localPopBlock = hudRoot.querySelector<HTMLElement>(".hud-pop:not(.hud-pop--enemy)");
  if (localPopBlock) minimapPopulation.appendChild(localPopBlock);
  hudMinimap.element.appendChild(minimapPopulation);
  rightHudStack.appendChild(hudMinimap.element);
  appEl.appendChild(rightHudStack);

  const matchEndTitle = matchEndOverlay.querySelector(".match-end-title") as HTMLElement | null;
  matchEndOverlay.querySelector(".match-end-export")?.addEventListener("click", () => {
    exportMatchAnalyticsLog();
  });
  matchEndOverlay.querySelector(".match-end-restart")?.addEventListener("click", () => {
    resetMatchToInitial();
  });

  function resetMatchToInitial(): void {
    if (useAuthoritativeNet) {
      window.location.reload();
      return;
    }
    resetComputerOpponentState();
    gameState = boot.session.resetMatch();
    if (clientSetup.kind === "player_vs_computer") {
      initComputerOpponentPersonality(gameState.matchId);
    }
    resetPlacementMode();
    view.clearControlGroups();
    view.syncFromState(gameState);
    focusCameraOnLocalHome(gameState);
    nameplateOverlay.syncFromState(gameState);
    beginMatchAnalytics(gameState);
    inspectHit = null;
    matchEndOverlay.hidden = true;
    if (skipMatchCountdown) {
      matchLive = true;
      matchStartOverlay.hidden = true;
    } else {
      matchLive = false;
      matchStartAtMs = performance.now();
      matchStartOverlay.hidden = false;
      if (matchStartCountEl) matchStartCountEl.textContent = String(MATCH_COUNTDOWN_SECONDS);
    }
    inspectPanelEl.hidden = true;
    const it = document.getElementById("inspectTitle");
    const ib = document.getElementById("inspectBody");
    if (it) it.textContent = "";
    if (ib) ib.textContent = "";
  }

  mountRuntimeTuningPanel(appEl, {
    getGameState: () => gameState,
    setGameState: (s) => {
      gameState = s;
    },
    onVisibilityChange: (open) => {
      adminPanelOpen = open;
    },
    resetMatchToInitial,
    matchAnalytics: {
      getStats: () => matchAnalytics.stats(),
      exportMatchLog: () => exportMatchAnalyticsLog(),
      clear: () => matchAnalytics.clear()
    }
  });

  const hudPopYours = document.getElementById("hudPopYours");
  const hudPopEnemy = document.getElementById("hudPopEnemy");
  const hudPopCap = document.getElementById("hudPopCap");
  const hudSelected = document.getElementById("hudSelected");
  const hudFormation = document.getElementById("hudFormation");
  const hudIdleNeutralBtn = document.getElementById("hudIdleNeutralBtn") as HTMLButtonElement | null;
  const hudIdleMilitaryBtn = document.getElementById("hudIdleMilitaryBtn") as HTMLButtonElement | null;
  const hudIdleNeutralCount = document.getElementById("hudIdleNeutralCount");
  const hudIdleMilitaryCount = document.getElementById("hudIdleMilitaryCount");
  const hudOutcome = document.getElementById("hudOutcome");
  const hudEnergy = document.getElementById("hudEnergy");
  const hudMinerals = document.getElementById("hudMinerals");
  const hudUnitPanel = document.getElementById("hudUnitPanel") as HTMLElement | null;
  const hudUnitTitle = document.getElementById("hudUnitTitle");
  const hudUnitBody = document.getElementById("hudUnitBody");
  const hudBuildingPanel = document.getElementById("hudBuildingPanel") as HTMLElement | null;
  const hudBuildingTitle = document.getElementById("hudBuildingTitle");
  const hudBuildingTip = document.getElementById("hudBuildingTip");
  const hudBuildingStatus = document.getElementById("hudBuildingStatus");
  const hudBuildingHp = document.getElementById("hudBuildingHp");
  const hudBuildingMeta = document.getElementById("hudBuildingMeta");
  const hudBuildingQueue = document.getElementById("hudBuildingQueue");
  const hudBuildingTrain = document.getElementById("hudBuildingTrain") as HTMLButtonElement | null;
  hudIdleNeutralBtn?.addEventListener("click", () => view.selectNextIdleNeutralUnit());
  hudIdleMilitaryBtn?.addEventListener("click", () => view.selectNextIdleMilitaryUnit());
  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const buildShortcut = PLACE_SPECS.find((spec) => spec.code === ev.code);
    if (buildShortcut) {
      const slot = placeBuildSlotEls.find((el) => el?.id === buildShortcut.id);
      if (slot && !slot.disabled) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        togglePlaceKind(buildShortcut.kind);
      }
      return;
    }
    if (ev.code === "Comma") {
      ev.preventDefault();
      view.selectNextIdleNeutralUnit(view.noteIdleShortcutTap("neutral"));
    } else if (ev.code === "Period") {
      ev.preventDefault();
      view.selectNextIdleMilitaryUnit(view.noteIdleShortcutTap("military"));
    }
  }, { capture: true });
  const clock = new THREE.Clock();

  hudBuildingTrain?.addEventListener("click", () => {
    const sid = gameState.structureSelections[localPlayerId]?.[0];
    if (!sid || gameState.victorPlayerId) return;
    submitCommandWithLog(
      createGameCommand(localPlayerId, "queue_structure_train", { structureId: sid })
    );
  });

  function updateUnitPanel(state: GameState): void {
    if (!hudUnitPanel || !hudUnitTitle || !hudUnitBody) return;
    const ids = state.selections[localPlayerId] ?? [];
    if (ids.length === 0) {
      if ((state.structureSelections[localPlayerId] ?? []).length > 0) {
        hudUnitPanel.hidden = true;
        return;
      }
      hudUnitPanel.hidden = false;
      hudUnitTitle.textContent = "No Selection";
      hudUnitBody.textContent = "Double Tap H to go back to Command Center.";
      return;
    }
    hudUnitPanel.hidden = false;
    const units = ids
      .map((id) => state.units.find((u) => u.id === id))
      .filter((u): u is (typeof state.units)[number] => !!u && u.hp > 0);
    if (units.length === 0) {
      hudUnitPanel.hidden = true;
      return;
    }
    if (units.length === 1) {
      const u = units[0]!;
      hudUnitTitle.textContent = unitNameplateLabel(u.kind);
    } else {
      hudUnitTitle.textContent = `${units.length} units`;
    }
    hudUnitBody.textContent = formatUnitSelectionCardBody(state, ids);
  }

  function updateBuildingPanel(state: GameState): void {
    if (
      !hudBuildingPanel ||
      !hudBuildingTitle ||
      !hudBuildingTip ||
      !hudBuildingStatus ||
      !hudBuildingHp ||
      !hudBuildingMeta ||
      !hudBuildingQueue ||
      !hudBuildingTrain
    ) {
      return;
    }
    const sid = state.structureSelections[localPlayerId]?.[0];
    if (!sid) {
      hudBuildingPanel.hidden = true;
      hudCluster.classList.remove("hud-cluster--selection-panel-visible");
      return;
    }
    const st = state.structures.find((s) => s.id === sid);
    if (!st) {
      hudBuildingPanel.hidden = true;
      hudCluster.classList.remove("hud-cluster--selection-panel-visible");
      return;
    }
    hudBuildingPanel.hidden = false;
    hudCluster.classList.add("hud-cluster--selection-panel-visible");
    hudBuildingTitle.textContent = structureDisplayName(st.kind);
    const tip = structureProductionTooltip(st.kind);
    hudBuildingTip.title = tip;
    hudBuildingStatus.textContent = formatStructureStatusLine(st);
    hudBuildingHp.textContent = `HP ${Math.round(st.hp)} / ${st.maxHp}`;
    const metaBits: string[] = [];
    const trainSum = formatStructureTrainSummary(st);
    if (trainSum) metaBits.push(trainSum);
    const passive = formatStructurePassiveLine(st);
    if (passive) metaBits.push(passive);
    hudBuildingMeta.textContent = metaBits.join("\n");
    hudBuildingMeta.hidden = metaBits.length === 0;
    if (structureProducesKind(st) !== null && isStructureBuilt(st)) {
      hudBuildingQueue.textContent = formatStructureProductionLine(st);
    } else if (st.buildRemainingSec > 0) {
      hudBuildingQueue.textContent = "Production: offline until construction finishes.";
    } else {
      hudBuildingQueue.textContent = "Production: this site does not train units.";
    }
    const canTrain = structureProducesKind(st) !== null;
    const rallyHint =
      canTrain && st.buildRemainingSec <= 0 ? " Right-click open ground to set a rally for new units." : "";
    hudBuildingTip.textContent = tip + rallyHint;
    hudBuildingTrain.style.display = canTrain ? "block" : "none";
    const pl = state.players.find((p) => p.id === localPlayerId);
    const trainKind = structureProducesKind(st);
    const trainCost = trainKind ? resourcesForTrainKind(trainKind) : null;
    const canAfford =
      !!pl &&
      !!trainCost &&
      pl.resources.energy >= trainCost.energy &&
      pl.resources.minerals >= trainCost.minerals;
    const shownCost = trainCost ?? { energy: 0, minerals: 0 };
    hudBuildingTrain.textContent = `Train unit (${shownCost.energy} En + ${shownCost.minerals} Min) · C`;
    hudBuildingTrain.disabled =
      !matchLive ||
      !canTrain ||
      !canAfford ||
      state.victorPlayerId !== null ||
      st.hp <= 0 ||
      st.buildRemainingSec > 0;
  }

  function updateInspectPanel(state: GameState): void {
    inspectPanelEl.hidden = true;
    inspectPanelEl.style.visibility = "hidden";
    if (!inspectHit) {
      return;
    }

    const hasSelection =
      (state.selections[localPlayerId] ?? []).length > 0 ||
      (state.structureSelections[localPlayerId] ?? []).length > 0;
    if (hasSelection) return;

    if (!hudUnitPanel || !hudUnitTitle || !hudUnitBody) return;

    const h = inspectHit;
    if (h.kind === "field") {
      const f = state.resourceFields.find((x) => x.id === h.id);
      if (!f || (f.reserve !== null && f.reserve <= 0)) {
        inspectHit = null;
        return;
      }
      hudUnitPanel.hidden = false;
      hudBuildingPanel?.setAttribute("hidden", "");
      hudUnitTitle.textContent = "Mineral deposit";
      hudUnitBody.textContent =
        f.reserve === null ? "Inspect\nOre remaining: unlimited" : `Inspect\nOre remaining: ${Math.floor(f.reserve)}`;
      return;
    }
    if (h.kind === "structure") {
      const st = state.structures.find((s) => s.id === h.id);
      if (!st || st.hp <= 0) {
        inspectHit = null;
        return;
      }
      const side = inspectSideLabel(st.playerId, localPlayerId, rivalPlayerId);
      const lines = [side, formatStructureStatusLine(st), structureProductionTooltip(st.kind)];
      const trainSum = formatStructureTrainSummary(st);
      if (trainSum && st.kind !== "home") lines.push(trainSum);
      const passive = formatStructurePassiveLine(st);
      if (passive) lines.push(passive);
      if (structureProducesKind(st) !== null && isStructureBuilt(st)) {
        lines.push(formatStructureProductionLine(st));
      }
      hudUnitPanel.hidden = false;
      hudBuildingPanel?.setAttribute("hidden", "");
      hudUnitTitle.textContent = structureDisplayName(st.kind);
      hudUnitBody.textContent = [`Inspect · HP ${Math.round(st.hp)} / ${st.maxHp}`, ...lines].join("\n");
      return;
    }
    const u = state.units.find((x) => x.id === h.id);
    if (!u || u.hp <= 0) {
      inspectHit = null;
      return;
    }
    const side = inspectSideLabel(u.playerId, localPlayerId, rivalPlayerId);
    const maxHp = getUnitMaxHp(u.kind);
    hudUnitPanel.hidden = false;
    hudBuildingPanel?.setAttribute("hidden", "");
    hudUnitTitle.textContent = unitNameplateLabel(u.kind);
    hudUnitBody.textContent = [`Inspect · HP ${Math.round(u.hp)} / ${maxHp}`, side, formatUnitActivityLine(u, state)].join("\n");
  }

  function formatRoomWaitMessage(): string {
    const host = netSeatStatus.p1 ? "P1 online" : "P1 waiting";
    const guest = netSeatStatus.p2 ? "P2 online" : "P2 waiting";
    return `Waiting for opponent… ${host} · ${guest}`;
  }

  function processCombatVisualEvents(events: readonly SimulationEvent[]): void {
    for (const ev of events) {
      if (ev.type !== "damage_dealt") continue;
      hitFlashOverlay.spawn(ev.position.x, ev.position.y, ev.position.z);
      if (ev.attackClass === "ranged") {
        const commandCoreBattery =
          typeof ev.attackerUnitId === "string" && ev.attackerUnitId.startsWith("home-defense:");
        const obeliskBattery =
          typeof ev.attackerUnitId === "string" && ev.attackerUnitId.startsWith("obelisk-defense:");
        view.spawnProjectileTrace(
          ev.attackerPosition,
          ev.position,
          commandCoreBattery || obeliskBattery
            ? {
                radius: obeliskBattery ? 0.42 : 0.52,
                maxAge: obeliskBattery ? 0.46 : 0.38,
                color: obeliskBattery ? 0x9b7cff : 0xffc266,
                emissive: obeliskBattery ? 0x5f3dff : 0xff9419,
                emissiveIntensity: obeliskBattery ? 1.75 : 1.45,
                startLift: obeliskBattery ? 0.72 : 0.62,
                endLift: 0.55
              }
            : undefined
        );
      }
    }
  }

  function refreshControlGroupDock(): void {
    const slots = view.getControlGroupsHudSlots();
    const sig = slots.map(({ digit, count, active }) => `${digit}:${count}:${active ? 1 : 0}`).join("|");
    if (sig === controlDockSignature) return;
    controlDockSignature = sig;
    controlDock.replaceChildren(
      ...slots.map(({ digit, count, active }) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = `control-group-chip${count > 0 ? " control-group-chip--filled" : ""}${
          active ? " control-group-chip--active" : ""
        }`;
        el.disabled = count === 0;
        el.title = `Group ${digit} (${count} items) — Ctrl+${digit} save selection (units+structures), ${digit} recall`;
        el.innerHTML = `<span class="control-group-chip-digit">${digit}</span><span class="control-group-chip-count">${count > 0 ? count : "—"}</span>`;
        el.addEventListener("click", () => view.recallControlGroup(digit));
        return el;
      })
    );
  }

  function tick(): void {
    const rawDeltaSeconds = clock.getDelta();
    const deltaSeconds =
      matchLive && !useAuthoritativeNet
        ? Math.min(rawDeltaSeconds, 2)
        : Math.min(rawDeltaSeconds, 0.08);
    try {
      const setup = boot.session.clientSetup;

      if (!matchLive) {
        if (useAuthoritativeNet) {
          if (netFatalError && matchStartCountEl) {
            matchStartCountEl.classList.add("match-start-count--net-message");
            matchStartCountEl.textContent = netFatalError;
          } else if (matchStartCountEl) {
            matchStartCountEl.classList.add("match-start-count--net-message");
            matchStartCountEl.textContent = netRoomReady ? "Starting match…" : formatRoomWaitMessage();
          }
          if (matchStartMenuBtn) matchStartMenuBtn.hidden = netRoomReady;
        } else {
          const elapsedSec = (performance.now() - matchStartAtMs) / 1000;
          if (elapsedSec < MATCH_COUNTDOWN_SECONDS) {
            const n = Math.max(1, MATCH_COUNTDOWN_SECONDS - Math.floor(elapsedSec));
            if (matchStartCountEl) matchStartCountEl.textContent = String(n);
          } else if (elapsedSec < MATCH_COUNTDOWN_SECONDS + MATCH_BEGIN_FLASH_SEC) {
            if (matchStartCountEl) matchStartCountEl.textContent = "BEGIN!";
          } else {
            matchLive = true;
            matchStartOverlay.hidden = true;
            if (matchStartMenuBtn) matchStartMenuBtn.hidden = true;
          }
        }
      }

    if (useAuthoritativeNet && netAuthority?.canSendCommands && netInbox.length > 0) {
      const batch = netInbox.splice(0, netInbox.length);
      for (const p of batch) {
        dispatchUiFeedback(p.feedback, {
          localPlayerId,
          sounds: feedbackSounds,
          visuals: {
            flashResourceField: (fieldId, durationSec) => view.flashResourceField(fieldId, durationSec)
          }
        });
        if (
          p.feedback.some(
            (ev) =>
              ev.kind === "place_structure" &&
              ev.playerId === localPlayerId &&
              ev.status === "ok"
          )
        ) {
          resetPlacementMode();
        }
        damageOverlay.processEvents(p.events);
        processCombatVisualEvents(p.events);
      }
      if (batch.length > 0) {
        const latest = batch[batch.length - 1]!;
        gameState = latest.state;
        netRoomReady = latest.roomReady;
        if (latest.seats) netSeatStatus = latest.seats;
        if (!netRoomReady) {
          matchLive = false;
          matchStartOverlay.hidden = false;
          if (matchStartMenuBtn) matchStartMenuBtn.hidden = false;
          if (matchStartCountEl) {
            matchStartCountEl.classList.add("match-start-count--net-message");
            matchStartCountEl.textContent = formatRoomWaitMessage();
          }
        } else if (!netAnalyticsStarted) {
          beginMatchAnalytics(gameState);
          netAnalyticsStarted = true;
          view.syncFromState(gameState);
          nameplateOverlay.syncFromState(gameState);
          focusCameraOnLocalHome(gameState);
          if (!matchLive) {
            matchLive = true;
            matchStartOverlay.hidden = true;
            if (matchStartMenuBtn) matchStartMenuBtn.hidden = true;
          }
        } else if (!matchLive) {
          matchLive = true;
          matchStartOverlay.hidden = true;
          if (matchStartMenuBtn) matchStartMenuBtn.hidden = true;
        }
        for (const p of batch) {
          if (p.roomReady) matchAnalytics.recordTick(p.state.tick, deltaSeconds, p.events, p.feedback);
        }
      }
    }

    if (matchLive) {
      if (!useAuthoritativeNet && setup.kind === "player_vs_computer" && selectedMode === "real_time") {
        const cpu = otherSkirmishPlayerId(setup.localPlayerId);
        if (cpu) {
          tickComputerOpponent(gameState, submitCommandWithLog, cpu, deltaSeconds);
        }
      }
    }

    const idleTick: SimulationTickResult = { state: gameState, events: [], feedback: [] };
    let tickResult: SimulationTickResult;
    if (matchLive && useAuthoritativeNet) {
      tickResult = { state: gameState, events: [], feedback: [] };
    } else if (matchLive) {
      tickResult = boot.session.mode.update(gameState, deltaSeconds);
    } else {
      tickResult = idleTick;
    }
    gameState = tickResult.state;
    if (matchLive && !useAuthoritativeNet) {
      matchAnalytics.recordTick(gameState.tick, deltaSeconds, tickResult.events, tickResult.feedback);
    }
    if (
      !useAuthoritativeNet &&
      tickResult.feedback.some(
        (ev) =>
          ev.kind === "place_structure" &&
          ev.playerId === localPlayerId &&
          ev.status === "ok"
      )
    ) {
      resetPlacementMode();
    }
    if (!useAuthoritativeNet) {
      dispatchUiFeedback(tickResult.feedback, {
        localPlayerId,
        sounds: feedbackSounds,
        visuals: {
          flashResourceField: (fieldId, durationSec) => view.flashResourceField(fieldId, durationSec)
        }
      });
      damageOverlay.processEvents(tickResult.events);
    }
    damageOverlay.update(deltaSeconds);
    if (!useAuthoritativeNet) {
      processCombatVisualEvents(tickResult.events);
    }
    hitFlashOverlay.update(deltaSeconds);
    view.updateCamera(deltaSeconds);
    view.syncFromState(gameState);
    hudMinimap.draw();
    view.syncAdminRangeOverlays(adminPanelOpen, gameState);
    nameplateOverlay.syncFromState(gameState);
    nameplateOverlay.updatePositions(gameState);

    const { yours, enemy } = populationCounts(gameState, localPlayerId, rivalPlayerId);
    const sel = (gameState.selections[localPlayerId] ?? []).length;
    const structSel = gameState.structureSelections[localPlayerId] ?? [];
    const localPlayerState = gameState.players.find((p) => p.id === localPlayerId);
    if (hudPopYours) hudPopYours.textContent = String(yours);
    if (hudPopEnemy) hudPopEnemy.textContent = String(enemy);
    if (hudPopCap) hudPopCap.textContent = String(POP_CAP_PLACEHOLDER);
    if (hudEnergy && localPlayerState) hudEnergy.textContent = String(Math.floor(localPlayerState.resources.energy));
    if (hudMinerals && localPlayerState)
      hudMinerals.textContent = String(Math.floor(localPlayerState.resources.minerals));
    if (hudSelected) {
      if (structSel.length > 0) {
        const st = gameState.structures.find((s) => s.id === structSel[0]);
        hudSelected.textContent = st ? `Site: ${structureDisplayName(st.kind)}` : "Site";
      } else {
        hudSelected.textContent = `Units ${sel}`;
      }
    }
    if (hudFormation) hudFormation.textContent = `Form ${tuning.formation.active}`;
    const idleNeutralN = countLocalIdleUnits(gameState, localPlayerId, "neutral");
    const idleMilitaryN = countLocalIdleUnits(gameState, localPlayerId, "military");
    if (hudIdleNeutralCount) hudIdleNeutralCount.textContent = String(idleNeutralN);
    if (hudIdleMilitaryCount) hudIdleMilitaryCount.textContent = String(idleMilitaryN);
    updateUnitPanel(gameState);
    updateBuildingPanel(gameState);
    updateInspectPanel(gameState);

    const plLocal = gameState.players.find((p) => p.id === localPlayerId);
    const buildLocked = gameState.victorPlayerId !== null;
    const selUnitIds = gameState.selections[localPlayerId] ?? [];
    const hasNeutralSelected = selUnitIds.some((id) => {
      const u = gameState.units.find((x) => x.id === id);
      return !!u && u.playerId === localPlayerId && u.kind === "N" && u.hp > 0;
    });
    if (hudBuildMenuEl) {
      hudBuildMenuEl.hidden = buildLocked || !hasNeutralSelected;
    }
    if (buildLocked) {
      resetPlacementMode();
    } else if (!hasNeutralSelected) {
      const hasAnyMiner = gameState.units.some(
        (u) => u.playerId === localPlayerId && u.kind === "N" && u.hp > 0
      );
      if (!hasAnyMiner || pendingPlaceKind === null) {
        resetPlacementMode();
      }
    }
    const canUseBuildUi = hasNeutralSelected && !buildLocked;
    for (let i = 0; i < PLACE_SPECS.length; i += 1) {
      const kind = PLACE_SPECS[i]!.kind;
      const { energy, minerals } = resourcesForPlaceStructure(kind);
      const canThis =
        !!plLocal && plLocal.resources.energy >= energy && plLocal.resources.minerals >= minerals;
      const el = placeBuildSlotEls[i];
      if (el) el.disabled = !canUseBuildUi || !canThis;
    }
    if (buildLocked) resetPlacementMode();

    if (gameState.victorPlayerId) {
      const won = gameState.victorPlayerId === localPlayerId;
      matchEndOverlay.hidden = false;
      if (matchEndTitle) {
        matchEndTitle.textContent = won ? "VICTORY" : "DEFEAT";
        matchEndTitle.classList.toggle("match-end-title--win", won);
        matchEndTitle.classList.toggle("match-end-title--lose", !won);
      }
      if (hudOutcome) hudOutcome.hidden = true;
    } else {
      matchEndOverlay.hidden = true;
      if (hudOutcome) {
        hudOutcome.hidden = true;
        hudOutcome.textContent = "";
        hudOutcome.classList.remove("hud-outcome--win", "hud-outcome--lose");
      }
    }
    refreshControlGroupDock();

      moonPresentation.render();
      const moonDbg = (window as unknown as { __moonDebug?: Record<string, unknown> }).__moonDebug;
      if (moonDbg) {
        const loaded = moonDbg["customModelLoaded"] === true;
        const err = moonDbg["customModelError"];
        const texLoaded = moonDbg["customTextureLoaded"] === true;
        const texErr = moonDbg["customTextureError"];
        const req = String(moonDbg["moonModelUrl"] ?? "none");
        if (loaded) {
          moonDebugBanner.style.borderColor = "rgba(80, 210, 120, 0.6)";
          const texInfo = texLoaded ? "tex ok" : texErr ? "tex fail" : "tex pending";
          moonDebugBanner.textContent = `Moon custom loaded (${texInfo}): ${req}`;
        } else if (err) {
          moonDebugBanner.style.borderColor = "rgba(230, 110, 110, 0.72)";
          moonDebugBanner.textContent = `Moon custom failed: ${String(err)}`;
        } else {
          moonDebugBanner.style.borderColor = "rgba(120, 165, 230, 0.35)";
          moonDebugBanner.textContent = `Moon loading: ${req}`;
        }
      }
    } catch (err) {
      console.error("[WebRTS] tick failed (countdown / sim / render)", err);
    } finally {
      requestAnimationFrame(tick);
    }
  }
  if (!skipMatchCountdown) {
    matchStartAtMs = performance.now();
  }
  tick();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    moonPresentation.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  });
}

export function startGame(): void {
  const appEl = document.getElementById("app");
  const launchRoot = document.getElementById("launch-root");
  if (!appEl) return;
  launchRoot?.remove();
  runGame(appEl);
}
