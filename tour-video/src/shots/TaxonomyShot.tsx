import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { IconBubble, Dot, RiseIn } from "../components/ui";
import { IconByName, type IconName, Check } from "../components/Icons";
import { Confetti } from "../components/Confetti";
import { pop } from "../anim";

type Topic = { name: string; state?: "base" | "new" | "retire" };
type Pillar = { name: string; color: string; soft: string; icon: IconName; topics: Topic[] };

export type TaxonomyShotProps = {
  kicker: string;
  headline: string;
  caption: string;
  pillars: Pillar[];
};

const TopicChip: React.FC<{
  topic: Topic;
  color: string;
  appear: number;
  retireAt: number;
  newAt: number;
}> = ({ topic, color, appear, retireAt, newAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isNew = topic.state === "new";
  const startFrame = isNew ? newAt : appear;
  const p = pop(frame, fps, startFrame);

  let opacity = p.opacity;
  let scale = p.scale;
  let ty = 0;
  let retiring = 0;
  if (topic.state === "retire") {
    retiring = interpolate(frame, [retireAt, retireAt + 26], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    opacity *= 1 - retiring * 0.86;
    ty = -retiring * 34;
    scale *= 1 - retiring * 0.1;
  }

  const badgeIn = isNew
    ? interpolate(frame, [newAt + 8, newAt + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;

  return (
    <div
      style={{
        transform: `translateY(${ty}px) scale(${scale})`,
        opacity,
        transformOrigin: "left center",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        background: c.card,
        borderRadius: radius.inner,
        boxShadow: shadow.soft,
        border: isNew ? `2px solid ${c.goodSoft}` : `2px solid ${c.white}`,
        padding: "18px 22px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Dot color={color} size={12} />
        <span style={{ fontFamily: fonts.display, fontWeight: 500, fontSize: 26, color: c.ink }}>{topic.name}</span>
      </div>
      {isNew ? (
        <span
          style={{
            opacity: badgeIn,
            transform: `scale(${0.7 + badgeIn * 0.3})`,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 13px",
            borderRadius: 999,
            background: c.goodSoft,
            color: c.good,
            fontFamily: fonts.body,
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          <Check size={15} color={c.good} strokeWidth={2.6} /> Ratified
        </span>
      ) : null}
      {topic.state === "retire" && retiring > 0.15 ? (
        <span
          style={{
            opacity: interpolate(retiring, [0.15, 0.4, 0.9], [0, 1, 0]),
            fontFamily: fonts.body,
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: c.inkDim,
          }}
        >
          let go
        </span>
      ) : null}
    </div>
  );
};

export const TaxonomyShot: React.FC<TaxonomyShotProps> = ({ kicker, headline, caption, pillars }) => {
  const { durationInFrames: dur } = useVideoConfig();
  const pillarStart = Math.round(dur * 0.12);
  const topicsStart = Math.round(dur * 0.3);
  const stagger = Math.round(dur * 0.028);
  const newAt = Math.round(dur * 0.56);
  const retireAt = Math.round(dur * 0.73);
  const captionAt = Math.round(dur * 0.86);

  let baseIdx = 0;
  return (
    <SceneLayout align="top" padY={88}>
      <SceneHeader kicker={kicker} headline={headline} size={58} marginBottom={50} />
      <div style={{ display: "flex", gap: 56, width: "100%", maxWidth: 1480, justifyContent: "center", alignItems: "flex-start" }}>
        {pillars.map((pil, pi) => {
          const Ico = IconByName[pil.icon];
          return (
            <PillarColumn key={pi} index={pi} pillarStart={pillarStart}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  background: c.card,
                  borderRadius: radius.card,
                  boxShadow: shadow.card,
                  borderTop: `5px solid ${pil.color}`,
                  padding: "24px 26px",
                  marginBottom: 18,
                }}
              >
                <IconBubble bg={pil.soft} size={64}>
                  <Ico size={34} color={pil.color} strokeWidth={1.9} />
                </IconBubble>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 14.5, letterSpacing: 2, textTransform: "uppercase", color: pil.color }}>
                    Pillar
                  </span>
                  <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 30, color: c.ink, lineHeight: 1.05 }}>
                    {pil.name}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {pil.topics.map((t, ti) => {
                  const appear = topicsStart + baseIdx * stagger;
                  if (t.state !== "new") baseIdx += 1;
                  return (
                    <TopicChip
                      key={ti}
                      topic={t}
                      color={pil.color}
                      appear={appear}
                      retireAt={retireAt}
                      newAt={newAt}
                    />
                  );
                })}
              </div>
            </PillarColumn>
          );
        })}
      </div>

      <RiseIn delay={captionAt} style={{ marginTop: 40 }}>
        <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 24, color: c.inkDim, textAlign: "center" }}>
          {caption}
        </div>
      </RiseIn>

      <Confetti count={34} startFrame={newAt + 4} originX={0.71} originY={0.56} power={0.7} />
    </SceneLayout>
  );
};

const PillarColumn: React.FC<{ index: number; pillarStart: number; children: React.ReactNode }> = ({
  index,
  pillarStart,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scale, opacity } = pop(frame, fps, pillarStart + index * 6);
  return (
    <div style={{ flex: 1, maxWidth: 660, transform: `scale(${scale})`, opacity, transformOrigin: "top center" }}>
      {children}
    </div>
  );
};
