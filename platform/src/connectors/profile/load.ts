/**
 * Loads ConnectorProfile documents (JSON) and admits them for an environment (WP-06; FO-06-12). A
 * directory is read in name order; one rejected profile rejects the load (no partial connector set),
 * and the profiles of the set must not share credentials (FO-05-56).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../protocol/common.js";
import { ValidationError } from "../../shared/errors.js";
import { credentialReuseViolations } from "./credentials.js";
import { ProfileRejectedError, admitConnectorProfile } from "./validate.js";
import type { AdmittedProfile } from "./validate.js";

const MAX_PROFILE_BYTES = 512 * 1_024;

export function loadConnectorProfile(json: string, environment: Environment): AdmittedProfile {
  if (Buffer.byteLength(json) > MAX_PROFILE_BYTES) throw new ProfileRejectedError(["PROFILE_TOO_LARGE"]);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProfileRejectedError(["PROFILE_NOT_JSON"]);
  }
  return admitConnectorProfile(raw, environment);
}

/** Admits every `*.json` profile of `dir`; refuses duplicates and credential reuse inside the set. */
export function loadConnectorProfilesFromDir(dir: string, environment: Environment): AdmittedProfile[] {
  const files = readdirSync(dir)
    .filter((f) => /^[a-z0-9][a-z0-9._-]{0,80}\.json$/.test(f))
    .sort();
  if (files.length > 256) throw new ValidationError("PROFILE_SET_TOO_LARGE");
  const out = files.map((f) => loadConnectorProfile(readFileSync(join(dir, f), "utf8"), environment));
  const ids = new Set<string>();
  for (const a of out) {
    const k = `${a.profile.tenantId}|${a.profile.profileId}`;
    if (ids.has(k)) throw new ProfileRejectedError(["PROFILE_DUPLICATE_ID"]);
    ids.add(k);
  }
  const reuse = credentialReuseViolations([{ environment, profiles: out.map((a) => a.profile) }]);
  if (reuse.length > 0) throw new ProfileRejectedError(reuse.map((r) => r.code));
  return out;
}
