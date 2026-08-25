/**
 * Reading JSON from one of the app's own API routes, in the browser, without
 * going through React Router's data layer.
 *
 * `useFetcher().load()` and `useRevalidator().revalidate()` do this job in
 * fewer lines, and both are what these hooks replaced. The difference is what
 * happens when the request never arrives. A rejected `fetch` — Home Assistant
 * restarting, the tunnel blinking, a laptop coming back from sleep — is a
 * *route error* to the data layer, and a route error replaces the page with
 * the nearest `ErrorBoundary`. For a navigation somebody asked for that is
 * exactly right. For a poll firing every two seconds it means one dropped
 * request takes out a dashboard that was left open, for good, until somebody
 * reloads it: the "TypeError: Failed to fetch" application error screen.
 *
 * So these use plain `fetch`, keep a failure as a flag rather than throwing
 * it, and leave the last good payload on screen. What to say about a failing
 * poll is the caller's decision, not this file's.
 */
import { useEffect, useState } from "react";
import { useHref } from "react-router";

export type JsonState<T> = {
  /** The most recent successful response, or null until one arrives. */
  data: T | null;
  /** Whether the last attempt failed — so `data`, if any, is stale. */
  failing: boolean;
};

type Options = {
  /** Stops requesting entirely while false. The last payload stays put. */
  enabled?: boolean;
  /** Repeat this often. Omitted means one request per URL, no repeats. */
  intervalMs?: number;
  /** The same while the page reports itself hidden. Defaults to `intervalMs`. */
  hiddenIntervalMs?: number;
  /** Whether to request as soon as it is enabled, rather than after one interval. */
  leading?: boolean;
};

/** One request per URL. */
export function useFetchedJson<T>(
  path: string,
  options: Pick<Options, "enabled"> = {},
): JsonState<T> {
  return useJson<T>(path, options);
}

/** The same, repeated, and tolerant of any single round failing. */
export function usePolledJson<T>(
  path: string,
  options: Options & { intervalMs: number },
): JsonState<T> {
  return useJson<T>(path, options);
}

function useJson<T>(
  path: string,
  { enabled = true, intervalMs, hiddenIntervalMs, leading = true }: Options,
): JsonState<T> {
  const [state, setState] = useState<JsonState<T>>({
    data: null,
    failing: false,
  });

  // Through `useHref`, so the URL carries the ingress prefix. A bare
  // "/api/whatever" would be resolved against the Home Assistant origin, where
  // this app is not served — the same trap the asset manifest falls into.
  // `useFetcher` did this for us; a hand-rolled `fetch` has to ask.
  const href = useHref(path);

  useEffect(() => {
    if (!enabled) return undefined;

    // Whatever failed last time it ran was a different connection ago. Without
    // this, a stream that dies leaves its fallback reporting a failure it has
    // not had yet, for the whole of the first interval.
    setState((previous) =>
      previous.failing ? { ...previous, failing: false } : previous,
    );

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;

    /**
     * The next round is scheduled once the previous has come back, rather than
     * on a fixed interval: a `setInterval` would need a guard against requests
     * piling up on a slow Home Assistant, and every version of that guard is
     * one stuck request away from skipping every round from then on.
     */
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || intervalMs === undefined) return;
      // Slower rather than stopped while hidden: the add-on panel usually sits
      // in a background tab and there is no point polling for nobody, but
      // "hidden" is not something to trust absolutely — a document embedded in
      // an iframe reports it for reasons that have nothing to do with whether
      // a person is looking at the page.
      timer = setTimeout(
        run,
        document.visibilityState === "visible"
          ? intervalMs
          : (hiddenIntervalMs ?? intervalMs),
      );
    };

    const run = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(href, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!stopped) setState({ data, failing: false });
      } catch {
        // Every failure is the same failure here: this round produced nothing.
        // Keeping the last payload and trying again is the entire point of the
        // hook, so there is nothing to rethrow to and nothing to log every two
        // seconds about.
        if (!stopped) setState((previous) => ({ ...previous, failing: true }));
      } finally {
        inFlight = false;
        schedule();
      }
    };

    if (leading) void run();
    else schedule();

    // Coming back to the page should show current values straight away rather
    // than the minute-old ones it was left on.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [href, enabled, intervalMs, hiddenIntervalMs, leading]);

  return state;
}
