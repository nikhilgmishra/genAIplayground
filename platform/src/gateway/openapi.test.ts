import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertStrictJsonSchema } from "./catalog.js";
import { createAppHarness } from "./fixtures/app-harness.fixture.js";
import type { AppHarness } from "./fixtures/app-harness.fixture.js";
import { runGenerateOpenApi } from "./generate-openapi.js";
import { OPENAPI_FILE, buildOpenApiDocument, gatewayRouteSpecs, openApiFileContent } from "./openapi.js";

type Op = {
  operationId: string;
  security: unknown[];
  "x-vsp-channel": string | null;
  parameters?: { name: string; in: string }[];
  requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } };
  responses: Record<string, { content?: { "application/json": { schema: Record<string, unknown> } } }>;
};

const doc = buildOpenApiDocument() as { openapi: string; paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, unknown> } };
const ops = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })));
const silentIo = () => {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
};

describe("gateway OpenAPI 3.1 document", () => {
  let h: AppHarness;
  beforeAll(async () => {
    h = await createAppHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("[SPEC-8.openapi] the committed schemas/openapi/gateway.openapi.json matches the route definitions (--check), and drift is detected", () => {
    const { io } = silentIo();
    expect(runGenerateOpenApi(["--check"], io)).toBe(0);
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(openApiFileContent());
    const dir = mkdtempSync(join(tmpdir(), "vsp-openapi-"));
    try {
      const file = join(dir, "gateway.openapi.json");
      const missing = silentIo();
      expect(runGenerateOpenApi(["--check", "--out", file], missing.io)).toBe(1);
      expect(runGenerateOpenApi(["--out", file], silentIo().io)).toBe(0);
      expect(runGenerateOpenApi(["--check", "--out", file], silentIo().io)).toBe(0);
      writeFileSync(file, openApiFileContent().replace('"3.1.0"', '"3.0.0"'), "utf8");
      const modified = silentIo();
      expect(runGenerateOpenApi(["--check", "--out", file], modified.io)).toBe(1);
      expect(modified.lines.join("\n")).toContain("openapi.drift MODIFIED");
      expect(runGenerateOpenApi(["--out"], silentIo().io)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[SPEC-8.openapi] every documented operation is a registered route, and every route spec is documented exactly once", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(ops.length).toBe(gatewayRouteSpecs().length);
    for (const { path, method } of ops) {
      expect(h.app.hasRoute({ method: method.toUpperCase() as "GET", url: path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1") })).toBe(true);
    }
    expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(ops.length);
  });

  it("[AUTH-07][SPEC-8.service-identity] authenticated operations declare the bearer scheme and their channel; the session ref is never a URL or body field", () => {
    for (const { path, op } of ops) {
      if (op["x-vsp-channel"]) expect(op.security).toEqual([{ integrationBearer: [] }]);
      else expect(op.security).toEqual([]);
      expect(path.toLowerCase()).not.toContain("session_ref");
      expect(path).not.toMatch(/\{session/i);
      for (const p of op.parameters ?? []) {
        expect(p.in).not.toBe("query");
        if (p.name.toLowerCase().includes("session")) expect(p.in).toBe("header");
      }
      const body = JSON.stringify(op.requestBody ?? {});
      expect(body).not.toContain('"sessionRef"');
      for (const [status, r] of Object.entries(op.responses)) {
        // The bearer reference is returned ONLY by TC-01 call start to the telephony identity.
        if (op.operationId === "telephony.startCall" && status === "201") continue;
        expect(JSON.stringify(r)).not.toContain('"sessionRef"');
      }
    }
    const start = ops.find((o) => o.op.operationId === "telephony.startCall");
    expect(start?.op["x-vsp-channel"]).toBe("telephony_control");
  });

  it("[SPEC-8.tool-schema] request bodies are strict (additionalProperties:false at every level) and every schema compiles as JSON Schema 2020-12", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema({ $id: "vsp-components", $defs: doc.components.schemas });
    for (const { op } of ops) {
      const req = op.requestBody?.content["application/json"].schema;
      if (req) {
        expect(() => ajv.compile(req)).not.toThrow();
        // tools.invoke carries `arguments` validated by the pinned tool schema; MCP bodies are JSON-RPC.
        if (op.operationId !== "tools.invoke" && op.operationId !== "mcp.post") expect(() => assertStrictJsonSchema(req)).not.toThrow();
      }
      for (const r of Object.values(op.responses)) {
        const s = r.content?.["application/json"].schema;
        if (!s || "$ref" in s) continue;
        expect(() => ajv.compile(s)).not.toThrow();
      }
    }
  });
});
