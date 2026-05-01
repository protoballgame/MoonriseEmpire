import type { MilitaryKind } from "./militaryKinds";
import {
  fibonacci,
  PHI,
  RPS_STRONG_MULTIPLIER,
  RPS_WEAK_MULTIPLIER,
  unitCooldownForKind,
  unitDamageForKind,
  unitMaxHpForKind
} from "./goldenScale";

/** Paper attack range (m). Neutral ranged uses ÷φ so it stays shorter but still golden-linked. */
const PAPER_ATTACK_RANGE = 4.0;
/**
 * Rock must stay **above** `collision.minCenterDistance` so melee can still land after overlap
 * resolution; otherwise Rock sits just outside `attackRange` vs Paper/S/R while Scissors (longer
 * reach) and ranged units dominate exchanges.
 */
const ROCK_MELEE_RANGE = 1.48;
const UNIT_SPEED_STEP = fibonacci(1);
const UNIT_MOVEMENT_SPEED_MULTIPLIER = 1.62;

export type FormationId = "none" | "square" | "circle" | "triangle";

export interface UnitTuningRow {
  hp: number;
  speed: number;
  range: number;
  /** Line of sight / reveal radius for fog-of-war, exploration, and debug overlay. */
  visionRange: number;
  damage: number;
  cooldown: number;
  attackClass: "melee" | "ranged";
}

export interface RuntimeTuning {
  combat: {
    rpsStrongMultiplier: number;
    rpsWeakMultiplier: number;
  };
  units: Record<MilitaryKind, UnitTuningRow>;
  collision: {
    minCenterDistance: number;
    resolvePasses: number;
    pushFactor: number;
  };
  formation: {
    active: FormationId;
    spacing: number;
    circleRadiusPerSqrtUnit: number;
    triangleApexLead: number;
  };
  camera: {
    panSpeed: number;
    rotateSpeed: number;
    /** Scales moon-spin speed (main RMB + minimap drag); paired with {@link moonSpinMaxRadiansPerPointerStep}. */
    sphereOrbitRadiansPerPixel: number;
    /** Caps arcball rotation per pointer event (rad) so fast drags stay smooth; scaled by sphereOrbit tuning. */
    moonSpinMaxRadiansPerPointerStep: number;
    zoomMin: number;
    zoomMax: number;
    wheelZoomFactor: number;
  };
  ui: {
    nameplateOffsetY: number;
    structureNameplateOffsetY: number;
  };
}

const DEFAULT_TUNING: RuntimeTuning = {
  combat: {
    rpsStrongMultiplier: RPS_STRONG_MULTIPLIER,
    rpsWeakMultiplier: RPS_WEAK_MULTIPLIER
  },
  units: {
    R: {
      hp: unitMaxHpForKind("R"),
      speed: (2.8 + UNIT_SPEED_STEP) * UNIT_MOVEMENT_SPEED_MULTIPLIER,
      range: ROCK_MELEE_RANGE,
      visionRange: 11.25,
      damage: unitDamageForKind("R"),
      cooldown: unitCooldownForKind("R"),
      attackClass: "melee"
    },
    P: {
      hp: unitMaxHpForKind("P"),
      speed: (2.2 + UNIT_SPEED_STEP) * UNIT_MOVEMENT_SPEED_MULTIPLIER,
      range: PAPER_ATTACK_RANGE,
      visionRange: 15,
      damage: unitDamageForKind("P"),
      cooldown: unitCooldownForKind("P"),
      attackClass: "ranged"
    },
    S: {
      hp: unitMaxHpForKind("S"),
      speed: (3.6 + UNIT_SPEED_STEP) * UNIT_MOVEMENT_SPEED_MULTIPLIER,
      range: 1.5,
      visionRange: 11.25,
      damage: unitDamageForKind("S"),
      cooldown: unitCooldownForKind("S"),
      attackClass: "melee"
    },
    N: {
      hp: unitMaxHpForKind("N"),
      speed: (2.5 + UNIT_SPEED_STEP) * UNIT_MOVEMENT_SPEED_MULTIPLIER,
      range: PAPER_ATTACK_RANGE / PHI,
      visionRange: 10,
      damage: unitDamageForKind("N"),
      cooldown: unitCooldownForKind("N"),
      attackClass: "ranged"
    }
  },
  collision: {
    minCenterDistance: 1.35,
    resolvePasses: 6,
    pushFactor: 0.55
  },
  formation: {
    active: "square",
    spacing: 2.0,
    circleRadiusPerSqrtUnit: 0.95,
    triangleApexLead: 1.25
  },
  camera: {
    panSpeed: 13,
    rotateSpeed: 1.6,
    sphereOrbitRadiansPerPixel: 0.00265,
    moonSpinMaxRadiansPerPointerStep: 0.048,
    zoomMin: 10,
    zoomMax: 112,
    wheelZoomFactor: 0.015
  },
  ui: {
    nameplateOffsetY: 2.05,
    structureNameplateOffsetY: 2.35
  }
};

function deepAssignTuning(target: RuntimeTuning, source: RuntimeTuning): void {
  Object.assign(target.combat, source.combat);
  Object.assign(target.collision, source.collision);
  Object.assign(target.formation, source.formation);
  Object.assign(target.camera, source.camera);
  Object.assign(target.ui, source.ui);
  for (const k of ["R", "S", "P", "N"] as MilitaryKind[]) {
    Object.assign(target.units[k], source.units[k]);
  }
}

export const tuning: RuntimeTuning = JSON.parse(JSON.stringify(DEFAULT_TUNING)) as RuntimeTuning;

export function resetTuningToDefaults(): void {
  deepAssignTuning(tuning, JSON.parse(JSON.stringify(DEFAULT_TUNING)) as RuntimeTuning);
}

export function getDefaultTuningSnapshot(): RuntimeTuning {
  return JSON.parse(JSON.stringify(DEFAULT_TUNING)) as RuntimeTuning;
}
