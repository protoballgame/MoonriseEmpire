import "./style.css";
import { mountLaunchScreen } from "./game/launchScreen";

let gameStarting = false;

async function startGame(): Promise<void> {
  if (gameStarting) return;
  gameStarting = true;
  const appEl = document.getElementById("app");
  if (appEl) {
    appEl.setAttribute("aria-busy", "true");
  }
  const game = await import("./main");
  game.startGame();
  if (appEl) {
    appEl.removeAttribute("aria-busy");
  }
}

function main(): void {
  const appEl = document.getElementById("app");
  const launchRoot = document.getElementById("launch-root");
  if (!appEl) return;

  const q = new URLSearchParams(window.location.search);
  if (!q.get("match")?.trim() && launchRoot) {
    mountLaunchScreen(launchRoot, appEl, () => {
      void startGame();
    });
    return;
  }

  launchRoot?.remove();
  void startGame();
}

main();
