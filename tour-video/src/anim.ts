// Motion language for "Daylight": gentle spring pops with a touch of overshoot
// (cute, never frantic), soft slide-ups, and slow idle floating. Everything is
// frame-deterministic so renders are stable.
import {
  spring,
  interpolate,
  Easing,
  useCurrentFrame,
  useVideoConfig,
  random,
} from "remotion";

// --- spring configs ---------------------------------------------------------
export const SPRING = {
  // a friendly bounce — for things that "pop" in
  bounce: { damping: 12, mass: 0.85, stiffness: 120 },
  // a soft settle — gentle overshoot
  soft: { damping: 18, mass: 0.9, stiffness: 95 },
  // smooth, no overshoot — for calm slides
  smooth: { damping: 200 },
} as const;

type Cfg = { damping: number; mass?: number; stiffness?: number };

// 0 → 1 spring, delayed by `delay` frames.
export const enter = (
  frame: number,
  fps: number,
  delay = 0,
  config: Cfg = SPRING.soft,
) => spring({ frame: frame - delay, fps, config });

// Cute pop: scale (with overshoot) + fade. Great default entrance.
export const pop = (
  frame: number,
  fps: number,
  delay = 0,
  config: Cfg = SPRING.bounce,
) => {
  const s = enter(frame, fps, delay, config);
  const opacity = interpolate(frame - delay, [0, 7], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { scale: 0.72 + 0.28 * s, opacity, s };
};

// Soft slide-up entrance: translateY + fade.
export const rise = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 38,
  config: Cfg = SPRING.soft,
) => {
  const s = enter(frame, fps, delay, config);
  return {
    translateY: interpolate(s, [0, 1], [distance, 0]),
    opacity: interpolate(frame - delay, [0, 9], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  };
};

// Idle floating bob — slow sine, deterministic.
export const floatY = (
  frame: number,
  amp = 8,
  periodFrames = 150,
  phase = 0,
) => Math.sin((frame / periodFrames) * Math.PI * 2 + phase) * amp;

// Fade a value out over the last `frames` of a window (for exits).
export const fadeOutTail = (
  frame: number,
  duration: number,
  frames = 14,
) =>
  interpolate(frame, [duration - frames, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });

// Whole-scene presence: a soft fade+lift in at the start and fade out at the
// end, so VO-synced hard cuts feel like gentle dissolves without shifting any
// timing. Returns frame/duration too for convenience.
export const useScenePresence = (fadeIn = 13, fadeOut = 12) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const inP = interpolate(frame, [0, fadeIn], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const outP = interpolate(
    frame,
    [durationInFrames - fadeOut, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.quad) },
  );
  const opacity = inP * outP;
  const translateY = interpolate(inP, [0, 1], [16, 0]);
  return { frame, duration: durationInFrames, fps, opacity, translateY };
};

// Deterministic jitter helper for decorative fields.
export const rand = (seed: string) => random(seed);
export const randRange = (seed: string, min: number, max: number) =>
  min + random(seed) * (max - min);
