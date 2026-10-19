/**
 * Layer-2 test factory. Every Layer-2 test is declared with the emulated services it uses:
 *
 *   const it = layer2(["postgres", "elasticmq"]);
 *   it("[FO-16-16] ...", async ({ l2 }) => { const port = l2.port("postgres", 5432); ... });
 *
 * Before the test body runs, the fixture checks that each service is running and healthy (a
 * missing service FAILS the test: an unrun check is never a pass, OPS-03) and records the
 * services' emulation labels in the test's meta (`layer: "L2"`, `emulated: [...]`), which the JSON
 * report and the emulation summary (emulation-reporter.ts) carry. Tests that need no emulator (the
 * runner's own process-level checks) use `layer2.withoutServices(reason)` and say why.
 */
import { inject, test as base } from "vitest";
import type { DiscoveredService, EmulationLabel } from "./discovery.js";
import { isReady } from "./discovery.js";

export const CORE_SERVICES = [
  "postgres",
  "dynamodb",
  "elasticmq",
  "minio",
  "localstack",
  "keycloak",
  "stepfunctions",
  "mailpit",
  "clamav",
  "valkey",
  "livekit",
  "livekit-sip",
] as const;
export type CoreService = (typeof CORE_SERVICES)[number];

declare module "vitest" {
  interface ProvidedContext {
    vspServices: Record<string, DiscoveredService>;
    vspProject: string;
  }
  interface TaskMeta {
    layer?: "L2";
    emulated?: EmulationLabel[];
    /** Set instead of `emulated` by process-level tests that use no emulator. */
    noEmulatorReason?: string;
    /** Real local infrastructure used that is not an emulator (e.g. the Docker engine). */
    realLocal?: string[];
    /** Declared services that were not running or not healthy; the test failed before its body. */
    unavailableServices?: string[];
  }
}

export class Layer2Context {
  constructor(private readonly services: Record<string, DiscoveredService>) {}

  service(name: string): DiscoveredService {
    const s = this.services[name];
    if (!s) throw new Error(`SERVICE_NOT_RUNNING: ${name}`);
    return s;
  }

  /** Host port published for the container port (127.0.0.1 binding). */
  port(name: string, containerPort: number, proto: "tcp" | "udp" = "tcp"): number {
    const p = this.service(name).ports[`${containerPort}/${proto}`];
    if (!p) throw new Error(`PORT_NOT_PUBLISHED: ${name} ${containerPort}/${proto}`);
    return p;
  }

  url(name: string, containerPort: number, scheme: "http" | "https" | "ws" = "http", host = "127.0.0.1"): string {
    return `${scheme}://${host}:${this.port(name, containerPort)}`;
  }
}

export interface Layer2Fixtures {
  l2: Layer2Context;
}

/**
 * Throws SERVICE_NOT_RUNNING / SERVICE_NOT_HEALTHY unless every named service of the compose project is
 * running and healthy; `onUnavailable` receives the offending names first.
 */
function requireServices(names: readonly string[], onUnavailable: (names: string[]) => void = () => undefined): Record<string, DiscoveredService> {
  const discovered = inject("vspServices");
  const project = inject("vspProject");
  const missing = names.filter((n) => !discovered[n]);
  if (missing.length > 0) {
    onUnavailable(missing);
    throw new Error(`SERVICE_NOT_RUNNING: ${missing.join(", ")} not running in compose project ${project}; start them with make up PROFILE=core`);
  }
  const notReady = names.filter((n) => !isReady(discovered[n] as DiscoveredService));
  if (notReady.length > 0) {
    onUnavailable(notReady);
    throw new Error(`SERVICE_NOT_HEALTHY: ${notReady.map((n) => `${n}=${discovered[n]?.health}`).join(", ")}`);
  }
  return discovered;
}

export function layer2(services: readonly CoreService[] | readonly string[]) {
  return base.extend<Layer2Fixtures>({
    l2: [
      async ({ task }, use) => {
        task.meta.layer = "L2";
        task.meta.emulated = [];
        // A declared service that is absent fails the test here, before its body; it is never skipped.
        const discovered = requireServices(services, (names) => {
          task.meta.unavailableServices = names;
        });
        task.meta.emulated = services.map((s) => (discovered[s] as DiscoveredService).label);
        await use(new Layer2Context(discovered));
      },
      { auto: true },
    ],
  });
}

layer2.withoutServices = (reason: string, realLocal: readonly string[] = []) =>
  base.extend<Layer2Fixtures>({
    l2: [
      async ({ task }, use) => {
        task.meta.layer = "L2";
        task.meta.emulated = [];
        task.meta.noEmulatorReason = reason;
        if (realLocal.length > 0) task.meta.realLocal = [...realLocal];
        await use(new Layer2Context(inject("vspServices")));
      },
      { auto: true },
    ],
  });

/**
 * Context for suite-level hooks (beforeAll), which do not receive test fixtures. The tests of the
 * suite still declare their services through layer2(...), which also fails them if a service is gone.
 */
export function layer2Context(services: readonly CoreService[] | readonly string[]): Layer2Context {
  return new Layer2Context(requireServices(services));
}
