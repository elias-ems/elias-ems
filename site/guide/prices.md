# Dynamic prices

If you are on a dynamic energy contract, Elias ems can read the day-ahead
exchange prices Home Assistant already has and turn them into the two numbers
that actually matter: **what a kWh costs you** and **what a kWh earns you**, for
every quarter hour of today and tomorrow.

::: tip One thing acts on this so far: PV curtailment.
[PV curtailment](/guide/pv-curtailment) reads the **production** leg and holds
your panels back while a kWh put on the grid earns less than it costs to make.
Battery control does not read prices at all yet — it still runs
net-zero-energy — so price-aware charging is still to come.

Either way, get the arithmetic below right first: curtailment acts on what your
production formula says, so a wrong formula is a wrong decision.
:::

## What you need

An integration that already publishes day-ahead prices in Home Assistant. Elias
ems does not fetch them itself, so it works with whatever you already trust:

| Integration | Works | Notes |
| --- | --- | --- |
| **Energi Data Service** | ✅ | Publishes `raw_today` / `raw_tomorrow`. |
| **EPEX Spot** (`mampfes`, HACS) | ✅ | Publishes a `data` attribute. Point at its **Market price**, not its Total price — see below. |
| **Nordpool** (custom, `custom-components`) | ✅ | Same `raw_today` shape as Energi. |
| **Nord Pool** (Home Assistant core) | ❌ | Its forecast is only reachable through an action, not an attribute, so there is nothing on the entity to read. Use one of the above for now. |

Anything else is read too, as long as it publishes one of those two shapes —
Elias ems recognises the **shape**, not the integration's name:

- a **`raw_today`** list (and optionally `raw_tomorrow`, taken only when the
  entity also says `tomorrow_valid`), where each entry has a `price` and a
  timestamp under `hour`, `start` or `start_time`;
- or a **`data`** list, where each entry has `start_time`, `end_time` and
  `price_per_kwh`.

Timestamps need their UTC offset on them, which every integration above
provides. If the entity sets `use_cent`, the prices are read as cents and
converted.

::: danger Point it at the raw market price, not an "all-in" total
Several integrations publish two price sensors: the bare exchange price, and a
total that already has your markup, grid fees and VAT folded in.

Elias ems applies *your* formula to whatever it reads. Give it the total and the
markup gets counted twice — and the result still looks like a plausible price,
which is what makes this worth getting right the first time. A house price near
€0.50/kWh where you expected €0.33 is the usual symptom.
:::

## Setting it up

On the **Settings** page, in the **Prices** section.

### 1. Pick the source

**Source** → *Home Assistant entity*. The rest of the form appears with the
choice.

### 2. Pick the entity

**Prices — the day-ahead sensor** autocompletes against your sensors, and also
takes an id typed in full.

### 3. Check what it found

This is the step worth not skipping. After saving, the section reads the series
back to you:

```
192 slots of 15 minutes · Aug 19 00:00 → Aug 21 00:00 · tomorrow included · Belgium

Now: 0.1037 EUR/kWh on the exchange · 0.2470 EUR/kWh to buy · 0.0866 EUR/kWh to sell
```

A price sensor is one entity among hundreds, and its neighbours look a lot like
it. That line is how you know you picked the right one before anything depends
on it — the slot count and interval, how far ahead it reaches, and whether
tomorrow has been published yet.

::: tip Tomorrow arrives in the early afternoon
The day-ahead auction clears around 13:00 CET, so `today only` before then is
normal and not a fault. If it still says `today only` at 18:00, the integration
hasn't refreshed — that is a question for the integration, not for Elias ems.
:::

### 4. Write the two formulas

The last two fields, and the substance of the whole feature. See below.

## The formulas

The exchange price is an **input to your contract, not the number on your
bill**. Your supplier takes the market price, applies a factor, adds a fixed
amount per kWh, and adds VAT — and does something different again for what you
inject. So Elias ems asks you for the arithmetic rather than guessing at it.

Both fields are ordinary arithmetic over one variable, `price`:

| | |
| --- | --- |
| `price` | The exchange price for that slot, **in your currency per kWh** |
| Operators | `+` `-` `*` `/`, parentheses, and a leading `-` |
| Functions | `min(a, b)` and `max(a, b)` |

::: tip Already using evcc?
`price` is per kWh, exactly as evcc's `formula` is, so a formula you have
already worked out for evcc's `grid` and `feedin` tariffs can be pasted straight
in.
:::

### A worked example

For a contract that takes the exchange price, adds 2%, adds a fixed 12.72
c/kWh of network costs and levies, and applies 6% VAT:

