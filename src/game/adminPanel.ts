import { applyTuningStatsToAllUnits } from "../core/applyLiveUnitStats";
import type { MilitaryKind } from "../core/militaryKinds";
import type { FormationId, RuntimeTuning, UnitTuningRow } from "../core/runtimeTuning";
import { resetTuningToDefaults, tuning } from "../core/runtimeTuning";
import type { GameState } from "../core/state/GameState";

export interface RuntimeAdminPanelOptions {
  getGameState: () => GameState;
  setGameState: (state: GameState) => void;
  onVisibilityChange?: (open: boolean) => void;
  /** Full match restart: fresh map state (does not reset runtime tuning — use “Reset all to defaults” for that). */
  resetMatchToInitial?: () => void;
  /** Match analytics: commands, combat math (RPS), gathers, per-frame summaries — export JSON for balance / fan metrics. */
  matchAnalytics?: {
    getStats: () => { recorded: number; dropped: number; cap: number };
    exportMatchLog: () => void;
    clear: () => void;
  };
}

const FORMATIONS: FormationId[] = ["none", "square", "circle", "triangle"];

function num(
  label: string,
  value: number,
  onChange: (n: number) => void,
  attrs: { step?: string; min?: string; hint?: string } = {}
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "admin-field";
  if (attrs.hint) {
    wrap.title = attrs.hint;
    wrap.classList.add("admin-field--hint");
  }
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = attrs.step ?? "any";
  if (attrs.min !== undefined) input.min = attrs.min;
  input.value = String(value);
  input.addEventListener("change", () => {
    const n = parseFloat(input.value);
    if (Number.isFinite(n)) onChange(n);
  });
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function intField(
  label: string,
  value: number,
  onChange: (n: number) => void,
  min: number,
  hint?: string
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "admin-field";
  if (hint) {
    wrap.title = hint;
    wrap.classList.add("admin-field--hint");
  }
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.min = String(min);
  input.value = String(value);
  input.addEventListener("change", () => {
    const n = parseInt(input.value, 10);
    if (Number.isFinite(n)) onChange(n);
  });
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function selectFormation(
  label: string,
  value: FormationId,
  onChange: (v: FormationId) => void,
  hint?: string
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "admin-field";
  if (hint) {
    wrap.title = hint;
    wrap.classList.add("admin-field--hint");
  }
  const span = document.createElement("span");
  span.textContent = label;
  const sel = document.createElement("select");
  for (const f of FORMATIONS) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    if (f === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value as FormationId));
  wrap.appendChild(span);
  wrap.appendChild(sel);
  return wrap;
}

function selectAttackClass(
  label: string,
  value: UnitTuningRow["attackClass"],
  onChange: (v: UnitTuningRow["attackClass"]) => void,
  hint?: string
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "admin-field";
  if (hint) {
    wrap.title = hint;
    wrap.classList.add("admin-field--hint");
  }
  const span = document.createElement("span");
  span.textContent = label;
  const sel = document.createElement("select");
  for (const c of ["melee", "ranged"] as const) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value as UnitTuningRow["attackClass"]));
  wrap.appendChild(span);
  wrap.appendChild(sel);
  return wrap;
}

function fieldset(title: string, legendHint?: string): { el: HTMLFieldSetElement; body: HTMLDivElement } {
  const fs = document.createElement("fieldset");
  fs.className = "admin-fieldset";
  const leg = document.createElement("legend");
  leg.textContent = title;
  if (legendHint) leg.title = legendHint;
  const body = document.createElement("div");
  body.className = "admin-fieldset-body";
  fs.appendChild(leg);
  fs.appendChild(body);
  return { el: fs, body };
}

function unitBlock(kind: MilitaryKind, body: HTMLDivElement): void {
  const sub = document.createElement("div");
  sub.className = "admin-subblock";
  sub.innerHTML = `<h4 class="admin-h4">Unit ${kind}</h4>`;
  const u = tuning.units[kind];
  const add = (n: HTMLLabelElement) => {
    sub.appendChild(n);
  };
  add(
    num("HP", u.hp, (v) => {
      tuning.units[kind].hp = v;
    })
  );
  add(
    num("Speed", u.speed, (v) => {
      tuning.units[kind].speed = v;
    })
  );
  add(
    num("Range", u.range, (v) => {
      tuning.units[kind].range = v;
    }, {
      hint: "Attack reach in world units. Larger = can shoot/swing from farther (ranged uses high range)."
    })
  );
  add(
    num("Vision range", u.visionRange, (v) => {
      tuning.units[kind].visionRange = v;
    }, {
      hint: "Sight circle for fog-of-war, exploration, and debug overlay."
    })
  );
  add(
    num("Damage", u.damage, (v) => {
      tuning.units[kind].damage = v;
    })
  );
  add(
    num("Cooldown (s)", u.cooldown, (v) => {
      tuning.units[kind].cooldown = v;
    })
  );
  add(
    selectAttackClass(
      "Attack class",
      u.attackClass,
      (v) => {
        tuning.units[kind].attackClass = v;
      },
      "Label for future projectiles. Combat is still instant hit when in range."
    )
  );
  body.appendChild(sub);
}

