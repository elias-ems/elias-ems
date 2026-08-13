import type { LiveHealth } from "../lib/readings";
import { hintStyle } from "./form";

/** One label-and-value pair in the health list. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd style={{ margin: 0, color: "var(--color-text)" }}>{value}</dd>
    </>
  );
}

/**
 * The live path's health, spelled out — the detail behind the one-line summary
 * [LiveStatus](LiveStatus.tsx) shows at the top of the page.
 *
 * It lives inside the diagnostics box on the home page rather than beside it,
 * because it answers the question someone opening that box already has: the
 * decisions in the log are only as good as the readings behind them, and this
 * is where you find out whether those were arriving. Its own component rather
 * than part of the box, because the box is shared with the Tools page, where
 * "the live path" is one feature's concern among several.
 */
export default function LiveHealthFacts({ health }: { health: LiveHealth }) {
  return (
    <dl
      style={{
        ...hintStyle,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "0.15rem 0.75rem",
        margin: "0 0 0.75rem",
      }}
    >
      <Fact
        label="Home Assistant"
        value={health.connected ? "subscribed" : "not connected"}
      />
      <Fact label="Last change seen" value={health.lastEventAt ?? "none yet"} />
      <Fact label="Readings from" value={health.source ?? "nothing read yet"} />
      {/* Only worth the line once it has happened: a stable connection
          should not spend space telling you it is stable. */}
      {health.reconnects > 0 && (
        <Fact label="Reconnects" value={String(health.reconnects)} />
      )}
      {health.lastError && <Fact label="Last error" value={health.lastError} />}
    </dl>
  );
}
