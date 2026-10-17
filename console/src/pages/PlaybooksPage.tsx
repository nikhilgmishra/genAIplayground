import { ESCALATION_ROLES, PLAYBOOKS } from "../content/playbooks";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** Escalation roster and incident playbooks (spec section 13). */
export function PlaybooksPage() {
  useDocumentTitle("Escalation and playbooks");
  return (
    <>
      <h1>Escalation roster and playbooks</h1>
      <p className="notice notice-warn">
        The named escalation roster is BLOCKED: it needs a named incident authority (PRQ-001, executive sponsor and support owner) and an
        on-call roster with paging (PRQ-011, SRE and security operations). Runbooks name roles, not people. Every runbook is an undrilled draft.
      </p>
      <p>
        Privacy counsel determines reporting obligations and deadlines; the software preserves evidence and supports the process.
      </p>
      <section aria-labelledby="pb-roles">
        <h2 id="pb-roles">Escalation roles</h2>
        <table>
          <caption>Communication and escalation roles</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Responsibility</th>
              <th scope="col">Named person</th>
            </tr>
          </thead>
          <tbody>
            {ESCALATION_ROLES.map((r) => (
              <tr key={r.role}>
                <th scope="row">{r.role}</th>
                <td>{r.responsibility}</td>
                <td>BLOCKED (PRQ-001, PRQ-011)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="pb-list">
        <h2 id="pb-list">Playbooks</h2>
        <table>
          <caption>Incident and recovery runbooks (docs/RUNBOOKS)</caption>
          <thead>
            <tr>
              <th scope="col">Runbook</th>
              <th scope="col">Title</th>
              <th scope="col">Severity</th>
              <th scope="col">Primary owner role</th>
              <th scope="col">Last drilled</th>
              <th scope="col">Location</th>
            </tr>
          </thead>
          <tbody>
            {PLAYBOOKS.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <code>{p.id}</code>
                </th>
                <td>{p.title}</td>
                <td>{p.severity}</td>
                <td>{p.ownerRole}</td>
                <td>NEVER (not yet run)</td>
                <td>
                  <code>docs/RUNBOOKS/{p.file}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
