/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Authoritative PvP match WebSocket URL (e.g. `wss://match.example.com` or `ws://127.0.0.1:8788`). */
  readonly VITE_MATCH_WS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
