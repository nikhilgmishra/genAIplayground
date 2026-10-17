import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SUPPORT_REF } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

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
});
