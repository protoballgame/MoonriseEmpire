#!/usr/bin/env node
/**
 * Runs analyze-webrts-export.mjs, then opens a dashboard in the default browser.
 *
 * With no args: analyzes all *.json in ./match-exports, opens the newest *-dashboard.html.
 *
 * Usage:
 *   node scripts/open-match-dashboard.mjs
 *   node scripts/open-match-dashboard.mjs <dir>
 *   node scripts/open-match-dashboard.mjs <export.json> [output.html]
 *
 *   npm run analyze-match:open
 *   npm run analyze-match:open -- <dir|export.json> [output.html]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const analyzeScript = path.join(root, "scripts", "analyze-webrts-export.mjs");
const defaultExportDir = path.join(root, "match-exports");

const inputArg = process.argv[2];
const outputArg = process.argv[3];

function openPath(filePath) {
  const abs = path.resolve(filePath);
  const opts = { detached: true, stdio: "ignore" };

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", abs], { ...opts, windowsHide: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [abs], opts).unref();
  } else {
    spawn("xdg-open", [abs], opts).unref();
  }
}

function findNewestDashboard(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const dashboards = names.filter((n) => n.endsWith("-dashboard.html"));
  if (!dashboards.length) return null;
  let best = null;
  let bestM = 0;
  for (const n of dashboards) {
    const p = path.join(dir, n);
    const m = fs.statSync(p).mtimeMs;
    if (m > bestM) {
      bestM = m;
      best = p;
    }
  }
  return best;
}

const target = inputArg ? path.resolve(inputArg) : defaultExportDir;
const isDir =
  fs.existsSync(target) && fs.statSync(target).isDirectory();

const analyzeArgs = [analyzeScript];
if (inputArg) {
  analyzeArgs.push(target);
  if (!isDir && outputArg) analyzeArgs.push(path.resolve(outputArg));
} else {
  // Default: analyzer uses match-exports with no argv
}

const result = spawnSync(process.execPath, analyzeArgs, {
  stdio: "inherit",
  cwd: root,
});

if (result.status !== 0 && result.status != null) {
  process.exit(result.status);
}
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

let toOpen;
if (isDir) {
  toOpen = findNewestDashboard(target);
  if (!toOpen) {
    console.error(`No *-dashboard.html found in ${target} (run analysis on .json exports first).`);
    process.exit(1);
  }
} else if (inputArg) {
  const jsonPath = target;
  toOpen = outputArg
    ? path.resolve(outputArg)
    : jsonPath.replace(/\.json$/i, "") + "-dashboard.html";
} else {
  toOpen = findNewestDashboard(defaultExportDir);
  if (!toOpen) {
    console.error(
      `No dashboard in ${defaultExportDir}. Add *.json exports and run again (first run may have only created the folder).`
    );
    process.exit(1);
  }
}

if (!fs.existsSync(toOpen)) {
  console.error(`Expected dashboard was not written: ${toOpen}`);
  process.exit(1);
}

openPath(toOpen);
console.log(`Opened: ${toOpen}`);
