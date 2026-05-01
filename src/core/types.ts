export type CivId = "khemetic" | "yokai" | "ixchel";
export type ResourceId = "biomass" | "obsidian" | "nexus" | "energy" | "minerals";

export interface ResourcePool {
  biomass: number;
  obsidian: number;
  nexus: number;
  /** Harvestable / spendable — power for training, structures, tech. */
  energy: number;
  /** Harvestable / spendable — ore / minerals for industry and units. */
  minerals: number;
}

export interface PlayerState {
  id: string;
  civ: CivId;
  resources: ResourcePool;
}

