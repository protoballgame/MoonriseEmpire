import type { CreateMatchOptions, TerrainId } from "../state/GameState";
import { PLAYER_HUMAN, PLAYER_OPPONENT } from "../state/GameState";

/**
 * How this client relates to the other seat in a two-player skirmish.
 * - `player_vs_computer`: non-local seat is driven by `tickComputerOpponent`.
 * - `player_vs_player`: symmetric start; the second human is **remote**. Dev authoritative sync: `npm run match:dev`
 *   + `matchWs` / `VITE_MATCH_WS` (see `README.md`). No matchmaking or accounts yet.
 */
export type MatchKind = "player_vs_computer" | "player_vs_player";

/** Per-client match selection (browser URL today; host passes the same for a dedicated server later). */
export interface ClientMatchSetup {
  /** Player id this client issues commands for (`p1` northwest, `p2` southeast in the prototype). */
  localPlayerId: string;
  kind: MatchKind;
  /** Moon build: always sphere chart + globe presentation. Defaults to sphere for older tests/tools. */
  terrain?: TerrainId;
}

export function defaultClientMatchSetup(): ClientMatchSetup {
  return { localPlayerId: PLAYER_HUMAN, kind: "player_vs_computer", terrain: "sphere" };
}

/** The other fixed skirmish seat (`p1` ↔ `p2`), or null if `playerId` is unknown. */
export function otherSkirmishPlayerId(playerId: string): string | null {
  if (playerId === PLAYER_HUMAN) return PLAYER_OPPONENT;
  if (playerId === PLAYER_OPPONENT) return PLAYER_HUMAN;
  return null;
}

/**
 * `createMatchState` options derived from client setup.
 * PvC and PvP: symmetric start (Command Cores, one Solar Array each, fields). The AI builds and mines like a human.
 */
export function createMatchOptionsFromClientSetup(setup: ClientMatchSetup): CreateMatchOptions {
  return { economyBoostPlayerId: null, terrain: setup.terrain ?? "sphere" };
}

/**
 * Parse `?match=pvp|pvc` and `?seat=p1|p2` (or `2` for p2). Defaults: PvC, seat p1.
 */
export function parseClientMatchSetupFromLocationSearch(search: string): ClientMatchSetup {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const matchRaw = params.get("match");
  const kind: MatchKind = matchRaw === "pvp" ? "player_vs_player" : "player_vs_computer";
  const seat = params.get("seat");
  const localPlayerId =
    seat === "p2" || seat === "2" || seat === PLAYER_OPPONENT ? PLAYER_OPPONENT : PLAYER_HUMAN;
  const terrain: TerrainId = "sphere";
  return { localPlayerId, kind, terrain };
}
