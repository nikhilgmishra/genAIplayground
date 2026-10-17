import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { INCIDENT_REF, staffView } from "../test/fixtures";
import { createMockApi, errorResponse } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

async function openDialog(path = "/kill-switches", staffKey: Parameters<typeof staffView>[0] = "supervisor") {
  const api = createMockApi();
  const ctx = renderConsole({ path, staff: staffView(staffKey), api });
  await findPage("Kill switches");
  await ctx.user.click(await screen.findByRole("button", { name: "Change a kill switch" }));
  const dialog = screen.getByRole("dialog", { name: "Change a kill switch" });
  return { ...ctx, api, dialog: within(dialog) };
}

describe("kill switches", () => {
  it("[SPEC-13.console] the page states that safety and human routes remain available", async () => {
    renderConsole({ path: "/kill-switches" });
    await findPage("Kill switches");
    expect(screen.getByTestId("safety-routes-banner")).toHaveTextContent("Safety and human routes remain available");
  });

  it("[SPEC-13.console] engaging WRITES requires a reason code and the exact typed confirmation, then sends the exact payload", async () => {
    const { user, api, dialog } = await openDialog();
    const submit = dialog.getByRole("button", { name: "Apply kill switch change" });
    expect(submit).toBeDisabled();

    await user.selectOptions(dialog.getByLabelText("Scope"), "WRITES");
    expect(dialog.getByText(/this scope applies globally/)).toBeInTheDocument();
    await user.click(dialog.getByLabelText("Engage (stop this automation)"));
    expect(submit).toBeDisabled();

    // No reason yet: the confirmation alone is not enough.
    const confirm = dialog.getByLabelText(/to confirm/);
    await user.type(confirm, "ENGAGE WRITES *");
    expect(submit).toBeDisabled();

    await user.selectOptions(dialog.getByLabelText("Reason code"), "INCIDENT_CONTAINMENT");
    await user.type(dialog.getByLabelText(/Incident reference/), INCIDENT_REF);
    expect(submit).toBeEnabled();

    // A near-miss confirmation (case) disables the action again.
    await user.clear(confirm);
    await user.type(confirm, "engage writes *");
    expect(submit).toBeDisabled();
    expect(dialog.getByText("The confirmation phrase must match exactly.")).toBeInTheDocument();
    await user.clear(confirm);
    await user.type(confirm, "ENGAGE WRITES *");
    expect(submit).toBeEnabled();

    await user.click(submit);
    const calls = api.calls("killSwitches.set");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      scope: "WRITES",
      target: "*",
      engaged: true,
      reason: `INCIDENT_CONTAINMENT:${INCIDENT_REF}`,
      confirmationPhrase: "ENGAGE WRITES *",
    });
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer /);
    expect(await screen.findByText(/Kill switch WRITES \(\*\) engaged\. Safety and human routes remain available/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("[SPEC-13.console] the reason cannot carry personal data: a phone-number incident reference blocks submission", async () => {
    const { user, api, dialog } = await openDialog();
    await user.selectOptions(dialog.getByLabelText("Scope"), "AI_ADMISSION");
    await user.click(dialog.getByLabelText("Engage (stop this automation)"));
    await user.selectOptions(dialog.getByLabelText("Reason code"), "UNSAFE_OUTPUT");
    await user.type(dialog.getByLabelText(/Incident reference/), "+15555550101");
    await user.type(dialog.getByLabelText(/to confirm/), "ENGAGE AI_ADMISSION *");
    expect(dialog.getByText(/Not an opaque reference/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Apply kill switch change" })).toBeDisabled();
    expect(api.calls("killSwitches.set")).toHaveLength(0);
  });

  it("[SPEC-13.console] releasing an engaged integration switch from its row is prefilled and still needs reason and confirmation", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: "/kill-switches", api });
    await findPage("Kill switches");
    await user.click(await screen.findByRole("button", { name: "Release INTEGRATION salesforce" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Scope")).toHaveValue("INTEGRATION");
    expect(dialog.getByLabelText(/Target/)).toHaveValue("salesforce");
    expect(dialog.getByLabelText("Release (resume this automation)")).toBeChecked();
    const submit = dialog.getByRole("button", { name: "Apply kill switch change" });
    expect(submit).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "ROOT_CAUSE_FIXED");
    await user.type(dialog.getByLabelText(/to confirm/), "RELEASE INTEGRATION salesforce");
    await user.click(submit);
    expect(api.calls("killSwitches.set")[0]?.body).toEqual({
      scope: "INTEGRATION",
      target: "salesforce",
      engaged: false,
      reason: "ROOT_CAUSE_FIXED",
      confirmationPhrase: "RELEASE INTEGRATION salesforce",
    });
    expect(await screen.findByText(/Kill switch INTEGRATION \(salesforce\) released/)).toBeInTheDocument();
  });

  it("[SPEC-13.console] a server refusal (e.g. audit unavailable) is shown as a reason code and nothing is announced as changed", async () => {
    const { user, api, dialog } = await openDialog();
    api.setHandler("killSwitches.set", () => errorResponse(503, "AUDIT_UNAVAILABLE"));
    await user.selectOptions(dialog.getByLabelText("Scope"), "OUTBOUND_NOTIFICATIONS");
    await user.click(dialog.getByLabelText("Engage (stop this automation)"));
    await user.selectOptions(dialog.getByLabelText("Reason code"), "PHI_EXPOSURE_SUSPECTED");
    await user.type(dialog.getByLabelText(/to confirm/), "ENGAGE OUTBOUND_NOTIFICATIONS *");
    await user.click(dialog.getByRole("button", { name: "Apply kill switch change" }));
    const alert = await dialog.findByRole("alert");
    expect(alert).toHaveTextContent("The kill switch was not changed. Reason code: AUDIT_UNAVAILABLE");
    expect(screen.getByTestId("live-region")).toHaveTextContent("");
  });

  it("[SPEC-16.console-a11y] the kill switch dialog closes with Escape and returns focus to its opener", async () => {
    const { user } = await openDialog();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change a kill switch" })).toHaveFocus();
  });
});
