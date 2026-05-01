# WebRTS Progress Log

Last updated: 2026-04-01 (Phase 2 authoritative PvP client + docs)
Project: Moonrise Empire
Studio: Studio Z 3D
Copyright (c) 2026 Studio Z 3D. All rights reserved.

## Vision (Locked)

- Browser-first RTS using Three.js/WebGL.
- Electron desktop build uses the same core codebase.
- Three-civ, three-resource, three-age design with rock-paper-scissors unit balance.
- Security-minded baseline from day one.
- Modular architecture (Parent -> Child) so future game modes can be added without rewriting core logic.

## Current Status

### Step 1 - Project Foundation (Complete)

- Project scaffold created in this folder.
- TypeScript + Vite browser client set up.
- Electron wrapper set up.
- Secure static serving set up with Helmet + CSP.
- Build pipeline validated (`npm run build` succeeds).

### Mode Architecture Baseline (Complete)

- Shared parent simulation layer created.
- Real-time and turn-based mode classes created as child modules.
- Mode factory and bootstrap wiring added.
- URL query originally supported mode selection prototype; jam build now forces real-time to keep PvP/CPU behavior stable:
  - default real-time
  - `?mode=turn` deprecated/ignored for submission build

## Key Files

- `package.json`
- `index.html`
- `vite.config.ts`
- `server/serve.js`
- `electron/main.js`
- `electron/preload.js`
- `src/main.ts`
- `src/game/bootstrap.ts`
- `src/core/types.ts`
- `src/core/state/GameState.ts`
- `src/core/commands/GameCommand.ts`
- `src/core/sim/SimulationEngine.ts`
- `src/core/modes/GameMode.ts`
- `src/core/modes/RealTimeMode.ts`
- `src/core/modes/TurnBasedMode.ts`
- `src/core/modes/ModeFactory.ts`
- `src/core/balance.ts`
- `src/game/prototype.ts` (view + input only)
- `Launch Test.bat`
- `PROGRESS.md`
- `ARCHITECTURE.md`
- `HOSTING_AND_MULTIPLAYER.md` (PvP + Cloudflare-first hosting plan; Phase 2 dev sync implemented)
- `README.md` (setup: `dev` + `match:dev`, env / query params)
- `.env.example` (`VITE_MATCH_WS`, `MATCH_DEV_PORT`)
- `src/vite-env.d.ts` (Vite env typings)
- `src/game/net/*` (match WebSocket client + state revive + URL resolution)

## Important Decisions

- Keep one shared deterministic simulation core for all modes.
- Modes control pacing/input cadence only (not separate balance math).
- Keep security defaults enabled:
  - strict CSP
  - Helmet hardening
  - Electron with `nodeIntegration: false`, `contextIsolation: true`, sandbox enabled
- Vendor the referenced ECS engine locally to avoid git dependency issues in this environment.

## Environment Notes

- `git` was not available on PATH during setup.
- Vendored dependency used:
  - `vendor/three.js-rts-ecs-engine`
- `node-sass` had to be removed from the vendored package dev dependencies to avoid native build/toolchain failure on this machine.

## Next Priorities

1. Extend `SimulationEngine` commands: `gather`, `train`, `attack` (explicit target), `research`, buildings.
2. Add deterministic unit tests for command application + combat (no Three.js in tests).
3. Wire turn-based mode to real planning/resolution phases (command buffer + end turn).
4. Differentiate `attack_move_units` behavior in sim (today it sets flags but movement/combat matches plain move).
5. Optional: `eslint.config.js` for ESLint 9 flat config if CLI `npm run lint` misbehaves on some machines.

## Handoff Notes For Any New Agent

- Do not duplicate combat/resource logic per mode.
- Extend `GameMode` for new modes; keep rules in shared simulation.
- Keep browser and Electron behavior aligned from same build output.
- Preserve secure defaults unless explicitly asked to loosen for local debugging.

## Session Update Protocol

When any session makes progress, append an entry at the bottom of this file using this format:

```md
## Session Log

### YYYY-MM-DD - <short title>
- Goal:
- Changes:
- Validation:
- Decisions:
- Next:
```

Rules:

- Keep entries concise and factual.
- Always include at least one validation step (build, lint, test, or manual check).
- If scope changes, update `Next Priorities` in the same session.
- Do not delete prior logs; append only.

