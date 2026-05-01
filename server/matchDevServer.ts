/**
 * Development/jam authoritative PvP host: private 1v1 rooms, 20 Hz tick, WebSocket fan-out.
 * Browser clients (Phase 2): open the game with `?match=pvp` + `?matchWs=` (or dev default `ws://<host>:8788`).
 *
 * Run: `npm run match:dev`
 * Connect (e.g. wscat): `wscat -c ws://127.0.0.1:8788`
 *   → `{"type":"hello","seat":"p1"}` or `"p2"`
 *   → `{"type":"game_command","commandType":"noop"}`
 */
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createGameCommand, type GameCommandType } from "../src/core/commands/GameCommand";
import { createGameSession } from "../src/core/modes/ModeFactory";
import type { ClientMatchSetup } from "../src/core/match/clientMatch";
import { PLAYER_HUMAN, PLAYER_OPPONENT, type GameState } from "../src/core/state/GameState";

const PORT = Number(process.env.PORT || process.env.MATCH_DEV_PORT || 8788);
const TICK_HZ = 20;
const DEFAULT_ROOM_ID = "default";
const ROOM_IDLE_TTL_MS = 15 * 60_000;

const pvpSetup: ClientMatchSetup = {
  localPlayerId: PLAYER_HUMAN,
  kind: "player_vs_player",
  terrain: "sphere"
};

type SeatId = "p1" | "p2";
type MatchRoom = {
  id: string;
  session: ReturnType<typeof createGameSession>;
  state: GameState;
  sockets: Map<WebSocket, { seat: SeatId; hello: boolean }>;
  lastActiveMs: number;
};

const rooms = new Map<string, MatchRoom>();
const socketRoom = new Map<WebSocket, MatchRoom>();

function normalizeRoomId(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_ROOM_ID;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return cleaned || DEFAULT_ROOM_ID;
}

function createRoom(id: string): MatchRoom {
  const session = createGameSession("real_time", pvpSetup);
  let state = session.initialState;
  const w = session.mode.update(state, 1 / state.tickRateHz);
  state = w.state;
  return {
    id,
    session,
    state,
    sockets: new Map(),
    lastActiveMs: Date.now()
  };
}

function getRoom(id: string): MatchRoom {
  let room = rooms.get(id);
  if (!room) {
    room = createRoom(id);
    rooms.set(id, room);
  }
  return room;
}

function roomHasBothSeats(room: MatchRoom): boolean {
  let hasP1 = false;
  let hasP2 = false;
  for (const [ws, meta] of room.sockets) {
    if (!meta.hello || ws.readyState !== ws.OPEN) continue;
    if (meta.seat === PLAYER_HUMAN) hasP1 = true;
    if (meta.seat === PLAYER_OPPONENT) hasP2 = true;
  }
  return hasP1 && hasP2;
}

function roomSeatStatus(room: MatchRoom): { p1: boolean; p2: boolean } {
  let p1 = false;
  let p2 = false;
  for (const [ws, meta] of room.sockets) {
    if (!meta.hello || ws.readyState !== ws.OPEN) continue;
    if (meta.seat === PLAYER_HUMAN) p1 = true;
    if (meta.seat === PLAYER_OPPONENT) p2 = true;
  }
  return { p1, p2 };
}

function roomStatusPayload(room: MatchRoom): {
  room: string;
  roomReady: boolean;
  seats: { p1: boolean; p2: boolean };
} {
  return {
    room: room.id,
    roomReady: roomHasBothSeats(room),
    seats: roomSeatStatus(room)
  };
}

function seatIsOccupied(room: MatchRoom, seat: SeatId, requester: WebSocket): boolean {
  for (const [ws, meta] of room.sockets) {
    if (ws !== requester && meta.hello && meta.seat === seat && ws.readyState === ws.OPEN) {
      return true;
    }
  }
  return false;
}

function broadcast(room: MatchRoom, obj: unknown): void {
  const raw = JSON.stringify(obj);
  for (const [ws, meta] of room.sockets) {
    if (ws.readyState === ws.OPEN && meta.hello) ws.send(raw);
  }
}

function serializeGameState(s: GameState): unknown {
  return JSON.parse(
    JSON.stringify(s, (_k, v) => (v instanceof Uint8Array ? { __uint8: Array.from(v) } : v))
  );
}

const COMMAND_TYPES = new Set<string>([
  "select_units",
  "select_structures",
  "select_units_and_structures",
  "move_units",
  "queue_move_waypoint",
  "attack_move_units",
  "attack_unit",
  "attack_structure",
  "queue_structure_train",
  "place_structure",
  "gather_from_field",
  "deposit_at_structure",
  "stop_units",
  "queue_unit",
  "set_rally",
  "advance_age",
  "noop"
]);

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Moonrise Empire match server");
});

