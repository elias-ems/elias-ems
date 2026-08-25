import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import "./app.css";
import type { Route } from "./+types/root";
import AppHeader from "./components/AppHeader";
import { hintStyle } from "./components/form";

/**
 * The document every page is rendered into — including the error page below.
 *
 * That is the whole reason this is a separate export rather than part of the
 * component: React Router renders an `ErrorBoundary` *inside* the root
 * `Layout` if there is one, and inside a bare fallback document of its own if
 * there isn't. Without it the error page would arrive with no stylesheet, no
 * top bar and, worse, no `Scripts` — an app that has stopped being an app.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Duplicates the `color-scheme` in app.css on purpose: this one is
            parsed before the stylesheet loads, so the very first paint of the
            page canvas already matches the theme instead of flashing white. */}
        <meta name="color-scheme" content="light dark" />
        <Meta />
        <Links />
      </head>
      <body>
        <AppHeader />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * What anyone sees when something throws where React Router can catch it: a
 * loader, an action, a form submission, a navigation.
 *
 * Before this existed the framework's own default rendered instead — the bare
 * "Application Error" page with a minified stack trace in red, no styling, no
 * navigation, and no way out but the browser's reload button. The failure that
 * actually put people there is a dropped request rather than a bug, which is
 * why the network case gets its own wording and a retry: at that point the
 * add-on is usually fine and the connection to it isn't.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) ? error : null;

  const title = routeError
    ? routeError.status === 404
      ? "Page not found"
      : `${routeError.status} ${routeError.statusText}`
    : isNetworkError(error)
      ? "Lost contact with the add-on"
      : "Something went wrong";

  const explanation = routeError
    ? routeError.status === 404
      ? "There is nothing at that address. The links above still work."
      : // Only when it is a string: `data` is whatever was thrown with the
        // response, and handing React an object here would throw a second
        // error out of the one place that must not.
        typeof routeError.data === "string" && routeError.data
        ? routeError.data
        : "The add-on refused that request."
    : isNetworkError(error)
      ? "A request never made it back — the add-on may be restarting, or Home Assistant may be. Nothing has been lost: the loops keep running while nobody is watching."
      : "The page hit an error it couldn't carry on from.";

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "0.75rem",
        padding: "1.5rem",
        maxWidth: 640,
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.25rem" }}>{title}</h1>
      <p style={{ margin: 0 }}>{explanation}</p>

      {/* Unstyled, like every other button here: `color-scheme` is what makes
          a native control follow Home Assistant's theme, and this page of all
          pages should not depend on anything more than that. */}
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>

      {/* The message, but not the stack: minified frames from a production
          bundle tell a reader nothing, and this is what a bug report needs. */}
      {error instanceof Error && error.message && (
        <p style={{ ...hintStyle, fontFamily: "ui-monospace, monospace" }}>
          {error.message}
        </p>
      )}
      {import.meta.env.DEV && error instanceof Error && error.stack && (
        <pre style={{ ...hintStyle, overflowX: "auto", maxWidth: "100%" }}>
          {error.stack}
        </pre>
      )}
    </main>
  );
}

/**
 * Whether a thrown value is a request that never arrived, rather than a fault
 * in the app. Browsers agree on the shape — a `TypeError` from `fetch` — and
 * on nothing else: Chrome says "Failed to fetch", Firefox "NetworkError when
 * attempting to fetch resource", Safari "Load failed". Matching the type alone
 * is close enough, since a `TypeError` reaching a route boundary is nearly
 * always this.
 */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}
