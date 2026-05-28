import React from "react";

// A cute 4-point sparkle (concave diamond). Pure shape; animate via props.
export const Sparkle: React.FC<{
  size?: number;
  color: string;
  style?: React.CSSProperties;
}> = ({ size = 24, color, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    style={style}
  >
    <path
      d="M12 0.5 C12.9 7.2 16.8 11.1 23.5 12 C16.8 12.9 12.9 16.8 12 23.5 C11.1 16.8 7.2 12.9 0.5 12 C7.2 11.1 11.1 7.2 12 0.5 Z"
      fill={color}
    />
  </svg>
);
