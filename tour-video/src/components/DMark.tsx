import React from "react";

// The brand monogram — a capital "D" (Disclosure), the white mark held inside
// the coral sigil. Replaces the earlier sparkle/star glyph. Drawn as a single
// even-odd path (stem + bowl + counter) so it stays crisp at any size and sits
// optically centred; geometric and gently weighted to live with Poppins.
export const DMark: React.FC<{
  size?: number;
  color: string;
  style?: React.CSSProperties;
}> = ({ size = 24, color, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.8 3.8 H10.6 C16.4 3.8 19.2 7.4 19.2 12 C19.2 16.6 16.4 20.2 10.6 20.2 H4.8 Z M8.5 7.6 H10.6 C13.8 7.6 15.3 9.4 15.3 12 C15.3 14.6 13.8 16.4 10.6 16.4 H8.5 Z"
      fill={color}
    />
  </svg>
);
