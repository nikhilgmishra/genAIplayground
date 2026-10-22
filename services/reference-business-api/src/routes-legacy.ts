/**
 * Legacy scheduling endpoint (WP-23; FO-06-75: "non-idempotent downstream APIs require an explicit supported
 * reconciliation path").
 *
 * It stands in for an older product the reference API keeps for tenants that still use it:
 *   POST /api/v1/legacy/appointments/{externalRef}               creates an appointment. NOT idempotent: every
 *                                                                delivery creates another appointment (the
 *                                                                reference is stored, not enforced unique), and
 *                                                                there is no slot locking (double booking is
 *                                                                possible).
 *   GET  /api/v1/legacy/appointments/by-reference/{externalRef}  the supported reconciliation path: appointments
 *                                                                carrying the reference, visible after the
 *                                                                account's documented visibility window.
 *   GET  /api/v1/legacy/appointments/{apptRef}                   one appointment.
 *   PUT  /api/v1/legacy/references/{externalRef}                 reserves the reference for ONE dispatch (its
 *                                                                dispatch id) before a create: the first
 *                                                                reservation wins, every later one answers the
 *                                                                stored state with reservedForDispatch false, so a
 *                                                                client that creates only under its own
 *                                                                reservation never sends a second create for the
 *                                                                reference (the product's dispatch marker; the
 *                                                                lookup by reference lags and cannot be one).
 *   POST /api/v1/legacy/references/{externalRef}/release         gives back a reservation whose create was
 *                                                                provably never sent (same dispatch id only).
 *   POST /api/v1/legacy/references/{externalRef}/fence           once the client's deadline has passed: POSTED
 *                                                                (a create committed under the reference), or
 *                                                                FENCED (no create can ever be stored under it; a
 *                                                                reservation that never created is fenced). Waits
 *                                                                for a create still inside its transaction. The
 *                                                                only proof of absence (never a 404 plus time).
 * Its representation is the legacy one: wall-clock local start time without offset (the account's time zone)
 * and legacy status and mode codes, which a tenant profile maps through the DSL's zone and enum tables.
 * A create takes the reference's row lock: under a FENCED reference it is refused 409 FENCED, under a reservation
 * of another dispatch id (when the create names its dispatch id) 409 RESERVED_BY_ANOTHER_DISPATCH; nothing is
 * stored either way. A create may carry a dispatch deadline (`notAfter`, deadline.ts): it is stored only if the
 * final deadline check, the last statement of its transaction, passes; otherwise 409 DEADLINE_EXCEEDED.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Tx } from "./db.js";
import { boundByDeadline, DEADLINE_EXCEEDED, FENCE_BEFORE_DEADLINE, FENCED, isDeadlineAbort, withinDeadline } from "./deadline.js";
import { ApiError, notFound } from "./errors.js";
import type { ApiDeps } from "./http.js";
import { context, deadlineOf, get, Id, NotAfter, parse } from "./http.js";
import { newId } from "./ids.js";
import type { AppointmentRow } from "./representation.js";
import { legacyAppointment } from "./representation.js";

const ExternalRef = z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/);
const LegacyBooking = z.strictObject({
  clientRef: Id,
  providerRef: Id,
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  modeCode: z.enum(["VID", "OFC", "TEL"]),
  notAfter: NotAfter,
  /** The dispatch that reserved the reference (optional: a create without it is not checked against a reservation). */
  dispatchId: Id.optional(),
});
const Reservation = z.strictObject({ dispatchId: Id, notAfter: NotAfter });
const Release = z.strictObject({ dispatchId: Id });
const Fence = z.strictObject({ notAfter: z.iso.datetime({ offset: true }) });

interface ReferenceRow {
  external_ref: string;
  state: "RESERVED" | "POSTED" | "FENCED";
  dispatch_id: string | null;
  not_after: Date | null;
  reserved_at: Date | null;
  posted_at: Date | null;
  fenced_at: Date | null;
}

/** A reference as the API reports it; the stored dispatch id is never disclosed (only whether it is the caller's). */
function referenceView(r: ReferenceRow, dispatchId: string | null): Record<string, unknown> {
  return {
    externalRef: r.external_ref,
    state: r.state,
    reservedForDispatch: dispatchId !== null && r.state === "RESERVED" && r.dispatch_id === dispatchId,
    reservedAt: r.reserved_at?.toISOString() ?? null,
    postedAt: r.posted_at?.toISOString() ?? null,
    fencedAt: r.fenced_at?.toISOString() ?? null,
  };
}

const lockReference = async (tx: Tx, acct: string, externalRef: string): Promise<ReferenceRow | undefined> =>
  (await tx.query<ReferenceRow>("select * from refbiz.legacy_references where account_id = $1 and external_ref = $2 for update", [acct, externalRef])).rows[0];
const MODALITY: Record<string, string> = { VID: "video", OFC: "in_person", TEL: "phone" };

const SELECT = `select a.*, p.display_name from refbiz.appointments a join refbiz.providers p using (account_id, provider_id)`;

