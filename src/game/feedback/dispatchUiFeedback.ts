import type { UiFeedbackEvent } from "../../core/sim/uiFeedbackEvents";
import type { FeedbackSoundPack } from "./FeedbackSoundPack";

export interface FeedbackVisualAdapter {
  flashResourceField(fieldId: string, durationSec?: number): void;
}

export interface DispatchUiFeedbackOptions {
  localPlayerId: string;
  sounds: FeedbackSoundPack;
  visuals: FeedbackVisualAdapter;
}

/**
 * Routes simulation `feedback` to audio + world/HUD hooks. Replace `sounds` / `visuals` to retheme the game.
 */
export function dispatchUiFeedback(events: readonly UiFeedbackEvent[], options: DispatchUiFeedbackOptions): void {
  const { localPlayerId, sounds, visuals } = options;
  for (const ev of events) {
    if (ev.playerId !== localPlayerId) continue;

    switch (ev.kind) {
      case "gather":
        if (ev.status === "started" && ev.fieldId) {
          sounds.gatherOk();
          visuals.flashResourceField(ev.fieldId, 0.45);
        } else {
          sounds.gatherFail();
        }
        break;
      case "move":
        if (ev.status === "ok") sounds.move();
        break;
      case "attack_move":
        if (ev.status === "ok") sounds.attack();
        break;
      case "attack_unit":
      case "attack_structure":
        if (ev.status === "ok") sounds.attack();
        break;
      case "deposit":
        if (ev.status === "ok") sounds.depositOk();
        else sounds.depositFail();
        break;
      case "place_structure":
        if (ev.status === "ok") sounds.placeOk();
        else sounds.placeFail();
        break;
      case "train_unit":
        if (ev.status === "ok") sounds.trainOk();
        else sounds.trainFail();
        break;
      case "rally_set":
        if (ev.status === "ok") {
          sounds.move();
          if (ev.mineFieldId) visuals.flashResourceField(ev.mineFieldId, 0.45);
        }
        break;
      case "stop":
        sounds.stop();
        break;
      default:
        break;
    }
  }
}
