/**
 * Registry of protocol artifacts exported as versioned JSON Schemas under /schemas.
 */
import type { z } from "zod";
import { AuthContext, AuthGateResponse, VerificationAssertionClaims } from "./auth.js";
import { ActionConfirmation, CommitReceipt, PreparedAction } from "./actions.js";
import { AuditEvent, AuditManifest } from "./audit.js";
import { KillSwitch, ResolutionContract, Budget } from "./contracts.js";
import { EvaluationResult, ScenarioDefinition } from "./evaluation.js";
import { PolicyDecision, PolicyInput } from "./policy.js";
import { ApprovalRecord, PrerequisiteRecord, ReleaseManifest } from "./release.js";
import { HandoffPackage, SupportRequest, TransferRecord } from "./support.js";
import { ToolCatalogManifest, ToolDefinition, ToolRequest, ToolResult, SpeechDirective } from "./tools.js";
import { WorkflowEvent } from "./workflow.js";

export const PROTOCOL_SCHEMAS: Record<string, z.ZodType> = {
  AuthContext,
  AuthGateResponse,
  VerificationAssertionClaims,
  ToolDefinition,
  ToolCatalogManifest,
  ToolRequest,
  ToolResult,
  SpeechDirective,
  PreparedAction,
  ActionConfirmation,
  CommitReceipt,
  SupportRequest,
  HandoffPackage,
  TransferRecord,
  WorkflowEvent,
  AuditEvent,
  AuditManifest,
  PolicyInput,
  PolicyDecision,
  ScenarioDefinition,
  EvaluationResult,
  ReleaseManifest,
  ApprovalRecord,
  PrerequisiteRecord,
  ResolutionContract,
  KillSwitch,
  Budget,
};
