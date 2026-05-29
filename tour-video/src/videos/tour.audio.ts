import { interpolate } from "remotion";
import type { Soundtrack, SfxCue } from "../types";

// Sound design for the "Daylight" tour.
//
// One continuous music bed (a warm, gentle instrumental composed to the film's
// arc) plays under the whole video. Its volume is frame-driven: it fades in,
// sits low under the VO, and lifts a touch in the ~0.5s gap at each scene cut
// so transitions breathe — a soft, automatic "duck/swell" feel.
//
// On top, a small palette of one-shot SFX (all peak-normalised to ~-3 dBFS) is
// placed on the EXACT animation frames of each shot — the SIGNED stamp, the
// ratify chime + sparkle, soft swipes on the
// "left out" list, a ta-da on the closing sigil. Frames are absolute (fps 30),
// derived from each shot's own timing + the per-scene boundaries baked into the
// voiceover manifest. Keep these in sync if a scene's duration changes.

const FADE_IN = 48; // 1.6s
const FADE_OUT = 80; // ~2.7s tail

// Every scene boundary except the open (start frames of each later scene).
const CUT_FRAMES = [356, 800, 1438, 1964, 2546, 2926, 3371, 3784, 4201, 4684, 5088, 5437, 5688];

const musicVolume = (frame: number, totalFrames: number): number => {
  const fadeIn = interpolate(frame, [0, FADE_IN], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [totalFrames - FADE_OUT, totalFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  let swell = 0;
  for (const b of CUT_FRAMES) {
    const d = (frame - b) / 8;
    swell += 0.06 * Math.exp(-d * d);
  }
  // base ~0.16 sits the bed ~16 LU under the VO during speech (present but unobtrusive);
  // the swell lifts it in the ~0.5s VO gap at each cut so transitions breathe.
  const v = (0.16 + swell) * fadeIn * fadeOut;
  return Math.min(0.32, Math.max(0, v));
};

// durF = clip length in frames (so each SFX Sequence unmounts cleanly).
const sfxFiles: Soundtrack["sfxFiles"] = {
  whoosh: { src: "sfx/whoosh.mp3", durF: 27 },
  pop: { src: "sfx/pop.mp3", durF: 15 },
  chime: { src: "sfx/chime.mp3", durF: 48 },
  stamp: { src: "sfx/stamp.mp3", durF: 24 },
  scribble: { src: "sfx/scribble.mp3", durF: 33 },
  sparkle: { src: "sfx/sparkle.mp3", durF: 48 },
  softDrop: { src: "sfx/soft-drop.mp3", durF: 30 },
  swipe: { src: "sfx/swipe.mp3", durF: 15 },
  tada: { src: "sfx/tada.mp3", durF: 41 },
};

// Soft airy transition on each scene cut (skipping the CTA + outro cuts, which
// get their own accents instead). Leads the cut by 8 frames.
const transitions: SfxCue[] = [356, 800, 1438, 1964, 2546, 2926, 3371, 3784, 4201, 4684, 5088].map((f) => ({
  at: f - 8,
  sfx: "whoosh",
  vol: 0.15,
}));

const accents: SfxCue[] = [
  // open — a sparkle as the wordmark pops
  { at: 4, sfx: "sparkle", vol: 0.18 },
  // method — four step cards pop in
  { at: 370, sfx: "pop", vol: 0.18 },
  { at: 379, sfx: "pop", vol: 0.18 },
  { at: 388, sfx: "pop", vol: 0.18 },
  { at: 397, sfx: "pop", vol: 0.18 },
  // taxonomy — pillars, first topics, a ratify, then a gentle "let go"
  { at: 877, sfx: "pop", vol: 0.16 },
  { at: 883, sfx: "pop", vol: 0.16 },
  // base topics cascade in every 18 frames (topicsStart 191 + baseIdx*18) — a soft marimba-ish trickle
  { at: 991, sfx: "pop", vol: 0.12 },
  { at: 1009, sfx: "pop", vol: 0.12 },
  { at: 1027, sfx: "pop", vol: 0.12 },
  { at: 1045, sfx: "pop", vol: 0.12 },
  { at: 1063, sfx: "pop", vol: 0.12 },
  { at: 1081, sfx: "pop", vol: 0.12 },
  { at: 1099, sfx: "pop", vol: 0.12 },
  { at: 1157, sfx: "chime", vol: 0.3 }, // newAt: a topic ratifies
  { at: 1157, sfx: "sparkle", vol: 0.22 },
  { at: 1266, sfx: "softDrop", vol: 0.22 }, // retireAt: a topic is let go
  // tiers — three cards land
  { at: 1618, sfx: "pop", vol: 0.22 },
  { at: 1717, sfx: "pop", vol: 0.22 },
  { at: 1810, sfx: "pop", vol: 0.22 },
  // lifecycle — two stations light, then "in the record"
  { at: 2034, sfx: "pop", vol: 0.15 },
  { at: 2121, sfx: "pop", vol: 0.15 },
  { at: 2208, sfx: "chime", vol: 0.24 },
  // voting — check, the SIGNED stamp, the signature scribble
  { at: 2652, sfx: "pop", vol: 0.18 },
  { at: 2698, sfx: "stamp", vol: 0.3 },
  { at: 2713, sfx: "scribble", vol: 0.24 },
  // wallet — fox appears (with a friendly shimmer), three reassurance points
  { at: 2944, sfx: "pop", vol: 0.22 },
  { at: 2946, sfx: "sparkle", vol: 0.16 },
  { at: 3033, sfx: "pop", vol: 0.14 },
  { at: 3104, sfx: "pop", vol: 0.14 },
  { at: 3175, sfx: "pop", vol: 0.14 },
  // peers — community fills, nominee verified, one steps away
  { at: 3790, sfx: "pop", vol: 0.14 },
  { at: 4009, sfx: "chime", vol: 0.26 },
  { at: 4011, sfx: "sparkle", vol: 0.2 },
  { at: 4093, sfx: "softDrop", vol: 0.2 },
  // capture — three problems, then each "designed out"
  { at: 4240, sfx: "softDrop", vol: 0.15 },
  { at: 4269, sfx: "softDrop", vol: 0.15 },
  { at: 4298, sfx: "softDrop", vol: 0.15 },
  { at: 4460, sfx: "chime", vol: 0.2 },
  { at: 4494, sfx: "chime", vol: 0.2 },
  { at: 4528, sfx: "chime", vol: 0.2 },
  // refusals — staccato swipes, then a warm banner
  { at: 4694, sfx: "swipe", vol: 0.12},
  { at: 4700, sfx: "swipe", vol: 0.12},
  { at: 4706, sfx: "swipe", vol: 0.12},
  { at: 4712, sfx: "swipe", vol: 0.12},
  { at: 4718, sfx: "swipe", vol: 0.12},
  { at: 4724, sfx: "swipe", vol: 0.12},
  { at: 4967, sfx: "chime", vol: 0.22 },
  // map — a soft single shimmer as the compass appears (Appear delay 3)
  { at: 5091, sfx: "sparkle", vol: 0.13 },
  // cta — wordmark shimmer, action chips, the url
  { at: 5439, sfx: "sparkle", vol: 0.18 },
  { at: 5463, sfx: "pop", vol: 0.16 },
  { at: 5469, sfx: "pop", vol: 0.16 },
  { at: 5475, sfx: "pop", vol: 0.16 },
  { at: 5481, sfx: "pop", vol: 0.16 },
  { at: 5563, sfx: "chime", vol: 0.26 },
  // outro — the sigil pops with a ta-da (matches enter delay 4), sparkles twinkle, a final chime
  { at: 5692, sfx: "tada", vol: 0.42 },
  { at: 5702, sfx: "sparkle", vol: 0.3 },
  { at: 5737, sfx: "chime", vol: 0.2 },
];

export const TOUR_SOUND: Soundtrack = {
  musicSrc: "audio/tour-music.mp3",
  musicVolume,
  sfxFiles,
  cues: [...transitions, ...accents],
};
