import type { ReactNode } from "react";
import { hintStyle } from "../form";

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
    <section style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{title}</h2>
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
        <p style={{ ...hintStyle, marginTop: "0.35rem" }}>{description}</p>
      )}
      {children}
    </section>
  );
}
