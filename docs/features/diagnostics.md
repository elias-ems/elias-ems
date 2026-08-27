# Diagnostics

One log that every feature writes to, and that anyone supporting an
installation can read on screen or download and paste into an issue.

It replaces what used to be called the *debug log*: a buffer belonging to the
control loop, readable only from the box on the home page. The rename is not
cosmetic. The old one had nowhere for a second feature's lines to go, so the
next feature that needed to say something would have had to grow a log of its
own — and then an installation with three features would have three places to
look and no way to see the order things happened in.

## An entry

Defined in [addon/app/lib/diagnostics.ts](../../addon/app/lib/diagnostics.ts),
which is pure and shared with the browser bundle.

| Field | Meaning |
| --- | --- |
| `origin` | which feature logged it — `battery-control`, `pv-curtailment` or `prices` |
| `message` | the text; may be several lines |
| `at` | ISO timestamp, for the downloaded file |
| `time` | `HH:MM:SS` local, for the box |
| `level` | `info`, `warn` or `error`, which is what colours the line |
| `seq` | rises across every origin, so merged views have a total order |
| `repeat` | how many times in a row this origin logged this exact message |

Two timestamps rather than one because a locale- or timezone-dependent string
built during render is a hydration mismatch waiting to happen — the same reason
readings are formatted on the server. `time` is what the box prints; `at` is
what the file carries.

`origin` is a union, and adding a feature to it means one line there and one in
`DIAGNOSTICS_ORIGINS` (which also carries the display label). Nothing else keys
off the set: the box, the merge and the download are all driven by that list
rather than by a hardcoded set of boxes.

## Logging from a feature

```ts
import { appendDiagnostic } from "./diagnostics.server";

appendDiagnostic("battery-control", "warn", "The grid sensor is not configured.");
```

Battery control wraps it in a one-line `logControl()` helper in
[control-loop.server.ts](../../addon/app/lib/control-loop.server.ts), because
everything that module logs has the same origin.

Two things to know before adding calls:

- **One event, one entry.** The control loop appends a whole tick — a summary
  line plus one line per battery — as a single multi-line message rather than
  as several entries. Logged separately they would interleave, and the
  collapsing below would then never see two identical entries in a row.
- **Consecutive identical messages collapse** into a `×N` count, compared
  against that origin's own last entry rather than the log's. Another feature
  logging in between is not a reason to end a run that is still going.

## Where it is kept

[diagnostics.server.ts](../../addon/app/lib/diagnostics.server.ts): an in-memory
ring buffer of the last 300 entries **per origin**.

Per origin, not one shared buffer, because the origins are not equally chatty.
The control loop at a one-second interval would otherwise evict everything a
quieter feature had ever said, and a diagnostics log that only ever shows the
loudest feature is no use for the thing it is for.

It is **deliberately not persisted**. The control loop alone produces thousands
of lines an hour at a five-second interval, and writing those into `/data` would
buy nothing but wear on whatever the Home Assistant box boots from. An empty log
after a restart is intended, not a limitation to fix. The download is the answer
to "I want to keep this one"; persisting decisions for after-the-fact analysis
is a separate thing that wants its own store and a retention policy, not this
buffer made durable.

## Reading it

Two components read it, one per page.

### The box

[DiagnosticsBox.tsx](../../addon/app/components/DiagnosticsBox.tsx), on the
**Tools** page: every origin's entries merged, open by default, and the only
reader that shows all three at once.

It still takes an `origin` rather than being one component per feature. The home
page used to mount a filtered copy under each strategy's heading, and that
parameter is what kept two boxes from being two components; the dashboard
redesign replaced those copies with the decision feed below, so Tools is now the
only page that mounts it and it mounts it unfiltered. The parameter stays
because the argument for it hasn't changed — the next feature that wants a log
under its own heading needs it back, and the playground still exercises both
shapes.

`origin` is both the filter and the switch for whether each line says where it
came from: under a feature's own heading that would be the same word on every
line, and on the Tools page it is the only way to tell the entries apart.

