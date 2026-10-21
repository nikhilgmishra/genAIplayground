/**
 * CLI: writes schemas/openapi/gateway.openapi.json from the gateway route
 * definitions and, from that document, the generated gateway client
 * (platform/src/gateway-client/operations.generated.ts, WP-07); `--check` exits 1
 * when either committed file differs (CI drift gate).
 *   npx tsx src/gateway/generate-openapi.ts [--check] [--out <file>]
 * `--out` writes the document only (the client always follows the committed path).
 *
 * Client generator (FO-03-11 rule 1): the operation table (method, path template, path parameters, declared
 * headers, body requirement, declared statuses, channel) and TypeScript types of every JSON request and
 * response body. The untrusted-output group (models, harness, media) and the HTTP-only clients (console,
 * companion) may import the gateway client and nothing else of the gateway: the generated file is data and
 * types only, derived from the same RouteDef specs Fastify registers, so a client cannot call a route or send
 * a field the gateway does not declare.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPENAPI_FILE, buildOpenApiDocument, openApiFileContent } from "./openapi.js";

type Json = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const prop = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

/** TypeScript type of a JSON Schema (the subset the gateway's zod schemas produce). */
export function tsTypeOf(schema: unknown, depth = 0): string {
  if (depth > 24) return "unknown";
  if (schema === true || schema === undefined || schema === null) return "unknown";
  if (schema === false) return "never";
  const s = schema as Json;
  if (typeof s.$ref === "string") {
    const m = /^#\/components\/schemas\/([A-Za-z][A-Za-z0-9]*)$/.exec(s.$ref);
    return m?.[1] ?? "unknown";
  }
  if (Object.hasOwn(s, "const")) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.length === 0 ? "never" : s.enum.map((v) => JSON.stringify(v)).join(" | ");
  for (const k of ["anyOf", "oneOf"] as const) {
    const alts = s[k];
    if (Array.isArray(alts) && alts.length > 0) return [...new Set(alts.map((a) => `(${tsTypeOf(a, depth + 1)})`))].join(" | ");
  }
  if (Array.isArray(s.allOf) && s.allOf.length > 0) return s.allOf.map((a) => `(${tsTypeOf(a, depth + 1)})`).join(" & ");
  const type = s.type;
  if (Array.isArray(type)) return type.map((t) => tsTypeOf({ ...s, type: t }, depth + 1)).join(" | ");
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsTypeOf(s.items, depth + 1)}>`;
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const keys = Object.keys(props);
      const extra = s.additionalProperties;
      if (keys.length === 0) {
        if (extra === false) return "Record<string, never>";
        return `Record<string, ${extra && extra !== true ? tsTypeOf(extra, depth + 1) : "unknown"}>`;
      }
      const fields = keys.map((k) => `${prop(k)}${required.has(k) ? "" : "?"}: ${tsTypeOf(props[k], depth + 1)}`);
      const index = extra && extra !== false ? [`[key: string]: ${extra === true ? "unknown" : `${tsTypeOf(extra, depth + 1)} | undefined`}`] : [];
      return `{ ${[...fields, ...index].join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

interface OperationEntry {
  operationId: string;
  method: string;
  path: string;
  pathParams: string[];
  headers: { name: string; required: boolean }[];
  body: "required" | "optional" | "none";
  bodyType: string;
  statuses: { status: number; type: string }[];
  channel: string | null;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function jsonSchemaOfContent(content: unknown): unknown {
  const c = (content ?? {}) as Record<string, { schema?: unknown }>;
  return c["application/json"]?.schema;
}

export function gatewayOperations(doc: Json): OperationEntry[] {
  const out: OperationEntry[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const path of Object.keys(paths).sort()) {
    for (const method of METHODS) {
      const op = paths[path]?.[method];
      if (!op) continue;
      const operationId = String(op.operationId ?? "");
      if (!/^[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(operationId)) throw new Error(`CLIENT_CODEGEN_OPERATION_ID_INVALID:${operationId}`);
      const params = (Array.isArray(op.parameters) ? op.parameters : []) as { name: string; in: string; required?: boolean }[];
      const pathParams = [...path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1] as string);
      const rb = op.requestBody as { required?: boolean; content?: unknown } | undefined;
      const statuses = Object.entries((op.responses ?? {}) as Record<string, { content?: unknown }>)
        .map(([code, r]) => ({ status: Number(code), type: tsTypeOf(jsonSchemaOfContent(r.content)) }))
        .filter((r) => Number.isInteger(r.status))
        .sort((a, b) => a.status - b.status);
      out.push({
        operationId,
        method: method.toUpperCase(),
        path,
        pathParams,
        headers: params.filter((p) => p.in === "header").map((p) => ({ name: p.name.toLowerCase(), required: p.required === true })),
        body: rb ? (rb.required ? "required" : "optional") : "none",
        bodyType: rb ? tsTypeOf(jsonSchemaOfContent(rb.content)) : "never",
        statuses,
        channel: typeof op["x-vsp-channel"] === "string" ? (op["x-vsp-channel"] as string) : null,
      });
    }
  }
  return out;
}

/** The generated module text (deterministic: sorted paths, fixed method order). */
export function gatewayClientSource(doc: Json, openApiText: string): string {
  const ops = gatewayOperations(doc);
  const schemas = ((doc.components as Json | undefined)?.schemas ?? {}) as Record<string, unknown>;
  const digest = createHash("sha256").update(openApiText, "utf8").digest("hex");
  const info = (doc.info ?? {}) as { version?: unknown };
  const lines: string[] = [
    "/**",
    " * GENERATED by platform/src/gateway/generate-openapi.ts from schemas/openapi/gateway.openapi.json. Do not edit:",
    " * run `pnpm --filter @vsp/platform openapi:gen` (the openapi:check drift gate fails on any difference).",
    " */",
    "",
    `export const GATEWAY_API_VERSION = ${JSON.stringify(String(info.version ?? ""))};`,
    "/** sha256 of the OpenAPI document this module was generated from. */",
    `export const GATEWAY_CONTRACT_SHA256 = ${JSON.stringify(digest)};`,
    "",
  ];
  for (const name of Object.keys(schemas).sort()) lines.push(`export type ${name} = ${tsTypeOf(schemas[name])};`, "");
  lines.push(
    "export interface GatewayOperationSpec {",
    "  readonly method: \"GET\" | \"POST\" | \"PUT\" | \"PATCH\" | \"DELETE\";",
    "  readonly path: string;",
    "  readonly pathParams: readonly string[];",
    "  readonly headers: readonly { readonly name: string; readonly required: boolean }[];",
    "  readonly body: \"required\" | \"optional\" | \"none\";",
    "  readonly statuses: readonly number[];",
    "  readonly channel: string | null;",
    "}",
    "",
    "export const GATEWAY_OPERATIONS = {",
  );
  for (const o of ops) {
    lines.push(
      `  ${JSON.stringify(o.operationId)}: { method: ${JSON.stringify(o.method)}, path: ${JSON.stringify(o.path)}, pathParams: ${JSON.stringify(o.pathParams)}, headers: ${JSON.stringify(o.headers)}, body: ${JSON.stringify(o.body)}, statuses: ${JSON.stringify(o.statuses.map((s) => s.status))}, channel: ${JSON.stringify(o.channel)} },`,
    );
  }
  lines.push("} as const satisfies Record<string, GatewayOperationSpec>;", "", "export type GatewayOperationId = keyof typeof GATEWAY_OPERATIONS;", "", "export interface GatewayRequestBodies {");
  for (const o of ops) lines.push(`  ${JSON.stringify(o.operationId)}: ${o.bodyType};`);
  lines.push("}", "", "export interface GatewayResponseBodies {");
  for (const o of ops) lines.push(`  ${JSON.stringify(o.operationId)}: { ${o.statuses.map((s) => `${s.status}: ${s.type}`).join("; ")} };`);
  lines.push("}", "");
  return lines.join("\n");
}

/** The generated gateway client module. */
export const GATEWAY_CLIENT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../gateway-client/operations.generated.ts");

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const stdio: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };

export function runGenerateOpenApi(argv: readonly string[], io: CliIo = stdio): number {
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && (outArg === undefined || outArg.startsWith("--"))) {
    io.err("openapi.usage: --out requires a file path");
    return 2;
  }
  const file = outArg ? resolve(outArg) : OPENAPI_FILE;
  const doc = buildOpenApiDocument();
  const content = openApiFileContent(doc);
  const client = gatewayClientSource(doc, content);
  if (check) {
    for (const [f, text, label] of [
      [file, content, "openapi"],
      [GATEWAY_CLIENT_FILE, client, "gateway-client"],
    ] as const) {
      if (!existsSync(f)) {
        io.err(`openapi.drift MISSING ${label}: run \`npx tsx src/gateway/generate-openapi.ts\` and commit the result`);
        return 1;
      }
      if (readFileSync(f, "utf8") !== text) {
        io.err(`openapi.drift MODIFIED ${label}: run \`npx tsx src/gateway/generate-openapi.ts\` and commit the result`);
        return 1;
      }
    }
    io.out("openapi.check ok");
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  if (!outArg) writeFileSync(GATEWAY_CLIENT_FILE, client, "utf8");
  io.out("openapi.write ok");
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runGenerateOpenApi(process.argv.slice(2));
}
