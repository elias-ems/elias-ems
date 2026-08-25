import { useEffect, useState } from "react";
import { useHref, useRevalidator } from "react-router";
import { sectionLabelStyle } from "../components/dashboard/chrome";
import DeviceTable from "../components/dashboard/DeviceTable";
import GridCard from "../components/dashboard/GridCard";
import PriceCard from "../components/dashboard/PriceCard";
import StrategyRail from "../components/dashboard/StrategyRail";
import { hintStyle } from "../components/form";
import LiveHealthFacts from "../components/LiveHealthFacts";
import LiveStatus from "../components/LiveStatus";
import { readControlConfig } from "../lib/control-config.server";
import {
  controlLoopStatus,
  curtailmentLoopStatus,
} from "../lib/control-loop.server";
import { readCurtailmentConfig } from "../lib/curtailment-config.server";
import type { DashboardReadings } from "../lib/dashboard";
import { readDashboard } from "../lib/dashboard.server";
import {
  batteryControlSummary,
  curtailmentSummary,
} from "../lib/dashboard-view";
import { readDiagnostics } from "../lib/diagnostics.server";
import { formatPricePerKwh } from "../lib/price-format.server";
import type { Route } from "./+types/_index";

/** How often the readings refresh themselves, in milliseconds. */
const REFRESH_INTERVAL = 5_000;

/**
 * The same, while the browser says the page is hidden. Slower rather than
 * stopped: the add-on panel usually sits in a background tab and there is no
 * point polling Home Assistant for nobody, but "hidden" is not something to
 * trust absolutely — a document embedded in an iframe reports it for reasons
 * that have nothing to do with whether a person is looking at the page, and a
 * refresh that stops entirely on a wrong answer never starts again.
 */
const HIDDEN_REFRESH_INTERVAL = 60_000;

/** Enough of the feed to be useful on first paint; it then polls for more. */
const INITIAL_LOG_ENTRIES = 20;

export async function loader() {
  const [readings, config, curtailmentConfig] = await Promise.all([
    readDashboard(),
    readControlConfig(),
    readCurtailmentConfig(),
  ]);

  return {
    ...readings,
    control: {
      enabled: config.enabled,
      status: controlLoopStatus(),
    },
    curtailment: {
      enabled: curtailmentConfig.enabled,
      // Formatted here rather than during render, for the reason every reading
      // on this page is: a locale-dependent string built in the component is a
      // hydration mismatch waiting to happen.
      thresholdPerKwh: curtailmentConfig.priceThresholdPerKwh,
      thresholdDisplay: formatPricePerKwh(
        curtailmentConfig.priceThresholdPerKwh,
        readings.prices.currency,
      ),
      settleSeconds: curtailmentConfig.settleSeconds,
      gridTargetW: curtailmentConfig.gridTargetW,
      deadbandW: curtailmentConfig.deadbandW,
      minLimitPercent: curtailmentConfig.minLimitPercent,
      status: curtailmentLoopStatus(),
    },
    // Both strategies in one list, newest first — what the rail's feed shows
    // until its first poll comes back.
    decisions: readDiagnostics({
      origins: ["pv-curtailment", "battery-control"],
      limit: INITIAL_LOG_ENTRIES,
    }),
  };
}

/**
 * Subscribes to the readings stream, which pushes a fresh set every time Home
 * Assistant says one of the entities on this page moved.
 *
 * Returns what to render and whether the stream is working. Until the first
 * message lands there is nothing to render but the loader's own data, which is
 * also what keeps hydration honest: the first client render is the server's.
 */
function useStreamedReadings(): {
  readings: DashboardReadings | null;
  streaming: boolean;
} {
  const [readings, setReadings] = useState<DashboardReadings | null>(null);
  const [streaming, setStreaming] = useState(false);

  // Through `useHref`, so the URL carries the ingress prefix. A bare
  // "/api/readings" would be resolved against the Home Assistant origin, where
  // this app is not served — the same trap the asset manifest falls into.
  const href = useHref("/api/readings");

  useEffect(() => {
    const source = new EventSource(href);

    source.addEventListener("message", (event) => {
      setReadings(JSON.parse(event.data) as DashboardReadings);
      setStreaming(true);
    });

    // EventSource reconnects on its own, so an error is not the end of the
    // stream — but it does mean this one is not delivering right now, which is
    // the moment to let polling take over. A stream that comes back says so
    // with its next message.
    source.addEventListener("error", () => setStreaming(false));

    return () => {
      source.close();
      setStreaming(false);
    };
  }, [href]);

  return { readings, streaming };
}

