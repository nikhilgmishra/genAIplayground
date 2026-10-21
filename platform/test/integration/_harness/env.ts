/**
 * Reads the generated local emulator state (.tools/vsp-local by default; scripts/vsp/up.mts writes it).
 * The values are credentials of the LOCAL EMULATORS only; tests never print them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PLATFORM_ROOT = join(REPO_ROOT, "platform");

export function stateDir(): string {
  return resolve(process.env.VSP_LOCAL_STATE_DIR ?? join(REPO_ROOT, ".tools", "vsp-local"));
}

export interface LocalEnv {
  postgresPassword: string;
  minioUser: string;
  minioPassword: string;
  /** Key name of MinIO's built-in KMS key (SSE-KMS key id for the audit sink). */
  minioKmsKeyId: string;
  keycloakAdminUser: string;
  keycloakAdminPassword: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  valkeyPassword: string;
  caFile: string;
}

function parse(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

let cached: LocalEnv | null = null;

export function localEnv(): LocalEnv {
  if (cached) return cached;
  const file = join(stateDir(), "env");
  if (!existsSync(file)) throw new Error(`LOCAL_STATE_MISSING: ${file} not found; run make up PROFILE=core`);
  const e = parse(readFileSync(file, "utf8"));
  const need = (k: string): string => {
    const v = e[k];
    if (!v) throw new Error(`LOCAL_STATE_INCOMPLETE: ${k} missing in ${file}; run make up PROFILE=core`);
    return v;
  };
  cached = {
    postgresPassword: need("VSP_POSTGRES_PASSWORD"),
    minioUser: need("VSP_MINIO_ROOT_USER"),
    minioPassword: need("VSP_MINIO_ROOT_PASSWORD"),
    minioKmsKeyId: need("VSP_MINIO_KMS_SECRET_KEY").split(":")[0] ?? "",
    keycloakAdminUser: need("VSP_KEYCLOAK_ADMIN_USER"),
    keycloakAdminPassword: need("VSP_KEYCLOAK_ADMIN_PASSWORD"),
    awsAccessKeyId: need("VSP_AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: need("VSP_AWS_SECRET_ACCESS_KEY"),
    livekitApiKey: need("VSP_LIVEKIT_API_KEY"),
    livekitApiSecret: need("VSP_LIVEKIT_API_SECRET"),
    valkeyPassword: need("VSP_VALKEY_PASSWORD"),
    caFile: join(stateDir(), "tls", "ca.pem"),
  };
  return cached;
}
