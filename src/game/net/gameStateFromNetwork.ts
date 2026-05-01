import type { GameState } from "../../core/state/GameState";

function uint8Reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "__uint8" in (value as object)) {
    const u = (value as { __uint8: number[] }).__uint8;
    if (!Array.isArray(u) || u.length > 5_000_000) {
      throw new Error("invalid_uint8_wire_payload");
    }
    return new Uint8Array(u);
  }
  return value;
}

function reviveUint8Deep(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const root = value as Record<string, unknown>;
  const stack: Array<Record<string, unknown> | unknown[]> = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) {
        const v = cur[i];
        const revived = uint8Reviver("", v);
        if (revived !== v) {
          cur[i] = revived;
          continue;
        }
        if (revived && typeof revived === "object") {
          stack.push(revived as Record<string, unknown> | unknown[]);
        }
      }
      continue;
    }
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      const revived = uint8Reviver(k, v);
      if (revived !== v) {
        cur[k] = revived;
        continue;
      }
      if (revived && typeof revived === "object") {
        stack.push(revived as Record<string, unknown> | unknown[]);
      }
    }
  }
  return value;
}

/** Rehydrates wire JSON from `match:dev` (Uint8Array as `{ __uint8: number[] }`) into a real `GameState`. */
export function reviveGameStateFromNetwork(wire: unknown): GameState {
  return reviveUint8Deep(wire) as GameState;
}
