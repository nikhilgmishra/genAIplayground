/**
 * SYNTHETIC caller personas for the LOCAL evaluation driver.
 *
 * The scenario's audience (and, where the synthetic world needs a specific
 * record holder, its intent) decides WHO the synthetic caller is in the
 * synthetic world (platform/src/fixtures/synthetic-world.ts). This is fixture
 * selection — the caller's real-world identity — not language understanding:
 * the coordinator never reads the scenario's intent label or expected tools.
 *
 * The locator is what the caller would say to the verification Skill (name and
 * date of birth, or a portal username hint). It only LOCATES a candidate inside
 * the restricted verification service; it never authenticates (AUTH-01).
 */
import { PEOPLE } from "../../fixtures/synthetic-world.js";
import type { SyntheticPerson } from "../../fixtures/synthetic-world.js";
import type { Role, ScenarioDefinition } from "../../protocol/index.js";

export type VerificationLocator =
  | { kind: "NAME_AND_DATE_OF_BIRTH"; fullName: string; dateOfBirth: string }
  | { kind: "PORTAL_USERNAME_HINT"; hint: string };

export interface CallerPersona {
  /** Key in PEOPLE, or null when the synthetic caller has no account (prospective, unknown, payer). */
  personKey: keyof typeof PEOPLE | null;
  person: SyntheticPerson | null;
  /** Role the caller picks in the deterministic Studio menu (SF-05); null = no selection. */
  role: Role | null;
  locator: VerificationLocator;
  /** Fictional caller id (555-01xx range) presented by the carrier: an identifier, never authentication. */
  callerIdE164: string;
}

const USERNAMES: Partial<Record<keyof typeof PEOPLE, string>> = {
  avery: "avery.synthetic",
  blake: "blake.synthetic",
  dana: "dana.synthetic",
  emery: "emery.synthetic",
  morgan: "morgan.synthetic",
  newbie: "newbie.synthetic",
  riley: "riley.synthetic",
  quinn: "quinn.synthetic",
};

/** A synthetic person with no account anywhere in the synthetic world. */
const UNKNOWN_LOCATOR: VerificationLocator = { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Jordan Synthetic-Unknown", dateOfBirth: "1999-09-09" };

function locatorFor(key: keyof typeof PEOPLE): VerificationLocator {
  const p = PEOPLE[key] as SyntheticPerson;
  if (p.dateOfBirth) return { kind: "NAME_AND_DATE_OF_BIRTH", fullName: p.fullName, dateOfBirth: p.dateOfBirth };
  return { kind: "PORTAL_USERNAME_HINT", hint: USERNAMES[key] ?? "unknown.synthetic" };
}

const persona = (key: keyof typeof PEOPLE | null, role: Role | null, callerIdE164 = "+15555550101"): CallerPersona => ({
  personKey: key,
  person: key ? (PEOPLE[key] as SyntheticPerson) : null,
  role,
  locator: key ? locatorFor(key) : UNKNOWN_LOCATOR,
  callerIdE164,
});

const NEW_PROVIDER_INTENTS = new Set(["provider_onboarding_status", "credentialing_document_status", "credentialing_decision_request"]);

/** Synthetic caller for a scenario (fixture selection only). */
export function personaFor(s: Pick<ScenarioDefinition, "audience" | "intent" | "initialState">): CallerPersona {
  if (s.initialState.fixtureSet === "synthetic_world_unknown_caller") return persona(null, s.audience ?? null, "+15555550177");
  switch (s.audience) {
    case "client":
      return persona("avery", "client");
    case "prospective_client":
      return persona(null, "prospective_client", "+15555550188");
    case "provider":
      return NEW_PROVIDER_INTENTS.has(s.intent) ? persona("newbie", "provider", "+15555550133") : persona("morgan", "provider", "+15555550131");
    case "practice_staff":
      return persona("riley", "practice_staff", "+15555550141");
    case "partner":
      return persona("quinn", "partner", "+15555550151");
    case "personal_representative":
      return s.intent === "expired_proxy_access" ? persona("emery", "personal_representative", "+15555550161") : persona("dana", "personal_representative", "+15555550162");
    case "payer_representative":
      return persona(null, "payer_representative", "+15555550171");
    default:
      return persona(null, null, "+15555550190");
  }
}

/** A second synthetic call for the same account (CONCURRENT_SAME_ACCOUNT): same person, different handset. */
export function concurrentPersona(p: CallerPersona): CallerPersona {
  return { ...p, callerIdE164: "+15555550102" };
}
