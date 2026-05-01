import type { FeedbackSoundPack } from "./FeedbackSoundPack";

function getAudioContext(): AudioContext {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    throw new Error("Web Audio API not available");
  }
  return new Ctx();
}

let sharedCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!sharedCtx) sharedCtx = getAudioContext();
  return sharedCtx;
}

function resumeIfNeeded(c: AudioContext): void {
  if (c.state === "suspended") void c.resume();
}

/** Short tonal blip — replace with sampled SFX later without changing call sites. */
function tone(
  freq: number,
  durationSec: number,
  type: OscillatorType,
  gain = 0.06,
  freqSlide = 0
): void {
  try {
    const c = ctx();
    resumeIfNeeded(c);
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqSlide !== 0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + freqSlide), t0 + durationSec);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  } catch {
    /* ignore missing audio in headless / strict browsers */
  }
}

export function createWebAudioFeedbackSounds(): FeedbackSoundPack {
  return {
    gatherOk: () => tone(880, 0.07, "sine", 0.055, -120),
    gatherFail: () => tone(180, 0.12, "square", 0.04, -80),
    move: () => tone(420, 0.05, "triangle", 0.045),
    attack: () => tone(640, 0.06, "sawtooth", 0.05, -200),
    depositOk: () => tone(660, 0.08, "sine", 0.05, 120),
    depositFail: () => tone(200, 0.1, "square", 0.035),
    placeOk: () => tone(520, 0.09, "sine", 0.055, 180),
    placeFail: () => tone(160, 0.11, "triangle", 0.04),
    trainOk: () => tone(740, 0.07, "sine", 0.05),
    trainFail: () => tone(220, 0.1, "square", 0.035),
    stop: () => tone(360, 0.05, "sine", 0.04)
  };
}
