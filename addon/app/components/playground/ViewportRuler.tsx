/**
 * How wide the window is, and which of the dashboard's breakpoints that puts it
 * past.
 *
 * Here because a third of what this page shows changes shape with the viewport,
 * and two of those pieces — the price chart and the device table — are *two
 * renderings with one hidden*, not one that reflows. Resizing the window until
 * something changes tells you nothing about which copy you are looking at or
 * what the next threshold is; this says both.
 *
 * The breakpoints are read off the `Dashboard layout` block in app.css rather
 * than shared with it, because CSS media queries are not readable from script.
 * If one moves there, it has to move here too — which is the cost of having the
 * numbers written down twice and the reason they are commented in both places.
 */
import { useEffect, useState } from "react";
import { captionStyle, monoStyle } from "../dashboard/chrome";

const BREAKPOINTS = [
  { at: 480, what: "top bar tightens" },
  { at: 560, what: "wide price chart" },
  { at: 620, what: "device table, strategy metric column" },
  { at: 640, what: "dashboard padding, feed shows all rows" },
  { at: 880, what: "grid card goes to three columns" },
  { at: 920, what: "strategy rail splits off the feed" },
  { at: 1000, what: "price card splits off the chart" },
];

export default function ViewportRuler() {
  // Null until the browser has taken over: the server has no window, and
  // rendering a guessed width would be markup the first client render disagrees
  // with.
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        gap: "0.4rem 0.75rem",
      }}
    >
      <span style={{ ...monoStyle, fontSize: "0.875rem", fontWeight: 600 }}>
        {width === null ? "—" : `${width} px`}
      </span>
      <span style={captionStyle}>
        {BREAKPOINTS.map(({ at, what }, index) => (
          <span key={at}>
            {index > 0 && " · "}
            <span
              style={{
                fontWeight: width !== null && width >= at ? 600 : 400,
                color:
                  width !== null && width >= at
                    ? "var(--color-text)"
                    : "var(--color-text-muted)",
              }}
              title={what}
            >
              {at}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