/**
 * Dev-only tuning UI: edits the shared `tuning` object (F10 or Backquote to toggle).
 */
export function mountRuntimeTuningPanel(parent: HTMLElement, options: RuntimeAdminPanelOptions): () => void {
  const root = document.createElement("div");
  root.className = "runtime-admin-panel";
  root.style.display = "none";
  root.innerHTML = `
    <header class="admin-header"><strong>Runtime tuning</strong><span class="admin-hint">F10 / \`</span></header>
    <p class="admin-viz-hint">Map: cyan ring = vision · orange = attack range (live unit stats; use Apply if you edited the table).</p>
  `;

  const scroll = document.createElement("div");
  scroll.className = "admin-scroll";
  root.appendChild(scroll);

  function rebuild(): void {
    scroll.innerHTML = "";
    const t: RuntimeTuning = tuning;

    {
      const { el, body } = fieldset(
        "Combat (RPS)",
        "Rock beats Scissors, Scissors beats Paper, Paper beats Rock."
      );
      body.appendChild(
        num("Strong mult", t.combat.rpsStrongMultiplier, (v) => {
          t.combat.rpsStrongMultiplier = v;
        }, {
          hint: "Damage multiplier when the attacker wins RPS (e.g. Rock vs Scissors)."
        })
      );
      body.appendChild(
        num("Weak mult", t.combat.rpsWeakMultiplier, (v) => {
          t.combat.rpsWeakMultiplier = v;
        }, {
          hint: "Multiplier when the attacker loses RPS (e.g. Rock vs Paper)."
        })
      );
      scroll.appendChild(el);
    }

    {
      const { el, body } = fieldset("Units");
      for (const k of ["R", "S", "P", "N"] as MilitaryKind[]) {
        unitBlock(k, body);
      }
      scroll.appendChild(el);
    }

    {
      const { el, body } = fieldset(
        "Collision",
        "After movement, units closer than min distance are nud apart on the ground plane."
      );
      body.appendChild(
        num("Min center distance", t.collision.minCenterDistance, (v) => {
          t.collision.minCenterDistance = v;
        }, {
          hint: "Minimum XZ distance between unit centers before overlap resolution pushes them apart."
        })
      );
      body.appendChild(
        intField(
          "Resolve passes",
          t.collision.resolvePasses,
          (v) => {
            t.collision.resolvePasses = Math.max(1, v);
          },
          1,
          "How many times per tick to run the pairwise push pass (more = stiffer separation)."
        )
      );
      body.appendChild(
        num("Push factor", t.collision.pushFactor, (v) => {
          t.collision.pushFactor = v;
        }, {
          hint: "Fraction of overlap corrected each sub-step (0–1 typical)."
        })
      );
      scroll.appendChild(el);
    }

    {
      const { el, body } = fieldset(
        "Formation (default for move)",
        "Used when you move or attack-move; V cycles the default. Triangle apex points toward the click."
      );
      body.appendChild(
        selectFormation(
          "Active formation",
          t.formation.active,
          (v) => {
            t.formation.active = v;
          },
          "Shape used for the next move orders unless overridden later."
        )
      );
      body.appendChild(
        num("Spacing", t.formation.spacing, (v) => {
          t.formation.spacing = v;
        }, { hint: "Distance between adjacent slots in square / triangle layouts." })
      );
      body.appendChild(
        num("Circle radius ×√n", t.formation.circleRadiusPerSqrtUnit, (v) => {
          t.formation.circleRadiusPerSqrtUnit = v;
        }, {
          hint: "Ring radius scales as spacing × this factor × √(unit count)."
        })
      );
      body.appendChild(
        num("Triangle apex lead", t.formation.triangleApexLead, (v) => {
          t.formation.triangleApexLead = v;
        }, {
          hint: "How far the front point sits past the click, in spacing units."
        })
      );
      scroll.appendChild(el);
    }

    {
      const { el, body } = fieldset(
        "Camera (prototype view)",
          "WASD / arrows / edge pan the anchor; wheel zoom; right-drag spins the moon in place (pointer capture on canvas)."
      );
      body.appendChild(
        num("Pan speed", t.camera.panSpeed, (v) => {
          t.camera.panSpeed = v;
        }, { hint: "Keyboard pan units per second." })
      );
      body.appendChild(
        num("Rotate speed", t.camera.rotateSpeed, (v) => {
          t.camera.rotateSpeed = v;
        }, { hint: "Yaw radians per second from Q/E." })
      );
      body.appendChild(
        num("Moon spin speed (px base)", t.camera.sphereOrbitRadiansPerPixel, (v) => {
          t.camera.sphereOrbitRadiansPerPixel = v;
        }, { hint: "Scales spin rate together with max radians / event." })
      );
      body.appendChild(
        num("Moon spin max rad / pointer event", t.camera.moonSpinMaxRadiansPerPointerStep, (v) => {
          t.camera.moonSpinMaxRadiansPerPointerStep = v;
        }, { hint: "Caps arcball step per move so fast drags stay smooth (reduces jerk / bloom smear)." })
      );
      body.appendChild(
        num("Zoom min", t.camera.zoomMin, (v) => {
          t.camera.zoomMin = v;
        }, { hint: "Closest camera distance (smaller = tighter)." })
      );
      body.appendChild(
        num("Zoom max", t.camera.zoomMax, (v) => {
          t.camera.zoomMax = v;
        }, { hint: "Farthest camera distance." })
      );
      body.appendChild(
        num("Wheel zoom factor", t.camera.wheelZoomFactor, (v) => {
          t.camera.wheelZoomFactor = v;
        }, { hint: "Per wheel tick change to camera distance." })
      );
      scroll.appendChild(el);
    }

    {
      const { el, body } = fieldset("UI");
      body.appendChild(
        num("Nameplate offset Y", t.ui.nameplateOffsetY, (v) => {
          t.ui.nameplateOffsetY = v;
        }, {
          hint: "Vertical offset above selected units for the Rock–R style label."
        })
      );
      body.appendChild(
        num("Structure nameplate Y", t.ui.structureNameplateOffsetY, (v) => {
          t.ui.structureNameplateOffsetY = v;
        }, {
          hint: "Vertical offset for selected building labels above the footprint center."
        })
      );
      scroll.appendChild(el);
    }

    if (options.matchAnalytics) {
      const { el, body } = fieldset("Match analytics");
      const statsEl = document.createElement("p");
      statsEl.className = "admin-analytics-stats";
      const refreshStats = (): void => {
        const s = options.matchAnalytics!.getStats();
        statsEl.textContent = `Recorded ${s.recorded} events · cap ${s.cap}${s.dropped ? ` · dropped ${s.dropped}` : ""}`;
      };
      refreshStats();

      const btnExport = document.createElement("button");
      btnExport.type = "button";
      btnExport.textContent = "Export match log (JSON)";
      btnExport.title =
        "Download commands, combat hits (RPS multipliers, HP), mineral pulses, and per-tick summaries for spreadsheets or pipelines.";
      btnExport.addEventListener("click", () => {
        options.matchAnalytics!.exportMatchLog();
        refreshStats();
      });

      const btnClearLog = document.createElement("button");
      btnClearLog.type = "button";
      btnClearLog.textContent = "Clear analytics buffer";
      btnClearLog.title = "Keeps the same session meta; empties in-memory events (e.g. before a clean playtest).";
      btnClearLog.addEventListener("click", () => {
        options.matchAnalytics!.clear();
        refreshStats();
      });

      body.appendChild(statsEl);
      body.appendChild(btnExport);
      body.appendChild(btnClearLog);
      scroll.appendChild(el);
    }

    const actions = document.createElement("div");
    actions.className = "admin-actions";

    const btnReset = document.createElement("button");
    btnReset.type = "button";
    btnReset.textContent = "Reset all to defaults";
    btnReset.title = "Restore every field in runtime tuning to shipped defaults.";
    btnReset.addEventListener("click", () => {
      resetTuningToDefaults();
      rebuild();
    });

    const btnNewMatch = document.createElement("button");
    btnNewMatch.type = "button";
    btnNewMatch.textContent = "Reset match (new game)";
    btnNewMatch.title =
      "Clear the command queue and reload initial match state (structures, units, resources, selections). Runtime tuning is unchanged.";
    btnNewMatch.hidden = !options.resetMatchToInitial;
    btnNewMatch.addEventListener("click", () => {
      options.resetMatchToInitial?.();
    });

    const btnApply = document.createElement("button");
    btnApply.type = "button";
    btnApply.textContent = "Apply unit stats to all living units";
    btnApply.title =
      "Overwrite speed, range, damage, cooldown, and attack class on every unit from the table above. HP is capped to the new max, not refilled.";
    btnApply.addEventListener("click", () => {
      options.setGameState(applyTuningStatsToAllUnits(options.getGameState()));
    });

    actions.appendChild(btnReset);
    actions.appendChild(btnNewMatch);
    actions.appendChild(btnApply);
    scroll.appendChild(actions);
  }

  rebuild();
  parent.appendChild(root);

  let visible = false;
  const toggle = (): void => {
    visible = !visible;
    root.style.display = visible ? "flex" : "none";
    if (visible) rebuild();
    options.onVisibilityChange?.(visible);
  };

  const onKey = (ev: KeyboardEvent): void => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (ev.code !== "F10" && ev.code !== "Backquote") return;
    }
    if (ev.code === "F10") {
      ev.preventDefault();
      toggle();
      return;
    }
    if (ev.code === "Backquote" && !ev.repeat) {
      ev.preventDefault();
      toggle();
    }
  };

  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    root.remove();
  };
}
