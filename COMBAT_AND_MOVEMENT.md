# Combat, movement, formations, and collision

This document describes how the **WebRTS prototype** behaves today. Values marked as **tunable** live in `src/core/runtimeTuning.ts` and can be edited at runtime via the **admin panel** (F10 or backtick).

## Structures and win condition

- `GameState.structures` holds **home**, **barracks_r/s/p**, and optional **`power_spire` (Solar Array)** / **mineral_refinery** generators. Match start seeds **only homes**. **Home** 500 HP; **barracks** 150 HP; **generators** 120 HP (`GENERATOR_STRUCTURE_MAX_HP`). Economy rules live under **`src/core/economy/`** (parent layer); modes only pace `SimulationEngine.step`.
- **Resources:** `ResourcePool` uses **energy** and **minerals** (renamed from “material”). HUD shows **En** / **Min**.
- **Passive generation:** **Command Core** grants **no** free resources. **Solar Array** adds energy/sec; **Mineral Refinery** adds minerals/sec (`structureResourceYield.ts` + `economyWorldTick.ts`). In **PvC**, `GameState.skirmishBoostPassive` scales those passives for the boosted AI seat by **F(6)/F(7)** so income stays closer to train spending.
- **Mining:** `GameState.resourceFields` holds neutral **minerals-only** nodes (`seedResourceFields.ts`). **Neutral (N)** units **right-click** a deposit → **`gather_from_field`**; they path into tight **gather range**, accrue **discrete mineral pulses** (`MINERAL_GATHER_*`, `RESOURCE_GATHER_RANGE`), fill **cargo** (`MINER_CARRY_CAPACITY`), then unload at Command Core / Mineral Depository within **deposit range** (`depositTick.ts`). Train **N** from Core (**C**); rally on ground or on a mineral field auto-assigns mine. Energy is **not** mined from fields — build **Solar Arrays**.
- **Solo vs computer:** In **`player_vs_computer`**, after fields are seeded the **non-local** seat gets **pre-built** Solar Array, Mineral Refinery, and **Rock / Scissors / Paper** barracks where grid allows (`seedSkirmishEconomyBoost` in `GameState.ts`). **`player_vs_player`** omits that cluster so both sides start with **Command Cores only** (plus shared neutral fields). Controlled by `ClientMatchSetup` / URL `?match=pvp|pvc`.
- **Placing buildings:** HUD toggles structure type; left-click empty ground → **`place_structure`**. Costs **33 En + 33 Min**; **2×2** footprint; must not overlap structures **or** resource fields (`structureFootprintOverlapsResourceField`). **Esc** cancels placement mode.
- **Training:** barracks only — **8 En + 8 Min** per queue step (`queue_structure_train` / **C**).
- **Admin:** **Reset match** reloads fields, structures, and resources.
- Right-click with units selected: **resource field** under cursor → gather; else **enemy structure** → `attack_structure`; else **enemy unit** → `attack_unit`; else **ground** → move / attack-move.
- When a **home** reaches `hp <= 0`, `victorPlayerId` is set to the other player and simulation stops resolving combat/production.

## Command flow

1. The client (`PrototypeView`) issues `GameCommand` objects (move, attack-move, attack unit/structure, gather, place structure, train, stop, select).
2. `SimulationEngine.enqueue` stores them; each frame `step` applies the queue, then runs one **simulation tick** of combat and movement.
3. `SimulationTickResult` returns updated `GameState` plus **events** (for example `damage_dealt` for floating combat numbers).

See `ARCHITECTURE.md` for the wider pipeline.

## Per-tick order (high level)

1. **Commands** applied to state (selection, move destinations, attack targets, etc.).
2. For every unit: **cooldown** decreases by `deltaSeconds`.
3. For every living unit, in array order:
   - **Combat target** is resolved (see below).
   - If the target is in **attack range** and cooldown is ready, apply **damage** (RPS multiplier), emit `damage_dealt`, refresh cooldown.
   - Else if the unit is **focus-firing** an enemy (`attack_unit` order) and is out of range, **chase** toward that enemy.
   - Else if the unit has a **move target**, step toward it; clear move and attack-move when close enough.
4. **Collision resolution**: pairs of living units are pushed apart on the XZ plane if closer than `tuning.collision.minCenterDistance` (several passes).
5. **Dead cleanup**: units at `hp <= 0` are removed; selections and stale `attackTargetId` references are cleared.

## Combat targeting

