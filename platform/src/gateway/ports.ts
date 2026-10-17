import type { z } from "zod";
import type {
  AuthContext,
  PolicyDecision,
  PolicyInput,
  PolicyPurpose,
  SpeechDirective,
  ToolDefinition,
  ToolRequest,
} from "../protocol/index.js";

/**
 * A tool module is a narrow, versioned operation. The gateway pipeline owns
 * transport auth, catalogue pinning, strict schema validation, session
 * resolution, kill switches/admission, policy evaluation, output validation,
 * field masking, audit and the ToolResult envelope. Modules only describe the
 * resource for policy and execute the business operation.
 */
export interface ToolExecutionContext {
  auth: AuthContext;
  request: ToolRequest;
  decision: PolicyDecision;
  now: Date;
}

export type ToolOutcome<O> =
  | { status: "SUCCESS"; data: O; speech: Omit<SpeechDirective, "turnId" | "sessionGeneration" | "authorizationRef"> | null }
  | { status: "PENDING"; reasonCode: string; pendingRef: string; data: O; speech: Omit<SpeechDirective, "turnId" | "sessionGeneration" | "authorizationRef"> | null }
  | { status: "RETRYABLE_FAILURE"; reasonCode: string; retryAfterMs: number }
  | { status: "PERMANENT_FAILURE"; reasonCode: string }
  | { status: "POLICY_DENIED"; reasonCode: string }
  | { status: "UNKNOWN_OUTCOME"; reasonCode: string; reconciliationRef: string };

export interface ToolModule<I = unknown, O = unknown> {
  /** Static catalogue entry minus JSON Schemas, which are derived from `input`/`output`. */
  definition: Omit<ToolDefinition, "inputSchema" | "outputSchema">;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** Policy purpose for this invocation. */
  purpose(auth: AuthContext, input: I): PolicyPurpose;
  /**
   * Describes the target resource from AUTHORITATIVE lookups (e.g. the
   * appointment's real subject), never from model-supplied ownership claims.
   */
  resolveResource(auth: AuthContext, input: I): Promise<PolicyInput["resource"]>;
  execute(ctx: ToolExecutionContext, input: I): Promise<ToolOutcome<O>>;
}
