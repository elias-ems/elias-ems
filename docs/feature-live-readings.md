# Live readings

The home page's numbers move as the house does. A sensor changes in Home
Assistant, and the dashboard shows the new value within a fraction of a second —
without the browser asking, and without the add-on asking either.

Nothing on this path is polled. The two hops both push.

```
Home Assistant ──WebSocket──▶ add-on ──SSE──▶ browser
  state_changed              ha-live         api/readings
```

## Home Assistant → the add-on

[`ha-live.server.ts`](../addon/app/lib/ha-live.server.ts) holds one WebSocket per
add-on process to `ws://supervisor/core/websocket` — the Supervisor's proxy to
Core's WebSocket API, reachable because [config.yaml](../addon/config.yaml) sets
`homeassistant_api: true`, and authenticated with the same `SUPERVISOR_TOKEN` the
REST calls use. Node 24 has a global `WebSocket` client, so nothing ships to make
this work.

The handshake is Home Assistant's: it sends `auth_required`, we answer with the
token, it answers `auth_ok`. Then two messages:

1. `get_states`, which seeds a cache of every entity, and
2. `subscribe_events` for `state_changed`, after which Home Assistant sends an
   event whenever anything in the house moves.

**The seed is not an optimisation.** Events only ever report what *changed*, so a
cache that started empty would have nothing to say about a sensor that happens to
sit still — and it has to be redone on every reconnect, because whatever moved
while the socket was down was never delivered to anyone. That is why a dropped
connection re-runs `get_states` rather than picking up where it left off.

Reconnection backs off from 1s to 30s with jitter. While disconnected the cache
stops answering — `liveStates()` returns null — and readers fall back to REST.

One subscription serves every browser. Two open dashboards do not mean two
sockets.

## The add-on → the browser

[`api.readings.tsx`](../addon/app/routes/api.readings.tsx) is a resource route
that returns a `text/event-stream` response and holds it open. It sends a
snapshot immediately, then pushes a new one whenever an entity *that is on the
page* changes, coalescing bursts into a single push every 500ms. A `: ping`
comment every 25s keeps idle connections from being closed underneath it.

Both the stream and the home loader build their payload with `readDashboard()`
from [`dashboard.server.ts`](../addon/app/lib/dashboard.server.ts). They have to
agree down to the formatting, because the stream's job is to replace what the
loader rendered — sharing the function is what makes that true by construction
rather than by discipline. Readings are formatted on the server for the reason
[`readings.server.ts`](../addon/app/lib/readings.server.ts) gives: the strings are
locale-dependent, and formatting them during render risks a hydration mismatch.

Server-sent events rather than a second WebSocket, because the traffic only goes
one way, `EventSource` reconnects itself, and a stream is a plain `Response` — no
dependency, and no upgrade handler reaching around React Router's request
handling.

## When it doesn't work

Every hop degrades instead of failing:

| What is wrong | What happens |
| --- | --- |
| The subscription isn't up yet, or Home Assistant isn't reachable | `readDashboard()` reads over REST, one request per entity, as it always did |
| No `SUPERVISOR_TOKEN` (any run outside Home Assistant) | No socket is dialled at all; the page reads over REST, which also fails, and says so |
| The token is refused | Reported as a rejected token rather than an unreachable server — the two look identical from outside and are fixed differently |
| The stream never opens, or stops delivering | The page falls back to revalidating the home loader every 5 seconds, which is what it did before this existed |

That last row is the one that matters most in production. **Home Assistant's
ingress proxy is the one thing that cannot be verified outside a real install**:
a proxy that buffers a `text/event-stream` response until it is complete turns
the stream into a connection that looks healthy and never delivers.
[`test/integration/readings-stream.test.ts`](../addon/test/integration/readings-stream.test.ts)
reproduces the shape of that failure against the mock ingress proxy, but only an
install proves it. If it ever does happen, the page is 5 seconds stale rather
than broken, and the browser's network tab shows it: repeated `.data` requests
mean the fallback took over.

## Testing it

The mock Home Assistant serves both halves of the Supervisor proxy — REST under
`/core/api` and the WebSocket at `/core/websocket` — sharing one state list, with
one way to change it: `POST /core/api/states/<id>`, exactly as the real API does.
A test moves a sensor once and both transports see it. `ws` is a devDependency
purely for that server half; node ships the client, which is the half the add-on
uses.

- `test/unit/ha-live.test.ts` — the handshake, the seed, an applied event, an
  entity removed, a reconnect that re-reads what it missed, and a refused token.
- `test/unit/dashboard.test.ts` — that the cache and REST produce the same page,
  and that the cache costs no round trip.
- `test/integration/readings-stream.test.ts` — the stream through the ingress
  proxy, and one Home Assistant subscription however many browsers are watching.
- `test/e2e/app.spec.ts` — a state changed at the mock appears on a rendered
  page, with no `.data` request anywhere, which is what proves the polling is
  gone rather than merely joined by a stream.