const wss = new WebSocketServer({ server, maxPayload: 262_144 });

server.on("error", (err) => {
  console.error("[match:dev] WebSocket server error:", err.message);
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`Port ${PORT} is in use — set PORT/MATCH_DEV_PORT or stop the other process.`);
  }
  process.exit(1);
});

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      ws.send(JSON.stringify({ type: "error", reason: "invalid_json" }));
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "hello") {
      const roomId = normalizeRoomId(m.room);
      const room = getRoom(roomId);
      room.sockets.set(ws, { seat: PLAYER_HUMAN, hello: false });
      socketRoom.set(ws, room);
      room.lastActiveMs = Date.now();
      const meta = room.sockets.get(ws)!;
      const requestedSeat = m.seat === PLAYER_OPPONENT || m.seat === "p2" ? PLAYER_OPPONENT : PLAYER_HUMAN;
      if (seatIsOccupied(room, requestedSeat, ws)) {
        ws.send(JSON.stringify({ type: "error", reason: `seat_occupied_${requestedSeat}` }));
        ws.close(1008, "seat occupied");
        return;
      }
      meta.seat = requestedSeat;
      meta.hello = true;
      ws.send(
        JSON.stringify({
          type: "hello_ok",
          seat: meta.seat,
          ...roomStatusPayload(room),
          tick: room.state.tick,
          matchId: room.state.matchId,
          victorPlayerId: room.state.victorPlayerId,
          state: serializeGameState(room.state),
          events: [],
          feedback: []
        })
      );
      broadcast(room, {
        type: "room_status",
        ...roomStatusPayload(room),
        tick: room.state.tick
      });
      return;
    }

    const room = socketRoom.get(ws);
    const meta = room?.sockets.get(ws);
    if (!room || !meta) {
      ws.send(JSON.stringify({ type: "error", reason: "send_hello_first" }));
      return;
    }

    if (!meta.hello) {
      ws.send(JSON.stringify({ type: "error", reason: "send_hello_first" }));
      return;
    }
    room.lastActiveMs = Date.now();

    if (m.type === "game_command") {
      const ct = m.commandType;
      if (typeof ct !== "string" || !COMMAND_TYPES.has(ct)) {
        ws.send(JSON.stringify({ type: "error", reason: "bad_command_type" }));
        return;
      }
      const payload =
        m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)
          ? (m.payload as Record<string, unknown>)
          : undefined;
      room.session.mode.submitCommand(
        createGameCommand(meta.seat, ct as GameCommandType, payload)
      );
      return;
    }

    if (m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", room: room.id, tick: room.state.tick }));
    }
  });

  ws.on("close", () => {
    const room = socketRoom.get(ws);
    if (room) {
      room.sockets.delete(ws);
      room.lastActiveMs = Date.now();
      broadcast(room, {
        type: "room_status",
        ...roomStatusPayload(room),
        tick: room.state.tick
      });
    }
    socketRoom.delete(ws);
  });
});

setInterval(() => {
  try {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (room.sockets.size === 0 && now - room.lastActiveMs > ROOM_IDLE_TTL_MS) {
        rooms.delete(id);
        continue;
      }
      if (!roomHasBothSeats(room)) {
        broadcast(room, {
          type: "tick",
          ...roomStatusPayload(room),
          tick: room.state.tick,
          state: serializeGameState(room.state),
          victorPlayerId: room.state.victorPlayerId,
          events: [],
          feedback: []
        });
        continue;
      }
      const tickHz = room.state.tickRateHz > 0 ? room.state.tickRateHz : TICK_HZ;
      const result = room.session.mode.update(room.state, 1 / tickHz);
      room.state = result.state;
      broadcast(room, {
        type: "tick",
        ...roomStatusPayload(room),
        tick: room.state.tick,
        state: serializeGameState(room.state),
        victorPlayerId: room.state.victorPlayerId,
        events: result.events,
        feedback: result.feedback
      });
    }
  } catch (err) {
    console.error("[match:dev] tick loop failed:", err);
  }
}, 1000 / TICK_HZ);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[match:dev] Authoritative PvP rooms listening on 0.0.0.0:${PORT} (${TICK_HZ} Hz) — try ws://127.0.0.1:${PORT} from this machine. ` +
      `Browser: Vite dev + ?match=pvp uses ws://<page-host>:8788 by default, or set VITE_MATCH_WS / ?matchWs=.`
  );
});
