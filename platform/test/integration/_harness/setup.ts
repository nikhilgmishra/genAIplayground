/**
 * Per-file Layer-2 setup: every test must be declared through layer2(...) so its report entry says
 * which emulated services it used (FO-16-23). An unlabelled test fails.
 */
import { afterEach } from "vitest";

afterEach(({ task }) => {
  // A test whose declared service was unavailable is labelled with what it needed and has already failed.
  const labelled =
    task.meta.layer === "L2" && ((task.meta.emulated?.length ?? 0) > 0 || typeof task.meta.noEmulatorReason === "string" || (task.meta.unavailableServices?.length ?? 0) > 0);
  if (!labelled) {
    throw new Error("LAYER2_UNLABELLED: declare Layer-2 tests with layer2([...services]) or layer2.withoutServices(reason) from test/integration/_harness");
  }
});
