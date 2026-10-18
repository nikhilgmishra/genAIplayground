import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { budgets, staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

describe("budgets", () => {
  it("[SPEC-12.budgets] shows spend versus limit, projected spend with metering delay, the safety reserve, and that alerts are not hard caps", async () => {
    renderConsole({ path: "/budgets", staff: staffView("supervisor") });
    await findPage("Budgets");
    expect(screen.getByTestId("budget-caveat")).toHaveTextContent("Alerts are not hard caps.");
    expect(screen.getByTestId("budget-caveat")).toHaveTextContent("never disconnects an active safety handoff");
    const table = within(await screen.findByRole("table", { name: "Spend versus limit by budget scope" }));
    expect(table.getByText(/\$45\.50 \(46% of limit; metering delay 60 min/)).toBeInTheDocument();
    expect(table.getByText("$17.50 remaining of $20.00")).toBeInTheDocument();
    expect(table.getByRole("meter", { name: "Projected spend for budget bud_synthBudgetLocal0001" })).toBeInTheDocument();
    expect(table.getByText("Unapproved")).toBeInTheDocument();
    expect(screen.getByText(/illustrative local fixture values, not approved budgets/)).toBeInTheDocument();
  });

  it("[SAFE-03] an exhausted budget is shown as stopping nonessential automation only, and reserve overdraw as an alert", async () => {
    const api = createMockApi();
    api.setHandler("budgets.list", () => {
      const b = budgets();
      const first = b.budgets[0]!;
      return { status: 200, body: { ...b, budgets: [{ ...first, exhausted: true, safetyReserveExceeded: true, safetyReserveRemainingUsd: 0 }] } };
    });
    renderConsole({ path: "/budgets", staff: staffView("securityAdmin"), api });
    await findPage("Budgets");
    expect(await screen.findByText("Exhausted: new nonessential automation stopped")).toBeInTheDocument();
    expect(screen.getByText("Safety reserve exceeded: escalation owner alerted (safety work continues)")).toBeInTheDocument();
  });
});
