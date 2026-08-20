/**
 * Turning a title somebody typed into something that can be part of a Home
 * Assistant event type.
 *
 * Its own module rather than a helper inside `batteries.ts`, because two kinds
 * of record are now named on the bus — a battery's target power and a PV
 * array's generation limit — and both have to reduce a title exactly the same
 * way. Two copies of this that drifted apart would be a bug nothing reports:
 * the settings page would show one name and the automation would need another.
 */

/**
 * A title reduced to lowercase, accents folded away, and every run of anything
 * else turned into a single underscore.
 *
 * "Home battery" becomes `home_battery`, and so does "Home  Battery!" — the
 * point is that the name in an automation is predictable from the name on the
 * settings page, not that every distinct title survives intact. Accents are
 * folded rather than dropped so that "Réserve" is `reserve` instead of `r_serve`.
 *
 * Empty when the title has no letters or digits at all. Callers decide what to
 * do about that: the forms reject such a title, and the `*Slug` helpers fall
 * back to the record id for anything a hand-edited file gets past them.
 */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether `title` would slugify onto a record other than the one being edited —
 * two names that are different on the settings page and the same on the bus.
 *
 * The rule lives here; going and reading the records does not. A pure module
 * cannot reach the store, so the caller hands in every stored record of that
 * kind, which is why the settings action is what calls this. Both batteries and
 * PV arrays need the identical comparison, and two hand-written copies of it
 * are the same drift `slugifyTitle` itself lives in this module to avoid.
 *
 * `editedId` is the id of the record being edited, or null when one is being
 * added — null matches no stored record, so the title is compared against all
 * of them. Skipping the edited record is what lets a battery keep its own name
 * across an edit that changes something else.
 */
export function titleSlugClashes(
  records: readonly { id: string; title: string }[],
  title: string,
  editedId: string | null,
): boolean {
  const slug = slugifyTitle(title);
  return records.some(
    (record) => record.id !== editedId && slugifyTitle(record.title) === slug,
  );
}
