import type { GameCommand } from "../commands/GameCommand";
import type { MilitaryKind } from "../militaryKinds";
import type { SimulationEvent } from "../sim/simulationEvents";
import type { UiFeedbackEvent } from "../sim/uiFeedbackEvents";

/** Who issued a command (derived from `playerId` vs known seats). */
export type AnalyticsActor = "human" | "computer" | "unknown";

export const MATCH_ANALYTICS_SCHEMA_VERSION = 1 as const;

export interface MatchAnalyticsMeta {
  schemaVersion: typeof MATCH_ANALYTICS_SCHEMA_VERSION;
  matchId: string;
  modeId: string;
  matchKind: string;
  localPlayerId: string;
  rivalPlayerId: string | null;
  sessionStartedAtMs: number;
  tickRateHz: number;
}

export type MatchAnalyticsRecord =
  | { kind: "session"; seq: 0; meta: MatchAnalyticsMeta }
  | {
      kind: "command";
      seq: number;
      simTickAtEnqueue: number;
      wallMs: number;
      actor: AnalyticsActor;
      playerId: string;
      commandType: string;
      payload?: unknown;
    }
  | {
      kind: "tick_frame";
      seq: number;
      simTick: number;
      wallMs: number;
      deltaSec: number;
      combatHits: number;
      mineralGatherEvents: number;
      feedbackSummary: Record<string, number>;
    }
  | {
      kind: "combat_hit";
      seq: number;
      simTick: number;
      wallMs: number;
      attackerUnitId: string;
      targetUnitId?: string;
      targetStructureId?: string;
      amount: number;
      attackClass: "melee" | "ranged";
      attackerKind?: MilitaryKind;
      defenderKind?: MilitaryKind;
      rpsMultiplier?: number;
      baseDamage?: number;
      defenderHpBefore?: number;
      defenderHpAfter?: number;
      targetStructureKind?: string;
      structureHpBefore?: number;
      structureHpAfter?: number;
    }
  | {
      kind: "mineral_gathered";
      seq: number;
      simTick: number;
      wallMs: number;
      playerId: string;
      unitId: string;
      amount: number;
    };

export interface MatchAnalyticsExport {
  exportVersion: typeof MATCH_ANALYTICS_SCHEMA_VERSION;
  exportedAtMs: number;
  droppedEvents: number;
  cap: number;
  meta: MatchAnalyticsMeta | null;
  events: MatchAnalyticsRecord[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sanitizeCommandPayload(cmd: GameCommand): unknown {
  if (!cmd.payload) return undefined;
  const p = cmd.payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };

  const capIds = (key: string, max: number): void => {
    const v = out[key];
    if (Array.isArray(v) && v.length > max) {
      out[key] = [...(v as unknown[]).slice(0, max)];
      out[`_${key}Total`] = v.length;
    }
  };
  capIds("unitIds", 32);

  const roundVec = (key: string): void => {
    const t = out[key];
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const o = t as Record<string, unknown>;
      if (typeof o.x === "number") o.x = round2(o.x);
      if (typeof o.y === "number") o.y = round2(o.y);
      if (typeof o.z === "number") o.z = round2(o.z);
    }
  };
  roundVec("target");

  return out;
}

function summarizeFeedback(feedback: readonly UiFeedbackEvent[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const f of feedback) {
    const key =
      f.kind === "gather" || f.kind === "place_structure" || f.kind === "rally_set"
        ? `${f.kind}:${f.status}${"reason" in f && f.reason ? `:${f.reason}` : ""}`
        : `${f.kind}:${f.status}`;
    m[key] = (m[key] ?? 0) + 1;
  }
  return m;
}

export function resolveAnalyticsActor(
  playerId: string,
  localPlayerId: string,
  rivalPlayerId: string | null
): AnalyticsActor {
  if (playerId === localPlayerId) return "human";
  if (rivalPlayerId !== null && playerId === rivalPlayerId) return "computer";
  return "unknown";
}

