import type { ReactNode } from "react";
import { Form, useNavigation } from "react-router";
import { formStyle, hintStyle, linkButtonStyle, rowStyle } from "../form";

/**
 * The add / edit / remove mechanics shared by the PV and battery sections. Only
 * the fields and the read-only summary differ between them, so those come in as
 * render props and everything else — the row shell, the three forms, the
 * hidden intents, which button says "Saving…" — lives here once.
 *
 * `editingId` is owned by the caller rather than held here: closing the editor
 * is the caller's decision, since only it can see whether the action that just
 * finished belonged to this section.
 */
type EditableListProps<TRecord extends { id: string }> = {
  records: TRecord[];
  /** Forms post `${intent}-add`, `${intent}-update` and `${intent}-remove`. */
  intent: string;
  emptyMessage: string;
  showAdd: boolean;
  onCloseAdd: () => void;
  editingId: string | null;
  onEdit: (id: string | null) => void;
  renderSummary: (record: TRecord) => ReactNode;
  /** `record` is undefined for the add form. */
  renderFields: (record: TRecord | undefined) => ReactNode;
};

export default function EditableList<TRecord extends { id: string }>({
  records,
  intent,
  emptyMessage,
  showAdd,
  onCloseAdd,
  editingId,
  onEdit,
  renderSummary,
  renderFields,
}: EditableListProps<TRecord>) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" ? navigation.formData : null;
  const submittingIntent = submitting?.get("intent");

  const isAdding = submittingIntent === `${intent}-add`;
  const savingId =
    submittingIntent === `${intent}-update`
      ? String(submitting?.get("id"))
      : null;

  return (
    <>
      {records.length === 0 && !showAdd && (
        <p style={{ ...hintStyle, marginTop: "0.75rem" }}>{emptyMessage}</p>
      )}

      {records.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
          {records.map((record) => (
            <li key={record.id} style={rowStyle}>
              {editingId === record.id ? (
                <Form method="post" style={formStyle}>
                  <input
                    type="hidden"
                    name="intent"
                    value={`${intent}-update`}
                  />
                  <input type="hidden" name="id" value={record.id} />
                  {renderFields(record)}
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="submit" disabled={savingId === record.id}>
                      {savingId === record.id ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onClick={() => onEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </Form>
              ) : (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "1rem",
                  }}
                >
                  <div>{renderSummary(record)}</div>
                  <div
                    style={{ display: "flex", gap: "0.75rem", flex: "none" }}
                  >
                    <button
                      type="button"
                      onClick={() => onEdit(record.id)}
                      style={linkButtonStyle("var(--color-text)")}
                    >
                      Edit
                    </button>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value={`${intent}-remove`}
                      />
                      <input type="hidden" name="id" value={record.id} />
                      <button
                        type="submit"
                        style={linkButtonStyle("var(--color-danger)")}
                      >
                        Remove
                      </button>
                    </Form>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {showAdd && (
        // Remounting on every successful add clears the inputs — the add form is
        // uncontrolled, so React would otherwise keep the last entry's values in
        // the DOM and the next array would look pre-filled with the previous one.
        <Form
          key={records.length}
          method="post"
          style={{ ...formStyle, marginTop: "1rem" }}
        >
          <input type="hidden" name="intent" value={`${intent}-add`} />
          {renderFields(undefined)}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" disabled={isAdding}>
              {isAdding ? "Adding…" : "Add"}
            </button>
            <button type="button" onClick={onCloseAdd}>
              Cancel
            </button>
          </div>
        </Form>
      )}
    </>
  );
}
