/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderOutcomesList } from "./view.ts";

describe("renderOutcomesList", () => {
  it("renders each Outcome's phase and readiness as text, not color alone", () => {
    const container = document.createElement("div");

    render(
      renderOutcomesList({
        disconnected: false,
        error: null,
        loaded: true,
        loading: false,
        outcomes: [
          {
            acceptanceValidity: "none",
            id: "outcome-1",
            phase: "draft",
            readiness: "incomplete",
            revision: 1,
            title: "Launch beta",
            updatedAt: 1,
          },
        ],
        unauthorized: false,
      }),
      container,
    );

    const summary = container.querySelector<HTMLElement>('[data-outcome-id="outcome-1"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("Draft");
    expect(summary?.textContent).toContain("Incomplete");
  });
});
