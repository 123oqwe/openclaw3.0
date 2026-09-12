/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderOutcomesList } from "./view.ts";

describe("renderOutcomesList", () => {
  it.each([
    ["draft", "Draft"],
    ["active", "Active"],
    ["accepted", "Accepted"],
    ["cancelled", "Cancelled"],
  ] as const)("renders the %s phase as %s", (phase, label) => {
    const container = document.createElement("div");

    render(
      renderOutcomesList({
        canCreate: false,
        disconnected: false,
        error: null,
        loaded: true,
        loading: false,
        onRequestCreate: () => undefined,
        onSelect: () => undefined,
        outcomes: [
          {
            acceptanceValidity: "none",
            id: `outcome-${phase}`,
            phase,
            readiness: "incomplete",
            revision: 1,
            title: "Launch beta",
            updatedAt: 1,
          },
        ],
        selectedOutcomeId: null,
        unauthorized: false,
      }),
      container,
    );

    expect(container.querySelector(`[data-outcome-phase="${phase}"]`)?.textContent).toContain(
      label,
    );
  });

  it.each([
    ["incomplete", "Incomplete"],
    ["blocked", "Blocked"],
    ["ready", "Ready"],
    ["stale", "Stale"],
    ["unavailable", "Unavailable"],
  ] as const)("renders the %s readiness as %s", (readiness, label) => {
    const container = document.createElement("div");

    render(
      renderOutcomesList({
        canCreate: false,
        disconnected: false,
        error: null,
        loaded: true,
        loading: false,
        onRequestCreate: () => undefined,
        onSelect: () => undefined,
        outcomes: [
          {
            acceptanceValidity: "none",
            id: `outcome-${readiness}`,
            phase: "draft",
            readiness,
            revision: 1,
            title: "Launch beta",
            updatedAt: 1,
          },
        ],
        selectedOutcomeId: null,
        unauthorized: false,
      }),
      container,
    );

    expect(
      container.querySelector(`[data-outcome-readiness="${readiness}"]`)?.textContent,
    ).toContain(label);
  });

  it("renders each Outcome's phase and readiness as text, not color alone", () => {
    const container = document.createElement("div");

    render(
      renderOutcomesList({
        canCreate: false,
        disconnected: false,
        error: null,
        loaded: true,
        loading: false,
        onRequestCreate: () => undefined,
        onSelect: () => undefined,
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
        selectedOutcomeId: null,
        unauthorized: false,
      }),
      container,
    );

    const summary = container.querySelector<HTMLElement>('[data-outcome-id="outcome-1"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("Draft");
    expect(summary?.textContent).toContain("Incomplete");
  });

  it("gives each Outcome selection control an accessible title", () => {
    const container = document.createElement("div");

    render(
      renderOutcomesList({
        canCreate: false,
        disconnected: false,
        error: null,
        hasMore: false,
        loaded: true,
        loading: false,
        loadingMore: false,
        loadMoreError: null,
        onLoadMore: () => undefined,
        onRequestCreate: () => undefined,
        onSelect: () => undefined,
        outcomes: [
          {
            acceptanceValidity: "none",
            id: "outcome-a",
            phase: "draft",
            readiness: "incomplete",
            revision: 1,
            title: "Ship the release",
            updatedAt: 1,
          },
        ],
        selectedOutcomeId: null,
        unauthorized: false,
      }),
      container,
    );

    expect(
      container.querySelector('[data-outcome-select="outcome-a"]')?.getAttribute("aria-label"),
    ).toBe("View Ship the release");
  });
});