export class MatchAnalyticsRecorder {
  private meta: MatchAnalyticsMeta | null = null;
  private events: MatchAnalyticsRecord[] = [];
  private seq = 0;
  private dropped = 0;
  private readonly cap: number;

  constructor(cap = 120_000) {
    this.cap = cap;
  }

  begin(meta: MatchAnalyticsMeta): void {
    this.meta = meta;
    this.events = [{ kind: "session", seq: 0, meta }];
    this.seq = 0;
    this.dropped = 0;
  }

  getMeta(): MatchAnalyticsMeta | null {
    return this.meta;
  }

  stats(): { recorded: number; dropped: number; cap: number } {
    return { recorded: this.events.length, dropped: this.dropped, cap: this.cap };
  }

  clear(): void {
    if (this.meta) {
      this.begin(this.meta);
    } else {
      this.events = [];
      this.seq = 0;
      this.dropped = 0;
    }
  }

  private push(rec: MatchAnalyticsRecord): void {
    if (this.events.length >= this.cap) {
      this.dropped += 1;
      return;
    }
    this.events.push(rec);
  }

  recordCommand(
    cmd: GameCommand,
    actor: AnalyticsActor,
    simTickAtEnqueue: number
  ): void {
    if (!this.meta) return;
    this.seq += 1;
    this.push({
      kind: "command",
      seq: this.seq,
      simTickAtEnqueue,
      wallMs: cmd.issuedAtMs,
      actor,
      playerId: cmd.playerId,
      commandType: cmd.type,
      payload: sanitizeCommandPayload(cmd)
    });
  }

  recordTick(
    simTick: number,
    deltaSec: number,
    simEvents: readonly SimulationEvent[],
    feedback: readonly UiFeedbackEvent[]
  ): void {
    if (!this.meta) return;
    let combatHits = 0;
    let mineralGatherEvents = 0;
    const wallMs = Date.now();

    for (const ev of simEvents) {
      if (ev.type === "damage_dealt") {
        combatHits += 1;
        this.seq += 1;
        this.push({
          kind: "combat_hit",
          seq: this.seq,
          simTick,
          wallMs,
          attackerUnitId: ev.attackerUnitId,
          targetUnitId: ev.targetUnitId,
          targetStructureId: ev.targetStructureId,
          amount: ev.amount,
          attackClass: ev.attackClass,
          attackerKind: ev.attackerKind,
          defenderKind: ev.defenderKind,
          rpsMultiplier: ev.rpsMultiplier,
          baseDamage: ev.baseDamage,
          defenderHpBefore: ev.defenderHpBefore,
          defenderHpAfter: ev.defenderHpAfter,
          targetStructureKind: ev.targetStructureKind,
          structureHpBefore: ev.structureHpBefore,
          structureHpAfter: ev.structureHpAfter
        });
      } else if (ev.type === "resources_gathered") {
        mineralGatherEvents += 1;
        this.seq += 1;
        this.push({
          kind: "mineral_gathered",
          seq: this.seq,
          simTick,
          wallMs,
          playerId: ev.playerId,
          unitId: ev.unitId,
          amount: ev.amount
        });
      }
    }

    this.seq += 1;
    this.push({
      kind: "tick_frame",
      seq: this.seq,
      simTick,
      wallMs,
      deltaSec: round2(deltaSec),
      combatHits,
      mineralGatherEvents,
      feedbackSummary: summarizeFeedback(feedback)
    });
  }

  exportJson(): string {
    const payload: MatchAnalyticsExport = {
      exportVersion: MATCH_ANALYTICS_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      droppedEvents: this.dropped,
      cap: this.cap,
      meta: this.meta,
      events: this.events
    };
    return JSON.stringify(payload);
  }

  downloadJson(filenameHint: string): void {
    const blob = new Blob([this.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filenameHint.endsWith(".json") ? filenameHint : `${filenameHint}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
