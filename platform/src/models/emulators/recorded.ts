/**
 * Recorded-response model provider for CI (WP-08; FO-19-09, FO-09-36): a ModelHttpExchange that replays recorded wire
 * responses (status, headers, body bytes) so the PRODUCTION adapters and parsers run over real protocol bytes with no
 * network at all. `RecordingModelExchange` wraps a live exchange (the emulator in CI, or a credentialed qualification
 * run against a provider with SYNTHETIC prompts only) and captures a cassette; `RecordedModelExchange` serves it.
 *
 * A request is matched by its method, path and the SHA-256 of its body; headers (credentials, signatures, dates) are
 * never recorded. A request with no recording fails closed (`MODEL_RECORDING_MISSING`), so a changed request shape is
 * detected instead of silently answered. Cassettes hold synthetic content only; recording a request whose data class
 * is not PUBLIC or INTERNAL is refused (DATA-01). Both exist for local and ci only: constructing either in any other
 * environment is refused (MODEL_RECORDING_OUTSIDE_LOCAL, OPS-04), so a composition root cannot answer real calls
 * from a cassette or record a deployed environment's traffic.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelHttpExchange, ModelHttpRequest, ModelHttpResponse } from "../adapters/http-exchange.js";
import type { Environment } from "../../protocol/common.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import { ModelCallError } from "../port/errors.js";

export const CASSETTE_SCHEMA_VERSION = "model-cassette.v1";

const Interaction = z.strictObject({
  method: z.enum(["GET", "POST"]),
  path: z.string().min(1).max(512),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  response: z.strictObject({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    /** Body bytes, base64 (binary event-stream frames are recorded exactly). */
    bodyBase64: z.string(),
  }),
});

export const ModelCassette = z.strictObject({
  schemaVersion: z.literal(CASSETTE_SCHEMA_VERSION),
  provider: z.enum(["openai_responses", "bedrock_converse", "vllm_openai_compatible"]),
  /** Where the bytes came from: the protocol emulator, or a provider during a qualification run. */
  source: z.enum(["emulator", "provider"]),
  recordedOn: z.iso.date(),
  interactions: z.array(Interaction).max(256),
});
export type ModelCassette = z.infer<typeof ModelCassette>;

const RECORDED_HEADERS = ["content-type", "retry-after", "retry-after-ms", "x-amzn-errortype"];

function bodyDigest(body: ModelHttpRequest["body"]): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** Cassettes are local/ci test infrastructure (OPS-04). */
function offlineOnly(environment: Environment): void {
  if (environment !== "local" && environment !== "ci") throw new ConfigurationRejectedError(["MODEL_RECORDING_OUTSIDE_LOCAL"]);
}

async function* once(body: Buffer): AsyncIterable<Buffer> {
  if (body.length > 0) yield body;
}

/** Replays a cassette; a request without a recording is refused before any byte (and nothing else is ever sent). */
export class RecordedModelExchange implements ModelHttpExchange {
  readonly incremental = false;
  private readonly cassette: ModelCassette;
  /** Requests answered from the cassette (for test assertions). */
  replayed = 0;

  constructor(cassette: unknown, opts: { environment: Environment }) {
    offlineOnly(opts.environment);
    this.cassette = ModelCassette.parse(cassette);
  }

  async send(req: ModelHttpRequest): Promise<ModelHttpResponse> {
    if (req.signal.aborted) throw new ModelCallError({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", errorClass: "PERMANENT", notStarted: true });
    const digest = bodyDigest(req.body);
    const hit = this.cassette.interactions.find((i) => i.method === req.method && i.path === `${req.url.pathname}${req.url.search}` && i.bodySha256 === digest);
    if (!hit) throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_RECORDING_MISSING", errorClass: "PERMANENT", notStarted: true });
    this.replayed += 1;
    return { status: hit.response.status, headers: { ...hit.response.headers }, body: once(Buffer.from(hit.response.bodyBase64, "base64")) };
  }
}

/** Wraps a live exchange and records each synthetic exchange into a cassette. */
export class RecordingModelExchange implements ModelHttpExchange {
  readonly interactions: ModelCassette["interactions"] = [];

  constructor(
    private readonly inner: ModelHttpExchange,
    opts: { environment: Environment },
  ) {
    offlineOnly(opts.environment);
  }

  get incremental(): boolean {
    return this.inner.incremental;
  }

  async send(req: ModelHttpRequest): Promise<ModelHttpResponse> {
    if (req.dataClass !== "PUBLIC" && req.dataClass !== "INTERNAL") {
      throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_RECORDING_SYNTHETIC_ONLY", errorClass: "PERMANENT", notStarted: true });
    }
    const res = await this.inner.send(req);
    const parts: Buffer[] = [];
    for await (const c of res.body) parts.push(c);
    const body = Buffer.concat(parts);
    const headers: Record<string, string> = {};
    for (const h of RECORDED_HEADERS) if (res.headers[h] !== undefined) headers[h] = res.headers[h] as string;
    this.interactions.push({ method: req.method, path: `${req.url.pathname}${req.url.search}`, bodySha256: bodyDigest(req.body), response: { status: res.status, headers, bodyBase64: body.toString("base64") } });
    return { status: res.status, headers: res.headers, body: once(body) };
  }

  cassette(provider: ModelCassette["provider"], source: ModelCassette["source"], recordedOn: string): ModelCassette {
    return ModelCassette.parse({ schemaVersion: CASSETTE_SCHEMA_VERSION, provider, source, recordedOn, interactions: this.interactions });
  }
}
