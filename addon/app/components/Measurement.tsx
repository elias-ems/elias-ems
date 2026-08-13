import type { Reading } from "../lib/readings";
import { hintStyle } from "./form";

/** One live value with its label. Null means "we never got as far as reading it". */
export default function Measurement({
  label,
  reading,
}: {
  label: string;
  reading: Reading | null;
}) {
  return (
    <div>
      <div style={hintStyle}>{label}</div>
      <div
        style={{
          fontVariantNumeric: "tabular-nums",
          // Muted when the number isn't a real current value, so a stale or
          // missing reading doesn't look like a live one.
          color: reading?.ok ? "var(--color-text)" : "var(--color-text-muted)",
        }}
        title={updatedAtTitle(reading?.updatedAt ?? null)}
      >
        {reading ? reading.display : "—"}
      </div>
    </div>
  );
}

/**
 * When this value last changed, on hover.
 *
 * Absolute rather than relative, and formatted without a locale: both the
 * server and the browser render this string, so anything that depends on the
 * clock or on where the reader is would differ between them and break
 * hydration. The relative version lives in the status line, client-side.
 */
function updatedAtTitle(updatedAt: number | null): string | undefined {
  if (updatedAt === null) return undefined;
  const stamp = new Date(updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `Last changed ${stamp}`;
}