## Session Log

### 2026-03-23 - Foundation + Modular Modes
- Goal: Create secure project scaffold and modular parent/child mode baseline.
- Changes: Added Vite + TypeScript + Three.js app, secure server, Electron wrapper, shared simulation core, and Real-Time/Turn-Based mode modules.
- Validation: `npm install` succeeded after local vendor adjustments; `npm run build` passes; IDE lint check clean.
- Decisions: One shared deterministic simulation core for all game modes; keep secure defaults enabled.
- Next: Implement first shared command set and deterministic tests.

### 2026-03-23 - Core Prototype Loop
- Goal: Move from render smoke-test to interactive gameplay prototype.
- Changes: Replaced placeholder cube with prototype battle scene (map, unit spawn, select, move, auto-combat, RPS multiplier behavior, RTS camera controls).
- Validation: `npm run build` passes; lint check clean on changed files.
- Decisions: Keep visuals minimal while proving command/combat loop behavior.
- Next: Connect prototype unit actions through shared command pipeline in `SimulationEngine`.

### 2026-03-24 - Command pipeline (Step 1 follow-through)
- Goal: Route player input through `GameMode.submitCommand` into `SimulationEngine`; keep view as sync + input only.
- Changes: Added `select_units`, `move_units`, `attack_move_units`, `stop_units`; authoritative `GameState` with `units` + `selections`; `createMatchState` seeds skirmish; `PrototypeView` submits commands; combat/movement in `SimulationEngine.simulateWorld`; `Launch Test.bat` runs `npm run build` before `serve`.
- Validation: `npm run build` succeeds (2026-03-24); IDE lints clean on `src/`.
- Decisions: Single simulation core; clone state per step for predictable updates.
- Next: Tests + economy/build commands + real turn-based phases.

### 2026-03-24 - R/S/P military types, RPS thirds damage, RMB camera + focus fire
- Goal: Align unit code names with Rock–Paper–Scissors (R/S/P), use 2/3 weak damage, add RMB-drag camera and right-click enemy to attack.
- Changes: Renamed kinds to `MilitaryKind` `"R"|"S"|"P"`; `rpsDamageMultiplier` (strong 3/2, weak 2/3); `attack_unit` command + `attackTargetId` chase in sim; `PrototypeView` RMB drag pan vs click; HUD copy updated.
- Validation: `npm run build` succeeds.
- Decisions: No worker units for now — future buildings place without civilians; military test layout unchanged.
- Next: Buildings that produce units/resources; automated sim tests.

### 2026-03-24 - Debug damage numbers (sim events → overlay)
- Goal: Visible hit feedback; keep styling extensible.
- Changes: `SimulationTickResult` + `damage_dealt` events from combat; `DamageNumberOverlay` + `damageNumberConfig.ts` + CSS hooks (`.damage-number`, variants); `GameMode.update` returns tick result; main wires overlay.
- Validation: `npm run build` succeeds.
- Next: Themed variants, crit colors, pooling if counts get high.

### 2026-03-24 - Marquee select + control groups 0–9
- Goal: RTS-style drag box selection; Ctrl+0–9 bind, 0–9 recall (main row + numpad).
- Changes: `PrototypeView` LMB window tracking, `.selection-marquee` overlay, screen-space unit culling; local `controlGroups` arrays; HUD copy updated.
- Validation: `npm run build` succeeds.
- Next: Shift-add to selection; double-tap group to focus camera.

### 2026-03-24 - Nameplates, formations, collision, runtime tuning panel, combat doc
- Goal: Selection labels (`Rock - R` style); squad formations (square/circle/triangle + none); non-stacking via overlap resolve; ranged vs melee clarity (Paper longer range); central tunables + admin UI; document combat/movement.
- Changes: `runtimeTuning.ts` + `militaryKinds.ts`; `balance.ts` reads tuning; `formations.ts` + `SimulationEngine` formation destinations + XZ separation passes; `SelectionNameplateOverlay` + `unitDisplayNames.ts`; `mountRuntimeTuningPanel` (F10/backtick); `applyLiveUnitStats.ts`; `COMBAT_AND_MOVEMENT.md`; HUD formation line + `V` cycle; move/attack-move payloads carry `formation`; `ARCHITECTURE.md` cross-links.
- Validation: `npm run build` succeeds (2026-03-24).
- Next: Projectiles for ranged; shift-add selection; automated sim tests for formations/collision.

