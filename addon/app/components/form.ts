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

export const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  maxWidth: 420,
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
