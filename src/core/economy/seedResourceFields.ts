import { structureFootprintOverlapsResourceField } from "./fieldOverlap";
import { footprintForStructureKind } from "../structureFootprint";
import {
  makeStructure,
  maxHpForPlacedStructure,
  playerTeamForPlayerId,
  structureFootprintViolatesMinimumClearance,
  type GameState,
  type SimStructure
} from "../state/GameState";
import type { SimResourceField } from "./resourceFieldTypes";
import { fibonacci } from "../goldenScale";
import { sphereCraterBlockedAtFlatXZ, spherePolarCapBlocksFlatXZ, sphereTerrainBlocksFootprint } from "../world/sphereTerrain";
import {
  footprintCenterWorld,
  footprintInWorldBounds,
  footprintsOverlap,
  GRID_CELL_SIZE,
  GROUND_HALF_EXTENT,
  worldToCell
} from "../world/worldGrid";
import { randomMatchId } from "../randomId";

function footprintOverlapsLivingStructure(
  state: GameState,
  gx: number,
  gz: number,
  footW: number,
  footD: number
): boolean {
  for (const s of state.structures) {
    if (s.hp <= 0) continue;
    if (footprintsOverlap(gx, gz, footW, footD, s.gx, s.gz, s.footW, s.footD)) return true;
  }
  return false;
}

function field(
  kind: SimResourceField["kind"],
  gx: number,
  gz: number,
  reserve: number | null
): SimResourceField {
  return {
    id: randomMatchId(),
    kind,
    gx,
    gz,
    reserve
  };
}

function overlapsAnyField(
  fields: SimResourceField[],
  gx: number,
  gz: number
): boolean {
  for (const f of fields) {
    if (footprintsOverlap(gx, gz, 1, 1, f.gx, f.gz, 1, 1)) return true;
  }
  return false;
}

/** World XZ contest hub — mineral density and yield peak here, thinning toward the rim. */
const MAP_CENTER_XZ = { x: 0, z: 0 } as const;

/** On sphere maps, keep bulk mineral rolls out of the polar caps (world Z). */
const SPHERE_MINERAL_MAX_ABS_Z = GROUND_HALF_EXTENT * 0.62;

function worldDistToMapCenterMeters(gx: number, gz: number): number {
  const c = footprintCenterWorld(gx, gz, 1, 1);
  return Math.hypot(c.x - MAP_CENTER_XZ.x, c.z - MAP_CENTER_XZ.z);
}

/** Higher `peak` near map center; outer patches stay thinner (lower reserve). */
function reserveForCenterDistance(distFromCenterM: number, salt: number): number {
  const sigma = 34;
  const peak = Math.exp(-(distFromCenterM * distFromCenterM) / (sigma * sigma));
  const base = 260 + (fibonacci((salt % 6) + 6) * 13) % 320;
  const bonus = 560 * peak;
  return Math.round(Math.min(1280, base + bonus));
}

type WeightedCell = { gx: number; gz: number; w: number };

function tryWeightedMineralPlacements(
  state: GameState,
  placed: SimResourceField[],
  pool: WeightedCell[],
  reserve: number,
  homePatchVisionOwnerId?: string
): boolean {
  const remaining = [...pool];
  while (remaining.length > 0) {
    const wsum = remaining.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * wsum;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      r -= remaining[i]!.w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    const pick = remaining[idx]!;
    if (tryAddMineralCell(state, placed, pick.gx, pick.gz, reserve, { homePatchVisionOwnerId })) return true;
    remaining.splice(idx, 1);
  }
  return false;
}

