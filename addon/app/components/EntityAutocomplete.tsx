import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { EntityOption } from "../lib/entities";

type EntitiesData = {
  entities: EntityOption[];
  error: string | null;
};

type EntityAutocompleteProps = {
  name: string;
  label: string;
  placeholder?: string;
  error?: string;
  /** Pre-fills the field when editing an entity that already has one. */
  defaultValue?: string;
};

export default function EntityAutocomplete({
  name,
  label,
  placeholder,
  error,
  defaultValue = "",
}: EntityAutocompleteProps) {
  const [query, setQuery] = useState(defaultValue);
  const [selected, setSelected] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<EntitiesData>();
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputId = useId();

  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetcher.load(`/api/entities?q=${encodeURIComponent(query)}`);
    }, 200);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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
    <div
      ref={containerRef}
      style={{ position: "relative", display: "flex", flexDirection: "column", gap: "0.25rem" }}
    >
      <label htmlFor={inputId} style={{ fontSize: "0.875rem", fontWeight: 600 }}>
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
        style={{
          padding: "0.5rem",
          border: `1px solid ${error ? "#e12d39" : "#cbd2d9"}`,
          borderRadius: 4,
          font: "inherit",
        }}
      />
      <input type="hidden" name={name} value={selected || query} />

      {open && entities.length > 0 && (
        <ul
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
            background: "#fff",
            border: "1px solid #cbd2d9",
            borderRadius: 4,
            maxHeight: 220,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
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
                <div style={{ fontSize: "0.75rem", color: "#7b8794" }}>
                  {entity.entityId}
                  {entity.unit ? ` · ${entity.unit}` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p style={{ fontSize: "0.75rem", color: "#e12d39", margin: 0 }}>{error}</p>
      )}
      {!error && open && loadError && (
        <p style={{ fontSize: "0.75rem", color: "#7b8794", margin: 0 }}>
          Couldn't load Home Assistant entities: {loadError}. You can still type an entity ID
          manually.
        </p>
      )}
    </div>
  );
}
