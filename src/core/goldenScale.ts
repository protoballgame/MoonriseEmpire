/**
 * Golden-ratio (φ) and Fibonacci helpers for economy, combat, and passive income.
 *
 * Design intent: one coherent “growth law” — adjacent tiers relate by ≈φ, and discrete
 * costs/stats land on Fibonacci integers where we want whole numbers. Strong/weak RPS
 * uses φ and 1/φ so advantage × disadvantage = 1 (balanced on a log scale), similar
 * to how inverse pairs show up in natural systems.
 */

export const PHI = (1 + Math.sqrt(5)) / 2;

/** Fibonacci F(0)=0, F(1)=1, … — sufficient for small n used in tuning. */
export function fibonacci(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i += 1) {
    const c = a + b;
    a = b;
    b = c;
  }
  return b;
}

/** RPS: strong = φ, weak = 1/φ (product 1). */
export const RPS_STRONG_MULTIPLIER = PHI;
export const RPS_WEAK_MULTIPLIER = 1 / PHI;

/**
 * Rock / Paper / Scissors: sustained DPS at RPS multiplier 1 (same-kind or neutral) is
 * `RPS_BASELINE_DPS` — damage per hit scales with each line’s cooldown so faster attackers
 * hit for less per swing. RPS then stretches/compresses both sides symmetrically.
 */
/** Slightly below F(7): slower midgame snowballs with economy, still φ-shaped cadence via cooldowns. */
export const RPS_BASELINE_DPS = fibonacci(6) + fibonacci(4);

export function unitDamageForKind(kind: "R" | "P" | "S" | "N"): number {
  /** Neutral line: between F(4) and F(5), below R/S/P baseline DPS. */
  if (kind === "N") return fibonacci(4) + fibonacci(3);
  return RPS_BASELINE_DPS * unitCooldownForKind(kind);
}

/**
 * HP ladder (pure Fibonacci tiers / sums): Paper F(11), Scissors F(11)+F(8), Rock F(12).
 */
export function unitMaxHpForKind(kind: "R" | "P" | "S" | "N"): number {
  if (kind === "N") return fibonacci(9);
  if (kind === "R") return fibonacci(12);
  if (kind === "S") return fibonacci(11) + fibonacci(8);
  return fibonacci(11);
}

/** Cooldowns: fast line uses 1/φ, neutral 1, bruiser √φ (damage scales so DPS matches `RPS_BASELINE_DPS`). */
export function unitCooldownForKind(kind: "R" | "P" | "S" | "N"): number {
  if (kind === "N") return 1;
  if (kind === "S") return Math.round((1 / PHI) * 1000) / 1000;
  if (kind === "P") return 1;
  return Math.round(Math.sqrt(PHI) * 1000) / 1000;
}

