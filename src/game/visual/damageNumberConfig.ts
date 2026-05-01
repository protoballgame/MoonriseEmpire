/**
 * Tunables for floating damage numbers — tweak here or swap config when adding art styles.
 * See `.damage-number` rules in `src/style.css`.
 */
export interface DamageNumberVisualConfig {
  /** World-space offset above unit feet before extra float. */
  anchorOffsetY: number;
  /** Additional rise in world units per second (stacked on anchor). */
  driftUpPerSecond: number;
  /** Time before node is removed. */
  lifetimeSeconds: number;
  /** Rounded display: decimal places (0 = integer). */
  fractionDigits: number;
  /** Root element class (layout + shared look). */
  className: string;
  /** Modifier for debug/prototype vs future themed variants. */
  variantClassName: string;
}

export const DAMAGE_NUMBER_CONFIG: DamageNumberVisualConfig = {
  anchorOffsetY: 1.35,
  driftUpPerSecond: 0.85,
  lifetimeSeconds: 0.9,
  fractionDigits: 1,
  className: "damage-number",
  variantClassName: "damage-number--debug"
};