function tryAddHomePatchMineral(
  state: GameState,
  placed: SimResourceField[],
  home: SimStructure,
  reserve: number
): void {
  const hc = footprintCenterWorld(home.gx, home.gz, home.footW, home.footD);
  const halfW = (home.footW * GRID_CELL_SIZE) * 0.5;
  const halfD = (home.footD * GRID_CELL_SIZE) * 0.5;
  const edgeFromCenter = Math.max(halfW, halfD);
  /** Outside the Command Core footprint, but still a short walk (not mid-map). */
  const minD = edgeFromCenter + GRID_CELL_SIZE * 0.85;
  const maxD = edgeFromCenter + GRID_CELL_SIZE * 2.85;

  const { gx, gz, footW, footD } = home;
  const pad = 14;

  function collectPool(distLo: number, distHi: number): WeightedCell[] {
    const out: WeightedCell[] = [];
    for (let cx = gx - pad; cx <= gx + footW - 1 + pad; cx += 1) {
      for (let cz = gz - pad; cz <= gz + footD - 1 + pad; cz += 1) {
        if (cx >= gx && cx < gx + footW && cz >= gz && cz < gz + footD) continue;
        const c = footprintCenterWorld(cx, cz, 1, 1);
        const dx = c.x - hc.x;
        const dz = c.z - hc.z;
        const dist = Math.hypot(dx, dz);
        if (dist < distLo || dist > distHi) continue;
        const w = 1 / (1 + dist * dist * 0.045);
        out.push({ gx: cx, gz: cz, w });
      }
    }
    return out;
  }

  const bands: { lo: number; hi: number }[] = [
    { lo: minD - 0.35, hi: minD + GRID_CELL_SIZE * 2.2 },
    { lo: minD - 0.8, hi: maxD + GRID_CELL_SIZE * 0.75 },
    { lo: minD - 1.5, hi: maxD + GRID_CELL_SIZE * 2.5 }
  ];

  const visionOwner = home.playerId;
  for (const b of bands) {
    const pool = collectPool(b.lo, b.hi);
    if (pool.length > 0 && tryWeightedMineralPlacements(state, placed, pool, reserve, visionOwner)) return;
  }

  const loose: WeightedCell[] = [];
  for (let cx = gx - pad; cx <= gx + footW - 1 + pad; cx += 1) {
    for (let cz = gz - pad; cz <= gz + footD - 1 + pad; cz += 1) {
      if (cx >= gx && cx < gx + footW && cz >= gz && cz < gz + footD) continue;
      const c = footprintCenterWorld(cx, cz, 1, 1);
      const dx = c.x - hc.x;
      const dz = c.z - hc.z;
      const dist = Math.hypot(dx, dz);
      if (dist < minD - 2.5 || dist > maxD + 6) continue;
      const w = 1 / (1 + dist * dist * 0.035);
      loose.push({ gx: cx, gz: cz, w });
    }
  }
  if (loose.length > 0 && tryWeightedMineralPlacements(state, placed, loose, reserve, visionOwner)) return;

  const fallback: { gx: number; gz: number; d2: number }[] = [];
  for (let cx = gx - pad; cx <= gx + footW - 1 + pad; cx += 1) {
    for (let cz = gz - pad; cz <= gz + footD - 1 + pad; cz += 1) {
      if (cx >= gx && cx < gx + footW && cz >= gz && cz < gz + footD) continue;
      const c = footprintCenterWorld(cx, cz, 1, 1);
      const dx = c.x - hc.x;
      const dz = c.z - hc.z;
      fallback.push({ gx: cx, gz: cz, d2: dx * dx + dz * dz });
    }
  }
  fallback.sort((a, b) => a.d2 - b.d2);
  for (const c of fallback) {
    if (tryAddMineralCell(state, placed, c.gx, c.gz, reserve, { homePatchVisionOwnerId: visionOwner })) return;
  }
}

/**
 * Fill remaining slots by scanning valid cells from map center outward (deterministic top-up).
 */
