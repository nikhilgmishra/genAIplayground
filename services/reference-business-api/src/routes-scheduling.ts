/**
 * Scheduling system of record (WP-23; canonical scheduling contract: options, create, reschedule, cancel; and the
 * provider-approved availability block). Administrative availability only: no clinical suitability matching.
 *
 * Authority rules enforced HERE, by the system of record, independently of the platform (AUTH-02, AUTH-05):
 *   CLIENT_CONFIRMED   the acting party is the appointment's own client (the client confirmed the change);
 *   PROVIDER_APPROVED  the acting party is the provider whose schedule it is (the provider approved it).
 * A provider approval never stands in for a client's consent: a booking for a client requires
 * CLIENT_CONFIRMED by that client, and a provider can act only on their own appointments and slots.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Applied } from "./changes.js";
import type { Tx } from "./db.js";
import { ApiError, notFound } from "./errors.js";
import type { ApiDeps, Ctx } from "./http.js";
import { context, deadlineOf, get, Id, KeyRef, NotAfter, parse } from "./http.js";
import { newId } from "./ids.js";
import type { AppointmentRow, SlotRow } from "./representation.js";
import { appointment, slot } from "./representation.js";

const Version = z.string().regex(/^[1-9][0-9]{0,8}$/);
const Authority = z.enum(["CLIENT_CONFIRMED", "PROVIDER_APPROVED"]);

const Booking = z.strictObject({ subjectId: Id, slotId: Id, slotVersion: Version, authority: Authority, actingPartyId: Id, notAfter: NotAfter });
const Reschedule = z.strictObject({ appointmentId: Id, expectedVersion: Version, slotId: Id, slotVersion: Version, authority: Authority, actingPartyId: Id, notAfter: NotAfter });
const Cancellation = z.strictObject({
  appointmentId: Id,
  expectedVersion: Version,
  reasonCode: z.enum(["CLIENT_REQUEST", "PROVIDER_UNAVAILABLE", "SCHEDULING_CONFLICT"]),
  authority: Authority,
  actingPartyId: Id,
  notAfter: NotAfter,
});
const AvailabilityBlock = z.strictObject({
  providerId: Id,
  slotId: Id,
  slotVersion: Version,
  reasonCode: z.enum(["PROVIDER_UNAVAILABLE", "ADMINISTRATIVE"]),
  authority: Authority,
  actingPartyId: Id,
  notAfter: NotAfter,
});

const Days = z.object({ days: z.coerce.number().int().min(1).max(62).default(14) }).strict();
const OptionsQuery = z.object({ days: z.coerce.number().int().min(1).max(62).default(14), appointmentId: Id.optional() }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{16,64}$/).optional() }).strict();

const APPOINTMENT_SELECT = `select a.*, p.display_name from refbiz.appointments a join refbiz.providers p using (account_id, provider_id)`;
const SLOT_SELECT = `select s.*, p.display_name from refbiz.slots s join refbiz.providers p using (account_id, provider_id)`;

export const encodeCursor = (offset: number): string => `cur_${Buffer.from(`offset:${String(offset).padStart(8, "0")}`).toString("base64url")}`;
export function decodeCursor(c: string | undefined): number {
  if (c === undefined) return 0;
  const m = /^offset:(\d{8})$/.exec(Buffer.from(c.slice(4), "base64url").toString("utf8"));
  if (!m) throw new ApiError(400, "REQUEST_INVALID");
  return Number(m[1]);
}

async function lockAppointment(tx: Tx, accountId: string, id: string): Promise<AppointmentRow> {
  const r = (await tx.query<AppointmentRow>(`${APPOINTMENT_SELECT} where a.account_id = $1 and a.appointment_id = $2 for update of a`, [accountId, id])).rows[0];
  if (!r) throw notFound();
  return r;
}

async function lockSlot(tx: Tx, accountId: string, id: string): Promise<SlotRow> {
  const r = (await tx.query<SlotRow>(`${SLOT_SELECT} where s.account_id = $1 and s.slot_id = $2 for update of s`, [accountId, id])).rows[0];
  if (!r) throw notFound();
  return r;
}

/** CLIENT_CONFIRMED by the appointment's client, or PROVIDER_APPROVED by its provider; nothing else. */
function assertAuthority(authority: string, actingPartyId: string, subjectId: string, providerId: string): void {
  if (authority === "CLIENT_CONFIRMED" && actingPartyId === subjectId) return;
  if (authority === "PROVIDER_APPROVED" && actingPartyId === providerId) return;
  throw new ApiError(403, "AUTHORITY_REFUSED");
}

