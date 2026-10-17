import type { CorpusSplit } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";

/** Target held-out fraction, in permille (~20 percent). */
export const HELDOUT_PERMILLE = 200;
const SALT = "vsp-corpus-split.v1:";

/**
 * Stable, order-independent split: depends only on the scenario id, so adding,
 * removing or reordering other scenarios never moves a scenario between the
 * development and held-out acceptance sets (spec section 16).
 */
export function stableSplit(scenarioId: string): CorpusSplit {
  const bucket = Number.parseInt(sha256Hex(SALT + scenarioId).slice(0, 8), 16) % 1000;
  return bucket < HELDOUT_PERMILLE ? "heldout_acceptance" : "development";
}
