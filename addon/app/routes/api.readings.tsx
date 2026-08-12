/**
 * The readings the home page listens to, as server-sent events.
 *
 * This is the second half of the live path: `ha-live.server.ts` learns from
 * Home Assistant that something changed, and this hands it to every open
 * dashboard. Nothing here is polled — a browser opens one connection and the
 * server writes to it when there is something to say.
 *
 * Server-sent events rather than a second WebSocket: the traffic only ever goes
 * one way, `EventSource` reconnects itself, and a stream is a plain `Response`
 * that needs neither a dependency nor an upgrade handler reaching around React
 * Router. What the browser cannot do is guarantee the stream arrives — an
 * ingress proxy that buffers would swallow it — so the page keeps its polling
 * fallback and uses whichever works.
 */
import { readDashboard, watchedEntityIds } from "../lib/dashboard.server";
import { onHaChange } from "../lib/ha-live.server";
import type { Route } from "./+types/api.readings";

/**
 * A burst of state changes — an inverter and its meter reporting together, or
 * Home Assistant coming back after a restart — should cost one push, not one
 * per entity. Short enough that nobody watching sees the delay.
 */
const COALESCE_MS = 500;

/**
 * Idle connections get closed by proxies that see nothing on them. A comment
 * line is valid SSE that no client has to handle.
 */
const HEARTBEAT_MS = 25_000;

export async function loader({ request }: Route.LoaderArgs) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let sending = false;
      let coalesce: ReturnType<typeof setTimeout> | undefined;

      /** Which entities are worth pushing for. Re-read on every send, because saving settings changes them. */
      let watched = await watchedEntityIds();

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client is gone and the abort handler hasn't run yet.
          closed = true;
        }
      };

      const send = async () => {
        if (closed || sending) return;
        sending = true;
        try {
          const [readings, ids] = await Promise.all([
            readDashboard(),
            watchedEntityIds(),
          ]);
          watched = ids;
          write(`data: ${JSON.stringify(readings)}\n\n`);
        } catch (error) {
          // Losing one update is not worth closing a stream that is about to
          // get another; the page keeps showing what it last received.
          const message =
            error instanceof Error ? error.message : String(error);
          write(`event: warning\ndata: ${JSON.stringify(message)}\n\n`);
        } finally {
          sending = false;
        }
      };

      const schedule = () => {
        if (closed || coalesce) return;
        coalesce = setTimeout(() => {
          coalesce = undefined;
          void send();
        }, COALESCE_MS);
        coalesce.unref?.();
      };

      // Straight away, so the page can tell the stream is alive and stand its
      // polling down before the first reading ever changes.
      await send();

      const unsubscribe = onHaChange((changed) => {
        // Null means the cache was replaced or invalidated, so anything may
        // have moved; otherwise only the entities on screen are worth a push.
        if (changed === null || watched.has(changed)) schedule();
      });

      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(coalesce);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the connection dropped.
        }
      };

      // A closed tab has to take its listener and its timers with it, or every
      // visit leaves one behind for the life of the process.
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      // `no-transform` is the part that matters: it asks proxies in the middle
      // not to buffer or re-encode, which is the whole failure mode for SSE.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
