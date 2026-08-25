/**
 * The dashboard's icons, drawn rather than typed.
 *
 * Inline SVG on a 24-unit grid with a 1.7 stroke, sized by the caller. No emoji
 * and no icon font: an emoji is a different glyph on every platform and none of
 * them takes `currentColor`, which is the whole reason these can sit inside a
 * coloured plate and inherit it.
 *
 * Every one is `aria-hidden`. They are decoration beside a word that already
 * says what they mean, and a screen reader announcing "sun, South roof" reads
 * the label twice. The attribute lives on the shared `<Icon>` below rather than
 * in a spread props object, so that it is visible to the lint rule that checks
 * an `<svg>` is either labelled or hidden.
 */
import type { ReactNode } from "react";

type IconProps = { size?: number };

function Icon({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function SunIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

export function BatteryIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="2" y="7" width="16" height="10" rx="2.5" />
      <path d="M21 10.5v3" />
      <path d="M5.5 10.5v3M9 10.5v3M12.5 10.5v3" />
    </Icon>
  );
}

/** Two arrows passing: the grid connection, which runs both ways. */
export function ExchangeIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 9h16l-4-4" />
      <path d="M20 15H4l4 4" />
    </Icon>
  );
}

export function TagIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M20.6 12.6 12.4 20.8a2 2 0 0 1-2.8 0L3 14.2V3h11.2l6.4 6.4a2 2 0 0 1 0 3.2Z" />
      <circle cx="8.5" cy="8.5" r="1.6" />
    </Icon>
  );
}

export function AlertIcon({ size = 14 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 4.5 2.5 20h19L12 4.5Z" />
      <path d="M12 10v4.5M12 17.4v.1" />
    </Icon>
  );
}
