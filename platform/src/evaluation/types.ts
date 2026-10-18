import type { ScenarioDefinition } from "../protocol/index.js";

export type RequiredHandoff = ScenarioDefinition["requiredHandoff"];
export type ExecutionMode = "local_fixture" | "vendor_sandbox" | "pstn_sandbox" | "production_pilot";
export const EXECUTION_MODES: readonly ExecutionMode[] = ["local_fixture", "vendor_sandbox", "pstn_sandbox", "production_pilot"];
