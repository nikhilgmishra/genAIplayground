/**
 * Provider catalogue discovery (WP-08; FO-09-11, OPS-06): the model ids an account can actually call, captured as a
 * dated snapshot that the model registry (WP-09) and the release manifest pin against. Release pins come from these
 * snapshots, never from documentation or memory.
 *
 *  - OpenAI: `GET /v1/models` (bearer key);
 *  - vLLM: `GET /v1/models` (served model names and `max_model_len`);
 *  - Bedrock: `GET /foundation-models` on the control plane (`bedrock.<region>.amazonaws.com`, SigV4 service
 *    `bedrock`), with lifecycle status, modalities and streaming support.
 *
 * Every request goes through the same egress-classified transport as inference (class INTERNAL: a listing carries no
 * conversation data). The snapshot holds ids and capabilities only, plus the SHA-256 of the sorted id list.
 *
 * The snapshot is kept with release evidence, so it holds no account identifiers (security review D11): an `ownedBy`
 * that names an account (`org-...`, `user-...`, `proj_...`, or any value with a run of digits) becomes
 * `ACCOUNT_SCOPED`, and an account-scoped model id (a fine-tuned `ft:` id, which carries the organisation name, or an
 * ARN with a 12-digit account id) is replaced by `account-scoped:<HMAC-SHA256 prefix>`. The digest is KEYED (security
 * review r3: an unkeyed digest of an ARN lets anyone enumerate the 1e12 account ids offline): with the composition
 * root's catalogue digest key (`idDigestKey`, at least 32 bytes) the same id gives the same digest in every snapshot
 * (`accountScopedIdDigest: "KEYED"`); without one a fresh random key is drawn for this snapshot and never stored
 * (`"EPHEMERAL"`), so the digests cannot be reversed, nor compared across snapshots. Public catalogue ids are kept as
 * they are. `pinnedModelListed` is computed on the provider's ids before redaction; `modelsDigest` over the
 * snapshot's own (redacted) ids, so the snapshot verifies on its own.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { ModelEndpointConfig } from "../port/config.js";
import type { ModelCredential } from "../port/credentials.js";
import { ModelCallError, errorClassForStatus } from "../port/errors.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { parseJson, readBody } from "./http-exchange.js";
import { signRequest } from "./sigv4.js";
import { ValidationError } from "../../shared/errors.js";

export const CATALOGUE_SNAPSHOT_SCHEMA_VERSION = "model-catalogue-snapshot.v1";

export interface CatalogueModel {
  id: string;
  ownedBy: string | null;
  lifecycle: string | null;
  streaming: boolean | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  maxModelLen: number | null;
}

export interface CatalogueSnapshot {
  schemaVersion: typeof CATALOGUE_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  provider: ModelEndpointConfig["provider"];
  endpointRef: string;
  region: string;
  /** The request that produced the listing (method and path, no host or credential). */
  source: string;
  models: CatalogueModel[];
  /** SHA-256 over the sorted model ids (what a release manifest binds). */
  modelsDigest: string;
  /** True when the endpoint's pinned model id is in the listing. */
  pinnedModelListed: boolean;
  /** Listed models whose id was account-scoped and is therefore recorded as a digest only. */
  accountScopedModels: number;
  /** How account-scoped ids were digested: with the configured key (stable across snapshots) or a discarded one. */
  accountScopedIdDigest: "KEYED" | "EPHEMERAL";
}

/** Owner values that name an account rather than a publisher. */
const ACCOUNT_OWNER = /^(?:org|user|proj|acct|account)[-_]|\d{4,}/i;
/** Model ids bound to one account: fine-tuned ids (`ft:<base>:<org>:...`) and ARNs that carry a 12-digit account id. */
const ACCOUNT_ID = /^ft:|^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/;

const redactOwner = (owner: string | null): string | null => (owner !== null && ACCOUNT_OWNER.test(owner) ? "ACCOUNT_SCOPED" : owner);
/** Smallest accepted catalogue digest key (bytes). */
export const CATALOGUE_ID_DIGEST_KEY_MIN_BYTES = 32;
const redactId = (id: string, key: Buffer): string => (ACCOUNT_ID.test(id) ? `account-scoped:${createHmac("sha256", key).update(`model-id\0${id}`).digest("hex").slice(0, 24)}` : id);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const str = (v: unknown): string | null => (typeof v === "string" && v.length <= 200 ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 16) : null);

/** The Bedrock control-plane URL for a region (overridable for a local/ci emulator). */
export function bedrockControlPlaneUrl(region: string): URL {
  return new URL(`https://bedrock.${region}.amazonaws.com/foundation-models?byOutputModality=TEXT`);
}

