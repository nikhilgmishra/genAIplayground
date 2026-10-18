import type { AuthenticatedEndpointKey, StaffRole } from "./api/contract";
import { canUse } from "./auth/roles";

export interface NavItem {
  path: string;
  label: string;
  /** The endpoint the page reads; its ENDPOINT_ROLES decide visibility. */
  endpoint: AuthenticatedEndpointKey;
}

/** Console sections (spec sections 13 and 16). Routes carry opaque identifiers only. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/overview", label: "Overview", endpoint: "overview" },
  { path: "/calls", label: "Active calls", endpoint: "calls.list" },
  { path: "/trace", label: "Support request trace", endpoint: "supportRequests.trace" },
  { path: "/actions", label: "Pending actions", endpoint: "actions.pending" },
  { path: "/reconciliation", label: "Reconciliation queue", endpoint: "reconciliation.list" },
  { path: "/approvals", label: "Approvals", endpoint: "workflows.tasks" },
  { path: "/safety-events", label: "Safety events", endpoint: "safetyEvents.list" },
  { path: "/releases", label: "Releases review", endpoint: "releases.list" },
  { path: "/budgets", label: "Budgets", endpoint: "budgets.list" },
  { path: "/kill-switches", label: "Kill switches", endpoint: "killSwitches.list" },
  { path: "/audit", label: "Audit search", endpoint: "audit.search" },
  { path: "/destinations", label: "Destinations", endpoint: "destinations.list" },
  { path: "/playbooks", label: "Escalation and playbooks", endpoint: "me" },
];

export const navFor = (roles: readonly StaffRole[]): NavItem[] => NAV_ITEMS.filter((n) => canUse(n.endpoint, roles));