/** Wall-clock local time in `zone` -> UTC instant (two fixed-point passes over the zone offset). */
export function fromWallClock(local: string, zone: string): Date {
  const [d, t] = local.split("T") as [string, string];
  const [y, mo, day] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, day, h, mi);
  const offsetAt = (ms: number): number => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

export function legacyRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store } = deps;

  app.post("/api/v1/legacy/appointments/:externalRef", async (req, reply) => {
    const operation = "legacy.appointment.post";
    const ctx = await context(deps, req, reply, operation, "legacy:write");
    const { externalRef } = parse(z.object({ externalRef: ExternalRef }), req.params);
    const b = parse(LegacyBooking, req.body);
    const acct = ctx.account.account_id;
    const unavailable = deps.faults.take(acct, operation, ["HTTP_STATUS"]);
    if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
    const startsAt = fromWallClock(b.startLocal, ctx.account.time_zone);
    const notAfter = deadlineOf(b);
    const id = newId("apt");
    const row = await store.tx(async (tx) => {
      if (notAfter !== null && !(await boundByDeadline(tx, notAfter))) throw new ApiError(409, DEADLINE_EXCEEDED);
      // The reference's row lock: a create without a reservation records the reference POSTED; a fenced reference
      // refuses the create, and so does a reservation of another dispatch (when the create names its dispatch id).
      await tx.query(
        "insert into refbiz.legacy_references (account_id, external_ref, state, dispatch_id, not_after, posted_at) values ($1, $2, 'POSTED', $3, $4, now()) on conflict (account_id, external_ref) do nothing",
        [acct, externalRef, b.dispatchId ?? null, notAfter],
      );
      const ref = await lockReference(tx, acct, externalRef);
      if (!ref || ref.state === "FENCED") throw new ApiError(409, FENCED);
      if (b.dispatchId !== undefined && ref.dispatch_id !== null && ref.dispatch_id !== b.dispatchId) throw new ApiError(409, "RESERVED_BY_ANOTHER_DISPATCH");
      await tx.query("update refbiz.legacy_references set state = 'POSTED', posted_at = coalesce(posted_at, now()) where account_id = $1 and external_ref = $2", [acct, externalRef]);
      if ((await tx.query("select 1 from refbiz.subjects where account_id = $1 and subject_id = $2", [acct, b.clientRef])).rowCount === 0) throw notFound();
      if ((await tx.query("select 1 from refbiz.providers where account_id = $1 and provider_id = $2", [acct, b.providerRef])).rowCount === 0) throw notFound();
      await tx.query(
        `insert into refbiz.appointments (account_id, appointment_id, subject_id, provider_id, slot_id, starts_at, time_zone, modality, status, version, external_ref, visible_at, updated_at)
         values ($1, $2, $3, $4, null, $5, $6, $7, 'SCHEDULED', 1, $8, now() + make_interval(secs => $9::double precision / 1000), now())`,
        [acct, id, b.clientRef, b.providerRef, startsAt, ctx.account.time_zone, MODALITY[b.modeCode], externalRef, Math.min(ctx.account.lookup_lag_ms, ctx.account.visibility_window_ms)],
      );
      await tx.query("insert into refbiz.effects (account_id, key_ref, operation, resource_type, resource_id, before_version, after_version) values ($1, null, $2, 'appointment', $3, null, '1')", [acct, operation, id]);
      const created = (await tx.query<AppointmentRow>(`${SELECT} where a.account_id = $1 and a.appointment_id = $2`, [acct, id])).rows[0] as AppointmentRow;
      // The final deadline check, the last statement before COMMIT: past it, nothing is stored (the throw rolls back).
      if (notAfter !== null && !(await withinDeadline(tx, notAfter))) throw new ApiError(409, DEADLINE_EXCEEDED);
      // STALL_BEFORE_COMMIT seam: the check passed, the COMMIT is delayed (it may land after the deadline).
      const stall = deps.faults.take(acct, operation, ["STALL_BEFORE_COMMIT"]);
      if (stall && stall.delayMs > 0) await new Promise((r) => setTimeout(r, stall.delayMs));
      return created;
    }).catch((e: unknown) => {
      if (notAfter !== null && isDeadlineAbort(e)) throw new ApiError(409, DEADLINE_EXCEEDED);
      throw e;
    });
    // Faults after the effect (timeout after send / dropped response) exercise the reconciliation path.
    const drop = deps.faults.take(acct, operation, ["DROP_RESPONSE_AFTER_COMMIT"]);
    if (drop) {
      deps.faults.record(acct, { operation, keyRef: null, status: 0 });
      req.refbiz = null;
      reply.hijack();
      reply.raw.socket?.destroy();
      return;
    }
    const delay = deps.faults.take(acct, operation, ["COMMIT_THEN_DELAY"]);
    if (delay && delay.delayMs > 0) await new Promise((r) => setTimeout(r, delay.delayMs));
    return reply.code(200).send(legacyAppointment(row, ctx.account.time_zone));
  });

  app.put("/api/v1/legacy/references/:externalRef", async (req, reply) => {
    const operation = "legacy.reference.reserve";
    const ctx = await context(deps, req, reply, operation, "legacy:write");
    const { externalRef } = parse(z.object({ externalRef: ExternalRef }), req.params);
    const b = parse(Reservation, req.body);
    const acct = ctx.account.account_id;
    const unavailable = deps.faults.take(acct, operation, ["HTTP_STATUS"]);
    if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
    const notAfter = deadlineOf(b);
    const ref = await store.tx(async (tx) => {
      // The first reservation wins (waits for a reservation or create still inside its transaction); none after
      // the dispatch's own deadline.
      await tx.query(
        `insert into refbiz.legacy_references (account_id, external_ref, state, dispatch_id, not_after, reserved_at)
         select $1, $2, 'RESERVED', $3, $4::timestamptz, now() where $4::timestamptz is null or clock_timestamp() <= $4::timestamptz
         on conflict (account_id, external_ref) do nothing`,
        [acct, externalRef, b.dispatchId, notAfter],
      );
      return lockReference(tx, acct, externalRef);
    });
    if (!ref) throw new ApiError(409, DEADLINE_EXCEEDED);
    return reply.code(200).send(referenceView(ref, b.dispatchId));
  });

  app.post("/api/v1/legacy/references/:externalRef/release", async (req, reply) => {
    const operation = "legacy.reference.release";
    const ctx = await context(deps, req, reply, operation, "legacy:write");
    const { externalRef } = parse(z.object({ externalRef: ExternalRef }), req.params);
    const b = parse(Release, req.body);
    const acct = ctx.account.account_id;
    const released = await store.query<ReferenceRow>(
      "delete from refbiz.legacy_references where account_id = $1 and external_ref = $2 and state = 'RESERVED' and dispatch_id = $3 returning *",
      [acct, externalRef, b.dispatchId],
    );
    if (released[0]) return reply.code(200).send({ externalRef, state: "RELEASED", reservedForDispatch: false, reservedAt: null, postedAt: null, fencedAt: null });
    const current = (await store.query<ReferenceRow>("select * from refbiz.legacy_references where account_id = $1 and external_ref = $2", [acct, externalRef]))[0];
    if (!current) throw notFound();
    return reply.code(200).send(referenceView(current, b.dispatchId));
  });

  app.post("/api/v1/legacy/references/:externalRef/fence", async (req, reply) => {
    const operation = "legacy.reference.fence";
    const ctx = await context(deps, req, reply, operation, "legacy:write");
    const { externalRef } = parse(z.object({ externalRef: ExternalRef }), req.params);
    const b = parse(Fence, req.body);
    const acct = ctx.account.account_id;
    const unavailable = deps.faults.take(acct, operation, ["HTTP_STATUS"]);
    if (unavailable) throw new ApiError(unavailable.status, "UNAVAILABLE", unavailable.retryAfterSeconds);
    const notAfter = new Date(b.notAfter).toISOString();
    const ref = await store.tx(async (tx) => {
      // Nothing under the reference: FENCED (only past the deadline). A create or reservation still inside its
      // transaction is waited for (the reference's unique key), then its committed state is answered.
      await tx.query(
        `insert into refbiz.legacy_references (account_id, external_ref, state, not_after, fenced_at)
         select $1, $2, 'FENCED', $3::timestamptz, now() where clock_timestamp() > $3::timestamptz
         on conflict (account_id, external_ref) do nothing`,
        [acct, externalRef, notAfter],
      );
      const current = await lockReference(tx, acct, externalRef);
      if (!current) throw new ApiError(409, FENCE_BEFORE_DEADLINE);
      if (current.state !== "RESERVED") return current;
      // A reservation whose create never committed: fenced once the deadline has passed (no create can follow).
      const fenced = (
        await tx.query<ReferenceRow>(
          "update refbiz.legacy_references set state = 'FENCED', fenced_at = now() where account_id = $1 and external_ref = $2 and clock_timestamp() > $3::timestamptz returning *",
          [acct, externalRef, notAfter],
        )
      ).rows[0];
      return fenced ?? current;
    });
    return reply.code(200).send(referenceView(ref, null));
  });

  get(app, deps, "/api/v1/legacy/appointments/by-reference/:externalRef", "legacy.appointments.by_reference", "legacy:read", async (ctx, req) => {
    const { externalRef } = parse(z.object({ externalRef: ExternalRef }), req.params);
    const rows = await store.query<AppointmentRow>(`${SELECT} where a.account_id = $1 and a.external_ref = $2 and a.visible_at <= now() order by a.appointment_id`, [ctx.account.account_id, externalRef]);
    return { items: rows.map((r) => legacyAppointment(r, ctx.account.time_zone)) };
  });

  get(app, deps, "/api/v1/legacy/appointments/:apptRef", "legacy.appointment.get", "legacy:read", async (ctx, req) => {
    const { apptRef } = parse(z.object({ apptRef: Id }), req.params);
    const r = (await store.query<AppointmentRow>(`${SELECT} where a.account_id = $1 and a.appointment_id = $2`, [ctx.account.account_id, apptRef]))[0];
    if (!r) throw notFound();
    return legacyAppointment(r, ctx.account.time_zone);
  });
}
