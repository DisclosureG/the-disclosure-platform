import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
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
  const scenes = useMemo(() => {
    let cursor = 0;
    return video.scenes.map((s) => {
      const start = cursor;
      cursor += s.durationFrames;
      return { ...s, start };
    });
  }, [video.scenes]);

  return (
    <AbsoluteFill style={{ backgroundColor: c.paper }}>
      <PaperBackground />
      {scenes.map((s) => {
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
      {video.voPath ? (
        <Audio src={staticFile(video.voPath)} volume={1} />
      ) : null}
    </AbsoluteFill>
  );
};
