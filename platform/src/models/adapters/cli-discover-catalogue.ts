/**
 * Provider catalogue discovery command (WP-08; FO-09-11, OPS-06): writes a dated snapshot of the model ids the
 * configured account can call, for the model registry (WP-09) and the release manifest to pin against.
 *
 *   pnpm --filter @vsp/platform exec tsx src/models/adapters/cli-discover-catalogue.ts --profile <profile.json> --out <dir>
 *     [--control-plane-url https://bedrock.<region>.amazonaws.com/foundation-models]   (Bedrock; emulator override)
 *     [--digest-key-file <owner-only file>]   (catalogue id digest key, >= 32 bytes: stable account-scoped digests)
 *
 * The profile is a real-model profile (real-model-profile.ts): its endpoint, reviewed credential source and egress
 * allowlist. A NOT_CONFIGURED profile makes no request (exit 3). A listing is content-free (class INTERNAL) and is not
 * a billable call, but it reaches the provider account, so it runs only with a reviewed credential. Output file:
 * `<out>/<YYYY-MM-DD>-<endpointRef>.json`. Exit codes: 0 written, 2 usage or profile error, 3 NOT_CONFIGURED, 4 failed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import { EgressGuard } from "../../privacy/egress.js";
import { egressBindingFor } from "../port/config.js";
import { ModelCallError } from "../port/errors.js";
import { bedrockControlPlaneUrl, discoverCatalogue, snapshotFileName } from "./discovery.js";
import { modelExchangeFor } from "./http-exchange.js";
import { RealModelProfile, evaluateRealModelProfile, processEnv, realModelDestination } from "./real-model-profile.js";

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(argv: readonly string[]): Promise<number> {
  const file = arg(argv, "--profile");
  const out = arg(argv, "--out");
  if (!file || !out) {
    console.error("usage: cli-discover-catalogue.ts --profile <profile.json> --out <dir> [--control-plane-url <url>]");
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(JSON.stringify({ error: "REAL_MODEL_PROFILE_UNREADABLE" }));
    return 2;
  }
  const evaluated = evaluateRealModelProfile(raw);
  const { credential, ...status } = evaluated;
  if (status.violations.length > 0) {
    console.log(JSON.stringify({ status }, null, 2));
    return 2;
  }
  if (status.status !== "CONFIGURED") {
    console.log(JSON.stringify({ status, discovered: false }, null, 2));
    return 3;
  }
  const p = RealModelProfile.parse(raw);
  const e = p.endpoint;
  const cp = arg(argv, "--control-plane-url");
  const controlPlane = e.provider === "bedrock_converse" ? new URL(cp ?? bedrockControlPlaneUrl(e.region).toString()) : null;
  const url = controlPlane ?? new URL(`${e.baseUrl.replace(/\/+$/, "")}/v1/models`);
  const routes = new Map((p.emulatorRoutes?.routes ?? []).map((r) => [r.host.toLowerCase(), { port: r.port, tls: true }] as const));
  // An emulator profile lists from the emulator only: the listing host (the Bedrock control plane included) must be
  // routed to it, or the command would reach the real provider account.
  if (realModelDestination(p) === "EMULATOR" && !routes.has(url.hostname.toLowerCase())) {
    console.log(JSON.stringify({ status: { ...status, violations: ["REAL_MODEL_EMULATOR_ROUTES_MISSING"] } }, null, 2));
    return 2;
  }
  // Without a key file, account-scoped ids are digested under a discarded random key (not comparable across snapshots).
  const keyFile = arg(argv, "--digest-key-file");
  let idDigestKey: string | undefined;
  if (keyFile) {
    try {
      idDigestKey = processEnv.readSecretFile(keyFile);
    } catch {
      console.error(JSON.stringify({ error: "MODEL_CATALOGUE_DIGEST_KEY_UNREADABLE" }));
      return 2;
    }
  }
  const transport = new ConnectorHttpTransport({
    environment: "local",
    egress: new EgressGuard(p.egress, { environment: "local" }).forModelEndpoint(egressBindingFor(e)),
    ...(routes.size > 0 ? { loopbackRoutes: routes } : {}),
    ...(p.emulatorRoutes ? { tlsCa: [readFileSync(p.emulatorRoutes.caFile, "utf8")] } : {}),
  });
  const exchange = modelExchangeFor(transport, { allowedHosts: [url.hostname.toLowerCase()], addressClass: e.network });
  try {
    const snapshot = await discoverCatalogue(e, { exchange, credential, now: () => new Date(), ...(controlPlane ? { controlPlaneUrl: controlPlane } : {}), ...(idDigestKey !== undefined ? { idDigestKey } : {}) });
    mkdirSync(out, { recursive: true });
    const target = join(out, snapshotFileName(snapshot));
    writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(JSON.stringify({ written: target, models: snapshot.models.length, pinnedModelListed: snapshot.pinnedModelListed, modelsDigest: snapshot.modelsDigest }, null, 2));
    return 0;
  } catch (err) {
    console.error(JSON.stringify({ error: err instanceof ModelCallError ? err.reasonCode : "MODEL_CATALOGUE_FAILED" }));
    return 4;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(4),
);
