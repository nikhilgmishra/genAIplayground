import type { Queryable, TxOptions } from "./types.js";

const ROLE_RE = /^(app_runtime|app_worker|app_console|app_auditor)$/;

export async function applyTxOptions(tx: Queryable, opts: TxOptions | undefined): Promise<void> {
  const role = opts?.role ?? "app_runtime";
  if (opts?.isolation) {
    await tx.query(`set transaction isolation level ${opts.isolation}`);
  }
  if (role !== "owner") {
    if (!ROLE_RE.test(role)) throw new Error("invalid db role");
    await tx.query(`set local role ${role}`);
  }
  const rls = opts?.rls;
  await tx.query(
    `select set_config('app.tenant_id', $1, true), set_config('app.organization_id', $2, true),
            set_config('app.subject_id', $3, true), set_config('app.actor_id', $4, true)`,
    [rls?.tenantId ?? "", rls?.organizationId ?? "", rls?.subjectId ?? "", rls?.actorId ?? ""],
  );
}
