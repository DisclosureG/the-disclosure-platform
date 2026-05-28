import "./index.css";
import { Composition } from "remotion";
import { VideoComposition } from "./VideoComposition";
import { TOUR } from "./videos/tour";
import { totalDurationFrames } from "./types";

const Tour: React.FC = () => <VideoComposition video={TOUR} />;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={TOUR.id}
      component={Tour}
      durationInFrames={totalDurationFrames(TOUR)}
      fps={TOUR.fps}
      width={TOUR.width}
      height={TOUR.height}
    />
  );
};
