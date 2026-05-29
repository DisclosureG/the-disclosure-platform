# tour-video — "Daylight" tour

The platform's tour video, rebuilt in a warm, joyful, modern-simplicity style
(think Claude promo videos), rendered with [Remotion](https://www.remotion.dev/).
A deliberate inverse of the old dark "Cosmos" cut: warm paper light, a friendly
coral accent, soft pastel shapes, big rounded cards, and gentle spring motion.

- **Output:** `out/tour.mp4` (1920×1080, ~3:14). The site copy lives at
  [`../public/artefacts/tour.mp4`](../public/artefacts/tour.mp4) (+ `tour-poster.jpg`),
  served at `/artefacts/tour.mp4` and embedded on the home page
  ([`../src/pages/Home.jsx`](../src/pages/Home.jsx)).
- **Voiceover:** a fresh warm script narrated by ElevenLabs voice **Sarah**
  (`EXAVITQu4vr4xnSDxMaL`, `eleven_multilingual_v2`, stability 0.4, speed 0.96).
- **Sound design:** a warm instrumental music bed (ElevenLabs Music,
  `public/audio/tour-music.mp3`) ducked under the VO with a frame-driven
  duck/swell envelope, plus a palette of one-shot SFX (`public/sfx/*.mp3`)
  placed on each shot's exact animation frames. The whole cue sheet lives in
  [`src/videos/tour.audio.ts`](src/videos/tour.audio.ts); a final two-pass
  loudnorm (`npm run master`) brings the mix to −14 LUFS / −1.5 dBTP.

## Commands

```bash
npm i
npm run studio     # live preview (Remotion Studio)
npm run render     # → out/tour.mp4 (raw mix: VO + music + SFX)
npm run master     # two-pass loudnorm on out/tour.mp4 → −14 LUFS / −1.5 dBTP
npm run film       # render + master in one go
npm run vo         # re-assemble public/voiceover/tour.mp3 from the line takes
```

## How it's wired

```
src/
  theme.ts            # "Daylight" palette, tiers, shadows, radii
  fonts.ts            # Poppins (display) · Inter (UI) · JetBrains Mono (hashes/url)
  anim.ts             # spring configs, pop/rise/float helpers, scene-presence fade
  types.ts            # VideoConfig + buildScenes() (anchors every scene boundary
                      #   to true cumulative audio time → no VO drift)
  VideoComposition.tsx# continuous paper background + scene Sequences + VO <Audio>
                      #   + music bed <Audio volume=fn> + SFX <Sequence><Audio>
  Root.tsx            # registers the "Tour" composition
  components/         # PaperBackground, FloatingShapes, Sparkle, Headline (word
                      #   rise + *accent* markup), Wordmark, SceneHeader, ui atoms,
                      #   Icons, MetaMaskFox (official colour mark), Confetti, SceneLayout
  shots/              # one component per scene kind (title, steps, tiers, taxonomy,
                      #   lifecycle, voting, wallet, peer-grid, walls, refusals, cta,
                      #   outro)
  videos/
    tour.ts                  # the 14-scene config (copy + colors per beat)
    tour.voiceover.json      # scene ids, measured durations, narration lines
    tour.audio.ts            # sound design: music duck/swell envelope + SFX cue
                             #   sheet (one-shots placed on exact animation frames)
scripts/
  assemble-vo.sh      # concat per-line takes (public/voiceover/lines/*.mp3) into
                      #   tour.mp3 with calm gaps; prints each scene's duration
  master-audio.sh     # two-pass EBU R128 loudnorm of the rendered mix, in place
public/
  voiceover/tour.mp3  # the narration track (assembled from per-line takes)
  audio/tour-music.mp3# the warm instrumental music bed (ElevenLabs Music)
  sfx/*.mp3           # one-shot SFX, peak-normalised to ~-3 dBFS
```

## Changing the script or voice

1. Edit the lines in `src/videos/tour.voiceover.json`.
2. Regenerate each changed line's take into `public/voiceover/lines/` (ElevenLabs
   TTS), then `npm run vo` — it concatenates the newest take per scene and prints
   the per-scene seconds. Paste those into `durationSec` in the manifest.
3. `npm run render`, then copy `out/tour.mp4` + a poster frame into
   `../public/artefacts/`.

To swap the **voice**, change the `voice_id` used when generating the line takes;
everything downstream (assembly, timings, render) is unchanged.

## Notes

- Scene cuts stay perfectly in sync with the VO because `buildScenes` rounds each
  boundary off the true cumulative audio time, not per-scene durations.
- The background (warm gradient + drifting pastel shapes) is rendered once for the
  whole video; scenes only fade their foreground in/out, so cuts feel continuous.
- CSS transitions/animations are never used — all motion is frame-driven
  (`useCurrentFrame` + `interpolate`/`spring`), per Remotion's rules.
