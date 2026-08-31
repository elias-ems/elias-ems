import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import { applyFormula } from "../../lib/price-formula";
import {
  PRICE_SOURCES,
  type PriceConfig,
  type PriceSourceSummary,
} from "../../lib/prices";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import {
  errorStyle,
  fieldStyle,
  formStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "../form";
import Section from "./Section";

/**
 * The formula's result at the current price, worked out in the browser as it is
 * typed.
 *
 * The same `applyFormula` the server will use, which is the whole reason the
 * evaluator lives in a pure module: this is a promise about what will happen
 * rather than a separate implementation that might drift. Nothing is saved
 * until the form is submitted, so a formula can be checked against a real
 * price before it is committed to.
 */
function FormulaPreview({
  formula,
  spotPerKwh,
  currency,
}: {
  formula: string;
  spotPerKwh: number | null;
  currency: string;
}) {
  if (spotPerKwh === null) {
    return (
      <p style={hintStyle}>
        Pick an entity and save to see this worked out against a real price.
      </p>
    );
  }

  const result = applyFormula(formula, spotPerKwh);

  return (
    <p style={result.ok ? hintStyle : errorStyle}>
      {result.ok
        ? `${spotPerKwh.toFixed(4)} → ${result.value.toFixed(4)} ${currency}/kWh`
        : result.error}
    </p>
  );
}

/** A formula field: monospaced, with its result underneath as it is typed. */
function FormulaField({
  name,
  label,
  hint,
  defaultValue,
  error,
  summary,
}: {
  name: string;
  label: string;
  hint: string;
  defaultValue: string;
  error?: string;
  summary: PriceSourceSummary;
}) {
  const inputId = useId();
  const [formula, setFormula] = useState(defaultValue);

  return (
    <div style={fieldStyle}>
      <label htmlFor={inputId} style={labelStyle}>
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={formula}
        onChange={(event) => setFormula(event.target.value)}
        style={{ ...inputStyle(Boolean(error)), fontFamily: "monospace" }}
      />
      <p style={hintStyle}>{hint}</p>
      {error ? (
        <p style={errorStyle}>{error}</p>
      ) : (
        <FormulaPreview
          formula={formula}
          spotPerKwh={summary.spotPerKwh}
          currency={summary.currency}
        />
      )}
    </div>
  );
}

export default function PricesSection({
  config,
  summary,
  actionData,
}: {
  config: PriceConfig;
  /** What the server made of the configured entity, on the last load. */
  summary: PriceSourceSummary;
  actionData?: SettingsActionData;
}) {
  const navigation = useNavigation();
  const errors = failureFor(actionData, "prices")?.errors ?? {};
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "prices-save";

  const sourceId = useId();
  // Held in state so the rest of the form can appear with the choice rather
  // than after a save — there is nothing to pick an entity for until then.
  const [source, setSource] = useState(config.source);
  const selected = PRICE_SOURCES.find((option) => option.id === source);

  // `summary` describes the entity that's actually saved, read back on the
  // last load — it can't know anything about an entity picked since. Track
  // what's currently in the field so the check below stops claiming to be
  // about it the moment they diverge, rather than showing a stale result
  // (most confusingly, the old entity's error) against the new pick until
  // the next save.
  const [liveEntityId, setLiveEntityId] = useState(config.forecastEntityId);
  const summaryIsCurrent = liveEntityId === config.forecastEntityId;
  const effectiveSummary: PriceSourceSummary = summaryIsCurrent
    ? summary
    : { ...summary, spotPerKwh: null };

  return (
    <Section
      title="Prices"
      description="Where the day-ahead energy prices come from, and the arithmetic that turns an exchange price into what you actually pay and are paid. Nothing acts on them yet — this imports and shows them."
    >
      <Form method="post" style={{ ...formStyle, marginTop: "1rem" }}>
        <input type="hidden" name="intent" value="prices-save" />

        <div style={fieldStyle}>
          <label htmlFor={sourceId} style={labelStyle}>
            Source
          </label>
          <select
            id={sourceId}
            name="source"
            value={source}
            onChange={(event) =>
              setSource(event.target.value as PriceConfig["source"])
            }
            style={inputStyle(Boolean(errors.source))}
          >
            {PRICE_SOURCES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {errors.source ? (
            <p style={errorStyle}>{errors.source}</p>
          ) : (
            selected && <p style={hintStyle}>{selected.description}</p>
          )}
        </div>

        {source === "home-assistant" && (
          <>
            <EntityAutocomplete
              name="forecastEntityId"
              label="Prices — the day-ahead sensor"
              placeholder="e.g. sensor.energi_epex_spot"
              defaultValue={config.forecastEntityId}
              error={errors.forecastEntityId}
              onValueChange={setLiveEntityId}
            />

            {/*
              The check that the right sensor was picked. An integration that
              publishes both a market price and a *total* price offers two
              plausible neighbours, and pointing a markup formula at the one
              that already includes markups double-counts into a number that
              still looks like a price. Reading back the series — and the
              worked-out prices below — is what makes that visible.

              Only shown while it's actually about the entity in the field:
              `summary` is a fact about what's saved, not what's typed.
            */}
            {summaryIsCurrent && (
              <>
                <p style={summary.ok ? hintStyle : errorStyle}>
                  {summary.detail}
                </p>
                {summary.spot && (
                  <p style={hintStyle}>
                    Now: {summary.spot} on the exchange · {summary.consumption}{" "}
                    to buy · {summary.production} to sell
                  </p>
                )}
              </>
            )}

            <FormulaField
              name="consumptionFormula"
              label="Consumption — what a kWh off the grid costs"
              hint="Arithmetic over `price`, the exchange price per kWh. e.g. ((price * 1.02) + 0.1272) * 1.06 for a slope, a fixed charge and VAT. `min` and `max` are available."
              defaultValue={config.consumptionFormula}
              error={errors.consumptionFormula}
              summary={effectiveSummary}
            />

            <FormulaField
              name="productionFormula"
              label="Production — what a kWh onto the grid earns"
              hint="Usually a different formula. e.g. max(price * 0.98 - 0.015, 0) to take a cut and never go below zero, or just 0.05 for a fixed injection tariff."
              defaultValue={config.productionFormula}
              error={errors.productionFormula}
              summary={effectiveSummary}
            />
          </>
        )}

        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save prices"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
