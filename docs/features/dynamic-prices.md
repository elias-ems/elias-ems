# Dynamic prices

Day-ahead energy prices, imported from Home Assistant and put through the
arithmetic of your own contract, so the add-on knows what a kWh costs and what
one earns at any quarter hour.

**It imports and shows. Nothing acts on it yet.** No strategy reads these
numbers — price-aware battery control and PV curtailment are separate
[roadmap](../roadmap.md) items. Importing prices is worth having on its own,
and it is testable on its own.

Tracked in [issue #3](https://github.com/elias-ems/elias-ems/issues/3).

## What you configure

On the **Settings** page, stored as `prices.json` under the add-on's data
directory.

| Field | Meaning |
| --- | --- |
| `source` | `none` or `home-assistant` |
| `forecastEntityId` | the sensor carrying the day-ahead prices |
| `consumptionFormula` | what a kWh off the grid costs, from `price` |
| `productionFormula` | what a kWh onto the grid earns, from `price` |

`source` is a string enum with one real member rather than a boolean, for the
same reason `strategy` in `control.json` is one: adding a built-in
energy-charts or ENTSO-E client later should be one more entry in
`PRICE_SOURCES` and one more branch, with nothing already on disk needing to
change.

Both formulas are required and default to `price` — the identity, which reports
the raw exchange price. That default is honest rather than helpful: one
carrying a markup we guessed at would be a wrong number presented as a right
one.

### Only the configuration is stored

Not the forecast. While the source is a Home Assistant entity, **Home Assistant
*is* the store**: it fetched the prices, it persists them, and it restates them
after a restart. A second copy here would be a cache with nothing to add and
its own way of going stale.

That changes the day a built-in fetcher lands, at which point losing tomorrow's
prices to a restart at 23:00 becomes a real failure.

## Why two formulas

**The exchange price is an input to a contract, not the number on a bill.** A
dynamic tariff is `(spot × slope + markup) × VAT + charges` for consumption and
a *different* formula for injection — different markup, often a floor. Two
consequences, and both are the kind that produce wrong decisions rather than
visible errors:

- **A negative spot price usually does not mean a negative consumption price.**
  Distribution and levies are on the order of 10–15 c/kWh here, so spot has to
  go a long way below zero before importing pays. A strategy charging on
  `spot < 0` would charge at a loss for most negative hours.
- **It very often *does* mean a zero or negative production price** — which is
  exactly what PV curtailment will key off. A model with a single "price"
  cannot express the thing that feature exists for.

So both legs are derived from the same spot, and the raw spot is shown beside
them so the arithmetic can be checked against an actual bill.

A **fixed** injection tariff needs no extra machinery: it is a formula that
ignores `price`, like `0.05`. That is why one source with two formulas covers
the flexible case, and why there is no second tariff configuration the way evcc
has one.

### Applied at read time, not at import time

Deliberately the reverse of the obvious design. Deriving the two legs once and
storing them beside the spot would leave every stored slot stale the moment a
formula is edited, in exchange for saving arithmetic over a couple of hundred
numbers. So what is stored is what the market said, and the contract is applied
on the way out — which makes editing a formula take effect on the next render,
as anyone would expect a settings field to.

## The formula language

In [addon/app/lib/price-formula.ts](../../addon/app/lib/price-formula.ts) — a
recursive-descent parser over four operators, parentheses, unary minus, one
variable and two functions:

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/') unary)*
unary      := '-' unary | primary
primary    := NUMBER | 'price' | '(' expression ')'
            | ('min' | 'max') '(' expression ',' expression ')'
```

`price` is the exchange price **in the currency per kWh**, deliberately the
same unit evcc's `formula` uses, so a formula written for evcc ports over
verbatim. Per MWh — the unit the raw APIs publish — would silently turn every
ported formula into a 1000× error.

```
consumption:  ((price * 1.02) + 0.1272) * 1.06
              0.1821 → 0.3317 EUR/kWh

production:   max(price * 0.98 - 0.015, 0)
              0.1821 → 0.1635 EUR/kWh
             -0.0500 → 0.0000 EUR/kWh
```

`min` and `max` are in from the start because the floor case is real: an
injection tariff that cannot go below zero is what `max(…, 0)` is for, and
evcc's own example reaches for `math.Max` for the same reason.

### Why it is hand-written

**Not `eval` or `new Function`.** The formula arrives from a JSON file on disk.
Compiling it to JavaScript would turn a hand-edited `prices.json` into
arbitrary code execution inside a container holding `SUPERVISOR_TOKEN` — a
privilege escalation, not a theoretical concern.

**Not a dependency either.** `mathjs` brings units, matrices and symbolic
algebra; `expr-eval` still ships variable assignment and user-defined
functions. All surface, none of it wanted. The only identifier reachable from a
parsed formula is `price`, because no environment is ever constructed for one
to escape into.

Two policies:

- **Validated at save time.** The settings action parses before anything
  reaches disk, so a formula that first fails at 03:00 is impossible. The form
  also previews it in the browser using the identical evaluator — that is what
  the pure module is for — but the server check is the one that binds, since
  nothing stops a form being posted directly.
- **A stored formula that no longer parses leaves its leg empty**, and does not
  fall back to `price`. Reporting the raw exchange price under the label
  "consumption" would be wrong by the whole of the grid fees and VAT: precisely
  the failure that is hardest to notice and most expensive to act on.

## Reading a price entity

No new transport. `readStates()` in
[states.server.ts](../../addon/app/lib/states.server.ts) already returns the
full state including `attributes`, from the live cache or over REST, already
stamped with which source answered. The adapter is a pure function from those
attributes to a forecast.

The price entity joins the **single entity list** in
[dashboard.server.ts](../../addon/app/lib/dashboard.server.ts), which is the
whole of what makes prices live: its state changes at every slot boundary, so
the WebSocket says so and the readings stream pushes a new card. **Nothing here
polls a clock.**

### Which attributes are needed

Detection is by **shape, not by integration name** — naming integrations would
mean a new branch for every fork of one.

| Attribute | Required | What happens to it |
| --- | --- | --- |
| `raw_today` | **yes** | the series: `[{ hour, price }]`. This alone is enough |
| `raw_tomorrow` | no | appended, **only** when `tomorrow_valid` |
| `tomorrow_valid` | with the above | the gate on it |
| `use_cent` | no | ÷100 when true |
| `currency` | no | the label; EUR assumed |
| `region`, `attribution` | no | shown so a picked entity can be recognised |

`data: [{ start_time, end_time, price_per_kwh }]` — what the EPEX Spot
integration publishes — is read too, and is the one shape that states its own
ends. `raw_today`/`raw_tomorrow` covers Energi Data Service and the older custom
Nordpool component.

Everything else is ignored on purpose. The bare `today`/`tomorrow` float arrays
are the same numbers without timestamps; the `today_min`/`max`/`mean` sensors are
derived, and pre-markup anyway; and `current_price` and the entity's own state
are ignored so that the number shown and the series it came from **cannot
disagree** — the current price is whichever slot contains the current instant.

### The traps

All six are visible in a single real Belgian entity, and every one of them is
covered in
[test/unit/prices-model.test.ts](../../addon/test/unit/prices-model.test.ts).

1. **The key is called `hour` and the cadence is fifteen minutes.** The
   day-ahead auction has cleared in 15-minute intervals across the coupled
   European bidding zones since 1 October 2025; the field name is a leftover.
   The interval is measured from the data, never assumed.
2. **There is no `end`.** A slot ends where the next begins; the last gets one
   median interval. The median rather than the first gap or the mean, because a
   DST day contains one gap an hour off the rest.
3. **Ends are capped at an hour.** No coupled European day-ahead market
   publishes a longer product, so a wider gap is *missing data* rather than a
   long slot. Without the cap, a feed that stopped at 03:00 would leave one
   nineteen-hour slot and every read through the afternoon would answer
   confidently with a price nobody published. Capping leaves the gap a gap and
   `slotAt` returns null inside it. The same cap is what lets an hourly slot
   sit inside a quarter-hourly series, which Home Assistant's Nord Pool
   integration warns it publishes while its markets migrate.
4. **Timestamps carry an offset** (`+02:00`), which is what makes them
   unambiguous. It is also what makes the October DST day work: it has 100
   quarter-hours, and `02:00+02:00` and `02:00+01:00` are different instants an
   hour apart. Parsing as wall-clock time would fold them together and lose an
   hour of prices. Everything is stored as UTC instants.
5. **`use_cent` is a factor-100 error waiting to happen** — the same payload,
   the same shape, values a hundred times bigger.
6. **The entity must carry the raw market price, not a total.** The EPEX Spot
   integration publishes both a *Market price* and a *Total price* that already
   includes markups; pointing a markup formula at the second one double-counts
   into a number that still looks like a price.

That last one is why the Settings page reads the series back the moment an
entity is picked — the slot count, the interval, the span, whether tomorrow
arrived — and shows both derived prices next to the raw one. A price entity is
a needle in a haystack of hundreds of sensors, and an all-in rate near €0.50/kWh
is obviously wrong in a way a stored number never would be.

## What it shows

- **Home** — a **Prices** card: buying, selling, and the exchange price they
  came from, with the quarter hour they are for and how far the forecast
  reaches. It updates over the existing readings stream.
- **Diagnostics** — a `prices` origin, written **on save only**. The read path
  runs on every dashboard render and every stream push, so logging what it found
  would fill the buffer with one sentence; the card carries that state instead.
  A configuration change is rare, deliberate, and exactly what somebody reading
  back a control decision later needs to see beside it.

## When it doesn't work

Every case degrades to a stated reason rather than an empty card:

| What is wrong | What happens |
| --- | --- |
| No source picked | The card says so. Not an error — nothing has failed |
| Home Assistant unreachable | Said plainly, like every other reading |
| The entity id has gone stale | Named, since that is what has to be fixed |
| The entity is not a price feed | Says which attributes were looked for |
| The prices don't reach the current instant | The forecast is kept and shown; only the *current* price is reported missing |
| A formula no longer parses | That leg alone is empty. The other still reports |

## Tests

| Suite | What it covers |
| --- | --- |
| `test/unit/price-formula.test.ts` | precedence, unary minus, `min`/`max`, a bare constant (the fixed-tariff case), division by zero reported rather than passed along, and that `process.exit(1)`, `globalThis`, `require('fs')` and friends are parse errors rather than calls |
| `test/unit/prices-model.test.ts` | a captured Belgian entity: quarter hours under an `hour` key, end derivation, the hour cap holding a gap open and letting a mixed-cadence hour through, `use_cent`, `tomorrow_valid: false`, both DST days, the `data` shape, `slotAt` on a boundary, and a negative spot staying a positive consumption price |
| `test/unit/prices-store.test.ts` | the config round trip, a hand-edited file, which entities the door asks for, and each failure above |
| `test/unit/routes.test.ts` | the settings intent, a formula rejected by the action rather than only by the form, and the diagnostics entry |

## Not done yet

- **A built-in price client**, so the feature works without depending on an
  integration the add-on can neither install nor verify.
  [energy-charts](https://api.energy-charts.info) is the obvious first one —
  no registration and no token, already quarter-hourly, covering most of the
  coupled zones — with ENTSO-E as the escape hatch for the rest. That is when a
  forecast cache and a fetch schedule become necessary, and when the ~13:00 CET
  publication time starts to matter.
- **Home Assistant's Nord Pool integration**, whose forecast is not an attribute
  at all: it is only reachable through the `nordpool.get_prices_for_date`
  action, which is a call rather than a subscription and so has to be polled.
- **Time-of-use grid fees** are deliberately out. A day/night distribution
  split or a capacity tariff cannot be expressed, and the flat term in the
  formula stands in for their average. If it ever needs to move with the clock,
  a Home Assistant template sensor doing the time-of-day arithmetic can be
  picked as the source like any other entity.
- **Publishing prices back to Home Assistant** as a sensor, which would make
  them usable in your own automations and the Energy dashboard.
- **Anything acting on them.**
