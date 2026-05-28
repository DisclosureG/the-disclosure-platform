// One video = a VideoConfig: dimensions, fps, an optional voiceover track, and
// an ordered list of scenes. Each scene names a Shot (a templated visual keyed
// by `kind`) with its props + a duration. Lines + durations are co-authored in
// <video>.voiceover.json so the audio pipeline and the video stay in lockstep.
import type { ShotKind, ShotPropsByKind } from "./shots";

export type ShotSpec = {
  [K in ShotKind]: { kind: K; props: ShotPropsByKind[K] };
}[ShotKind];

export type SceneConfig = {
  id: string;
  durationFrames: number;
  shot: ShotSpec;
};

export type VideoConfig = {
  id: string;
  fps: number;
  width: number;
  height: number;
  voPath?: string;
  scenes: SceneConfig[];
};

export type VoiceoverManifest = {
  voPath: string;
  scenes: Array<{ id: string; durationSec: number; line: string }>;
};

// Build SceneConfig[] from a voiceover manifest. Crucially, every scene
// boundary is anchored to the *true cumulative audio time* (round(sec * fps)),
// so per-scene rounding never accumulates into VO drift across a long video.
export const buildScenes = (
  manifest: VoiceoverManifest,
  fps: number,
  shotsById: Record<string, ShotSpec>,
): SceneConfig[] => {
  let cumSec = 0;
  return manifest.scenes.map((s) => {
    const shot = shotsById[s.id];
    if (!shot) {
      throw new Error(
        `[video] No shot spec for scene id="${s.id}" — check ${manifest.voPath}`,
      );
    }
    const startFrame = Math.round(cumSec * fps);
    cumSec += s.durationSec;
    const endFrame = Math.round(cumSec * fps);
    return { id: s.id, durationFrames: endFrame - startFrame, shot };
  });
};

export const totalDurationFrames = (cfg: VideoConfig): number =>
  cfg.scenes.reduce((acc, s) => acc + s.durationFrames, 0);
