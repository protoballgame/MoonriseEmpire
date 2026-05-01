/**
 * Pluggable sounds for command feedback. Swap implementations (Web Audio, Howler, assets) in one place.
 */
export interface FeedbackSoundPack {
  gatherOk(): void;
  gatherFail(): void;
  move(): void;
  attack(): void;
  depositOk(): void;
  depositFail(): void;
  placeOk(): void;
  placeFail(): void;
  trainOk(): void;
  trainFail(): void;
  stop(): void;
}
