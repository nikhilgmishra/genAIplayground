/**
 * Database outage on a consequential commit (spec section 12: "A database outage must block
 * protected reads and writes"). REAL modules over PGlite (kill switches, action ledger, audit
 * writer, OPA bundle) with LOCAL SYNTHETIC fixtures (business/testing/harness.ts). The outage is
 * simulated by making every call on the harness database reject after the change was prepared
 * and confirmed. Observed path: the kill-switch state cannot be read, so it fails closed and
 * policy refuses the commit before the action ledger or the provider is reached.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPOINTMENTS, PEOPLE, SLOTS } from "../fixtures/synthetic-world.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
let restore: (() => void) | null = null;

beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  restore?.();
  restore = null;
  await h.close();
});

/** LOCAL FIXTURE outage: query, exec and tx on the harness database all reject until restored. */
function databaseOutage(): void {
  const db = h.db as unknown as Record<string, unknown>;
  const down = async () => {
    throw new Error("LOCAL_FIXTURE_DATABASE_OUTAGE");
  };
  for (const m of ["query", "exec", "tx"]) db[m] = down;
  restore = () => {
    for (const m of ["query", "exec", "tx"]) delete db[m];
  };
}

describe("commit during a database outage", () => {
  it("[SPEC-12.db-outage] a confirmed reschedule is refused, never committed and never reported as success while the database is down", async () => {
    const { sessionRef } = await h.startCall();
    const auth = await h.verify(PEOPLE.avery, sessionRef);
    const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: SLOTS[0].startsAt, modality: null }));
    if (p.outcome.status !== "SUCCESS") throw new Error("prepare failed");
    const change = (p.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
    await h.confirm(auth, change.actionId, change.actionDigest);

    databaseOutage();
    const r = await h.invoke("commit_appointment_change", auth, { actionId: change.actionId, digest: change.actionDigest }).catch(() => null);
    expect(r?.stage === "done" && r.outcome.status === "SUCCESS").toBe(false);
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
    expect((await h.fixtures.scheduling.getAppointment(APPOINTMENTS[0].appointmentId))?.startsAt).toBe(APPOINTMENTS[0].startsAt);
  });
});