/**
 * Keeps the loader's readings current when the stream cannot: power is a live
 * value, so a number that never moves would be misleading.
 *
 * The next refresh is scheduled only once the previous one has come back,
 * rather than on a fixed interval. A `setInterval` would need a guard against
 * refreshes piling up on a slow Home Assistant, and every version of that guard
 * is one stuck request away from skipping every refresh from then on — the page
 * then sits there showing whatever it last managed to read, which is exactly
 * the failure this is meant to prevent.
 */
function useRefreshingReadings(enabled: boolean) {
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (!enabled) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let refreshing = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(
        refresh,
        document.visibilityState === "visible"
          ? REFRESH_INTERVAL
          : HIDDEN_REFRESH_INTERVAL,
      );
    };

    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      // A failed revalidation is already reported by the loader, which returns
      // the reason instead of throwing; all that matters here is that one bad
      // round does not end the schedule.
      await revalidate().catch(() => {});
      refreshing = false;
      if (!stopped) schedule();
    };

    // Coming back to the page should show current numbers straight away rather
    // than the minute-old ones it was left on.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, revalidate]);
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { control, curtailment, decisions } = loaderData;
  const { readings, streaming } = useStreamedReadings();

  // The stream's readings once it has sent any, the loader's until then. Both
  // are built by the same function on the server, so they are interchangeable.
  const { arrays, grid, batteries, prices, error, health } =
    readings ?? loaderData;

  const hasReadings =
    arrays.length > 0 ||
    grid.configured ||
    batteries.length > 0 ||
    prices.configured;

  // Only while the stream isn't delivering. If it never connects — an ingress
  // proxy that buffers, a browser with EventSource disabled — the page quietly
  // goes back to polling rather than showing numbers that stopped moving.
  useRefreshingReadings(hasReadings && !streaming);

  return (
    // The column, its gaps and its padding are in app.css with the rest of the
    // dashboard's layout, because the padding tightens on a phone and an inline
    // style has nowhere to put a media query.
    <main className="dash">
      {/* The page's own name is in the top bar, which is the only thing above
          this. A visible "Home" heading would say it a second time. */}
      <h1 className="visually-hidden">Home</h1>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        {hasReadings && <LiveStatus health={health} streaming={streaming} />}
        <span style={{ flexGrow: 1 }} />
        <details style={hintStyle}>
          <summary style={{ cursor: "pointer" }}>Connection detail</summary>
          <div style={{ marginTop: "0.5rem" }}>
            <LiveHealthFacts health={health} />
          </div>
        </details>
      </div>

      {error && (
        <p style={hintStyle}>
          Couldn't read live values from Home Assistant: {error}
        </p>
      )}

      <PriceCard
        prices={prices}
        thresholdPerKwh={curtailment.thresholdPerKwh}
        thresholdDisplay={curtailment.thresholdDisplay}
        curtailing={curtailment.enabled}
      />

      <GridCard
        configured={grid.configured}
        power={grid.power}
        powerW={grid.powerW}
        targetW={curtailment.gridTargetW}
        deadbandW={curtailment.deadbandW}
        settleSeconds={curtailment.settleSeconds}
        minLimitPercent={curtailment.minLimitPercent}
      />

      <h2 style={{ ...sectionLabelStyle, marginTop: "0.25rem" }}>
        Active strategies
      </h2>
      <StrategyRail
        curtailment={{
          summary: curtailmentSummary(arrays, {
            enabled: curtailment.enabled,
            running: curtailment.status.running,
          }),
          rule: curtailment.enabled ? (
            <>
              Holding the arrays back whenever a kWh put on the grid earns less
              than <strong>{curtailment.thresholdDisplay}</strong>, after{" "}
              {curtailment.settleSeconds} s off target.
            </>
          ) : (
            <>Switched off — no limit is published for any array.</>
          ),
        }}
        control={{
          summary: batteryControlSummary(batteries, {
            enabled: control.enabled,
            running: control.status.running,
          }),
          rule: control.enabled ? (
            <>
              Running the <strong>{control.status.strategy}</strong> strategy
              whenever a reading changes, at most every{" "}
              {control.status.intervalSeconds} s.
            </>
          ) : (
            <>Switched off — no target is published for any battery.</>
          ),
        }}
        initialEntries={decisions}
      />

      <h2 style={{ ...sectionLabelStyle, marginTop: "0.25rem" }}>
        Solar &amp; batteries
      </h2>
      <DeviceTable arrays={arrays} batteries={batteries} />
    </main>
  );
}