### 2026-03-24 - Grid, bases, R/S/P barracks, combat VFX, HUD dock
- Goal: World grid; home base (500 HP) lose condition; three barracks per side spawning R/S/P without resources; wider/taller HUD; centered dynamic control-group chips; ranged trace + hit flash; attack enemy buildings.
- Changes: `world/worldGrid.ts`; `SimStructure` + `structures` + `victorPlayerId` + `attack_structure` / `attackStructureTargetId`; production timer on barracks; nearest-hostile includes structures (flat damage); `damage_dealt` carries attacker + class; `HitFlashOverlay` + `spawnProjectileTrace`; `GridHelper`; structure meshes; bottom `control-groups-dock`; HUD outcome banner.
- Validation: `npm run build` succeeds.
- Next: Pathable grid / blocked cells; spend costs; real projectiles; match restart UI.

### 2026-03-24 - Manual barracks training, resources, building HUD, HP nameplates
- Goal: Player-commanded unit production with time + cost; Energy/Material (100 start); building panel beside main HUD; structure + unit selection labels include HP; all buildings 100 HP.
- Changes: `economyConstants.ts`; `ResourcePool.energy/material`; `productionQueue` on structures; `select_structures` + `queue_structure_train`; removed auto-spawn timer; `structureSelections`; `structureDisplayNames.ts`; `hud-cluster` + `hud-building-panel`; `SelectionNameplateOverlay` for sites; admin tuning for structure nameplate Y.
- Validation: `npm run build` succeeds.
- Next: Harvest/generator buildings; AI training; placement costs for new structures.

### 2026-03-24 - Economy module: minerals, fields, gather, generators
- Goal: Modular parent `src/core/economy/` for energy/minerals; mine world nodes; generate from structures; keep modes as pacing-only children.
- Changes: `ResourcePool.minerals`; `SimResourceField` + seed; `gather_from_field` + `gatherTargetFieldId`; `power_spire` / `mineral_refinery` + passive yields; `economyWorldTick` / `gatheringTick` / `fieldOverlap`; HUD generators row; octahedron field markers; RMB gather priority; `ARCHITECTURE.md` / `COMBAT_AND_MOVEMENT.md`.
- Validation: `npm run build` succeeds.

### 2026-03-24 - Placement HUD, match reset, C-train, structure HP tiers
- Goal: Admin new-game reset; C queues train from selected barracks; homes moved inward; place 3 barracks from HUD on grid; match starts home-only; home 500 HP / barracks 150 HP.
- Changes: `place_structure` command + grid overlap/bounds checks; `GameSession.resetMatch` + engine `clearCommandQueue`; TurnBased accumulator reset; HUD build toolbar + Esc; `economyConstants` structure HP; `seedStructures` homes only at gx 10 / 30; `COMBAT_AND_MOVEMENT.md`.
- Validation: `npm run build` succeeds.

### 2026-03-24 - φ/Fibonacci economy + combat scaling
- Goal: Building placement cost 33/33 vs cheap unit train; golden-ratio curves for damage, RPS, resources, structure HP.
- Changes: `goldenScale.ts` (φ, Fibonacci, unit damage/HP/cooldown, structure HP, RPS multipliers); `economyConstants.ts` (train F(6)=8; `STRUCTURE_PLACE_COST_*` 33; passive φ⁻¹/φ⁻²; starting F(11)+F(10)); `SimulationEngine` passive income; `runtimeTuning` defaults from golden helpers; `COMBAT_AND_MOVEMENT.md` updated.
- Validation: `npm run build` (post-change).
- Next: Implement `place_structure` + build grid validation to actually spend 33/33; gather commands.

### 2026-03-28 - Solar Array rename, AI Fibonacci R/P/S bias, PvC passive tuning
- Goal: Rename Power Spire → Solar Array in UI; computer trains weighted Rock/Paper/Scissors (F(4–6) permutation per `matchId`); seed three barracks; stop infinite AI eco vs trains via F(6)/F(7) passive scale on boosted seat.
- Changes: `GameState.skirmishBoostPassive`, `createMatchOptionsFromClientSetup` scale; `economyWorldTick` multiplier; `seedSkirmishEconomyBoost` + S/P slots; `computerOpponent` `initComputerOpponentPersonality` + weighted pick; `main` personality init on boot/reset; copy/tooltips/HUD/docs/tests strings.
- Validation: `npm run build`, `npm test`.

