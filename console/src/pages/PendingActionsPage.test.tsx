import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

describe("pending actions", () => {
  it("[SPEC-13.console] cancelling uncommitted work needs a confirm dialog with a reason code and sends reason plus expected state", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: "/actions", api });
    await findPage("Pending actions");
    await user.click(await screen.findByRole("button", { name: "Cancel action act_synthActionPrepared01" }));
    const dialog = within(screen.getByRole("dialog", { name: "Cancel action act_synthActionPrepared01" }));
    const confirm = dialog.getByRole("button", { name: "Confirm cancellation" });
    expect(confirm).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText("Reason code"), "CALLER_CHANGED_REQUEST");
    await user.click(confirm);
    const calls = api.calls("actions.cancel");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reason: "CALLER_CHANGED_REQUEST", expectedState: "PREPARED" });
    expect(await screen.findByText(/Action act_synthActionPrepared01 is CANCELLED/)).toBeInTheDocument();
  });

  it("[ACT-03] an action whose commit has started is not cancellable from the console", async () => {
    renderConsole({ path: "/actions" });
    await findPage("Pending actions");
    const row = (await screen.findByRole("rowheader", { name: "act_synthActionCommitting" })).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).getByText(/Not cancellable/)).toHaveTextContent("COMMIT_IN_PROGRESS");
  });

  it("[SPEC-7.staff] roles without cancel permission cannot open pending actions at all", async () => {
    const api = createMockApi();
    renderConsole({ path: "/actions", staff: staffView("safety"), api });
    await findPage("Not permitted");
    expect(api.calls("actions.pending")).toHaveLength(0);
  });
});
