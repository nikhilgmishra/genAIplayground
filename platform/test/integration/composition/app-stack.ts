/**
 * Provisions the sandbox-profile configuration that deploy/local/services/app.compose.yaml runs the live units
 * with (WP-07). Run on the host after `make up PROFILE=core`:
 *
 *   pnpm --filter @vsp/platform exec tsx test/integration/composition/app-stack.ts
 *   make up PROFILE=core,app
 *
 * It creates, on the running emulators, the substrate one sandbox deployment needs (a PostgreSQL 16 database
 * with every migration, the DynamoDB session and route-audit journal tables, the SQS outbox queue, the KMS
 * assertion and approval-trust keys, the Secrets Manager database login and peppers) exactly as the Layer-2
 * composition suite does (support.ts provisionSandbox), and writes the configuration to
 * <state dir>/app/config/sandbox.json, which the app services mount over the committed placeholder
 * platform/config/sandbox.json. Every value is SYNTHETIC and lives only in the local emulators and the
 * generated state directory (never in the repository). Without this step the app services start against the
 * committed placeholder configuration and are refused by the guard, as a deployment would be.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { discoverServices, isReady } from "../_harness/discovery.js";
import type { DiscoveredService } from "../_harness/discovery.js";
import { stateDir } from "../_harness/env.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { SUBSTRATE, provisionSandbox } from "./support.js";

/** The subset of Layer2Context the provisioning uses, over the discovered compose services. */
function contextOf(services: Record<string, DiscoveredService>): Layer2Context {
  const port = (name: string, containerPort: number): number => {
    const p = services[name]?.ports[`${containerPort}/tcp`];
    if (!p) throw new Error(`PORT_NOT_PUBLISHED: ${name} ${containerPort}/tcp`);
    return p;
  };
  return { port, url: (name: string, containerPort: number, scheme = "http", host = "127.0.0.1") => `${scheme}://${host}:${port(name, containerPort)}`, service: (n: string) => services[n] } as unknown as Layer2Context;
}

export async function provisionAppStack(): Promise<string> {
  const services = discoverServices();
  const missing = SUBSTRATE.filter((s) => !services[s] || !isReady(services[s] as DiscoveredService));
  if (missing.length > 0) throw new Error(`SERVICE_NOT_RUNNING: ${missing.join(", ")}; start them with make up PROFILE=core`);
  // The app services run as an unprivileged user (10001): the built bundle (a gitignored build output whose
  // extraction keeps owner-only modes) must be readable by it.
  const { bundleDir } = ensurePolicyBundle();
  chmodSync(bundleDir, 0o755);
  for (const f of readdirSync(bundleDir)) chmodSync(join(bundleDir, f), 0o644);
  const sb = await provisionSandbox(contextOf(services));
  const out = join(stateDir(), "app", "config");
  mkdirSync(out, { recursive: true });
  const file = join(out, "sandbox.json");
  writeFileSync(file, `${JSON.stringify(sb.config(), null, 2)}\n`, { mode: 0o644 });
  // The substrate stays provisioned for the app services; only the clients are released.
  sb.kms.destroy();
  sb.sm.destroy();
  sb.sqs.destroy();
  await sb.idb.db.close();
  rmSync(dirname(sb.configDir), { recursive: true, force: true });
  return file;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  provisionAppStack()
    .then((file) => process.stdout.write(`app-stack.provisioned ${file}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`app-stack.failed ${err instanceof Error ? err.message.split("\n")[0] : "UNKNOWN"}\n`);
      process.exitCode = 1;
    });
}
