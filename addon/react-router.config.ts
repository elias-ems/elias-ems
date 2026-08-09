import type { Config } from "@react-router/dev/config";

export default {
  // Server-render every route: the add-on runs a Node server behind the Home
  // Assistant ingress proxy, and loaders talk to the Supervisor API.
  ssr: true,
} satisfies Config;
