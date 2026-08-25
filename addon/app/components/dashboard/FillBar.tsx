/**
 * A share of something, with a caption saying what.
 *
 * The caption is not optional decoration. The same bar shape is used on this
 * page for an inverter's published limit and for a battery's state of charge,
 * and an unlabelled bar reading 42% next to a number reading 2,100 W leaves the
 * reader to guess which of the two it is a fraction of. That guess was the one
 * real ambiguity in the design this came from.
 */
import { captionStyle } from "./chrome";

export default function FillBar({
  percent,
  color,
  caption,
  label,
}: {
  /** 0–100, or null when nothing has been published and there is no fill. */
  percent: number | null;
  color: string;
  caption?: string;
  /** What the bar means, for a reader who cannot see it. */
  label: string;
}) {
  // Clamped rather than trusted: a state of charge sensor reporting 101 should
  // draw a full bar, not one that overflows its track.
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div>
      <div
        role="img"
        aria-label={
          percent === null
            ? `${label}: nothing published`
            : `${label}: ${width}%`
        }
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--color-surface-active)",
          overflow: "hidden",
        }}
      >
        <div
          style={{ width: `${width}%`, height: "100%", background: color }}
        />
      </div>
      {caption && (
        <div style={{ ...captionStyle, marginTop: 5 }}>{caption}</div>
      )}
    </div>
  );
}