```
Consumption:  ((price * 1.02) + 0.1272) * 1.06
```

And for injection paid at 98% of the exchange price less a 1.5 c/kWh fee, never
going below zero:

```
Production:   max(price * 0.98 - 0.015, 0)
```

At an exchange price of 0.1821 EUR/kWh those give **0.3317** to buy and
**0.1635** to sell. The field shows you that as you type it:

```
0.1821 → 0.3317 EUR/kWh
```

### Reading it off your contract

Your contract almost certainly does not use these words, but it will have these
four things somewhere:

| What to look for | Where it goes |
| --- | --- |
| A factor or percentage on the market price | `price * 1.02` |
| A fixed amount per kWh — supplier fee, network costs, levies | `+ 0.1272` |
| VAT | `* 1.06` — applied to the whole thing, so wrap it in parentheses |
| A floor, if injection is never negative | `max(…, 0)` |

Everything is **per kWh**, so a contract quoting c/kWh needs dividing by 100:
12.72 c/kWh is `0.1272`.

::: tip A fixed injection tariff needs no market price at all
If you are paid a flat rate for what you export, the Production formula is just
that number — `0.05`. A formula that ignores `price` is a perfectly good
formula, and it is why there is no separate "fixed tariff" setting to find.
:::

### Why two formulas and not one

Because the two go in genuinely different directions, and a single price would
get both wrong at exactly the moment it matters — when the exchange price goes
**negative**.

At a market price of -0.05 EUR/kWh, the example formulas give:

| | |
| --- | --- |
| Consumption | **+0.0808 EUR/kWh** — still costs you money |
| Production | **0.0000 EUR/kWh** — earns you nothing |

Network costs and VAT do not go away when the market does, so a negative
exchange price rarely means free electricity. It very often *does* mean your
injection is worth nothing, or less — which is exactly the case [PV
curtailment](/guide/pv-curtailment) keys off. One number could not have told you
both.

### Checking it against a bill

Take an hour you have a real invoice line for, read the exchange price for that
slot off your integration, and put it through your formula by hand. If it does
not land within a rounding error of the bill, the formula is wrong — and it is
much easier to find out now than after a battery has been trading on it.

The Settings section shows the exchange price next to both derived numbers for
exactly this reason.

## On the dashboard

Once configured, the home page grows a **Prices** card:

```
Prices
Buying              Selling             Exchange
0.2470 EUR/kWh      0.0866 EUR/kWh      0.1037 EUR/kWh

07:30–07:45 · 192 slots · Aug 19 00:00 → Aug 21 00:00
```

**Buying** and **Selling** are your two formulas applied to the current slot.
**Exchange** is the raw market price they came from — it is there so the numbers
stay checkable at a glance rather than being three results you have to trust.

Underneath: which quarter hour these are for, and how far the forecast reaches.

The card updates itself as the slot rolls over, on the same live connection the
rest of the readings use. Nothing polls a clock.

## What can go wrong

Every failure states its reason on the card and in the Settings section rather
than showing a blank:

| What you see | What it means |
| --- | --- |
| *No price source* | Nothing picked yet. Not an error. |
| *Home Assistant has no entity called …* | The id is wrong, or the entity was renamed in Home Assistant. Renaming does not update here. |
| *That entity carries no price series* | The sensor exists but publishes no forecast — often the right integration but the wrong one of its sensors. |
| *…prices don't cover right now* | The forecast is real but has not been refreshed past the current time. Usually the integration, not Elias ems. |
| A dash where a price should be | That formula stopped evaluating. See below. |

::: warning A broken formula shows a dash, not a fallback
If one of your formulas stops producing a number — a division by zero, or a file
edited by hand — that side shows a dash and the other keeps working. It
deliberately does **not** fall back to the raw exchange price, because a market
price displayed under the label "Buying" is wrong by the whole of your network
costs and VAT, and looks entirely reasonable.
:::

Changes to a formula take effect immediately on the next page load — nothing is
cached, so you can adjust it and watch the number move.

## What it cannot do yet

- **Fetch prices on its own.** It reads what an integration publishes, so it
  depends on you having one installed and working. A built-in price client is
  the next step here.
- **Time-of-day network costs.** The fixed amount in your formula is a single
  number, so a day/night distribution split or a capacity tariff gets averaged
  into it rather than followed. If that matters for your contract, a Home
  Assistant template sensor doing the time-of-day arithmetic can be picked as
  the source like any other entity.
- **Act on the prices.** No strategy reads them yet.

## Next

[Diagnostics →](/guide/diagnostics)
