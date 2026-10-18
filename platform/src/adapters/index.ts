/**
 * Adapters module barrel: ports, LOCAL fixtures (SYNTHETIC data, fault
 * injection), documented live adapters and BLOCKED live stubs, the adapter
 * registry and the machine-readable integration inventory.
 */
export * from "./ports.js";
export * from "./errors.js";
export * from "./registry.js";
export * from "./integration-inventory.js";
export * from "./support-records-schema.js";
export * from "./support-record-cache.js";

export * from "./local/synthetic-store.js";
export * from "./local/faults.js";
export * from "./local/idempotency.js";
export * from "./local/scheduling-fixture.js";
export * from "./local/billing-fixture.js";
export * from "./local/claims-fixture.js";
export * from "./local/provider-fixture.js";
export * from "./local/relationship-directory-fixture.js";
export * from "./local/support-records-fixture.js";
export * from "./local/telephony-fixture.js";
export * from "./local/fixture-set.js";
// Identity-owned fixtures and verifier (platform/src/adapters/local|live, identity module).
export * from "./local/identity-directory.js";
export * from "./local/oidc-fixture.js";
export * from "./local/notification-fixture.js";
export * from "./live/oidc-verifier.js";

export * from "./live/blocked-base.js";
export * from "./live/business-systems-blocked.js";
export * from "./live/talkdesk-blocked.js";
export * from "./live/salesforce-rest-support-records.js";
export * from "./live/blocked-set.js";
