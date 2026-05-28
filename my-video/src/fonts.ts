// Brand type for "Daylight":
//   • Poppins  — friendly geometric display (headlines, big numbers). Joyful,
//     rounded, modern. The personality voice.
//   • Inter    — clean neutral UI/body (subheads, labels, captions).
//   • JetBrains Mono — used sparingly for hashes / the URL, kept light.
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const poppins = loadPoppins("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
});
const inter = loadInter("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});
const mono = loadMono("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
});

export const fonts = {
  display: poppins.fontFamily,
  body: inter.fontFamily,
  mono: mono.fontFamily,
} as const;
