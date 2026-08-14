import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { EntitiesData } from "../lib/entities";
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
  const fetcher = useFetcher<EntitiesData>();
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const inputId = useId();

  // useFetcher returns a new object every render, so depending on fetcher.load
  // would restart the debounce on each render and refire the request. Only
  // query and open should retrigger it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetcher.load(`/api/entities?q=${encodeURIComponent(query)}`);
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

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

  const entities = fetcher.data?.entities ?? [];
  const loadError = fetcher.data?.error;

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
