# Hosting, PvP, and production deployment (design notes)

**Status:** Phase 2 landed for **dev authoritative PvP**: the browser can connect to `npm run match:dev`, send `GameCommand` over WebSocket, and apply server `tick` payloads (including exploration buffer revive). Production hardening (TLS-only, validation, shared countdown) remains future work — see phases below.

---

## Goals (locked in from discussion)

- **Lightweight:** small number of services, minimal ops.
- **Efficient:** static client on a CDN; game traffic on long-lived WebSockets where needed.
- **Secure:** server validates everything that matters; TLS everywhere in production.
- **Simple path to scale:** design so we are not stuck on one home machine if traffic spikes.
- **Provider preference:** **Cloudflare over AWS** for the public site and edge; avoid AWS-centric stacks unless something forces it.

---

## PvP architecture (target)

- **Authoritative server** (recommended default): clients send **intentions** as commands (same family as `GameCommand` today); the server **validates** (ownership, tick, costs, legality) and advances **one** canonical simulation (or relays + checksum only if we ever accept higher cheat risk).
- **Transport:** **`wss://` only** in production — never raw `ws://` on the open internet.
- **Auth:** short-lived **join tokens** per match; server enforces **seat** (`p1` / `p2`) and rate limits.
- **Lobby / countdown:** the in-client **5 → 1 → BEGIN!** countdown is **local only** (PvC / offline PvP). **Net PvP** shows **Connecting to match server…** until `hello_ok` + first state; a **shared** server-driven start is still Phase 3.

---

## What not to use for the game server

- **Typical shared cPanel / “PHP hosting”** (e.g. classic GoDaddy shared): built for short HTTP requests, not a long-lived WebSocket game process. Fine for **static files only** if needed, not for the match server.

---

## Home network and the Raspberry Pi idea

- **Exposing any host to the open internet increases attack surface** (scans, abuse, exploits in your server code or stack).
- **Linux Mint PC with valuable files:** prefer **not** to be the sole port-forwarded target. If it must run a server, isolate with **VLAN/guest network** and minimal open ports — still higher stakes than a dedicated box.
- **Raspberry Pi as the only public-facing game host:** reasonable **isolation** (blast radius is the Pi, not your main files), good for **friends / dev**. Use **64-bit Pi OS**, **Node LTS**, serve **`dist/`** + run the match process; prefer **USB/SSD** over SD for longevity.
- **“Could go viral” / thousands of concurrent players:** do **not** rely on a **home ISP + single Pi** for production. Consumer bandwidth, DDoS noise, and connection limits break first.

---

## Production-scale shape (viral / many players)

| Piece | Role |
|--------|------|
| **CDN + static hosting** | Built Vite client: global edge, HTTPS, absorbs junk traffic. |
| **Game nodes** | Container or VM processes running **Node + WebSocket + sim**; **scale out** (more instances) when load grows. |
| **Room routing (phase 2)** | When >1 game node: **Redis** (e.g. Upstash) or small API for “which instance holds match X.” |

---

## Cloudflare-first stack (preferred)

**Cloudflare should own:**

1. **Client:** **Cloudflare Pages** (deploy `dist/`) — CDN, HTTPS, DDoS mitigation at the edge, low ops.
2. **DNS + proxy:** orange-cloud hostnames; **WAF / rate limits** where applicable.
3. **Later optional:** **R2** (large assets/replays), **Workers** (tiny APIs like “create match id”), **Access** (private admin).

**Real-time match server — two acceptable patterns:**

1. **Mostly Cloudflare:** **Durable Objects + WebSockets** (one object ≈ one match). Fits if the **per-tick sim work stays within CF CPU/time limits**; profile early.
2. **Pragmatic “ship fast”:** small **Node** (authoritative sim) on **Fly.io, Hetzner VPS, Railway, Render**, etc., with **`wss://match…`** behind **Cloudflare’s proxy** (Cloudflare supports **WebSockets** to an origin). Still “Cloudflare in front of everything” for the domain; only compute is elsewhere.

**Security defaults:** TLS on all public endpoints; rate limiting; no SSH/admin exposed broadly; deploy via provider UI or VPN — not open RDP/SSH to the world.

---

## Cloudflare + GoDaddy cPanel deploy checklist

This repo now builds as a static Vite client with lazy-loaded game chunks:

