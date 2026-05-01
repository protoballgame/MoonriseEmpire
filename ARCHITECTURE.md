# Modular Architecture Baseline

This project is structured for parent/child extensibility so we can add new game modes without rewriting core systems.

## Parent Layer (Shared Core)

- `src/core/state`: canonical game state and match metadata (includes prototype `units` + per-player `selections`).
- `src/core/commands`: command/event contracts (`select_units`, `move_units`, `attack_move_units`, `stop_units`, plus placeholders).
- `src/core/sim`: shared deterministic resolver (`SimulationEngine` drains the command queue then runs `simulateWorld`). Each `step` returns `SimulationTickResult` with `state` plus `events` (e.g. `damage_dealt`) for UI/VFX.
- `src/core/balance.ts`: RPS helpers and per-kind combat fields read from **`runtimeTuning`** (spawn + live apply).
- `src/core/runtimeTuning.ts`: mutable **tunable defaults** for combat, units, collision, formations, camera, UI (edited via the in-game admin panel).
- `COMBAT_AND_MOVEMENT.md`: tick order, targeting, formations, collision, melee vs ranged notes.
- `src/core/types.ts`: shared civ/resource/player contracts.
- `src/core/economy/`: **resource economy parent layer** — world **mineral** fields (`SimResourceField`), passive yields **only** from **Solar Array** (`power_spire`, energy) and **Mineral Refinery** (`economyWorldTick.ts` + `structureResourceYield.ts`), **N**-miner discrete pulse gathering (`gatheringTick.ts`, `depositTick.ts`), field seeding, and footprint overlap helpers. Command Core has **no** passive income. PvC applies **`skirmishBoostPassive`** (F(6)/F(7) scale on the boosted seat’s generators) so passive income does not outrun train costs forever. Modes must not duplicate these formulas; they only schedule `SimulationEngine.step`.

## Child Layer (Mode Modules)

- `src/core/modes/GameMode.ts`: abstract base class for all modes.
- `src/core/modes/RealTimeMode.ts`: resolves simulation each tick/frame.
- `src/core/modes/TurnBasedMode.ts`: resolves simulation in turn windows.
- `src/core/modes/ModeFactory.ts`: mode creation and dependency wiring.

## Match setup (PvP vs PvC)

- `src/core/match/clientMatch.ts`: **`ClientMatchSetup`** — `localPlayerId` (`p1`|`p2`) and **`MatchKind`** (`player_vs_player` | `player_vs_computer`). Parsed from the query string (`?match=pvp|pvc`, `?seat=p1|p2`).
- `src/game/launchScreen.ts`: first visit (no `match` param) shows **Play vs computer** / **Play vs player**; PvP flow exposes a **guest join URL** with `match=pvp`, `seat=p2`, and **`matchWs`** (WebSocket URL for `npm run match:dev`, default `ws://<host>:8788`). Shared links with `match=` skip the launcher. Dev: add `match=pvc` (or `pvp`) if you need to bypass the menu (e.g. `?match=pvc&skipCountdown=1`).
- **Authoritative PvP (Phase 2):** `src/game/net/resolveMatchWebSocketUrl.ts` resolves `?matchWs=` / `?ws=` → `VITE_MATCH_WS` → in Vite dev only, `?match=pvp` → `ws://<hostname>:8788`. `src/game/net/matchAuthorityClient.ts` speaks the `match:dev` protocol (`hello`, `game_command`, `tick`). `src/game/net/gameStateFromNetwork.ts` revives `Uint8Array` exploration from wire JSON. `src/main.ts` stops local `mode.update` when net PvP is active; state and tick `events` / `feedback` come from the server.
- **`createMatchState(mode, options?)`** (`GameState.ts`): optional **`CreateMatchOptions.economyBoostPlayerId`** — when set to a seat id, pre-places generator + barracks (`seedSkirmishEconomyBoost`); **`null` or omitted** → symmetric start (home + one starter solar each, like normal PvC via `createMatchOptionsFromClientSetup`).
- **`GameSession.clientSetup`** is stored on the session so **reset match** reapplies the same kind/seat.
- Commands are always **`GameCommand.playerId`**-scoped; the simulation does not assume a single human. The view uses **`localPlayerId`** only for input and HUD.
- **Computer driver:** `src/game/opponent/computerOpponent.ts` **`tickComputerOpponent`** runs before each tick in PvC: evaluates miner queues, structure placement, and military/Core training **every frame**, gated by affordability and build rules (not fixed seconds-between-attempts; `resetComputerOpponentState` on match reset). PvP expects a **remote** second client to submit rival commands (matchmaking later).
- **Victory:** `winnerWhenCommandCoreDestroyed` generalizes Command Core elimination for the two-player roster (not hardcoded `p1`/`p2` branches in the engine).

## Rule of Efficiency

All gameplay/balance rules should live in shared simulation systems.
Mode classes should only control pacing/input cadence (when to resolve), not duplicate combat/resource math.

## View Layer (Prototype)

- `src/game/prototype.ts` (`PrototypeView`): Three.js scene sync + camera + pointer/keyboard input.
- It must not mutate gameplay state directly; it calls `GameMode.submitCommand` only.
- **Inspect:** each non-marquee LMB reports a `WorldInspectHit` (field / structure / unit) via `onInspect` for the HUD panel in `main.ts` (name, HP, ore remaining).
- `src/main.ts` owns the loop: `state = mode.update(state, dt)` then `view.syncFromState(state)`.
- **Match end:** when `victorPlayerId` is set, a full-screen **VICTORY** / **DEFEAT** overlay with **Restart** calls the same `resetMatchToInitial` as the admin panel.

## Hosting, PvP, and production

Dev **authoritative PvP** uses `npm run match:dev` + browser `matchWs` / `VITE_MATCH_WS` (see **`README.md`** and **`HOSTING_AND_MULTIPLAYER.md`**). Production still needs TLS (`wss://`), validation, and shared match start — see hosting doc phases 3+.

