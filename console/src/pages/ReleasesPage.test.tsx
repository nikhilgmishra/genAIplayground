import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

describe("policy and knowledge release review", () => {
  it("[OPS-06] a policy approver records a review with decision and reason; the console states it is not an approval record", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: "/releases", staff: staffView("policyApprover"), api });
    await findPage("Releases review");
    expect(screen.getByText(/Recording a review is not an approval/)).toBeInTheDocument();
    const card = within(await screen.findByRole("article", { name: /Policy bundle policy-fixture-v2/ }));
    expect(card.getByText("Missing")).toBeInTheDocument();
    expect(card.getByText("SCOPE_NARROWED")).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: "Record review" }));
    const dialog = within(screen.getByRole("dialog"));
    const submit = dialog.getByRole("button", { name: "Record review" });
    expect(submit).toBeDisabled();
    await user.click(dialog.getByLabelText("Changes requested"));
    expect(submit).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "MISSING_EVIDENCE");
    await user.click(submit);
    expect(api.calls("releases.review")[0]?.path).toBe("/console/api/v1/releases/rls_synthPolicyRelease01/review");
    expect(api.calls("releases.review")[0]?.body).toEqual({ decision: "CHANGES_REQUESTED", reason: "MISSING_EVIDENCE" });
    expect(await screen.findByText(/No approval record was created/)).toBeInTheDocument();
  });

  it("[OPS-06] a policy approver cannot review a knowledge snapshot", async () => {
    renderConsole({ path: "/releases", staff: staffView("policyApprover") });
    await findPage("Releases review");
    const card = within(await screen.findByRole("article", { name: /Knowledge snapshot knowledge-fixture-v2/ }));
    expect(card.queryByRole("button", { name: "Record review" })).not.toBeInTheDocument();
  });
});
