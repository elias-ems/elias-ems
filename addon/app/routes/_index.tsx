import { useEffect, useState } from "react";
import { useHref } from "react-router";
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
import { CURTAILMENT_STRATEGIES } from "../lib/curtailment";
import { readCurtailmentConfig } from "../lib/curtailment-config.server";
import type { DashboardReadings } from "../lib/dashboard";
import { readDashboard } from "../lib/dashboard.server";
import {
  batteryControlSummary,
  curtailmentSummary,
} from "../lib/dashboard-view";
import { DECISION_ORIGINS } from "../lib/diagnostics";
import { readDiagnostics } from "../lib/diagnostics.server";
import { usePolledJson } from "../lib/json-fetch";
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
      // Null under `threshold`, which is the rule the card already describes by
      // showing the threshold at all — naming it there too would be one more
      // figure saying nothing new.
      strategyLabel:
        curtailmentConfig.strategy === "threshold"
          ? null
          : (CURTAILMENT_STRATEGIES.find(
              (strategy) => strategy.id === curtailmentConfig.strategy,
            )?.label ?? null),
      settleSeconds: curtailmentConfig.settleSeconds,
      gridTargetW: curtailmentConfig.gridTargetW,
      deadbandW: curtailmentConfig.deadbandW,
      minLimitPercent: curtailmentConfig.minLimitPercent,
      status: curtailmentLoopStatus(),
    },
    // Both strategies in one list, newest first — what the rail's feed shows
    // until its first poll comes back.
    decisions: readDiagnostics({
      origins: DECISION_ORIGINS,
      limit: INITIAL_LOG_ENTRIES,
    }),
  };
}

/**
 * The readings the page shows, however they can be got: the stream while it is
 * delivering, and a poll of the same readings while it isn't.
 *
 * Power is a live value, so a number that never moves is worse than no number
 * — hence the fallback. It exists because nothing guarantees the stream
 * arrives: an ingress proxy that buffers, a browser with `EventSource`
 * disabled, a connection that dropped and hasn't come back.
 *
 * Returns what to render, whether the stream is working, and whether the
 * add-on is answering at all. Until the first message or the first poll lands
 * there is nothing to render but the loader's own data, which is also what
 * keeps hydration honest: the first client render is the server's.
 */
function useLiveReadings(enabled: boolean): {
  readings: DashboardReadings | null;
  streaming: boolean;
  reachable: boolean;
} {
  const [streamed, setStreamed] = useState<DashboardReadings | null>(null);
  const [streaming, setStreaming] = useState(false);

  // Through `useHref`, so the URL carries the ingress prefix. A bare
  // "/api/readings" would be resolved against the Home Assistant origin, where
  // this app is not served — the same trap the asset manifest falls into.
  const href = useHref("/api/readings");

  useEffect(() => {
    const source = new EventSource(href);

    source.addEventListener("message", (event) => {
      setStreamed(JSON.parse(event.data) as DashboardReadings);
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

  // Deliberately not `useRevalidator`: a revalidation that fails is a route
  // error, and a route error replaces this page with the error boundary. The
  // fallback runs precisely when the connection is unreliable, so that is a
  // dashboard destroying itself over the one round it was built to survive.
  // See `lib/json-fetch.ts`.
  const { data: polled, failing } = usePolledJson<DashboardReadings>(
    "/api/readings?snapshot=1",
    {
      enabled: enabled && !streaming,
      intervalMs: REFRESH_INTERVAL,
      hiddenIntervalMs: HIDDEN_REFRESH_INTERVAL,
      // One interval's grace before the first poll: on a normal load the
      // stream's opening message is already on its way, and polling for the
      // same readings alongside it would cost Home Assistant a second read of
      // every entity for nothing.
      leading: false,
    },
  );

  return {
    // Whichever is the more recent: the stream while it delivers, the poll
    // once it has stopped and the poll has caught up.
    readings: (streaming ? streamed : (polled ?? streamed)) ?? null,
    streaming,
    reachable: streaming || !failing,
  };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { control, curtailment, decisions } = loaderData;

  // Read from the loader rather than from the readings below, which is what
  // lets it gate the hook that produces them. It answers the same question
  // either way: what is configured only changes on the settings page, which
  // comes back here as a navigation and a fresh loader.
  //
  // Nothing configured is nothing to refresh, and nothing to report the health
  // of: an empty installation would poll Home Assistant forever to be told
  // again that it has no entities.
  const configured =
    loaderData.arrays.length > 0 ||
    loaderData.grid.configured ||
    loaderData.batteries.length > 0 ||
    loaderData.prices.configured;

  const { readings, streaming, reachable } = useLiveReadings(configured);

  // Whatever arrived last, the loader's own until something does. All three are
  // built by the same function on the server, so they are interchangeable.
  const { arrays, grid, batteries, prices, error, health } =
    readings ?? loaderData;

  return (
    // The column, its gaps and its padding are in app.css with the rest of the
    // dashboard's layout, because the padding tightens on a phone and an inline
    // style has nowhere to put a media query. `page` is the shell every route
    // shares; `dash` is what this one stacks inside it.
    <main className="page dash">
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
        {configured && (
          <LiveStatus
            health={health}
            streaming={streaming}
            reachable={reachable}
          />
        )}
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
        strategyLabel={curtailment.strategyLabel}
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
