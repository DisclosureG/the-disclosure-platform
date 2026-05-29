import React from "react";
import { AbsoluteFill } from "remotion";
import { c, shadow, radius, tier } from "../theme";
import { fonts } from "../fonts";
import { PaperBackground } from "./PaperBackground";
import { Wordmark } from "./Wordmark";
import { DMark } from "./DMark";
import { Badge } from "./ui";

// A designed, STATIC poster / thumbnail for the tour video. Built from the same
// "Daylight" primitives as the film — warm paper + blooms + drifting shapes, the
// coral wordmark sigil, and a verified-evidence card — so the still, the film,
// and the web platform all read as one product. No entrance animations, so a
// single-frame still always renders complete. Rendered to
// public/artefacts/tour-poster.jpg via `remotion still Thumbnail`.

const PlayGlyph: React.FC = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M8 5v14l11-7z" fill="#fff" />
  </svg>
);

// The focal object: a single white "record" card with a coral sigil, a tier
// badge, an in-archive stamp, and a little cluster of peers — the platform's
// promise made tangible.
const RecordCard: React.FC = () => (
  <div
    style={{
      width: 480,
      background: c.card,
      borderRadius: radius.card,
      boxShadow: shadow.lift,
      padding: 40,
      display: "flex",
      flexDirection: "column",
      gap: 26,
      transform: "rotate(3deg)",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div
        style={{
          width: 62,
          height: 62,
          borderRadius: 18,
          background: c.coral,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: shadow.chip,
        }}
      >
        <DMark size={48} color={c.white} />
      </div>
      <Badge color={tier[1].ink} soft={tier[1].soft}>
        Tier I · Peer-reviewed
      </Badge>
    </div>

    <div>
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 600,
          fontSize: 34,
          lineHeight: 1.15,
          color: c.ink,
          letterSpacing: -0.5,
        }}
      >
        Declassified memo, 1947
      </div>
      <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 21, color: c.inkDim, marginTop: 8 }}>
        National Archives · 18 pages
      </div>
    </div>

    <div style={{ height: 1, background: c.line }} />

    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Badge color={c.good} soft={c.goodSoft}>
        ✓ In the archive
      </Badge>
      <div style={{ display: "flex" }}>
        {[c.coral, c.sage, c.sky, c.butter].map((col, i) => (
          <span
            key={col}
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: col,
              border: `2px solid ${c.card}`,
              marginLeft: i ? -9 : 0,
            }}
          />
        ))}
      </div>
    </div>
  </div>
);

export const Thumbnail: React.FC = () => (
  <AbsoluteFill>
    <PaperBackground />

    <AbsoluteFill
      style={{
        padding: "92px 104px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* top — brand lockup */}
      <Wordmark />

      {/* middle — headline (left) flanking the verified-evidence card (right) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 56 }}>
        <div style={{ maxWidth: 1040 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 11,
              padding: "11px 22px 11px 20px",
              borderRadius: radius.chip,
              background: c.coralSoft,
              color: c.coralDeep,
              fontFamily: fonts.body,
              fontWeight: 600,
              fontSize: 21,
              letterSpacing: 1.4,
              textTransform: "uppercase",
              marginBottom: 32,
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: c.coralDeep, display: "inline-block" }} />
            A record, kept by many
          </div>

          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 700,
              fontSize: 100,
              lineHeight: 1.02,
              letterSpacing: -2.5,
              color: c.ink,
            }}
          >
            Some things matter
            <br />
            <span style={{ color: c.coralDeep }}>too much to forget.</span>
          </div>

          <div
            style={{
              fontFamily: fonts.body,
              fontWeight: 500,
              fontSize: 32,
              lineHeight: 1.45,
              color: c.inkSoft,
              marginTop: 34,
              maxWidth: 760,
            }}
          >
            A public record for the world&rsquo;s most contested ideas — checked in the open by named peers, owned by no one.
          </div>
        </div>

        <RecordCard />
      </div>

      {/* bottom — the video tag */}
      <div
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          alignItems: "center",
          gap: 13,
          padding: "16px 30px 16px 24px",
          borderRadius: radius.chip,
          background: c.coral,
          color: c.white,
          boxShadow: shadow.chip,
          fontFamily: fonts.display,
          fontWeight: 600,
          fontSize: 27,
        }}
      >
        <PlayGlyph /> Watch the tour
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