function fillMineralsFromCenterOutward(
  state: GameState,
  placed: SimResourceField[],
  targetTotal: number,
  tryAdd: (gx: number, gz: number, reserve: number) => boolean
): void {
  const candidates: { gx: number; gz: number; d: number }[] = [];
  for (let gx = -24; gx <= 44; gx += 1) {
    for (let gz = -24; gz <= 44; gz += 1) {
      if (!footprintInWorldBounds(gx, gz, 1, 1)) continue;
      const c = footprintCenterWorld(gx, gz, 1, 1);
      let d = worldDistToMapCenterMeters(gx, gz);
      const lat = Math.abs(c.z) / Math.max(1e-6, GROUND_HALF_EXTENT);
      d += 380 * lat * lat;
      candidates.push({ gx, gz, d });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  let salt = placed.length;
  for (const cell of candidates) {
    if (placed.length >= targetTotal) break;
    if (tryAdd(cell.gx, cell.gz, reserveForCenterDistance(cell.d, salt))) salt += 1;
  }
}

function tryAddMineralNearWorld(
  state: GameState,
  placed: SimResourceField[],
  wx: number,
  wz: number,
  reserve: number,
  maxRing = 6
): boolean {
  for (const cell of sortedCellsNearWorld(wx, wz, maxRing)) {
    if (tryAddMineralCell(state, placed, cell.gx, cell.gz, reserve)) return true;
  }
  return false;
}

function seedMidpointAndEquatorMinerals(
  state: GameState,
  placed: SimResourceField[],
  center: { x: number; z: number }
): void {
  const midpointOffsets: { x: number; z: number; reserve: number }[] = [
    { x: 0, z: 0, reserve: 1600 },
    { x: -4, z: 0, reserve: 1450 },
    { x: 4, z: 0, reserve: 1450 },
    { x: 0, z: -4, reserve: 1380 },
    { x: 0, z: 4, reserve: 1380 },
    { x: -8, z: -3, reserve: 1280 },
    { x: -8, z: 3, reserve: 1280 },
    { x: 8, z: -3, reserve: 1280 },
    { x: 8, z: 3, reserve: 1280 },
    { x: -13, z: 0, reserve: 1180 },
    { x: 13, z: 0, reserve: 1180 },
    { x: 0, z: -8, reserve: 1120 },
    { x: 0, z: 8, reserve: 1120 }
  ];
  for (const p of midpointOffsets) {
    tryAddMineralNearWorld(state, placed, center.x + p.x, center.z + p.z, p.reserve, 8);
  }

  const equatorXs = [-48, -40, -32, -24, -16, -8, 8, 16, 24, 32, 40, 48];
  for (let i = 0; i < equatorXs.length; i += 1) {
    const x = equatorXs[i]!;
    const z = (i % 3 - 1) * 3;
    const reserve = 520 + ((i * 73) % 260);
    tryAddMineralNearWorld(state, placed, x, z, reserve, 5);
  }

  const spreadRing: { x: number; z: number; reserve: number }[] = [
    { x: -52, z: -28, reserve: 560 },
    { x: -40, z: 30, reserve: 620 },
    { x: -28, z: -34, reserve: 590 },
    { x: -14, z: 32, reserve: 540 },
    { x: 14, z: -32, reserve: 540 },
    { x: 28, z: 34, reserve: 590 },
    { x: 40, z: -30, reserve: 620 },
    { x: 52, z: 28, reserve: 560 },
    { x: -58, z: 8, reserve: 500 },
    { x: -50, z: -14, reserve: 520 },
    { x: 50, z: 14, reserve: 520 },
    { x: 58, z: -8, reserve: 500 },
    { x: -22, z: 44, reserve: 470 },
    { x: 22, z: -44, reserve: 470 }
  ];
  for (const p of spreadRing) {
    tryAddMineralNearWorld(state, placed, p.x, p.z, p.reserve, 6);
  }
}

/**
 * Mineral patches across the map. **Densest near world (0,0)** with high reserves; outer ring is thinner.
 * Each Command Core first gets a **starter mineral + Solar Array** on an equilateral triangle (see `HOME_TRIANGLE_SIDE_M`),
 * then the bulk mineral scatter runs.
 */
export function seedResourceFields(state: GameState): void {
  const placed: SimResourceField[] = [];
  const tryAdd = (gx: number, gz: number, reserve: number): boolean =>
    tryAddMineralCell(state, placed, gx, gz, reserve);

  /** Starter mineral + solar in an equilateral triangle around each Command Core (see `HOME_TRIANGLE_SIDE_M`). */
  seedEquilateralHomeSolarAndMineral(state, placed);

  const targetWorldFields = 78;
  const maxR = GROUND_HALF_EXTENT * 0.9;
  const homes = state.structures.filter((s) => s.kind === "home" && s.hp > 0);
  const center =
    homes.length >= 2
      ? (() => {
          const a = footprintCenterWorld(homes[0]!.gx, homes[0]!.gz, homes[0]!.footW, homes[0]!.footD);
          const b = footprintCenterWorld(homes[1]!.gx, homes[1]!.gz, homes[1]!.footW, homes[1]!.footD);
          return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
        })()
      : { ...MAP_CENTER_XZ };
  seedMidpointAndEquatorMinerals(state, placed, center);
  let salt = 0;
  let attempts = 0;
  const maxAttempts = 2400;

  while (placed.length < targetWorldFields && attempts < maxAttempts) {
    attempts += 1;
    const richBand = placed.length < Math.floor(targetWorldFields * 0.56);
    let wx: number;
    let wz: number;
    if (richBand) {
      // Bulk of larger reserves near the midpoint between players.
      const theta = Math.random() * Math.PI * 2;
      const r = maxR * 0.3 * Math.sqrt(Math.random());
      wx = center.x + Math.cos(theta) * r;
      wz = center.z + Math.sin(theta) * r;
    } else {
      // Even spread elsewhere across the playable world.
      const theta = Math.random() * Math.PI * 2;
      const r = maxR * Math.sqrt(Math.random());
      wx = Math.cos(theta) * r;
      wz = Math.sin(theta) * r;
    }
    if (Math.abs(wz) > SPHERE_MINERAL_MAX_ABS_Z) continue;
    const { gx, gz } = worldToCell(wx, wz);
    const c = footprintCenterWorld(gx, gz, 1, 1);
    const distMid = Math.hypot(c.x - center.x, c.z - center.z);
    const reserve = richBand
      ? Math.round(Math.min(1300, 720 + (1 - Math.min(1, distMid / (maxR * 0.33))) * 520 + (salt % 5) * 16))
      : Math.round(220 + (salt % 9) * 28 + Math.max(0, 120 - distMid * 0.9));
    if (tryAdd(gx, gz, reserve)) salt += 1;
  }

  if (placed.length < targetWorldFields) {
    fillMineralsFromCenterOutward(state, placed, targetWorldFields, tryAdd);
  }

  state.resourceFields = placed;
}

function tryAddMineralCell(
  state: GameState,
  placed: SimResourceField[],
  gx: number,
  gz: number,
  reserve: number,
  opts?: { homePatchVisionOwnerId?: string }
): boolean {
  if (!footprintInWorldBounds(gx, gz, 1, 1)) return false;
  if (footprintOverlapsLivingStructure(state, gx, gz, 1, 1)) return false;
  if (overlapsAnyField(placed, gx, gz)) return false;
  const cellCenter = footprintCenterWorld(gx, gz, 1, 1);
  if (spherePolarCapBlocksFlatXZ(cellCenter.x, cellCenter.z)) return false;
  if (sphereCraterBlockedAtFlatXZ(cellCenter.x, cellCenter.z)) return false;
  const f = field("minerals", gx, gz, reserve);
  if (opts?.homePatchVisionOwnerId) f.homePatchVisionOwnerId = opts.homePatchVisionOwnerId;
  placed.push(f);
  return true;
}

/** Command Core is 3×3 cells — one edge of that footprint in meters. */
const COMMAND_CORE_EDGE_M = 3 * GRID_CELL_SIZE;
/**
 * Equilateral triangle side (home center ↔ solar ↔ mineral). Design target was two core edges, but that
 * read too wide in play; ~2.5× shrink keeps the trio tight around the Command Core.
 */
const HOME_TRIANGLE_SIDE_M = (2 * COMMAND_CORE_EDGE_M) / 2.5;

function dist2World(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function sideLengthM(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function triangleSideErrorM(
  hx: number,
  hz: number,
  sx: number,
  sz: number,
  mx: number,
  mz: number,
  target: number
): number {
  const e1 = Math.abs(sideLengthM(hx, hz, sx, sz) - target);
  const e2 = Math.abs(sideLengthM(hx, hz, mx, mz) - target);
  const e3 = Math.abs(sideLengthM(sx, sz, mx, mz) - target);
  return Math.max(e1, e2, e3);
}

function hashHomeTriangleAngle(matchId: string, playerId: string): number {
  let h = 2166136261 >>> 0;
  const s = `${matchId}:${playerId}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function sortedCellsNearWorld(
  targetWX: number,
  targetWZ: number,
  maxRing: number
): { gx: number; gz: number; d2: number }[] {
  const o = worldToCell(targetWX, targetWZ);
  const arr: { gx: number; gz: number; d2: number }[] = [];
  for (let r = 0; r <= maxRing; r += 1) {
    if (r === 0) {
      const c = footprintCenterWorld(o.gx, o.gz, 1, 1);
      arr.push({ gx: o.gx, gz: o.gz, d2: dist2World(c.x, c.z, targetWX, targetWZ) });
      continue;
    }
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const gx = o.gx + dx;
        const gz = o.gz + dz;
        const c = footprintCenterWorld(gx, gz, 1, 1);
        arr.push({ gx, gz, d2: dist2World(c.x, c.z, targetWX, targetWZ) });
      }
    }
  }
  arr.sort((a, b) => a.d2 - b.d2);
  return arr;
}

function solarFootprintPlannable(state: GameState, placed: SimResourceField[], cgx: number, cgz: number): boolean {
  const footW = 1;
  const footD = 1;
  if (!footprintInWorldBounds(cgx, cgz, footW, footD)) return false;
  if (sphereTerrainBlocksFootprint(state, cgx, cgz, footW, footD)) return false;
  if (structureFootprintViolatesMinimumClearance(state, cgx, cgz, footW, footD)) return false;
  if (footprintOverlapsLivingStructure(state, cgx, cgz, footW, footD)) return false;
  if (structureFootprintOverlapsResourceField(state, cgx, cgz, footW, footD)) return false;
  for (const f of placed) {
    if (footprintsOverlap(cgx, cgz, footW, footD, f.gx, f.gz, 1, 1)) return false;
  }
  return true;
}

function mineralCellPlannable(state: GameState, placed: SimResourceField[], gx: number, gz: number): boolean {
  if (!footprintInWorldBounds(gx, gz, 1, 1)) return false;
  if (footprintOverlapsLivingStructure(state, gx, gz, 1, 1)) return false;
  if (overlapsAnyField(placed, gx, gz)) return false;
  const cellCenter = footprintCenterWorld(gx, gz, 1, 1);
  if (spherePolarCapBlocksFlatXZ(cellCenter.x, cellCenter.z)) return false;
  if (sphereCraterBlockedAtFlatXZ(cellCenter.x, cellCenter.z)) return false;
  return true;
}

/**
 * Places starter Solar Array + guaranteed home mineral as an **equilateral triangle** in world XZ with
 * the Command Core center, solar 1×1 center, and mineral 1×1 center; each side ≈ `HOME_TRIANGLE_SIDE_M`
 * (two Command Core edge lengths). Falls back to legacy ring mineral + edge solar if no valid pair is found.
 */
function seedEquilateralHomeSolarAndMineral(state: GameState, placed: SimResourceField[]): void {
  const homes = state.structures.filter((s) => s.kind === "home" && s.hp > 0);
  const reserve = 320 + (fibonacci(7) * 13) % 520;
  const slackM = GRID_CELL_SIZE * 1.15;
  const L = HOME_TRIANGLE_SIDE_M;

  for (const home of homes) {
    const hc = footprintCenterWorld(home.gx, home.gz, home.footW, home.footD);
    const baseT = hashHomeTriangleAngle(state.matchId, home.playerId) * Math.PI * 2;

    let best: { sg: { gx: number; gz: number }; mg: { gx: number; gz: number }; err: number } | null = null;

    for (let step = 0; step < 28; step += 1) {
      const theta = baseT + step * (Math.PI / 14);
      const su = Math.cos(theta);
      const sv = Math.sin(theta);
      const solarWX = hc.x + L * su;
      const solarWZ = hc.z + L * sv;
      const minWX = hc.x + L * Math.cos(theta + Math.PI / 3);
      const minWZ = hc.z + L * Math.sin(theta + Math.PI / 3);

      const solarCandidates = sortedCellsNearWorld(solarWX, solarWZ, 7).slice(0, 28);
      const minCandidates = sortedCellsNearWorld(minWX, minWZ, 7).slice(0, 28);

      for (const sc of solarCandidates) {
        if (!solarFootprintPlannable(state, placed, sc.gx, sc.gz)) continue;
        const scc = footprintCenterWorld(sc.gx, sc.gz, 1, 1);
        for (const mc of minCandidates) {
          if (mc.gx === sc.gx && mc.gz === sc.gz) continue;
          if (footprintsOverlap(sc.gx, sc.gz, 1, 1, mc.gx, mc.gz, 1, 1)) continue;
          if (!mineralCellPlannable(state, placed, mc.gx, mc.gz)) continue;
          const mcc = footprintCenterWorld(mc.gx, mc.gz, 1, 1);
          const err = triangleSideErrorM(hc.x, hc.z, scc.x, scc.z, mcc.x, mcc.z, L);
          if (err > slackM) continue;
          if (!best || err < best.err) best = { sg: { gx: sc.gx, gz: sc.gz }, mg: { gx: mc.gx, gz: mc.gz }, err };
        }
      }
      const currentBest =
        best as { sg: { gx: number; gz: number }; mg: { gx: number; gz: number }; err: number } | null;
      if (currentBest && currentBest.err < GRID_CELL_SIZE * 0.55) break;
    }

    const selected = best as { sg: { gx: number; gz: number }; mg: { gx: number; gz: number }; err: number } | null;
    if (selected) {
      if (
        tryAddMineralCell(state, placed, selected.mg.gx, selected.mg.gz, reserve, {
          homePatchVisionOwnerId: home.playerId
        })
      ) {
        if (solarFootprintPlannable(state, placed, selected.sg.gx, selected.sg.gz)) {
          const { footW, footD } = footprintForStructureKind("power_spire");
          const hp = maxHpForPlacedStructure("power_spire");
          const team = playerTeamForPlayerId(home.playerId);
          state.structures.push(
            makeStructure(home.playerId, team, "power_spire", selected.sg.gx, selected.sg.gz, footW, footD, hp)
          );
          continue;
        }
        placed.pop();
      }
    }

    tryAddHomePatchMineral(state, placed, home, reserve);
    seedStarterSolarAdjacentFallback(state, placed, home);
  }
}

/** Legacy edge-adjacent solar when triangle placement did not run. */
function seedStarterSolarAdjacentFallback(
  state: GameState,
  placed: SimResourceField[],
  home: SimStructure
): void {
  if (state.structures.some((s) => s.playerId === home.playerId && s.kind === "power_spire" && s.hp > 0)) {
    return;
  }
  const { footW, footD } = footprintForStructureKind("power_spire");
  const hp = maxHpForPlacedStructure("power_spire");
  const team = playerTeamForPlayerId(home.playerId);
  const { gx, gz, footW: hw, footD: hd } = home;
  const homeCenter = footprintCenterWorld(home.gx, home.gz, home.footW, home.footD);

  for (const gap of [0, 1, 2] as const) {
    const candidates: { cgx: number; cgz: number; d2: number }[] = [];
    for (let dz = 0; dz < hd; dz += 1) candidates.push({ cgx: gx + hw + gap, cgz: gz + dz, d2: 0 });
    for (let dz = 0; dz < hd; dz += 1) candidates.push({ cgx: gx - footW - gap, cgz: gz + dz, d2: 0 });
    for (let dx = 0; dx < hw; dx += 1) candidates.push({ cgx: gx + dx, cgz: gz + hd + gap, d2: 0 });
    for (let dx = 0; dx < hw; dx += 1) candidates.push({ cgx: gx + dx, cgz: gz - footD - gap, d2: 0 });
    for (const c of candidates) {
      const sc = footprintCenterWorld(c.cgx, c.cgz, footW, footD);
      c.d2 = dist2World(sc.x, sc.z, homeCenter.x, homeCenter.z);
    }
    candidates.sort((a, b) => a.d2 - b.d2);

    for (const { cgx, cgz } of candidates) {
      if (!solarFootprintPlannable(state, placed, cgx, cgz)) continue;
      state.structures.push(makeStructure(home.playerId, team, "power_spire", cgx, cgz, footW, footD, hp));
      return;
    }
  }
}
