import { getUnitMaxHp } from "./balance";
import { structurePassiveYieldPerSec } from "./economy/structureResourceYield";
import { isStructureBuilt, structureProducesKind, type GameState, type SimStructure, type SimUnit } from "./state/GameState";
import { structureDisplayName } from "./structureDisplayNames";
import { unitNameplateLabel } from "./unitDisplayNames";

/** What the unit is doing right now (orders + cargo). */
export function formatUnitActivityLine(u: SimUnit, state: GameState): string {
  if (u.hp <= 0) return "Inactive";
  if (u.attackStructureTargetId) {
    const t = state.structures.find((s) => s.id === u.attackStructureTargetId);
    return t ? `Attacking ${structureDisplayName(t.kind)}` : "Attacking a structure";
  }
  if (u.attackTargetId) {
    const t = state.units.find((x) => x.id === u.attackTargetId);
    return t ? `Fighting ${unitNameplateLabel(t.kind)}` : "Attacking a unit";
  }
  if (u.attackMoveTarget) return "Attack-moving";
  if (u.buildStructureTargetId) {
    const st = state.structures.find((s) => s.id === u.buildStructureTargetId);
    return st ? `Building ${structureDisplayName(st.kind)}` : "Building";
  }
  if (u.depositStructureTargetId) {
    const st = state.structures.find((s) => s.id === u.depositStructureTargetId);
    return st ? `Unloading at ${structureDisplayName(st.kind)}` : "Walking to unload minerals";
  }
  if (u.gatherTargetFieldId) return "Gathering minerals";
  if (u.moveWaypointQueue.length > 0) return `Moving (${u.moveWaypointQueue.length} queued waypoints)`;
  if (u.moveTarget) return "Moving";
  if (u.kind === "N" && u.carriedMinerals > 0) {
    return `Carrying ${Math.round(u.carriedMinerals)} minerals (seeking unload)`;
  }
  return "Idle";
}

export function formatUnitSelectionCardBody(state: GameState, unitIds: readonly string[]): string {
  const units = unitIds
    .map((id) => state.units.find((u) => u.id === id))
    .filter((u): u is SimUnit => !!u && u.hp > 0);
  if (units.length === 0) return "";
  if (units.length === 1) {
    const u = units[0]!;
    return `${formatUnitActivityLine(u, state)}\nHP ${Math.round(u.hp)} / ${getUnitMaxHp(u.kind)}`;
  }
  const lines = units.slice(0, 5).map((u) => {
    const act = formatUnitActivityLine(u, state);
    return `${unitNameplateLabel(u.kind)} — ${act}`;
  });
  const tail = units.length > 5 ? `\n… +${units.length - 5} more selected` : "";
  return lines.join("\n") + tail;
}

export function formatStructureStatusLine(st: SimStructure): string {
  if (st.hp <= 0) return "Destroyed";
  if (st.buildRemainingSec > 0) {
    return `Under construction — ${Math.max(0, st.buildRemainingSec).toFixed(1)}s remaining`;
  }
  return "Operational";
}

export function formatStructureProductionLine(st: SimStructure): string {
  const q = st.productionQueue;
  if (q.length === 0) return "Production: idle (nothing queued).";
  const front = q[0]!;
  const rest = q.length - 1;
  const head = `${front.kind} in progress — ${Math.max(0, front.remainingSec).toFixed(1)}s left`;
  return rest > 0 ? `${head}; ${rest} more queued` : `${head}.`;
}

export function formatStructurePassiveLine(st: SimStructure): string | null {
  if (!isStructureBuilt(st)) return null;
  const y = structurePassiveYieldPerSec(st.kind);
  if (y.energy <= 0 && y.minerals <= 0) return null;
  const parts: string[] = [];
  if (y.energy > 0) parts.push(`+${y.energy.toFixed(2)} energy/s`);
  if (y.minerals > 0) parts.push(`+${y.minerals.toFixed(2)} minerals/s`);
  return `Passive: ${parts.join(", ")}.`;
}

export function formatStructureTrainSummary(st: SimStructure): string | null {
  const k = structureProducesKind(st);
  if (!k) return null;
  if (k === "N") return "Trains Neutral miners from this site.";
  return `Trains ${k} units (${k === "R" ? "Rock" : k === "S" ? "Scissors" : "Paper"} line).`;
}