- **`attack_unit` / `attack_structure`**: sets `attackTargetId` / `attackStructureTargetId`. While valid, that target is chased and struck (unlimited chase range for explicit orders).
- **Auto-engage (in vision)**: after explicit targets and miner gather/deposit, units scan for the **nearest hostile unit or building within `visionRange`**. If found, they **chase and fight**. **Idle** units (no `moveTarget`, no `attackMoveTarget`) always do this when eligible. **`attack_move_units`** does this **while** marching toward the destination. **Plain `move_units`** does **not** scan — units walk through without stopping for enemies.
- **Neutral miners (`N`)**: keep **gather / deposit / haul** priority. Auto-engage applies only when they have **no** gather target, no deposit order, and **no** carried minerals (idle workers).

## Melee vs ranged (prototype)

- Each line **R / S / P** has `attackRange`, `visionRange`, `attackDamage`, and `attackCooldownSeconds` from **`tuning.units`** (copied onto each `SimUnit` at spawn and via admin **Apply**).
- **Only Paper (P)** is flagged **`attackClass: "ranged"`** — that is the line we intend to give **real projectiles** first. **Rock** and **Scissors** are **melee**. Combat is still **hitscan** when in `attackRange`; on each ranged hit the client spawns a **short-lived emissive sphere** that flies from attacker to target (`PrototypeView.spawnProjectileTrace`) as visual feedback only.
- The 3D view shows a **cyan waist ring** on ranged-class units. With the **admin panel open**, every unit gets **ground rings**: **cyan** = `visionRange`, **orange** = `attackRange` (values from live `SimUnit`; tune the table then **Apply** to refresh).

## RPS damage

When unit A hits enemy B:

`damage = A.attackDamage * rpsDamageMultiplier(A.kind, B.kind)`

**Triangle (locked):** Rock beats Scissors and loses to Paper · Scissors beats Paper and loses to Rock · Paper beats Rock and loses to Scissors. Same kind = neutral **1×**. Strong / weak multipliers default to **φ** and **1/φ** (golden ratio, product **1**) from `goldenScale.ts`, surfaced as `tuning.combat` and editable in the admin panel.

## Golden-scale unit stats (defaults)

Base strike damage uses **F(7)=13**: Rock **×φ → 21**, Paper **÷φ → 8**, Scissors **13**. Max HP uses Fibonacci tiers: Paper **F(11)=89**, Scissors **F(11)+F(8)=110**, Rock **F(12)=144**. Cooldowns: Scissors **1/φ**, Paper **1s**, Rock **√φ** (see `unitCooldownForKind` in `goldenScale.ts`). Speed and range stay hand-tuned in `runtimeTuning.ts` defaults.

## Movement and formations

- **`move_units`** and **`attack_move_units`** set per-unit **destinations** from a **formation** around the ground click point.
- **Formation** is taken from the command payload `formation`, or falls back to `tuning.formation.active`.
- **Stable slotting**: selected units are sorted by `id` before slots are assigned so the layout does not flicker when the set is unchanged.
- **Shapes** (see `src/core/formations.ts`):
  - **none**: every unit aims at the same point (legacy stack; collision still separates them).
  - **square**: a facing-aligned rectangle/grid oriented toward the march direction (centroid → click).
  - **circle**: ring around the target, radius scales with √N and `tuning.formation.circleRadiusPerSqrtUnit`.
  - **triangle**: wedge with the **apex** leading in the **direction of travel** (toward the click from the squad centroid); base trails behind.

Spacing and shape parameters are under `tuning.formation`.

## Collision

After movement, units are pushed apart horizontally using `tuning.collision` (`minCenterDistance`, `resolvePasses`, `pushFactor`). Pairs involving a **Neutral (N)** miner skip unit–unit overlap so they can cluster on nodes and depositories. This prevents exact stacking for military units; it is not a full physics engine.

## Client-only presentation

- **Nameplates** for the local player’s selection show placeholder names like `Rock - R` (`src/core/unitDisplayNames.ts`), positioned with `tuning.ui.nameplateOffsetY`.
- **Inspect panel:** any **single** LMB on the map (non-marquee) raycasts the closest field, structure, or unit and shows **title + stats** (ore remaining, building HP / construction time, unit HP) in `main.ts`.
- **Match end:** centered **VICTORY** / **DEFEAT** overlay with **Restart** (same reset as admin **Reset match**).
- **Admin panel** edits `tuning` live. **Apply unit stats to all living units** re-copies combat fields from `tuning` onto every `SimUnit` and clamps HP to the new max (see `src/core/applyLiveUnitStats.ts`).
