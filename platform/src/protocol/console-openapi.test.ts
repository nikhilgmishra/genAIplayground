/**
 * Console API contract in the zod registry (FO-04-01): schemas/openapi/console.openapi.json is
 * generated from platform/src/console-api/schemas.ts + contract.ts, covers every endpoint with its
 * method, path parameters, roles, idempotency header and strict request/response schemas, and is
 * drift-checked. In-memory rendering plus the committed file; SYNTHETIC values only.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSOLE_ENDPOINTS, ENDPOINT_ROLES, PUBLIC_ENDPOINTS, type AuthenticatedEndpointKey, type EndpointKey } from "../console-api/contract.js";
import { CONSOLE_OPENAPI_PATH, buildConsoleOpenApi, idempotentEndpoint, renderConsoleOpenApi } from "./console-openapi.js";
import { strictnessViolations, type JsonNode } from "./registry-check.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Op = { operationId: string; security: unknown[]; "x-vsp-roles": string[]; parameters?: { name: string; in: string; required: boolean; schema: JsonNode }[]; requestBody?: { content: { "application/json": { schema: JsonNode } } }; responses: Record<string, { content?: { "application/json": { schema: JsonNode } } }> };

const doc = buildConsoleOpenApi() as { paths: Record<string, Record<string, Op>>; info: { version: string } };
const opFor = (key: EndpointKey): Op => {
  const spec = CONSOLE_ENDPOINTS[key];
  const op = doc.paths[spec.path.replace(/:([A-Za-z]+)/g, "{$1}")]?.[spec.method.toLowerCase()];
  if (!op) throw new Error(`missing operation ${key}`);
  return op;
};

describe("console OpenAPI from the zod console contract [FO-04-01]", () => {
  it("[FO-04-01] the committed console.openapi.json equals the generated document", () => {
    expect(readFileSync(join(repoRoot, CONSOLE_OPENAPI_PATH), "utf8")).toBe(renderConsoleOpenApi());
    expect(doc.info.version).toBe("console-api.v1");
  });

  it("[FO-04-01][AUTH-02] every endpoint is present once; authenticated endpoints require the staff bearer and list their roles; public ones list none", () => {
    const keys = Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[];
    const ids = new Set<string>();
    for (const key of keys) {
      const op = opFor(key);
      ids.add(op.operationId);
      if ((PUBLIC_ENDPOINTS as readonly string[]).includes(key)) {
        expect(op.security, key).toEqual([]);
        expect(op["x-vsp-roles"], key).toEqual([]);
      } else {
        expect(op.security, key).toEqual([{ staffBearer: [] }]);
        expect(op["x-vsp-roles"], key).toEqual([...ENDPOINT_ROLES[key as AuthenticatedEndpointKey]].sort());
        expect(op.responses["401"], key).toBeDefined();
        expect(op.responses["403"], key).toBeDefined();
      }
    }
    expect(ids.size).toBe(keys.length);
  });

  it("[FO-04-01][ACT-02] confirmed mutations require an Idempotency-Key with the published grammar", () => {
    for (const key of Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]) {
      const header = opFor(key).parameters?.find((p) => p.name === "Idempotency-Key");
      if (idempotentEndpoint(key)) {
        expect(header?.required, key).toBe(true);
        expect(header?.schema.pattern, key).toBe("^[A-Za-z0-9_-]{16,128}$");
      } else expect(header, key).toBeUndefined();
    }
    expect(idempotentEndpoint("killSwitches.set")).toBe(true);
    expect(idempotentEndpoint("auth.logout")).toBe(false);
    expect(idempotentEndpoint("auth.localToken")).toBe(false);
  });

  it("[FO-04-02][SPEC-6.no-phi-url] path parameters are pattern-bound opaque ids and every request/response object is strict", () => {
    const callParam = opFor("calls.get").parameters?.find((p) => p.in === "path");
    expect(callParam?.schema.pattern).toBe("^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$");
    for (const key of Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]) {
      const op = opFor(key);
      const body = op.requestBody?.content["application/json"].schema;
      if (body) expect(strictnessViolations(body), key).toEqual([]);
      const response = op.responses["200"]?.content?.["application/json"].schema;
      expect(response, key).toBeDefined();
      expect(strictnessViolations(response as JsonNode), key).toEqual([]);
    }
  });

  it("[SPEC-16.console] the generated contract has no transcript, recording or task-token field", () => {
    const text = renderConsoleOpenApi();
    expect(text).not.toMatch(/"(transcript\w*|recording(Url|Link)?|taskToken|audio)"\s*:/i);
  });
});
