import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ENDPOINT_ROLES } from "../api/contract";
import { NAV_ITEMS } from "../navigation";
import { ALL_STAFF_KEYS, staffView } from "../test/fixtures";
import type { StaffKey } from "../test/fixtures";
import { createMockApi, errorResponse } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

function navLabels(): string[] {
  return within(screen.getByRole("navigation", { name: "Console sections" }))
    .getAllByRole("link")
    .map((a) => a.textContent ?? "");
}

describe("role-aware console (UI mirrors least privilege; the server enforces it)", () => {
  for (const key of ALL_STAFF_KEYS) {
    it(`[SPEC-7.staff] navigation for ${key} lists exactly the sections its roles permit`, async () => {
      const staff = staffView(key);
      renderConsole({ path: "/playbooks", staff });
      await findPage("Escalation roster and playbooks");
      const expected = NAV_ITEMS.filter((n) => ENDPOINT_ROLES[n.endpoint].some((r) => staff.roles.includes(r))).map((n) => n.label);
      expect(navLabels()).toEqual(expected);
    });
  }

  it("[SPEC-7.staff] the auditor gets read-only audit and release views but no operational or mutating sections", async () => {
    renderConsole({ path: "/playbooks", staff: staffView("auditor") });
    await findPage("Escalation roster and playbooks");
    expect(navLabels()).toEqual(["Releases review", "Audit search", "Escalation and playbooks"]);
  });

  it("[SPEC-7.staff] an auditor reviewing releases sees no review action", async () => {
    renderConsole({ path: "/releases", staff: staffView("auditor") });
    await findPage("Releases review");
    await screen.findAllByText(/Diff summary/);
    expect(screen.queryByRole("button", { name: "Record review" })).not.toBeInTheDocument();
  });

  const FORBIDDEN: readonly { key: StaffKey; path: string; endpoint: Parameters<ReturnType<typeof createMockApi>["calls"]>[0] }[] = [
    { key: "auditor", path: "/kill-switches", endpoint: "killSwitches.list" },
    { key: "agent", path: "/kill-switches", endpoint: "killSwitches.list" },
    { key: "knowledgeEditor", path: "/calls", endpoint: "calls.list" },
    { key: "deployOperator", path: "/audit", endpoint: "audit.search" },
    { key: "policyApprover", path: "/safety-events", endpoint: "safetyEvents.list" },
    { key: "securityAdmin", path: "/approvals", endpoint: "workflows.tasks" },
  ];
  for (const f of FORBIDDEN) {
    it(`[SPEC-7.staff] ${f.key} opening ${f.path} directly sees "Not permitted" and no data is requested`, async () => {
      const api = createMockApi();
      renderConsole({ path: f.path, staff: staffView(f.key), api });
      await findPage("Not permitted");
      expect(screen.getByText(/The server enforces the same rule/)).toBeInTheDocument();
      expect(api.calls(f.endpoint)).toHaveLength(0);
    });
  }

  it("[SPEC-13.console] a deployment operator may change only model and voice version switches", async () => {
    const { user } = renderConsole({ path: "/kill-switches", staff: staffView("deployOperator") });
    await findPage("Kill switches");
    const writesRow = (await screen.findByRole("rowheader", { name: /^WRITES/ })).closest("tr") as HTMLElement;
    expect(within(writesRow).queryByRole("button")).not.toBeInTheDocument();
    expect(within(writesRow).getByText("Not permitted for your roles")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Engage MODEL_VERSION model-fixture-v1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change a kill switch" }));
    const options = within(within(screen.getByRole("dialog")).getByLabelText("Scope")).getAllByRole("option");
    const enabled = options.filter((o) => !(o as HTMLOptionElement).disabled).map((o) => (o as HTMLOptionElement).value);
    expect(enabled).toEqual(["", "MODEL_VERSION", "VOICE_VERSION"]);
  });

  it("[SPEC-7.staff] a knowledge editor cannot review a policy bundle or their own knowledge snapshot", async () => {
    renderConsole({ path: "/releases", staff: staffView("knowledgeEditor") });
    await findPage("Releases review");
    await screen.findAllByText(/Diff summary/);
    expect(screen.queryByRole("button", { name: "Record review" })).not.toBeInTheDocument();
    expect(screen.getByText("Reviewing this release kind is not permitted for your roles.")).toBeInTheDocument();
    expect(screen.getByText("You submitted this release, so you cannot review it.")).toBeInTheDocument();
  });

  it("[AUTH-02] the server remains the authority: a server-side denial of a visible action is surfaced as its reason code", async () => {
    const api = createMockApi();
    api.setHandler("actions.cancel", () => errorResponse(403, "STAFF_ROLE_NOT_PERMITTED"));
    const { user } = renderConsole({ path: "/actions", staff: staffView("agent"), api });
    await findPage("Pending actions");
    await user.click(await screen.findByRole("button", { name: "Cancel action act_synthActionPrepared01" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(dialog.getByLabelText("Reason code"), "SAFETY_ESCALATION");
    await user.click(dialog.getByRole("button", { name: "Confirm cancellation" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Reason code: STAFF_ROLE_NOT_PERMITTED");
    expect(dialog.getByRole("alert")).toHaveTextContent("correlation id cor_synthCorrelation0099");
  });

  it("[AUTH-02] the mock backend rejects a forged request from a role without access, independent of the UI", async () => {
    const api = createMockApi();
    const agent = staffView("agent");
    const res = await api.fetch("/console/api/v1/kill-switches", {
      method: "POST",
      headers: { Authorization: `Bearer ${api.tokenFor(agent)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_CONTAINMENT", confirmationPhrase: "ENGAGE WRITES *" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { reasonCode: "STAFF_ROLE_NOT_PERMITTED" } });
  });

  it("[SPEC-7.staff] active break-glass access is shown with its expiry and approver; the console offers no way to request or grant it", async () => {
    const staff = staffView("supervisor", {
      breakGlass: { expiresAt: "2026-10-17T16:00:00.000Z", approvedBy: "stf_synthSecurityAdm1", justificationCode: "INCIDENT_CONTAINMENT" },
    });
    renderConsole({ path: "/overview", staff });
    await findPage("Overview");
    const banner = screen.getByTestId("break-glass-banner");
    expect(banner).toHaveTextContent("Break-glass access is active until 2026-10-17 16:00:00 UTC");
    expect(banner).toHaveTextContent("stf_synthSecurityAdm1");
    expect(screen.queryByRole("button", { name: /break-glass/i })).not.toBeInTheDocument();
  });
});