export interface DiscoveryDeps {
  exchange: ModelHttpExchange;
  credential: ModelCredential | null;
  now: () => Date;
  /** Bedrock only: the control-plane listing URL (default `bedrockControlPlaneUrl(region)`). */
  controlPlaneUrl?: URL;
  timeoutMs?: number;
  /** Keyed digest of account-scoped ids (at least 32 bytes, from the composition root); absent: an ephemeral key. */
  idDigestKey?: string | Buffer;
}

export async function discoverCatalogue(e: ModelEndpointConfig, deps: DiscoveryDeps): Promise<CatalogueSnapshot> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  if (deps.idDigestKey !== undefined && Buffer.byteLength(deps.idDigestKey) < CATALOGUE_ID_DIGEST_KEY_MIN_BYTES) throw new ValidationError("MODEL_CATALOGUE_DIGEST_KEY_TOO_SHORT");
  const idKey = deps.idDigestKey !== undefined ? Buffer.from(deps.idDigestKey) : randomBytes(32);
  const signal = new AbortController().signal;
  let url: URL;
  let headers: Record<string, string> = { accept: "application/json" };
  if (e.provider === "bedrock_converse") {
    if (deps.credential?.kind !== "aws") throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_NOT_CONFIGURED", errorClass: "PERMANENT", notStarted: true });
    url = deps.controlPlaneUrl ?? bedrockControlPlaneUrl(e.region);
    const creds = await deps.credential.credentials();
    headers = signRequest({ method: "GET", url, headers, body: null, region: e.region, service: "bedrock", credentials: creds, now: deps.now() });
  } else {
    url = new URL(`${e.baseUrl.replace(/\/+$/, "")}/v1/models`);
    if (deps.credential?.kind === "bearer") headers.authorization = `Bearer ${await deps.credential.token()}`;
    else if (e.provider === "openai_responses") throw new ModelCallError({ kind: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_NOT_CONFIGURED", errorClass: "PERMANENT", notStarted: true });
  }
  const res = await deps.exchange.send({ method: "GET", url, headers, body: null, dataClass: "INTERNAL", timeoutMs, signal });
  const body = parseJson(await readBody(res.body, 4 * 1024 * 1024));
  if (res.status !== 200) {
    const cls = errorClassForStatus(res.status);
    throw new ModelCallError({ kind: res.status === 401 || res.status === 403 ? "UNAVAILABLE" : "FAILED", reasonCode: res.status === 401 || res.status === 403 ? "MODEL_AUTH_REJECTED" : "MODEL_CATALOGUE_FAILED", errorClass: cls, httpStatus: res.status });
  }
  const models: CatalogueModel[] = [];
  const o = body as Record<string, unknown> | undefined;
  if (e.provider === "bedrock_converse") {
    for (const m of Array.isArray(o?.modelSummaries) ? o.modelSummaries : []) {
      const r = m as Record<string, unknown>;
      const id = str(r.modelId);
      if (!id || !ID.test(id)) continue;
      const lc = r.modelLifecycle as Record<string, unknown> | undefined;
      models.push({ id, ownedBy: str(r.providerName), lifecycle: str(lc?.status), streaming: typeof r.responseStreamingSupported === "boolean" ? r.responseStreamingSupported : null, inputModalities: strs(r.inputModalities), outputModalities: strs(r.outputModalities), maxModelLen: null });
    }
  } else {
    for (const m of Array.isArray(o?.data) ? o.data : []) {
      const r = m as Record<string, unknown>;
      const id = str(r.id);
      if (!id || !ID.test(id)) continue;
      models.push({ id, ownedBy: str(r.owned_by), lifecycle: null, streaming: null, inputModalities: null, outputModalities: null, maxModelLen: typeof r.max_model_len === "number" ? r.max_model_len : null });
    }
  }
  const pinnedModelListed = models.some((m) => m.id === e.model.id);
  let accountScopedModels = 0;
  for (const m of models) {
    const id = redactId(m.id, idKey);
    if (id !== m.id) accountScopedModels += 1;
    m.id = id;
    m.ownedBy = redactOwner(m.ownedBy);
  }
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = models.map((m) => m.id);
  return {
    schemaVersion: CATALOGUE_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: deps.now().toISOString(),
    provider: e.provider,
    endpointRef: e.endpointRef,
    region: e.region,
    source: `GET ${url.pathname}`,
    models,
    modelsDigest: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    pinnedModelListed,
    accountScopedModels,
    accountScopedIdDigest: deps.idDigestKey !== undefined ? "KEYED" : "EPHEMERAL",
  };
}

/** File name of a snapshot: `<YYYY-MM-DD>-<endpointRef>.json`. */
export function snapshotFileName(s: CatalogueSnapshot): string {
  return `${s.capturedAt.slice(0, 10)}-${s.endpointRef}.json`;
}
