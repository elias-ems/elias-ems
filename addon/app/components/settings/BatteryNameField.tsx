import { useId, useState } from "react";
import { setpointEventType, slugifyTitle } from "../../lib/batteries";
import {
  errorStyle,
  fieldStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "../form";

/**
 * The battery's title, and under it the event type derived from it.
 *
 * A controlled input rather than the shared `Field`, which is uncontrolled:
 * the whole point is that the event name follows the title *as it is typed*.
 * The name an automation has to be written against is not something anyone
 * should have to save the form to find out, and it is not editable on its own
 * — one name, one place to change it.
 *
 * `savedTitle` is what is currently on disk, and only the edit form has one.
 * It is what makes the warning below possible: Home Assistant has no idea that
 * two event types were ever related, so an automation listening for the old
 * name simply stops hearing this battery, with nothing anywhere reporting a
 * problem. This is the only moment at which anything can say so.
 */
export default function BatteryNameField({
  defaultValue = "",
  savedTitle,
  error,
}: {
  defaultValue?: string;
  savedTitle?: string;
  error?: string;
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
        placeholder="e.g. Home battery"
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
              Setpoints for this battery go out as{" "}
              <code>{setpointEventType(slug)}</code>, which is what your
              automation listens for.
            </>
          ) : (
            "The event your automation listens for is built from this name, so it needs at least one letter or digit."
          )}
        </p>
      )}

      {renamed && (
        <p style={errorStyle}>
          Renaming changes the event from{" "}
          <code>{setpointEventType(savedSlug)}</code> to{" "}
          <code>{setpointEventType(slug)}</code>. Any automation listening for
          the old one stops hearing this battery — update its trigger too.
        </p>
      )}
    </div>
  );
}
