import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TASK_TOKEN_CANARY, staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

describe("approvals (workflow human tasks)", () => {
  it("[SPEC-9.workflow-token] a decision requires a reason code and the request carries only decision and reason, never a task token", async () => {
    const api = createMockApi();
    // A misbehaving backend that leaks a token field: the console must neither show nor return it.
    api.setHandler("workflows.tasks", ({ state }) => ({
      status: 200,
      body: { tasks: state.tasks.tasks.map((t) => ({ ...t, taskToken: TASK_TOKEN_CANARY })) },
    }));
    const { user } = renderConsole({ path: "/approvals", api });
    await findPage("Approvals");
    await user.click(await screen.findByRole("button", { name: "Decide task wft_synthTaskBilling00001" }));
    const dialog = within(screen.getByRole("dialog", { name: "Decide task wft_synthTaskBilling00001" }));
    const submit = dialog.getByRole("button", { name: "Submit decision" });
    expect(submit).toBeDisabled();

    await user.click(dialog.getByLabelText("Reject"));
    expect(submit).toBeDisabled();
    expect(dialog.getByLabelText("Reason code")).toBeRequired();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "EVIDENCE_INSUFFICIENT");
    expect(submit).toBeEnabled();
    await user.click(submit);

    const calls = api.calls("workflows.decision");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/console/api/v1/workflows/tasks/wft_synthTaskBilling00001/decision");
    expect(calls[0]?.body).toEqual({ decision: "REJECT", reason: "EVIDENCE_INSUFFICIENT" });
    for (const r of api.requests) {
      expect(JSON.stringify(r.body ?? {})).not.toMatch(/token/i);
      expect(r.url).not.toContain(TASK_TOKEN_CANARY);
      expect(Object.values(r.headers).join(" ")).not.toContain(TASK_TOKEN_CANARY);
    }
    expect(document.body.textContent).not.toContain(TASK_TOKEN_CANARY);
    expect(await screen.findByText(/REJECT recorded; workflow wf_synthWorkflowBilling1 is CANCELLED/)).toBeInTheDocument();
  });

  it("[SPEC-9.workflow-token] approve uses the approve reason-code list, which differs from the reject list", async () => {
    const { user, api } = renderConsole({ path: "/approvals" });
    await findPage("Approvals");
    await user.click(await screen.findByRole("button", { name: "Decide task wft_synthTaskPartner00001" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByLabelText("Approve"));
    const options = within(dialog.getByLabelText("Reason code")).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(options).toEqual(["", "EVIDENCE_VERIFIED", "POLICY_CRITERIA_MET", "SPECIALIST_CONFIRMED"]);
    await user.selectOptions(dialog.getByLabelText("Reason code"), "POLICY_CRITERIA_MET");
    await user.click(dialog.getByRole("button", { name: "Submit decision" }));
    expect(api.calls("workflows.decision")[0]?.body).toEqual({ decision: "APPROVE", reason: "POLICY_CRITERIA_MET" });
  });

  it("[SPEC-7.staff] a support agent sees only tasks for their roles and cannot decide supervisor-only tasks", async () => {
    const api = createMockApi();
    // Server returns both tasks (simulating a broad list) to prove the UI also checks task roles.
    api.setHandler("workflows.tasks", ({ state }) => ({ status: 200, body: state.tasks }));
    renderConsole({ path: "/approvals", staff: staffView("agent"), api });
    await findPage("Approvals");
    expect(await screen.findByRole("button", { name: "Decide task wft_synthTaskBilling00001" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide task wft_synthTaskPartner00001" })).not.toBeInTheDocument();
    const row = screen.getByRole("rowheader", { name: "wft_synthTaskPartner00001" }).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Not permitted for your roles")).toBeInTheDocument();
  });
});
