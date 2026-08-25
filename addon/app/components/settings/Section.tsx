import type { ReactNode } from "react";
import { cardStyle, headingStyle, hintStyle } from "../form";

type SectionProps = {
  title: string;
  description?: string;
  /** When given, the header carries a `+` toggle for that section's add form. */
  add?: {
    label: string;
    open: boolean;
    onToggle: () => void;
  };
  children: ReactNode;
};

export default function Section({
  title,
  description,
  add,
  children,
}: SectionProps) {
  return (
    // A card rather than a run of headings: the sections sit side by side
    // once the panel is wide enough, and columns of text with nothing drawn
    // around them read as one column that has lost its way.
    <section style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <h2 style={headingStyle}>{title}</h2>
        {add && (
          <button
            type="button"
            onClick={add.onToggle}
            aria-label={add.label}
            title={add.label}
            aria-expanded={add.open}
            style={{
              width: "2rem",
              height: "2rem",
              flex: "none",
              borderRadius: "999px",
              border: "1px solid var(--color-border-strong)",
              background: add.open
                ? "var(--color-surface-active)"
                : "var(--color-surface)",
              fontSize: "1.25rem",
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            +
          </button>
        )}
      </div>
      {description && (
        // A card can be wider than a paragraph wants to be, so the sentence
        // stops at a readable measure instead of running the card's width.
        <p style={{ ...hintStyle, marginTop: "0.35rem", maxWidth: "62ch" }}>
          {description}
        </p>
      )}
      {children}
    </section>
  );
}
