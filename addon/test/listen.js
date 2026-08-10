/**
 * Binding a port, with a readable failure.
 *
 * The mock and the proxy both listen on fixed ports in their CLI modes, and a
 * clash is the likeliest way to trip over them — `npm run dev:mock` while
 * `npm run start:ingress` is up, or a stack left running from earlier. Node's
 * bare EADDRINUSE is a stack trace that names a port number and nothing else,
 * which tells you the least at exactly the moment you need to know which of
 * these things is already holding it.
 *
 * Plain JavaScript for the same reason as the rest of the harness.
 */

/**
 * @param {import("node:http").Server} server
 * @param {number} port 0 picks a free one.
 * @param {string} what Named in the error, e.g. "The mock Home Assistant API".
 */
export async function listen(server, port, what) {
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `${what} can't start: port ${port} is already in use.\n` +
              `Something else is on it — most likely another of this project's ` +
              `stacks, or one left running from an earlier session.\n` +
              `Stop it, or set a different port (HA_MOCK_PORT, APP_PORT, INGRESS_PORT).`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  return server.address().port;
}
