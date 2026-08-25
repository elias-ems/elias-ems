/**
 * The playground's own frame: one component, its source file, and the states it
 * is being shown in.
 *
 * This file and its neighbour are the playground's chrome rather than part of
 * the app, and so are the two components deliberately absent from the
 * catalogue — nothing on a page of the add-on renders them, and cataloguing
 * them would be the page describing itself.
 *
 * Everything here is drawn in the app's own tokens, like the rest of the app,
 * so the frame follows Home Assistant's theme along with the specimens inside
 * it. That matters more than it sounds: a playground with its own hardcoded
 * light background would render every dark-theme bug invisible, which is one of
 * the two things this page exists to catch.
 */
import type { CSSProperties, ReactNode } from "react";
import { captionStyle, eyebrowStyle, monoStyle } from "../dashboard/chrome";
import { hintStyle } from "../form";

export function Specimen({
  id,
  name,
  path,
  note,
  children,
}: {
  /** The fragment the index links to. Stable, so a link can be shared. */
  id: string;
  name: string;
  /** Where the thing lives, relative to `app/`. */
  path: string;
  /** What it is for, or what is worth knowing about the states below. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      id={id}
      style={{
        // So a fragment link does not land the heading under the sticky bar.
        scrollMarginTop: 80,
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        background: "var(--color-surface)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <header
        style={{
          padding: "0.875rem 1.125rem",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem" }}>{name}</h3>
        <p style={{ ...captionStyle, ...monoStyle, margin: "0.25rem 0 0" }}>
          {path}
        </p>
        {note && (
          <p style={{ ...hintStyle, marginTop: "0.5rem", textWrap: "pretty" }}>
            {note}
          </p>
        )}
      </header>

      <div style={{ padding: "1.125rem" }}>{children}</div>
    </article>
  );
}

/**
 * One state of the specimen above it, with the state named.
 *
 * The label is not decoration. Half of what this page is for is the states
 * nobody can reach by configuring anything — a sensor that has gone
 * unavailable, a loop enabled but not running — and two of those side by side
 * are indistinguishable without a word saying which is which.
 */
export function Variant({
  label,
  /** The page canvas rather than a card, for the specimens that sit on it. */
  onCanvas = false,
  children,
}: {
  label: string;
  onCanvas?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={variantStyle}>
      <h4 style={eyebrowStyle}>{label}</h4>
      <div
        style={{
          background: onCanvas ? "var(--color-bg)" : undefined,
          borderRadius: onCanvas ? 8 : undefined,
          padding: onCanvas ? "0.75rem" : undefined,
        }}
      >
        {children}
      </div>
    </section>
  );
}

const variantStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.625rem",
  // Separated rather than boxed: a border around each state would put a second
  // frame inside the specimen's own, and several of the specimens are cards
  // that already have one.
  marginTop: "1.25rem",
};
