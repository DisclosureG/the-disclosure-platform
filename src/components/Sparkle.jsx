// A cute 4-point sparkle (concave diamond) — the brand's ambient motif.
// Ported verbatim from tour-video/src/components/Sparkle.tsx so the platform
// and the promo film share the exact mark.
export function Sparkle({ size = 24, color = 'currentColor', style, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={style}
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 0.5 C12.9 7.2 16.8 11.1 23.5 12 C16.8 12.9 12.9 16.8 12 23.5 C11.1 16.8 7.2 12.9 0.5 12 C7.2 11.1 11.1 7.2 12 0.5 Z"
        fill={color}
      />
    </svg>
  );
}

// The brand monogram — a capital "D" (Disclosure), the white mark held inside
// the coral sigil. Mirrors tour-video/src/components/DMark.tsx so the site
// header, the film, and the thumbnail share the exact lockup.
export function DMark({ size = 24, color = 'currentColor', style, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={style}
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.8 3.8 H10.6 C16.4 3.8 19.2 7.4 19.2 12 C19.2 16.6 16.4 20.2 10.6 20.2 H4.8 Z M8.5 7.6 H10.6 C13.8 7.6 15.3 9.4 15.3 12 C15.3 14.6 13.8 16.4 10.6 16.4 H8.5 Z"
        fill={color}
      />
    </svg>
  );
}

// The coral rounded-square sigil holding the white "D" monogram — the nav
// lockup that matches the tour-video Wordmark. Rendered before .brand-text.
export function BrandSigil() {
  return (
    <span className="brand-sigil" aria-hidden="true">
      <DMark size={26} color="#fff" />
    </span>
  );
}
