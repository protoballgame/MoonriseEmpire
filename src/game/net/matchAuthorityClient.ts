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
  const ws = new WebSocket(options.url);
  const triedUrl = options.url;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", seat: options.seat, room: options.room }));
  };

  ws.onmessage = (ev) => {
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
  ws.onerror = () => {};

  ws.onclose = (ev: CloseEvent) => {
    if (userClosed) return;
    if (canSend) {
      options.onError(`disconnected (${triedUrl} · ws ${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      return;
    }
    options.onError(
      `connect_failed url=${triedUrl} · ws_close=${ev.code}` +
        (ev.reason ? ` · ${ev.reason}` : "") +
        " · (is npm run match:dev up on that port?)"
    );
  };

  return {
    close: () => {
      userClosed = true;
      canSend = false;
      ws.close();
    },
    sendGameCommand: (commandType: string, payload?: Record<string, unknown>) => {
      if (!canSend || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "game_command", commandType, payload }));
    },
    get canSendCommands(): boolean {
      return canSend && ws.readyState === WebSocket.OPEN;
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
