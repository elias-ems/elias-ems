/** Bounded request/response connection for Energy and Recorder commands. */
export function haCommands<T extends unknown[]>(
  commands: Record<string, unknown>[],
): Promise<T> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token)
    return Promise.reject(
      new Error("Home Assistant connection is not configured."),
    );
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      process.env.SUPERVISOR_WS || "ws://supervisor/core/websocket",
    );
    const results: unknown[] = new Array(commands.length);
    const received = new Set<number>();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(results as T);
    };
    const timeout = setTimeout(
      () => finish(new Error("Home Assistant forecast request timed out.")),
      15_000,
    );
    socket.addEventListener("error", () =>
      finish(new Error("Home Assistant forecast connection failed.")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Home Assistant forecast connection closed.")),
    );
    socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(String(data));
        if (message.type === "auth_required")
          socket.send(JSON.stringify({ type: "auth", access_token: token }));
        if (message.type === "auth_invalid")
          finish(new Error("Home Assistant rejected the forecast connection."));
        if (message.type === "auth_ok") {
          commands.forEach((command, i) => {
            socket.send(JSON.stringify({ ...command, id: i + 1 }));
          });
          if (!commands.length) finish();
        }
        if (
          message.type === "result" &&
          Number.isInteger(message.id) &&
          message.id >= 1 &&
          message.id <= commands.length
        ) {
          if (!message.success) {
            finish(
              new Error(
                `${commands[message.id - 1].type}: ${message.error?.message || "request rejected"}`,
              ),
            );
            return;
          }
          results[message.id - 1] = message.result;
          received.add(message.id);
          if (received.size === commands.length) finish();
        }
      } catch {
        finish(
          new Error("Home Assistant returned an invalid forecast response."),
        );
      }
    });
  });
}
