import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// A deliberately read-only subset of the unofficial Home Assistant MCP API.
const allowed = new Set([
  "ha_get_history",
  "ha_get_state",
  "ha_search",
  "ha_manage_energy_prefs",
]);
const [tool, argumentsJson, output] = process.argv.slice(2);
if (!allowed.has(tool) || !output)
  throw new Error(
    "Usage: node gym/capture.mjs <read-tool> '<arguments-json>' <output.json>",
  );
const args = JSON.parse(argumentsJson);
if (tool === "ha_manage_energy_prefs" && args.mode !== "get")
  throw new Error("Only mode=get is allowed");
if (!process.env.HA_MCP_URL)
  throw new Error("Set HA_MCP_URL locally; never commit the private URL");
const response = await fetch(process.env.HA_MCP_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  }),
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
const text = await response.text();
const messages = text.startsWith("{")
  ? [JSON.parse(text)]
  : text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
const message = messages.find((item) => item.id === 1);
if (!message || message.error || message.result?.isError)
  throw new Error("MCP read failed; check connection and tool arguments");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      tool,
      arguments: args,
      result: message.result,
    },
    null,
    2,
  ),
);
console.log(`Saved ${output}`);