While it is open it polls `GET /api/diagnostics` (with `?origin=` when it is
filtered) every two seconds, and only while the tab is visible. That route
touches nothing but memory — separate from the page loaders on purpose, since
the home loader reads every configured Home Assistant entity, which is far too
much work to repeat every couple of seconds, and its cadence is far too slow to
watch a five-second loop with. Closed, the box costs nothing.

Newest first, because that is the end anyone opening a box wants to read.

### The decision feed

[DecisionFeed.tsx](../../addon/app/components/dashboard/DecisionFeed.tsx), on
**Home**, inside the strategy rail: the two loops' entries merged into one list,
open and polling rather than collapsed. The strategies correct against the same
grid meter within milliseconds of each other, and the pair of decisions is the
thing worth seeing — a box each would have hidden the one relationship anyone
comes to the page for.

It asks the same route for two origins at once, rather than for none: an
unfiltered feed would fold in `prices`, which says nothing about what the house
just did and would push off the bottom the lines that do.

An entry from the control loop looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total.
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
```

### The download

`GET /api/diagnostics.txt`
([api.diagnostics\[.\]txt.tsx](../../addon/app/routes/api.diagnostics[.]txt.tsx))
answers with `text/plain` and a `Content-Disposition` naming the file
`elias-ems-diagnostics-<timestamp>.txt`. The **Download** button on the Tools
page is a plain `<a>` rather than a `<Link>`, so the browser makes a real
request and sees those headers instead of client-navigating.

The file is **oldest first**, the reverse of the box. A box is read from the end
backwards to see what just happened; a file is read from the top forwards to
follow what led up to something, which is also the order every other log it will
sit next to is in.

```
2026-08-13T20:50:57.000Z  battery-control  info (×12)
    Grid net +842 W (importing), batteries at 0 W → discharge 842 W total.
    Home battery: discharge at 842 W (SoC 76%, 6.6 kWh to 10%)
```

The message is indented under its header line so that grepping for a timestamp
finds entry starts only. The repeat count is on the header because a collapsed
run read as one event would understate how long something had been going on.

Two things about the route's filename. The `[.]` is flat-routes escaping — a
bare dot is a path separator there, which would make this a *child* of
`api.diagnostics`, and a resource route whose parent has a loader is no longer a
resource route: React Router would render it as a page instead of handing the
`Response` back untouched. And `Content-Type` carries `charset=utf-8` because
the entries contain `×` and `→`, which a browser left to guess renders as
mojibake.

## The Tools page

[tools.tsx](../../addon/app/routes/tools.tsx), sitting between Home and Settings
in the top bar. It exists as the place for the things you do *to* an
installation rather than the things you configure on it, which is why the
download lives here and not on the home page. Diagnostics is the first of its
two sections; the second is **Debug**, holding nothing but a link to the
component playground, and sitting below rather than beside because a page
anyone can reach should not put a developer's page at eye level.

## Tests

| Suite | What it covers |
| --- | --- |
| `test/unit/diagnostics.test.ts` | the buffer: stamping, collapsing (and not collapsing across levels), newest-first, the limit, per-origin filtering and merging, and the file format |
| `test/unit/control-loop.test.ts` | that the loop's own lines land under the `battery-control` origin, and collapse |
| `test/unit/routes.test.ts` | `/api/diagnostics` with and without a filter, an unknown origin falling back to no filter, the Tools loader, and the download's headers |
| `test/integration/ingress.test.ts` | both routes reached over HTTP through the ingress proxy — including that `/api/diagnostics.txt` really does come back as a text file rather than as a page |
| `test/e2e/app.spec.ts` | watching the decision feed fill on the home page, then the Tools page showing labelled entries and the button producing a file with them in it |

## Not done yet

- **Filtering or searching in the UI.** The two filters that exist are both
  fixed in code — the decision feed's pair of origins, the Tools box's none —
  and nothing lets a reader narrow the log themselves. Three origins and 300
  entries still fit in a scroll; a fourth writer, or a longer buffer, is what
  would change that.
- **Persistence and retention**, deliberately — see above.
