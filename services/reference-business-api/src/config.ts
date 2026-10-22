/**
 * Configuration of the reference business API (WP-23; FO-06-74). Read once from the environment at start-up
 * and validated strictly; an invalid or unsafe combination refuses to start with a reason code (never a
 * best-effort default).
 *
 * Safety rules enforced here (OPS-04, OPS-05):
 *   - the fault-control listener (admin API: synthetic seeding, per-host TLS registration, fault injection and
 *     seams) exists only when REFBIZ_FAULT_CONTROL=enabled AND the environment is local or ci; any other
 *     environment refuses to start with REFBIZ_FAULT_CONTROL_OUTSIDE_LOCAL. It binds the loopback interface only;
 *   - outside local/ci the API must serve TLS with a configured certificate (no per-host registration exists
 *     there), and the database is never created implicitly.
 */
import { z } from "zod";

export const ENVIRONMENTS = ["local", "ci", "sandbox", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export class ConfigError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ConfigError";
  }
}

const Port = z.coerce.number().int().min(1).max(65_535);
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

const Env = z.object({
  REFBIZ_ENVIRONMENT: z.enum(ENVIRONMENTS),
  REFBIZ_API_BIND: z.string().regex(/^[0-9a-fA-F.:]{2,45}$/).default("127.0.0.1"),
  REFBIZ_API_PORT: Port.default(8443),
  REFBIZ_HEALTH_PORT: Port.default(8081),
  REFBIZ_FAULT_CONTROL: z.enum(["enabled", "disabled"]).default("disabled"),
  REFBIZ_ADMIN_BIND: z.string().default("127.0.0.1"),
  REFBIZ_ADMIN_PORT: Port.default(8080),
  REFBIZ_DATABASE_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  REFBIZ_DATABASE_PORT: Port.default(5432),
  REFBIZ_DATABASE_USER: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  REFBIZ_DATABASE_PASSWORD: z.string().min(8).max(256),
  REFBIZ_DATABASE_NAME: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default("refbiz"),
  REFBIZ_DATABASE_CREATE: z.enum(["true", "false"]).default("false"),
  REFBIZ_DATABASE_SSL: z.enum(["disable", "require"]).default("require"),
  REFBIZ_TLS_CERT_FILE: z.string().min(1).max(512).optional(),
  REFBIZ_TLS_KEY_FILE: z.string().min(1).max(512).optional(),
  REFBIZ_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
});

export interface ServiceConfig {
  environment: Environment;
  api: { bind: string; port: number };
  health: { port: number };
  /** Null unless fault control is enabled in local/ci. */
  admin: { bind: string; port: number } | null;
  database: { host: string; port: number; user: string; password: string; name: string; create: boolean; ssl: boolean };
  tls: { certFile: string; keyFile: string } | null;
  tokenTtlSeconds: number;
}

/** Parses the environment; throws ConfigError with a reason code (never a value) on any violation. */
export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new ConfigError(typeof field === "string" ? `CONFIG_INVALID_${field}` : "CONFIG_INVALID");
  }
  const e = parsed.data;
  const local = e.REFBIZ_ENVIRONMENT === "local" || e.REFBIZ_ENVIRONMENT === "ci";
  const faultControl = e.REFBIZ_FAULT_CONTROL === "enabled";
  if (faultControl && !local) throw new ConfigError("REFBIZ_FAULT_CONTROL_OUTSIDE_LOCAL");
  if (faultControl && !LOOPBACK.has(e.REFBIZ_ADMIN_BIND)) throw new ConfigError("REFBIZ_ADMIN_NOT_LOOPBACK");
  // The environment name is self-declared: fault control also needs the API itself on loopback, so a deployed
  // container (the image binds 0.0.0.0) that claims local/ci still refuses to start with the fault seams.
  if (faultControl && !LOOPBACK.has(e.REFBIZ_API_BIND)) throw new ConfigError("REFBIZ_FAULT_CONTROL_REQUIRES_LOOPBACK_API");
  const tls = e.REFBIZ_TLS_CERT_FILE && e.REFBIZ_TLS_KEY_FILE ? { certFile: e.REFBIZ_TLS_CERT_FILE, keyFile: e.REFBIZ_TLS_KEY_FILE } : null;
  if ((e.REFBIZ_TLS_CERT_FILE === undefined) !== (e.REFBIZ_TLS_KEY_FILE === undefined)) throw new ConfigError("REFBIZ_TLS_PAIR_INCOMPLETE");
  // Outside local/ci there is no per-host certificate registration: the API needs its own certificate.
  if (!local && tls === null) throw new ConfigError("REFBIZ_TLS_REQUIRED");
  if (!local && e.REFBIZ_DATABASE_CREATE === "true") throw new ConfigError("REFBIZ_DATABASE_CREATE_OUTSIDE_LOCAL");
  if (!local && e.REFBIZ_DATABASE_SSL === "disable") throw new ConfigError("REFBIZ_DATABASE_TLS_REQUIRED");
  return {
    environment: e.REFBIZ_ENVIRONMENT,
    api: { bind: e.REFBIZ_API_BIND, port: e.REFBIZ_API_PORT },
    health: { port: e.REFBIZ_HEALTH_PORT },
    admin: faultControl ? { bind: e.REFBIZ_ADMIN_BIND, port: e.REFBIZ_ADMIN_PORT } : null,
    database: {
      host: e.REFBIZ_DATABASE_HOST,
      port: e.REFBIZ_DATABASE_PORT,
      user: e.REFBIZ_DATABASE_USER,
      password: e.REFBIZ_DATABASE_PASSWORD,
      name: e.REFBIZ_DATABASE_NAME,
      create: e.REFBIZ_DATABASE_CREATE === "true",
      ssl: e.REFBIZ_DATABASE_SSL === "require",
    },
    tls,
    tokenTtlSeconds: e.REFBIZ_TOKEN_TTL_SECONDS,
  };
}
