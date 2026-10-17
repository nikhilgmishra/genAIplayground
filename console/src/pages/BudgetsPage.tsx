/**
 * Budgets by environment, cohort, workflow and vendor (spec section 12).
 * Alerts and prepaid balances are not hard caps; vendor metering is delayed, so
 * projected spend adds the metering delay times the recent burn rate. Budget
 * exhaustion stops new nonessential automation and never disconnects an active
 * safety handoff; safety spend draws on the bounded safety reserve first.
 */
import { useApi } from "../api/ApiContext";
import type { BudgetView } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { QueryView } from "../components/QueryView";
import { StatusText } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { formatUsd } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

function scopeLabel(b: BudgetView): string {
  return `${b.scope.environment} / cohort ${b.scope.cohort} / workflow ${b.scope.workflow} / vendor ${b.scope.vendor}`;
}

function BudgetStatus({ b }: { b: BudgetView }) {
  return (
    <>
      {b.exhausted ? (
        <StatusText tone="bad" label="Exhausted: new nonessential automation stopped" />
      ) : (
        <StatusText tone="ok" label="Within nonessential allowance" />
      )}
      {b.safetyReserveExceeded ? (
        <>
          <br />
          <StatusText tone="bad" label="Safety reserve exceeded: escalation owner alerted (safety work continues)" />
        </>
      ) : null}
    </>
  );
}

export function BudgetsPage() {
  useDocumentTitle("Budgets");
  const api = useApi();
  const query = useApiQuery(() => api.request("budgets.list", {}), []);
  return (
    <>
      <h1>Budgets</h1>
      <div className="notice notice-warn" data-testid="budget-caveat">
        <p>
          <strong>Alerts are not hard caps.</strong> Vendor metering is delayed, so recorded spend understates actual spend; projections add the
          metering delay times the recent burn rate. Fixed charges may apply regardless.
        </p>
        <p>
          Budget exhaustion stops new nonessential automation and routes callers to the approved continuity service. It never disconnects an
          active safety handoff: safety spend draws on the bounded safety reserve, and exceeding that reserve alerts the escalation owner.
        </p>
      </div>
      <QueryView query={query} label="budgets">
        {(data) => (
          <>
            <p className="hint">
              Generated <Timestamp value={data.generatedAt} />.
              {data.figuresIllustrative ? " Figures are illustrative local fixture values, not approved budgets." : ""}
            </p>
            {data.budgets.length === 0 ? (
              <p>No budgets defined. Nonessential admission fails closed without a covering budget.</p>
            ) : (
              <table>
                <caption>Spend versus limit by budget scope</caption>
                <thead>
                  <tr>
                    <th scope="col">Scope</th>
                    <th scope="col">Period</th>
                    <th scope="col">Limit</th>
                    <th scope="col">Recorded spend</th>
                    <th scope="col">Projected spend</th>
                    <th scope="col">Safety reserve</th>
                    <th scope="col">Nonessential headroom</th>
                    <th scope="col">Status</th>
                    <th scope="col">Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {data.budgets.map((b) => {
                    const pct = b.limitUsd > 0 ? Math.round((b.projectedUsd / b.limitUsd) * 100) : 0;
                    return (
                      <tr key={b.budgetId}>
                        <th scope="row">
                          {scopeLabel(b)} <code>{b.budgetId}</code>
                        </th>
                        <td>
                          <Timestamp value={b.periodStart} /> to <Timestamp value={b.periodEnd} />
                        </td>
                        <td>{formatUsd(b.limitUsd)}</td>
                        <td>
                          {formatUsd(b.spentUsd)} (safety {formatUsd(b.safetySpentUsd)}, other {formatUsd(b.nonSafetySpentUsd)})
                        </td>
                        <td>
                          <meter min={0} max={b.limitUsd} value={Math.min(b.projectedUsd, b.limitUsd)} aria-label={`Projected spend for budget ${b.budgetId}`} />{" "}
                          {formatUsd(b.projectedUsd)} ({pct}% of limit; metering delay {b.meteringDelayMinutes} min, burn {formatUsd(b.burnRateUsdPerMinute)}
                          /min)
                        </td>
                        <td>
                          {formatUsd(b.safetyReserveRemainingUsd)} remaining of {formatUsd(b.safetyReserveUsd)}
                        </td>
                        <td>{formatUsd(b.nonessentialHeadroomUsd)}</td>
                        <td>
                          <BudgetStatus b={b} />
                        </td>
                        <td>{b.approvedBy ? <code>{b.approvedBy}</code> : <StatusText tone="warn" label="Unapproved" />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </QueryView>
    </>
  );
}
