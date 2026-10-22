import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApiApp } from "./app.js";
import type { ApiDeps } from "./http.js";
import { SniContexts } from "./listeners.js";
import { OPENAPI_PATH, openApiDocument, renderOpenApi } from "./openapi.js";

/** Route registration touches no dependency: the handlers are never called here. */
const inertDeps = {} as unknown as ApiDeps;

async function registeredRoutes(): Promise<Set<string>> {
  const routes = new Set<string>();
  const { app } = buildApiApp(inertDeps, new SniContexts(), (method, url) => routes.add(`${method} ${url.replace(/:([A-Za-z]+)/g, "{$1}")}`));
  await app.ready();
  await app.close();
  return routes;
}

describe("reference business API OpenAPI document [FO-06-74]", () => {
  it("[FO-06-74] the committed OpenAPI document is the generated one (regenerate with: node --import tsx src/openapi.ts --write)", () => {
    expect(readFileSync(OPENAPI_PATH, "utf8")).toBe(renderOpenApi());
  });

  it("[FO-06-74] every registered route is documented and every documented operation is served (no undocumented or phantom endpoint)", async () => {
    const served = await registeredRoutes();
    const doc = openApiDocument() as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    expect([...served].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !served.has(r)).sort()).toEqual([]);
    expect(served.size).toBeGreaterThan(35);
  });

  it("[FO-06-74][FO-06-75] every change is a PUT keyed by a client-chosen request id with a documented 409/422/500 contract; the legacy product's create is the declared non-idempotent POST behind a keyed reservation; absence has a fence", () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { parameters?: { name: string }[]; responses: Record<string, unknown>; summary?: string }>> };
    const writes = Object.entries(doc.paths).flatMap(([p, ops]) => Object.entries(ops).filter(([m]) => m !== "get").map(([m, op]) => ({ path: p, method: m, op })));
    const puts = writes.filter((x) => x.method === "put");
    for (const w of puts.filter((x) => x.path !== "/api/v1/legacy/references/{externalRef}")) {
      expect(w.path, w.path).toMatch(/\/\{requestId\}$/);
      expect(Object.keys(w.op.responses), w.path).toEqual(expect.arrayContaining(["200", "409", "422", "500"]));
    }
    // The legacy reservation is keyed by the client's reference: the first dispatch wins, later ones are told so.
    expect(puts.map((x) => x.path)).toContain("/api/v1/legacy/references/{externalRef}");
    expect(doc.paths["/api/v1/legacy/references/{externalRef}"]?.put?.summary).toMatch(/first reservation wins/);
    const posts = writes.filter((x) => x.method === "post").map((x) => x.path).sort();
    expect(posts).toEqual([
      "/api/v1/change-requests/{requestId}/completion",
      "/api/v1/change-requests/{requestId}/fence",
      "/api/v1/legacy/appointments/{externalRef}",
      "/api/v1/legacy/references/{externalRef}/fence",
      "/api/v1/legacy/references/{externalRef}/release",
      "/oauth/token",
    ]);
    expect(doc.paths["/api/v1/legacy/appointments/{externalRef}"]?.post?.summary).toMatch(/NOT idempotent/);
    // A 404 is never proof of absence; the fences are, and only after the deadline.
    expect(doc.paths["/api/v1/change-requests/{requestId}"]?.get?.summary).toMatch(/never proof of absence/);
    expect(doc.paths["/api/v1/change-requests/{requestId}/fence"]?.post?.summary).toMatch(/notAfter has passed/);
    expect(doc.paths["/api/v1/legacy/references/{externalRef}/fence"]?.post?.summary).toMatch(/notAfter has passed/);
  });

  it("[FO-06-76] the documented objects carry no coverage, waiver, refund, payout or clinical-suitability field, and restricted fields are marked prohibited", () => {
    const doc = openApiDocument() as { components: { schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }> } };
    const fields = Object.entries(doc.components.schemas).flatMap(([name, s]) => Object.keys(s.properties ?? {}).map((f) => `${name}.${f}`));
    expect(fields.filter((f) => /coverageDecision|waiver|refund|payout|suitab|guarantee|eligibleFor/i.test(f))).toEqual([]);
    const prohibited = Object.entries(doc.components.schemas).flatMap(([name, s]) =>
      Object.entries(s.properties ?? {})
        .filter(([, p]) => p["x-vsp-prohibited"] === true)
        .map(([f]) => `${name}.${f}`),
    );
    expect(prohibited.sort()).toEqual(["Appointment.visitReason", "Claim.diagnosisCodes", "Eligibility.memberReference", "Payment.cardLast4", "Referral.clinicalSummary", "Remittance.bankAccountLast4"]);
  });
});
