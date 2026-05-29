import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { useMemo } from "react";
import { SHOT_COMPONENTS } from "./shots";
import { PaperBackground } from "./components/PaperBackground";
import { c } from "./theme";
import type { VideoConfig } from "./types";

// Generic renderer for any VideoConfig. The warm paper background + drifting
// shapes live here, persistent across the whole video, so scene cuts feel like
// the same room re-arranging itself rather than 12 separate slides. Each shot
// draws only its foreground and fades itself in/out (see useScenePresence).
export const VideoComposition: React.FC<{ video: VideoConfig }> = ({
  video,
}) => {
  const { durationInFrames: total } = useVideoConfig();
  const scenes = useMemo(() => {
    let cursor = 0;
    return video.scenes.map((s) => {
      const start = cursor;
      cursor += s.durationFrames;
      return { ...s, start };
    });
  }, [video.scenes]);

  const sound = video.soundtrack;

  return (
    <AbsoluteFill style={{ backgroundColor: c.paper }}>
      <PaperBackground />
      {scenes.map((s) => {
        // Generic dispatch: the per-kind prop type is erased by the union index.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ShotComponent = SHOT_COMPONENTS[s.shot.kind] as React.FC<any>;
        return (
          <Sequence
            key={s.id}
            from={s.start}
            durationInFrames={s.durationFrames}
            name={s.id}
          >
            <ShotComponent {...s.shot.props} />
          </Sequence>
        );
      })}

      {/* Narration */}
      {video.voPath ? (
        <Audio src={staticFile(video.voPath)} volume={1} />
      ) : null}

      {/* Sound design: music bed (frame-driven duck/swell) + one-shot SFX */}
      {sound ? (
        <>
          <Audio
            src={staticFile(sound.musicSrc)}
            volume={(f) => sound.musicVolume(f, total)}
          />
          {sound.cues.map((q, i) => {
            const meta = sound.sfxFiles[q.sfx];
            if (!meta) return null;
            return (
              <Sequence
                key={`${q.sfx}-${q.at}-${i}`}
                from={Math.max(0, q.at)}
                durationInFrames={meta.durF + 2}
                name={`sfx:${q.sfx}@${q.at}`}
                layout="none"
              >
                <Audio src={staticFile(meta.src)} volume={() => q.vol} />
              </Sequence>
            );
          })}
        </>
      ) : null}
    </AbsoluteFill>
  );
};
