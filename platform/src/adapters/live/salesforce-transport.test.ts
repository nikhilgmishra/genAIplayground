/**
 * Salesforce REST adapter over the egress-classified transport (WP-07; FO-14-53, DATA-01, ACT-03). The
 * transport here is a UNIT FAKE that records the requests the adapter hands it and answers with the documented
 * Salesforce responses; the real transport (TLS, allowlist, address class, EgressGuard) is the WP-06
 * ConnectorHttpTransport, exercised in platform/test/integration.
 */
import { describe, expect, it } from "vitest";
import { TransportError } from "../../connectors/http/transport.js";
import type { TransportRequest, TransportResponse } from "../../connectors/http/transport.js";
import { FakeClock } from "../../shared/clock.js";
import { AccessDeniedError, PlatformError } from "../../shared/errors.js";
import { SALESFORCE_SCHEMA_OWNER, SalesforceRestSupportRecords } from "./salesforce-rest-support-records.js";
import type { SalesforceFieldMapping, SalesforceTransport } from "./salesforce-rest-support-records.js";

const ORIGIN = "https://synthetic-org.my.salesforce.com";
const names = (prefix: string, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, `${prefix}_${k}__c`]));
const MAPPING: SalesforceFieldMapping = {
  interaction: { sobject: "Synth_Interaction__c", externalIdField: "Synth_Interaction_Ext__c", fields: names("Synth", ["callId", "language", "consentStatus", "startedAt"]) as SalesforceFieldMapping["interaction"]["fields"] },
  case: {
    sobject: "Case",
    externalIdField: "Synth_Issue_Ext__c",
    statusField: "Status",
    fields: names("SynthCase", ["subjectRef", "audience", "issueCategory", "disposition", "ownerQueue", "priority", "summary", "attempted", "commitReceiptIds", "sourceCallIds", "language", "consentStatus", "nextStep", "deadline", "versions", "restricted", "supportReference"]) as SalesforceFieldMapping["case"]["fields"],
  },
  link: { sobject: "Synth_Link__c", externalIdField: "Synth_Link_Ext__c", interactionRelationship: "Synth_Interaction__r", caseRelationship: "Synth_Case__r" },
};

class RecordingTransportFixture implements SalesforceTransport {
  readonly requests: TransportRequest[] = [];
  refuse: Error | null = null;
  async send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    if (this.refuse) throw this.refuse;
    const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
    if (req.url.pathname === "/services/oauth2/token") return json(200, { access_token: "tok_synthAccessToken0001", instance_url: ORIGIN, token_type: "Bearer" });
    return json(201, { id: "a0B000000000001AAA", success: true, created: true });
  }
}

const adapter = (transport: SalesforceTransport) =>
  new SalesforceRestSupportRecords(
    { myDomainUrl: ORIGIN, apiVersion: "v62.0", timeoutMs: 2_000, schema: { status: "PROVIDED", providedBy: SALESFORCE_SCHEMA_OWNER, evidenceRef: "evidence://synthetic-schema-review", approvalId: "apr_synthSchemaApproval01" }, mapping: MAPPING },
    { credentials: async () => ({ clientId: "cid_synthConnectedApp01", clientSecret: "sec_synthNotARealSecret01" }), transport, clock: new FakeClock("2026-10-21T10:00:00.000Z") },
  );

const fields = { callId: "cal_synthCallForSalesforce01", language: "en", consentStatus: "GRANTED", startedAt: "2026-10-21T09:59:00.000Z" };

describe("Salesforce adapter over the egress transport [FO-14-53]", () => {
  it("[FO-14-53][ACT-03] positive: token and upsert go through the transport with the org host only, the content-free data class and the write marked as a side effect", async () => {
    const t = new RecordingTransportFixture();
    const r = await adapter(t).upsertInteraction("int_synthInteractionExt0001", fields);
    expect(r).toEqual({ recordId: "a0B000000000001AAA", created: true });
    expect(t.requests.map((q) => [q.method, q.url.pathname, q.sideEffect, q.policy.allowedHosts, q.policy.dataClass, q.dependency])).toEqual([
      ["POST", "/services/oauth2/token", false, ["synthetic-org.my.salesforce.com"], "INTERNAL", "salesforce"],
      ["PATCH", "/services/data/v62.0/sobjects/Synth_Interaction__c/Synth_Interaction_Ext__c/int_synthInteractionExt0001", true, ["synthetic-org.my.salesforce.com"], "INTERNAL", "salesforce"],
    ]);
    expect(t.requests[1]?.headers.authorization).toBe("Bearer tok_synthAccessToken0001");
  });

  it("[DATA-01] adversarial: an egress refusal is passed on as the refusal (nothing sent), never retried as an outage", async () => {
    const t = new RecordingTransportFixture();
    t.refuse = new AccessDeniedError("EGRESS_DESTINATION_UNKNOWN");
    const err = await adapter(t).upsertInteraction("int_synthInteractionExt0001", fields).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).reasonCode).not.toBe("SALESFORCE_UPSERT_CONFIRMED");
    expect(t.requests).toHaveLength(1);
  });

  it("[ACT-03] failure: a write lost after it may have been sent is UNKNOWN (reconcile by external id), a refusal before I/O is NOT_STARTED", async () => {
    const t = new RecordingTransportFixture();
    const a = adapter(t);
    await a.upsertInteraction("int_synthInteractionExt0001", fields);
    t.refuse = new TransportError("CONNECTOR_TIMEOUT", "UNKNOWN", false, "SENT", true);
    expect(await a.upsertInteraction("int_synthInteractionExt0002", fields).then(() => null, (e: unknown) => e)).toMatchObject({ outcome: "UNKNOWN" });
    t.refuse = new TransportError("CONNECTOR_ADDRESS_NOT_ALLOWED", "NOT_STARTED", false, "PRE_IO", false);
    expect(await a.upsertInteraction("int_synthInteractionExt0003", fields).then(() => null, (e: unknown) => e)).toMatchObject({ outcome: "NOT_STARTED" });
  });
});
