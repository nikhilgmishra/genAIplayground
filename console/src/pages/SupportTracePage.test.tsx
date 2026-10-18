import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SUPPORT_REF, staffView, supportTrace } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

/** LOCAL TEST FIXTURE: the trace of a request whose Salesforce sync exhausted its attempt budget. */
const deadLettered = () => {
  const t = supportTrace();
  return { ...t, sync: { ...t.sync, state: "DEAD_LETTER" as const, attempts: 6 } };
};

describe("support request trace", () => {
  it("[SPEC-13.console] traces a support request to sync state, Salesforce Case id, actions, workflows and audit ids", async () => {
    const { user, api, locations } = renderConsole({ path: "/trace" });
    await findPage("Support request trace");
    await user.type(screen.getByLabelText("Support reference"), SUPPORT_REF.toLowerCase());
    await user.click(screen.getByRole("button", { name: "Trace" }));
    expect(await screen.findByRole("table", { name: "Durable workflows" })).toBeInTheDocument();
    expect(locations.at(-1)).toBe(`/support-requests/${SUPPORT_REF}`);
    expect(api.calls("supportRequests.trace")[0]?.path).toBe(`/console/api/v1/support-requests/${SUPPORT_REF}/trace`);
    expect(screen.getByText(/pending synchronization \(no Case number is ever invented\)/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Actions and commit receipts" })).toBeInTheDocument();
    expect(screen.getByText("aud_synthAuditEvent00007")).toBeInTheDocument();
    expect(screen.getByText(/A Case created or a workflow accepted is not issue resolution/)).toBeInTheDocument();
  });

  it("[SPEC-6.no-phi-url] personal details typed into the lookup are rejected and never reach a URL or request", async () => {
    const api = createMockApi();
    const { user, locations } = renderConsole({ path: "/trace", api });
    await findPage("Support request trace");
    for (const value of ["+1 555 555 0101", "Avery Synthetic-Client", "1990-01-01"]) {
      await user.clear(screen.getByLabelText("Support reference"));
      await user.type(screen.getByLabelText("Support reference"), value);
      await user.click(screen.getByRole("button", { name: "Trace" }));
      expect(await screen.findByText(/Not a valid support reference. Nothing was looked up./)).toBeInTheDocument();
    }
    expect(api.calls("supportRequests.trace")).toHaveLength(0);
    for (const l of locations) expect(l).toBe("/trace");
  });

  it("[SPEC-8.salesforce][ACT-02] a supervisor repairs a dead-lettered sync with a reason code only; the request returns to the queue and the trace reloads", async () => {
    const api = createMockApi({ handlers: { "supportRequests.trace": () => ({ status: 200, body: deadLettered() }) } });
    const { user } = renderConsole({ path: `/support-requests/${SUPPORT_REF}`, api });
    await findPage("Support request trace");
    await user.click(await screen.findByRole("button", { name: `Repair synchronization of ${SUPPORT_REF}` }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/cannot create a duplicate Case/)).toBeInTheDocument();
    const submit = dialog.getByRole("button", { name: "Confirm repair" });
    expect(submit).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "ROOT_CAUSE_FIXED");
    await user.click(submit);
    const call = api.calls("supportRequests.repair")[0];
    expect(call?.path).toBe(`/console/api/v1/support-requests/${SUPPORT_REF}/repair`);
    expect(call?.body).toEqual({ reason: "ROOT_CAUSE_FIXED" });
    expect(call?.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(await screen.findByText(new RegExp(`Support request ${SUPPORT_REF} returned to the synchronization queue \\(sync state PENDING\\)`))).toBeInTheDocument();
    expect(api.calls("supportRequests.trace").length).toBeGreaterThan(1);
  });

  it("[SPEC-8.salesforce] no repair is offered for a sync that is not dead-lettered", async () => {
    const pending = createMockApi();
    renderConsole({ path: `/support-requests/${SUPPORT_REF}`, api: pending });
    expect(await screen.findByRole("table", { name: "Durable workflows" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repair synchronization/ })).toBeNull();
  });

  it("[SPEC-7.staff] a support agent sees that the sync is dead-lettered but gets no repair control", async () => {
    const api = createMockApi({ handlers: { "supportRequests.trace": () => ({ status: 200, body: deadLettered() }) } });
    renderConsole({ path: `/support-requests/${SUPPORT_REF}`, api, staff: staffView("agent") });
    expect(await screen.findByText(/Synchronization is dead-lettered. A supervisor can repair it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repair synchronization/ })).toBeNull();
    expect(api.calls("supportRequests.repair")).toHaveLength(0);
  });
});
