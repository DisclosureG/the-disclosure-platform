import React from "react";

// Friendly, rounded stroke icons. Single color, consistent weight. Kept simple
// and geometric to match the Poppins display face.
type P = { size?: number; color?: string; strokeWidth?: number; style?: React.CSSProperties };

const Base: React.FC<P & { children: React.ReactNode }> = ({
  size = 28,
  color = "#2C2622",
  strokeWidth = 1.9,
  style,
  children,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {children}
  </svg>
);

export const Check: React.FC<P> = (p) => <Base {...p}><path d="M5 13l4 4L19 7" /></Base>;
export const Cross: React.FC<P> = (p) => <Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>;
export const ArrowRight: React.FC<P> = (p) => <Base {...p}><path d="M4 12h15M13 6l6 6-6 6" /></Base>;
export const Plus: React.FC<P> = (p) => <Base {...p}><path d="M12 5v14M5 12h14" /></Base>;

export const Refresh: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M4 12a8 8 0 0 1 13.5-5.8L20 8" />
    <path d="M20 4v4h-4" />
    <path d="M20 12a8 8 0 0 1-13.5 5.8L4 16" />
    <path d="M4 20v-4h4" />
  </Base>
);

export const File: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
    <path d="M13.5 3.5V8H18M9 12.5h6M9 16h4" />
  </Base>
);

export const Users: React.FC<P> = (p) => (
  <Base {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3 2.4-5.2 5.5-5.2s5.5 2.2 5.5 5.2" />
    <path d="M16 5.6a3 3 0 0 1 0 5.6M17 14.6c2.3.5 4 2.4 4 4.9" />
  </Base>
);

export const Eye: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);

export const Flag: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M6 21V4M6 4.5h11l-2.6 3.5L17 11.5H6" />
  </Base>
);

export const Shield: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.6-3.1 7.8-7 9-3.9-1.2-7-4.4-7-9V6l7-3Z" />
  </Base>
);

export const ShieldCheck: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.6-3.1 7.8-7 9-3.9-1.2-7-4.4-7-9V6l7-3Z" />
    <path d="M9 11.5l2 2 4-4" />
  </Base>
);

export const Pen: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M14.5 4.5l5 5M3 21l1-4L16.5 4.5a1.5 1.5 0 0 1 2 0l1 1a1.5 1.5 0 0 1 0 2L7 20l-4 1Z" />
  </Base>
);

export const Note: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M4.5 5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 4v-4H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    <path d="M8 9.5h8M8 12.5h5" />
  </Base>
);

export const Link: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M9.5 14.5l5-5" />
    <path d="M10.5 6.5l1-1a4 4 0 0 1 5.7 5.7l-1 1" />
    <path d="M13.5 17.5l-1 1a4 4 0 0 1-5.7-5.7l1-1" />
  </Base>
);

export const Coin: React.FC<P> = (p) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v9M9.8 10c0-1.2 1-1.8 2.4-1.8s2.4.7 2.4 1.7-1 1.6-2.4 1.6-2.4.6-2.4 1.7 1 1.7 2.4 1.7 2.4-.6 2.4-1.6" />
  </Base>
);

export const Globe: React.FC<P> = (p) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z" />
  </Base>
);

export const Heart: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 20s-7-4.4-9.2-9C1.4 8 3 4.7 6.3 4.7c2 0 3.2 1.2 4 2.4.8-1.2 2-2.4 4-2.4 3.3 0 4.9 3.3 3.5 6.3C19 15.6 12 20 12 20Z" />
  </Base>
);

export const Star: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.1 5.9L12 16.6 6.7 19.4l1.1-5.9L3.4 9.4l6-.7Z" />
  </Base>
);

export const BookOpen: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 6.2C10 4.8 7 4.3 4 5.2v13c3-.9 6-.4 8 1 2-1.4 5-1.9 8-1v-13c-3-.9-6-.4-8 1Z" />
    <path d="M12 6.2V19" />
  </Base>
);

export const Compass: React.FC<P> = (p) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" />
  </Base>
);

export const Scale: React.FC<P> = (p) => (
  <Base {...p}>
    <path d="M12 4v16M7.5 20.5h9M5 8.5l7-2.2 7 2.2" />
    <path d="M5 8.5l-2.3 4.6a2.6 2.6 0 0 0 4.6 0L5 8.5ZM19 8.5l-2.3 4.6a2.6 2.6 0 0 0 4.6 0L19 8.5Z" />
  </Base>
);

export const LockOpen: React.FC<P> = (p) => (
  <Base {...p}>
    <rect x="5" y="11" width="14" height="9.5" rx="2.2" />
    <path d="M8.5 11V7.2A3.5 3.5 0 0 1 15.5 6.4" />
  </Base>
);

export const Ban: React.FC<P> = (p) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </Base>
);

export type IconName =
  | "check" | "cross" | "arrowRight" | "plus" | "refresh" | "file" | "users"
  | "eye" | "flag" | "shield" | "shieldCheck" | "pen" | "note" | "link"
  | "coin" | "globe" | "heart" | "star" | "bookOpen" | "compass" | "scale"
  | "lockOpen" | "ban";

export const IconByName: Record<IconName, React.FC<P>> = {
  check: Check, cross: Cross, arrowRight: ArrowRight, plus: Plus, refresh: Refresh,
  file: File, users: Users, eye: Eye, flag: Flag, shield: Shield, shieldCheck: ShieldCheck,
  pen: Pen, note: Note, link: Link, coin: Coin, globe: Globe, heart: Heart, star: Star,
  bookOpen: BookOpen, compass: Compass, scale: Scale, lockOpen: LockOpen, ban: Ban,
};
