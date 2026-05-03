/**
 * Browser client for `npm run match:dev`: hello → receive `hello_ok` + `tick` payloads; send `game_command`.
 */
export function connectMatchAuthorityWs(options: {
  url: string;
  seat: "p1" | "p2";
  room?: string;
  onCommandsReady: () => void;
  onPush: (packet: {
    state?: unknown;
    events?: unknown;
    feedback?: unknown;
    roomReady?: boolean;
    seats?: { p1?: boolean; p2?: boolean };
  }) => void;
  onError: (reason: string) => void;
}): {
  close: () => void;
  sendGameCommand: (commandType: string, payload?: Record<string, unknown>) => void;
  get canSendCommands(): boolean;
} {
  let canSend = false;
  let userClosed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let ws: WebSocket | null = null;
  const pendingCommands: Array<{ commandType: string; payload?: Record<string, unknown> }> = [];
  const triedUrl = options.url;

  const flushPendingCommands = (): void => {
    if (!canSend || ws?.readyState !== WebSocket.OPEN) return;
    const batch = pendingCommands.splice(0, pendingCommands.length);
    for (const cmd of batch) {
      ws.send(JSON.stringify({ type: "game_command", commandType: cmd.commandType, payload: cmd.payload }));
    }
  };

  const connect = (): void => {
    if (userClosed) return;
    const socket = new WebSocket(options.url);
    ws = socket;

    socket.onopen = () => {
      reconnectAttempt = 0;
      socket.send(JSON.stringify({ type: "hello", seat: options.seat, room: options.room }));
    };

    socket.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        options.onError("invalid_json");
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type === "error") {
        options.onError(String(m.reason ?? "server_error"));
        return;
      }
      if (m.type === "room_status") {
        options.onPush({
          roomReady: m.roomReady === true,
          seats: parseSeatStatus(m.seats)
        });
        return;
      }
      if (m.type === "hello_ok") {
        canSend = true;
        options.onCommandsReady();
        flushPendingCommands();
        if (m.state != null) {
          options.onPush({
            state: m.state,
            events: m.events,
            feedback: m.feedback,
            roomReady: m.roomReady === true,
            seats: parseSeatStatus(m.seats)
          });
        }
        return;
      }
      if (m.type === "tick" && m.state != null) {
        options.onPush({
          state: m.state,
          events: m.events,
          feedback: m.feedback,
          roomReady: m.roomReady === true,
          seats: parseSeatStatus(m.seats)
        });
      }
    };

    /** `onerror` usually precedes `onclose`; use `onclose` for codes so the user sees one clear reason. */
    socket.onerror = () => {};

    socket.onclose = (ev: CloseEvent) => {
      if (userClosed || ws !== socket) return;
      canSend = false;
      const delayMs = Math.min(5000, 350 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      if (reconnectAttempt <= 2) {
        options.onError(
          `reconnecting (${triedUrl} · ws ${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`
        );
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };
  };

  connect();

  return {
    close: () => {
      userClosed = true;
      canSend = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
    sendGameCommand: (commandType: string, payload?: Record<string, unknown>) => {
      if (!canSend || ws?.readyState !== WebSocket.OPEN) {
        pendingCommands.push({ commandType, payload });
        if (pendingCommands.length > 128) pendingCommands.splice(0, pendingCommands.length - 128);
        return;
      }
      ws.send(JSON.stringify({ type: "game_command", commandType, payload }));
    },
    get canSendCommands(): boolean {
      return canSend && ws?.readyState === WebSocket.OPEN;
    }
  };
}

function parseSeatStatus(raw: unknown): { p1?: boolean; p2?: boolean } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    p1: r["p1"] === true,
    p2: r["p2"] === true
  };
}
