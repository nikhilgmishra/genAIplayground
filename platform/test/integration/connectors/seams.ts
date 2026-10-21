/**
 * Fault-injection SEAM built by WP-06 for the Layer-2 run owned by WP-32 (docs/followon/work-packages.yaml
 * WP-06 faultInjectionPoints):
 *
 *   SCHEMA_DRIFT (WP-32)  schemaDriftSeam: the vendor protocol emulator (emulator.ts) starts returning drifted
 *       records and metadata (a renamed required field, a retyped field, or a picklist value no enum table
 *       maps). The production mapping DSL refuses the record whole with ConnectorSchemaDriftError
 *       (CONNECTOR_SCHEMA_DRIFT), nothing of that page is written, and the affected capability turns UNKNOWN
 *       in the runtime's readiness. WP-32's [FAULT:SCHEMA_DRIFT] test drives this seam and asserts the
 *       readiness surface and /health/ready.
 *
 * The seam's own local proof is in runtime.test.ts and checkpoints.test.ts ([FAULT:SCHEMA_DRIFT seam]).
 */
import type { Drift, VendorEmulator } from "./emulator.js";

export type SchemaDriftKind = "RENAMED_REQUIRED_FIELD" | "RETYPED_FIELD" | "UNMAPPED_ENUM_VALUE";

const DRIFTS: Record<SchemaDriftKind, Drift> = {
  RENAMED_REQUIRED_FIELD: { rename: { status: "state" } },
  RETYPED_FIELD: { retype: ["startsAt"] },
  UNMAPPED_ENUM_VALUE: { newStatusValue: "tentative" },
};

export interface SchemaDriftSeam {
  readonly kind: SchemaDriftKind;
  /** Restores the vendor's documented schema. */
  undo(): void;
}

/** Makes the emulated vendor drift in the given way until `undo()`. */
export function schemaDriftSeam(em: VendorEmulator, kind: SchemaDriftKind): SchemaDriftSeam {
  const before = em.drift;
  em.drift = { ...DRIFTS[kind] };
  return {
    kind,
    undo: () => {
      em.drift = before;
    },
  };
}
