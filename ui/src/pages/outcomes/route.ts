import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("outcomes"),
  component: () =>
    import("./outcomes-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-outcomes-page></openclaw-outcomes-page>`,
    })),
});
