// "Daylight" — the joyful, modern-simplicity brand system for the Disclosure
// tour. A deliberate inverse of the old slate "Cosmos" look: warm paper light,
// a friendly coral as the hero accent, soft pastel categories, big rounded
// corners and pillowy shadows. Calm, bright, optimistic — the register of a
// Claude promo, not a documentary.

export const c = {
  // Warm paper background + soft surfaces
  paper: "#F4EFE4", // warm ivory canvas
  paperTop: "#FBF7EE", // lighter — used for the gentle top glow
  paperDeep: "#EDE6D6", // slightly deeper warm tone for layering
  card: "#FFFFFF", // clean card
  cardAlt: "#FBF8F1", // softly tinted card

  // Warm ink
  ink: "#2C2622", // near-black, warm
  inkSoft: "#5E544A", // body
  inkDim: "#938778", // muted captions / meta
  inkGhost: "#C9BEAC", // faint hairline text

  // Lines / hairlines
  line: "#E7DECE",
  lineSoft: "#F0E9DB",

  // Hero accent — the Anthropic-ish clay coral
  coral: "#D97757",
  coralDeep: "#BE5C3C", // readable coral text on light
  coralSoft: "#F7E2D7", // coral tint fill
  coralGlow: "rgba(217, 119, 87, 0.22)",

  // Soft pastel family (cute category accents + decoration)
  sky: "#6CA8CF",
  skySoft: "#DEEAF2",
  sage: "#6FAE8E",
  sageSoft: "#DDEDE3",
  butter: "#E6B454",
  butterSoft: "#F8EBCC",
  lilac: "#A38BD1",
  lilacSoft: "#E9E1F5",
  blush: "#E8917B",
  blushSoft: "#F8E0D9",

  // Semantic (kept gentle, never harsh)
  good: "#5FA882",
  goodSoft: "#DCEDE3",
  warn: "#D9A23B",
  retire: "#CF7C62", // soft terracotta for "let it go" / retire — warm, not alarming

  white: "#FFFFFF",
} as const;

// Evidence tiers — honest-about-strength, but on the warm palette.
export const tier = {
  1: { ink: "#3E7D60", soft: c.sageSoft, dot: c.sage, roman: "I" },
  2: { ink: "#B8801F", soft: c.butterSoft, dot: c.butter, roman: "II" },
  3: { ink: c.coralDeep, soft: c.coralSoft, dot: c.coral, roman: "III" },
} as const;

// Pillowy, joyful shadows — large soft ambient + a tiny contact shadow.
export const shadow = {
  card: "0 28px 60px -28px rgba(78, 52, 30, 0.30), 0 8px 20px -12px rgba(78, 52, 30, 0.12)",
  soft: "0 18px 44px -22px rgba(78, 52, 30, 0.26), 0 4px 10px -6px rgba(78, 52, 30, 0.10)",
  chip: "0 10px 22px -12px rgba(78, 52, 30, 0.24)",
  lift: "0 38px 80px -30px rgba(78, 52, 30, 0.40), 0 10px 24px -12px rgba(78, 52, 30, 0.16)",
} as const;

export const radius = {
  card: 34,
  inner: 22,
  chip: 999,
  sm: 14,
} as const;
