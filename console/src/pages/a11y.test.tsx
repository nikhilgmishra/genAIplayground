import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axeViolations } from "../test/axe";
import { PRIMARY_CALL, SUPPORT_REF, staffView } from "../test/fixtures";
import type { StaffKey } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

/** Every console page, the staff member who may view it, and text that proves its data loaded. */
const PAGES: readonly { path: string; heading: string | RegExp; staff: StaffKey; loaded: RegExp }[] = [
  { path: "/overview", heading: "Overview", staff: "supervisor", loaded: /Queue health by owner queue/ },
  { path: "/calls", heading: "Active calls", staff: "agent", loaded: /Active calls \(2\)/ },
  { path: `/calls/${PRIMARY_CALL}`, heading: "Call investigation", staff: "safety", loaded: /Content-free event timeline/ },
  { path: "/trace", heading: "Support request trace", staff: "agent", loaded: /Format SR-XXXX-XXXX/ },
  { path: `/support-requests/${SUPPORT_REF}`, heading: "Support request trace", staff: "supervisor", loaded: /Durable workflows/ },
  { path: "/actions", heading: "Pending actions", staff: "supervisor", loaded: /Pending actions \(2\)/ },
  { path: "/reconciliation", heading: "Reconciliation queue", staff: "supervisor", loaded: /Dead-lettered outbox messages/ },
  { path: "/approvals", heading: "Approvals", staff: "supervisor", loaded: /Open human tasks \(2\)/ },
  { path: "/safety-events", heading: "Safety events", staff: "safety", loaded: /Safety events \(1\)/ },
  { path: "/releases", heading: "Releases review", staff: "policyApprover", loaded: /Diff summary: 1 added/ },
  { path: "/budgets", heading: "Budgets", staff: "deployOperator", loaded: /Spend versus limit by budget scope/ },
  { path: "/kill-switches", heading: "Kill switches", staff: "securityAdmin", loaded: /Kill switch state/ },
  { path: "/audit", heading: "Audit search", staff: "auditor", loaded: /Search audit metadata/ },
  { path: "/destinations", heading: "Transfer destinations", staff: "agent", loaded: /Destination allowlist/ },
  { path: "/playbooks", heading: "Escalation roster and playbooks", staff: "auditor", loaded: /Incident and recovery runbooks/ },
];

describe("console accessibility (axe-core on the rendered DOM, synthetic mock data)", () => {
  for (const page of PAGES) {
    it(`[SPEC-16.console-a11y] ${page.path} has zero axe violations, landmarks, a skip link and a page title`, async () => {
      renderConsole({ path: page.path, staff: staffView(page.staff) });
      await findPage(page.heading);
      await screen.findAllByText(page.loaded);
      expect(await axeViolations()).toEqual([]);
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Console sections" })).toBeInTheDocument();
      expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
      expect(document.title).toMatch(/— Operations console$/);
    });
  }

  it("[SPEC-16.console-a11y] control: the axe harness detects a planted violation (the suite is not vacuous)", async () => {
    const planted = document.createElement("div");
    const unnamedButton = document.createElement("button");
    unnamedButton.type = "button";
    const unlabelledInput = document.createElement("input");
    unlabelledInput.type = "text";
    planted.append(unnamedButton, unlabelledInput);
    document.body.appendChild(planted);
    try {
      const ids = (await axeViolations()).map((v) => v.id);
      expect(ids).toContain("button-name");
      expect(ids).toContain("label");
    } finally {
      planted.remove();
    }
  });

  it("[SPEC-16.console-a11y] the sign-in page (local fixture mode) has zero axe violations", async () => {
    renderConsole({ signedIn: false });
    await findPage("Sign in to the operations console");
    await screen.findByRole("radio", { name: /Synthetic Supervisor/ });
    expect(await axeViolations()).toEqual([]);
  });

  it("[SPEC-16.console-a11y] an open kill switch dialog has zero axe violations and is a labelled modal", async () => {
    const { user } = renderConsole({ path: "/kill-switches", staff: staffView("supervisor") });
    await findPage("Kill switches");
    await user.click(await screen.findByRole("button", { name: "Change a kill switch" }));
    const dialog = screen.getByRole("dialog", { name: "Change a kill switch" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/Safety and human routes stay available/);
    expect(await axeViolations()).toEqual([]);
  });

  it("[SPEC-16.console-a11y] the skip link moves focus to the main region", async () => {
    const { user } = renderConsole({ path: "/overview" });
    await findPage("Overview");
    await user.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("[SPEC-16.console-a11y] statuses are never colour-only: every status carries a text label", async () => {
    renderConsole({ path: "/overview" });
    await findPage("Overview");
    await screen.findByText(/Queue health by owner queue/);
    const statuses = document.querySelectorAll(".status");
    expect(statuses.length).toBeGreaterThan(3);
    for (const s of Array.from(statuses)) expect((s.textContent ?? "").replace(/[✓!✕•\s]/g, "").length).toBeGreaterThan(1);
  });

  it("[SPEC-16.console-a11y] data tables have captions and scoped header cells", async () => {
    renderConsole({ path: "/reconciliation" });
    await findPage("Reconciliation queue");
    await screen.findByText(/Dead-lettered outbox messages/);
    const tables = screen.getAllByRole("table");
    expect(tables.length).toBe(2);
    for (const t of tables) {
      expect(t.querySelector("caption")?.textContent?.trim()).toBeTruthy();
      for (const th of Array.from(t.querySelectorAll("th"))) expect(["col", "row"]).toContain(th.getAttribute("scope"));
    }
  });

  it("[SPEC-16.console-a11y] action results are announced in a polite live region inside main", async () => {
    const api = createMockApi();
    api.state.reconcileOutcomes["act_synthActionUnknown01"] = "NOT_FOUND";
    const { user } = renderConsole({ path: "/reconciliation", api });
    await findPage("Reconciliation queue");
    await user.click(await screen.findByRole("button", { name: "Reconcile action act_synthActionUnknown01" }));
    const region = within(screen.getByRole("main")).getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(await within(region).findByText(/provider result NOT_FOUND/)).toBeInTheDocument();
  });
});
