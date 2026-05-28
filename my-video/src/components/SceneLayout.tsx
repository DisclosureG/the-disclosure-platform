import React from "react";
import { AbsoluteFill } from "remotion";
import { useScenePresence } from "../anim";

// Standard scene shell: a soft opacity crossfade in/out (so VO-synced hard cuts
// feel like dissolves) plus consistent safe-area padding and centering. Inner
// elements provide their own motion; the shell only fades, so the two never
// fight.
export const SceneLayout: React.FC<{
  children: React.ReactNode;
  align?: "center" | "top";
  padX?: number;
  padY?: number;
  style?: React.CSSProperties;
}> = ({ children, align = "center", padX = 150, padY = 100, style }) => {
  const { opacity } = useScenePresence();
  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: align === "center" ? "center" : "flex-start",
          padding: `${padY}px ${padX}px`,
          ...style,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
