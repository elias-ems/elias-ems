import { useEffect, useId, useRef, useState } from "react";
import type { EntitiesData } from "../lib/entities";
import { useFetchedJson } from "../lib/json-fetch";
import {
  errorStyle,
  fieldStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "./form";

type EntityAutocompleteProps = {
  name: string;
  label: string;
  placeholder?: string;
  error?: string;
  /** Shown under the field when there's no error and no load failure to show instead. */
  hint?: string;
  /** Pre-fills the field when editing an entity that already has one. */
  defaultValue?: string;
};

/** Long enough that typing a sensor name isn't one request per letter. */
const DEBOUNCE_MS = 200;

export default function EntityAutocomplete({
  name,
  label,
  placeholder,
  error,
  hint,
  defaultValue = "",
}: EntityAutocompleteProps) {
  const [query, setQuery] = useState(defaultValue);
  const [selected, setSelected] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  // The request is driven by the URL, so the debounce is on the query that
  // builds it rather than on the fetch itself: every keystroke re-renders,
  // only a pause requests.
  const [debounced, setDebounced] = useState(defaultValue);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Not `useFetcher`: a request that fails while somebody is typing is a route
  // error, and a route error would replace the settings page — and everything
  // typed into it — with an error page. See `lib/json-fetch.ts`.
  const { data, failing } = useFetchedJson<EntitiesData>(
    `/api/entities?${new URLSearchParams({ q: debounced })}`,
    { enabled: open },
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const entities = data?.entities ?? [];
  // The loader reports a Home Assistant it couldn't read as a value; `failing`
  // is the other half — the request never reaching the add-on at all.
  const loadError = failing ? "the add-on didn't answer" : data?.error;

  function selectEntity(entityId: string) {
    setSelected(entityId);
    setQuery(entityId);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ ...fieldStyle, position: "relative" }}>
      <label htmlFor={inputId} style={labelStyle}>
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected("");
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        style={inputStyle(Boolean(error))}
      />
      <input type="hidden" name={name} value={selected || query} />

      {open && entities.length > 0 && (
        <ul
          // The ARIA combobox pattern wants exactly this — a ul carrying
          // role=listbox wrapping li role=option. The rule doesn't model the
          // composite widget, so it reads the ul in isolation and objects.
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 10,
            margin: 0,
            marginTop: "0.25rem",
            padding: "0.25rem",
            listStyle: "none",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border-strong)",
            borderRadius: 4,
            maxHeight: 220,
            overflowY: "auto",
            boxShadow: "var(--shadow-popover)",
          }}
        >
          {entities.map((entity) => (
            // The li is presentational so the listbox's children are the
            // options themselves, which is what the role expects.
            <li key={entity.entityId} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={selected === entity.entityId}
                onClick={() => selectEntity(entity.entityId)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.4rem 0.5rem",
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                <div>{entity.name}</div>
                <div style={hintStyle}>
                  {entity.entityId}
                  {entity.unit ? ` · ${entity.unit}` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p style={errorStyle}>{error}</p>}
      {!error && open && loadError && (
        <p style={hintStyle}>
          Couldn't load Home Assistant entities: {loadError}. You can still type
          an entity ID manually.
        </p>
      )}
      {!error && !(open && loadError) && hint && (
        <p style={hintStyle}>{hint}</p>
      )}
    </div>
  );
}
