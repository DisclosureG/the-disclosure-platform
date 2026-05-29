import "./index.css";
import { Composition } from "remotion";
import { VideoComposition } from "./VideoComposition";
import { Thumbnail } from "./components/Thumbnail";
import { TOUR } from "./videos/tour";
import { totalDurationFrames } from "./types";

const Tour: React.FC = () => <VideoComposition video={TOUR} />;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id={TOUR.id}
        component={Tour}
        durationInFrames={totalDurationFrames(TOUR)}
        fps={TOUR.fps}
        width={TOUR.width}
        height={TOUR.height}
      />
      {/* Static poster / thumbnail for the tour video — rendered to
          public/artefacts/tour-poster.jpg via `remotion still Thumbnail`. */}
      <Composition
        id="Thumbnail"
        component={Thumbnail}
        durationInFrames={1}
        fps={TOUR.fps}
        width={TOUR.width}
        height={TOUR.height}
      />
    </>
  );
};
