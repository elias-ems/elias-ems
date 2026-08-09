import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "@remix-run/react";
import Nav from "./components/Nav";

// Home Assistant serves this app through an ingress proxy at a path that's
// only known at request time (it strips the prefix before forwarding here).
// Read it so links/actions/fetches can be built with the right prefix.
export async function loader({ request }) {
  const ingressPath = (request.headers.get("x-ingress-path") ?? "").replace(/\/+$/, "");
  return json({ ingressPath });
}

export default function App() {
  const { ingressPath } = useLoaderData();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Nav ingressPath={ingressPath} />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
