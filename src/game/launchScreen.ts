/**
 * Full-screen mode picker: Vs CPU vs Vs Player, plus a copyable guest join URL for PvP dev play.
 * Skipped when `match` is already in the URL (e.g. shared join link).
 */

import * as THREE from "three";
import { setupMoonAtmosphere } from "./visual/moonEnvironment";
import { hostnameForMatchWebSocket, PUBLIC_MATCH_WS_FALLBACK } from "./net/resolveMatchWebSocketUrl";

function isLocalDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function buildGuestJoinUrl(
  hostForGuests: string,
  searchPreserved: URLSearchParams,
  matchWsUrl: string,
  roomId: string
): string {
  const parsed = parseHostPortInput(hostForGuests);
  const pageHost = parsed.host.length > 0 ? parsed.host : window.location.hostname;
  const pagePort = parsed.port ?? window.location.port;
  const port = pagePort ? `:${pagePort}` : "";
  const path = window.location.pathname || "/";
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const base =
    pageHost.trim().length > 0
      ? `${protocol}//${formatHostForHttpUrl(pageHost.trim())}${port}${path}`
      : `${window.location.origin}${path}`;
  const q = new URLSearchParams(searchPreserved);
  q.set("match", "pvp");
  q.set("seat", "p2");
  q.set("room", roomId);
  q.set("matchWs", matchWsUrl);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

function randomRoomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = Array.from(bytes).reduce((acc, b) => (acc << 8) ^ b, 0) >>> 0;
  return n.toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

function normalizeRoomCode(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32).toUpperCase();
}

function parseHostPortInput(raw: string): { host: string; port: string | null } {
  const value = raw.trim();
  if (value.length === 0) return { host: "", port: null };
  if (value.startsWith("[") && value.includes("]")) {
    const end = value.indexOf("]");
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(":") && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : null;
    return { host, port };
  }
  const parts = value.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? "")) {
    return { host: parts[0] ?? "", port: parts[1] ?? null };
  }
  return { host: value, port: null };
}

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function matchRoomsHttpUrl(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/rooms";
    url.search = `?t=${Date.now()}`;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function mountLaunchSkybox(launchRoot: HTMLElement): () => void {
  const canvasHost = document.createElement("div");
  canvasHost.className = "launch-screen__skybox";
  launchRoot.appendChild(canvasHost);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasHost.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  setupMoonAtmosphere(scene, renderer, { voidOnly: false });
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1800);
  camera.position.set(0, 0, 0.01);
  camera.lookAt(0, 0, -1);

  let raf = 0;
  const cosmos = scene.getObjectByName("moonSpaceCosmos");
  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  const animate = () => {
    raf = window.requestAnimationFrame(animate);
    if (cosmos) {
      cosmos.rotation.y += 0.00018;
      cosmos.rotation.x = Math.sin(performance.now() * 0.00005) * 0.035;
    }
    renderer.render(scene, camera);
  };
  window.addEventListener("resize", onResize);
  animate();

  return () => {
    window.cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat?.dispose();
      }
    });
    renderer.dispose();
    canvasHost.remove();
  };
}

/**
 * Renders the launch UI. Calls `onStartGame` after updating the URL and removing this layer.
 */
function preservedParamsMinusMatchSeat(): URLSearchParams {
  const q = new URLSearchParams(window.location.search);
  q.delete("match");
  q.delete("seat");
  q.delete("room");
  q.delete("matchWs");
  q.delete("ws");
  q.delete("mode");
  q.delete("moonModel");
  q.delete("moonModelScale");
  q.delete("moonTexture");
  return q;
}

