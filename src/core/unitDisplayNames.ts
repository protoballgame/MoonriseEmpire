import type { MilitaryKind } from "./militaryKinds";

const NAMES: Record<MilitaryKind, string> = {
  R: "Rock",
  P: "Paper",
  S: "Scissors",
  N: "Neutral"
};

/** Placeholder display until faction-specific names exist. */
export function unitNameplateLabel(kind: MilitaryKind): string {
  return `${NAMES[kind]} - ${kind}`;
}
