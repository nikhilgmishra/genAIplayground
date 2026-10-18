/**
 * Runs axe-core against the rendered DOM. `color-contrast` is disabled because
 * jsdom does not lay out or paint, so contrast cannot be computed here; it needs
 * a real-browser check (recorded as a known gap).
 */
import axe from "axe-core";

export interface AxeViolationSummary {
  id: string;
  impact: string | null | undefined;
  targets: string[];
}

export async function axeViolations(root: Document | Element = document): Promise<AxeViolationSummary[]> {
  const results = await axe.run(root, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(" ")) }));
}
