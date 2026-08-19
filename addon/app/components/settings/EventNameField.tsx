import { useId, useState } from "react";
import { slugifyTitle } from "../../lib/slug";
import {
  errorStyle,
  fieldStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "../form";

/**
 * The title of something that is named on Home Assistant's event bus, and under
 * it the event type derived from it.
 *
 * A controlled input rather than the shared `Field`, which is uncontrolled: the
 * whole point is that the event name follows the title *as it is typed*. The
 * name an automation has to be written against is not something anyone should
 * have to save the form to find out, and it is not editable on its own — one
 * name, one place to change it.
 *
 * `savedTitle` is what is currently on disk, and only an edit form has one. It
 * is what makes the warning below possible: Home Assistant has no idea that two
 * event types were ever related, so an automation listening for the old name
 * simply stops hearing this record, with nothing anywhere reporting a problem.
 * This is the only moment at which anything can say so.
 *
 * Shared between batteries and PV arrays rather than written twice, because the
 * rule and the failure are identical — and because a second copy would be the
 * one that quietly stopped matching `slugifyTitle` after a change to it.
 */
export default function EventNameField({
  defaultValue = "",
  savedTitle,
  error,
  placeholder,
  noun,
  carries,
  eventType,
}: {
  defaultValue?: string;
  savedTitle?: string;
  error?: string;
  placeholder: string;
  /** What this record is, for the prose: "battery", "PV array". */
  noun: string;
  /** What its event carries: "target power", "generation limit". */
  carries: string;
  /** How this kind of record's event type is built from a slug. */
  eventType: (slug: string) => string;
}) {
  const inputId = useId();
  const [title, setTitle] = useState(defaultValue);

  const slug = slugifyTitle(title);
  const savedSlug = savedTitle ? slugifyTitle(savedTitle) : "";
  const renamed = Boolean(slug) && Boolean(savedSlug) && slug !== savedSlug;

  return (
    <div style={fieldStyle}>
      <label htmlFor={inputId} style={labelStyle}>
        Title
      </label>
      <input
        id={inputId}
        name="title"
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        style={inputStyle(Boolean(error))}
      />

      {error ? (
        <p style={errorStyle}>{error}</p>
      ) : (
        <p style={hintStyle}>
          {slug ? (
            <>
              This {noun}'s {carries} goes out as <code>{eventType(slug)}</code>
              , which is what your automation listens for.
            </>
          ) : (
            "The event your automation listens for is built from this name, so it needs at least one letter or digit."
          )}
        </p>
      )}

      {renamed && (
        <p style={errorStyle}>
          Renaming changes the event from <code>{eventType(savedSlug)}</code> to{" "}
          <code>{eventType(slug)}</code>. Any automation listening for the old
          one stops hearing this {noun} — update its trigger too.
        </p>
      )}
    </div>
  );
}
