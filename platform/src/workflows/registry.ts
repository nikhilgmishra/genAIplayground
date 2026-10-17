/**
 * Definition registry keyed by type + version. Registered versions are
 * immutable (same version with different content is refused) and are never
 * removed, so in-flight instances keep loading the definition version they
 * pinned at start (spec section 15, Phase 5).
 */
import type { WorkflowType } from "../protocol/index.js";
import { digestOf } from "../shared/canonical.js";
import { ConflictError } from "../shared/errors.js";
import { SHIPPED_DEFINITIONS } from "./definitions/index.js";
import { deepFreeze } from "./definitions/builders.js";
import type { WorkflowDefinition } from "./ports.js";
import type { VersionedWorkflowDefinition } from "./types.js";
import { assertValidDefinition } from "./validator.js";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function normalize(def: WorkflowDefinition | VersionedWorkflowDefinition): VersionedWorkflowDefinition {
  const v = def as Partial<VersionedWorkflowDefinition>;
  const copy = structuredClone({
    type: def.type,
    version: def.version,
    initial: def.initial,
    states: def.states,
    description: v.description ?? "",
    transitionGuards: v.transitionGuards ?? {},
    humanTaskRoles: v.humanTaskRoles ?? {},
  }) as VersionedWorkflowDefinition;
  return deepFreeze(copy);
}

export class WorkflowDefinitionRegistry {
  private readonly byType = new Map<WorkflowType, Map<string, { def: VersionedWorkflowDefinition; digest: string }>>();

  register(def: WorkflowDefinition | VersionedWorkflowDefinition): VersionedWorkflowDefinition {
    assertValidDefinition(def);
    const normalized = normalize(def);
    const digest = digestOf(normalized);
    let versions = this.byType.get(normalized.type);
    if (!versions) {
      versions = new Map();
      this.byType.set(normalized.type, versions);
    }
    const existing = versions.get(normalized.version);
    if (existing) {
      if (existing.digest !== digest) throw new ConflictError("DEFINITION_VERSION_IMMUTABLE");
      return existing.def;
    }
    versions.set(normalized.version, { def: normalized, digest });
    return normalized;
  }

  get(type: WorkflowType, version: string): VersionedWorkflowDefinition | null {
    return this.byType.get(type)?.get(version)?.def ?? null;
  }

  latest(type: WorkflowType): VersionedWorkflowDefinition | null {
    const versions = this.byType.get(type);
    if (!versions || versions.size === 0) return null;
    const newest = [...versions.keys()].sort(compareVersions).at(-1);
    return newest === undefined ? null : (versions.get(newest)?.def ?? null);
  }

  versions(type: WorkflowType): string[] {
    return [...(this.byType.get(type)?.keys() ?? [])].sort(compareVersions);
  }

  digest(type: WorkflowType, version: string): string | null {
    return this.byType.get(type)?.get(version)?.digest ?? null;
  }

  all(): VersionedWorkflowDefinition[] {
    const out: VersionedWorkflowDefinition[] = [];
    for (const versions of this.byType.values()) for (const v of versions.values()) out.push(v.def);
    return out.sort((a, b) => (a.type === b.type ? compareVersions(a.version, b.version) : a.type < b.type ? -1 : 1));
  }
}

/** Registry pre-loaded with every shipped definition version. */
export function createDefaultRegistry(): WorkflowDefinitionRegistry {
  const r = new WorkflowDefinitionRegistry();
  for (const d of SHIPPED_DEFINITIONS) r.register(d);
  return r;
}
