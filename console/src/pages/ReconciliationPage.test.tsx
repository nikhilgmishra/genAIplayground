import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReconciliationItem } from "../api/contract";
import { reconciliation, staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";
import { retryAllowed } from "./ReconciliationPage";

const ACTION = "act_synthActionUnknown01";

describe("reconciliation queue", () => {
  it("[ACT-03] retry stays disabled until reconciliation returns NOT_FOUND, then sends the reconciliation id and reason", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: "/reconciliation", api });
    await findPage("Reconciliation queue");
    const retry = await screen.findByRole("button", { name: `Retry action ${ACTION}` });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleDescription("Retry is available only after reconciliation returns NOT_FOUND.");

    // Provider lookup is still ambiguous: retry must remain disabled.
    api.state.reconcileOutcomes[ACTION] = "UNKNOWN";
    await user.click(screen.getByRole("button", { name: `Reconcile action ${ACTION}` }));
    expect(await screen.findByText(/provider result UNKNOWN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Retry action ${ACTION}` })).toBeDisabled();
    expect(api.calls("reconciliation.retry")).toHaveLength(0);

    // Provider has no record of the commit: retry becomes available.
    api.state.reconcileOutcomes[ACTION] = "NOT_FOUND";
    await user.click(screen.getByRole("button", { name: `Reconcile action ${ACTION}` }));
    expect(await screen.findByText(/provider result NOT_FOUND/)).toBeInTheDocument();
    const enabled = screen.getByRole("button", { name: `Retry action ${ACTION}` });
    expect(enabled).toBeEnabled();
    const reconciliationId = api.state.latestReconcile[ACTION]?.reconciliationId;
    expect(reconciliationId).toBeTruthy();

    await user.click(enabled);
    const dialog = within(screen.getByRole("dialog", { name: `Retry action ${ACTION}` }));
    expect(dialog.getByRole("button", { name: "Confirm retry" })).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "RECONCILED_NOT_FOUND_RETRY");
    await user.click(dialog.getByRole("button", { name: "Confirm retry" }));
    const calls = api.calls("reconciliation.retry");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/console/api/v1/reconciliation/${ACTION}/retry`);
    expect(calls[0]?.body).toEqual({ reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" });
    expect(await screen.findByText(/Retry of act_synthActionUnknown01: outcome COMMITTED/)).toBeInTheDocument();
  });

  it("[ACT-03] retryAllowed is false for COMMITTED, UNKNOWN and missing reconciliation results", () => {
    const base: ReconciliationItem = reconciliation().actions[0]!;
    const at = "2026-10-17T15:00:00.000Z";
    expect(retryAllowed(base, undefined)).toBe(false);
    expect(retryAllowed({ ...base, retryEligible: true, lastReconcile: { reconciliationId: "rcn_synthReconcile00001", result: "UNKNOWN", at, receiptId: null } }, undefined)).toBe(false);
    expect(retryAllowed({ ...base, retryEligible: true, lastReconcile: { reconciliationId: "rcn_synthReconcile00002", result: "COMMITTED", at, receiptId: "rcp_synthReceipt0000001" } }, undefined)).toBe(false);
    // Server says NOT_FOUND but not eligible (e.g. a newer attempt exists): still disabled.
    expect(retryAllowed({ ...base, retryEligible: false, lastReconcile: { reconciliationId: "rcn_synthReconcile00003", result: "NOT_FOUND", at, receiptId: null } }, undefined)).toBe(false);
    expect(retryAllowed({ ...base, retryEligible: true, lastReconcile: { reconciliationId: "rcn_synthReconcile00004", result: "NOT_FOUND", at, receiptId: null } }, undefined)).toBe(true);
  });

  it("[ACT-02] requeueing a dead-lettered message needs a reason code and sends only the reason", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: "/reconciliation", api });
    await findPage("Reconciliation queue");
    await user.click(await screen.findByRole("button", { name: "Requeue message msg_synthDeadLetter00001" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Consumers deduplicate by message id/)).toBeInTheDocument();
    const submit = dialog.getByRole("button", { name: "Confirm requeue" });
    expect(submit).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "ROOT_CAUSE_FIXED");
    await user.click(submit);
    expect(api.calls("outbox.requeue")[0]?.body).toEqual({ reason: "ROOT_CAUSE_FIXED" });
    expect(await screen.findByText(/Message msg_synthDeadLetter00001 requeued/)).toBeInTheDocument();
  });

  it("[SPEC-7.staff] a support agent cannot open the reconciliation queue and no queue data is requested", async () => {
    const api = createMockApi();
    renderConsole({ path: "/reconciliation", staff: staffView("agent"), api });
    await findPage("Not permitted");
    expect(api.calls("reconciliation.list")).toHaveLength(0);
  });
});
