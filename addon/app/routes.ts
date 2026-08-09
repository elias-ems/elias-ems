import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Keeps the Remix-style file naming convention in app/routes.
export default flatRoutes() satisfies RouteConfig;
