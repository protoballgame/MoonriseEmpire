# Moonrise Empire

Browser-first WebGL RTS by Studio Z 3D (Vite + TypeScript + Three.js). Electron can wrap the same `dist/` output.

Copyright (c) 2026 Studio Z 3D. All rights reserved.

## Prerequisites

- Node.js 20+ recommended
- `npm install`

## Run locally

### Vs computer (single browser)

```bash
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`). Use the launch screen **Play vs computer**, or open with `?match=pvc`.

### Vs player (authoritative PvP, jam rooms)

You need **two processes**: the static/game client and the match server.

1. **Terminal A — match server** (20 Hz sim, WebSocket on port **8788** by default):

   ```bash
   npm run match:dev
   ```

2. **Terminal B — Vite client** (`--host` so LAN guests can connect):

   ```bash
   npm run dev
   ```

3. **Host**: open the app, choose **Play vs player**, enter or keep the generated room code, then **Host Match** and copy the invite link. The host connects to the local match server, while the copied guest URL includes `match=pvp`, `seat=p2`, `room=<code>`, and `matchWs=ws://<that-host>:8788`.

4. **Guest**: open the copied **Guest join link**, paste it into **Join from invite link**, or enter the same room code and click **Join Room**. The room stays at **Waiting for opponent…** and the simulation does not advance until both players are connected.

**Scale note:** the jam match server supports multiple private 1v1 rooms in one process, but it is not public matchmaking infrastructure. For hundreds of players, run a production WebSocket host, add matchmaking/lobbies, reconnect handling, metrics, room limits, and reduce network payloads instead of broadcasting the full state every tick.

**Vite dev shortcut:** if you open PvP with `?match=pvp` but omit `matchWs`, the client defaults to `ws://<page-hostname>:8788` (so `localhost` → `ws://localhost:8788`). If `room` is omitted, the server uses a backwards-compatible default room. LAN guests still need `matchWs` aimed at the host machine’s IP.

**If you see `connect_failed`:** keep `npm run match:dev` running, and do **not** open the game at `http://0.0.0.0:5173` — use `http://localhost:5173` or your LAN IP. Outbound WebSockets cannot target `0.0.0.0`; the client now maps that case to `127.0.0.1` when building the default URL.

**Production / `npm run build`:** there is no dev default. Set `VITE_MATCH_WS` at build time (see `.env.example`) or put `matchWs` on every PvP URL. Use **`wss://`** behind HTTPS.

**Windows — `Launch Test.bat`:** still supported. It runs `npm run build`, then starts **Vite dev**, **`npm run serve`**, and **`npm run match:dev`** as background jobs so PvP has the match server without a second manual terminal. Press Enter in that window to stop all three.

## Useful query parameters

| Param | Purpose |
|--------|---------|
| `match=pvp` / `match=pvc` | Player vs player / vs computer |
| `seat=p1` / `seat=p2` | Which seat this browser plays |
| `room` | Private PvP room code; omitted links use the default room |
| `matchWs` / `ws` | WebSocket URL for authoritative PvP |
| `mode=turn` | Deprecated prototype flag; jam build forces real-time mode |
| `skipCountdown=1` | Skip local begin countdown (offline / non–net PvP only) |

## Other scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Production client bundle to `dist/` |
| `npm run serve` | Serve `dist/` with Helmet + CSP |
| `npm test` | Vitest |
| `npm run typecheck` | TypeScript no-emit check |
| `npm run electron:dev` / `electron:build` | Desktop wrapper |

## Docs

- `ARCHITECTURE.md` — core vs mode vs view layout
- `HOSTING_AND_MULTIPLAYER.md` — PvP phases, Cloudflare/cPanel deployment, security notes
- `COMBAT_AND_MOVEMENT.md` — sim combat details
- `PROGRESS.md` — session log