async function readAppointment(tx: Tx, accountId: string, id: string, ctx: Ctx): Promise<Record<string, unknown>> {
  const r = (await tx.query<AppointmentRow>(`${APPOINTMENT_SELECT} where a.account_id = $1 and a.appointment_id = $2`, [accountId, id])).rows[0];
  if (!r) throw notFound();
  return appointment(r, ctx.account.dialect);
}

export function schedulingRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store } = deps;

  get(app, deps, "/api/v1/subjects/:subjectId/appointments", "scheduling.appointments.list", "scheduling:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const q = parse(ListQuery, req.query);
    const offset = decodeCursor(q.cursor);
    const rows = await store.query<AppointmentRow>(`${APPOINTMENT_SELECT} where a.account_id = $1 and a.subject_id = $2 order by a.starts_at, a.appointment_id limit $3 offset $4`, [
      ctx.account.account_id,
      subjectId,
      q.limit + 1,
      offset,
    ]);
    const page = rows.slice(0, q.limit);
    return { items: page.map((r) => appointment(r, ctx.account.dialect)), nextCursor: rows.length > q.limit ? encodeCursor(offset + q.limit) : null };
  });

  get(app, deps, "/api/v1/appointments/:appointmentId", "scheduling.appointment.get", "scheduling:read", async (ctx, req) => {
    const { appointmentId } = parse(z.object({ appointmentId: Id }), req.params);
    const r = (await store.query<AppointmentRow>(`${APPOINTMENT_SELECT} where a.account_id = $1 and a.appointment_id = $2`, [ctx.account.account_id, appointmentId]))[0];
    if (!r) throw notFound();
    return appointment(r, ctx.account.dialect);
  });

  // Options for a client: open slots in the next `days` days; for a reschedule, only the appointment's provider.
  get(app, deps, "/api/v1/subjects/:subjectId/slot-options", "scheduling.slot_options.list", "scheduling:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const q = parse(OptionsQuery, req.query);
    const acct = ctx.account.account_id;
    if ((await store.query("select 1 from refbiz.subjects where account_id = $1 and subject_id = $2", [acct, subjectId])).length === 0) throw notFound();
    let providerId: string | null = null;
    if (q.appointmentId !== undefined) {
      const a = (await store.query<{ subject_id: string; provider_id: string }>("select subject_id, provider_id from refbiz.appointments where account_id = $1 and appointment_id = $2", [acct, q.appointmentId]))[0];
      // Absent and "another client's appointment" answer the same way (no existence disclosure).
      if (!a || a.subject_id !== subjectId) throw notFound();
      providerId = a.provider_id;
    }
    const rows = await store.query<SlotRow>(
      `${SLOT_SELECT} where s.account_id = $1 and s.state = 'OPEN' and s.starts_at > now() and s.starts_at < now() + make_interval(days => $2)
         and ($3::text is null or s.provider_id = $3) order by s.starts_at, s.slot_id limit 100`,
      [acct, q.days, providerId],
    );
    return { items: rows.map((r) => slot(r, ctx.account.dialect)), nextCursor: null };
  });

  // A provider's own open slots (their schedule).
  get(app, deps, "/api/v1/providers/:providerId/slots", "scheduling.provider_slots.list", "scheduling:read", async (ctx, req) => {
    const { providerId } = parse(z.object({ providerId: Id }), req.params);
    const q = parse(Days, req.query);
    // An unknown provider is 404 (not an empty schedule): the platform tells "not a provider here" from "no slots".
    if ((await store.query("select 1 from refbiz.providers where account_id = $1 and provider_id = $2", [ctx.account.account_id, providerId])).length === 0) throw notFound();
    const rows = await store.query<SlotRow>(
      `${SLOT_SELECT} where s.account_id = $1 and s.provider_id = $2 and s.state = 'OPEN' and s.starts_at > now() and s.starts_at < now() + make_interval(days => $3) order by s.starts_at, s.slot_id limit 100`,
      [ctx.account.account_id, providerId, q.days],
    );
    return { items: rows.map((r) => slot(r, ctx.account.dialect)), nextCursor: null };
  });

  // One slot with its version: the read-back before a confirmation and the re-read at commit.
  app.get("/api/v1/slots/:slotId", async (req, reply) => {
    const operation = "scheduling.slot.get";
    const ctx = await context(deps, req, reply, operation, "scheduling:read");
    const { slotId } = parse(z.object({ slotId: Id }), req.params);
    const body = await (async () => {
      const r = (await store.query<SlotRow>(`${SLOT_SELECT} where s.account_id = $1 and s.slot_id = $2`, [ctx.account.account_id, slotId]))[0];
      if (!r) throw notFound();
      return slot(r, ctx.account.dialect);
    })();
    // CHANGED_SLOT_DURING_CONFIRMATION seam: another channel changes the slot right after this read-back.
    if (deps.faults.slotReadTriggersChange(ctx.account.account_id, slotId)) {
      await store.query("update refbiz.slots set version = version + 1 where account_id = $1 and slot_id = $2", [ctx.account.account_id, slotId]);
    }
    return reply.code(200).send(body);
  });

  // ------------------------------------------------------------------ writes (change requests)

  app.put("/api/v1/appointment-bookings/:requestId", async (req, reply) => {
    const operation = "scheduling.booking.put";
    const ctx = await context(deps, req, reply, operation, "scheduling:write");
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(Booking, req.body);
    const acct = ctx.account.account_id;
    await deps.changes.execute(
      { accountId: acct, operation, keyRef: requestId, body: b, barrierResourceId: b.slotId, notAfter: deadlineOf(b) },
      async (tx): Promise<Applied> => {
        if ((await tx.query("select 1 from refbiz.subjects where account_id = $1 and subject_id = $2", [acct, b.subjectId])).rowCount === 0) throw notFound();
        // A booking for a client is that client's decision: only their own confirmation authorizes it.
        if (b.authority !== "CLIENT_CONFIRMED" || b.actingPartyId !== b.subjectId) throw new ApiError(403, "AUTHORITY_REFUSED");
        const s = await lockSlot(tx, acct, b.slotId);
        if (s.state !== "OPEN") throw new ApiError(409, "SLOT_UNAVAILABLE");
        if (String(s.version) !== b.slotVersion) throw new ApiError(409, "VERSION_CONFLICT");
        await tx.query("update refbiz.slots set state = 'BOOKED', version = version + 1 where account_id = $1 and slot_id = $2", [acct, b.slotId]);
        const id = newId("apt");
        await tx.query(
          `insert into refbiz.appointments (account_id, appointment_id, subject_id, provider_id, slot_id, starts_at, time_zone, modality, status, version, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'SCHEDULED', 1, now())`,
          [acct, id, b.subjectId, s.provider_id, s.slot_id, s.starts_at, s.time_zone, s.modality],
        );
        return { resourceType: "appointment", resourceId: id, beforeVersion: null, afterVersion: "1", resource: await readAppointment(tx, acct, id, ctx) };
      },
      reply,
    );
  });

  app.put("/api/v1/appointment-reschedules/:requestId", async (req, reply) => {
    const operation = "scheduling.reschedule.put";
    const ctx = await context(deps, req, reply, operation, "scheduling:write");
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(Reschedule, req.body);
    const acct = ctx.account.account_id;
    await deps.changes.execute(
      { accountId: acct, operation, keyRef: requestId, body: b, barrierResourceId: b.appointmentId, notAfter: deadlineOf(b) },
      async (tx): Promise<Applied> => {
        const a = await lockAppointment(tx, acct, b.appointmentId);
        assertAuthority(b.authority, b.actingPartyId, a.subject_id, a.provider_id);
        if (a.status !== "SCHEDULED") throw new ApiError(409, "STATE_CONFLICT");
        if (String(a.version) !== b.expectedVersion) throw new ApiError(409, "VERSION_CONFLICT");
        if (b.slotId === a.slot_id) throw new ApiError(409, "SLOT_UNAVAILABLE");
        // Lock order: the appointment, then slots by id (no deadlock between concurrent reschedules).
        const ids = [b.slotId, a.slot_id].filter((x): x is string => x !== null).sort();
        const locked = new Map<string, SlotRow>();
        for (const id of ids) locked.set(id, await lockSlot(tx, acct, id));
        const target = locked.get(b.slotId) as SlotRow;
        if (target.provider_id !== a.provider_id || target.state !== "OPEN") throw new ApiError(409, "SLOT_UNAVAILABLE");
        if (String(target.version) !== b.slotVersion) throw new ApiError(409, "VERSION_CONFLICT");
        if (a.slot_id !== null) await tx.query("update refbiz.slots set state = 'OPEN', version = version + 1 where account_id = $1 and slot_id = $2", [acct, a.slot_id]);
        await tx.query("update refbiz.slots set state = 'BOOKED', version = version + 1 where account_id = $1 and slot_id = $2", [acct, b.slotId]);
        await tx.query(
          "update refbiz.appointments set slot_id = $3, starts_at = $4, time_zone = $5, modality = $6, version = version + 1, updated_at = now() where account_id = $1 and appointment_id = $2",
          [acct, a.appointment_id, target.slot_id, target.starts_at, target.time_zone, target.modality],
        );
        return { resourceType: "appointment", resourceId: a.appointment_id, beforeVersion: String(a.version), afterVersion: String(a.version + 1), resource: await readAppointment(tx, acct, a.appointment_id, ctx) };
      },
      reply,
    );
  });

  app.put("/api/v1/appointment-cancellations/:requestId", async (req, reply) => {
    const operation = "scheduling.cancellation.put";
    const ctx = await context(deps, req, reply, operation, "scheduling:write");
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(Cancellation, req.body);
    const acct = ctx.account.account_id;
    await deps.changes.execute(
      { accountId: acct, operation, keyRef: requestId, body: b, barrierResourceId: b.appointmentId, notAfter: deadlineOf(b) },
      async (tx): Promise<Applied> => {
        const a = await lockAppointment(tx, acct, b.appointmentId);
        assertAuthority(b.authority, b.actingPartyId, a.subject_id, a.provider_id);
        if (a.status !== "SCHEDULED") throw new ApiError(409, "STATE_CONFLICT");
        if (String(a.version) !== b.expectedVersion) throw new ApiError(409, "VERSION_CONFLICT");
        if (a.slot_id !== null) {
          await lockSlot(tx, acct, a.slot_id);
          await tx.query("update refbiz.slots set state = 'OPEN', version = version + 1 where account_id = $1 and slot_id = $2", [acct, a.slot_id]);
        }
        await tx.query("update refbiz.appointments set status = 'CANCELLED', version = version + 1, updated_at = now() where account_id = $1 and appointment_id = $2", [acct, a.appointment_id]);
        return { resourceType: "appointment", resourceId: a.appointment_id, beforeVersion: String(a.version), afterVersion: String(a.version + 1), resource: await readAppointment(tx, acct, a.appointment_id, ctx) };
      },
      reply,
    );
  });

  // Provider-approved: a provider closes one of their own open slots.
  app.put("/api/v1/availability-blocks/:requestId", async (req, reply) => {
    const operation = "scheduling.availability_block.put";
    const ctx = await context(deps, req, reply, operation, "scheduling:write");
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(AvailabilityBlock, req.body);
    const acct = ctx.account.account_id;
    await deps.changes.execute(
      { accountId: acct, operation, keyRef: requestId, body: b, barrierResourceId: b.slotId, notAfter: deadlineOf(b) },
      async (tx): Promise<Applied> => {
        if (b.authority !== "PROVIDER_APPROVED" || b.actingPartyId !== b.providerId) throw new ApiError(403, "AUTHORITY_REFUSED");
        const s = await lockSlot(tx, acct, b.slotId);
        // Another provider's slot: refused, never disclosed.
        if (s.provider_id !== b.providerId) throw new ApiError(403, "AUTHORITY_REFUSED");
        if (s.state !== "OPEN") throw new ApiError(409, "SLOT_UNAVAILABLE");
        if (String(s.version) !== b.slotVersion) throw new ApiError(409, "VERSION_CONFLICT");
        await tx.query("update refbiz.slots set state = 'BLOCKED', version = version + 1 where account_id = $1 and slot_id = $2", [acct, b.slotId]);
        const after = (await tx.query<SlotRow>(`${SLOT_SELECT} where s.account_id = $1 and s.slot_id = $2`, [acct, b.slotId])).rows[0] as SlotRow;
        return { resourceType: "slot", resourceId: s.slot_id, beforeVersion: String(s.version), afterVersion: String(s.version + 1), resource: slot(after, ctx.account.dialect) };
      },
      reply,
    );
  });
}