export function mountLaunchScreen(launchRoot: HTMLElement, _appEl: HTMLElement, onStartGame: () => void): void {
  launchRoot.className = "launch-screen";
  launchRoot.innerHTML = `
    <div class="launch-screen__panel" role="dialog" aria-labelledby="launch-title">
      <p class="launch-screen__eyebrow">Studio Z 3D presents</p>
      <h1 class="launch-screen__title" id="launch-title">Moonrise Empire</h1>
      <p class="launch-screen__subtitle" id="launchSubtitle">A cozy lunar RTS - pick a match</p>
      <div class="launch-screen__pulse" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="launch-screen__actions" id="launchMainActions">
        <section class="launch-screen__mode-card">
          <div class="launch-screen__mode-info">
            <span class="launch-screen__mode-kicker">Network ops</span>
            <strong>Play vs Player</strong>
            <small>Prepare a host console and guest link for multiplayer.</small>
          </div>
          <button type="button" class="launch-screen__jump-btn" id="launchVsPvpExpand" aria-label="Configure player versus player">
            Play
          </button>
        </section>
        <section class="launch-screen__mode-card">
          <div class="launch-screen__mode-info">
            <span class="launch-screen__mode-kicker">Solo sortie</span>
            <strong>Play vs CPU</strong>
            <small>Launch a skirmish against the computer commander.</small>
          </div>
          <button type="button" class="launch-screen__jump-btn" id="launchVsCpu" aria-label="Play versus computer">
            Play
          </button>
        </section>
      </div>
      <div class="launch-screen__pvp" id="launchPvpSection" hidden>
        <p class="launch-screen__hint">
          Start a private 1v1 room, copy the invite link, and send it to your opponent. Host plays
          <strong>Player 1</strong> (blue); the invite joins as <strong>Player 2</strong> (red).
        </p>
        <p class="launch-screen__note" id="launchNetNote">Host a room, copy an invite, or join an open room below.</p>
        <div class="launch-screen__rooms" aria-live="polite">
          <div class="launch-screen__rooms-head">
            <strong>Open Rooms</strong>
            <button type="button" class="launch-screen__btn launch-screen__btn--mini" id="launchRefreshRooms">Refresh</button>
          </div>
          <div class="launch-screen__rooms-list" id="launchOpenRooms">Checking for rooms...</div>
        </div>
        <label class="launch-screen__label" for="launchRoomField">Room code</label>
        <div class="launch-screen__row">
          <input
            type="text"
            class="launch-screen__input launch-screen__input--mono launch-screen__room-input"
            id="launchRoomField"
            autocomplete="off"
            spellcheck="false"
            maxlength="32"
          />
          <button type="button" class="launch-screen__btn launch-screen__btn--primary" id="launchStartHost">
            Host Match
          </button>
          <button type="button" class="launch-screen__btn launch-screen__btn--ghost" id="launchJoinRoom">
            Join Room
          </button>
          <button type="button" class="launch-screen__btn launch-screen__btn--ghost" id="launchCopyJoin">Copy Invite</button>
        </div>
        <label class="launch-screen__label" for="launchJoinUrl">Invite link</label>
        <div class="launch-screen__row">
          <input type="text" class="launch-screen__input launch-screen__input--mono" id="launchJoinUrl" readonly />
        </div>
        <label class="launch-screen__label" for="launchJoinPaste">Join from invite link</label>
        <div class="launch-screen__row">
          <input type="text" class="launch-screen__input launch-screen__input--mono" id="launchJoinPaste" placeholder="Paste invite link here" />
          <button type="button" class="launch-screen__btn launch-screen__btn--ghost" id="launchJoinPasted">
            Join
          </button>
        </div>
        <details class="launch-screen__advanced">
          <summary>Advanced / LAN setup</summary>
          <label class="launch-screen__label" for="launchHostField">Address guests should open</label>
          <div class="launch-screen__row">
            <input
              type="text"
              class="launch-screen__input"
              id="launchHostField"
              autocomplete="off"
              spellcheck="false"
              placeholder="e.g. 192.168.1.50 or game.example.com"
              aria-describedby="launchHostHelp"
            />
            <button type="button" class="launch-screen__btn launch-screen__btn--ghost" id="launchFetchPublicIp" title="Looks up your public IPv4 (office networks may block this)">
              Use public IP
            </button>
          </div>
          <p class="launch-screen__help" id="launchHostHelp">
            Optional: override the address used when copying invite links for LAN testing.
          </p>
        </details>
      </div>
      <footer class="launch-screen__footer">
        <span>Moonrise Empire by Studio Z 3D / Real-time mode / jam build</span>
        <span>Copyright (c) 2026 Studio Z 3D. All rights reserved.</span>
        <span>
          Panel styling inspired by
          <a href="https://codepen.io/Margarita-the-solid/pen/qENzBWN" target="_blank" rel="noreferrer">Skeuomorphic spacecraft control panel</a>.
        </span>
      </footer>
    </div>
  `;
  const disposeSkybox = mountLaunchSkybox(launchRoot);

  const hostField = launchRoot.querySelector<HTMLInputElement>("#launchHostField")!;
  const roomField = launchRoot.querySelector<HTMLInputElement>("#launchRoomField")!;
  const joinUrlEl = launchRoot.querySelector<HTMLInputElement>("#launchJoinUrl")!;
  const joinPasteEl = launchRoot.querySelector<HTMLInputElement>("#launchJoinPaste")!;
  const openRoomsEl = launchRoot.querySelector<HTMLElement>("#launchOpenRooms")!;
  const pvpSection = launchRoot.querySelector<HTMLElement>("#launchPvpSection")!;
  const pvpTerrain = "sphere" as const;
  let roomId = normalizeRoomCode(new URLSearchParams(window.location.search).get("room") ?? "") || randomRoomCode();
  roomField.value = roomId;

  if (!isLocalDevHost(window.location.hostname)) {
    hostField.value = window.location.hostname;
  }

  function writeSearchAndStart(q: URLSearchParams): void {
    const path = window.location.pathname || "/";
    const s = q.toString();
    history.replaceState(null, "", s ? `${path}?${s}` : path);
    disposeSkybox();
    launchRoot.remove();
    onStartGame();
  }
  function matchServerWsUrl(): string {
    const configured =
      typeof import.meta.env !== "undefined" && typeof import.meta.env.VITE_MATCH_WS === "string"
        ? import.meta.env.VITE_MATCH_WS.trim()
        : "";
    if (configured) return configured;
    if (typeof import.meta.env === "undefined" || !import.meta.env.DEV) return PUBLIC_MATCH_WS_FALLBACK;
    const raw = hostField.value.trim() || window.location.hostname;
    const h = hostnameForMatchWebSocket(parseHostPortInput(raw).host);
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${wsProto}://${h}:8788`;
  }

  function localHostMatchServerWsUrl(): string {
    return "ws://127.0.0.1:8788";
  }

  function refreshJoinUrl(): void {
    roomId = normalizeRoomCode(roomField.value) || roomId || randomRoomCode();
    roomField.value = roomId;
    const wsUrl = matchServerWsUrl();
    const q = preservedParamsMinusMatchSeat();
    q.set("terrain", "sphere");
    const guestUrl = buildGuestJoinUrl(hostField.value, q, wsUrl, roomId);
    joinUrlEl.value = guestUrl;
  }

  type OpenRoom = {
    room?: unknown;
    seats?: { p1?: unknown; p2?: unknown };
    waitingFor?: unknown;
  };

  async function refreshOpenRooms(): Promise<void> {
    const roomsUrl = matchRoomsHttpUrl(matchServerWsUrl());
    if (!roomsUrl) {
      openRoomsEl.textContent = "Room list unavailable.";
      return;
    }
    openRoomsEl.textContent = "Checking for rooms...";
    try {
      const res = await fetch(roomsUrl);
      if (!res.ok) throw new Error(`rooms_${res.status}`);
      const data = (await res.json()) as { rooms?: OpenRoom[] };
      const rooms = Array.isArray(data.rooms) ? data.rooms : [];
      if (rooms.length === 0) {
        openRoomsEl.innerHTML = `<p class="launch-screen__rooms-empty">No rooms waiting right now. Host one and others will see it here.</p>`;
        return;
      }
      openRoomsEl.replaceChildren(
        ...rooms.map((entry) => {
          const code = normalizeRoomCode(String(entry.room ?? ""));
          const waitingFor = entry.waitingFor === "p1" ? "p1" : "p2";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "launch-screen__room-row";
          btn.innerHTML = `<span class="launch-screen__room-code">${code}</span><span class="launch-screen__room-status">Join as ${waitingFor.toUpperCase()}</span>`;
          btn.addEventListener("click", () => {
            roomField.value = code;
            roomId = code;
            refreshJoinUrl();
            const q = preservedParamsMinusMatchSeat();
            q.set("match", "pvp");
            q.set("seat", waitingFor);
            q.set("room", roomId);
            q.set("matchWs", matchServerWsUrl());
            q.set("terrain", pvpTerrain);
            writeSearchAndStart(q);
          });
          return btn;
        })
      );
    } catch {
      openRoomsEl.innerHTML = `<p class="launch-screen__rooms-empty">Could not reach the room list. You can still host or join by room code.</p>`;
    }
  }

  refreshJoinUrl();
  hostField.addEventListener("input", refreshJoinUrl);
  roomField.addEventListener("input", () => {
    roomId = normalizeRoomCode(roomField.value);
    roomField.value = roomId;
    refreshJoinUrl();
  });

  let publicIpFetchInFlight = false;
  async function autofillPublicIp(preferOverwrite = false): Promise<void> {
    if (publicIpFetchInFlight) return;
    const current = hostField.value.trim();
    const shouldWrite =
      preferOverwrite ||
      current.length === 0 ||
      isLocalDevHost(current) ||
      current === "localhost" ||
      current === "127.0.0.1";
    if (!shouldWrite) return;
    publicIpFetchInFlight = true;
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const j = (await r.json()) as { ip?: string };
      if (j.ip) {
        hostField.value = j.ip;
        refreshJoinUrl();
      }
    } catch {
      // Keep existing host as-is when WAN lookup fails.
    } finally {
      publicIpFetchInFlight = false;
    }
  }

  launchRoot.querySelector("#launchVsCpu")!.addEventListener("click", () => {
    const q = preservedParamsMinusMatchSeat();
    q.set("match", "pvc");
    q.set("terrain", "sphere");
    writeSearchAndStart(q);
  });

  launchRoot.querySelector("#launchVsPvpExpand")!.addEventListener("click", () => {
    pvpSection.hidden = false;
    refreshJoinUrl();
    void refreshOpenRooms();
    void autofillPublicIp();
    joinUrlEl.focus();
  });

  launchRoot.querySelector("#launchRefreshRooms")!.addEventListener("click", () => {
    void refreshOpenRooms();
  });

  launchRoot.querySelector("#launchCopyJoin")!.addEventListener("click", async () => {
    refreshJoinUrl();
    try {
      await navigator.clipboard.writeText(joinUrlEl.value);
      const btn = launchRoot.querySelector<HTMLButtonElement>("#launchCopyJoin")!;
      const t = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = t;
      }, 1600);
    } catch {
      joinUrlEl.select();
      document.execCommand("copy");
    }
  });

  launchRoot.querySelector("#launchFetchPublicIp")!.addEventListener("click", async () => {
    const btn = launchRoot.querySelector<HTMLButtonElement>("#launchFetchPublicIp")!;
    btn.disabled = true;
    try {
      await autofillPublicIp(true);
    } catch {
      hostField.placeholder = "Could not fetch — type your IP manually";
    } finally {
      btn.disabled = false;
    }
  });

  launchRoot.querySelector("#launchJoinPasted")!.addEventListener("click", () => {
    const raw = joinPasteEl.value.trim();
    if (!raw) return;
    try {
      const parsed = new URL(raw, window.location.href);
      history.replaceState(null, "", `${parsed.pathname}${parsed.search}`);
      disposeSkybox();
      launchRoot.remove();
      onStartGame();
    } catch {
      joinPasteEl.select();
    }
  });

  launchRoot.querySelector("#launchJoinRoom")!.addEventListener("click", () => {
    refreshJoinUrl();
    const wsUrl = matchServerWsUrl();
    const q = preservedParamsMinusMatchSeat();
    q.set("match", "pvp");
    q.set("seat", "p2");
    q.set("room", roomId);
    q.set("matchWs", wsUrl);
    q.set("terrain", pvpTerrain);
    writeSearchAndStart(q);
  });

  launchRoot.querySelector("#launchStartHost")!.addEventListener("click", () => {
    // Local dev hosts use the local authority process; published builds use the public match service.
    const wsUrl =
      typeof import.meta.env !== "undefined" && import.meta.env.DEV && isLocalDevHost(window.location.hostname)
        ? localHostMatchServerWsUrl()
        : matchServerWsUrl();
    const q = preservedParamsMinusMatchSeat();
    q.set("match", "pvp");
    q.set("seat", "p1");
    refreshJoinUrl();
    q.set("room", roomId);
    q.set("matchWs", wsUrl);
    q.set("terrain", pvpTerrain);
    writeSearchAndStart(q);
  });

}
