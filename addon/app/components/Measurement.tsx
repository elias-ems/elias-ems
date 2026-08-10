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
      >
        {reading ? reading.display : "—"}
      </div>
    </div>
  );
}
