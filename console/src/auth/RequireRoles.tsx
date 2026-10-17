import type { ReactNode } from "react";
import { ENDPOINT_ROLES } from "../api/contract";
import type { AuthenticatedEndpointKey } from "../api/contract";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useRoles } from "./AuthProvider";
import { ROLE_LABELS, canUse } from "./roles";

function Forbidden({ endpoint }: { endpoint: AuthenticatedEndpointKey }) {
  useDocumentTitle("Not permitted");
  return (
    <>
      <h1>Not permitted</h1>
      <p>
        This view requires one of these roles: {ENDPOINT_ROLES[endpoint].map((r) => ROLE_LABELS[r]).join(", ")}. Your roles do not include
        any of them. The server enforces the same rule, so the data is not available through any other route.
      </p>
    </>
  );
}

/** Route guard mirroring ENDPOINT_ROLES (UX only; the server is authoritative). */
export function RequireRoles({ endpoint, children }: { endpoint: AuthenticatedEndpointKey; children: ReactNode }) {
  const roles = useRoles();
  return canUse(endpoint, roles) ? <>{children}</> : <Forbidden endpoint={endpoint} />;
}