### 2026-03-28 - Computer barracks production + vision auto-engage
- Goal: AI spends down resources via periodic train; all military idles and attack-move acquire hostiles in vision; plain move ignores side fights; remote PvP noted in docs.
- Changes: `computerOpponent.ts` queue train + accum + reset; `COMPUTER_TRAIN_ATTEMPT_INTERVAL_SEC`; `SimulationEngine` `findNearestHostileWithinDistance` + idle/attack-move auto chase-strike; `clientMatch` comment on remote second player; `COMBAT_AND_MOVEMENT.md` / `ARCHITECTURE.md`.
- Validation: `npm run build`, `npm test`.

### 2026-03-28 - Client match setup for PvP and PvC
- Goal: Structure the codebase so two human seats and a computer seat are explicit; symmetric PvP start vs boosted computer start; single place for future AI.
- Changes: `clientMatch.ts` (`ClientMatchSetup`, URL parse, `createMatchOptionsFromClientSetup`); `CreateMatchOptions` + `resolveEconomyBoostPlayerId` + `winnerWhenCommandCoreDestroyed` + `seedSkirmishEconomyBoost(forPlayerId)` in `GameState.ts`; `ModeFactory` / `bootstrapGame` take `clientSetup`; `main.ts` uses `localPlayerId` from setup, PvC pre-tick `tickComputerOpponent` stub; `SimulationEngine` win uses roster helper; tests for PvP no-boost; `ARCHITECTURE.md`.
- Validation: `npm run build`, `npm test`.
- Next: Real AI in `computerOpponent.ts`; network command relay; optional hotseat UI.

### 2026-03-28 - Mining tune, inspect HUD, victory overlay, AI seed position
- Goal: Miners hug ore and fill/return slightly faster in sim-time; slower per-pulse mining; click-to-inspect any field/building/unit; big victory UI + Restart; push red pre-placed economy toward SE away from blue; docs match minerals-only + no home passive.
- Changes: `economyConstants.ts` (tight `RESOURCE_GATHER_RANGE`, `MINER_CARRY_CAPACITY` F(7) for fewer pulses before depot runs, slower pulses F(8)/10 + F(3) per pulse, tighter `MINERAL_DEPOSIT_RANGE`); `GameState.seedOpponentEconomyStructures` candidates gx 30/26 gz 7–11; `PrototypeView` `WorldInspectHit` + `pickInspectTargetAt` + `onInspect` on non-marquee LMB; `main.ts` inspect panel + `match-end-overlay` + shared `resetMatchToInitial`; `style.css` overlay/panel; `prototype.ts` gather pick `nearSlack` 2.8m; `ARCHITECTURE.md` / `COMBAT_AND_MOVEMENT.md` / `economyWorldTick` comment.
- Validation: `npm run build`, `npm test` (post-change).
- Next: Shift-add selection; automated sim tests for economy pulses; pathing on blocked grid.

### 2026-04-01 - Phase 2 authoritative PvP (browser + match:dev)
- Goal: Wire PvP to the existing `npm run match:dev` WebSocket host; document two-terminal setup and WebSocket URL options.
- Changes: `src/game/net/` (`resolveMatchWebSocketUrl`, `gameStateFromNetwork`, `matchAuthorityClient`); `main.ts` authoritative branch (no local `mode.update`, command send over WS, apply batched `tick`/`hello_ok` with `events`/`feedback`); `server/matchDevServer.ts` (`hello_ok` includes serialized state; `tick` includes events/feedback; broadcast only after `hello`); `launchScreen.ts` embeds `matchWs` in host/guest URLs; `README.md`, `.env.example`, `src/vite-env.d.ts`; `ARCHITECTURE.md`, `HOSTING_AND_MULTIPLAYER.md`, `PROGRESS.md` updated.
- Validation: `npm run build`, `npm test`.
- Next: Phase 3 — shared match start, stricter validation, `wss` production path.

