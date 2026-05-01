/** World ore nodes (`minerals`); `energy` exists for map data only — energy income is from Solar Arrays. */
export type ResourceFieldKind = "energy" | "minerals";

export interface SimResourceField {
  id: string;
  kind: ResourceFieldKind;
  gx: number;
  gz: number;
  /** Remaining yield; `null` = infinite node. */
  reserve: number | null;
  /**
   * When set, this field grants exploration + fog line-of-sight like a friendly building (starter patch
   * next to that player's Command Core).
   */
  homePatchVisionOwnerId?: string;
}
