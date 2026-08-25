/**
 * The look shared by the dashboard's cards, the way [form.ts](../form.ts) holds
 * the one shared by the settings controls.
 *
 * Same rule as there, and it matters more here because this file is nothing but
 * colour: every value goes through a `--color-*` token from
 * [app.css](../../app.css), never a literal. A hardcoded colour is by definition
 * wrong in one of the two themes.
 */
import type { CSSProperties } from "react";

export const cardStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  boxShadow: "var(--shadow-card)",
};

/**
 * The label above a card's contents — "Price now", "Grid exchange".
 *
 * Small caps rather than a heading size: on a dashboard these name a panel
 * rather than introduce a section, and at heading weight they compete with the
 * number they are labelling, which is the thing the page exists to show.
 */
export const eyebrowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  margin: 0,
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "var(--color-text-muted)",
};

/** The same, one level up: the label over a group of cards. */
export const sectionLabelStyle: CSSProperties = {
  ...eyebrowStyle,
  letterSpacing: "0.1em",
};

export const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};

/**
 * The unit beside a value. Sized in `em` so one declaration works under a 40px
 * headline and a 14px table cell alike.
 */
export const unitStyle: CSSProperties = {
  fontSize: "0.42em",
  fontWeight: 500,
  color: "var(--color-text-muted)",
  marginLeft: "0.35em",
  letterSpacing: 0,
};

/** The sentence under a strategy saying what it is set up to do. */
export const ruleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  lineHeight: 1.55,
  color: "var(--color-text-muted)",
  textWrap: "pretty",
};

/**
 * Links inside a card.
 *
 * Underlined as well as coloured, which the rest of the app does not do: these
 * are 12px and sit inside a paragraph of muted text, where colour alone is both
 * the only signal that they are links and the one a colour-blind reader misses.
 */
export const cardLinkStyle: CSSProperties = {
  color: "var(--color-link)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

export const captionStyle: CSSProperties = {
  fontSize: "0.65625rem",
  lineHeight: 1.4,
  color: "var(--color-text-muted)",
};

/** A small outlined label: "not curtailable", "released". */
export const tagStyle: CSSProperties = {
  fontSize: "0.65625rem",
  fontWeight: 600,
  padding: "0.125rem 0.375rem",
  borderRadius: 4,
  border: "1px solid var(--color-border-strong)",
  color: "var(--color-text-muted)",
  whiteSpace: "nowrap",
};

/**
 * The same, in a feature's own colour.
 *
 * Filled rather than outlined, because these say something is *being done* —
 * an array held at 42% — and an outline reads as the resting state.
 */
export function accentTagStyle(
  color: string,
  background: string,
): CSSProperties {
  return {
    ...tagStyle,
    border: "1px solid transparent",
    background,
    color,
  };
}

/** The icon plate at the head of a strategy row. */
export function iconPlateStyle(
  color: string,
  background: string,
): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 8,
    background,
    color,
    flex: "none",
  };
}
