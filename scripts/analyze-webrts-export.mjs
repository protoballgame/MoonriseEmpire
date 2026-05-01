#!/usr/bin/env node
/**
 * Reads WebRTS match analytics JSON export(s) and writes standalone HTML dashboard(s).
 *
 * Usage:
 *   node scripts/analyze-webrts-export.mjs
 *       → all *.json in ./match-exports (creates folder if missing)
 *   node scripts/analyze-webrts-export.mjs <dir>
 *       → all *.json in that folder
 *   node scripts/analyze-webrts-export.mjs <export.json> [out.html]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_EXPORT_DIR = path.join(ROOT, "match-exports");

const KINDS = ["R", "S", "P", "N"];

function emptyMatrix() {
  const m = {};
  for (const a of KINDS) {
    m[a] = {};
    for (const d of KINDS) m[a][d] = { hits: 0, damage: 0 };
  }
  return m;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPayload(inputPath, data) {
  const events = data.events ?? [];

  const matrix = emptyMatrix();
  let combatUnitHits = 0;
  let meleeHits = 0;
  let rangedHits = 0;
  const rpsMult = {};
  const timelineMap = new Map();

  for (const e of events) {
    if (e.kind === "combat_hit" && e.targetUnitId && e.attackerKind && e.defenderKind) {
      combatUnitHits += 1;
      if (e.attackClass === "melee") meleeHits += 1;
      else rangedHits += 1;
      const ak = e.attackerKind;
      const dk = e.defenderKind;
      if (matrix[ak]?.[dk]) {
        matrix[ak][dk].hits += 1;
        matrix[ak][dk].damage += e.amount ?? 0;
      }
      const m = e.rpsMultiplier;
      if (m != null) {
        const k = String(Math.round(m * 1e6) / 1e6);
        rpsMult[k] = (rpsMult[k] ?? 0) + 1;
      }
    }
    if (e.kind === "tick_frame") {
      const bucket = Math.floor(e.simTick / 2000) * 2000;
      const prev = timelineMap.get(bucket) ?? { combat: 0, gather: 0 };
      prev.combat += e.combatHits ?? 0;
      prev.gather += e.mineralGatherEvents ?? 0;
      timelineMap.set(bucket, prev);
    }
  }

  const commands = events.filter((e) => e.kind === "command");
  const byActor = {};
  const byCmdType = {};
  for (const c of commands) {
    byActor[c.actor] = (byActor[c.actor] ?? 0) + 1;
    byCmdType[c.commandType] = (byCmdType[c.commandType] ?? 0) + 1;
  }

  const minerals = {};
  for (const e of events) {
    if (e.kind === "mineral_gathered") {
      minerals[e.playerId] = (minerals[e.playerId] ?? 0) + e.amount;
    }
  }

  const structureHits = events.filter(
    (e) => e.kind === "combat_hit" && e.targetStructureId
  ).length;

  const timeline = [...timelineMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, v]) => ({ tick, ...v }));

  const rockRow = matrix.R;
  const rockTotalHits = KINDS.reduce((s, d) => s + rockRow[d].hits, 0);
  const rockToPaper = rockRow.P.hits;

  const insights = [];
  if (rockToPaper === 0 && rockTotalHits > 0) {
    insights.push({
      severity: "high",
      title: "Rock never hit Paper",
      detail: `Rock landed ${rockTotalHits} unit hits but 0 vs Paper (expected strong matchup). Likely melee pathing / crowding — Rocks could not reach enemy Paper.`
    });
  }
  if (matrix.S.R.damage > matrix.R.S.damage * 5) {
    insights.push({
      severity: "medium",
      title: "Scissors dominated Rock in output damage",
      detail: `S→R damage ${matrix.S.R.damage.toFixed(0)} vs R→S ${matrix.R.S.damage.toFixed(0)} — check range, focus fire, and whether Rocks were stuck.`
    });
  }

  return {
    file: path.basename(inputPath),
    exportMeta: {
      exportVersion: data.exportVersion,
      exportedAtMs: data.exportedAtMs,
      droppedEvents: data.droppedEvents,
      cap: data.cap
    },
    session: data.meta,
    summary: {
      totalEvents: events.length,
      combatUnitHits,
      structureHits,
      meleeHits,
      rangedHits,
      commandCount: commands.length,
      tickFrames: events.filter((e) => e.kind === "tick_frame").length
    },
    matrix,
    rpsMult,
    byActor,
    byCmdType: Object.fromEntries(
      Object.entries(byCmdType).sort((a, b) => b[1] - a[1])
    ),
    minerals,
    timeline,
    rockFocus: {
      totalHits: rockTotalHits,
      toPaper: rockToPaper,
      breakdown: Object.fromEntries(KINDS.map((d) => [d, rockRow[d]]))
    },
    insights
  };
}

function renderDashboardHtml(payload) {
  const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WebRTS match — ${escapeHtml(payload.file)}</title>
  <style>
    :root { --bg:#0c1018; --card:#151c2a; --text:#e8eef8; --muted:#8a9ab8; --accent:#6eb8ff; --good:#5ecf8a; --warn:#e8b44a; --bad:#ff7a7a; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height:1.5; }
    header { padding: 1.25rem 1.5rem; border-bottom: 1px solid #2a3548; background: linear-gradient(180deg, #121a28, var(--bg)); }
    h1 { margin:0 0 .35rem; font-size: 1.35rem; }
    .sub { color: var(--muted); font-size: .9rem; }
    main { padding: 1.25rem 1.5rem 3rem; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); margin-bottom: 1.5rem; }
    .card { background: var(--card); border: 1px solid #2a3548; border-radius: 10px; padding: 1rem; }
    .card h2 { margin: 0 0 .75rem; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; }
    .stat { font-size: 1.65rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .insight { border-left: 4px solid var(--accent); padding: .75rem 1rem; margin-bottom: .75rem; border-radius: 0 8px 8px 0; background: #1a2234; }
    .insight.high { border-color: var(--bad); }
    .insight.medium { border-color: var(--warn); }
    .insight h3 { margin: 0 0 .35rem; font-size: 1rem; }
    .insight p { margin: 0; color: var(--muted); font-size: .92rem; }
    table.matrix { width: 100%; border-collapse: collapse; font-size: .85rem; }
    table.matrix th, table.matrix td { padding: .45rem .6rem; text-align: right; border: 1px solid #2a3548; }
    table.matrix th:first-child, table.matrix td:first-child { text-align: left; }
    table.matrix thead th { background: #1e2838; }
    .chart-wrap { position: relative; height: 320px; margin-top: .5rem; }
    .two-col { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; }
    @media (max-width: 800px) { .two-col { grid-template-columns: 1fr; } }
    code { background: #1e2838; padding: .1em .35em; border-radius: 4px; font-size: .88em; }
  </style>
</head>
<body>
  <header>
    <h1>WebRTS match analytics</h1>
    <div class="sub">${escapeHtml(payload.file)} · generated ${new Date().toISOString()}</div>
  </header>
  <main>
    <p id="dash-status" class="sub" style="margin:0 0 1rem;padding:.5rem .75rem;background:#1a2234;border-radius:8px;border:1px solid #2a3548;">Loading dashboard…</p>
    <section class="grid" id="summary-cards"></section>

    <section class="card" style="margin-bottom:1rem;">
      <h2>Insights (auto)</h2>
      <div id="insights"></div>
    </section>

    <div class="two-col">
      <section class="card">
        <h2>Combat intensity (per ~2000 sim ticks)</h2>
        <div class="chart-wrap"><canvas id="chartTimeline"></canvas></div>
      </section>
      <section class="card">
        <h2>Commands by type</h2>
        <div class="chart-wrap"><canvas id="chartCmd"></canvas></div>
      </section>
    </div>

    <section class="card" style="margin-top:1rem;">
      <h2>Damage by attacker → defender (unit fights)</h2>
      <div class="chart-wrap" style="height:380px"><canvas id="chartPairs"></canvas></div>
    </section>

    <section class="card" style="margin-top:1rem;">
      <h2>Hit matrix (count / damage)</h2>
      <div id="matrix-table"></div>
    </section>

    <section class="card" style="margin-top:1rem;">
      <h2>RPS multiplier hits</h2>
      <p class="sub" style="margin:0 0 .5rem;color:var(--muted);font-size:.85rem;">φ strong / weak should appear as ~1.618 and ~0.618 in unit matchups.</p>
      <div class="chart-wrap" style="height:260px"><canvas id="chartRps"></canvas></div>
    </section>

    <section class="card" style="margin-top:1rem;">
      <h2>Rock (melee) breakdown</h2>
      <div id="rock-detail"></div>
    </section>
  </main>
  <script type="application/json" id="webrts-dash-data">${dataJson}</script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
  function escape(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function runDashboard() {
    const statusEl = document.getElementById("dash-status");
    let DATA;
    try {
      const raw = document.getElementById("webrts-dash-data").textContent;
      DATA = JSON.parse(raw);
    } catch (e) {
      if (statusEl) statusEl.textContent = "Failed to parse embedded data: " + e.message;
      return;
    }
    const sc = document.getElementById("summary-cards");
    if (!sc) return;
    const s = DATA.summary;
    const cards = [
      ["Sim ticks (approx)", "~" + (DATA.timeline.length ? DATA.timeline[DATA.timeline.length - 1].tick + 2000 : "—")],
      ["Unit combat hits", s.combatUnitHits],
      ["Melee / ranged hits", s.meleeHits + " / " + s.rangedHits],
      ["Structure hits", s.structureHits],
      ["Commands logged", s.commandCount],
      ["Human / CPU cmds", (DATA.byActor.human || 0) + " / " + (DATA.byActor.computer || 0)],
      ["p1 minerals gathered", Math.round((DATA.minerals.p1 || 0) * 10) / 10],
      ["p2 minerals gathered", Math.round((DATA.minerals.p2 || 0) * 10) / 10],
      ["Events dropped", DATA.exportMeta.droppedEvents || 0]
    ];
    sc.innerHTML = cards
      .map(
        ([t, v]) =>
          '<div class="card"><h2>' +
          escape(t) +
          '</h2><div class="stat">' +
          escape(String(v)) +
          "</div></div>"
      )
      .join("");

    const ins = document.getElementById("insights");
    if (!DATA.insights || !DATA.insights.length) {
      ins.innerHTML = '<p style="color:var(--muted)">No auto-flags. Skim charts for balance.</p>';
    } else {
      ins.innerHTML = DATA.insights
        .map(
          (i) =>
            '<div class="insight ' +
            i.severity +
            '"><h3>' +
            escape(i.title) +
            "</h3><p>" +
            escape(i.detail) +
            "</p></div>"
        )
        .join("");
    }

    const KINDS = ["R", "S", "P", "N"];
    let mhtml = '<table class="matrix"><thead><tr><th>Atk \\\\ Def</th>';
    for (const d of KINDS) mhtml += "<th>" + d + "</th>";
    mhtml += "</tr></thead><tbody>";
    for (const a of KINDS) {
      mhtml += "<tr><th>" + a + "</th>";
      for (const d of KINDS) {
        const c = DATA.matrix[a][d];
        mhtml +=
          "<td>" +
          c.hits +
          ' <span style="color:var(--muted)">/</span> ' +
          Math.round(c.damage) +
          "</td>";
      }
      mhtml += "</tr>";
    }
    mhtml += "</tbody></table>";
    document.getElementById("matrix-table").innerHTML = mhtml;

    const rf = DATA.rockFocus;
    let rockList = "";
    for (const d of KINDS) {
      const c = rf.breakdown[d];
      rockList +=
        "<li>vs " + d + ": " + c.hits + " hits, " + Math.round(c.damage) + " dmg</li>";
    }
    document.getElementById("rock-detail").innerHTML =
      "<p><strong>Total Rock hits:</strong> " +
      rf.totalHits +
      ". <strong>vs Paper:</strong> " +
      rf.toPaper +
      "</p>" +
      '<ul style="margin:.5rem 0 0 1rem;color:var(--muted)">' +
      rockList +
      "</ul>";

    if (typeof Chart === "undefined") {
      if (statusEl) {
        statusEl.innerHTML =
          "Tables above are complete. <strong>Charts need Chart.js</strong> (open this file online or allow the CDN script). Or run from a local server with network access.";
      }
      return;
    }

    const textColor = "#8a9ab8";
    const gridColor = "#2a3548";
    const legendColor = "#c8d4e8";
    const scaleOpts = {
      ticks: { color: textColor },
      grid: { color: gridColor }
    };

    const tl = DATA.timeline;
    new Chart(document.getElementById("chartTimeline"), {
      type: "line",
      data: {
        labels: tl.map((t) => "tick " + t.tick),
        datasets: [
          {
            label: "Combat hits (bucket)",
            data: tl.map((t) => t.combat),
            borderColor: "#e07a7a",
            tension: 0.15,
            fill: false
          },
          {
            label: "Mineral gather events",
            data: tl.map((t) => t.gather),
            borderColor: "#c9a45c",
            tension: 0.15,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: legendColor } } },
        scales: {
          x: { ticks: { color: textColor, maxRotation: 45 }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true }
        }
      }
    });

    const cmdEntries = Object.entries(DATA.byCmdType).slice(0, 14);
    new Chart(document.getElementById("chartCmd"), {
      type: "bar",
      data: {
        labels: cmdEntries.map(([k]) => k),
        datasets: [
          {
            label: "Count",
            data: cmdEntries.map(([, v]) => v),
            backgroundColor: "#4a8fd4"
          }
        ]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true },
          y: { ticks: { color: textColor }, grid: { color: gridColor } }
        }
      }
    });

    const pairLabels = [];
    const pairDmg = [];
    for (const a of KINDS) {
      for (const d of KINDS) {
        const cell = DATA.matrix[a][d];
        if (cell.damage > 0) {
          pairLabels.push(a + "→" + d);
          pairDmg.push(Math.round(cell.damage * 10) / 10);
        }
      }
    }
    const sorted = pairLabels
      .map((l, i) => ({ l, d: pairDmg[i] }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 16);
    new Chart(document.getElementById("chartPairs"), {
      type: "bar",
      data: {
        labels: sorted.map((x) => x.l),
        datasets: [
          {
            label: "Total damage",
            data: sorted.map((x) => x.d),
            backgroundColor: sorted.map((_, i) => "hsl(" + ((200 + i * 11) % 360) + ",55%,55%)")
          }
        ]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor } }
        }
      }
    });

    const rpsE = Object.entries(DATA.rpsMult);
    if (rpsE.length) {
      new Chart(document.getElementById("chartRps"), {
        type: "doughnut",
        data: {
          labels: rpsE.map(([k]) => "mult " + k),
          datasets: [
            {
              data: rpsE.map(([, v]) => v),
              backgroundColor: ["#5ecf8a", "#e8b44a", "#6eb8ff", "#c07ae0", "#e07a7a"]
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "right", labels: { color: legendColor } } }
        }
      });
    } else {
      const wrap = document.getElementById("chartRps").parentElement;
      wrap.innerHTML += '<p style="color:var(--muted)">No RPS multiplier data.</p>';
    }

    if (statusEl) statusEl.style.display = "none";
  }
  runDashboard();
  </script>
</body>
</html>`;
}

function analyzeExportFile(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Skip (invalid JSON): ${inputPath} — ${e.message}`);
    return false;
  }
  const payload = buildPayload(inputPath, data);
  const html = renderDashboardHtml(payload);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  console.log("Wrote", outputPath);
  return true;
}

function listJsonFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.json$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function runDirectory(dir) {
  const files = listJsonFiles(dir);
  if (!files.length) {
    console.error(`No .json files in ${dir}`);
    process.exit(1);
  }
  let ok = 0;
  for (const f of files) {
    const out = f.replace(/\.json$/i, "") + "-dashboard.html";
    if (analyzeExportFile(f, out)) ok += 1;
  }
  console.log(`Done: ${ok}/${files.length} dashboard(s).`);
  if (ok === 0) process.exit(1);
}

const arg1 = process.argv[2];
const arg2 = process.argv[3];

if (!arg1) {
  if (!fs.existsSync(DEFAULT_EXPORT_DIR)) {
    fs.mkdirSync(DEFAULT_EXPORT_DIR, { recursive: true });
    console.log(`Created ${DEFAULT_EXPORT_DIR}`);
    console.log("Drop *.json match exports there, then run this script again.");
    process.exit(0);
  }
  runDirectory(DEFAULT_EXPORT_DIR);
  process.exit(0);
}

const resolved = path.resolve(arg1);
if (!fs.existsSync(resolved)) {
  console.error(`Not found: ${resolved}`);
  console.error(
    "Usage: node scripts/analyze-webrts-export.mjs [dir|export.json] [out.html]"
  );
  process.exit(1);
}

const st = fs.statSync(resolved);
if (st.isDirectory()) {
  runDirectory(resolved);
} else {
  const out = arg2 || resolved.replace(/\.json$/i, "") + "-dashboard.html";
  if (!analyzeExportFile(resolved, out)) process.exit(1);
}
