import { data, Form, Link, useHref, useNavigation } from "react-router";
import {
  cardStyle,
  fieldStyle,
  formStyle,
  headingStyle,
  labelStyle,
  pageTitleStyle,
} from "../components/form";
import { withChargeLimitLock } from "../lib/charge-limit-loop.server";
import { appendDiagnostic } from "../lib/diagnostics.server";
import {
  BACKUP_MAX_BYTES,
  parseSettingsBackup,
  previewRevision,
  readSettings,
  restoreSettings,
  SettingsBackupError,
  serializeSettings,
} from "../lib/settings-backup.server";
import type { Route } from "./+types/settings_.backup";

const groups = {
  batteries: "Batteries",
  pvEntities: "PV arrays",
  grid: "Grid",
  prices: "Prices",
  control: "Battery control",
  curtailment: "PV curtailment",
} as const;

async function readBackupForm(request: Request): Promise<FormData> {
  // URL encoding may use three bytes per byte of JSON.
  const maxBodyBytes = 3 * BACKUP_MAX_BYTES + 4096;
  let bytes = 0;
  const body = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBodyBytes) {
          throw new SettingsBackupError(
            "Choose a backup smaller than 256 KiB.",
          );
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(body, { headers: request.headers }).formData();
  } catch (error) {
    if (error instanceof SettingsBackupError) throw error;
    throw new SettingsBackupError("Could not read the submitted backup form.");
  }
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const form = await readBackupForm(request);
    const intent = form.get("intent");

    if (intent === "preview") {
      const file = form.get("backup");
      if (!(file instanceof File) || !file.size) {
        throw new SettingsBackupError("Choose a settings backup to preview.");
      }
      if (file.size > BACKUP_MAX_BYTES) {
        throw new SettingsBackupError("Choose a backup smaller than 256 KiB.");
      }
      const incoming = parseSettingsBackup(await file.text());
      const current = await withChargeLimitLock(readSettings);
      return {
        status: "preview" as const,
        current,
        incoming,
        backup: serializeSettings(incoming, 0),
        revision: previewRevision(current, incoming),
      };
    }

    const backup = form.get("backup");
    const revision = form.get("revision");
    if (
      intent !== "apply" ||
      typeof backup !== "string" ||
      typeof revision !== "string"
    ) {
      throw new SettingsBackupError("Preview the backup before applying it.");
    }
    const result = await restoreSettings(parseSettingsBackup(backup), revision);
    return { status: "applied" as const, restartFailed: result.restartFailed };
  } catch (error) {
    if (error instanceof SettingsBackupError) {
      return data(
        { status: "error" as const, error: error.message },
        { status: 400 },
      );
    }
    appendDiagnostic(
      "battery-control",
      "error",
      `Settings backup request failed: ${error}`,
    );
    return data(
      {
        status: "error" as const,
        error:
          "The backup operation could not complete. Check Diagnostics for details.",
      },
      { status: 500 },
    );
  }
}

export default function SettingsBackup({ actionData }: Route.ComponentProps) {
  const exportHref = useHref("/api/settings-backup.json");
  const busy = useNavigation().state !== "idle";
  const preview = actionData?.status === "preview" ? actionData : null;
  const changes = preview
    ? (Object.keys(groups) as Array<keyof typeof groups>).filter(
        (key) =>
          JSON.stringify(preview.current[key]) !==
          JSON.stringify(preview.incoming[key]),
      )
    : [];

  return (
    <main className="page">
      <Link to="/settings">Back to Settings</Link>
      <h1 style={{ ...pageTitleStyle, marginBlock: "1rem" }}>
        Settings backup
      </h1>
      <section style={{ ...cardStyle, maxWidth: "42rem" }}>
        <h2 style={headingStyle}>Export settings</h2>
        <p>
          Download your device mappings, prices and control settings as a JSON
          file.
        </p>
        <a href={exportHref} download>
          Download settings backup
        </a>
      </section>
      <section style={{ ...cardStyle, marginTop: "1rem", maxWidth: "42rem" }}>
        <h2 style={headingStyle}>Restore settings</h2>
        <p>Choose a backup to review before replacing your current settings.</p>
        <Form method="post" encType="multipart/form-data" style={formStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Settings backup file</span>
            <input
              type="file"
              name="backup"
              accept=".json,application/json"
              required
            />
          </label>
          <div>
            <button type="submit" name="intent" value="preview" disabled={busy}>
              Preview backup
            </button>
          </div>
        </Form>

        {actionData?.status === "error" && (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {actionData.error}
          </p>
        )}
        {actionData?.status === "applied" && (
          <p role="status">
            {actionData.restartFailed
              ? "Settings restored. PV control could not restart. Check Diagnostics."
              : "Settings restored."}
          </p>
        )}
        {preview && (
          <section
            style={{ marginTop: "1rem" }}
            aria-labelledby="backup-preview"
          >
            <h3 id="backup-preview">Restore preview</h3>
            <p>
              After restore, battery control will be{" "}
              {preview.incoming.control.enabled ? "on" : "off"} and PV
              curtailment will be{" "}
              {preview.incoming.curtailment.enabled ? "on" : "off"}.
            </p>
            {changes.length === 0 ? (
              <p>This backup matches your current settings.</p>
            ) : (
              <>
                <p>
                  Review the changed groups below. Apply replaces the current
                  configuration and can send commands to Home Assistant.
                </p>
                {changes.map((key) => (
                  <details key={key}>
                    <summary>{groups[key]}</summary>
                    <h4>Current</h4>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {JSON.stringify(preview.current[key], null, 2)}
                    </pre>
                    <h4>From backup</h4>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {JSON.stringify(preview.incoming[key], null, 2)}
                    </pre>
                  </details>
                ))}
                <Form method="post" style={{ marginTop: "1rem" }}>
                  <input type="hidden" name="backup" value={preview.backup} />
                  <input
                    type="hidden"
                    name="revision"
                    value={preview.revision}
                  />
                  <button
                    type="submit"
                    name="intent"
                    value="apply"
                    disabled={busy}
                  >
                    Apply backup
                  </button>
                </Form>
              </>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
