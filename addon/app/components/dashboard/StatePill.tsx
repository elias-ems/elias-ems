/**
 * What a strategy is doing right now, in one word.
 *
 * The tone carries the difference between the three states that matter and that
 * a label alone blurs: *acting* is filled in the feature's own colour, *armed
 * but with nothing to do* is outlined, and *switched off in settings* is
 * outlined in grey. A reader scanning the page should be able to tell those
 * apart without reading the word.
 */
import type { ReactNode } from "react";
import type { StrategyTone } from "../../lib/dashboard-view";

const TONES: Record<StrategyTone, { color: string; background: string }> = {
  pv: { color: "var(--color-pv)", background: "var(--color-pv-soft)" },
  battery: {
    color: "var(--color-battery)",
    background: "var(--color-battery-soft)",
  },
  warn: {
    color: "var(--color-warning)",
    background: "var(--color-warning-soft)",
  },
  // Outlined rather than tinted: nothing is happening, so nothing should draw
  // the eye. The border is what keeps it reading as a status and not as text.
  idle: { color: "var(--color-text-muted)", background: "transparent" },
  off: { color: "var(--color-text-muted)", background: "transparent" },
};

export default function StatePill({
  tone,
  children,
}: {
  tone: StrategyTone;
  children: ReactNode;
}) {
  const { color, background } = TONES[tone];
  const outlined = background === "transparent";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.1875rem 0.5625rem 0.1875rem 0.4375rem",
        borderRadius: 999,
        fontSize: "0.71875rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        background,
        color,
        border: `1px solid ${outlined ? "var(--color-border-strong)" : "transparent"}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "0.375rem",
          height: "0.375rem",
          borderRadius: "50%",
          background: "currentColor",
          flex: "none",
        }}
      />
      {children}
    </span>
  );
}
