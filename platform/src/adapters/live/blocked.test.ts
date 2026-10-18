import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CALLS, PEOPLE } from "../../fixtures/synthetic-world.js";
import { newId } from "../../shared/ids.js";
import { PlatformError } from "../../shared/errors.js";
import { BLOCKED_CAPABILITY_UNVERIFIED, BlockedCapabilityError, isBlockedCapability } from "../errors.js";
import type { BlockedLiveAdapter } from "./blocked-base.js";
import {
  BillingLiveBlocked,
  ClaimsLiveBlocked,
  ProviderSystemLiveBlocked,
  RelationshipDirectoryLiveBlocked,
  SchedulingLiveBlocked,
} from "./business-systems-blocked.js";
import { TalkdeskExploreClient, TalkdeskTelephonyLive } from "./talkdesk-blocked.js";

const here = dirname(fileURLToPath(import.meta.url));
const KNOWN_PRQ = new Set((parseYaml(readFileSync(resolve(here, "../../../../docs/prerequisites.yaml"), "utf8")) as { records: { id: string }[] }).records.map((r) => r.id));

async function expectBlocked(p: Promise<unknown>, integrationId: string): Promise<void> {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PlatformError);
  expect(err).toBeInstanceOf(BlockedCapabilityError);
  expect(err).toMatchObject({ reasonCode: BLOCKED_CAPABILITY_UNVERIFIED, retryable: false, integrationId });
  expect((err as Error).message).toBe(BLOCKED_CAPABILITY_UNVERIFIED);
}

const hof = () => newId("hof");

const cases: { adapter: BlockedLiveAdapter; calls: (() => Promise<unknown>)[] }[] = (() => {
  const scheduling = new SchedulingLiveBlocked();
  const billing = new BillingLiveBlocked();
  const claims = new ClaimsLiveBlocked();
  const provider = new ProviderSystemLiveBlocked();
  const relationships = new RelationshipDirectoryLiveBlocked();
  const telephony = new TalkdeskTelephonyLive();
  const explore = new TalkdeskExploreClient();
  const idem = "idem-blocked-stub-000000000";
  return [
    {
      adapter: scheduling,
      calls: [
        () => scheduling.listAppointments(PEOPLE.avery.subjectId),
        () => scheduling.getAppointment("apt_synthAveryAppt00001"),
        () => scheduling.listSlots({ subjectId: PEOPLE.avery.subjectId, appointmentId: null, fromDate: "2026-10-20", toDate: "2026-10-31" }),
        () => scheduling.reschedule({ appointmentId: "apt_synthAveryAppt00001", beforeVersion: "v1", slotId: "slt_synthMorganSlot0001", idempotencyKey: idem }),
        () => scheduling.create({ subjectId: PEOPLE.avery.subjectId, slotId: "slt_synthMorganSlot0001", idempotencyKey: idem }),
        () => scheduling.findByIdempotencyKey(idem),
      ],
    },
    {
      adapter: billing,
      calls: [
        () => billing.listInvoices(PEOPLE.avery.subjectId),
        () => billing.getInvoice("inv_synthAveryInvoice001"),
        () => billing.hostedPaymentPath("inv_synthAveryInvoice001"),
        () => billing.markInReview({ invoiceId: "inv_synthAveryInvoice001", beforeVersion: "v1", idempotencyKey: idem }),
        () => billing.findReviewByIdempotencyKey(idem),
      ],
    },
    { adapter: claims, calls: [() => claims.listClaims(PEOPLE.avery.subjectId), () => claims.getClaim("clm_synthAveryClaim0001")] },
    {
      adapter: provider,
      calls: [() => provider.getOnboardingStatus(PEOPLE.newbie.subjectId ?? ""), () => provider.listRemittances({ practiceId: "org_synthPracticeNorth1", fromDate: "2026-09-01", toDate: "2026-10-31" })],
    },
    { adapter: relationships, calls: [() => relationships.relationshipsFor(PEOPLE.dana.actorId, "personal_representative")] },
    {
      adapter: telephony,
      calls: [
        () => telephony.requestTransfer({ callId: CALLS.primary.callId, destinationId: "dst_safety_priority", handoffId: hof(), priority: "SAFETY" }),
        () => telephony.playApprovedUpdate({ callId: CALLS.primary.callId, templateId: "transfer.hold_update" }),
        () => telephony.subscribeTransferEvents(() => undefined),
      ],
    },
    {
      adapter: explore,
      calls: [() => explore.requestReport({ reportType: "UNKNOWN_REPORT", fromDate: "2026-09-01", toDate: "2026-09-30" }), () => explore.reportStatus("job"), () => explore.readReportPage("job", null)],
    },
  ];
})();

describe("BLOCKED live stubs (no documented API / tenant evidence)", () => {
  it("[OPS-03] every method of every BLOCKED live stub throws BLOCKED_CAPABILITY_UNVERIFIED — nothing is simulated as success", async () => {
    for (const { adapter, calls } of cases) {
      expect(adapter.kind).toBe("live");
      expect(adapter.capabilityStatus).toBe("BLOCKED");
      expect(isBlockedCapability(adapter)).toBe(true);
      for (const call of calls) await expectBlocked(call(), adapter.integrationId);
    }
  });

  it("[OPS-03] BLOCKED stubs report themselves unhealthy so they can never count as an available route", async () => {
    for (const { adapter } of cases) expect(await adapter.health()).toEqual({ healthy: false, reasonCode: BLOCKED_CAPABILITY_UNVERIFIED });
  });

  it("[OPS-03] each stub names the prerequisites (existing PRQ ids) and the exact evidence required to unblock it", () => {
    expect(KNOWN_PRQ.size).toBeGreaterThan(40);
    for (const { adapter } of cases) {
      expect(adapter.prerequisites.length).toBeGreaterThan(0);
      expect(adapter.requiredEvidence.length).toBeGreaterThan(0);
      for (const p of [...adapter.prerequisites, ...adapter.requiredEvidence.flatMap((e) => e.prerequisites)]) expect(KNOWN_PRQ.has(p)).toBe(true);
      for (const e of adapter.requiredEvidence) expect(e.evidence.length).toBeGreaterThan(20);
    }
  });

  it("[SAFE-05] the Talkdesk stubs implement no endpoint: their source contains no invented URL, path or event name", () => {
    const src = readFileSync(resolve(here, "talkdesk-blocked.ts"), "utf8");
    const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect(urls).toEqual([]);
    expect(src).not.toMatch(/fetch\(|\/api\/v\d|\/v1\//);
    const biz = readFileSync(resolve(here, "business-systems-blocked.ts"), "utf8");
    expect(biz.match(/https?:\/\//g) ?? []).toEqual([]);
  });
});