1. Run `npm ci`, then `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
2. Upload the contents of `dist/` to GoDaddy cPanel `public_html/` (or a subdomain document root). Include hidden files like `.htaccess`.
3. In GoDaddy DNS, point the domain/subdomain to the cPanel site as usual, or delegate DNS to Cloudflare and create the matching DNS record there.
4. In Cloudflare, enable proxy/CDN for the web hostname and set SSL/TLS mode to **Full** if cPanel has a valid certificate.
5. Keep the browser client static on cPanel/CDN. Run the authoritative match server somewhere that supports long-lived Node WebSockets, then expose it as `wss://match.yourdomain.com`.
6. Build production PvP links with `?match=pvp&seat=p1|p2&matchWs=wss%3A%2F%2Fmatch.yourdomain.com`, or set `VITE_MATCH_WS=wss://match.yourdomain.com` before `npm run build`.

Static hosting files included:

- `public/_headers`: Cloudflare Pages-style security and cache headers if you deploy there later.
- `public/.htaccess`: cPanel/Apache SPA fallback plus long-cache headers for hashed assets.

Important: classic shared cPanel is fine for `dist/` but usually not for the match server. If GoDaddy’s cPanel plan has a real Node.js app feature with WebSocket support, it can host the match process; otherwise use a small VPS/container provider behind Cloudflare.

---

## Local development (before production)

- Run **static client** locally (`vite` / preview) and a **separate local Node WebSocket server**; point the client at `ws://localhost:…` in dev.
- **Pi or spare machine:** same deploy shape as production in miniature — good rehearsal, not the viral ceiling.

---

## Related code / docs

- Match kinds and URL params: `src/core/match/clientMatch.ts` (`?match=pvp|pvc`, `?seat=p1|p2`). WebSocket URL: `?matchWs=` / `?ws=`, or `VITE_MATCH_WS`, or Vite dev default for `?match=pvp` → `src/game/net/resolveMatchWebSocketUrl.ts`.
- Sim and commands: `ARCHITECTURE.md` (Match setup section).
- Match start overlay: `src/main.ts` (`MATCH_COUNTDOWN_SECONDS`, `?skipCountdown=1` for dev).

---

## Product direction (context)

Browser-first RTS for casual office play at scale; **PvC + PvP**; later **accounts**, **skill ranks / leaderboards**, **inventories** (cosmetics MTX). Keep each layer swappable: static client on a CDN, authoritative match process, small APIs for lobby/auth when you add them — **do not** bake account logic into the tick loop.

---

## Iteration order (recommended)

| Phase | Goal | Cloudflare / ops |
|--------|------|-------------------|
| **1 — Dev authoritative host** | One shared sim in Node; WebSocket fan-out; prove `GameCommand` + `RealTimeMode` off-browser. | N/A (localhost). **Done:** `npm run match:dev` → `server/matchDevServer.ts`. |
| **2 — Browser net client** | **Done (dev):** `?match=pvp` + `matchWs` / `VITE_MATCH_WS` / Vite dev default `ws://<host>:8788`; client stops local `mode.update`; commands over WS; apply `tick` + `hello_ok` state; revive `Uint8Array` exploration. | Still localhost or LAN; optional **Cloudflare Tunnel** to share a dev URL. |
| **3 — Hardening** | Rate limits, reject illegal commands, shared **match start** (no dual countdown), optional checksum. | Same. |
| **4 — Production game nodes** | Container/VPS **or** **Durable Objects** if tick CPU fits CF limits. | **Pages** = client; **orange-cloud** `wss://` to origin or DO; **Workers** later for “create match” tokens. |
| **5 — Accounts / meta** | Auth, leaderboards, cosmetics: separate **Workers + D1 / Postgres** (or small API), not inside the 20 Hz loop. | R2 for assets/replays if needed. |

**Next step:** Phase 3 — rate limits, stricter command validation, shared match start, optional checksums.

---

## Open work when resuming

- [x] Dev WebSocket match host (`match:dev`) + JSON state fan-out (see `server/matchDevServer.ts`).
- [x] Browser net mode: `matchWs` / `VITE_MATCH_WS`, command relay, `tick` + `hello_ok` apply, exploration buffer revive (`src/game/net/`, `src/main.ts`).
- [ ] Server-side command validation + tick contract with client (stricter than dev host).
- [ ] Lobby + ready + synchronized start (reuse or replace local-only countdown).
- [ ] Choose **Durable Objects** vs **Node origin behind Cloudflare** after profiling one real match tick on CF limits.
- [ ] Add Redis (or equivalent) when the second game instance ships.
- [ ] Accounts / cosmetics / leaderboards (out-of-band services).
