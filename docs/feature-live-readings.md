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

Everything that reads a state goes through
[`states.server.ts`](../addon/app/lib/states.server.ts), which answers from that
cache when it can and falls back to REST when it can't. Both the dashboard and
the control loop use it, so "where did this number come from, and how old is it"
has one answer rather than one per caller.

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

### Proving the connection is alive

A socket that closes is the easy failure. The hard one is a connection that dies
without either end noticing — a dropped route, a NAT table that forgot us —
because a half-open TCP socket never fires `close` and never errors. Home
Assistant sends nothing at all when nothing changes, so **silence on a healthy
connection and silence on a dead one are the same silence**.

Two watchdogs close that gap, both derived from one number (`HA_HEARTBEAT_MS`,
30s by default, and overridable so a test can reach these deadlines in
milliseconds):

| Watchdog | Fires after | Catches |
| --- | --- | --- |
| Ping/pong | a ping every 30s, answer due within 10s | a connection that went mute while open |
| Handshake | 15s from opening | a socket that is accepted and then never spoken on — the heartbeat hasn't started yet, so nothing else would notice |

Either one closes the socket, which drops it into the same reconnect path as an
ordinary disconnect.

## How old is this number?

Two different questions, deliberately answered by two different things. Confusing
them produces a system that either trusts stale data or refuses to act on good
data.

| | Question | Where it comes from |
| --- | --- | --- |
| **Link health** | Is our picture of the house current? | `haLiveStatus()` — connected, last event, last pong, reconnect count |
| **Entity age** | When did *this* value last change? | the state's own `last_updated`, carried on every `Reading` |

The trap is that **`last_updated` only moves when a value changes**. A battery
parked at exactly 0 W overnight emits no `state_changed` event at all, so its age
grows while nothing whatsoever is wrong. Home Assistant's `last_reported` and its
`state_reported` event answer this precisely, but that event is high-volume by
design, cannot be subscribed to broadly, and needs per-entity filters — so it is
not used here.

The consequence: **ages are advisory**. Nothing refuses to act on an old reading.
Home Assistant's own `unavailable` and `unknown` remain the only states that stop
a decision, which `toNumber()` in
[`readings.server.ts`](../addon/app/lib/readings.server.ts) has always handled.

That policy is only safe if a person can see what the machine is ignoring, which
is what the health chip is for.

## The health chip

[`LiveStatus.tsx`](../addon/app/components/LiveStatus.tsx) sits above the
readings and says one of three things:

| Chip | Means |
| --- | --- |
| **Live** · last change 3s ago | The subscription is up and the stream is delivering. With no changes yet, it dates itself by how long the link has been up instead. |
| **Reconnecting** · showing values read on request | The WebSocket is down. Readings still appear — over REST — which is exactly why this needs saying. |
| **Polling** · live updates aren't getting through | The server is fine; the browser's stream isn't. The page is revalidating every 5s instead. |

Hovering a reading shows when that particular value last changed, as an absolute
timestamp. The relative form ("3s ago") is rendered client-side only: a relative
time computed on the server is already wrong when it arrives, and rendering a
different string on hydration is the mismatch React warns about.

The debug box carries the detail — connected or not, last change seen, which
source the readings came from, reconnect count, last error.

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
  entity removed, a reconnect that re-reads what it missed, a refused token, an
  out-of-order event that must not overwrite a newer one, and — via the mock's
  `goSilent()` — a socket that goes mute without closing.
- `test/unit/states.test.ts` — that both sources produce the same answer and say
  which they are, and that a freshly fetched old reading is still reported as old.
- `test/unit/dashboard.test.ts` — that the cache and REST produce the same page,
  and that the cache costs no round trip.
- `test/integration/readings-stream.test.ts` — the stream through the ingress
  proxy, and one Home Assistant subscription however many browsers are watching.
- `test/e2e/app.spec.ts` — a state changed at the mock appears on a rendered
  page, with no `.data` request anywhere, which is what proves the polling is
  gone rather than merely joined by a stream.
