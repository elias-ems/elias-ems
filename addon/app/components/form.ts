/**
 * The look shared by every form control and card on the settings and home pages.
 *
 * Colours are the `--color-*` tokens from [app.css](../app.css), never literal
 * hex: the tokens are what `light-dark()` switches, so a hardcoded colour here
 * would simply stop following Home Assistant's theme.
 */
import type { CSSProperties } from "react";

export const labelStyle: CSSProperties = {
  fontSize: "0.875rem",
  fontWeight: 600,
};

export const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

export function inputStyle(hasError?: boolean): CSSProperties {
  return {
    padding: "0.5rem",
    border: `1px solid ${
      hasError ? "var(--color-danger)" : "var(--color-border-strong)"
    }`,
    borderRadius: 4,
    font: "inherit",
  };
}

export const errorStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-danger)",
  margin: 0,
};

export const hintStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-text-muted)",
  margin: 0,
};

/*
 * A form fills the card it sits in, up to a measure a label and a field are
 * still comfortable at. The cap used to be what kept the page from being one
 * wide column; that job now belongs to the card, which is why this is a
 * readable-measure limit rather than a layout one.
 */
export const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  maxWidth: "36rem",
};

/** A button that reads as a link: used for Edit and Remove on a list row. */
export function linkButtonStyle(color: string): CSSProperties {
  return {
    border: "none",
    background: "none",
    padding: 0,
    color,
    cursor: "pointer",
    font: "inherit",
  };
}

export const rowStyle: CSSProperties = {
  padding: "0.75rem 0",
  borderBottom: "1px solid var(--color-border)",
};

export const headingStyle: CSSProperties = { margin: 0, fontSize: "1.1rem" };

/**
 * A page's own `h1`. Sized down from the browser's 2em default, which was
 * picked for a document rather than for a panel sitting under a top app bar.
 */
export const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.5rem",
  fontWeight: 600,
};

/**
 * The card a settings section is drawn as, matching the dashboard's.
 *
 * Kept here rather than imported from the dashboard's `chrome.ts`: that file
 * describes the look of a *reading*, and the two happen to agree today. Both
 * go through the same tokens, so they stay in step where it matters.
 */
export const cardStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  boxShadow: "var(--shadow-card)",
  padding: "1.125rem 1.25rem 1.25rem",
};
