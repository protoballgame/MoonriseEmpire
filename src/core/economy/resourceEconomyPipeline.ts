/**
 * Resource economy (parent layer)
 * -----------------
 * All **shared** rules for energy / minerals live under `src/core/economy/`.
 * - `economyWorldTick.ts` — passive Solar Array; core has no free income.
 * - `gatheringTick.ts` — N miners on mineral fields (pulsed ore); field energy is not gathered.
 * - `seedResourceFields.ts` — match setup.
 *
 * **Child** game modes (`RealTimeMode`, `TurnBasedMode`) only decide *when* `SimulationEngine.step`
 * runs; they must not duplicate these formulas.
 */

export { runDefaultResourceEconomyWorldTick } from "./economyWorldTick";
export { processGatheringForUnit, removeDepletedResourceFields } from "./gatheringTick";
export { seedResourceFields } from "./seedResourceFields";
export type { SimResourceField, ResourceFieldKind } from "./resourceFieldTypes";
export { resourceFieldCenterWorld } from "./resourceFieldGeometry";
export { structureFootprintOverlapsResourceField } from "./fieldOverlap";
